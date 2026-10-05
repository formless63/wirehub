/**
 * Part cost (cs-5k1.17): an optional price on a library record.
 *
 * `cost` is an additive field of every catalog record (`RecordMeta`): a record
 * without it is unpriced, and nothing prints for it. A price is a unit price
 * with an explicit currency (an ISO 4217 code, defaulting to the organisation's
 * in the engineering settings) and optional **quantity breaks**: from `minQty`
 * pieces (metres, for a wire stock) the unit price is the break's.
 *
 * Pure: numbers in, numbers out. No exchange rates, no clock, no network; a
 * module may supply live pricing by writing these fields.
 */

import type { Issue } from './model.ts';

export interface PriceBreak {
  /** from this quantity (inclusive) the break's unit price applies; positive */
  minQty: number;
  /** price per unit at this quantity; not negative */
  unit: number;
}

export interface PartCost {
  /** price per unit at the base quantity; not negative */
  unit: number;
  /** ISO 4217 code (`USD`); absent = the organisation's currency */
  currency?: string;
  /** what `unit` is per: a piece (`each`, the default) or a metre (wire stocks default to `m`) */
  per?: 'each' | 'm';
  /** price breaks, any order; the base `unit` applies below the smallest `minQty` */
  breaks?: PriceBreak[];
  /** the supplier's minimum order quantity, for the buyer's information */
  moq?: number;
  /** where the price came from (a quote, a catalog page, a date) */
  src?: string;
}

/** The organisation's costing settings (`Db.rules.costing`, from the hub's engineering settings). */
export interface CostingRules {
  /** ISO 4217 code every unpriced-currency record is read in, and the currency totals are printed in */
  currency?: string;
  /** labour rate per hour, in `currency`; absent = labour time is shown but not priced */
  labourRatePerHour?: number;
}

const CURRENCY = /^[A-Z]{3}$/;

export const isCurrencyCode = (value: unknown): value is string => typeof value === 'string' && CURRENCY.test(value);

/** Problems with the organisation's costing settings, one sentence each (empty = fine). */
export function costingRulesProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['costing must be an object { currency?, labourRatePerHour? }.'];
  const v = value as Record<string, unknown>;
  const out: string[] = [];
  if (v['currency'] !== undefined && !isCurrencyCode(v['currency'])) out.push('currency must be a three-letter ISO 4217 code such as USD.');
  const rate = v['labourRatePerHour'];
  if (rate !== undefined && !(typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)) out.push('labourRatePerHour must be a number, zero or more.');
  for (const key of Object.keys(v)) if (key !== 'currency' && key !== 'labourRatePerHour') out.push(`costing has no setting called ${key}.`);
  return out;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The problems with a record's `cost` (absent is fine; present has to be well formed). */
export function costIssues(record: object, where: string): Issue[] {
  const cost = (record as { cost?: unknown }).cost;
  if (cost === undefined) return [];
  const issues: Issue[] = [];
  const bad = (message: string): void => {
    issues.push({ code: 'record-cost', severity: 'error', message: `record '${where}': cost ${message}`, where });
  };
  if (typeof cost !== 'object' || cost === null || Array.isArray(cost)) {
    bad('must be an object { unit, currency?, breaks? }');
    return issues;
  }
  const c = cost as Record<string, unknown>;
  if (!finite(c['unit']) || c['unit'] < 0) bad('unit must be a number, zero or more');
  if (c['currency'] !== undefined && !isCurrencyCode(c['currency'])) bad('currency must be a three-letter ISO 4217 code such as USD');
  if (c['per'] !== undefined && c['per'] !== 'each' && c['per'] !== 'm') bad("per must be 'each' or 'm'");
  if (c['moq'] !== undefined && !(finite(c['moq']) && c['moq'] > 0)) bad('moq must be a positive number');
  if (c['src'] !== undefined && typeof c['src'] !== 'string') bad('src must be text');
  const breaks = c['breaks'];
  if (breaks !== undefined) {
    if (!Array.isArray(breaks)) bad('breaks must be a list of { minQty, unit }');
    else {
      const seen = new Set<number>();
      breaks.forEach((b: unknown, i) => {
        const at = `breaks[${i}]`;
        if (typeof b !== 'object' || b === null) return bad(`${at} must be { minQty, unit }`);
        const { minQty, unit } = b as Record<string, unknown>;
        if (!finite(minQty) || minQty <= 0) bad(`${at}.minQty must be a positive number`);
        if (!finite(unit) || unit < 0) bad(`${at}.unit must be a number, zero or more`);
        if (finite(minQty)) {
          if (seen.has(minQty)) bad(`${at}.minQty ${minQty} is listed twice`);
          seen.add(minQty);
        }
      });
    }
  }
  return issues;
}

/** The unit of a record's price: wire stocks are priced per metre unless they say otherwise. */
export function costUnit(cost: PartCost, isWire: boolean): 'each' | 'm' {
  return cost.per ?? (isWire ? 'm' : 'each');
}

/** The unit price that applies when buying `qty` (the last break at or below it, else the base price). */
export function unitPriceAt(cost: PartCost, qty: number): number {
  let price = cost.unit;
  let from = 0;
  for (const b of cost.breaks ?? []) {
    if (b.minQty <= qty && b.minQty > from) {
      price = b.unit;
      from = b.minQty;
    }
  }
  return price;
}
