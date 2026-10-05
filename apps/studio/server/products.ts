/**
 * Products and the lineup over the API (`@wirehub/model` `products.ts`, `docs/products.md`):
 *
 *   GET  /api/products                    the families (local and from packs), their issues, the ETag
 *   PUT  /api/products                    { products: [...] } — this hub's own families (If-Match)
 *   GET  /api/products/:id                one family, each variant with its design, route, released revision and cost
 *   POST /api/products/:id/merge          { from: [ids] } — merge those families into this one
 *   POST /api/products/:id/split          { variants: [ids], id, label, partNumber? } — split variants off into a new family
 *   GET  /api/products/:id/next-number    the scheme's next variant number for this family (a proposal)
 *   GET  /api/lineup[?retired=1]          every variant as a row (JSON)
 *   GET  /api/lineup.csv[?retired=1]      the same as CSV
 *
 * The families are the catalog document `data/products.json`, written through the unit of work
 * (both backends). A change raises `product.changed` for each family it touches (webhooks).
 */

import { deriveBomSheet } from '@wirehub/docs';
import {
  findProduct,
  knownPartNumbers,
  lineupCsv,
  lineupRows,
  mergeProducts,
  productIssues,
  splitProduct,
  suggestVariantNumber,
  type CableDesign,
  type Db,
  type ProductFamily,
} from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { withDesignLibrary } from './assemblies.ts';
import { readAllDesigns } from './designs.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';
import { workingStatus } from './versions.ts';
import type { DomainEvent } from './webhooks/events.ts';

export const PRODUCTS_PATH = 'data/products.json';
const PRODUCTS_FILE = 'products.json';

export const PRODUCT_ROUTES = [
  'GET    /api/products',
  'PUT    /api/products',
  'GET    /api/products/:id',
  'POST   /api/products/:id/merge',
  'POST   /api/products/:id/split',
  'GET    /api/products/:id/next-number',
  'GET    /api/lineup',
  'GET    /api/lineup.csv',
] as const;

export const isProductsPath = (parts: string[]): boolean => parts[0] === 'api' && (parts[1] === 'products' || parts[1] === 'lineup' || parts[1] === 'lineup.csv');

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

async function localProducts(deps: WorkbenchDeps): Promise<ProductFamily[]> {
  const stored = await deps.docs?.read(PRODUCTS_PATH);
  return Array.isArray(stored) ? (stored as ProductFamily[]) : [];
}

async function packOwners(deps: WorkbenchDeps): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const pack of (await deps.installedPacks?.())?.packs ?? []) for (const id of pack.added[PRODUCTS_FILE] ?? []) if (!owners.has(id)) owners.set(id, pack.id);
  return owners;
}

/** Each design's released revision: the approved one when approvals are on, else the latest saved. */
export async function releasedOf(deps: WorkbenchDeps, designs: readonly CableDesign[]): Promise<Map<string, number | undefined>> {
  const out = new Map<string, number | undefined>();
  for (const d of designs) {
    const status = await workingStatus(deps, d.id, d);
    out.set(d.id, status.approvals === true ? status.releasedRev : status.latestRev);
  }
  return out;
}

/** Each design's cost roll-up for one cable (the BOM's), when anything in it is priced. */
async function costsOf(deps: WorkbenchDeps, db: Db, designs: readonly CableDesign[]): Promise<Map<string, { total: number; currency?: string } | undefined>> {
  const out = new Map<string, { total: number; currency?: string } | undefined>();
  for (const d of designs) {
    try {
      const cost = deriveBomSheet(d, await withDesignLibrary(deps, d, db)).cost;
      out.set(d.id, cost === undefined ? undefined : { total: cost.total, ...(cost.currency === undefined ? {} : { currency: cost.currency }) });
    } catch {
      out.set(d.id, undefined);
    }
  }
  return out;
}

async function context(deps: WorkbenchDeps, products: readonly ProductFamily[]): Promise<{ db: Db; designs: CableDesign[]; named: CableDesign[]; released: Map<string, number | undefined> }> {
  const db = await deps.loadDb();
  const designs = await readAllDesigns(deps.designs);
  const wanted = new Set(products.flatMap((p) => p.variants.map((v) => v.design)));
  const named = designs.filter((d) => wanted.has(d.id));
  return { db, designs, named, released: await releasedOf(deps, named) };
}

async function view(deps: WorkbenchDeps, products?: ProductFamily[]): Promise<{ body: Record<string, unknown>; etag: string }> {
  const local = await localProducts(deps);
  const all = products ?? (await deps.loadDb()).products ?? [];
  const owners = await packOwners(deps);
  const ctx = await context(deps, all);
  const scheme = await partNumberSchemeOf(deps);
  const etag = contentETag(local.length === 0 ? null : local);
  return {
    etag,
    body: {
      products: all.map((p) => ({ ...p, origin: owners.has(p.id) ? 'pack' : 'local', ...(owners.has(p.id) ? { pack: owners.get(p.id) } : {}) })),
      local,
      issues: productIssues(all, { designs: ctx.designs, scheme, released: ctx.released }),
      etag,
    },
  };
}

/** The family changes between two lists, as `product.changed` events. */
function changeEvents(before: readonly ProductFamily[], after: readonly ProductFamily[], action?: string): DomainEvent[] {
  const was = new Map(before.map((p) => [p.id, JSON.stringify(p)]));
  const now = new Map(after.map((p) => [p.id, p]));
  const events: DomainEvent[] = [];
  for (const p of after) {
    const old = was.get(p.id);
    if (old === JSON.stringify(p)) continue;
    events.push({ type: 'product.changed', subject: { kind: 'product', id: p.id, label: p.label }, summary: { action: action ?? (old === undefined ? 'created' : 'updated'), variants: p.variants.length, ...(p.partNumber === undefined ? {} : { partNumber: p.partNumber }) } });
  }
  for (const p of before) if (!now.has(p.id)) events.push({ type: 'product.changed', subject: { kind: 'product', id: p.id, label: p.label }, summary: { action: action === 'merged' ? 'merged' : 'removed' } });
  return events;
}

/** Write `next` as this hub's own families, refusing a list with errors; the answer carries the events. */
async function store(deps: WorkbenchDeps, next: ProductFamily[], before: ProductFamily[], action?: string): Promise<ApiResponse> {
  const designs = await readAllDesigns(deps.designs);
  const errors = productIssues(next, { designs }).filter((i) => i.severity === 'error');
  if (errors.length > 0) return fail(422, `Those products cannot be used: ${errors[0]!.message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}.`, 'Nothing was saved.', { issues: errors });
  // where a pack was merged into the catalog its families sit in this document; the ones not mentioned stay
  const owners = await packOwners(deps);
  const ids = new Set(next.map((p) => p.id));
  const local = await localProducts(deps);
  const kept = local.filter((p) => owners.has(p.id) && !ids.has(p.id));
  const stored = [...next, ...kept];
  if (stored.length === 0) await deps.docs!.remove(PRODUCTS_PATH);
  else await deps.docs!.write(PRODUCTS_PATH, stored);
  const fromPacks = ((await deps.loadDb()).products ?? []).filter((p) => owners.has(p.id) && !ids.has(p.id));
  const fresh = await view(deps, [...next, ...fromPacks]);
  return { status: 200, body: fresh.body, headers: { ETag: contentETag(stored.length === 0 ? null : stored) }, events: changeEvents(before, next, action) };
}

async function productPage(deps: WorkbenchDeps, id: string): Promise<ApiResponse> {
  const all = (await deps.loadDb()).products ?? [];
  const product = findProduct(all, id);
  if (product === undefined) return fail(404, `There is no product '${id}'.`, 'GET /api/products lists them.');
  const ctx = await context(deps, [product]);
  const costs = await costsOf(deps, ctx.db, ctx.named);
  const scheme = await partNumberSchemeOf(deps);
  const rows = lineupRows([product], { designs: ctx.named, released: ctx.released, costs }, { retired: true });
  return {
    status: 200,
    body: {
      product,
      rows,
      issues: productIssues(all, { designs: ctx.designs, scheme, released: ctx.released }).filter((i) => i.where?.startsWith(`products/${id}`)),
    },
  };
}

async function lineup(deps: WorkbenchDeps, csv: boolean, retired: boolean): Promise<ApiResponse> {
  const all = (await deps.loadDb()).products ?? [];
  const ctx = await context(deps, all);
  const costs = await costsOf(deps, ctx.db, ctx.named);
  const rows = lineupRows(all, { designs: ctx.named, released: ctx.released, costs }, { retired });
  if (!csv) return { status: 200, body: { rows } };
  return { status: 200, body: null, bytes: new TextEncoder().encode(lineupCsv(rows)), contentType: 'text/csv; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="lineup.csv"' } };
}

export async function handleProductsRequest(method: string, parts: string[], path: string, body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined): Promise<ApiResponse> {
  const params = new URLSearchParams(path.split('?')[1] ?? '');
  if (parts[1] === 'lineup' || parts[1] === 'lineup.csv') {
    if (parts.length !== 2) return fail(404, `${parts.join('/')} is not part of the workbench API.`, `Try ${PRODUCT_ROUTES.join('; ')}.`);
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return lineup(deps, parts[1] === 'lineup.csv', params.get('retired') === '1');
  }
  const id = parts[2];
  const action = parts[3];
  if (id === undefined) {
    if (method === 'GET') {
      const v = await view(deps);
      return { status: 200, body: v.body, headers: { ETag: v.etag } };
    }
    if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
    if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Products are stored with the catalog.');
    const local = await localProducts(deps);
    const guard = checkIfMatch(ifMatch, contentETag(local.length === 0 ? null : local), 'products', 'products');
    if (guard !== undefined) return guard;
    const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { products?: unknown }).products : undefined;
    if (!Array.isArray(list)) return fail(400, 'Send { "products": [ … ] }: this hub\'s own product families, replacing the ones it has.', 'An empty list removes them all.');
    if (list.some((p) => typeof p !== 'object' || p === null || typeof (p as { id?: unknown }).id !== 'string' || !Array.isArray((p as { variants?: unknown }).variants))) {
      return fail(422, 'Every product is a record with an id and a variants list.', 'Nothing was saved.');
    }
    const before = (await deps.loadDb()).products ?? [];
    return store(deps, list as ProductFamily[], before);
  }
  if (action === undefined && parts.length === 3) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET; PUT /api/products saves.');
    return productPage(deps, id);
  }
  if (action === 'next-number' && parts.length === 4) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const db = await deps.loadDb();
    const product = findProduct(db.products, id);
    if (product === undefined) return fail(404, `There is no product '${id}'.`);
    const designs = await readAllDesigns(deps.designs);
    const scheme = await partNumberSchemeOf(deps);
    const suggestion = suggestVariantNumber(scheme, product, knownPartNumbers(db, designs));
    return { status: 200, body: { scheme: scheme.id, ...(suggestion === undefined ? { suggestion: null } : { suggestion }) } };
  }
  if ((action === 'merge' || action === 'split') && parts.length === 4) {
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.');
    const before = (await deps.loadDb()).products ?? [];
    const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (action === 'merge') {
      const from = Array.isArray(request['from']) ? request['from'].filter((x): x is string => typeof x === 'string') : [];
      const merged = mergeProducts(before, id, from);
      if (!merged.ok) return fail(422, `Not merged: ${merged.reason}.`);
      return store(deps, merged.products, before, 'merged');
    }
    const variants = Array.isArray(request['variants']) ? request['variants'].filter((x): x is string => typeof x === 'string') : [];
    const nextId = typeof request['id'] === 'string' ? request['id'] : '';
    const label = typeof request['label'] === 'string' && request['label'].trim() !== '' ? request['label'] : nextId;
    const partNumber = typeof request['partNumber'] === 'string' && request['partNumber'].trim() !== '' ? request['partNumber'] : undefined;
    const split = splitProduct(before, id, variants, { id: nextId, label, ...(partNumber === undefined ? {} : { partNumber }) });
    if (!split.ok) return fail(422, `Not split: ${split.reason}.`);
    return store(deps, split.products, before, 'split');
  }
  return fail(404, `${parts.join('/')} is not part of the workbench API.`, `Try ${PRODUCT_ROUTES.join('; ')}.`);
}
