/**
 * `/api/inventory/offers` (dated supplier offers, `offers.ts`) and the optional sourcing view a
 * build answers with (`rollup.ts`). Mounted by the inventory router, so the same gate, events and
 * "no inventory → 501" apply.
 *
 *   GET    /api/inventory/offers?item=<kind>:<id>   newest first (all offers without `item`)
 *   POST   /api/inventory/offers                    { item, supplier, offeredOn?, price?, currency?, unit?, pack?, supplierRef?, note? }
 *   DELETE /api/inventory/offers/:id
 */

import type { Db } from '@wirehub/model';

import type { ApiResponse } from '../api.ts';
import type { ShortageLine } from '../inventory/requirements.ts';
import { ITEM_KINDS, InventoryError, itemKey, type Allowance, type ItemKind, type Lot } from '../inventory/types.ts';
import { OFFER_ID, offerInput, type Offer, type OfferStore } from './offers.ts';
import { sourcingOf, type SourcingSummary } from './rollup.ts';

export const OFFER_ROUTES = ['GET    /api/inventory/offers', 'POST   /api/inventory/offers', 'DELETE /api/inventory/offers/:id'] as const;

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });

export async function handleOffers(method: string, id: string | undefined, query: URLSearchParams, body: unknown, offers: OfferStore | undefined, actor: string, now: string): Promise<ApiResponse> {
  if (offers === undefined) return fail(501, 'This hub keeps no supplier offers.');
  if (id === undefined) {
    if (method === 'GET') {
      const raw = query.get('item');
      if (raw === null) return { status: 200, body: { offers: await offers.list() } };
      const [kind, ...rest] = raw.split(':');
      if (!(ITEM_KINDS as readonly unknown[]).includes(kind) || rest.length === 0) return fail(400, 'item is <kind>:<id>.');
      return { status: 200, body: { offers: await offers.list([{ kind: kind as ItemKind, id: rest.join(':') }]) } };
    }
    if (method === 'POST') {
      const offer = offerInput(body, actor, now);
      await offers.add(offer);
      return { status: 201, body: { offer } };
    }
    return fail(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
  }
  if (method !== 'DELETE') return fail(405, `${method} is not something this address accepts.`, 'It answers DELETE.');
  if (!OFFER_ID.test(id)) return fail(400, `'${id}' is not an offer id.`);
  if (!(await offers.remove(id))) throw new InventoryError(404, `There is no offer '${id}'.`);
  return { status: 200, body: { deleted: id } };
}

/** The build view's optional sourcing: cost and waste for its shortage lines. Never fails a build: a broken offer store just leaves it out. */
export async function buildSourcing(lines: readonly ShortageLine[], build: { buildQty: number; allowance: Allowance }, lotsByItem: ReadonlyMap<string, Lot[]>, offers: OfferStore | undefined, db: Db, today: string): Promise<SourcingSummary | undefined> {
  let list: Offer[] = [];
  try {
    if (offers !== undefined) list = await offers.list(lines.map((l) => l.item));
  } catch {
    list = [];
  }
  const byItem = new Map<string, Offer[]>();
  for (const o of list) byItem.set(itemKey(o.item), [...(byItem.get(itemKey(o.item)) ?? []), o]);
  return sourcingOf(lines, build, lotsByItem, byItem, db, today);
}
