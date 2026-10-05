/**
 * The formboard (nail-board) drawing: the cable laid out flat at true length,
 * the way a harness is built on a board.
 *
 * What it draws, all derived and never authored (`specs/formboard.md`):
 *
 * - **runs**: every wire segment as a straight line of its true `lengthMm`;
 *   the trunk first, then each breakout's legs fanned out from the breakout
 *   point at a fixed branch step;
 * - **pegs**: a numbered fixture point at every free end and at every breakout;
 * - **connectors**: a glyph at each free end naming what the end lands on;
 * - **moulds**: a glyph at each breakout, named after its mechanical part;
 * - **labels**: the wire-label markers (`deriveLabels`) at their offset from each end;
 * - **sleeves and tape**: a heat-shrink sleeve or tape part attached to a
 *   connector, at that connector's end.
 *
 * Lengths and angles are the truth of the drawing; glyphs (connector, mould,
 * sleeve) are fixed-size symbols and say so. Pages are paper in millimetres:
 * an overview (the whole board fitted to one sheet, with tables and the tile
 * map) and, when the board is larger than a sheet at the chosen scale, tiles at
 * that scale with registration marks. Pure and deterministic: no clock, no
 * randomness; identical input gives identical bytes.
 */

import { breakoutAt, findComponent, findConnector, findMechanical, findPcba, findWire, flattenSubassemblies, hasSubassemblies, type CableDesign, type Db, type SegmentInstance } from '@wirehub/model';

import { textWidth } from './drawing/render.ts';
import { trunkSegment } from './drawing/model.ts';
import type { DrawingMeta } from './drawing/model.ts';
import { deriveLabels } from './exports/labels.ts';
import { Occupied, placeFirstFree, rotatedRect, shiftIntoView, thickLine, type Poly, type Pt, type View } from './formboard-labels.ts';
import { suppliedEnds } from './supplied.ts';
import { compareStrings, escapeHtml } from './text.ts';

type End = 'a' | 'b';

/** Degrees between neighbouring legs of one breakout (a Y's legs sit at plus and minus half of it). */
export const BRANCH_STEP_DEG = 30;
/** A run with no `lengthMm` is drawn this long, dashed, and called out. */
export const NOMINAL_LENGTH_MM = 200;
/** Paper overlap between neighbouring tiles. */
export const TILE_OVERLAP_MM = 10;
/** Fixed glyph sizes (board mm, scaled with the board but not to the part). */
const CONNECTOR_LENGTH = 30;
const CONNECTOR_WIDTH = 18;
const MOULD_LENGTH = 40;
const MOULD_WIDTH = 22;
const SLEEVE_DEFAULT_MM = 25;
const BOARD_MARGIN_MM = 40;
const MARGIN = 12;
const FOOTER = 7;
/** Paper padding round the board on every side, so dimension lines and labels near its edge stay on the sheet. */
const PAD = 10;

export const FORMBOARD_PAPER = {
  A4: { width: 297, height: 210 },
  letter: { width: 279.4, height: 215.9 },
} as const;

/* ------------------------------------------------------------------ *
 * The derived board
 * ------------------------------------------------------------------ */

export interface BoardPoint {
  x: number;
  y: number;
}

export interface FormboardRun {
  segment: string;
  /** the label designation (`W1`) the wire labels use */
  designation: string;
  stock: string;
  /** where the run starts and ends on the board (the start is the end nearer the trunk's origin) */
  from: BoardPoint;
  to: BoardPoint;
  /** the segment end at `from` */
  fromEnd: End;
  lengthMm: number;
  /** false: the design gives no length; the run is drawn at `NOMINAL_LENGTH_MM`, dashed */
  lengthKnown: boolean;
  /** direction of travel, degrees, 0 = +x, clockwise on the board (y down) */
  angleDeg: number;
  /** angle against the run it branches from (absent for a root run) */
  branchDeg?: number;
  parent?: string;
  /** carries only part of its stock (a breakout run) */
  scoped: boolean;
}

export interface FormboardJoined {
  id: string;
  label: string;
  def: string;
}

export interface FormboardPeg {
  id: string;
  at: BoardPoint;
  kind: 'end' | 'breakout';
  note: string;
}

export interface FormboardTerminus {
  segment: string;
  end: End;
  at: BoardPoint;
  /** outward direction, degrees */
  angleDeg: number;
  joined: FormboardJoined[];
}

export interface FormboardMould {
  breakout: string;
  at: BoardPoint;
  angleDeg: number;
  label: string;
  housed: string[];
}

export interface FormboardMarker {
  kind: 'label' | 'sleeve' | 'tape';
  segment: string;
  end: End;
  text: string;
  /** distance along the run from the given end, mm */
  offsetMm: number;
  /** extent along the run (sleeve, tape), mm */
  lengthMm?: number;
  /** the extent is the part's own, not the nominal glyph */
  lengthKnown?: boolean;
}

export interface Formboard {
  designId: string;
  title: string;
  /** the board's size, mm (its bounding box with a margin); every coordinate is from its top-left corner */
  width: number;
  height: number;
  runs: FormboardRun[];
  pegs: FormboardPeg[];
  termini: FormboardTerminus[];
  moulds: FormboardMould[];
  markers: FormboardMarker[];
  /** things worth saying on the sheet: unset lengths, runs the supplier delivers, separate runs */
  notes: string[];
}

export interface FormboardOptions {
  /** the length family's suffix: the trunk is cut to that variation's length */
  variation?: string;
  drawing?: DrawingMeta;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;
const other = (end: End): End => (end === 'a' ? 'b' : 'a');

function r2(value: number): number {
  const v = Math.round(value * 100) / 100;
  return v === 0 ? 0 : v;
}
const n2 = (value: number): string => String(r2(value));

function designationOf(design: CableDesign, id: string): string {
  const own = design.instances.connectors.find((c) => c.id === id)?.label?.trim();
  return own !== undefined && own !== '' ? own : id.toUpperCase();
}

function describeInstance(design: CableDesign, db: Db, id: string): FormboardJoined | undefined {
  const connector = design.instances.connectors.find((c) => c.id === id);
  if (connector !== undefined) return { id, label: designationOf(design, id), def: findConnector(db, connector.def)?.label ?? connector.def };
  const pcba = design.instances.pcbas.find((p) => p.id === id);
  if (pcba !== undefined) return { id, label: id.toUpperCase(), def: findPcba(db, pcba.def)?.label ?? pcba.def };
  const component = design.instances.components.find((c) => c.id === id);
  if (component !== undefined) return { id, label: id.toUpperCase(), def: findComponent(db, component.def)?.label ?? component.def };
  return undefined;
}

function joinedAt(design: CableDesign, db: Db, segment: string, end: End): FormboardJoined[] {
  const ids = new Set<string>();
  for (const joint of design.joints) {
    for (const [near, far] of [[joint.a, joint.b], [joint.b, joint.a]] as const) {
      if (near.instance === segment && near.end === end && far.instance !== segment) ids.add(far.instance);
    }
  }
  const out: FormboardJoined[] = [];
  for (const id of [...ids].sort(compareStrings)) {
    const described = describeInstance(design, db, id);
    if (described !== undefined) out.push(described);
  }
  return out;
}

/** "Heat-shrink sleeve 6 mm, 40 mm long" is a sleeve of 40 mm; a part that names no length gets the nominal glyph. */
function wrapKind(label: string): 'sleeve' | 'tape' | undefined {
  if (/\btape\b/i.test(label)) return 'tape';
  if (/heat[- ]?shrink|\bsleeve\b/i.test(label)) return 'sleeve';
  return undefined;
}
function wrapLength(label: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*mm\s+long/i.exec(label);
  return match === null ? undefined : Number(match[1]);
}

/** Derive the board's geometry from the design: no drawing, no paper. */
export function deriveFormboard(given: CableDesign, givenDb: Db, options: FormboardOptions = {}): Formboard {
  // the whole harness lies on the board: a sub-assembly's runs are laid out with this design's own
  const flat = hasSubassemblies(given) && givenDb.assemblies !== undefined ? flattenSubassemblies(given, givenDb) : undefined;
  const design = flat?.design ?? given;
  const db = flat?.db ?? givenDb;
  const segments = design.instances.segments;
  const byId = new Map(segments.map((s) => [s.id, s]));
  const trunk = trunkSegment(design, db);
  const notes: string[] = [];

  // the trunk is cut to the chosen variation's length
  const variant = options.variation === undefined ? undefined : options.drawing?.lengths?.find((l) => l.suffix === options.variation);
  const lengthOf = (segment: SegmentInstance): number | undefined => (variant !== undefined && segment.id === trunk?.id ? variant.mm : segment.lengthMm);

  const runs: FormboardRun[] = [];
  const termini: FormboardTerminus[] = [];
  const moulds: FormboardMould[] = [];
  const pegSpots: { at: BoardPoint; kind: 'end' | 'breakout'; note: string }[] = [];
  const placed = new Set<string>();
  const covered = new Set(suppliedEnds(design, db).flatMap((s) => [...s.covers]));

  const point = (from: BoardPoint, angleDeg: number, length: number): BoardPoint => ({
    x: from.x + length * Math.cos(rad(angleDeg)),
    y: from.y + length * Math.sin(rad(angleDeg)),
  });

  /** Fan the other members of a breakout out of `at`, each leaving at `angleDeg` plus its share of the step. */
  const fan = (breakoutId: string, skip: { segment: string; end: End }, at: BoardPoint, outward: number, parent: string): void => {
    const breakout = (design.instances.breakouts ?? []).find((b) => b.id === breakoutId);
    if (breakout === undefined) return;
    const members = [breakout.trunk, ...breakout.legs].filter((m) => !(m.segment === skip.segment && m.end === skip.end));
    members.forEach((member, index) => {
      const angle = outward + BRANCH_STEP_DEG * (index - (members.length - 1) / 2);
      place(member.segment, member.end, at, angle, parent, angle - outward);
    });
  };

  const place = (id: string, fromEnd: End, from: BoardPoint, angleDeg: number, parent: string | undefined, branchDeg: number | undefined): void => {
    const segment = byId.get(id);
    if (segment === undefined || placed.has(id)) return;
    placed.add(id);
    const length = lengthOf(segment);
    const lengthKnown = length !== undefined && length > 0;
    const mm = lengthKnown ? (length as number) : NOMINAL_LENGTH_MM;
    const to = point(from, angleDeg, mm);
    const wire = findWire(db, segment.def);
    runs.push({
      segment: id,
      designation: '',
      stock: wire?.label ?? segment.def,
      from: { ...from },
      to,
      fromEnd,
      lengthMm: mm,
      lengthKnown,
      angleDeg,
      ...(branchDeg === undefined ? {} : { branchDeg }),
      ...(parent === undefined ? {} : { parent }),
      scoped: segment.scope !== undefined,
    });
    for (const [end, at, outward] of [
      [fromEnd, from, angleDeg + 180],
      [other(fromEnd), to, angleDeg],
    ] as const) {
      const here = breakoutAt(design, id, end);
      if (here === undefined) {
        termini.push({ segment: id, end, at: { ...at }, angleDeg: outward, joined: joinedAt(design, db, id, end) });
        pegSpots.push({ at: { ...at }, kind: 'end', note: `${id} end ${end.toUpperCase()}` });
      } else if (end === other(fromEnd)) {
        const mouldInstance = here.breakout.mould === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === here.breakout.mould);
        const mouldLabel = mouldInstance === undefined ? undefined : findMechanical(db, mouldInstance.def)?.label;
        moulds.push({
          breakout: here.breakout.id,
          at: { ...at },
          angleDeg,
          label: mouldLabel ?? here.breakout.role ?? 'breakout',
          housed: (here.breakout.housed ?? []).map((h) => designationOf(design, h)),
        });
        pegSpots.push({ at: { ...at }, kind: 'breakout', note: `${here.breakout.id} breakout point` });
        fan(here.breakout.id, { segment: id, end }, at, angleDeg, id);
      }
    }
  };

  // the components of the design, trunk's first, each laid out below the one before
  const order = [...segments.filter((s) => s.id === trunk?.id), ...segments.filter((s) => s.id !== trunk?.id)];
  let nextY = 0;
  let first = true;
  const extent = (): number => runs.reduce((m, r) => Math.max(m, r.from.y, r.to.y), 0);
  for (const segment of order) {
    if (placed.has(segment.id)) continue;
    // a leg or trunk of a breakout is placed by its breakout, from the root run of its tree
    const start: End = breakoutAt(design, segment.id, 'a') !== undefined && breakoutAt(design, segment.id, 'b') === undefined ? 'b' : 'a';
    const origin: BoardPoint = { x: 0, y: first ? 0 : nextY };
    if (!first) notes.push(`${segment.id} is a separate run, drawn below the main board.`);
    // a root whose start end sits in a breakout fans that breakout out behind it
    const behind = breakoutAt(design, segment.id, start);
    place(segment.id, start, origin, 0, undefined, undefined);
    if (behind !== undefined) {
      const mouldInstance = behind.breakout.mould === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === behind.breakout.mould);
      moulds.push({
        breakout: behind.breakout.id,
        at: { ...origin },
        angleDeg: 180,
        label: (mouldInstance === undefined ? undefined : findMechanical(db, mouldInstance.def)?.label) ?? behind.breakout.role ?? 'breakout',
        housed: (behind.breakout.housed ?? []).map((h) => designationOf(design, h)),
      });
      pegSpots.push({ at: { ...origin }, kind: 'breakout', note: `${behind.breakout.id} breakout point` });
      fan(behind.breakout.id, { segment: segment.id, end: start }, origin, 180, segment.id);
    }
    first = false;
    nextY = extent() + 120;
  }

  // designations come from the wire labels so the sheet and the label sheet agree
  const labels = deriveLabels(design, db);
  const designations = new Map(labels.map((l) => [l.segment, l.designation]));
  for (const run of runs) {
    run.designation = designations.get(run.segment) ?? run.segment.toUpperCase();
    if (covered.has(run.segment)) notes.push(`${run.segment} arrives terminated from the supplier; it is drawn for layout only.`);
    if (!run.lengthKnown) notes.push(`${run.segment} has no length; it is drawn ${NOMINAL_LENGTH_MM} mm long, dashed.`);
  }

  // markers
  const markers: FormboardMarker[] = [];
  const runIds = new Set(runs.map((r) => r.segment));
  for (const label of labels) {
    if (label.core !== undefined || !runIds.has(label.segment)) continue;
    markers.push({ kind: 'label', segment: label.segment, end: label.end, text: `${label.designation}-${label.end.toUpperCase()}`, offsetMm: label.offsetMm });
  }
  for (const mechanical of design.instances.mechanical ?? []) {
    if (mechanical.attachedTo === undefined) continue;
    const def = findMechanical(db, mechanical.def);
    const kind = def === undefined ? undefined : wrapKind(def.label);
    if (def === undefined || kind === undefined) continue;
    for (const run of runs) {
      for (const end of ['a', 'b'] as const) {
        if (breakoutAt(design, run.segment, end) !== undefined) continue;
        if (!joinedAt(design, db, run.segment, end).some((j) => j.id === mechanical.attachedTo)) continue;
        const known = wrapLength(def.label);
        markers.push({
          kind,
          segment: run.segment,
          end,
          text: `${kind === 'tape' ? 'Tape' : 'Sleeve'} on ${designationOf(design, mechanical.attachedTo)}`,
          offsetMm: 0,
          lengthMm: Math.min(known ?? SLEEVE_DEFAULT_MM, run.lengthMm),
          lengthKnown: known !== undefined,
        });
      }
    }
  }
  if (markers.some((m) => m.kind !== 'label' && m.lengthKnown === false)) {
    notes.push('A sleeve or tape whose part names no length is drawn 25 mm long.');
  }

  // normalise: the board's top-left corner is (0, 0), a margin outside everything drawn
  const xs: number[] = [];
  const ys: number[] = [];
  for (const run of runs) xs.push(run.from.x, run.to.x), ys.push(run.from.y, run.to.y);
  for (const t of termini) {
    const far = point(t.at, t.angleDeg, CONNECTOR_LENGTH);
    xs.push(far.x, t.at.x), ys.push(far.y, t.at.y);
  }
  for (const m of moulds) xs.push(m.at.x - MOULD_LENGTH, m.at.x + MOULD_LENGTH), ys.push(m.at.y - MOULD_LENGTH, m.at.y + MOULD_LENGTH);
  const minX = xs.length === 0 ? 0 : Math.min(...xs) - BOARD_MARGIN_MM;
  const minY = ys.length === 0 ? 0 : Math.min(...ys) - BOARD_MARGIN_MM;
  const shift = (p: BoardPoint): BoardPoint => ({ x: r2(p.x - minX), y: r2(p.y - minY) });
  for (const run of runs) {
    run.from = shift(run.from);
    run.to = shift(run.to);
    run.angleDeg = r2(run.angleDeg);
    if (run.branchDeg !== undefined) run.branchDeg = r2(run.branchDeg);
  }
  for (const t of termini) {
    t.at = shift(t.at);
    t.angleDeg = r2(t.angleDeg);
  }
  for (const m of moulds) {
    m.at = shift(m.at);
    m.angleDeg = r2(m.angleDeg);
  }
  // pegs are numbered after the shift, in drawing order (runs, then ends in run order)
  const pegs: FormboardPeg[] = pegSpots.map((spot, index) => ({ id: `P${index + 1}`, at: shift(spot.at), kind: spot.kind, note: spot.note }));
  const width = xs.length === 0 ? 2 * BOARD_MARGIN_MM : Math.max(...xs) + BOARD_MARGIN_MM - minX;
  const height = ys.length === 0 ? 2 * BOARD_MARGIN_MM : Math.max(...ys) + BOARD_MARGIN_MM - minY;
  return {
    designId: design.id,
    title: options.drawing?.title ?? design.label,
    width: r2(width),
    height: r2(height),
    runs,
    pegs,
    termini,
    moulds,
    markers,
    notes: [...new Set(notes)],
  };
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

export interface FormboardSheetOptions {
  paper?: 'A4' | 'letter';
  /** paper millimetres per board millimetre; 1 is 1:1 (the default); 0.5 is 1:2 */
  scale?: number;
  /** document facts for the footer */
  revisionNumber?: number;
}

export interface FormboardLayout {
  paper: 'A4' | 'letter';
  scale: number;
  cols: number;
  rows: number;
  /** tile count; page 0 is the overview, pages 1..tiles the tiles */
  tiles: number;
  /** a tile's printable area, paper mm */
  content: { width: number; height: number };
  /** the distance between registration marks, paper mm */
  step: { x: number; y: number };
}

/** Parse a scale: a number (`0.5`) or a ratio (`1:2`). Returns undefined when it is neither, or not in 1:100 to 10:1. */
export function parseScale(text: string): number | undefined {
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text.trim());
  const value = ratio === null ? Number(text) : Number(ratio[1]) / Number(ratio[2]);
  if (!Number.isFinite(value) || text.trim() === '' || value < 0.01 || value > 10) return undefined;
  return value;
}

/** "1:1", "1:2", "2:1", else three significant figures. */
export function scaleText(scale: number): string {
  if (scale >= 1) return Number.isInteger(scale) ? `${scale}:1` : `${r2(scale)}:1`;
  const inverse = 1 / scale;
  return Number.isInteger(r2(inverse)) ? `1:${r2(inverse)}` : `1:${Math.round(inverse * 100) / 100}`;
}

export function formboardLayout(board: Formboard, options: FormboardSheetOptions = {}): FormboardLayout {
  const paper = options.paper ?? 'A4';
  const scale = options.scale ?? 1;
  const size = FORMBOARD_PAPER[paper];
  const content = { width: size.width - 2 * MARGIN, height: size.height - 2 * MARGIN - FOOTER };
  const step = { x: content.width - TILE_OVERLAP_MM, y: content.height - TILE_OVERLAP_MM };
  const cover = (extent: number, stepSize: number, room: number): number => (extent <= room + 1e-9 ? 1 : Math.ceil((extent - TILE_OVERLAP_MM) / stepSize - 1e-9));
  const cols = cover(board.width * scale + 2 * PAD, step.x, content.width);
  const rows = cover(board.height * scale + 2 * PAD, step.y, content.height);
  return { paper, scale, cols, rows, tiles: cols * rows, content, step };
}

const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const ACCENT = '#0b5cad';
const FONT = "'CS Sans', 'Liberation Sans', Helvetica, Arial, sans-serif";

interface Frame {
  /** board mm to paper mm */
  x(board: number): number;
  y(board: number): number;
  scale: number;
  /** the part of the page this drawing is visible in (a tile's cell): a caption is kept whole inside it where it fits */
  view?: View;
}

function rotate(angleDeg: number): string {
  return n2(angleDeg);
}

/** Text that reads upright whatever the run's direction. */
function uprightAngle(angleDeg: number): number {
  let a = ((angleDeg % 360) + 360) % 360;
  if (a > 90 && a < 270) a -= 180;
  return a > 180 ? a - 360 : a;
}

function text(x: number, y: number, size: number, body: string, extra = ''): string {
  return `<text x="${n2(x)}" y="${n2(y)}" font-size="${n2(size)}" ${extra.includes(' fill=') ? '' : ` fill="${INK}"`}${extra}>${escapeHtml(body)}</text>`;
}


/* ------------------------------------------------------------------ *
 * Caption placement: keep captions off glyphs, pegs, ticks and each other
 * ------------------------------------------------------------------ */

interface RunGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ux: number;
  uy: number;
  /** unit normal: the side the dimension line is on */
  nx: number;
  ny: number;
  /** the dimension line's midpoint */
  mx: number;
  my: number;
  /** the angle text reads at, upright */
  flat: number;
}

/** The dimension line sits this far (paper mm) to the left of the direction of travel. */
const DIMENSION_OFFSET = 7;

function runGeometry(run: FormboardRun, frame: Frame): RunGeometry {
  const x1 = frame.x(run.from.x);
  const y1 = frame.y(run.from.y);
  const x2 = frame.x(run.to.x);
  const y2 = frame.y(run.to.y);
  const ang = rad(run.angleDeg);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const nx = uy;
  const ny = -ux;
  return {
    x1,
    y1,
    x2,
    y2,
    ux,
    uy,
    nx,
    ny,
    mx: (x1 + x2) / 2 + nx * DIMENSION_OFFSET,
    my: (y1 + y2) / 2 + ny * DIMENSION_OFFSET,
    flat: uprightAngle(run.angleDeg),
  };
}

interface TextBox {
  size: number;
  bold?: boolean;
  anchor?: 'start' | 'middle' | 'end';
  /** `dominant-baseline="middle"`: y is the text's middle, not its baseline */
  middle?: boolean;
  /** turned this many degrees about `pivot` (the text's own position when absent) */
  angle?: number;
  pivot?: Pt;
}

/** The rectangle a one-line caption occupies, from the face's glyph widths. */
function textPoly(at: Pt, body: string, box: TextBox, pad = 0.25): Poly {
  const w = textWidth(body, box.size, box.bold === true);
  const x0 = box.anchor === 'middle' ? -w / 2 : box.anchor === 'end' ? -w : 0;
  const top = box.middle === true ? -box.size * 0.5 : -box.size * 0.78;
  const bottom = box.middle === true ? box.size * 0.5 : box.size * 0.22;
  const pivot = box.pivot ?? at;
  const a = ((box.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return ([
    [x0 - pad, top - pad],
    [x0 + w + pad, top - pad],
    [x0 + w + pad, bottom + pad],
    [x0 - pad, bottom + pad],
  ] as const).map(([lx, ly]) => {
    const dx = at.x + lx - pivot.x;
    const dy = at.y + ly - pivot.y;
    return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
  });
}

/** A block of caption lines (one anchor, one x, a line pitch) as one rectangle. */
function blockPoly(x: number, y: number, lines: readonly { body: string; size: number; bold: boolean }[], pitch: number, anchor: 'start' | 'middle' | 'end'): Poly {
  const w = Math.max(0, ...lines.map((l) => textWidth(l.body, l.size, l.bold)));
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return [];
  const top = y - first.size * 0.78 - 0.25;
  const bottom = y + (lines.length - 1) * pitch + last.size * 0.22 + 0.25;
  return [
    { x: x0 - 0.25, y: top },
    { x: x0 + w + 0.25, y: top },
    { x: x0 + w + 0.25, y: bottom },
    { x: x0 - 0.25, y: bottom },
  ];
}

const translated = (poly: Poly, dx: number, dy: number): Poly => poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
const bounds = (poly: Poly): { x0: number; x1: number } => ({ x0: Math.min(...poly.map((p) => p.x)), x1: Math.max(...poly.map((p) => p.x)) });

interface Captions {
  /** how far a mould's or a terminus's whole caption moves from its home place */
  mould: Map<string, Pt>;
  terminus: Map<string, Pt>;
  peg: Map<string, { x: number; y: number; anchor: 'start' | 'middle' | 'end' }>;
  tick: Map<string, Pt>;
}

/**
 * Where each caption goes. Every caption has a home place (the one the sheet
 * always used); it keeps it unless something else is there, and then takes the
 * first free spot of a fixed list — nudged away from the glyph, flipped to the
 * other side, or slid along the run. A caption the tile edge would cut is
 * pulled inside it when it fits whole. The fixed things are the glyphs, pegs,
 * ticks, runs, dimension lines and the texts that are not moved; captions are
 * placed in this order: pegs (whose labels may sit inside a mould), moulds, connectors, ticks.
 */
function planCaptions(board: Formboard, frame: Frame, compact: boolean): Captions {
  const S = frame.scale;
  const view = frame.view;
  const occupied = new Occupied();
  const plan: Captions = { mould: new Map(), terminus: new Map(), peg: new Map(), tick: new Map() };
  const px = (p: BoardPoint): Pt => ({ x: frame.x(p.x), y: frame.y(p.y) });
  const byRun = new Map(board.runs.map((r) => [r.segment, r]));

  for (const t of board.termini) {
    const at = px(t.at);
    const dir = rad(t.angleDeg);
    const mid = { x: at.x + Math.cos(dir) * CONNECTOR_LENGTH * S * 0.5, y: at.y + Math.sin(dir) * CONNECTOR_LENGTH * S * 0.5 };
    occupied.add(rotatedRect(mid, CONNECTOR_LENGTH * S, CONNECTOR_WIDTH * S, t.angleDeg, 0.2));
  }
  for (const peg of board.pegs) {
    const c = px(peg.at);
    occupied.add(rotatedRect(c, 4.4, 4.4, 0));
    occupied.add(thickLine({ x: c.x - 3.4, y: c.y }, { x: c.x + 3.4, y: c.y }, 0.4));
    occupied.add(thickLine({ x: c.x, y: c.y - 3.4 }, { x: c.x, y: c.y + 3.4 }, 0.4));
  }
  for (const run of board.runs) {
    const g = runGeometry(run, frame);
    occupied.add(thickLine({ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }, run.scoped ? 0.8 : 1.3));
    const dim = (a: number, b: number): Pt => ({ x: g.x1 + g.nx * a + g.ux * b, y: g.y1 + g.ny * a + g.uy * b });
    const length = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    occupied.add(thickLine(dim(DIMENSION_OFFSET, 0), dim(DIMENSION_OFFSET, length), 0.3));
    occupied.add(thickLine(dim(2, 0), dim(DIMENSION_OFFSET + 1.5, 0), 0.3));
    occupied.add(thickLine(dim(2, length), dim(DIMENSION_OFFSET + 1.5, length), 0.3));
    const dimText = `${run.lengthKnown ? '' : '~'}${n2(run.lengthMm)} mm`;
    occupied.add(textPoly({ x: g.mx, y: g.my - 0.8 }, dimText, { size: 3, anchor: 'middle', angle: g.flat, pivot: { x: g.mx, y: g.my } }));
    if (compact) continue;
    const tx = (g.x1 + g.x2) / 2 - g.nx * 3.4;
    const ty = (g.y1 + g.y2) / 2 - g.ny * 3.4;
    occupied.add(textPoly({ x: tx, y: ty }, `${run.designation} · ${run.stock}`, { size: 3, anchor: 'middle', middle: true, angle: g.flat }));
    if (run.branchDeg !== undefined && run.parent !== undefined && byRun.has(run.parent)) {
      const sign = run.branchDeg > 0 ? '+' : run.branchDeg < 0 ? '−' : '';
      occupied.add(textPoly({ x: g.x1 + g.ux * 9 - g.nx * 2, y: g.y1 + g.uy * 9 - g.ny * 2 }, `${sign}${n2(Math.abs(run.branchDeg))}°`, { size: 2.6, anchor: 'middle', middle: true }));
    }
  }
  // sleeves and tape are fixed; the label ticks' lines are fixed and their texts are placed below
  const ticks: { key: string; centre: Pt; home: Pt; along: Pt; flat: number; text: string }[] = [];
  for (const marker of board.markers) {
    const run = byRun.get(marker.segment);
    if (run === undefined) continue;
    const g = runGeometry(run, frame);
    const fromStart = marker.end === run.fromEnd;
    const sx = fromStart ? g.x1 : g.x2;
    const sy = fromStart ? g.y1 : g.y2;
    const dir = rad(fromStart ? run.angleDeg : run.angleDeg + 180);
    const ux = Math.cos(dir);
    const uy = Math.sin(dir);
    if (marker.kind === 'label') {
      if (compact) continue;
      const d = marker.offsetMm * S;
      const cx = sx + ux * d;
      const cy = sy + uy * d;
      occupied.add(thickLine({ x: cx - uy * 2.6, y: cy + ux * 2.6 }, { x: cx + uy * 2.6, y: cy - ux * 2.6 }, 0.9));
      ticks.push({ key: `${marker.segment}/${marker.end}`, centre: { x: cx, y: cy }, home: { x: cx - uy * 5.2, y: cy + ux * 5.2 }, along: { x: ux, y: uy }, flat: uprightAngle(fromStart ? run.angleDeg : run.angleDeg + 180), text: marker.text });
    } else {
      const len = (marker.lengthMm ?? SLEEVE_DEFAULT_MM) * S;
      const ex = sx + ux * len;
      const ey = sy + uy * len;
      occupied.add(thickLine({ x: sx, y: sy }, { x: ex, y: ey }, 3.4));
      occupied.add(textPoly({ x: (sx + ex) / 2 + uy * 5.6, y: (sy + ey) / 2 - ux * 5.6 }, marker.text, { size: 2.6, anchor: 'middle', middle: true }));
    }
  }

  // peg names first, beside the peg, on the first corner nothing is in (a breakout's peg sits inside its mould, so the mould's glyph is not in the way yet)
  for (const peg of board.pegs) {
    const c = px(peg.at);
    const spots: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }[] = [
      { x: c.x + 2.6, y: c.y - 2.6, anchor: 'start' },
      { x: c.x + 2.6, y: c.y + 5.2, anchor: 'start' },
      { x: c.x - 2.6, y: c.y - 2.6, anchor: 'end' },
      { x: c.x - 2.6, y: c.y + 5.2, anchor: 'end' },
      { x: c.x, y: c.y - 6, anchor: 'middle' },
      { x: c.x, y: c.y + 8.6, anchor: 'middle' },
      { x: c.x + 6, y: c.y - 2.6, anchor: 'start' },
      { x: c.x - 6, y: c.y - 2.6, anchor: 'end' },
    ];
    plan.peg.set(peg.id, placeFirstFree(occupied, spots, (s) => textPoly({ x: s.x, y: s.y }, peg.id, { size: 2.8, bold: true, anchor: s.anchor }), view));
  }

  for (const m of board.moulds) occupied.add(rotatedRect(px(m.at), MOULD_LENGTH * S, MOULD_WIDTH * S, m.angleDeg, 0.2));

  // moulds: centred over the glyph; lifted clear or moved under it, and held whole inside the tile
  for (const m of board.moulds) {
    const c = px(m.at);
    const lines = (compact ? [m.breakout] : [`${m.breakout} · ${m.label}`, ...(m.housed.length === 0 ? [] : [`houses ${m.housed.join(', ')}`])]).map((body) => ({ body, size: 3, bold: true }));
    const baseY = c.y - (MOULD_WIDTH * S) / 2 - 2.6 - (lines.length - 1) * 3.4;
    const home = blockPoly(c.x, baseY, lines, 3.4, 'middle');
    const inside = view !== undefined && c.x >= view.x0 && c.x <= view.x1;
    // lifted clear, or — when legs and dimension lines crowd the top — under the glyph
    const below = c.y + (MOULD_WIDTH * S) / 2 + 5.4 - baseY;
    const candidates = [0, -3.4, -6.8, below, below + 3.4].map((dy) => {
      const b = bounds(home);
      const dx = inside ? shiftIntoView(b.x0, b.x1, view) : 0;
      return { x: dx, y: dy };
    });
    const at = placeFirstFree(occupied, candidates, (shift) => translated(home, shift.x, shift.y), view);
    plan.mould.set(m.breakout, at);
  }

  // connector names: under the glyph, pushed away from it, flipped to its other side, or slid out
  for (const t of board.termini) {
    const at = px(t.at);
    const dir = rad(t.angleDeg);
    const sgn = Math.cos(dir) >= 0 ? 1 : -1;
    const nxp = -Math.sin(dir) * sgn;
    const nyp = Math.cos(dir) * sgn;
    const outerX = at.x + Math.cos(dir) * CONNECTOR_LENGTH * S;
    const outerY = at.y + Math.sin(dir) * CONNECTOR_LENGTH * S;
    const lx = outerX + nxp * (CONNECTOR_WIDTH * S * 0.5 + 3.4);
    const ly = outerY + nyp * (CONNECTOR_WIDTH * S * 0.5 + 3.4);
    const anchor = Math.cos(dir) > 0.3 ? 'end' : Math.cos(dir) < -0.3 ? 'start' : 'middle';
    const lines = compact
      ? [{ body: t.joined.length === 0 ? 'open' : t.joined.map((j) => j.label).join(', '), size: 3, bold: true }]
      : t.joined.length === 0
        ? [{ body: 'open end', size: 3, bold: true }]
        : t.joined.flatMap((j) => [
            { body: j.label, size: 3, bold: true },
            { body: clip(j.def, 38), size: 2.5, bold: false },
          ]);
    const home = blockPoly(lx, ly + 1, lines, 3.3, anchor);
    const blockHeight = (lines.length - 1) * 3.3 + 3;
    const side = CONNECTOR_WIDTH * S + 6.8;
    const flipped = { x: -nxp * side, y: -nyp * side - (-nyp * side < 0 ? blockHeight : 0) };
    const raw: Pt[] = [{ x: 0, y: 0 }];
    for (let k = 1; k <= 6; k += 1) raw.push({ x: nxp * 1.6 * k, y: nyp * 1.6 * k });
    for (let k = 1; k <= 4; k += 1) raw.push({ x: Math.cos(dir) * 3 * k, y: Math.sin(dir) * 3 * k });
    raw.push(flipped);
    for (let k = 1; k <= 4; k += 1) raw.push({ x: flipped.x - nxp * 1.6 * k, y: flipped.y - nyp * 1.6 * k });
    const inside = view !== undefined && lx >= view.x0 && lx <= view.x1;
    const candidates = raw.map((shift) => {
      const b = bounds(translated(home, shift.x, shift.y));
      return { x: shift.x + (inside ? shiftIntoView(b.x0, b.x1, view) : 0), y: shift.y };
    });
    const at2 = placeFirstFree(occupied, candidates, (shift) => translated(home, shift.x, shift.y), view);
    plan.terminus.set(`${t.segment}/${t.end}`, at2);
  }

  // label tick names: home beside the tick; slid along the run, then the same across it
  for (const tick of ticks) {
    const other = { x: 2 * tick.centre.x - tick.home.x, y: 2 * tick.centre.y - tick.home.y };
    const spots: Pt[] = [];
    for (const side of [tick.home, other]) {
      for (const k of [0, 1, -1, 2, -2, 3, -3]) spots.push({ x: side.x + tick.along.x * 3 * k, y: side.y + tick.along.y * 3 * k });
    }
    plan.tick.set(
      tick.key,
      placeFirstFree(occupied, spots, (at) => textPoly(at, tick.text, { size: 2.8, anchor: 'middle', middle: true, angle: tick.flat }), view),
    );
  }
  return plan;
}

/** The drawing of the board in one frame: runs, glyphs, pegs, dimensions. No page furniture. */
function drawBoard(board: Formboard, frame: Frame, compact = false): string {
  const out: string[] = [];
  const S = frame.scale;
  const px = (p: BoardPoint): [number, number] => [frame.x(p.x), frame.y(p.y)];
  const byRun = new Map(board.runs.map((r) => [r.segment, r]));
  const plan = planCaptions(board, frame, compact);

  // moulds, under the runs
  for (const m of board.moulds) {
    const [cx, cy] = px(m.at);
    out.push(
      `<g data-mould="${escapeHtml(m.breakout)}" transform="translate(${n2(cx)} ${n2(cy)}) rotate(${rotate(m.angleDeg)})">` +
        `<rect x="${n2(-MOULD_LENGTH * S * 0.5)}" y="${n2(-MOULD_WIDTH * S * 0.5)}" width="${n2(MOULD_LENGTH * S)}" height="${n2(MOULD_WIDTH * S)}" rx="${n2(Math.min(6, 4 * S))}" fill="#e8eef5" stroke="${INK}" stroke-width="0.35" stroke-dasharray="1.6 1"/>` +
        `</g>`,
    );
    const lines = compact ? [m.breakout] : [`${m.breakout} · ${m.label}`, ...(m.housed.length === 0 ? [] : [`houses ${m.housed.join(', ')}`])];
    const lift = plan.mould.get(m.breakout) ?? { x: 0, y: 0 };
    lines.forEach((line, i) => out.push(text(cx + lift.x, cy + lift.y - (MOULD_WIDTH * S) / 2 - 2.6 - (lines.length - 1 - i) * 3.4, 3, line, ` text-anchor="middle" font-weight="bold" data-caption="${escapeHtml(`mould:${m.breakout}`)}"`)));
  }

  // runs, their dimensions and markers
  for (const run of board.runs) {
    const [x1, y1] = px(run.from);
    const [x2, y2] = px(run.to);
    out.push(
      `<line data-run="${escapeHtml(run.segment)}" x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" stroke="${INK}" stroke-width="${run.scoped ? 0.8 : 1.3}" stroke-linecap="round"${run.lengthKnown ? '' : ' stroke-dasharray="3 2"'}/>`,
    );
    const ang = rad(run.angleDeg);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    // the dimension line sits 7 mm of paper to the left of the direction of travel
    const nx = uy;
    const ny = -ux;
    const off = 7;
    const dx1 = x1 + nx * off;
    const dy1 = y1 + ny * off;
    const dx2 = x2 + nx * off;
    const dy2 = y2 + ny * off;
    out.push(
      `<g data-dimension="${escapeHtml(run.segment)}" stroke="${ACCENT}" stroke-width="0.25" fill="none">` +
        `<line x1="${n2(dx1)}" y1="${n2(dy1)}" x2="${n2(dx2)}" y2="${n2(dy2)}"/>` +
        `<line x1="${n2(x1 + nx * 2)}" y1="${n2(y1 + ny * 2)}" x2="${n2(x1 + nx * (off + 1.5))}" y2="${n2(y1 + ny * (off + 1.5))}"/>` +
        `<line x1="${n2(x2 + nx * 2)}" y1="${n2(y2 + ny * 2)}" x2="${n2(x2 + nx * (off + 1.5))}" y2="${n2(y2 + ny * (off + 1.5))}"/>` +
        `<line x1="${n2(dx1 - ux * 1)}" y1="${n2(dy1 - uy * 1)}" x2="${n2(dx1 + ux * 1.4 + nx * 1)}" y2="${n2(dy1 + uy * 1.4 + ny * 1)}"/>` +
        `<line x1="${n2(dx2 + ux * 1)}" y1="${n2(dy2 + uy * 1)}" x2="${n2(dx2 - ux * 1.4 + nx * 1)}" y2="${n2(dy2 - uy * 1.4 + ny * 1)}"/>` +
        `</g>`,
    );
    const mx = (dx1 + dx2) / 2;
    const my = (dy1 + dy2) / 2;
    const flat = uprightAngle(run.angleDeg);
    const dimText = `${run.lengthKnown ? '' : '~'}${n2(run.lengthMm)} mm`;
    out.push(
      `<text x="${n2(mx)}" y="${n2(my - 0.8)}" font-size="3" fill="${ACCENT}" text-anchor="middle" transform="rotate(${rotate(flat)} ${n2(mx)} ${n2(my)})">${escapeHtml(dimText)}</text>`,
    );
    // the run's name, on the other side of the line
    if (compact) continue;
    const tx = (x1 + x2) / 2 - nx * 3.4;
    const ty = (y1 + y2) / 2 - ny * 3.4;
    out.push(
      `<text x="${n2(tx)}" y="${n2(ty)}" font-size="3" fill="${INK}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${rotate(flat)} ${n2(tx)} ${n2(ty)})">${escapeHtml(`${run.designation} · ${run.stock}`)}</text>`,
    );
    if (run.branchDeg !== undefined && run.parent !== undefined && byRun.has(run.parent)) {
      const sign = run.branchDeg > 0 ? '+' : run.branchDeg < 0 ? '−' : '';
      out.push(
        `<text x="${n2(x1 + ux * 9 - nx * 2)}" y="${n2(y1 + uy * 9 - ny * 2)}" font-size="2.6" fill="${MUTED}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(`${sign}${n2(Math.abs(run.branchDeg))}°`)}</text>`,
      );
    }
  }

  // sleeves, tape and label ticks
  for (const marker of board.markers) {
    const run = byRun.get(marker.segment);
    if (run === undefined) continue;
    const fromStart = marker.end === run.fromEnd;
    const [sx, sy] = px(fromStart ? run.from : run.to);
    const dir = rad(fromStart ? run.angleDeg : run.angleDeg + 180);
    const ux = Math.cos(dir);
    const uy = Math.sin(dir);
    if (compact && marker.kind === 'label') continue;
    if (marker.kind === 'label') {
      const d = marker.offsetMm * S;
      const cx = sx + ux * d;
      const cy = sy + uy * d;
      const name = plan.tick.get(`${marker.segment}/${marker.end}`) ?? { x: cx - uy * 5.2, y: cy + ux * 5.2 };
      out.push(
        `<g data-marker="${escapeHtml(`${marker.segment}/${marker.end}`)}"><line x1="${n2(cx - uy * 2.6)}" y1="${n2(cy + ux * 2.6)}" x2="${n2(cx + uy * 2.6)}" y2="${n2(cy - ux * 2.6)}" stroke="${INK}" stroke-width="0.7"/>` +
          `<text x="${n2(name.x)}" y="${n2(name.y)}" font-size="2.8" fill="${INK}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${rotate(uprightAngle(fromStart ? run.angleDeg : run.angleDeg + 180))} ${n2(name.x)} ${n2(name.y)})">${escapeHtml(marker.text)}</text></g>`,
      );
    } else {
      const len = (marker.lengthMm ?? SLEEVE_DEFAULT_MM) * S;
      const ex = sx + ux * len;
      const ey = sy + uy * len;
      out.push(
        `<g data-marker="${escapeHtml(`${marker.segment}/${marker.end}/${marker.kind}`)}"><line x1="${n2(sx)}" y1="${n2(sy)}" x2="${n2(ex)}" y2="${n2(ey)}" stroke="${ACCENT}" stroke-width="3.4" stroke-opacity="0.35" stroke-linecap="butt"${marker.kind === 'tape' ? ' stroke-dasharray="1.2 0.8"' : ''}/>` +
          `<text x="${n2((sx + ex) / 2 + uy * 5.6)}" y="${n2((sy + ey) / 2 - ux * 5.6)}" font-size="2.6" fill="${ACCENT}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(marker.text)}</text></g>`,
      );
    }
  }

  // connectors, at the free ends
  for (const t of board.termini) {
    const [cx, cy] = px(t.at);
    const dir = rad(t.angleDeg);
    const midX = cx + Math.cos(dir) * CONNECTOR_LENGTH * S * 0.5;
    const midY = cy + Math.sin(dir) * CONNECTOR_LENGTH * S * 0.5;
    const name = t.joined.length === 0 ? 'open end' : t.joined.map((j) => j.label).join(', ');
    out.push(
      `<g data-terminus="${escapeHtml(`${t.segment}/${t.end}`)}" transform="translate(${n2(midX)} ${n2(midY)}) rotate(${rotate(t.angleDeg)})">` +
        `<rect x="${n2(-CONNECTOR_LENGTH * S * 0.5)}" y="${n2(-CONNECTOR_WIDTH * S * 0.5)}" width="${n2(CONNECTOR_LENGTH * S)}" height="${n2(CONNECTOR_WIDTH * S)}" rx="1" fill="${t.joined.length === 0 ? 'none' : '#f3f3f3'}" stroke="${INK}" stroke-width="0.45"${t.joined.length === 0 ? ' stroke-dasharray="1.2 1"' : ''}/></g>`,
    );
    // the name sits under the glyph (the side with more page below), centred on it
    const sgn = Math.cos(dir) >= 0 ? 1 : -1;
    const down = 1;
    const nxp = -Math.sin(dir) * sgn;
    const nyp = Math.cos(dir) * sgn;
    // anchored at the glyph's outer end and reading back toward the run, so it stays on the board
    const outerX = cx + Math.cos(dir) * CONNECTOR_LENGTH * S;
    const outerY = cy + Math.sin(dir) * CONNECTOR_LENGTH * S;
    const moved = plan.terminus.get(`${t.segment}/${t.end}`) ?? { x: 0, y: 0 };
    const lx = outerX + nxp * (CONNECTOR_WIDTH * S * 0.5 + 3.4) + moved.x;
    const ly = outerY + nyp * (CONNECTOR_WIDTH * S * 0.5 + 3.4) + moved.y;
    const anchor = Math.cos(dir) > 0.3 ? 'end' : Math.cos(dir) < -0.3 ? 'start' : 'middle';
    const lines = t.joined.length === 0 ? [name] : t.joined.flatMap((j) => [j.label, clip(j.def, 38)]);
    if (compact) {
      out.push(text(lx, ly + 1, 3, t.joined.length === 0 ? 'open' : t.joined.map((j) => j.label).join(', '), ` text-anchor="${anchor}" font-weight="bold" data-caption="${escapeHtml(`terminus:${t.segment}/${t.end}`)}"`));
      continue;
    }
    lines.forEach((line, i) => {
      const head = i % 2 === 0 || t.joined.length === 0;
      out.push(text(lx, ly + 1 + i * 3.3 * down, head ? 3 : 2.5, line, ` text-anchor="${anchor}"${head ? ' font-weight="bold"' : ''} data-caption="${escapeHtml(`terminus:${t.segment}/${t.end}`)}"`));
    });
  }

  // pegs, on top
  for (const peg of board.pegs) {
    const [cx, cy] = px(peg.at);
    const label = plan.peg.get(peg.id) ?? { x: cx + 2.6, y: cy - 2.6, anchor: 'start' as const };
    out.push(
      `<g data-peg="${peg.id}"><circle cx="${n2(cx)}" cy="${n2(cy)}" r="2" fill="#ffffff" stroke="${INK}" stroke-width="0.5"/>` +
        `<line x1="${n2(cx - 3.4)}" y1="${n2(cy)}" x2="${n2(cx + 3.4)}" y2="${n2(cy)}" stroke="${INK}" stroke-width="0.25"/><line x1="${n2(cx)}" y1="${n2(cy - 3.4)}" x2="${n2(cx)}" y2="${n2(cy + 3.4)}" stroke="${INK}" stroke-width="0.25"/>` +
        `<text x="${n2(label.x)}" y="${n2(label.y)}" font-size="2.8" fill="${INK}" font-weight="bold"${label.anchor === 'start' ? '' : ` text-anchor="${label.anchor}"`}>${peg.id}</text></g>`,
    );
  }
  return out.join('');
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function svgOpen(width: number, height: number, page: number, pages: number, kind: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n2(width)} ${n2(height)}" width="${n2(width)}mm" height="${n2(height)}mm" data-formboard="${kind}" data-page="${page}" data-pages="${pages}" font-family="${FONT}">` +
    `<rect width="${n2(width)}" height="${n2(height)}" fill="#ffffff"/>`
  );
}

function footer(board: Formboard, layout: FormboardLayout, size: { width: number; height: number }, left: string, options: FormboardSheetOptions): string {
  const rev = options.revisionNumber === undefined ? '' : ` · rev ${options.revisionNumber}`;
  return (
    text(MARGIN, size.height - MARGIN + 3.5, 3, `${board.designId}${rev} · formboard · ${scaleText(layout.scale)} on ${layout.paper}`, ` fill="${MUTED}"`) +
    text(size.width - MARGIN, size.height - MARGIN + 3.5, 3, left, ` text-anchor="end" fill="${MUTED}"`)
  );
}

/** One tile at the chosen scale, with registration marks, a print-check bar and its neighbours named. `page` is 1-based. */
function tileSvg(board: Formboard, layout: FormboardLayout, page: number, options: FormboardSheetOptions): string {
  const size = FORMBOARD_PAPER[layout.paper];
  const col = (page - 1) % layout.cols;
  const row = Math.floor((page - 1) / layout.cols);
  const ox = col * layout.step.x;
  const oy = row * layout.step.y;
  const S = layout.scale;
  const frame: Frame = { x: (v) => MARGIN + PAD + v * S - ox, y: (v) => MARGIN + PAD + v * S - oy, scale: S, view: { x0: MARGIN, y0: MARGIN, x1: MARGIN + layout.content.width, y1: MARGIN + layout.content.height } };
  const compact = S < 0.3;
  const out = [svgOpen(size.width, size.height, page, layout.tiles, 'tile')];
  out.push(`<clipPath id="tile-clip"><rect x="${MARGIN}" y="${MARGIN}" width="${n2(layout.content.width)}" height="${n2(layout.content.height)}"/></clipPath>`);
  out.push(`<g clip-path="url(#tile-clip)">${drawBoard(board, frame, compact)}</g>`);
  out.push(`<rect x="${MARGIN}" y="${MARGIN}" width="${n2(layout.content.width)}" height="${n2(layout.content.height)}" fill="none" stroke="${MUTED}" stroke-width="0.15" stroke-dasharray="0.8 0.8"/>`);
  // registration marks at the cell corners: a neighbour's marks sit on the same board coordinates
  const marks: [number, number, number, number][] = [
    [0, 0, col * layout.step.x, row * layout.step.y],
    [1, 0, (col + 1) * layout.step.x, row * layout.step.y],
    [0, 1, col * layout.step.x, (row + 1) * layout.step.y],
    [1, 1, (col + 1) * layout.step.x, (row + 1) * layout.step.y],
  ];
  for (const [mx, my, gx, gy] of marks) {
    const x = MARGIN + mx * layout.step.x;
    const y = MARGIN + my * layout.step.y;
    out.push(
      `<g data-registration="${mx}${my}" stroke="${INK}" stroke-width="0.25" fill="none"><circle cx="${n2(x)}" cy="${n2(y)}" r="2.2"/>` +
        `<line x1="${n2(x - 5)}" y1="${n2(y)}" x2="${n2(x + 5)}" y2="${n2(y)}"/><line x1="${n2(x)}" y1="${n2(y - 5)}" x2="${n2(x)}" y2="${n2(y + 5)}"/></g>`,
    );
    out.push(text(x + (mx === 0 ? 3 : -3), y + (my === 0 ? 6.5 : -3.5), 2.4, `${n2((gx - PAD) / S)}, ${n2((gy - PAD) / S)}`, ` text-anchor="${mx === 0 ? 'start' : 'end'}" fill="${MUTED}"`));
  }
  // print check: a bar that must measure 100 mm on paper whatever the scale
  const by = size.height - 4.5;
  out.push(
    `<g data-print-check="100" stroke="${INK}" stroke-width="0.3"><line x1="${MARGIN}" y1="${n2(by)}" x2="${MARGIN + 100}" y2="${n2(by)}"/>` +
      `<line x1="${MARGIN}" y1="${n2(by - 1.4)}" x2="${MARGIN}" y2="${n2(by + 1.4)}"/><line x1="${MARGIN + 100}" y1="${n2(by - 1.4)}" x2="${MARGIN + 100}" y2="${n2(by + 1.4)}"/></g>`,
  );
  out.push(text(MARGIN + 103, by + 0.9, 2.4, 'print check: this bar must measure 100 mm', ` fill="${MUTED}"`));
  const joins = [
    col > 0 ? `left p${page - 1}` : '',
    col < layout.cols - 1 ? `right p${page + 1}` : '',
    row > 0 ? `up p${page - layout.cols}` : '',
    row < layout.rows - 1 ? `down p${page + layout.cols}` : '',
  ].filter((j) => j !== '');
  out.push(footer(board, layout, size, `page ${page} of ${layout.tiles} (column ${col + 1}, row ${row + 1})${joins.length === 0 ? '' : ` · joins ${joins.join(', ')}`}`, options));
  out.push('</svg>');
  return out.join('');
}

function overviewSvg(board: Formboard, layout: FormboardLayout, options: FormboardSheetOptions): string {
  const size = FORMBOARD_PAPER[layout.paper];
  const out = [svgOpen(size.width, size.height, 0, layout.tiles, 'overview')];
  const tableRows = Math.max(board.runs.length, Math.ceil(board.pegs.length / 2), 1);
  const notes = board.notes;
  const tableHeight = Math.min(66, 9 + (tableRows + 1) * 3.5 + notes.length * 3.2);
  const area = { x: MARGIN, y: MARGIN + 7, width: size.width - 2 * MARGIN, height: size.height - 2 * MARGIN - FOOTER - tableHeight - 7 };
  const fit = Math.min((area.width - 2 * PAD) / board.width, (area.height - 2 * PAD) / board.height);
  const frame: Frame = { x: (v) => area.x + PAD + v * fit, y: (v) => area.y + PAD + v * fit, scale: fit, view: { x0: area.x, y0: area.y, x1: area.x + area.width, y1: area.y + area.height } };
  out.push(text(MARGIN, MARGIN + 3.5, 4.2, board.title, ' font-weight="bold"'));
  out.push(
    text(size.width - MARGIN, MARGIN + 3.5, 3, `overview, fitted ${scaleText(fit)} · tiles at ${scaleText(layout.scale)}: ${layout.tiles} page${layout.tiles === 1 ? '' : 's'} (${layout.cols} × ${layout.rows})`, ` text-anchor="end" fill="${MUTED}"`),
  );
  out.push(`<rect x="${n2(area.x + PAD)}" y="${n2(area.y + PAD)}" width="${n2(board.width * fit)}" height="${n2(board.height * fit)}" fill="none" stroke="${MUTED}" stroke-width="0.2"/>`);
  out.push(drawBoard(board, frame, true));
  // the tile map: each page's cell on the fitted board
  if (layout.tiles > 1) {
    for (let page = 1; page <= layout.tiles; page += 1) {
      const col = (page - 1) % layout.cols;
      const row = Math.floor((page - 1) / layout.cols);
      // a tile's cell in board millimetres, clipped to the board (the padding is paper, not board)
      const bx0 = Math.max(0, (col * layout.step.x - PAD) / layout.scale);
      const by0 = Math.max(0, (row * layout.step.y - PAD) / layout.scale);
      const bx1 = Math.min(board.width, ((col + 1) * layout.step.x + TILE_OVERLAP_MM - PAD) / layout.scale);
      const by1 = Math.min(board.height, ((row + 1) * layout.step.y + TILE_OVERLAP_MM - PAD) / layout.scale);
      const x = area.x + PAD + bx0 * fit;
      const y = area.y + PAD + by0 * fit;
      const w = (bx1 - bx0) * fit;
      const h = (by1 - by0) * fit;
      out.push(`<g data-tile="${page}"><rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="none" stroke="${ACCENT}" stroke-width="0.2" stroke-dasharray="2 1.2"/>${text(x + 1.4, y + 3.6, 3.4, `p${page}`, ` fill="${ACCENT}" font-weight="bold"`)}</g>`);
    }
  }
  // tables: runs on the left, pegs on the right
  const top = area.y + area.height + 6;
  const half = (size.width - 2 * MARGIN) / 2;
  out.push(text(MARGIN, top, 3, 'Run · stock · length · angle', ' font-weight="bold"'));
  const maxRows = Math.floor((tableHeight - 9 - notes.length * 3.2) / 3.5);
  board.runs.slice(0, Math.max(1, maxRows)).forEach((run, i) => {
    const branch = run.branchDeg === undefined ? '' : ` · ${run.branchDeg >= 0 ? '+' : '−'}${n2(Math.abs(run.branchDeg))}° from ${run.parent}`;
    out.push(text(MARGIN, top + 3.5 * (i + 1), 2.7, `${run.designation} ${run.segment} · ${run.stock} · ${run.lengthKnown ? '' : '~'}${n2(run.lengthMm)} mm${branch}`));
  });
  out.push(text(MARGIN + half, top, 3, 'Pegs (mm from the board corner)', ' font-weight="bold"'));
  const perColumn = Math.max(1, maxRows);
  board.pegs.forEach((peg, i) => {
    const column = Math.floor(i / perColumn);
    const columns = Math.ceil(board.pegs.length / perColumn);
    if (column > 1) return;
    out.push(text(MARGIN + half + (column * half) / Math.max(columns, 2), top + 3.5 * ((i % perColumn) + 1), 2.7, `${peg.id}  ${n2(peg.at.x)}, ${n2(peg.at.y)}  ${peg.note}`));
  });
  const noteTop = top + 3.5 * (Math.min(tableRows, Math.max(1, maxRows)) + 1) + 2;
  notes.forEach((note, i) => out.push(text(MARGIN, noteTop + i * 3.2, 2.7, note, ` fill="${MUTED}"`)));
  out.push(footer(board, layout, size, 'glyphs (connector, mould, sleeve) are symbols, not to scale; lengths are true', options));
  out.push('</svg>');
  return out.join('');
}

/** Pages in a formboard document: the overview plus the tiles. */
export function formboardPageCount(board: Formboard, options: FormboardSheetOptions = {}): number {
  return 1 + formboardLayout(board, options).tiles;
}

/**
 * One page as SVG, in paper millimetres. Page 0 is the overview (the whole
 * board fitted to one sheet, tables, tile map); pages 1..N are the tiles at
 * the chosen scale. A page out of range is the nearest one.
 */
export function formboardSvg(board: Formboard, page: number, options: FormboardSheetOptions = {}): string {
  const layout = formboardLayout(board, options);
  const at = Math.min(Math.max(0, Math.floor(page)), layout.tiles);
  return at === 0 ? overviewSvg(board, layout, options) : tileSvg(board, layout, at, options);
}

/** Every page, in order: the overview then the tiles. */
export function formboardSvgPages(board: Formboard, options: FormboardSheetOptions = {}): string[] {
  const layout = formboardLayout(board, options);
  return Array.from({ length: layout.tiles + 1 }, (_, page) => (page === 0 ? overviewSvg(board, layout, options) : tileSvg(board, layout, page, options)));
}

/** A self-contained HTML document: one page per sheet, page-broken, sized to the paper. */
export function formboardHtml(board: Formboard, options: FormboardSheetOptions = {}): string {
  const layout = formboardLayout(board, options);
  const size = FORMBOARD_PAPER[layout.paper];
  const pages = formboardSvgPages(board, options)
    .map((svg) => `<section class="cs-formboard-page">${svg}</section>`)
    .join('\n');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(board.title)} — formboard</title>` +
    `<style>@page{size:${size.width}mm ${size.height}mm;margin:0}html,body{margin:0;background:#e9e9e9}` +
    `.cs-formboard-page{width:${size.width}mm;height:${size.height}mm;margin:0 auto 6mm;background:#fff;page-break-after:always;break-after:page;overflow:hidden}` +
    `.cs-formboard-page svg{display:block;width:${size.width}mm;height:${size.height}mm}` +
    `@media print{html,body{background:#fff}.cs-formboard-page{margin:0}}</style></head><body>\n${pages}\n</body></html>`
  );
}
