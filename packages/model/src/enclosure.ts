/**
 * Parametric enclosures (WF-MECH): the design inputs of a generated case around one or more
 * board occurrences. A shell mechanical carries one as `enclosure`; the solids themselves are
 * generated outputs (the `enclosure` tool pack) and never stored in the record.
 *
 * Three kinds of value stay distinct here:
 * - design parameters (`params`): choices with useful defaults — wall 2 mm is a decision, not a fact;
 * - board facts (`EnclosureFact`): a measured, declared or estimated number, or explicitly unknown
 *   (`value: null`) — never silently zero;
 * - native geometry: read from the board's own source when it has one, at generation time.
 *
 * A draft may be incomplete (no board picked yet, unknown heights, unresolved references): those
 * are findings, not refusals. `enclosureProblems` only rejects what cannot be represented.
 *
 * Pure: values in, problems out.
 */

/**
 * How a board fact is known. `native`: read from the board's own source (its KiCad board file, or
 * the 3D export made from it) — a fact, not an estimate. `unknown` pairs with `value: null`.
 */
export const FACT_BASES = ['measured', 'declared', 'native', 'estimated', 'unknown'] as const;
export type FactBasis = (typeof FACT_BASES)[number];

/** A physical fact about a board, with how it is known. Millimetres. */
export interface EnclosureFact {
  value: number | null;
  basis: FactBasis;
  note?: string;
}

export const ENCLOSURE_EDGES = ['front', 'back', 'left', 'right'] as const;
export type EnclosureEdge = (typeof ENCLOSURE_EDGES)[number];

/** A connector or port on a board edge that needs an opening. Board-local mm, y toward the back. */
export interface EnclosurePort {
  id: string;
  label?: string;
  edge: EnclosureEdge;
  /** position along the edge: x for front/back, y for left/right, board-local */
  atMm: number;
  /** opening centre above the board's top face */
  zMm: number;
  widthMm: number;
  heightMm: number;
  shape?: 'rect' | 'round';
  /** how far the part sticks out past the board edge (negative: set back) */
  protrudeMm?: number;
  basis?: FactBasis;
  /** the footprint reference it was suggested from, when it came from the native source */
  ref?: string;
}

/** What the enclosure knows about one board (shared by all its occurrences). */
export interface EnclosureBoard {
  /** the pcbas record */
  pcba: string;
  /**
   * `native`: outline, holes and footprints come from the board's model source (a KiCad board
   * file). `declared`: the rectangle and holes below (a purchased black-box board, say).
   */
  geometry: 'native' | 'declared';
  widthMm?: EnclosureFact;
  lengthMm?: EnclosureFact;
  thicknessMm?: EnclosureFact;
  /** declared mounting holes, board-local mm (ignored for `native`, which reads its own) */
  holes?: { xMm: number; yMm: number; diameterMm: number }[];
  /** tallest part above the top face / below the underside */
  heightAboveMm?: EnclosureFact;
  heightBelowMm?: EnclosureFact;
  /** per-footprint heights for native geometry; a missing one is unknown */
  componentHeights?: Record<string, EnclosureFact>;
  ports?: EnclosurePort[];
}

/** One placed copy of a board. Without x/y it is laid out automatically. */
export interface EnclosureOccurrence {
  id: string;
  pcba: string;
  xMm?: number;
  yMm?: number;
  rotationDeg?: number;
}

export interface EnclosureParams {
  wallMm?: number;
  floorMm?: number;
  lidMm?: number;
  clearanceMm?: number;
  topClearanceMm?: number;
  standoffMm?: number;
  standoffDiameterMm?: number;
  pilotDiameterMm?: number;
  cornerRadiusMm?: number;
  /** floor top to lid underside; absent = derived from the tallest occurrence */
  interiorHeightMm?: number;
  lid?: 'flat' | 'split';
  splitHeightMm?: number;
  lipHeightMm?: number;
  fitMm?: number;
  lidScrews?: boolean;
  ventsLid?: boolean;
  ventsSides?: boolean;
  /** used for parts whose height is unknown */
  assumedPartHeightMm?: number;
}

/** A manual cut-out in the enclosure frame (x/y from the interior's minimum corner, z from the floor's outside). */
export interface EnclosureOpening {
  id: string;
  label?: string;
  face: EnclosureEdge | 'lid';
  uMm: number;
  vMm: number;
  widthMm: number;
  heightMm: number;
  shape?: 'rect' | 'round';
}

export interface EnclosureSpec {
  boards: EnclosureBoard[];
  occurrences: EnclosureOccurrence[];
  params?: EnclosureParams;
  openings?: EnclosureOpening[];
}

/** The defaults the generator uses for any parameter left out (tool pack `DEFAULTS`). */
export const ENCLOSURE_DEFAULTS: Required<Omit<EnclosureParams, 'interiorHeightMm' | 'splitHeightMm'>> = {
  wallMm: 2,
  floorMm: 2,
  lidMm: 2,
  clearanceMm: 1,
  topClearanceMm: 2,
  standoffMm: 5,
  standoffDiameterMm: 5.5,
  pilotDiameterMm: 2.5,
  cornerRadiusMm: 2,
  lid: 'flat',
  lipHeightMm: 2,
  fitMm: 0.25,
  lidScrews: true,
  ventsLid: true,
  ventsSides: false,
  assumedPartHeightMm: 10,
};

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function factProblem(v: unknown, at: string): string | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return `${at} is not a fact ({ value, basis }).`;
  if (!(FACT_BASES as readonly unknown[]).includes(v['basis'])) return `${at} has no basis (measured, declared, native, estimated or unknown).`;
  if (v['value'] !== null && !(isNum(v['value']) && v['value'] >= 0)) return `${at} is not a positive number or null.`;
  if (v['basis'] === 'unknown' && v['value'] !== null) return `${at} is unknown but has a value; say how it is known.`;
  return undefined;
}

/**
 * Structural problems that make an enclosure spec unrepresentable (the save gate). Design
 * advice — unknown heights, an unresolved board, a port behind a wall — is the generator's
 * findings, not this.
 */
export function enclosureProblems(value: unknown): string[] {
  const out: string[] = [];
  if (!isObj(value)) return ['The enclosure is not in the right form ({ boards, occurrences, params }).'];
  const boards = value['boards'];
  const occurrences = value['occurrences'];
  if (!Array.isArray(boards)) out.push('The enclosure has no boards list.');
  if (!Array.isArray(occurrences)) out.push('The enclosure has no occurrences list.');
  const boardIds = new Set<string>();
  for (const [i, b] of (Array.isArray(boards) ? boards : []).entries()) {
    const at = `Board ${i + 1}`;
    if (!isObj(b) || typeof b['pcba'] !== 'string' || !ID.test(b['pcba'])) { out.push(`${at} does not name a board record.`); continue; }
    if (boardIds.has(b['pcba'])) out.push(`${at}: ${b['pcba']} is listed twice; add another occurrence instead.`);
    boardIds.add(b['pcba']);
    if (b['geometry'] !== 'native' && b['geometry'] !== 'declared') out.push(`${at}: geometry is native or declared.`);
    for (const key of ['widthMm', 'lengthMm', 'thicknessMm', 'heightAboveMm', 'heightBelowMm']) {
      const p = factProblem(b[key], `${at} ${key}`);
      if (p !== undefined) out.push(p);
    }
    const heights = b['componentHeights'];
    if (heights !== undefined) {
      if (!isObj(heights)) out.push(`${at}: component heights are a map of reference to fact.`);
      else for (const [ref, f] of Object.entries(heights)) { const p = factProblem(f, `${at} ${ref} height`); if (p !== undefined) out.push(p); }
    }
    const holes = b['holes'];
    if (holes !== undefined && (!Array.isArray(holes) || !holes.every((h) => isObj(h) && isNum(h['xMm']) && isNum(h['yMm']) && isNum(h['diameterMm']) && h['diameterMm'] > 0))) {
      out.push(`${at}: each hole needs xMm, yMm and a positive diameterMm.`);
    }
    const ports = b['ports'];
    if (ports !== undefined) {
      if (!Array.isArray(ports)) out.push(`${at}: ports is a list.`);
      else for (const [j, q] of ports.entries()) {
        const pat = `${at} port ${j + 1}`;
        if (!isObj(q) || typeof q['id'] !== 'string' || q['id'] === '') { out.push(`${pat} has no id.`); continue; }
        if (!(ENCLOSURE_EDGES as readonly unknown[]).includes(q['edge'])) out.push(`${pat}: edge is front, back, left or right.`);
        if (!isNum(q['atMm']) || !isNum(q['zMm'])) out.push(`${pat}: atMm and zMm are numbers.`);
        if (!isNum(q['widthMm']) || q['widthMm'] <= 0 || !isNum(q['heightMm']) || q['heightMm'] <= 0) out.push(`${pat}: widthMm and heightMm are positive numbers.`);
        if (q['shape'] !== undefined && q['shape'] !== 'rect' && q['shape'] !== 'round') out.push(`${pat}: shape is rect or round.`);
        if (q['protrudeMm'] !== undefined && !isNum(q['protrudeMm'])) out.push(`${pat}: protrudeMm is a number.`);
        if (q['basis'] !== undefined && !(FACT_BASES as readonly unknown[]).includes(q['basis'])) out.push(`${pat}: basis is measured, declared, native, estimated or unknown.`);
      }
    }
  }
  const occIds = new Set<string>();
  for (const [i, o] of (Array.isArray(occurrences) ? occurrences : []).entries()) {
    const at = `Occurrence ${i + 1}`;
    if (!isObj(o) || typeof o['id'] !== 'string' || !ID.test(o['id'])) { out.push(`${at} has no id (lowercase words).`); continue; }
    if (occIds.has(o['id'])) out.push(`${at}: id ${o['id']} is used twice.`);
    occIds.add(o['id']);
    if (typeof o['pcba'] !== 'string' || !boardIds.has(o['pcba'])) out.push(`${at} names a board that is not in the boards list.`);
    for (const key of ['xMm', 'yMm', 'rotationDeg']) if (o[key] !== undefined && !isNum(o[key])) out.push(`${at}: ${key} is a number.`);
  }
  const params = value['params'];
  if (params !== undefined) {
    if (!isObj(params)) out.push('The enclosure parameters are not in the right form.');
    else for (const [k, v] of Object.entries(params)) {
      if (k === 'lid') { if (v !== 'flat' && v !== 'split') out.push('lid is flat or split.'); continue; }
      if (k === 'lidScrews' || k === 'ventsLid' || k === 'ventsSides') { if (typeof v !== 'boolean') out.push(`${k} is yes or no.`); continue; }
      if (!k.endsWith('Mm')) { out.push(`${k} is not an enclosure parameter.`); continue; }
      if (!isNum(v) || v < 0) out.push(`${k} is not a positive number.`);
    }
  }
  const openings = value['openings'];
  if (openings !== undefined && (!Array.isArray(openings) || !openings.every((o) => isObj(o) && typeof o['id'] === 'string'
    && ['front', 'back', 'left', 'right', 'lid'].includes(String(o['face'])) && isNum(o['uMm']) && isNum(o['vMm']) && isNum(o['widthMm']) && isNum(o['heightMm'])))) {
    out.push('Each manual opening needs an id, a face and uMm, vMm, widthMm, heightMm.');
  }
  return out;
}
