/**
 * `/api/inventory/…` (`docs/inventory.md`): locations, lots, the ledger, build shortages and
 * reservations. Not catalog data, so no unit of work, change set or catalog version: each write is
 * one inventory transaction (`store.ts`). Roles and tokens are the gate's (a viewer reads; a token
 * writes with `catalog:write`). Lots, locations and reservations carry a version (`ETag`, `If-Match`
 * refuses a stale edit); the balances themselves are guarded by the transaction, not the client.
 * Every write raises the `inventory.changed` webhook event.
 */

import { versionDb, workingDiffers, type CableDesign, type Db } from '@wirehub/model';

import type { ApiResponse } from '../api.ts';
import { withDesignLibrary, type AssemblyDeps } from '../assemblies.ts';
import type { StudioUser } from '../me.ts';
import type { Awaitable } from '../storage/change-set.ts';
import type { EventHub } from '../events.ts';
import type { DomainEvent } from '../webhooks/events.ts';
import { adjust, completeUnits, consume, createLocation, deleteLocation, editLot, giveBack, move, receive, recordBatch, release, reserve, updateLocation, type BatchInput, type LotPatch } from './engine.ts';
import { deriveRequirement, shortage, type BuildRequirement } from './requirements.ts';
import type { InventoryStore } from './store.ts';
import { massEstimateOf, withMassEstimates } from './mass.ts';
import { OFFER_ROUTES, buildSourcing, handleOffers } from '../sourcing/api.ts';
import { convertedTotal } from '../sourcing/fx.ts';
import type { OfferStore } from '../sourcing/offers.ts';
import { BASE_UNIT, DIMENSIONS, ITEM_KINDS, InventoryError, UNITS, defaultDimension, itemKey, toBase, versionTag, type Allowance, type Dimension, type ItemKind, type ItemRef, type Lot, type Measured } from './types.ts';

export const INVENTORY_ROUTES = [
  'GET    /api/inventory',
  'POST   /api/inventory/locations',
  'PATCH  /api/inventory/locations/:id',
  'DELETE /api/inventory/locations/:id',
  'POST   /api/inventory/receive',
  'GET    /api/inventory/lots/:id',
  'PATCH  /api/inventory/lots/:id',
  'POST   /api/inventory/lots/:id/move',
  'POST   /api/inventory/lots/:id/adjust',
  'GET    /api/inventory/items/:kind/:id',
  'GET    /api/inventory/movements',
  'GET    /api/inventory/builds/:design',
  'GET    /api/inventory/reservations',
  'POST   /api/inventory/reservations',
  'GET    /api/inventory/reservations/:id',
  'POST   /api/inventory/reservations/:id/consume',
  'POST   /api/inventory/reservations/:id/return',
  'POST   /api/inventory/reservations/:id/release',
  'POST   /api/inventory/reservations/:id/complete',
  'GET    /api/inventory/batches',
  'POST   /api/inventory/batches',
  ...OFFER_ROUTES,
] as const;

export interface InventoryDeps extends AssemblyDeps {
  inventory?: InventoryStore;
  /** dated supplier offers (`sourcing/offers.ts`); absent → `/offers` answers 501 and builds carry no offer prices */
  offers?: OfferStore;
  loadDb: () => Awaitable<Db>;
  /** the `inventory` server event after a write (files; on pg the commit's NOTIFY carries it and a local publish is dropped) */
  events?: EventHub;
}

export const isInventoryPath = (path: string): boolean => /^\/api\/inventory(?:\/|$|\?)/.test(path);

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

const ok = (body: unknown, status = 200, extra: Partial<ApiResponse> = {}): ApiResponse => ({ status, body, ...extra });

const ID = /^(loc|lot|res|bat)-[0-9a-f]{10}$/;
const RECORD_ID = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

/* ------------------------------------------------------------------ *
 * Body reading
 * ------------------------------------------------------------------ */

type Body = Record<string, unknown>;

function bodyOf(value: unknown): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InventoryError(400, 'Send a JSON object.');
  return value as Body;
}

function text(body: Body, key: string, max: number, required: true): string;
function text(body: Body, key: string, max: number, required?: false): string | undefined;
function text(body: Body, key: string, max: number, required = false): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && !required)) {
    if (required) throw new InventoryError(400, `${key} is required.`);
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new InventoryError(400, `${key} is text, up to ${max} characters.`);
  return v.trim();
}

function number(body: Body, key: string, required: true): number;
function number(body: Body, key: string, required?: false): number | undefined;
function number(body: Body, key: string, required = false): number | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new InventoryError(400, `${key} is required.`);
    return undefined;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new InventoryError(400, `${key} is a number.`);
  return n;
}

function itemOf(value: unknown): ItemRef {
  const v = bodyOf(value);
  if (!(ITEM_KINDS as readonly unknown[]).includes(v['kind'])) throw new InventoryError(400, `item.kind is one of ${ITEM_KINDS.join(', ')}.`);
  if (typeof v['id'] !== 'string' || !RECORD_ID.test(v['id'])) throw new InventoryError(400, 'item.id is a record id.');
  return { kind: v['kind'] as ItemKind, id: v['id'] };
}

/** A quantity in `unit` (default: the dimension's base unit) as the base value, checked against `dim`. */
function quantity(qty: number, unit: string | undefined, dim: Dimension): number {
  const base = toBase(qty, unit ?? BASE_UNIT[dim]);
  if (base === undefined) throw new InventoryError(400, `'${unit}' is not a unit (${Object.keys(UNITS).join(', ')}).`);
  if (base.dim !== dim) throw new InventoryError(422, `${unit} is a ${base.dim}; this is counted by ${dim} (${BASE_UNIT[dim]}).`);
  return base.value;
}

function allowanceOf(source: { get(key: string): string | null } | Body): Allowance {
  const read = (key: string): number | undefined => {
    const raw = source instanceof URLSearchParams ? source.get(key) : (source as Body)[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new InventoryError(400, `${key} is a number, zero or more.`);
    return n;
  };
  const pct = read('pct') ?? 0;
  if (pct > 200) throw new InventoryError(400, 'pct is at most 200.');
  return { perCutMm: read('perCutMm') ?? 0, pct };
}

/** `units`, `failed`, `batchCode`, `serials`, `measured`, `into`, `note` of a batch. */
function batchInputOf(body: Body): BatchInput {
  const units = number(body, 'units') ?? 0;
  const failed = number(body, 'failed');
  const batchCode = text(body, 'batchCode', 120);
  const into = text(body, 'into', 20);
  const note = text(body, 'note', 2000);
  const rawSerials = body['serials'];
  let serials: string[] | undefined;
  if (typeof rawSerials === 'string') serials = rawSerials.split(/[\s,;]+/);
  else if (Array.isArray(rawSerials) && rawSerials.every((v) => typeof v === 'string')) serials = rawSerials as string[];
  else if (rawSerials !== undefined && rawSerials !== null) throw new InventoryError(400, 'serials is a list of text (or one text, separated by commas or spaces).');
  if (serials !== undefined && serials.length > 10_000) throw new InventoryError(400, 'At most 10000 serials in one batch.');
  let measured: Measured | undefined;
  if (body['measured'] !== undefined && body['measured'] !== null) {
    const m = bodyOf(body['measured']);
    const durationS = number(m, 'durationS');
    const unitMassG = number(m, 'unitMassG');
    measured = { ...(durationS === undefined ? {} : { durationS }), ...(unitMassG === undefined ? {} : { unitMassG }) };
  }
  return { units, ...(failed === undefined ? {} : { failed }), ...(batchCode === undefined ? {} : { batchCode }), ...(serials === undefined ? {} : { serials }), ...(measured === undefined ? {} : { measured }), ...(into === undefined ? {} : { into }), ...(note === undefined ? {} : { note }) };
}

/* ------------------------------------------------------------------ *
 * Design loading
 * ------------------------------------------------------------------ */

/** The latest saved revision when the working copy has not changed since it, else undefined. */
async function savedRevOfWorking(deps: InventoryDeps, designId: string): Promise<number | undefined> {
  const last = ((await deps.versions?.revisions(designId)) ?? []).at(-1);
  if (last === undefined) return undefined;
  const [working, file] = await Promise.all([deps.designs.read(designId), deps.versions?.read(designId, last)]);
  if (working === undefined || file === undefined) return undefined;
  return workingDiffers(working, { ...file.design, id: designId }) ? undefined : last;
}

async function requirementFor(deps: InventoryDeps, designId: string, buildQty: number, allowance: Allowance, rev: number | undefined, explode: boolean): Promise<{ requirement: BuildRequirement; db: Db; design: CableDesign }> {
  if (!RECORD_ID.test(designId)) throw new InventoryError(400, `'${designId}' is not a design id.`);
  if (!(buildQty > 0) || buildQty > 100_000 || !Number.isInteger(buildQty)) throw new InventoryError(400, 'qty is a whole number from 1.');
  const live = await deps.loadDb();
  let design: CableDesign | undefined;
  let db = live;
  if (rev === undefined) design = await deps.designs.read(designId);
  else {
    const file = await deps.versions?.read(designId, rev);
    if (file !== undefined) {
      design = { ...file.design, id: designId };
      db = versionDb(file.definitions, live);
    }
  }
  if (design === undefined) throw new InventoryError(404, rev === undefined ? `There is no design '${designId}'.` : `'${designId}' has no saved Rev ${rev}.`);
  db = await withDesignLibrary(deps, design, db);
  // a design kept in stock reads its own route: the library of designs, for sub-assembly hints
  return { requirement: deriveRequirement(design, db, buildQty, allowance, { explode }), db, design };
}

async function itemExists(deps: InventoryDeps, item: ItemRef): Promise<{ label: string; dim: Dimension } | undefined> {
  if (item.kind === 'designs') {
    const d = await deps.designs.read(item.id);
    return d === undefined ? undefined : { label: d.label, dim: 'count' };
  }
  const db = await deps.loadDb();
  const list: readonly { id: string; label?: string }[] = item.kind === 'mechanicals' ? (db.mechanicals ?? []) : db[item.kind];
  const found = list.find((r) => r.id === item.id);
  return found === undefined ? undefined : { label: found.label ?? found.id, dim: defaultDimension(item.kind) };
}

/** Labels for the items of these lots, so a table can show names without the whole library. */
async function labelsFor(deps: InventoryDeps, items: readonly ItemRef[]): Promise<Record<string, string>> {
  const db = await deps.loadDb();
  const out: Record<string, string> = {};
  for (const item of items) {
    const key = itemKey(item);
    if (out[key] !== undefined) continue;
    if (item.kind === 'designs') out[key] = (await deps.designs.read(item.id))?.label ?? item.id;
    else {
      const list: readonly { id: string; label?: string }[] = item.kind === 'mechanicals' ? (db.mechanicals ?? []) : db[item.kind];
      out[key] = list.find((r) => r.id === item.id)?.label ?? item.id;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function changed(kind: 'lot' | 'reservation' | 'location' | 'batch', id: string, action: string, summary: Record<string, unknown> = {}): DomainEvent[] {
  return [{ type: 'inventory.changed', subject: { kind, id }, summary: { action, ...summary } }];
}

const lotSummary = (lot: Lot): Record<string, unknown> => ({ item: itemKey(lot.item), onHand: lot.onHand, reserved: lot.reserved, unit: BASE_UNIT[lot.dim] });

/* ------------------------------------------------------------------ *
 * The handler
 * ------------------------------------------------------------------ */

type InventoryRequest = { method: string; path: string; body?: unknown; headers?: Record<string, string>; user?: StudioUser };

/** Answer an inventory request; a write that went through raises the `inventory` server event, so other open pages refetch. */
export async function handleInventoryRequest(request: InventoryRequest, deps: InventoryDeps, fallbackUser: StudioUser): Promise<ApiResponse> {
  const answer = await inventoryRequest(request, deps, fallbackUser);
  if (request.method.toUpperCase() !== 'GET' && answer.status < 400) deps.events?.publish({ type: 'inventory' });
  return answer;
}

async function inventoryRequest(request: InventoryRequest, deps: InventoryDeps, fallbackUser: StudioUser): Promise<ApiResponse> {
  const store = deps.inventory;
  if (store === undefined) return fail(501, 'This hub keeps no inventory.', 'Run it with a data directory or a database.');
  const method = request.method.toUpperCase();
  const [pathPart, queryPart = ''] = request.path.split('?');
  const query = new URLSearchParams(queryPart);
  const parts = (pathPart ?? '').split('/').filter((p) => p !== '').slice(2).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const ifMatch = request.headers?.['if-match'];
  const user = request.user ?? fallbackUser;
  const actor = user.email ?? user.name;
  const [head, id, action, extra] = parts;
  const allow = (...methods: string[]): ApiResponse | undefined => (methods.includes(method) ? undefined : fail(405, `${method} is not something this address accepts.`, `It answers ${methods.join(' and ')}.`));
  const dimOfLot = async (lot: string): Promise<Dimension> => {
    const found = await store.read((tx) => tx.lot(lot));
    if (found === undefined) throw new InventoryError(404, `There is no lot '${lot}'.`);
    return found.dim;
  };
  try {
    if (head === undefined) {
      const bad = allow('GET');
      if (bad !== undefined) return bad;
      return await store.read(async (tx) => {
        const lots = await tx.lots({ empty: query.get('empty') === '1' });
        const reservations = await tx.reservations({ status: 'open' });
        return ok({
          backend: store.backend,
          units: Object.fromEntries(DIMENSIONS.map((d) => [d, Object.entries(UNITS).filter(([, u]) => u.dim === d).map(([k]) => k)])),
          locations: await tx.locations(),
          lots,
          labels: await labelsFor(deps, [...lots.map((l) => l.item), ...reservations.map((r): ItemRef => ({ kind: 'designs', id: r.design }))]),
          reservations,
        });
      });
    }

    if (head === 'locations') {
      if (id === undefined) {
        const bad = allow('POST');
        if (bad !== undefined) return bad;
        const body = bodyOf(request.body);
        const parent = text(body, 'parent', 20);
        const note = text(body, 'note', 2000);
        const location = await store.transact(actor, (tx) => createLocation(tx, { name: text(body, 'name', 120, true), ...(parent === undefined ? {} : { parent }), ...(note === undefined ? {} : { note }) }));
        return ok({ location }, 201, { headers: { etag: versionTag(location) }, events: changed('location', location.id, 'location-created', { name: location.name }) });
      }
      if (!ID.test(id) || action !== undefined) return fail(404, `${request.path} is not an inventory address.`);
      const bad = allow('PATCH', 'DELETE');
      if (bad !== undefined) return bad;
      if (method === 'DELETE') {
        await store.transact(actor, (tx) => deleteLocation(tx, id, ifMatch));
        return ok({ deleted: id }, 200, { events: changed('location', id, 'location-deleted') });
      }
      const body = bodyOf(request.body);
      const patch: { name?: string; parent?: string | null; note?: string | null } = {};
      if (body['name'] !== undefined) patch.name = text(body, 'name', 120, true);
      if (body['parent'] !== undefined) patch.parent = body['parent'] === null ? null : text(body, 'parent', 20, true);
      if (body['note'] !== undefined) patch.note = body['note'] === null ? null : (text(body, 'note', 2000) ?? null);
      const location = await store.transact(actor, (tx) => updateLocation(tx, id, patch, ifMatch));
      return ok({ location }, 200, { headers: { etag: versionTag(location) }, events: changed('location', id, 'location-changed') });
    }

    if (head === 'receive' && id === undefined) {
      const bad = allow('POST');
      if (bad !== undefined) return bad;
      const body = bodyOf(request.body);
      const item = itemOf(body['item']);
      const known = await itemExists(deps, item);
      if (known === undefined) return fail(422, `There is no ${item.kind} record '${item.id}'.`, 'Receive stock of a record in the library.');
      const unit = text(body, 'unit', 4);
      const dim = unit === undefined ? known.dim : (UNITS[unit]?.dim ?? known.dim);
      const qty = quantity(number(body, 'qty', true), unit, dim);
      const optional = (key: string, max: number) => {
        const v = text(body, key, max);
        return v === undefined ? {} : { [key]: v };
      };
      const unitCostIn = number(body, 'unitCost');
      // a price is per the unit it was entered in; the lot keeps it per base unit
      const unitCost = unitCostIn === undefined ? undefined : unitCostIn / (UNITS[unit ?? BASE_UNIT[dim]]?.factor ?? 1);
      const done = await store.transact(actor, (tx) =>
        receive(tx, {
          item,
          dim,
          qty,
          location: text(body, 'location', 20, true),
          ...optional('lotCode', 120),
          ...optional('supplier', 120),
          ...optional('supplierRef', 120),
          ...optional('currency', 8),
          ...optional('note', 2000),
          ...(unitCost === undefined ? {} : { unitCost }),
        }),
      );
      return ok(done, 201, { headers: { etag: versionTag(done.lot) }, events: changed('lot', done.lot.id, 'received', lotSummary(done.lot)) });
    }

    if (head === 'lots' && id !== undefined && ID.test(id)) {
      if (action === undefined && method === 'PATCH') {
        const body = bodyOf(request.body);
        const patch: LotPatch = {};
        for (const [key, max] of [['lotCode', 120], ['supplier', 120], ['supplierRef', 120], ['currency', 8], ['note', 2000]] as const) {
          if (body[key] === undefined) continue;
          patch[key] = body[key] === null || body[key] === '' ? null : text(body, key, max, true);
        }
        if (body['unitCost'] !== undefined) {
          const cost = body['unitCost'] === null || body['unitCost'] === '' ? null : number(body, 'unitCost', true);
          const current = cost === null ? undefined : await store.read((tx) => tx.lot(id));
          // a price is per the unit it was entered in; the lot keeps it per base unit
          const unit = text(body, 'unit', 4);
          if (cost !== null && current !== undefined && unit !== undefined) {
            const u = UNITS[unit];
            if (u === undefined || u.dim !== current.dim) throw new InventoryError(422, `${unit} is not a unit this lot is counted in (${BASE_UNIT[current.dim]}).`);
            patch.unitCost = cost / u.factor;
          } else patch.unitCost = cost;
        }
        const done = await store.transact(actor, (tx) => editLot(tx, id, patch, ifMatch));
        return ok(done, 200, { headers: { etag: versionTag(done.lot) }, ...(done.movement === undefined ? {} : { events: changed('lot', id, 'edited', { ...lotSummary(done.lot), change: done.movement.note }) }) });
      }
      if (action === undefined) {
        const bad = allow('GET', 'PATCH');
        if (bad !== undefined) return bad;
        return await store.read(async (tx) => {
          const lot = await tx.lot(id);
          if (lot === undefined) return fail(404, `There is no lot '${id}'.`);
          return ok({ lot, movements: await tx.movements({ lot: id, limit: 200 }) }, 200, { headers: { etag: versionTag(lot) } });
        });
      }
      const bad = allow('POST');
      if (bad !== undefined) return bad;
      const body = bodyOf(request.body ?? {});
      const current = await store.read((tx) => tx.lot(id));
      if (current === undefined) return fail(404, `There is no lot '${id}'.`);
      const unit = text(body, 'unit', 4);
      const note = text(body, 'note', 2000);
      if (action === 'move') {
        const qtyIn = number(body, 'qty');
        const done = await store.transact(actor, (tx) => move(tx, id, { to: text(body, 'to', 20, true), ...(qtyIn === undefined ? {} : { qty: quantity(qtyIn, unit, current.dim) }), ...(note === undefined ? {} : { note }) }, ifMatch));
        return ok(done, 200, { headers: { etag: versionTag(done.lot) }, events: changed('lot', id, done.split === undefined ? 'moved' : 'split', lotSummary(done.lot)) });
      }
      if (action === 'adjust') {
        const reason = text(body, 'reason', 500);
        const delta = number(body, 'delta');
        const count = number(body, 'count');
        if ((delta === undefined) === (count === undefined)) return fail(400, 'Send either delta (a signed change) or count (what is there now).');
        const done = await store.transact(actor, (tx) => adjust(tx, id, { ...(reason === undefined ? {} : { reason }), ...(delta === undefined ? {} : { delta: quantity(delta, unit, current.dim) }), ...(count === undefined ? {} : { count: quantity(count, unit, current.dim) }) }, ifMatch));
        return ok(done, 200, { headers: { etag: versionTag(done.lot) }, events: changed('lot', id, 'adjusted', { ...lotSummary(done.lot), delta: done.movement.qty, reason }) });
      }
      return fail(404, `${request.path} is not an inventory address.`);
    }

    if (head === 'items' && id !== undefined && action !== undefined && extra === undefined) {
      const bad = allow('GET');
      if (bad !== undefined) return bad;
      const item = itemOf({ kind: id, id: action });
      return await store.read(async (tx) => {
        const lots = await tx.lots({ item, empty: query.get('empty') === '1' });
        const holding = (await tx.reservations({ status: 'open' })).filter((r) => r.lines.some((l) => itemKey(l.item) === itemKey(item)));
        return ok({ item, lots, locations: await tx.locations(), reservations: holding, movements: await tx.movements({ item, limit: 50 }), batches: await tx.batches({ item, limit: 50 }) });
      });
    }

    if (head === 'movements' && id === undefined) {
      const bad = allow('GET');
      if (bad !== undefined) return bad;
      const lot = query.get('lot') ?? undefined;
      const res = query.get('reservation') ?? undefined;
      const itemText = query.get('item');
      const before = query.get('before');
      const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? 100) || 100));
      const item = itemText === null ? undefined : itemOf({ kind: itemText.split(':')[0], id: itemText.split(':').slice(1).join(':') });
      return await store.read(async (tx) => {
        const movements = await tx.movements({ ...(lot === undefined ? {} : { lot }), ...(res === undefined ? {} : { reservation: res }), ...(item === undefined ? {} : { item }), ...(before === null ? {} : { before: Number(before) }), limit });
        // used-up lots are not in GET /api/inventory, so their names come with the rows
        return ok({ movements, labels: await labelsFor(deps, movements.map((m) => m.item)) });
      });
    }

    if (head === 'builds' && id !== undefined && action === undefined) {
      const bad = allow('GET');
      if (bad !== undefined) return bad;
      const qty = Number(query.get('qty') ?? 1);
      const revText = query.get('rev');
      const rev = revText === null || revText === '' ? undefined : Number(revText);
      if (rev !== undefined && !Number.isInteger(rev)) return fail(400, 'rev is a revision number.');
      const { requirement, db, design } = await requirementFor(deps, id, qty, allowanceOf(query), rev, query.get('explode') === '1');
      const view = await store.read(async (tx) => {
        const lotsByItem = new Map<string, Lot[]>();
        for (const line of requirement.lines) lotsByItem.set(itemKey(line.item), await tx.lots({ item: line.item }));
        const open = await tx.reservations({ design: id, status: 'open' });
        return { lotsByItem, body: { ...requirement, lines: shortage(requirement, lotsByItem, open), reservations: open, locations: await tx.locations(), batches: await tx.batches({ item: { kind: 'designs', id }, limit: 20 }) } };
      });
      // one unit's derived mass, beside what batches measured (an estimate; never in an export)
      const massEstimate = massEstimateOf(design, db);
      const batches = await withMassEstimates(deps, view.body.batches);
      // optional: cost from lot costs and dated offers, and where cut stock goes (never a gate)
      const sourcing = await buildSourcing(view.body.lines, requirement, view.lotsByItem, deps.offers, db, new Date().toISOString().slice(0, 10));
      // one total in the currency of a saved fx-rates snapshot, when the design carries one
      const converted = sourcing === undefined ? undefined : convertedTotal(sourcing.totals, design.extensions?.['fx-rates']);
      return ok({ ...view.body, batches, massEstimate, ...(sourcing === undefined ? {} : { sourcing: { ...sourcing, ...(converted === undefined ? {} : { converted }) } }) });
    }

    if (head === 'offers') return await handleOffers(method, id, query, request.body, deps.offers, actor, new Date().toISOString());

    if (head === 'reservations') {
      if (id === undefined) {
        const bad = allow('GET', 'POST');
        if (bad !== undefined) return bad;
        if (method === 'GET') {
          const design = query.get('design') ?? undefined;
          const status = query.get('status');
          return await store.read(async (tx) => ok({ reservations: await tx.reservations({ ...(design === undefined ? {} : { design }), ...(status === 'open' || status === 'closed' ? { status } : {}) }) }));
        }
        const body = bodyOf(request.body);
        const design = text(body, 'design', 200, true);
        const rev = number(body, 'rev');
        const label = text(body, 'label', 200);
        const prefer = text(body, 'prefer', 20);
        const { requirement } = await requirementFor(deps, design, number(body, 'qty') ?? 1, allowanceOf(body), rev, body['explode'] === true);
        // a working copy that is its latest saved revision builds to that revision
        const pinned = rev ?? (await savedRevOfWorking(deps, design));
        const reservation = await store.transact(actor, (tx) => reserve(tx, requirement, { partial: body['partial'] !== false, ...(pinned === undefined ? {} : { rev: pinned }), ...(label === undefined ? {} : { label }), ...(prefer === undefined ? {} : { prefer }) }));
        return ok({ reservation }, 201, { headers: { etag: versionTag(reservation) }, events: changed('reservation', reservation.id, 'reserved', { design, buildQty: reservation.buildQty, lines: reservation.lines.length }) });
      }
      if (!ID.test(id)) return fail(404, `There is no reservation '${id}'.`);
      if (action === undefined) {
        const bad = allow('GET');
        if (bad !== undefined) return bad;
        return await store.read(async (tx) => {
          const r = await tx.reservation(id);
          if (r === undefined) return fail(404, `There is no reservation '${id}'.`);
          return ok({ reservation: r, movements: await tx.movements({ reservation: id }), batches: await tx.batches({ reservation: id }) }, 200, { headers: { etag: versionTag(r) } });
        });
      }
      const bad = allow('POST');
      if (bad !== undefined) return bad;
      const body = bodyOf(request.body ?? {});
      const note = text(body, 'note', 2000);
      if (action === 'consume') {
        const units = number(body, 'units');
        const items: { lot: string; qty: number }[] = [];
        if (Array.isArray(body['items'])) {
          for (const raw of body['items']) {
            const entry = bodyOf(raw);
            const lot = text(entry, 'lot', 20, true);
            items.push({ lot, qty: quantity(number(entry, 'qty', true), text(entry, 'unit', 4), await dimOfLot(lot)) });
          }
        }
        if ((units === undefined) === (items.length === 0)) return fail(400, 'Send units (finished units) or items (lot and quantity).');
        const done = await store.transact(actor, (tx) => consume(tx, id, { ...(units === undefined ? { items } : { units }), ...(note === undefined ? {} : { note }) }, ifMatch));
        return ok(done, 200, { headers: { etag: versionTag(done.reservation) }, events: changed('reservation', id, 'consumed', { design: done.reservation.design, movements: done.movements.length, status: done.reservation.status }) });
      }
      if (action === 'return') {
        const lot = text(body, 'lot', 20, true);
        const into = text(body, 'into', 20);
        const qty = quantity(number(body, 'qty', true), text(body, 'unit', 4), await dimOfLot(lot));
        const done = await store.transact(actor, (tx) => giveBack(tx, id, { lot, qty, ...(into === undefined ? {} : { into }), ...(note === undefined ? {} : { note }) }));
        return ok(done, 200, { headers: { etag: versionTag(done.reservation) }, events: changed('reservation', id, 'returned', { design: done.reservation.design, lot: done.movement.lot, qty: done.movement.qty }) });
      }
      if (action === 'complete') {
        const input = batchInputOf(body);
        const done = await store.transact(actor, (tx) => completeUnits(tx, id, input, ifMatch));
        return ok(done, 200, { headers: { etag: versionTag(done.reservation) }, events: changed('batch', done.batch.id, 'completed', { design: done.reservation.design, reservation: id, units: done.batch.units, failed: done.batch.failed, unitsDone: done.reservation.unitsDone ?? 0, status: done.reservation.status }) });
      }
      if (action === 'release') {
        const items = Array.isArray(body['items']) ? body['items'].map(itemOf) : undefined;
        const reservation = await store.transact(actor, (tx) => release(tx, id, items === undefined ? {} : { items }, ifMatch));
        return ok({ reservation }, 200, { headers: { etag: versionTag(reservation) }, events: changed('reservation', id, 'released', { design: reservation.design, status: reservation.status }) });
      }
    }
    if (head === 'batches' && id === undefined) {
      const bad = allow('GET', 'POST');
      if (bad !== undefined) return bad;
      if (method === 'GET') {
        const itemText = query.get('item');
        const item = itemText === null ? undefined : itemOf({ kind: itemText.split(':')[0], id: itemText.split(':').slice(1).join(':') });
        const res = query.get('reservation') ?? undefined;
        const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? 100) || 100));
        const read = await store.read(async (tx) => {
          const batches = await tx.batches({ ...(item === undefined ? {} : { item }), ...(res === undefined ? {} : { reservation: res }), limit });
          return { batches, labels: await labelsFor(deps, batches.map((x) => x.item)) };
        });
        // a derived estimate beside each measured unit mass, read outside the inventory transaction
        return ok({ batches: await withMassEstimates(deps, read.batches), labels: read.labels });
      }
      const body = bodyOf(request.body);
      const item = itemOf(body['item']);
      if ((await itemExists(deps, item)) === undefined) return fail(422, `There is no ${item.kind} record '${item.id}'.`);
      const variant = text(body, 'variant', 64);
      const uses: { lot: string; qty: number }[] = [];
      if (body['consume'] !== undefined && !Array.isArray(body['consume'])) return fail(400, 'consume is a list of { lot, qty, unit }.');
      for (const raw of (body['consume'] as unknown[] | undefined) ?? []) {
        const entry = bodyOf(raw);
        const lot = text(entry, 'lot', 20, true);
        uses.push({ lot, qty: quantity(number(entry, 'qty', true), text(entry, 'unit', 4), await dimOfLot(lot)) });
      }
      const input = batchInputOf(body);
      const done = await store.transact(actor, (tx) => recordBatch(tx, { ...input, item, consume: uses, ...(variant === undefined ? {} : { variant }) }));
      return ok(done, 201, { events: changed('batch', done.batch.id, 'recorded', { item: itemKey(item), units: done.batch.units, failed: done.batch.failed, ...(variant === undefined ? {} : { variant }), consumed: done.movements.filter((m) => m.kind === 'consume').length }) });
    }
    return fail(404, `${request.path} is not an inventory address.`, `Try one of: ${INVENTORY_ROUTES.join('; ')}.`);
  } catch (error) {
    if (error instanceof InventoryError) return fail(error.status, error.message, error.hint);
    throw error;
  }
}
