/** Dated supplier offers on Postgres (migration 0035, `sourcing/offers.ts`), under the org's row-level security. */

import { sql } from 'kysely';

import type { ItemKind } from '../inventory/types.ts';
import type { Offer, OfferStore } from '../sourcing/offers.ts';
import { inOrg, type Db } from './db.ts';

interface OfferRow {
  id: string; item_kind: ItemKind; item_id: string; supplier: string; supplier_ref: string | null; offered_on: Date | string; price: string | null;
  currency: string | null; unit: string; pack: string | null; note: string | null; created_at: Date; created_by: string;
}

const day = (v: Date | string): string => (typeof v === 'string' ? v.slice(0, 10) : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`);

const offerOf = (r: OfferRow): Offer => ({
  id: r.id,
  item: { kind: r.item_kind, id: r.item_id },
  supplier: r.supplier,
  ...(r.supplier_ref === null ? {} : { supplierRef: r.supplier_ref }),
  // `date` comes back as a local-midnight Date from node-postgres: read it back as the same day
  offeredOn: day(r.offered_on),
  ...(r.price === null ? {} : { price: Number(r.price) }),
  ...(r.currency === null ? {} : { currency: r.currency }),
  unit: r.unit,
  ...(r.pack === null ? {} : { pack: Number(r.pack) }),
  ...(r.note === null ? {} : { note: r.note }),
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
});

export function pgOfferStore(db: Db, orgId: string): OfferStore {
  return {
    list: (items) =>
      inOrg(db, orgId, async (tx) => {
        const where = items === undefined ? sql`TRUE` : items.length === 0 ? sql`FALSE` : sql.join(items.map((i) => sql`(item_kind = ${i.kind} AND item_id = ${i.id})`), sql` OR `);
        return (await sql<OfferRow>`SELECT * FROM studio.inv_offer WHERE ${where} ORDER BY offered_on DESC, created_at DESC, id`.execute(tx)).rows.map(offerOf);
      }, { snapshot: true }),
    add: (o) =>
      inOrg(db, orgId, async (tx) => {
        await sql`INSERT INTO studio.inv_offer (org_id, id, item_kind, item_id, supplier, supplier_ref, offered_on, price, currency, unit, pack, note, created_at, created_by)
          VALUES (${orgId}::uuid, ${o.id}, ${o.item.kind}, ${o.item.id}, ${o.supplier}, ${o.supplierRef ?? null}, ${o.offeredOn}::date, ${o.price ?? null}, ${o.currency ?? null}, ${o.unit}, ${o.pack ?? null}, ${o.note ?? null}, ${o.createdAt}::timestamptz, ${o.createdBy})`.execute(tx);
        await sql`SELECT pg_notify('studio_inventory', ${JSON.stringify({ org: orgId })})`.execute(tx);
      }),
    remove: (id) =>
      inOrg(db, orgId, async (tx) => {
        const gone = (await sql`DELETE FROM studio.inv_offer WHERE id = ${id}`.execute(tx)).numAffectedRows ?? 0n;
        if (gone > 0n) await sql`SELECT pg_notify('studio_inventory', ${JSON.stringify({ org: orgId })})`.execute(tx);
        return gone > 0n;
      }),
  };
}
