/**
 * Static mass on library records (`docs/mass.md`).
 *
 * A piece part (connector, connector body, component, board, mechanical) may
 * carry `mass: { g, src? }`, a wire stock `massPerLength: { gPerM, src? }`.
 * Grams (and grams per metre) are the only stored unit: an editor converts what
 * was typed on commit and keeps no input unit. Absent is unknown, an explicit 0
 * is a value. A design's mass is derived from these (`@wirehub/docs` `deriveMass`).
 *
 * Pure: records in, numbers and issues out.
 */

import type { Db, Issue } from './model.ts';

/** A piece part's mass: grams, and where the figure came from. */
export interface RecordMass {
  g: number;
  src?: string;
}

/** A wire stock's mass per length: grams per metre, and where the figure came from. */
export interface RecordMassPerLength {
  gPerM: number;
  src?: string;
}

/** How a derived mass is bounded: `floor` = at least `g` (something is missing), `unknown` = `g` is null. */
export type MassBound = 'exact' | 'floor' | 'unknown';

export interface MassValue {
  g: number | null;
  bound: MassBound;
}

/** One input a derived mass is missing; every one is listed, never counted as zero. */
export interface MassMissing {
  reason: 'no-mass' | 'no-length' | 'no-definition' | 'subassembly';
  /** `pcbas/x`, `wires/x`, `designs/x@2` (`designs/x` = the working copy) */
  record: string;
  /** instances, cavities (`j2:1`) or runs (`w3`) */
  instances: string[];
  /** the BOM line's key (design-level lists) */
  line?: string;
  detail?: string;
}

/** Input units for a mass: the same factors as inventory's. */
export const MASS_UNIT_GRAMS = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } as const;
export type MassUnit = keyof typeof MASS_UNIT_GRAMS;

/** Input lengths a per-length mass may be per, in metres. */
export const PER_LENGTH_METRES = { m: 1, km: 1000, ft: 0.3048, kft: 304.8 } as const;
export type PerLengthUnit = keyof typeof PER_LENGTH_METRES;

/** The largest stored figure (g or g/m). */
export const MASS_MAX = 1e9;

/** Six decimals: no float dust in a stored or derived figure. */
export function roundMass(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0;
}

/** `value` in `unit` as grams, six decimals. */
export function toGrams(value: number, unit: MassUnit): number {
  return roundMass(value * MASS_UNIT_GRAMS[unit]);
}

/** `value` grams per `per` (in `unit`) as grams per metre: `toGramsPerMetre(22, 'lb', 'kft')`. */
export function toGramsPerMetre(value: number, unit: MassUnit, per: PerLengthUnit): number {
  return roundMass((value * MASS_UNIT_GRAMS[unit]) / PER_LENGTH_METRES[per]);
}

/** `g` grams in `unit`, six decimals. */
export function fromGrams(g: number, unit: MassUnit): number {
  return roundMass(g / MASS_UNIT_GRAMS[unit]);
}

/** A mass for people: `8.2 g`, `0.35 g`, `1.83 kg`. */
export function formatGrams(g: number): string {
  const trim = (n: number, places: number): string => n.toFixed(places).replace(/\.?0+$/, '');
  if (Math.abs(g) >= 1000) return `${trim(g / 1000, 3)} kg`;
  if (Math.abs(g) >= 10 || g === 0) return `${trim(g, 1)} g`;
  return `${trim(g, 3)} g`;
}

/** A derived mass for people: `182.4 g`, `≥ 182.4 g`, or undefined when unknown. */
export function formatMassValue(value: MassValue): string | undefined {
  if (value.g === null) return undefined;
  return `${value.bound === 'floor' ? '≥ ' : ''}${formatGrams(value.g)}`;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const figure = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MASS_MAX;

/** The library directories whose records are weighed per piece. */
const PIECE_KINDS = ['connectors', 'components', 'pcbas', 'mechanicals', 'bodies'];
/** Library directories whose records are weighed by neither field (a kit is not a BOM line). */
const UNWEIGHED_KINDS = ['kits', 'interfaces'];

/**
 * The problems with a record's `mass` and `massPerLength` (`record-mass`, errors; absent is fine).
 * `where` is the record's address (`wires/x`): its directory decides which field belongs; a bare
 * id is checked for shape only.
 */
export function massIssues(record: object, where: string): Issue[] {
  const r = record as Record<string, unknown>;
  const issues: Issue[] = [];
  const bad = (message: string): void => {
    issues.push({ code: 'record-mass', severity: 'error', message: `record '${where}': ${message}`, where });
  };
  const kind = where.includes('/') ? where.slice(0, where.indexOf('/')) : undefined;
  const mass = r['mass'];
  if (mass !== undefined) {
    if (kind === 'wires') bad('a wire stock is weighed per length: massPerLength { gPerM }, not mass');
    else if (kind !== undefined && UNWEIGHED_KINDS.includes(kind)) bad(`a ${kind === 'kits' ? 'kit' : 'interface'} carries no mass`);
    else if (!isObject(mass) || Object.keys(mass).some((k) => k !== 'g' && k !== 'src')) bad('mass must be { g, src? }');
    else {
      if (!figure(mass['g'])) bad('mass.g must be a number of grams, 0 to 1e9');
      if (mass['src'] !== undefined && typeof mass['src'] !== 'string') bad('mass.src must be text');
    }
  }
  const perLength = r['massPerLength'];
  if (perLength !== undefined) {
    if (kind !== undefined && (PIECE_KINDS.includes(kind) || UNWEIGHED_KINDS.includes(kind))) bad('only a wire stock carries massPerLength; a part is weighed per piece: mass { g }');
    else if (!isObject(perLength) || Object.keys(perLength).some((k) => k !== 'gPerM' && k !== 'src')) bad('massPerLength must be { gPerM, src? }');
    else {
      if (!figure(perLength['gPerM'])) bad('massPerLength.gPerM must be a number of grams per metre, 0 to 1e9');
      if (perLength['src'] !== undefined && typeof perLength['src'] !== 'string') bad('massPerLength.src must be text');
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

export type PieceKind = 'connectors' | 'components' | 'pcbas' | 'mechanicals' | 'bodies';

const massOf = (record: { mass?: RecordMass } | undefined): number | undefined => (record?.mass !== undefined && figure(record.mass.g) ? record.mass.g : undefined);

/**
 * The mass of one piece of a library record, and the record it was read from: a connector's own
 * `mass` wins over its body's. A board's integrated connectors are inside the board's mass.
 */
export function effectivePieceMass(db: Db, kind: PieceKind, id: string): { g: number; from: string } | undefined {
  const own = (list: readonly { id: string; mass?: RecordMass }[] | undefined): number | undefined => massOf(list?.find((r) => r.id === id));
  if (kind === 'connectors') {
    const connector = db.connectors.find((c) => c.id === id);
    if (connector === undefined) return undefined;
    const g = massOf(connector);
    if (g !== undefined) return { g, from: `connectors/${id}` };
    const body = connector.body === undefined ? undefined : db.bodies?.find((b) => b.id === connector.body);
    const bodyG = massOf(body);
    return bodyG === undefined || body === undefined ? undefined : { g: bodyG, from: `bodies/${body.id}` };
  }
  const list = kind === 'components' ? db.components : kind === 'pcbas' ? db.pcbas : kind === 'mechanicals' ? db.mechanicals : db.bodies;
  const g = own(list);
  return g === undefined ? undefined : { g, from: `${kind}/${id}` };
}

/** A wire stock's grams per metre, and the record. */
export function wireMassPerMetre(db: Db, id: string): { gPerM: number; from: string } | undefined {
  const wire = db.wires.find((w) => w.id === id);
  const v = wire?.massPerLength;
  return v === undefined || !figure(v.gPerM) ? undefined : { gPerM: v.gPerM, from: `wires/${id}` };
}
