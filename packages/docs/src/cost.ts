/**
 * The BOM cost roll-up (cs-5k1.17): unit and extended cost per line and a
 * total, from the optional `cost` on library records and the design's labour.
 *
 * Rules the numbers follow:
 *
 * - **Nothing without prices.** A design none of whose parts is priced (and
 *   that records no labour) has no summary at all; a part without a price is
 *   listed as unpriced, never counted as free.
 * - **Currency is explicit.** A price is read in its own currency, else the
 *   organisation's (`Db.rules.costing.currency`). The summary is in the
 *   organisation's currency, or in the one currency every price shares; a line
 *   in another currency is listed beside it and left out of the total (there
 *   are no exchange rates here).
 * - **Quantity breaks follow the build quantity.** The unit price is the
 *   break that applies to what the whole build buys (line quantity x
 *   `buildQty`), the extended cost is for one cable.
 * - **Labour** is the design's `labourMinutes` at the organisation's rate; the
 *   model has no per-operation times yet, so it is one figure per design.
 *
 * Pure: the lines of `deriveBomSheet` and the definitions in, numbers out.
 */

import {
  costUnit,
  findComponent,
  findConnector,
  findMechanical,
  findPcba,
  findWire,
  unitPriceAt,
  type CableDesign,
  type Db,
  type PartCost,
} from '@wirehub/model';

import type { BomCategory } from './bom.ts';
import type { BomSheetLine } from './bom-sheet.ts';

export interface CostLine {
  /** the BOM sheet line's `sourceKey` */
  sourceKey: string;
  ref: string;
  label: string;
  variationPn?: string;
  /** what is bought for one cable: pieces, or metres of wire */
  quantity: number;
  unit: 'each' | 'm';
  /** the price per unit that applies at the build quantity */
  unitPrice: number;
  /** the break that set it (`minQty`), absent = the base price */
  tier?: number;
  /** `quantity` x `unitPrice`, for one cable */
  extended: number;
  currency?: string;
}

export interface CostSummary {
  /** the currency every figure below is in; absent = no currency was set anywhere */
  currency?: string;
  /** cables in the build; the quantity breaks were read at line quantity x this */
  buildQty: number;
  lines: CostLine[];
  /** priced lines in another currency, left out of the total */
  foreign: CostLine[];
  /** lines whose part has no price */
  unpriced: { sourceKey: string; ref: string; label: string }[];
  /** the sum of the priced lines, for one cable */
  materials: number;
  labour?: { minutes: number; ratePerHour?: number; cost?: number };
  /** materials plus labour, for one cable */
  total: number;
  /** `total` x `buildQty` */
  buildTotal: number;
  /** why the total is not the whole story, in words */
  notes: string[];
}

export interface CostOptions {
  /** cables in the build (default 1) */
  buildQty?: number;
}

const MM_PER_M = 1000;
const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
};

function costOf(db: Db, category: BomCategory, ref: string): { cost: PartCost | undefined; isWire: boolean } {
  switch (category) {
    case 'wire':
      return { cost: findWire(db, ref)?.cost, isWire: true };
    case 'connector':
      return { cost: findConnector(db, ref)?.cost, isWire: false };
    case 'component':
      return { cost: findComponent(db, ref)?.cost, isWire: false };
    case 'pcba':
      return { cost: findPcba(db, ref)?.cost, isWire: false };
    default:
      return { cost: findMechanical(db, ref)?.cost, isWire: false };
  }
}

/** The cost summary of a printed BOM, or `undefined` when nothing in it is priced and no labour is recorded. */
export function deriveCost(design: CableDesign, db: Db, lines: readonly BomSheetLine[], options: CostOptions = {}): CostSummary | undefined {
  const buildQty = options.buildQty !== undefined && Number.isFinite(options.buildQty) && options.buildQty >= 1 ? Math.floor(options.buildQty) : 1;
  const org = db.rules?.costing;
  const orgCurrency = org?.currency;
  const priced: CostLine[] = [];
  const unpriced: CostSummary['unpriced'] = [];
  const segmentIds = new Set(design.instances.segments.map((s) => s.id));
  for (const line of lines) {
    const { cost, isWire } = costOf(db, line.category, line.ref);
    if (cost === undefined) {
      unpriced.push({ sourceKey: line.sourceKey, ref: line.ref, label: line.label });
      continue;
    }
    const unit = costUnit(cost, isWire);
    let quantity: number;
    if (isWire && unit === 'm') {
      const mm = line.wire?.mm;
      if (mm === undefined) {
        unpriced.push({ sourceKey: line.sourceKey, ref: line.ref, label: `${line.label} (no length recorded)` });
        continue;
      }
      quantity = round(mm / MM_PER_M, 6);
    } else if (isWire) {
      quantity = Math.max(1, line.instances.filter((id) => segmentIds.has(id)).length);
    } else {
      quantity = Number(line.quantity);
    }
    const bought = quantity * buildQty;
    const unitPrice = unitPriceAt(cost, bought);
    const tier = unitPrice === cost.unit && !(cost.breaks ?? []).some((b) => b.unit === unitPrice && b.minQty <= bought) ? undefined : Math.max(...(cost.breaks ?? []).filter((b) => b.minQty <= bought).map((b) => b.minQty));
    const currency = cost.currency ?? orgCurrency;
    priced.push({
      sourceKey: line.sourceKey,
      ref: line.ref,
      label: line.label,
      ...(line.variationPn === undefined ? {} : { variationPn: line.variationPn }),
      quantity,
      unit,
      unitPrice,
      ...(tier === undefined ? {} : { tier }),
      extended: round(quantity * unitPrice),
      ...(currency === undefined ? {} : { currency }),
    });
  }

  const minutes = design.labourMinutes;
  if (priced.length === 0 && minutes === undefined) return undefined;

  const explicit = new Set(priced.map((l) => l.currency));
  const currency = orgCurrency ?? (explicit.size === 1 ? [...explicit][0] : undefined);
  const counted = priced.filter((l) => l.currency === currency);
  const foreign = priced.filter((l) => l.currency !== currency);
  const materials = round(counted.reduce((sum, l) => sum + l.extended, 0));
  const rate = org?.labourRatePerHour;
  const labour = minutes === undefined ? undefined : { minutes, ...(rate === undefined ? {} : { ratePerHour: rate, cost: round((minutes / 60) * rate) }) };
  const total = round(materials + (labour?.cost ?? 0));

  const notes: string[] = [];
  if (currency === undefined) notes.push('No currency is set: add one in the engineering settings, or on the prices.');
  if (foreign.length > 0) notes.push(`${foreign.length} priced line${foreign.length === 1 ? ' is' : 's are'} in another currency and not in the total (no exchange rates).`);
  if (unpriced.length > 0) notes.push(`${unpriced.length} line${unpriced.length === 1 ? ' has' : 's have'} no price, so the total is a floor.`);
  if (labour !== undefined && labour.cost === undefined) notes.push('Labour time is recorded but no labour rate is set, so it is not in the total.');
  return {
    ...(currency === undefined ? {} : { currency }),
    buildQty,
    lines: counted,
    foreign,
    unpriced,
    materials,
    ...(labour === undefined ? {} : { labour }),
    total,
    buildTotal: round(total * buildQty),
    notes,
  };
}

/** A price as text: two decimals, more when the figure needs them (a 0.0035 resistor), with its currency. */
export function formatMoney(amount: number, currency?: string): string {
  const fixed = Math.abs(amount) >= 1 || amount === 0 ? amount.toFixed(2) : String(round(amount, 4));
  return currency === undefined ? fixed : `${fixed} ${currency}`;
}

/** The cost line of one printed BOM line (a family's trunk has one per variation), counted or foreign. */
export function costLineOf(cost: CostSummary | undefined, line: Pick<BomSheetLine, 'sourceKey' | 'variationPn'>): CostLine | undefined {
  return [...(cost?.lines ?? []), ...(cost?.foreign ?? [])].find((c) => c.sourceKey === line.sourceKey && c.variationPn === line.variationPn);
}
