/**
 * Dated supplier offers (`docs/inventory.md` § Offers): what a supplier asked for an item on a
 * given day, kept beside the inventory and never part of the catalog. Every field but the item,
 * the supplier, the day and the unit is optional — an offer without a price still says who sells
 * it and in what pack. Offers are never a gate: a build, a reservation or a shortage never needs
 * one; they only feed the optional cost roll-up and the pack count of a procurement projection.
 *
 * An offer is written once; a newer price is a newer offer (the older one stays as history and the
 * roll-up reads the newest one on or before today). Stores: memory, a file beside the inventory
 * (`offers.json`), Postgres (`pg/offers.ts`, migration 0035).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.ts';
import { newInventoryId } from '../inventory/store.ts';
import { ITEM_KINDS, InventoryError, UNITS, itemKey, type Dimension, type ItemKind, type ItemRef } from '../inventory/types.ts';

export interface Offer {
  id: string;
  item: ItemRef;
  supplier: string;
  /** the supplier's own number for the item */
  supplierRef?: string;
  /** the day the price was quoted or read, `YYYY-MM-DD` */
  offeredOn: string;
  /** price per `unit`; absent = not known */
  price?: number;
  /** ISO 4217 code; absent = not known */
  currency?: string;
  /** what `price` and `pack` are in: `ea`, `m`, `ft`, `kg`, `ml` … (a key of `UNITS`) */
  unit: string;
  /** what one order unit holds (a 100 m reel, a bag of 50), in `unit`; absent = sold loose */
  pack?: number;
  note?: string;
  createdAt: string;
  createdBy: string;
}

export const OFFER_ID = /^off-[0-9a-f]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const RECORD_ID = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

export const offerDim = (offer: Pick<Offer, 'unit'>): Dimension | undefined => UNITS[offer.unit]?.dim;

/** The price per base unit (ea, mm, g, ml), or undefined when the offer names none. */
export function basePrice(offer: Offer): number | undefined {
  const u = UNITS[offer.unit];
  return offer.price === undefined || u === undefined ? undefined : offer.price / u.factor;
}

/** One pack in the base unit, or undefined when sold loose. */
export function basePack(offer: Offer): number | undefined {
  const u = UNITS[offer.unit];
  return offer.pack === undefined || u === undefined ? undefined : offer.pack * u.factor;
}

/** The offers that count today for one dimension: on or before `today`, newest per supplier first. */
export function currentOffers(offers: readonly Offer[], dim: Dimension, today: string): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  for (const o of [...offers].sort((a, b) => b.offeredOn.localeCompare(a.offeredOn) || b.createdAt.localeCompare(a.createdAt))) {
    if (offerDim(o) !== dim || o.offeredOn > today) continue;
    const key = o.supplier.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

type Body = Record<string, unknown>;

function str(body: Body, key: string, max: number): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new InventoryError(400, `${key} is text, up to ${max} characters.`);
  return v.trim();
}

function num(body: Body, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e12) throw new InventoryError(400, `${key} is a number, zero or more.`);
  return n;
}

/** A new offer from a request body, checked; `today` fills a missing date. */
export function offerInput(value: unknown, actor: string, now: string): Offer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InventoryError(400, 'Send a JSON object.');
  const body = value as Body;
  const item = body['item'] as Body | undefined;
  if (item === undefined || typeof item !== 'object' || !(ITEM_KINDS as readonly unknown[]).includes(item['kind'])) throw new InventoryError(400, `item.kind is one of ${ITEM_KINDS.join(', ')}.`);
  if (typeof item['id'] !== 'string' || !RECORD_ID.test(item['id'])) throw new InventoryError(400, 'item.id is a record id.');
  const supplier = str(body, 'supplier', 120);
  if (supplier === undefined) throw new InventoryError(400, 'supplier is required.');
  const offeredOn = str(body, 'offeredOn', 10) ?? now.slice(0, 10);
  if (!DATE.test(offeredOn) || Number.isNaN(Date.parse(`${offeredOn}T00:00:00Z`))) throw new InventoryError(400, 'offeredOn is a date, YYYY-MM-DD.');
  const unit = str(body, 'unit', 8) ?? 'ea';
  if (UNITS[unit] === undefined) throw new InventoryError(400, `'${unit}' is not a unit (${Object.keys(UNITS).join(', ')}).`);
  const currency = str(body, 'currency', 3)?.toUpperCase();
  if (currency !== undefined && !CURRENCY.test(currency)) throw new InventoryError(400, 'currency is a three-letter code (USD, EUR).');
  const price = num(body, 'price');
  const pack = num(body, 'pack');
  if (pack !== undefined && pack <= 0) throw new InventoryError(400, 'pack is more than zero.');
  const supplierRef = str(body, 'supplierRef', 120);
  const note = str(body, 'note', 2000);
  return {
    id: newInventoryId('off'),
    item: { kind: item['kind'] as ItemKind, id: item['id'] },
    supplier,
    ...(supplierRef === undefined ? {} : { supplierRef }),
    offeredOn,
    ...(price === undefined ? {} : { price }),
    ...(currency === undefined ? {} : { currency }),
    unit,
    ...(pack === undefined ? {} : { pack }),
    ...(note === undefined ? {} : { note }),
    createdAt: now,
    createdBy: actor,
  };
}

/* ------------------------------------------------------------------ *
 * Stores
 * ------------------------------------------------------------------ */

export interface OfferStore {
  /** newest offered first; `items` narrows to those items */
  list(items?: readonly ItemRef[]): Promise<Offer[]>;
  add(offer: Offer): Promise<void>;
  /** false when there was no such offer */
  remove(id: string): Promise<boolean>;
}

const order = (a: Offer, b: Offer): number => b.offeredOn.localeCompare(a.offeredOn) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

function over(load: () => Offer[], save: (all: Offer[]) => void): OfferStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => T): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    list: async (items) => {
      const keys = items === undefined ? undefined : new Set(items.map(itemKey));
      return load().filter((o) => keys === undefined || keys.has(itemKey(o.item))).sort(order);
    },
    add: (offer) => serial(() => save([...load(), structuredClone(offer)])),
    remove: (id) => serial(() => {
      const all = load();
      const left = all.filter((o) => o.id !== id);
      if (left.length !== all.length) save(left);
      return left.length !== all.length;
    }),
  };
}

export function memoryOfferStore(): OfferStore {
  let all: Offer[] = [];
  return over(() => structuredClone(all), (next) => void (all = next));
}

/** `offers.json` in the inventory's directory: beside the catalog, never part of it. */
export function fileOfferStore(dir: string): OfferStore {
  const path = join(dir, 'offers.json');
  return over(
    () => (existsSync(path) ? ((JSON.parse(readFileSync(path, 'utf8')) as { offers?: Offer[] }).offers ?? []) : []),
    (all) => {
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(path, `${JSON.stringify({ offers: all }, null, 1)}\n`);
    },
  );
}
