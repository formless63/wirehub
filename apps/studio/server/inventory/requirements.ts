/**
 * What building `qty` of a design takes from stock, from its BOM (`deriveBom`): one line per
 * library item, wire as cut pieces (length + the per-cut allowance) and everything else counted.
 * A board is one item: a bought assembled board is not its components. A placed sub-assembly is
 * one item (a design kept in stock) unless the build explodes it into its parts.
 *
 * The allowance is the shop's to set, per build: extra length per cut, and a scrap percentage on
 * cut or weighed stock (never on counted parts). Both default to none.
 *
 * A wire line without a length is **unknown**, not zero: the line says so and its need stays open.
 * The make/buy hint is the record's own route; without one, a design is made and a part bought,
 * and the hint says it was assumed.
 */

import { deriveBom } from '@wirehub/docs';
import type { CableDesign, Db, PartRoute } from '@wirehub/model';

import { defaultDimension, freeOf, itemKey, roundQty, type Allowance, type Dimension, type ItemKind, type ItemRef, type Lot, type Reservation } from './types.ts';

export interface RouteHint {
  route: PartRoute;
  /** no route on the record: the default for its kind */
  assumed: boolean;
  maker?: string;
  supplier?: string;
}

export interface NeedLine {
  item: ItemRef;
  dim: Dimension;
  label: string;
  partNumber?: string;
  category: string;
  /** per finished unit, base unit, without allowance */
  perUnit: number;
  /** wire: the cut pieces of one unit, mm each (without allowance) */
  pieces?: number[];
  /** the whole build, allowance included; absent when a length is unknown */
  needed?: number;
  /** why `needed` is open */
  unknown?: string;
  /** `needed` is open: the runs with no length (`location: instances`), each one a reason */
  missing?: string[];
  /** `needed` is open: what the runs that do have a length take, allowance included (a lower bound) */
  neededAtLeast?: number;
  route: RouteHint;
  /** the BOM lines folded into this one */
  bomKeys: string[];
}

export interface BuildRequirement {
  design: string;
  label: string;
  buildQty: number;
  allowance: Allowance;
  lines: NeedLine[];
  /** what the BOM could not identify (its `gaps`) */
  gaps: string[];
}

const KIND_BY_CATEGORY: Readonly<Record<string, ItemKind>> = {
  wire: 'wires',
  pcba: 'pcbas',
  connector: 'connectors',
  component: 'components',
  subassembly: 'designs',
};

type Sourced = { route?: PartRoute; maker?: string; suppliers?: readonly { supplier: string }[] };

function recordOf(db: Db, kind: ItemKind, id: string): Sourced | undefined {
  switch (kind) {
    case 'wires':
      return db.wires.find((r) => r.id === id);
    case 'pcbas':
      return db.pcbas.find((r) => r.id === id);
    case 'connectors':
      return db.connectors.find((r) => r.id === id);
    case 'components':
      return db.components.find((r) => r.id === id);
    case 'mechanicals':
      return db.mechanicals?.find((r) => r.id === id);
    case 'designs':
      return db.assemblies?.working.find((d) => d.id === id);
  }
}

/** The library kind a BOM line's ref lives in. */
function kindOf(db: Db, category: string, ref: string): ItemKind {
  const direct = KIND_BY_CATEGORY[category];
  if (direct !== undefined) return direct;
  // terminations, shells, hardware and supplied ends are mechanicals unless the catalog says otherwise
  if (db.mechanicals?.some((m) => m.id === ref) === true) return 'mechanicals';
  if (db.components.some((c) => c.id === ref)) return 'components';
  if (db.connectors.some((c) => c.id === ref)) return 'connectors';
  return 'mechanicals';
}

export function routeHint(db: Db, item: ItemRef): RouteHint {
  const record = recordOf(db, item.kind, item.id);
  const supplier = record?.suppliers?.[0]?.supplier;
  const extra = { ...(record?.maker === undefined ? {} : { maker: record.maker }), ...(supplier === undefined ? {} : { supplier }) };
  if (record?.route !== undefined) return { route: record.route, assumed: false, ...extra };
  // a design is built here; so is a shell whose enclosure the hub generates (it is printed, not bought)
  const made = item.kind === 'designs' || (item.kind === 'mechanicals' && (record as { enclosure?: unknown } | undefined)?.enclosure !== undefined);
  return { route: made ? 'make' : 'buy', assumed: true, ...extra };
}

export function deriveRequirement(design: CableDesign, db: Db, buildQty: number, allowance: Allowance, options: { explode?: boolean } = {}): BuildRequirement {
  const bom = deriveBom(design, db, options.explode === true ? { explode: true } : {});
  const byItem = new Map<string, NeedLine>();
  const growth = 1 + allowance.pct / 100;
  for (const line of bom.lines) {
    const kind = kindOf(db, line.category, line.ref);
    const item: ItemRef = { kind, id: line.ref };
    const key = itemKey(item);
    let need = byItem.get(key);
    if (need === undefined) {
      need = {
        item,
        dim: line.category === 'wire' ? 'length' : defaultDimension(kind) === 'length' ? 'length' : 'count',
        label: line.label,
        ...(line.partNumber === undefined ? {} : { partNumber: line.partNumber }),
        category: line.category,
        perUnit: 0,
        route: routeHint(db, item),
        bomKeys: [],
      };
      byItem.set(key, need);
    }
    need.bomKeys.push(line.key);
    if (need.dim === 'length') {
      const mm = line.length?.mm;
      if (mm === undefined || mm <= 0) {
        const why = `${line.location}: no length on ${line.provenance.join(', ')}`;
        need.missing = [...(need.missing ?? []), why];
        need.unknown = need.missing.length === 1 ? why : `${need.missing.length} runs have no length`;
        continue;
      }
      need.pieces = [...(need.pieces ?? []), ...Array.from({ length: line.qty }, () => mm)];
      need.perUnit = roundQty(need.perUnit + mm * line.qty);
    } else {
      need.perUnit = roundQty(need.perUnit + line.qty);
    }
  }
  const lines = [...byItem.values()].map((need): NeedLine => {
    const perUnit = need.dim === 'length' ? (need.pieces ?? []).reduce((sum, mm) => sum + mm + allowance.perCutMm, 0) : need.perUnit;
    // the scrap percentage is for stock that is cut or weighed out; counted parts are counted
    const needed = need.dim === 'count' ? Math.ceil(roundQty(perUnit * buildQty)) : roundQty(perUnit * buildQty * growth);
    // an open length still has a floor: what the runs with a length take
    if (need.unknown !== undefined) return needed > 0 ? { ...need, neededAtLeast: needed } : need;
    return { ...need, needed };
  });
  lines.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
  return { design: design.id, label: design.label, buildQty, allowance, lines, gaps: bom.gaps };
}

/* ------------------------------------------------------------------ *
 * Shortage
 * ------------------------------------------------------------------ */

export interface ShortageLine extends NeedLine {
  onHand: number;
  /** held by every open reservation */
  reserved: number;
  /** held by this design's open reservations */
  reservedHere: number;
  /** already taken out for this design's open reservations */
  consumedHere: number;
  /** on hand and not held */
  free: number;
  /** what is still missing once this design's reservations and the free stock count; absent when the need is unknown */
  short?: number;
  /** the need is open: what is missing at least, from `neededAtLeast` */
  shortAtLeast?: number;
  /** `short` is an upper bound: lots counted another way (`otherDim`) may cover part of it */
  shortAtMost?: boolean;
  /** length: the longest single cut no lot can supply from its free part (a cut cannot span two reels) */
  noFit?: number;
  /** lots of the item in another dimension (counted reels for a length need): never added in */
  otherDim?: number;
}

/**
 * Needed against on hand, held and free. What this design's open builds already hold or took counts
 * for it; free stock counts next. A length need also checks that each cut fits in one lot's free part.
 */
export function shortage(requirement: BuildRequirement, lotsByItem: ReadonlyMap<string, Lot[]>, open: readonly Reservation[]): ShortageLine[] {
  const heldHere = new Map<string, number>();
  const usedHere = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string, by: number): void => void map.set(key, roundQty((map.get(key) ?? 0) + by));
  for (const r of open) {
    if (r.design !== requirement.design || r.status !== 'open') continue;
    for (const line of r.lines) {
      // what the open build already took counts toward it; a returned cut-off does not undo the cut
      bump(usedHere, itemKey(line.item), line.allocations.reduce((sum, a) => sum + a.consumed, 0));
      if (line.released !== true) bump(heldHere, itemKey(line.item), line.allocations.reduce((sum, a) => sum + (a.qty - a.consumed), 0));
    }
  }
  return requirement.lines.map((need) => {
    const all = lotsByItem.get(itemKey(need.item)) ?? [];
    const lots = all.filter((l) => l.dim === need.dim);
    const onHand = roundQty(lots.reduce((s, l) => s + l.onHand, 0));
    const reserved = roundQty(lots.reduce((s, l) => s + l.reserved, 0));
    const free = roundQty(onHand - reserved);
    const reservedHere = heldHere.get(itemKey(need.item)) ?? 0;
    const consumedHere = usedHere.get(itemKey(need.item)) ?? 0;
    const out: ShortageLine = { ...need, onHand, reserved, reservedHere, consumedHere, free };
    const otherDim = all.length - lots.length;
    if (otherDim > 0) out.otherDim = otherDim;
    if (need.needed !== undefined) out.short = Math.max(0, roundQty(need.needed - reservedHere - consumedHere - free));
    else if (need.neededAtLeast !== undefined) out.shortAtLeast = Math.max(0, roundQty(need.neededAtLeast - reservedHere - consumedHere - free));
    if (otherDim > 0 && (out.short ?? 0) > 0) out.shortAtMost = true;
    if (need.dim === 'length' && need.pieces !== undefined && reservedHere === 0 && consumedHere === 0) {
      const cut = Math.max(...need.pieces) + requirement.allowance.perCutMm;
      const best = Math.max(0, ...lots.map(freeOf));
      if (lots.length > 0 && best < cut && free >= cut) out.noFit = cut;
    }
    return out;
  });
}
