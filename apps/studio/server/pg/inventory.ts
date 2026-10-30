/**
 * The inventory store on Postgres (migrations 0028, 0032; `server/inventory/store.ts`): every engine
 * transaction is one database transaction under the org's row-level security. Lots read for a
 * change are locked (`FOR UPDATE`, in id order), so two people consuming the same reel serialise
 * and the balance checks (and the table's own CHECKs) hold. The ledger and batches are
 * insert-only for the app.
 *
 * Two transactions can still lock lots of different items in opposite orders (two builds whose
 * BOMs list the same parts differently) and Postgres breaks that deadlock by failing one of them
 * (40P01). The engine's transactions are pure over the store, so the failed one is run again
 * from the start (twice at most); if it keeps losing, the API answers 409 "try again" — never a
 * 500, and never a half-written change. A committed write NOTIFYs `studio_inventory`, which
 * every process's events stream turns into an `inventory` server event (`events.ts`).
 */

import { sql } from 'kysely';

import { newInventoryId, type InvTx, type InventoryStore, type LotFilter, type MovementFilter } from '../inventory/store.ts';
import { InventoryError, type Allowance, type Batch, type Dimension, type ItemKind, type Location, type Lot, type Measured, type Movement, type MovementKind, type Reservation, type ReservationLine } from '../inventory/types.ts';
import { inOrg, type Db, type Tx } from './db.ts';

interface LocationRow { id: string; parent_id: string | null; name: string; note: string | null; version: number; created_at: Date }
interface LotRow {
  id: string; item_kind: ItemKind; item_id: string; dim: Dimension; location_id: string; lot_code: string | null; supplier: string | null; supplier_ref: string | null;
  unit_cost: string | null; currency: string | null; note: string | null; parent_lot: string | null; received_at: Date; on_hand: string; reserved: string; version: number;
}
interface MovementRow {
  seq: string; at: Date; actor: string; kind: MovementKind; lot_id: string; item_kind: ItemKind; item_id: string; qty: string; on_hand_after: string;
  from_location: string | null; to_location: string | null; reason: string | null; reservation_id: string | null; other_lot: string | null; batch_id: string | null; note: string | null;
}
interface ReservationRow {
  id: string; design_id: string; design_rev: number | null; build_qty: string; label: string | null; status: 'open' | 'closed'; allowance: Allowance; lines: ReservationLine[];
  created_at: Date; created_by: string; closed_at: Date | null; units_done: string; version: number;
}
interface BatchRow {
  id: string; item_kind: ItemKind; item_id: string; design_rev: number | null; reservation_id: string | null; variant: string | null; units: string; failed: string;
  batch_code: string | null; serials: string[]; measured: Measured; output_lot: string | null; note: string | null; at: Date; actor: string;
}

const opt = <K extends string, V>(key: K, value: V | null): { [k in K]?: V } => (value === null ? {} : ({ [key]: value } as { [k in K]?: V }));

const locationOf = (r: LocationRow): Location => ({ id: r.id, name: r.name, ...opt('parent', r.parent_id), ...opt('note', r.note), version: r.version, createdAt: r.created_at.toISOString() });
const lotOf = (r: LotRow): Lot => ({
  id: r.id,
  item: { kind: r.item_kind, id: r.item_id },
  dim: r.dim,
  location: r.location_id,
  ...opt('lotCode', r.lot_code),
  ...opt('supplier', r.supplier),
  ...opt('supplierRef', r.supplier_ref),
  ...opt('unitCost', r.unit_cost === null ? null : Number(r.unit_cost)),
  ...opt('currency', r.currency),
  ...opt('note', r.note),
  ...opt('parent', r.parent_lot),
  receivedAt: r.received_at.toISOString(),
  onHand: Number(r.on_hand),
  reserved: Number(r.reserved),
  version: r.version,
});
const movementOf = (r: MovementRow): Movement => ({
  seq: Number(r.seq),
  at: r.at.toISOString(),
  by: r.actor,
  kind: r.kind,
  lot: r.lot_id,
  item: { kind: r.item_kind, id: r.item_id },
  qty: Number(r.qty),
  onHandAfter: Number(r.on_hand_after),
  ...opt('from', r.from_location),
  ...opt('to', r.to_location),
  ...opt('reason', r.reason),
  ...opt('reservation', r.reservation_id),
  ...opt('otherLot', r.other_lot),
  ...opt('batch', r.batch_id),
  ...opt('note', r.note),
});
const batchOf = (r: BatchRow): Batch => ({
  id: r.id,
  item: { kind: r.item_kind, id: r.item_id },
  ...opt('rev', r.design_rev),
  ...opt('reservation', r.reservation_id),
  ...opt('variant', r.variant),
  units: Number(r.units),
  failed: Number(r.failed),
  ...opt('batchCode', r.batch_code),
  serials: r.serials,
  measured: r.measured,
  ...opt('outputLot', r.output_lot),
  ...opt('note', r.note),
  at: r.at.toISOString(),
  by: r.actor,
});
const reservationOf = (r: ReservationRow): Reservation => ({
  id: r.id,
  design: r.design_id,
  ...opt('rev', r.design_rev),
  buildQty: Number(r.build_qty),
  ...opt('label', r.label),
  status: r.status,
  allowance: r.allowance,
  lines: r.lines,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  ...opt('closedAt', r.closed_at === null ? null : r.closed_at.toISOString()),
  ...(Number(r.units_done) > 0 ? { unitsDone: Number(r.units_done) } : {}),
  version: r.version,
});

function pgTx(tx: Tx, orgId: string, actor: string): InvTx {
  const lockSql = (lock: boolean | undefined) => (lock === true ? sql` ORDER BY id FOR UPDATE` : sql` ORDER BY received_at, id`);
  const lotWhere = (filter: LotFilter) => {
    const parts = [sql`TRUE`];
    if (filter.item !== undefined) parts.push(sql`item_kind = ${filter.item.kind} AND item_id = ${filter.item.id}`);
    if (filter.location !== undefined) parts.push(sql`location_id = ${filter.location}`);
    if (filter.empty !== true) parts.push(sql`(on_hand > 0 OR reserved > 0)`);
    return sql.join(parts, sql` AND `);
  };
  return {
    actor,
    now: () => new Date().toISOString(),
    newId: (prefix) => newInventoryId(prefix),
    locations: async () => (await sql<LocationRow>`SELECT * FROM studio.inv_location ORDER BY name, id`.execute(tx)).rows.map(locationOf),
    location: async (id) => (await sql<LocationRow>`SELECT * FROM studio.inv_location WHERE id = ${id}`.execute(tx)).rows.map(locationOf)[0],
    lot: async (id, lock) => (await sql<LotRow>`SELECT * FROM studio.inv_lot WHERE id = ${id}${lock === true ? sql` FOR UPDATE` : sql``}`.execute(tx)).rows.map(lotOf)[0],
    lots: async (filter, lock) => (await sql<LotRow>`SELECT * FROM studio.inv_lot WHERE ${lotWhere(filter)}${lockSql(lock)}`.execute(tx)).rows.map(lotOf),
    reservation: async (id, lock) => (await sql<ReservationRow>`SELECT * FROM studio.inv_reservation WHERE id = ${id}${lock === true ? sql` FOR UPDATE` : sql``}`.execute(tx)).rows.map(reservationOf)[0],
    reservations: async (filter) => {
      const parts = [sql`TRUE`];
      if (filter.design !== undefined) parts.push(sql`design_id = ${filter.design}`);
      if (filter.status !== undefined) parts.push(sql`status = ${filter.status}`);
      return (await sql<ReservationRow>`SELECT * FROM studio.inv_reservation WHERE ${sql.join(parts, sql` AND `)} ORDER BY created_at DESC, id`.execute(tx)).rows.map(reservationOf);
    },
    movements: async (filter: MovementFilter) => {
      const parts = [sql`TRUE`];
      if (filter.lot !== undefined) parts.push(sql`(lot_id = ${filter.lot} OR other_lot = ${filter.lot})`);
      if (filter.item !== undefined) parts.push(sql`item_kind = ${filter.item.kind} AND item_id = ${filter.item.id}`);
      if (filter.reservation !== undefined) parts.push(sql`reservation_id = ${filter.reservation}`);
      if (filter.before !== undefined) parts.push(sql`seq < ${filter.before}`);
      const limit = filter.limit === undefined ? sql`` : sql` LIMIT ${filter.limit}`;
      return (await sql<MovementRow>`SELECT * FROM studio.inv_movement WHERE ${sql.join(parts, sql` AND `)} ORDER BY seq DESC${limit}`.execute(tx)).rows.map(movementOf);
    },
    batches: async (filter) => {
      const parts = [sql`TRUE`];
      if (filter.item !== undefined) parts.push(sql`item_kind = ${filter.item.kind} AND item_id = ${filter.item.id}`);
      if (filter.reservation !== undefined) parts.push(sql`reservation_id = ${filter.reservation}`);
      const limit = filter.limit === undefined ? sql`` : sql` LIMIT ${filter.limit}`;
      return (await sql<BatchRow>`SELECT * FROM studio.inv_batch WHERE ${sql.join(parts, sql` AND `)} ORDER BY at DESC, id DESC${limit}`.execute(tx)).rows.map(batchOf);
    },
    putLocation: async (l) => {
      await sql`INSERT INTO studio.inv_location (org_id, id, parent_id, name, note, version, created_at)
        VALUES (${orgId}::uuid, ${l.id}, ${l.parent ?? null}, ${l.name}, ${l.note ?? null}, ${l.version}, ${l.createdAt}::timestamptz)
        ON CONFLICT (org_id, id) DO UPDATE SET parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, note = EXCLUDED.note, version = EXCLUDED.version`.execute(tx);
    },
    deleteLocation: async (id) => {
      await sql`DELETE FROM studio.inv_location WHERE id = ${id}`.execute(tx);
    },
    putLot: async (l) => {
      await sql`INSERT INTO studio.inv_lot (org_id, id, item_kind, item_id, dim, location_id, lot_code, supplier, supplier_ref, unit_cost, currency, note, parent_lot, received_at, on_hand, reserved, version)
        VALUES (${orgId}::uuid, ${l.id}, ${l.item.kind}, ${l.item.id}, ${l.dim}, ${l.location}, ${l.lotCode ?? null}, ${l.supplier ?? null}, ${l.supplierRef ?? null}, ${l.unitCost ?? null}, ${l.currency ?? null}, ${l.note ?? null}, ${l.parent ?? null}, ${l.receivedAt}::timestamptz, ${l.onHand}, ${l.reserved}, ${l.version})
        ON CONFLICT (org_id, id) DO UPDATE SET location_id = EXCLUDED.location_id, lot_code = EXCLUDED.lot_code, supplier = EXCLUDED.supplier, supplier_ref = EXCLUDED.supplier_ref,
          unit_cost = EXCLUDED.unit_cost, currency = EXCLUDED.currency, note = EXCLUDED.note, on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved, version = EXCLUDED.version`.execute(tx);
    },
    putReservation: async (r) => {
      await sql`INSERT INTO studio.inv_reservation (org_id, id, design_id, design_rev, build_qty, label, status, allowance, lines, created_at, created_by, closed_at, units_done, version)
        VALUES (${orgId}::uuid, ${r.id}, ${r.design}, ${r.rev ?? null}, ${r.buildQty}, ${r.label ?? null}, ${r.status}, ${JSON.stringify(r.allowance)}::jsonb, ${JSON.stringify(r.lines)}::jsonb, ${r.createdAt}::timestamptz, ${r.createdBy}, ${r.closedAt ?? null}::timestamptz, ${r.unitsDone ?? 0}, ${r.version})
        ON CONFLICT (org_id, id) DO UPDATE SET status = EXCLUDED.status, lines = EXCLUDED.lines, label = EXCLUDED.label, closed_at = EXCLUDED.closed_at, units_done = EXCLUDED.units_done, version = EXCLUDED.version`.execute(tx);
    },
    append: async (m) => {
      const row = (await sql<MovementRow>`INSERT INTO studio.inv_movement (org_id, at, actor, kind, lot_id, item_kind, item_id, qty, on_hand_after, from_location, to_location, reason, reservation_id, other_lot, batch_id, note)
        VALUES (${orgId}::uuid, ${m.at}::timestamptz, ${m.by}, ${m.kind}, ${m.lot}, ${m.item.kind}, ${m.item.id}, ${m.qty}, ${m.onHandAfter}, ${m.from ?? null}, ${m.to ?? null}, ${m.reason ?? null}, ${m.reservation ?? null}, ${m.otherLot ?? null}, ${m.batch ?? null}, ${m.note ?? null})
        RETURNING *`.execute(tx)).rows[0]!;
      return movementOf(row);
    },
    addBatch: async (b) => {
      await sql`INSERT INTO studio.inv_batch (org_id, id, item_kind, item_id, design_rev, reservation_id, variant, units, failed, batch_code, serials, measured, output_lot, note, at, actor)
        VALUES (${orgId}::uuid, ${b.id}, ${b.item.kind}, ${b.item.id}, ${b.rev ?? null}, ${b.reservation ?? null}, ${b.variant ?? null}, ${b.units}, ${b.failed}, ${b.batchCode ?? null},
          ${b.serials}::text[], ${JSON.stringify(b.measured)}::jsonb, ${b.outputLot ?? null}, ${b.note ?? null}, ${b.at}::timestamptz, ${b.by})`.execute(tx);
    },
  };
}

/** Postgres gave up on a transaction because of another one: a deadlock or a serialization failure. */
export const isConcurrencyFailure = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '40P01' || code === '40001';
};

const RETRIES = 2;

export function pgInventoryStore(db: Db, orgId: string): InventoryStore {
  return {
    backend: 'pg',
    transact: async (actor, fn) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await inOrg(db, orgId, async (tx) => {
            const out = await fn(pgTx(tx, orgId, actor));
            // delivered at commit, never for a rolled-back write
            await sql`SELECT pg_notify('studio_inventory', ${JSON.stringify({ org: orgId })})`.execute(tx);
            return out;
          });
        } catch (error) {
          if (!isConcurrencyFailure(error)) throw error;
          if (attempt >= RETRIES) throw new InventoryError(409, 'Someone else changed the same stock at the same moment.', 'Nothing was written. Try again.');
        }
      }
    },
    read: (fn) => inOrg(db, orgId, (tx) => fn(pgTx(tx, orgId, '')), { snapshot: true }),
  };
}
