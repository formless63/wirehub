/**
 * The inventory rules, once, over any store (`store.ts`): receive, move, adjust, edit a lot's
 * details, reserve, consume, return, release, and record batches of made units. Every physical change is a ledger movement written in the same transaction
 * as the balance it changes; a balance never goes below zero and never below what is held for a
 * build. A failed rule throws `InventoryError` and the store writes nothing.
 */

import type { BuildRequirement } from './requirements.ts';
import type { InvTx } from './store.ts';
import { BASE_UNIT, freeOf, InventoryError, itemKey, roundQty, SERIAL, versionTag, type Allocation, type Batch, type Dimension, type ItemRef, type Location, type Lot, type Measured, type Movement, type Reservation, type ReservationLine } from './types.ts';

/** `If-Match` against a record's version: absent passes (the ledger guards balances), stale refuses. */
function checkVersion(ifMatch: string | undefined, record: { id: string; version: number }, what: string): void {
  if (ifMatch === undefined || ifMatch.trim() === '' || ifMatch.trim() === '*') return;
  const want = versionTag(record).replace(/"/g, '');
  if (!ifMatch.split(',').some((t) => t.trim().replace(/^W\//, '').replace(/"/g, '') === want)) {
    throw new InventoryError(409, `This ${what} changed since you loaded it.`, 'Nothing was written. Reload and try again.');
  }
}

async function mustLocation(tx: InvTx, id: string): Promise<Location> {
  const found = await tx.location(id);
  if (found === undefined) throw new InventoryError(404, `There is no location '${id}'.`);
  return found;
}

async function mustLot(tx: InvTx, id: string): Promise<Lot> {
  const found = await tx.lot(id, true);
  if (found === undefined) throw new InventoryError(404, `There is no lot '${id}'.`);
  return found;
}

async function record(tx: InvTx, lot: Lot, entry: Omit<Movement, 'seq' | 'at' | 'by' | 'lot' | 'item' | 'onHandAfter'>): Promise<Movement> {
  return tx.append({ at: tx.now(), by: tx.actor, lot: lot.id, item: lot.item, onHandAfter: lot.onHand, ...entry });
}

/* ------------------------------------------------------------------ *
 * Locations
 * ------------------------------------------------------------------ */

export async function createLocation(tx: InvTx, input: { name: string; parent?: string; note?: string }): Promise<Location> {
  if (input.parent !== undefined) await mustLocation(tx, input.parent);
  const all = await tx.locations();
  if (all.some((l) => l.name.toLowerCase() === input.name.toLowerCase() && l.parent === input.parent)) {
    throw new InventoryError(409, `There is already a location '${input.name}' there.`);
  }
  const location: Location = { id: tx.newId('loc'), name: input.name, ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.note === undefined ? {} : { note: input.note }), version: 1, createdAt: tx.now() };
  await tx.putLocation(location);
  return location;
}

export async function updateLocation(tx: InvTx, id: string, patch: { name?: string; parent?: string | null; note?: string | null }, ifMatch: string | undefined): Promise<Location> {
  const location = await mustLocation(tx, id);
  if (ifMatch === undefined) throw new InventoryError(428, `Changing location '${location.name}' needs the version you loaded (If-Match).`, 'Reload and try again.');
  checkVersion(ifMatch, location, 'location');
  const next: Location = { ...location, version: location.version + 1 };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.note === null) delete next.note;
  else if (patch.note !== undefined) next.note = patch.note;
  if (patch.parent === null) delete next.parent;
  else if (patch.parent !== undefined) {
    // no cycles: the new parent may not be this location or inside it
    const all = await tx.locations();
    for (let at: string | undefined = patch.parent; at !== undefined; at = all.find((l) => l.id === at)?.parent) {
      if (at === id) throw new InventoryError(422, 'A location cannot be put inside itself.');
      if (!all.some((l) => l.id === at)) throw new InventoryError(404, `There is no location '${at}'.`);
    }
    next.parent = patch.parent;
  }
  await tx.putLocation(next);
  return next;
}

export async function deleteLocation(tx: InvTx, id: string, ifMatch: string | undefined): Promise<void> {
  const location = await mustLocation(tx, id);
  checkVersion(ifMatch, location, 'location');
  if ((await tx.locations()).some((l) => l.parent === id)) throw new InventoryError(409, `'${location.name}' holds other locations.`, 'Move or remove them first.');
  if ((await tx.lots({ location: id, empty: true })).length > 0) throw new InventoryError(409, `'${location.name}' has lots recorded in it.`, 'Move them elsewhere first; the ledger keeps where they were.');
  await tx.deleteLocation(id);
}

/* ------------------------------------------------------------------ *
 * Receive, move, adjust
 * ------------------------------------------------------------------ */

export interface ReceiveInput {
  item: ItemRef;
  dim: Dimension;
  qty: number;
  location: string;
  lotCode?: string;
  supplier?: string;
  supplierRef?: string;
  unitCost?: number;
  currency?: string;
  note?: string;
}

export async function receive(tx: InvTx, input: ReceiveInput): Promise<{ lot: Lot; movement: Movement }> {
  if (!(input.qty > 0)) throw new InventoryError(422, 'A receipt needs a quantity above zero.');
  await mustLocation(tx, input.location);
  const lot: Lot = {
    id: tx.newId('lot'),
    item: input.item,
    dim: input.dim,
    location: input.location,
    ...(input.lotCode === undefined ? {} : { lotCode: input.lotCode }),
    ...(input.supplier === undefined ? {} : { supplier: input.supplier }),
    ...(input.supplierRef === undefined ? {} : { supplierRef: input.supplierRef }),
    ...(input.unitCost === undefined ? {} : { unitCost: input.unitCost }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(input.note === undefined ? {} : { note: input.note }),
    receivedAt: tx.now(),
    onHand: roundQty(input.qty),
    reserved: 0,
    version: 1,
  };
  await tx.putLot(lot);
  const movement = await record(tx, lot, { kind: 'receive', qty: lot.onHand, to: input.location, ...(input.note === undefined ? {} : { note: input.note }) });
  return { lot, movement };
}

/**
 * Move a lot. Without `qty` (or with all of it) the lot itself moves, reservations and all; with
 * part of its free stock, that part splits off as a new lot at the destination.
 */
export async function move(tx: InvTx, id: string, input: { to: string; qty?: number; note?: string }, ifMatch: string | undefined): Promise<{ lot: Lot; split?: Lot; movements: Movement[] }> {
  const lot = await mustLot(tx, id);
  checkVersion(ifMatch, lot, 'lot');
  await mustLocation(tx, input.to);
  if (input.to === lot.location) throw new InventoryError(422, 'The lot is already there.');
  const note = input.note === undefined ? {} : { note: input.note };
  if (input.qty === undefined || roundQty(input.qty) === lot.onHand) {
    const from = lot.location;
    const moved: Lot = { ...lot, location: input.to, version: lot.version + 1 };
    await tx.putLot(moved);
    return { lot: moved, movements: [await record(tx, moved, { kind: 'move', qty: 0, from, to: input.to, ...note })] };
  }
  const qty = roundQty(input.qty);
  if (!(qty > 0)) throw new InventoryError(422, 'Move a quantity above zero.');
  if (qty > freeOf(lot)) throw new InventoryError(409, `Only ${freeOf(lot)} of this lot is free to move.`, lot.reserved > 0 ? 'The rest is held for a build; release it or move the whole lot.' : undefined);
  const source: Lot = { ...lot, onHand: roundQty(lot.onHand - qty), version: lot.version + 1 };
  const split: Lot = { ...lot, id: tx.newId('lot'), location: input.to, onHand: qty, reserved: 0, parent: lot.id, version: 1 };
  await tx.putLot(source);
  await tx.putLot(split);
  const out = await record(tx, source, { kind: 'split', qty: -qty, from: lot.location, to: input.to, otherLot: split.id, ...note });
  const into = await record(tx, split, { kind: 'split', qty, from: lot.location, to: input.to, otherLot: lot.id, ...note });
  return { lot: source, split, movements: [out, into] };
}

/** Correct a lot's count: by a signed `delta`, or to a counted `count`. A reason is optional. */
export async function adjust(tx: InvTx, id: string, input: { delta?: number; count?: number; reason?: string }, ifMatch: string | undefined): Promise<{ lot: Lot; movement: Movement }> {
  const lot = await mustLot(tx, id);
  checkVersion(ifMatch, lot, 'lot');
  const target = input.count !== undefined ? roundQty(input.count) : roundQty(lot.onHand + (input.delta ?? 0));
  const delta = roundQty(target - lot.onHand);
  if (delta === 0) throw new InventoryError(422, 'That changes nothing.');
  if (target < 0) throw new InventoryError(422, `The lot holds ${lot.onHand}; it cannot go below zero.`);
  if (target < lot.reserved) throw new InventoryError(409, `${lot.reserved} of this lot is held for a build.`, 'Release that reservation first, or count at least what it holds.');
  const next: Lot = { ...lot, onHand: target, version: lot.version + 1 };
  await tx.putLot(next);
  return { lot: next, movement: await record(tx, next, { kind: 'adjust', qty: delta, ...(input.reason === undefined ? {} : { reason: input.reason }) }) };
}

/** A lot's details: everything but where it is and how much. `null` clears a field. */
export interface LotPatch {
  lotCode?: string | null;
  supplier?: string | null;
  supplierRef?: string | null;
  /** per base unit (ea, mm or g) */
  unitCost?: number | null;
  currency?: string | null;
  note?: string | null;
}

const LOT_FIELDS: readonly (keyof LotPatch)[] = ['lotCode', 'supplier', 'supplierRef', 'unitCost', 'currency', 'note'];
const FIELD_LABEL: Readonly<Record<keyof LotPatch, string>> = { lotCode: 'lot code', supplier: 'supplier', supplierRef: 'supplier ref', unitCost: 'unit cost', currency: 'currency', note: 'note' };

/**
 * Correct a lot's details after receipt (a mistyped reel code, the invoice's price). Quantities
 * never change here. The change is a ledger line (`edit`, quantity 0) saying what was and what is,
 * so the ledger still tells the whole story; it needs the version the person loaded (`If-Match`).
 */
export async function editLot(tx: InvTx, id: string, patch: LotPatch, ifMatch: string | undefined): Promise<{ lot: Lot; movement?: Movement }> {
  const lot = await mustLot(tx, id);
  if (ifMatch === undefined) throw new InventoryError(428, `Changing lot '${lot.lotCode ?? lot.id}' needs the version you loaded (If-Match).`, 'Reload and try again.');
  checkVersion(ifMatch, lot, 'lot');
  if (patch.unitCost !== undefined && patch.unitCost !== null && !(patch.unitCost >= 0)) throw new InventoryError(422, 'A unit cost is zero or more.');
  const next: Lot = { ...lot };
  const changes: string[] = [];
  const show = (v: unknown): string => (v === undefined ? '—' : String(v));
  for (const key of LOT_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    const before = lot[key];
    if (value === null) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = key === 'unitCost' ? roundQty(value as number) : value;
    const after = next[key];
    if (before !== after) changes.push(key === 'note' ? 'note changed' : `${FIELD_LABEL[key]} ${show(before)} → ${show(after)}`);
  }
  if (changes.length === 0) return { lot };
  next.version = lot.version + 1;
  await tx.putLot(next);
  return { lot: next, movement: await record(tx, next, { kind: 'edit', qty: 0, note: changes.join('; ').slice(0, 2000) }) };
}

/* ------------------------------------------------------------------ *
 * Reservations
 * ------------------------------------------------------------------ */

/** The lots of an item in a dimension, locked, in a stable order (oldest first; lock order by id). */
async function lotsFor(tx: InvTx, item: ItemRef, dim: Dimension, prefer?: string): Promise<Lot[]> {
  const lots = (await tx.lots({ item }, true)).filter((l) => l.dim === dim && freeOf(l) > 0);
  return lots.sort((a, b) => (a.location === prefer ? 0 : 1) - (b.location === prefer ? 0 : 1) || a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
}

/**
 * Hold stock for a build. Counted and weighed items take the oldest free stock first. Length
 * allocates cut by cut, each cut from one lot (best fit: the smallest free part that holds it), so a
 * reservation never promises a cut that would span two reels. What cannot be held stays short on
 * the line (`needed` above what is allocated); `partial: false` refuses the whole reservation instead.
 */
export async function reserve(tx: InvTx, requirement: BuildRequirement, input: { rev?: number; label?: string; partial: boolean; prefer?: string }): Promise<Reservation> {
  const lines: ReservationLine[] = [];
  const short: string[] = [];
  for (const need of requirement.lines) {
    if (need.needed === undefined || need.needed <= 0) continue;
    const lots = await lotsFor(tx, need.item, need.dim, input.prefer);
    const free = new Map(lots.map((l) => [l.id, freeOf(l)]));
    const take = new Map<string, number>();
    const add = (lot: string, qty: number): void => {
      take.set(lot, roundQty((take.get(lot) ?? 0) + qty));
      free.set(lot, roundQty((free.get(lot) ?? 0) - qty));
    };
    let missing = 0;
    if (need.dim === 'length' && need.pieces !== undefined) {
      const factor = need.needed / need.pieces.reduce((s, mm) => s + mm + requirement.allowance.perCutMm, 0) / requirement.buildQty;
      const cuts = Array.from({ length: requirement.buildQty }, () => need.pieces!.map((mm) => roundQty((mm + requirement.allowance.perCutMm) * factor))).flat().sort((a, b) => b - a);
      for (const cut of cuts) {
        const fit = lots.filter((l) => (free.get(l.id) ?? 0) >= cut).sort((a, b) => (free.get(a.id) ?? 0) - (free.get(b.id) ?? 0))[0];
        if (fit === undefined) missing = roundQty(missing + cut);
        else add(fit.id, cut);
      }
    } else {
      let left = need.needed;
      for (const lot of lots) {
        if (left <= 0) break;
        const qty = Math.min(left, free.get(lot.id) ?? 0);
        if (qty > 0) {
          add(lot.id, qty);
          left = roundQty(left - qty);
        }
      }
      missing = left;
    }
    if (missing > 0) short.push(`${need.label}: ${missing} short`);
    const allocations: Allocation[] = [...take].map(([lot, qty]) => ({ lot, qty, consumed: 0, returned: 0 }));
    // counted parts are whole per unit; cut and weighed stock is its share of the whole, allowance included
    const perUnit = need.dim === 'count' ? need.perUnit : roundQty(need.needed / requirement.buildQty);
    lines.push({ item: need.item, dim: need.dim, label: need.label, needed: need.needed, perUnit, allocations });
  }
  if (short.length > 0 && !input.partial) throw new InventoryError(409, `Not enough stock to hold the whole build: ${short.join('; ')}.`, 'Reserve what there is (partial), or receive more first.');
  if (lines.every((l) => l.allocations.length === 0)) throw new InventoryError(409, 'Nothing in stock for this build yet.', 'Receive stock first; the shortage list shows what is needed.');
  for (const line of lines) {
    for (const a of line.allocations) {
      const lot = (await tx.lot(a.lot, true))!;
      await tx.putLot({ ...lot, reserved: roundQty(lot.reserved + a.qty), version: lot.version + 1 });
    }
  }
  const reservation: Reservation = {
    id: tx.newId('res'),
    design: requirement.design,
    ...(input.rev === undefined ? {} : { rev: input.rev }),
    buildQty: requirement.buildQty,
    ...(input.label === undefined ? {} : { label: input.label }),
    status: 'open',
    allowance: requirement.allowance,
    lines,
    createdAt: tx.now(),
    createdBy: tx.actor,
    version: 1,
  };
  await tx.putReservation(reservation);
  return reservation;
}

async function mustOpen(tx: InvTx, id: string, ifMatch: string | undefined): Promise<Reservation> {
  const found = await tx.reservation(id, true);
  if (found === undefined) throw new InventoryError(404, `There is no reservation '${id}'.`);
  checkVersion(ifMatch, found, 'reservation');
  if (found.status !== 'open') throw new InventoryError(409, 'This reservation is closed.');
  return found;
}

const heldOf = (a: Allocation): number => roundQty(a.qty - a.consumed);

function closeIfDone(r: Reservation, now: string): void {
  if (r.lines.every((l) => l.released === true || l.allocations.every((a) => heldOf(a) <= 0))) {
    r.status = 'closed';
    r.closedAt = now;
  }
}

interface PlanStep { line: ReservationLine; alloc: Allocation; qty: number }

/**
 * What `units` finished units take from what the reservation holds: each line's per-unit share.
 * With `beyond`, a share the holds no longer cover (a failed unit on top of the planned ones) is
 * asked of the last lot used, which gives what free stock it has (`applyPlan`'s `soft`).
 */
function unitsPlan(r: Reservation, units: number, beyond = false): PlanStep[] {
  const plan: PlanStep[] = [];
  for (const line of r.lines) {
    if (line.released === true) continue;
    let want = line.perUnit !== undefined ? roundQty(line.perUnit * units) : roundQty((line.needed * units) / r.buildQty);
    if (line.dim === 'count') want = Math.ceil(want - 1e-9);
    let last: PlanStep | undefined;
    for (const alloc of line.allocations) {
      const qty = Math.min(want, heldOf(alloc));
      if (qty > 0) {
        last = { line, alloc, qty: roundQty(qty) };
        plan.push(last);
        want = roundQty(want - qty);
      }
    }
    if (beyond && want > 0) {
      const alloc = line.allocations.at(-1);
      if (last !== undefined) last.qty = roundQty(last.qty + want);
      else if (alloc !== undefined) plan.push({ line, alloc, qty: want });
    }
  }
  return plan;
}

/** Take a plan's stock out, lots locked in id order (one order for every writer: fewer deadlocks). */
async function applyPlan(tx: InvTx, r: Reservation, plan: readonly PlanStep[], extra: { note?: string; batch?: string; soft?: boolean }): Promise<Movement[]> {
  for (const id of [...new Set(plan.map((p) => p.alloc.lot))].sort()) await mustLot(tx, id);
  const movements: Movement[] = [];
  for (const step of plan) {
    const lot = await mustLot(tx, step.alloc.lot);
    const fromHeld = Math.min(step.qty, heldOf(step.alloc));
    let over = roundQty(step.qty - fromHeld);
    // soft: a failed unit's extra share takes what free stock there is; the record is not refused for it
    if (extra.soft === true && over > freeOf(lot)) {
      over = Math.max(0, freeOf(lot));
      step.qty = roundQty(fromHeld + over);
      if (step.qty <= 0) continue;
    }
    if (over > freeOf(lot)) throw new InventoryError(409, `Lot '${lot.id}' has ${roundQty(fromHeld + freeOf(lot))} available for this build.`);
    step.alloc.consumed = roundQty(step.alloc.consumed + step.qty);
    if (step.alloc.consumed > step.alloc.qty) step.alloc.qty = step.alloc.consumed;
    const next: Lot = { ...lot, onHand: roundQty(lot.onHand - step.qty), reserved: roundQty(lot.reserved - fromHeld), version: lot.version + 1 };
    await tx.putLot(next);
    movements.push(await record(tx, next, { kind: 'consume', qty: -step.qty, reservation: r.id, ...(extra.batch === undefined ? {} : { batch: extra.batch }), ...(extra.note === undefined ? {} : { note: extra.note }) }));
  }
  return movements;
}

export interface ConsumeItem {
  lot: string;
  qty: number;
}

/**
 * Take stock out for the build: named lots and quantities, or `units` finished (each line's share
 * of what it holds, `units / buildQty`). Consuming more than a lot holds for the build takes the
 * rest from its free stock.
 */
export async function consume(tx: InvTx, id: string, input: { items?: ConsumeItem[]; units?: number; note?: string }, ifMatch: string | undefined): Promise<{ reservation: Reservation; movements: Movement[] }> {
  const r = await mustOpen(tx, id, ifMatch);
  const plan: PlanStep[] = [];
  if (input.units !== undefined) {
    if (!(input.units > 0) || input.units > r.buildQty) throw new InventoryError(422, `Units are between 1 and ${r.buildQty}.`);
    plan.push(...unitsPlan(r, input.units));
  } else {
    for (const item of input.items ?? []) {
      const line = r.lines.find((l) => l.allocations.some((a) => a.lot === item.lot));
      const alloc = line?.allocations.find((a) => a.lot === item.lot);
      if (line === undefined || alloc === undefined) throw new InventoryError(422, `Lot '${item.lot}' is not held by this reservation.`);
      if (!(item.qty > 0)) throw new InventoryError(422, 'Consume a quantity above zero.');
      plan.push({ line, alloc, qty: roundQty(item.qty) });
    }
  }
  if (plan.length === 0) throw new InventoryError(422, 'Nothing to consume.');
  const movements = await applyPlan(tx, r, plan, { ...(input.note === undefined ? {} : { note: input.note }) });
  r.version += 1;
  closeIfDone(r, tx.now());
  await tx.putReservation(r);
  return { reservation: r, movements };
}

/**
 * Put leftover back: a cut-off length onto its reel, unused parts into their lot. The target is
 * the lot it came from (default) or `into` another lot of the same item; the return is recorded
 * against the reservation even once it is closed.
 */
export async function giveBack(tx: InvTx, id: string, input: { lot: string; qty: number; into?: string; note?: string }): Promise<{ reservation: Reservation; movement: Movement }> {
  const r = await tx.reservation(id, true);
  if (r === undefined) throw new InventoryError(404, `There is no reservation '${id}'.`);
  const alloc = r.lines.flatMap((l) => l.allocations).find((a) => a.lot === input.lot);
  if (alloc === undefined) throw new InventoryError(422, `Lot '${input.lot}' was not used by this reservation.`);
  const qty = roundQty(input.qty);
  if (!(qty > 0)) throw new InventoryError(422, 'Return a quantity above zero.');
  if (qty > roundQty(alloc.consumed - alloc.returned)) throw new InventoryError(422, `Only ${roundQty(alloc.consumed - alloc.returned)} was taken from that lot for this build.`);
  const target = await mustLot(tx, input.into ?? input.lot);
  const source = input.into === undefined ? target : await mustLot(tx, input.lot);
  if (itemKey(target.item) !== itemKey(source.item) || target.dim !== source.dim) throw new InventoryError(422, 'Return into a lot of the same item.');
  alloc.returned = roundQty(alloc.returned + qty);
  const next: Lot = { ...target, onHand: roundQty(target.onHand + qty), version: target.version + 1 };
  await tx.putLot(next);
  const movement = await record(tx, next, { kind: 'return', qty, reservation: r.id, ...(input.note === undefined ? {} : { note: input.note }) });
  r.version += 1;
  await tx.putReservation(r);
  return { reservation: r, movement };
}

/** Stop holding stock: every line, or the lines of `items`. A reservation with nothing held closes. */
export async function release(tx: InvTx, id: string, input: { items?: ItemRef[] }, ifMatch: string | undefined): Promise<Reservation> {
  const r = await mustOpen(tx, id, ifMatch);
  const which = input.items === undefined ? undefined : new Set(input.items.map(itemKey));
  for (const line of r.lines) {
    if (which !== undefined && !which.has(itemKey(line.item))) continue;
    for (const alloc of line.allocations) {
      const held = heldOf(alloc);
      if (held <= 0) continue;
      const lot = await mustLot(tx, alloc.lot);
      await tx.putLot({ ...lot, reserved: roundQty(Math.max(0, lot.reserved - held)), version: lot.version + 1 });
      alloc.qty = alloc.consumed;
    }
    line.released = true;
  }
  r.version += 1;
  if (which === undefined || r.lines.every((l) => l.released === true)) {
    r.status = 'closed';
    r.closedAt = tx.now();
  } else closeIfDone(r, tx.now());
  await tx.putReservation(r);
  return r;
}

/* ------------------------------------------------------------------ *
 * Batches: made units
 * ------------------------------------------------------------------ */

export interface BatchInput {
  units: number;
  failed?: number;
  batchCode?: string;
  serials?: string[];
  measured?: Measured;
  /** keep the good units in stock: receive them into this location as a lot of the made item */
  into?: string;
  note?: string;
}

/** Serials are one per good unit at most, unique in the batch and among the item's earlier batches. */
async function checkBatch(tx: InvTx, item: ItemRef, input: BatchInput): Promise<{ units: number; failed: number; serials: string[] }> {
  const units = roundQty(input.units);
  const failed = roundQty(input.failed ?? 0);
  if (!(units >= 0) || !(failed >= 0) || !Number.isInteger(units) || !Number.isInteger(failed)) throw new InventoryError(422, 'Units and failed units are whole numbers, zero or more.');
  if (units + failed === 0) throw new InventoryError(422, 'Record at least one unit, good or failed.');
  const serials = (input.serials ?? []).map((s) => s.trim()).filter((s) => s !== '');
  if (serials.length > units) throw new InventoryError(422, `${serials.length} serials for ${units} good unit(s).`, 'One serial per good unit, or none.');
  const bad = serials.find((s) => !SERIAL.test(s));
  if (bad !== undefined) throw new InventoryError(422, `'${bad}' is not a serial: letters, digits and . _ / # : -, up to 64.`);
  const seen = new Set<string>();
  for (const s of serials) {
    if (seen.has(s)) throw new InventoryError(422, `Serial ${s} is listed twice.`);
    seen.add(s);
  }
  if (serials.length > 0) {
    const used = (await tx.batches({ item })).flatMap((b) => b.serials).filter((s) => seen.has(s));
    if (used.length > 0) throw new InventoryError(409, `Serial ${used.slice(0, 3).join(', ')} is already recorded for this item.`);
  }
  for (const [key, v] of Object.entries(input.measured ?? {})) {
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new InventoryError(422, `${key} is a number, zero or more.`);
  }
  return { units, failed, serials };
}

/** The good units into stock: a new counted lot of the made item, coded with the batch. */
async function receiveMade(tx: InvTx, item: ItemRef, units: number, location: string, batch: string, batchCode: string | undefined, serials: readonly string[]): Promise<Lot> {
  await mustLocation(tx, location);
  // the movement names the batch; the note keeps only what a person reads: the serials
  const note = serials.length === 0 ? {} : { note: serials.join(', ').slice(0, 2000) };
  const lot: Lot = { id: tx.newId('lot'), item, dim: 'count', location, ...(batchCode === undefined ? {} : { lotCode: batchCode }), ...note, receivedAt: tx.now(), onHand: units, reserved: 0, version: 1 };
  await tx.putLot(lot);
  await record(tx, lot, { kind: 'receive', qty: units, to: location, batch, ...note });
  return lot;
}

function measuredOf(m: Measured | undefined): Measured {
  return { ...(m?.durationS === undefined ? {} : { durationS: roundQty(m.durationS) }), ...(m?.unitMassG === undefined ? {} : { unitMassG: roundQty(m.unitMassG) }) };
}

/**
 * Finish units of a build: part of it (3 of 10 today) or the rest. Each good or failed unit takes
 * its share of what the reservation holds (as `consume` with `units`), the batch is recorded with
 * its serials and code, the reservation counts the good units, and with `into` they go on the
 * shelf as a lot of the design. When every unit is done, what is still held is let go and the
 * reservation closes.
 */
export async function completeUnits(tx: InvTx, id: string, input: BatchInput, ifMatch: string | undefined): Promise<{ reservation: Reservation; batch: Batch; movements: Movement[]; lot?: Lot }> {
  const r = await mustOpen(tx, id, ifMatch);
  const item: ItemRef = { kind: 'designs', id: r.design };
  const { units, failed, serials } = await checkBatch(tx, item, input);
  const done = r.unitsDone ?? 0;
  const left = roundQty(r.buildQty - done);
  if (units > left) throw new InventoryError(422, `This build has ${left} unit(s) left to finish (${done} of ${r.buildQty} done).`, 'Reserve another build for more.');
  const batchId = tx.newId('bat');
  const note = input.note;
  const movements = await applyPlan(tx, r, unitsPlan(r, units + failed, true), { batch: batchId, soft: true, ...(note === undefined ? {} : { note }) });
  const lot = input.into === undefined || units === 0 ? undefined : await receiveMade(tx, item, units, input.into, batchId, input.batchCode, serials);
  if (lot !== undefined) movements.push(...(await tx.movements({ lot: lot.id, limit: 1 })));
  const batch: Batch = {
    id: batchId,
    item,
    ...(r.rev === undefined ? {} : { rev: r.rev }),
    reservation: r.id,
    units,
    failed,
    ...(input.batchCode === undefined ? {} : { batchCode: input.batchCode }),
    serials,
    measured: measuredOf(input.measured),
    ...(lot === undefined ? {} : { outputLot: lot.id }),
    ...(note === undefined ? {} : { note }),
    at: tx.now(),
    by: tx.actor,
  };
  await tx.addBatch(batch);
  r.unitsDone = roundQty(done + units);
  r.version += 1;
  if (r.unitsDone >= r.buildQty) {
    // the build is finished: nothing more is needed, so nothing stays held
    for (const line of r.lines) {
      for (const alloc of line.allocations) {
        const held = heldOf(alloc);
        if (held <= 0) continue;
        const l = await mustLot(tx, alloc.lot);
        await tx.putLot({ ...l, reserved: roundQty(Math.max(0, l.reserved - held)), version: l.version + 1 });
        alloc.qty = alloc.consumed;
      }
    }
    r.status = 'closed';
    r.closedAt = tx.now();
  } else closeIfDone(r, tx.now());
  // a build whose held stock ran out early stays open until its units are recorded
  if (r.status === 'closed' && r.unitsDone < r.buildQty) {
    r.status = 'open';
    delete r.closedAt;
  }
  await tx.putReservation(r);
  return { reservation: r, batch, movements, ...(lot === undefined ? {} : { lot }) };
}

export interface ConsumeFromLot {
  lot: string;
  qty: number;
}

/**
 * A batch made without a reservation, such as a print: the stock it used is taken straight from
 * the named lots' free stock (filament by the gram), and the good units may go on the shelf.
 */
export async function recordBatch(tx: InvTx, input: BatchInput & { item: ItemRef; variant?: string; consume: ConsumeFromLot[] }): Promise<{ batch: Batch; movements: Movement[]; lot?: Lot }> {
  const { units, failed, serials } = await checkBatch(tx, input.item, input);
  const batchId = tx.newId('bat');
  const note = input.note === undefined ? {} : { note: input.note };
  const movements: Movement[] = [];
  for (const id of [...new Set(input.consume.map((c) => c.lot))].sort()) await mustLot(tx, id);
  for (const use of input.consume) {
    const qty = roundQty(use.qty);
    if (!(qty > 0)) throw new InventoryError(422, 'Consume a quantity above zero.');
    const lot = await mustLot(tx, use.lot);
    if (qty > freeOf(lot)) throw new InventoryError(409, `Lot '${lot.lotCode ?? lot.id}' has ${freeOf(lot)} ${BASE_UNIT[lot.dim]} free.`, lot.reserved > 0 ? 'The rest is held for a build.' : undefined);
    const next: Lot = { ...lot, onHand: roundQty(lot.onHand - qty), version: lot.version + 1 };
    await tx.putLot(next);
    movements.push(await record(tx, next, { kind: 'consume', qty: -qty, batch: batchId, ...note }));
  }
  const lot = input.into === undefined || units === 0 ? undefined : await receiveMade(tx, input.item, units, input.into, batchId, input.batchCode, serials);
  if (lot !== undefined) movements.push(...(await tx.movements({ lot: lot.id, limit: 1 })));
  const batch: Batch = {
    id: batchId,
    item: input.item,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    units,
    failed,
    ...(input.batchCode === undefined ? {} : { batchCode: input.batchCode }),
    serials,
    measured: measuredOf(input.measured),
    ...(lot === undefined ? {} : { outputLot: lot.id }),
    ...note,
    at: tx.now(),
    by: tx.actor,
  };
  await tx.addBatch(batch);
  return { batch, movements, ...(lot === undefined ? {} : { lot }) };
}
