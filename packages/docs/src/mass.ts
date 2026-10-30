/**
 * The derived mass of a design (`docs/mass.md`): one figure per BOM line and a total for one unit,
 * from the static `mass` / `massPerLength` on library records (`@wirehub/model` `mass.ts`).
 *
 * It follows `deriveBom`'s lines exactly — the same supplied-terminated ends, integrated board
 * connectors (inside the board's mass), pass-through runs (cut with their trunk) and one cavity per
 * contact, seal and plug — so a mass can never disagree with the BOM it sits beside.
 *
 * - A line is `exact` when every input is known, `floor` (g = the known part) when something is
 *   missing but something is known, `unknown` (g null) otherwise.
 * - The total is `exact` when every line is, `floor` when any line has a figure, `unknown` when none
 *   does; an empty BOM weighs exactly 0. Every missing input is listed, never counted as zero.
 * - A sub-assembly line weighs the placed design's own total (at its pinned revision) × qty; with
 *   `explode` that line goes and the placed design's parts count instead, never both.
 *
 * Pure and deterministic; grams rounded to six decimals.
 */

import {
  effectivePieceMass,
  findComponent,
  findConnector,
  findMechanical,
  findPcba,
  findWire,
  flattenSubassemblies,
  hasSubassemblies,
  passThroughRuns,
  placedDesign,
  roundMass,
  subassembliesOf,
  wireMassPerMetre,
  type CableDesign,
  type Db,
  type MassBound,
  type MassMissing,
  type MassValue,
  type PieceKind,
} from '@wirehub/model';

import { deriveBom, type Bom, type BomCategory, type BomLine } from './bom.ts';

/** What a line's mass is read from: grams per metre of a stock, or grams per piece (a sub-assembly: its own total). */
export type MassRate = { gPerM: number; from: string } | { gEach: number; bound?: MassBound; from: string };

/** The mass of one BOM line (or one printed line: a length family's trunk per variation). */
export interface LineMass {
  /** per-piece cut length of a wire line, when known */
  lengthMm?: number;
  rate: MassRate | null;
  g: number | null;
  bound: MassBound;
  missing?: MassMissing[];
}

export interface MassLine extends LineMass {
  /** `BomLine.key` */
  key: string;
  category: BomCategory;
  ref: string;
  label: string;
  partNumber?: string;
  qty: number;
  instances: string[];
}

export interface DesignMass {
  explode: boolean;
  total: MassValue;
  lines: MassLine[];
  /** every line's missing inputs (each with `line`), then any sub-assembly an exploded BOM could not open */
  missing: MassMissing[];
}

export interface MassOptions {
  /** `deriveBom`'s result for the same design, db and `explode`, when the caller has it */
  bom?: Bom;
  /** weigh the placed designs' parts instead of one line per sub-assembly */
  explode?: boolean;
  /** internal: the designs being weighed above this one, a cycle guard */
  assemblyStack?: readonly string[];
}

const PIECE_KIND: Readonly<Record<Exclude<BomCategory, 'wire' | 'subassembly'>, PieceKind>> = {
  connector: 'connectors',
  pcba: 'pcbas',
  component: 'components',
  termination: 'mechanicals',
  shell: 'mechanicals',
  hardware: 'mechanicals',
  assembly: 'mechanicals',
};

const sortedUnique = (ids: readonly string[]): string[] => [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function missing(reason: MassMissing['reason'], record: string, instances: readonly string[], detail?: string): MassMissing {
  return { reason, record, instances: sortedUnique(instances), ...(detail === undefined ? {} : { detail }) };
}

function bounded(g: number | null, gaps: readonly MassMissing[]): MassBound {
  if (g === null) return 'unknown';
  return gaps.length === 0 ? 'exact' : 'floor';
}

const designRef = (def: string, rev: number | undefined): string => `designs/${def}${rev === undefined ? '' : `@${rev}`}`;

const linesWithout = (n: number): string => `${n} line${n === 1 ? '' : 's'} without a mass inside it`;

/** How many lines (or unopened sub-assemblies) of a derived mass lack something. */
export function massGapCount(mass: DesignMass): number {
  return new Set(mass.missing.map((m) => m.line ?? m.record)).size;
}

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

interface Context {
  design: CableDesign;
  db: Db;
  stack: readonly string[];
}

function wireLine(ctx: Context, line: BomLine): LineMass {
  const gaps: MassMissing[] = [];
  const record = `wires/${line.ref}`;
  const lengthMm = line.length?.mm;
  const withLength = lengthMm === undefined ? {} : { lengthMm };
  if (findWire(ctx.db, line.ref) === undefined) {
    return { ...withLength, rate: null, g: null, bound: 'unknown', missing: [missing('no-definition', record, line.provenance)] };
  }
  const rate = wireMassPerMetre(ctx.db, line.ref);
  if (rate === undefined) gaps.push(missing('no-mass', record, line.provenance));

  // the length that is known: the whole cut, or per trunk its own length plus the longest known run
  let knownMm: number | null = null;
  if (line.totalMm !== undefined) knownMm = line.totalMm;
  else {
    const segments = new Map(ctx.design.instances.segments.map((s) => [s.id, s]));
    const runs = passThroughRuns(ctx.design, ctx.db);
    const runIds = new Set(runs.map((r) => r.segment));
    const unlengthed: string[] = [];
    for (const id of line.provenance) {
      const segment = segments.get(id);
      if (segment === undefined || runIds.has(id)) continue;
      const own = runs.filter((r) => r.trunk === id);
      unlengthed.push(...own.filter((r) => r.lengthMm === undefined).map((r) => r.segment));
      if (segment.lengthMm === undefined) {
        unlengthed.push(id);
        continue;
      }
      const longest = Math.max(0, ...own.map((r) => r.lengthMm ?? 0));
      knownMm = (knownMm ?? 0) + segment.lengthMm + longest;
    }
    gaps.push(missing('no-length', record, unlengthed.length === 0 ? line.provenance : unlengthed));
  }
  const g = rate === undefined || knownMm === null ? null : roundMass((rate.gPerM * knownMm) / 1000);
  return {
    ...withLength,
    rate: rate === undefined ? null : { gPerM: rate.gPerM, from: rate.from },
    g,
    bound: bounded(g, gaps),
    ...(gaps.length === 0 ? {} : { missing: gaps }),
  };
}

function exists(db: Db, kind: PieceKind, id: string): boolean {
  switch (kind) {
    case 'connectors':
      return findConnector(db, id) !== undefined;
    case 'components':
      return findComponent(db, id) !== undefined;
    case 'pcbas':
      return findPcba(db, id) !== undefined;
    case 'mechanicals':
      return findMechanical(db, id) !== undefined;
    default:
      return (db.bodies ?? []).some((b) => b.id === id);
  }
}

function pieceLine(ctx: Context, line: BomLine, kind: PieceKind): LineMass {
  const record = `${kind}/${line.ref}`;
  if (!exists(ctx.db, kind, line.ref)) return { rate: null, g: null, bound: 'unknown', missing: [missing('no-definition', record, line.provenance)] };
  const each = effectivePieceMass(ctx.db, kind, line.ref);
  if (each === undefined) return { rate: null, g: null, bound: 'unknown', missing: [missing('no-mass', record, line.provenance)] };
  return { rate: { gEach: each.g, from: each.from }, g: roundMass(each.g * line.qty), bound: 'exact' };
}

function subassemblyLine(ctx: Context, line: BomLine): LineMass {
  const sub = line.subassembly!;
  const record = designRef(sub.design, sub.rev);
  const unknown = (detail: string): LineMass => ({ rate: null, g: null, bound: 'unknown', missing: [missing('subassembly', record, line.provenance, detail)] });
  const opened = placedDesign(ctx.db, { id: line.provenance[0] ?? line.ref, def: sub.design, ...(sub.rev === undefined ? {} : { rev: sub.rev }) });
  if (opened === undefined) return unknown('the placed design was not loaded');
  if (!opened.ok) return unknown(opened.issue.message);
  if (ctx.stack.includes(opened.placed.design.id)) return unknown('it places a design that places it');
  const own = deriveMass(opened.placed.design, opened.placed.db, { assemblyStack: [...ctx.stack, opened.placed.design.id] });
  const gaps = own.total.bound === 'exact' ? [] : [missing('subassembly', record, line.provenance, linesWithout(massGapCount(own)))];
  if (own.total.g === null) return { rate: null, g: null, bound: 'unknown', missing: gaps };
  const g = roundMass(own.total.g * line.qty);
  return { rate: { gEach: own.total.g, bound: own.total.bound, from: record }, g, bound: own.total.bound, ...(gaps.length === 0 ? {} : { missing: gaps }) };
}

function lineMass(ctx: Context, line: BomLine): LineMass {
  if (line.category === 'wire') return wireLine(ctx, line);
  if (line.category === 'subassembly') return subassemblyLine(ctx, line);
  return pieceLine(ctx, line, PIECE_KIND[line.category]);
}

/**
 * A wire line printed at another length (a length family's trunk, per variation): the stock's
 * rate over that length.
 */
export function wireMassAt(mass: LineMass, mm: number): LineMass {
  if (mass.rate === null || !('gPerM' in mass.rate)) return { ...mass, lengthMm: mm };
  const gaps = (mass.missing ?? []).filter((m) => m.reason !== 'no-length');
  const g = roundMass((mass.rate.gPerM * mm) / 1000);
  return { lengthMm: mm, rate: mass.rate, g, bound: bounded(g, gaps), ...(gaps.length === 0 ? {} : { missing: gaps }) };
}

/* ------------------------------------------------------------------ *
 * The design
 * ------------------------------------------------------------------ */

/** Sub-assemblies an exploded BOM could not open (their parts are not in it), at any depth. */
function unopened(design: CableDesign, db: Db, prefix: string, stack: readonly string[]): MassMissing[] {
  const out: MassMissing[] = [];
  for (const sub of subassembliesOf(design)) {
    const record = designRef(sub.def, sub.rev);
    const at = `${prefix}${sub.id}`;
    const opened = placedDesign(db, sub);
    if (opened === undefined) out.push(missing('subassembly', record, [at], 'the placed design was not loaded'));
    else if (!opened.ok) out.push(missing('subassembly', record, [at], opened.issue.message));
    else if (stack.includes(opened.placed.design.id)) out.push(missing('subassembly', record, [at], 'it places a design that places it'));
    else out.push(...unopened(opened.placed.design, opened.placed.db, `${at}/`, [...stack, opened.placed.design.id]));
  }
  return out;
}

/** The mass of each of `design`'s BOM lines and of one unit. */
export function deriveMass(design: CableDesign, db: Db, options: MassOptions = {}): DesignMass {
  const stack = options.assemblyStack ?? [design.id];
  const flatten = options.explode === true && hasSubassemblies(design) && db.assemblies !== undefined;
  const flat = flatten ? flattenSubassemblies(design, db) : undefined;
  const ctx: Context = { design: flat?.design ?? design, db: flat?.db ?? db, stack };
  const bom = options.bom ?? deriveBom(ctx.design, ctx.db);
  const lines: MassLine[] = bom.lines.map((line) => {
    const mass = lineMass(ctx, line);
    return {
      key: line.key,
      category: line.category,
      ref: line.ref,
      label: line.label,
      ...(line.partNumber === undefined ? {} : { partNumber: line.partNumber }),
      qty: line.qty,
      instances: [...line.provenance],
      ...mass,
    };
  });
  const extra = flatten ? unopened(design, db, '', stack) : [];
  const all: MassMissing[] = [
    ...lines.flatMap((line) => (line.missing ?? []).map((m) => ({ reason: m.reason, record: m.record, instances: m.instances, line: line.key, ...(m.detail === undefined ? {} : { detail: m.detail }) }))),
    ...extra,
  ];
  const known = lines.filter((line) => line.g !== null);
  const sum = known.reduce((total, line) => roundMass(total + (line.g ?? 0)), 0);
  const total: MassValue =
    lines.length === 0 && extra.length === 0
      ? { g: 0, bound: 'exact' }
      : lines.every((line) => line.bound === 'exact') && extra.length === 0
        ? { g: sum, bound: 'exact' }
        : known.length > 0
          ? { g: sum, bound: 'floor' }
          : { g: null, bound: 'unknown' };
  return { explode: options.explode === true, total, lines, missing: all };
}

/** Whether a derived mass says anything: some line has a known rate (a sub-assembly: a non-null mass). */
export function hasMassData(mass: DesignMass): boolean {
  return mass.lines.some((line) => line.rate !== null);
}
