/**
 * The optional side of a build's shortage list (`requirements.ts` `shortage`): what the build would
 * cost and, for cut stock, where the length goes. Pure: shortage lines, lots, offers and the
 * library in, numbers out. Nothing here is required — a hub with no prices gets no cost at all, and
 * a part without a price is counted as unpriced, never as free.
 *
 * Cost, per line:
 * - what comes **from stock** is priced from the lots it would come out of, oldest received first
 *   (FIFO over on-hand lots), at each lot's own `unitCost`; a lot without a cost leaves that part
 *   unpriced;
 * - what must be **bought** is priced from the cheapest current dated offer (the newest per
 *   supplier on or before today) in whole packs when the offer names a pack, else from the record's
 *   catalog `cost` (with its price breaks);
 * - a line whose need is open (a run with no length) is priced on its lower bound and says so.
 * Currencies are never converted: a total is kept per currency.
 *
 * Waste, per cut-stock (length) line whose cuts are known: the per-cut allowance and the scrap
 * percentage, the cuts placed on the free reels (best fit, longest cut first — a cut never spans
 * two reels), the offcuts left shorter than any cut of this build (drops), and what must be bought,
 * in packs when a current offer names a pack size.
 */

import type { ConvertedTotal } from './fx.ts';
import { findComponent, findConnector, findMechanical, findPcba, findWire, unitPriceAt, type Db, type PartCost } from '@wirehub/model';

import type { ShortageLine } from '../inventory/requirements.ts';
import { freeOf, roundQty, type Allowance, type Lot } from '../inventory/types.ts';
import { basePack, basePrice, currentOffers, type Offer } from './offers.ts';

export interface CostPart {
  from: 'stock' | 'offer' | 'catalog';
  /** base unit */
  qty: number;
  amount?: number;
  currency?: string;
  supplier?: string;
  offeredOn?: string;
  /** whole packs bought, and what one holds (base unit) */
  packs?: number;
  pack?: number;
}

export interface LineCost {
  parts: CostPart[];
  /** the line's whole cost, when every part is priced in one currency */
  amount?: number;
  currency?: string;
  /** priced on the open need's lower bound */
  atLeast?: boolean;
  /** why there is no `amount` */
  reason?: string;
}

export interface Waste {
  /** the cut lengths themselves, every unit */
  cut: number;
  /** the per-cut allowance (strip, trim, service) */
  allowance: number;
  /** the scrap percentage */
  scrap: number;
  /** cut from free reels */
  fromStock: number;
  /** offcuts left on the reels used, shorter than any cut of this build */
  drop: number;
  /** cuts no free reel holds: to buy */
  buy: number;
  /** whole packs to buy (when a current offer names a pack) and their size */
  packs?: number;
  pack?: number;
  /** what the new packs leave over, kept as stock */
  leftover?: number;
  /** a cut longer than one pack: the pack count cannot hold it */
  tooLong?: number;
}

export interface SourcingLine {
  key: string;
  cost?: LineCost;
  waste?: Waste;
}

export interface SourcingSummary {
  lines: SourcingLine[];
  /** the build's cost, per currency (`''` = no currency named) */
  totals: Record<string, number>;
  /** lines that need something and have no whole price */
  unpriced: number;
  /** some line was priced on a lower bound */
  atLeast: boolean;
  /** offers on file for the build's items (current or not), so the client can say "none yet" quietly */
  offers: number;
  /** the totals in one currency, from the design's saved fx-rates snapshot (absent without one) */
  converted?: ConvertedTotal;
}

const r2 = (n: number): number => Math.round(n * 1e4) / 1e4 + 0;

function catalogCost(db: Db, line: ShortageLine): { cost: PartCost; isWire: boolean } | undefined {
  const { kind, id } = line.item;
  const found = kind === 'wires' ? findWire(db, id) : kind === 'connectors' ? findConnector(db, id) : kind === 'components' ? findComponent(db, id) : kind === 'pcbas' ? findPcba(db, id) : kind === 'mechanicals' ? findMechanical(db, id) : undefined;
  const cost = (found as { cost?: PartCost } | undefined)?.cost;
  return cost === undefined ? undefined : { cost, isWire: kind === 'wires' };
}

/** FIFO over on-hand lots: the price of taking `qty` out of stock. */
function stockPart(qty: number, lots: readonly Lot[], fallbackCurrency: string | undefined): CostPart {
  let left = qty;
  let amount = 0;
  let currency: string | undefined;
  let priced = true;
  for (const lot of [...lots].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))) {
    if (left <= 0) break;
    const take = Math.min(left, lot.onHand);
    if (take <= 0) continue;
    left = roundQty(left - take);
    const cur = lot.currency ?? fallbackCurrency;
    if (lot.unitCost === undefined || (currency !== undefined && cur !== currency)) {
      priced = false;
      continue;
    }
    currency = cur;
    amount += take * lot.unitCost;
  }
  // more than the lots hold (held or used elsewhere): the rest has no lot to price it
  if (left > 0) priced = false;
  return { from: 'stock', qty, ...(priced ? { amount: r2(amount), ...(currency === undefined ? {} : { currency }) } : {}) };
}

/** The cheapest current offer (or the catalog price) for buying `qty`; `packsOf` overrides the pack count (cuts cannot span packs). */
function buyPart(qty: number, line: ShortageLine, offers: readonly Offer[], db: Db, today: string, packsOf?: (pack: number) => number | undefined): CostPart {
  let best: CostPart | undefined;
  for (const o of currentOffers(offers, line.dim, today)) {
    const price = basePrice(o);
    if (price === undefined) continue;
    const pack = basePack(o);
    const packs = pack === undefined ? undefined : (packsOf?.(pack) ?? Math.ceil(roundQty(qty / pack)));
    const bought = pack === undefined || packs === undefined ? qty : packs * pack;
    const part: CostPart = { from: 'offer', qty, amount: r2(bought * price), supplier: o.supplier, offeredOn: o.offeredOn, ...(o.currency === undefined ? {} : { currency: o.currency }), ...(packs === undefined || pack === undefined ? {} : { packs, pack }) };
    if (best === undefined || (best.currency === part.currency && part.amount! < best.amount!)) best = part;
  }
  if (best !== undefined) return best;
  const cat = catalogCost(db, line);
  if (cat !== undefined) {
    const per = cat.cost.per ?? (cat.isWire ? 'm' : 'each');
    // a length bought by the metre, anything else by the piece; a mass or volume has no catalog price
    if ((per === 'm' && line.dim === 'length') || (per === 'each' && line.dim === 'count')) {
      const units = per === 'm' ? qty / 1000 : qty;
      const currency = cat.cost.currency ?? db.rules?.costing?.currency;
      return { from: 'catalog', qty, amount: r2(units * unitPriceAt(cat.cost, units)), ...(currency === undefined ? {} : { currency }) };
    }
  }
  return { from: 'offer', qty };
}

/** Best-fit, longest first: where the cuts go on the reels' free parts; what is left unplaced. */
function placeCuts(cuts: readonly number[], capacities: readonly number[]): { placed: number; unplaced: number[]; remains: number[]; touched: boolean[] } {
  const remains = [...capacities];
  const touched = remains.map(() => false);
  const unplaced: number[] = [];
  let placed = 0;
  for (const cut of [...cuts].sort((a, b) => b - a)) {
    let at = -1;
    for (let i = 0; i < remains.length; i++) if (remains[i]! >= cut && (at === -1 || remains[i]! < remains[at]!)) at = i;
    if (at === -1) unplaced.push(cut);
    else {
      remains[at] = roundQty(remains[at]! - cut);
      touched[at] = true;
      placed += cut;
    }
  }
  return { placed: roundQty(placed), unplaced, remains, touched };
}

function wasteOf(line: ShortageLine, allowance: Allowance, buildQty: number, lots: readonly Lot[], packOf: number | undefined): Waste | undefined {
  if (line.dim !== 'length' || line.needed === undefined || line.pieces === undefined || line.pieces.length === 0) return undefined;
  const raw = line.pieces.reduce((s, mm) => s + mm + allowance.perCutMm, 0);
  // the scrap percentage stretches each cut, as the reservation does (`engine.ts` reserve)
  const factor = raw > 0 ? line.needed / (raw * buildQty) : 1;
  const cuts = Array.from({ length: buildQty }, () => line.pieces!.map((mm) => roundQty((mm + allowance.perCutMm) * factor))).flat();
  const cut = roundQty(line.pieces.reduce((s, mm) => s + mm, 0) * buildQty);
  const allowanceTotal = roundQty(allowance.perCutMm * line.pieces.length * buildQty);
  const scrap = Math.max(0, roundQty(line.needed - cut - allowanceTotal));
  const shortest = Math.min(...cuts);
  // what this design already holds or took is its own; only a fresh build is placed on free reels
  const fresh = line.reservedHere === 0 && line.consumedHere === 0;
  const reels = fresh ? lots.filter((l) => l.dim === 'length' && freeOf(l) > 0) : [];
  const fit = placeCuts(cuts, reels.map(freeOf));
  const drop = roundQty(fit.remains.reduce((s, left, i) => s + (fit.touched[i] === true && left > 0 && left < shortest ? left : 0), 0));
  const out: Waste = { cut, allowance: allowanceTotal, scrap, fromStock: fit.placed, drop, buy: roundQty(fit.unplaced.reduce((s, c) => s + c, 0)) };
  if (!fresh) {
    // held stock is cut when units are finished: only the shortfall is bought, loose
    out.fromStock = roundQty(line.needed - (line.short ?? 0));
    out.buy = line.short ?? 0;
  }
  if (packOf !== undefined && out.buy > 0) {
    const tooLong = fit.unplaced.filter((c) => c > packOf);
    if (tooLong.length > 0) out.tooLong = Math.max(...tooLong);
    else if (fresh) {
      // the unplaced cuts into new packs, best fit as on the shelf
      const packs: number[] = [];
      for (const c of [...fit.unplaced].sort((a, b) => b - a)) {
        let at = -1;
        for (let i = 0; i < packs.length; i++) if (packs[i]! >= c && (at === -1 || packs[i]! < packs[at]!)) at = i;
        if (at === -1) packs.push(roundQty(packOf - c));
        else packs[at] = roundQty(packs[at]! - c);
      }
      out.packs = packs.length;
      out.pack = packOf;
      out.leftover = roundQty(packs.reduce((s, l) => s + l, 0));
    } else {
      out.packs = Math.ceil(roundQty(out.buy / packOf));
      out.pack = packOf;
      out.leftover = roundQty(out.packs * packOf - out.buy);
    }
  }
  return out;
}

export function sourcingOf(
  lines: readonly ShortageLine[],
  build: { buildQty: number; allowance: Allowance },
  lotsByItem: ReadonlyMap<string, readonly Lot[]>,
  offersByItem: ReadonlyMap<string, readonly Offer[]>,
  db: Db,
  today: string,
): SourcingSummary {
  const fallback = db.rules?.costing?.currency;
  const totals: Record<string, number> = {};
  let unpriced = 0;
  let atLeast = false;
  let anyPrice = false;
  let offerCount = 0;
  const out: SourcingLine[] = [];
  for (const line of lines) {
    const key = `${line.item.kind}:${line.item.id}`;
    const lots = (lotsByItem.get(key) ?? []).filter((l) => l.dim === line.dim);
    const offers = offersByItem.get(key) ?? [];
    offerCount += offers.length;
    // the pack a cut-stock purchase would come in: the cheapest current offer that names one
    const packed = currentOffers(offers, line.dim, today).filter((o) => basePack(o) !== undefined).sort((a, b) => (basePrice(a) ?? Infinity) - (basePrice(b) ?? Infinity))[0];
    const waste = wasteOf(line, build.allowance, build.buildQty, lots, packed === undefined ? undefined : basePack(packed));
    const want = line.needed ?? line.neededAtLeast;
    const entry: SourcingLine = { key, ...(waste === undefined ? {} : { waste }) };
    if (want !== undefined && want > 0) {
      const short = line.short ?? line.shortAtLeast ?? 0;
      const buy = waste?.buy ?? short;
      const fromStock = Math.max(0, roundQty(want - buy));
      const parts: CostPart[] = [];
      if (fromStock > 0) parts.push(stockPart(fromStock, lots, fallback));
      if (buy > 0) parts.push(buyPart(buy, line, offers, db, today, waste?.packs === undefined ? undefined : (pack) => (pack === waste.pack ? waste.packs : undefined)));
      const cost: LineCost = { parts, ...(line.needed === undefined ? { atLeast: true } : {}) };
      const currencies = new Set(parts.map((p) => p.currency ?? ''));
      if (parts.some((p) => p.amount !== undefined)) anyPrice = true;
      if (parts.some((p) => p.amount === undefined)) cost.reason = parts.find((p) => p.amount === undefined)!.from === 'stock' ? 'a lot has no cost' : 'no price to buy';
      else if (currencies.size > 1) cost.reason = `mixed currencies (${[...currencies].filter((c) => c !== '').join(', ')})`;
      else {
        cost.amount = r2(parts.reduce((s, p) => s + p.amount!, 0));
        const currency = [...currencies][0]!;
        if (currency !== '') cost.currency = currency;
        totals[currency] = r2((totals[currency] ?? 0) + cost.amount);
        if (cost.atLeast === true) atLeast = true;
      }
      if (cost.amount === undefined) unpriced += 1;
      entry.cost = cost;
    }
    out.push(entry);
  }
  // no price anywhere: no cost at all, rather than a column of "unpriced"
  if (!anyPrice) for (const l of out) delete l.cost;
  return { lines: out, totals, unpriced: anyPrice ? unpriced : 0, atLeast, offers: offerCount };
}
