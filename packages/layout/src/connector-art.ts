/**
 * Connector artwork: a connector drawn as itself, from its definition (spec:
 * ui-redesign, Canvas v2 item 5) — the one home of this geometry.
 * The canvas (`editor-react/src/connector-art.ts`,
 * re-exported through `@wirehub/render-svg`) and the SVG schematic
 * (`layout.ts`, drawn by `render-svg`) both read it from here; the drawing
 * sheets' solder-side faces (`docs/src/drawing/drawn-faces.ts`) restate it
 * and are held to it by `docs/test/drawing-faces.test.ts`.
 *
 * Pure geometry — no React, no DOM. `connectorArt` turns a definition into
 * the shapes a renderer paints and the point every pin sits on, in art
 * units (the canvas's CSS pixels). Nothing is placed per instance: two
 * DB-23s draw identically, and a new definition of a known family draws with
 * no code.
 *
 * Two kinds of drawing:
 *
 *  - **mating face** (D-Sub, HD15, mini-DIN, DIN, and any a catalog pack
 *    draws as data — `registerConnectorArt`): the face the shop sees when it plugs the part in, long
 *    axis vertical, a handle on every drawn pin;
 *  - **side profile** (RCA, 3.5 mm TRS, BNC): strain relief, grip, the
 *    business end — with the solder lugs at the cable end carrying the
 *    handles, on the side the wire is (`facing`).
 *
 * Unknown families, and definitions whose pins a family's drawing has no
 * place for, return `undefined`: the node keeps its pin list.
 *
 * Where a drawing is **approximate** (pin positions from the family's
 * general shape rather than a mechanical drawing) the builder says so in a
 * comment and the art carries `approximate: true` (shown in the tooltip).
 */

import type { ConnectorArtRecord } from '@wirehub/catalog';
import type { ConnectorBody, ConnectorDefinition } from '@wirehub/model';

/** The side a drawing's wire leaves toward (the canvas's board-art `Facing`). */
export type Facing = 'left' | 'right';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** A paint role: the canvas maps each to theme tokens (`editor.css`), the schematic to print paint. */
export type ArtTone =
  | 'flange'
  | 'shell'
  | 'insert'
  | 'hole'
  | 'metal'
  | 'boot'
  | 'grip'
  | 'knurl'
  | 'band'
  | 'copper'
  | 'dark'
  | 'key';

export type ArtShape =
  | { el: 'path'; d: string; tone: ArtTone }
  | { el: 'circle'; cx: number; cy: number; r: number; tone: ArtTone }
  | {
      el: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
      tone: ArtTone;
      /** `band`: painted the colour of this terminal's conductor, when known */
      band?: string;
    };

/**
 * How a pin is drawn: a round male pin, a female socket, a flat blade, a card
 * finger, a solder lug at the cable end, or a contact on the metal shell.
 */
export type PinForm = 'pin' | 'socket' | 'blade' | 'finger' | 'lug' | 'shell';

export interface ConnectorPinArt {
  /** the definition's pin id */
  terminal: string;
  form: PinForm;
  /** centre, art coordinates — where the handle sits */
  x: number;
  y: number;
  /** radius (pin, socket, lug) */
  r?: number;
  /** size (blade, finger) */
  width?: number;
  height?: number;
}

export interface ArtLabel {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}

export type ArtView = 'face' | 'profile';

export interface ConnectorArt {
  defId: string;
  view: ArtView;
  /** a short name for captions (`DB-23`, `SCART`, `RCA`) */
  short: string;
  width: number;
  height: number;
  shapes: ArtShape[];
  pins: ConnectorPinArt[];
  labels: ArtLabel[];
  /** profiles: the side the lugs (and so the wire) are on */
  facing?: Facing;
  /** pin positions follow the family's general shape, not a drawing */
  approximate: boolean;
}

export interface ConnectorArtInput {
  def: ConnectorDefinition;
  /** the side the node's edges leave toward (profiles put their lugs there) */
  facing: Facing;
  /**
   * The physical body the connector is built on (data model v2 §1.2). Given
   * one, the drawing is the **body's** — its `drawing`, or its family, id and
   * label — so every pinout on one body draws the same and a new pinout on a
   * known body draws with no upload. The connector only
   * relabels the pins.
   */
  body?: ConnectorBody;
}

/** The built-in drawings a body can name as its `drawing`. */
export const BODY_DRAWINGS = [
  'din-270',
  'din-262',
  'mini-din',
  'd-sub',
  'hd15',
  'rca',
  'trs',
  'bnc',
] as const;

export type BodyDrawing = (typeof BODY_DRAWINGS)[number];

/** Family words or vocab ids, as the switch below reads them. */
function normalFamily(family: string): string {
  const f = family.trim().toLowerCase();
  if (f === 'trs-3-5mm' || f === '3.5 mm trs' || f === '3.5mm' || f === 'trs') return 'trs';
  if (f === 'hd15 (de-15)' || f === 'de-15' || f === 'hd15') return 'hd15';
  return f;
}

/** The drawing a body is, from its own `drawing` or from its family, id and label. */
export function bodyDrawing(body: Pick<ConnectorBody, 'id' | 'label' | 'family'> & { drawing?: string }): BodyDrawing | undefined {
  if (body.drawing !== undefined && (BODY_DRAWINGS as readonly string[]).includes(body.drawing)) return body.drawing as BodyDrawing;
  const family = normalFamily(body.family);
  const id = body.id.toLowerCase();
  switch (family) {
    case 'din':
      return /270/.test(body.label) || /270/.test(id) ? 'din-270' : 'din-262';
    case 'mini-din':
    case 'd-sub':
    case 'hd15':
    case 'rca':
    case 'trs':
    case 'bnc':
      return family;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Drawings a catalog pack ships (specs/drawing-language.md §7)
 * ------------------------------------------------------------------ */

/**
 * The connector drawings registered by packs and modules, by record id. The
 * built-in drawings below are the base's own shapes; a registered record
 * draws the bodies, `drawing` names and families it names, and wins over a
 * built-in drawing of the same body. Registration is the host's job (the
 * studio does it from the module manifest at start); nothing registered means
 * the base alone, and a family nobody draws keeps its pin table.
 */
const registered = new Map<string, ConnectorArtRecord>();

/**
 * Register connector drawings (a pack's `art/connectors/*.json`); a record
 * with a known id replaces the earlier one. Returns the function that takes
 * these records out again — tests that must see the base alone use it.
 */
export function registerConnectorArt(records: readonly ConnectorArtRecord[]): () => void {
  for (const record of records) registered.set(record.id, record);
  return () => {
    for (const record of records) if (registered.get(record.id) === record) registered.delete(record.id);
  };
}

/** Every registered connector drawing, in registration order. */
export function registeredConnectorArt(): ConnectorArtRecord[] {
  return [...registered.values()];
}

/** The registered record that draws this connector: its body id, then its body's `drawing` name, then its family. */
function packArtFor(def: ConnectorDefinition, body: ConnectorBody | undefined): ConnectorArtRecord | undefined {
  if (registered.size === 0) return undefined;
  const records = [...registered.values()];
  const bodyIds = [body?.id, def.body].filter((id): id is string => id !== undefined);
  const family = normalFamily(body?.family ?? def.family ?? '');
  return (
    records.find((r) => bodyIds.some((id) => (r.bodies ?? []).includes(id))) ??
    (body?.drawing === undefined ? undefined : records.find((r) => (r.drawings ?? []).includes(body.drawing as string))) ??
    (family === '' ? undefined : records.find((r) => (r.families ?? []).includes(family)))
  );
}

/** A record as the art a renderer paints, or `undefined` when the connector has a pin it does not draw. */
function artOfRecord(def: ConnectorDefinition, record: ConnectorArtRecord): ConnectorArt | undefined {
  const has = new Set(def.pins.map((pin) => pin.id));
  const pins: ConnectorPinArt[] = record.pins
    .filter((pin) => pin.ifDefined !== true || has.has(pin.terminal))
    .map(({ ifDefined: _ifDefined, ...pin }) => pin);
  const drawn = new Set(pins.map((pin) => pin.terminal));
  if (!def.pins.every((pin) => drawn.has(pin.id))) return undefined;
  return {
    defId: def.id,
    view: 'face',
    short: record.short,
    width: record.width,
    height: record.height,
    shapes: record.shapes.map((shape) => ({ ...shape })),
    pins,
    labels: record.labels.map((item) => ({ ...item })),
    approximate: record.approximate,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const R = (value: number): number => Math.round(value * 100) / 100;

/** Outer margin around every drawing, so strokes are not clipped. */
const MARGIN = 4;

function polygon(points: readonly [number, number][], close = true): string {
  const [first, ...rest] = points;
  if (first === undefined) return '';
  return `M${R(first[0])} ${R(first[1])}${rest.map(([x, y]) => ` L${R(x)} ${R(y)}`).join('')}${close ? ' Z' : ''}`;
}

function circle(cx: number, cy: number, r: number, tone: ArtTone): ArtShape {
  return { el: 'circle', cx: R(cx), cy: R(cy), r: R(r), tone };
}

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  tone: ArtTone,
  rx?: number,
  band?: string,
): ArtShape {
  return {
    el: 'rect',
    x: R(x),
    y: R(y),
    width: R(width),
    height: R(height),
    tone,
    ...(rx === undefined ? {} : { rx: R(rx) }),
    ...(band === undefined ? {} : { band }),
  };
}

function label(x: number, y: number, text: string, anchor: ArtLabel['anchor'] = 'middle'): ArtLabel {
  return { x: R(x), y: R(y), text, anchor };
}

function pinIds(def: ConnectorDefinition): string[] {
  return def.pins.map((pin) => pin.id);
}

/** Every pin id is one of `allowed` — otherwise the drawing has no place for one. */
function coversAll(def: ConnectorDefinition, allowed: ReadonlySet<string>): boolean {
  return def.pins.every((pin) => allowed.has(pin.id));
}

/** Pins 1..n, each exactly once, plus any of `extra`. */
function numbered(def: ConnectorDefinition, n: number, extra: readonly string[] = []): boolean {
  const ids = pinIds(def);
  const allowed = new Set([...Array.from({ length: n }, (_, i) => String(i + 1)), ...extra]);
  return coversAll(def, allowed) && new Set(ids).size === ids.length;
}

const isMale = (def: ConnectorDefinition): boolean => def.gender !== 'female';

/* ------------------------------------------------------------------ *
 * A face, laid out in its front view and turned
 * ------------------------------------------------------------------ */

/**
 * A mating face is laid out in its **front view** (u along the long axis,
 * left → right; v across it, top → bottom — the view a datasheet draws) and
 * turned a quarter clockwise so the long axis runs down the canvas: the front
 * view's top row becomes the right-hand column, its left end the top.
 */
class Face {
  readonly shapes: ArtShape[] = [];
  readonly pins: ConnectorPinArt[] = [];
  readonly labels: ArtLabel[] = [];
  readonly width: number;
  readonly height: number;
  /** pixels per mm */
  readonly k: number;
  private readonly cx: number;
  private readonly cy: number;

  /**
   * @param long the front view's long axis, mm
   * @param across the front view's short axis, mm
   * @param k pixels per mm
   */
  // (no parameter properties: layout also runs under Node's type stripping)
  constructor(long: number, across: number, k: number) {
    this.k = k;
    this.width = Math.ceil(across * k + MARGIN * 2);
    this.height = Math.ceil(long * k + MARGIN * 2);
    this.cx = this.width / 2;
    this.cy = this.height / 2;
  }

  /** front-view mm → art pixels */
  at(u: number, v: number): [number, number] {
    return [this.cx - v * this.k, this.cy + u * this.k];
  }

  poly(points: readonly [number, number][], tone: ArtTone): void {
    this.shapes.push({ el: 'path', d: polygon(points.map(([u, v]) => this.at(u, v))), tone });
  }

  /** a rectangle given in front-view mm (u0..u1 × v0..v1) */
  box(u0: number, v0: number, u1: number, v1: number, tone: ArtTone, radius = 0): void {
    const [xa, ya] = this.at(u0, v0);
    const [xb, yb] = this.at(u1, v1);
    this.shapes.push(
      rect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya), tone, radius * this.k || undefined),
    );
  }

  ring(u: number, v: number, r: number, tone: ArtTone): void {
    const [x, y] = this.at(u, v);
    this.shapes.push(circle(x, y, r * this.k, tone));
  }

  pin(terminal: string, u: number, v: number, form: PinForm, size: { r?: number; w?: number; h?: number }): void {
    const [x, y] = this.at(u, v);
    // a blade or finger given as (along u, along v) turns with the face
    this.pins.push({
      terminal,
      form,
      x: R(x),
      y: R(y),
      ...(size.r === undefined ? {} : { r: R(size.r * this.k) }),
      ...(size.w === undefined ? {} : { width: R((size.h ?? 0) * this.k), height: R(size.w * this.k) }),
    });
  }

  /** a pin number; dropped when it would sit on top of one already placed */
  text(u: number, v: number, text: string): void {
    const [x, y] = this.at(u, v);
    const width = text.length * 4.6;
    const clash = this.labels.some(
      (other) => Math.abs(other.x - x) < (width + other.text.length * 4.6) / 2 + 1 && Math.abs(other.y - (y + 3)) < 8,
    );
    if (!clash) this.labels.push(label(x, y + 3, text));
  }

  art(def: ConnectorDefinition, short: string, approximate: boolean): ConnectorArt {
    return {
      defId: def.id,
      view: 'face',
      short,
      width: this.width,
      height: this.height,
      shapes: this.shapes,
      pins: this.pins,
      labels: this.labels,
      approximate,
    };
  }
}

/* ------------------------------------------------------------------ *
 * D-Sub (DE-9, DA-15, DB-23, DB-25, DC-37) and HD15
 * ------------------------------------------------------------------ */

export interface DsubShell {
  /** pins per row, top row first */
  rows: number[];
  /** u offset of each row, in pitches (HD15's middle row sits half a pitch left) */
  shift?: number[];
  pitch: number;
  rowGap: number;
  /** flange: long side, short side, mounting-hole spacing (mm) */
  flange: number;
  flangeAcross: number;
  holes: number;
}

/**
 * Standard shells (IEC 60807-2 / -3): pitch 2.77 × 2.84 mm; high-density
 * 2.29 × 1.98 mm. The DB-23 is a non-standard shell between A and B —
 * its flange and hole spacing are approximate.
 *
 * Checked against published references and left unchanged: no connector
 * reference we found covers the DB-23 at all, and no Wikimedia Commons
 * file gives its shell's mechanical dimensions — Commons' D-subminiature
 * category has only the standard DE-9/DE-15/DSubminiatures reference
 * drawings, which confirm this file's general row-numbering convention
 * (long row 1..n left→right, short row n+1..total) but say nothing about a
 * non-standard 23-pin shell's flange or mounting-hole spacing. The generic
 * D-Sub row/column numbering below (shared by DE-9 through DC-37) is not in
 * question; only the DB-23 shell's own dimensions remain approximate.
 */
export const DSUB_SHELLS: Readonly<Record<string, DsubShell>> = {
  '9': { rows: [5, 4], pitch: 2.77, rowGap: 2.84, flange: 30.81, flangeAcross: 12.5, holes: 24.99 },
  '15': { rows: [8, 7], pitch: 2.77, rowGap: 2.84, flange: 39.14, flangeAcross: 12.5, holes: 33.32 },
  '23': { rows: [12, 11], pitch: 2.77, rowGap: 2.84, flange: 50.0, flangeAcross: 12.5, holes: 44.2 },
  '25': { rows: [13, 12], pitch: 2.77, rowGap: 2.84, flange: 53.04, flangeAcross: 12.5, holes: 47.04 },
  '37': { rows: [19, 18], pitch: 2.77, rowGap: 2.84, flange: 69.32, flangeAcross: 12.5, holes: 63.5 },
  hd15: {
    rows: [5, 5, 5],
    shift: [0, -0.5, 0],
    pitch: 2.29,
    rowGap: 1.98,
    flange: 30.81,
    flangeAcross: 12.5,
    holes: 24.99,
  },
};

const DSUB_K = 3.8;

function dsub(def: ConnectorDefinition, highDensity: boolean, positions?: number): ConnectorArt | undefined {
  // the metal shell is an optional 25th/24th/16th/etc.
  // pin, not one of the numbered mating contacts — excluded from the count
  // the shell-size lookup and the row math key off. With a body, the shell
  // size is the body's: a pinout that leaves positions unassigned still
  // draws on the full shell
  const count = positions ?? def.pins.filter((pin) => /^\d+$/.test(pin.id)).length;
  const shell = highDensity ? DSUB_SHELLS['hd15'] : DSUB_SHELLS[String(count)];
  if (shell === undefined) return undefined;
  const total = shell.rows.reduce((sum, n) => sum + n, 0);
  if (total !== count || !numbered(def, total, ['shell'])) return undefined;

  const face = new Face(shell.flange + 1, shell.flangeAcross + 1, DSUB_K);
  const male = isMale(def);
  const rowCount = shell.rows.length;
  const vOf = (row: number): number => (row - (rowCount - 1) / 2) * shell.rowGap;
  const uOf = (row: number, index: number): number => {
    const n = shell.rows[row] ?? 0;
    const u = (index - (n - 1) / 2 + (shell.shift?.[row] ?? 0)) * shell.pitch;
    // a socket face is the pin face mirrored: pin 1 on the right
    return male ? u : -u;
  };

  // the D: long side on the top row, 10° draft, corners eased
  let reach = 0;
  shell.rows.forEach((_, row) => {
    const n = shell.rows[row] ?? 0;
    for (const index of [0, n - 1]) reach = Math.max(reach, Math.abs(uOf(row, index)));
  });
  const halfTop = reach + (highDensity ? 2.3 : 2.6);
  const halfAcross = vOf(rowCount - 1) + (highDensity ? 2.0 : 2.3);
  const draft = Math.tan((10 * Math.PI) / 180) * halfAcross * 2;
  const halfBottom = halfTop - draft;

  face.box(-shell.flange / 2, -shell.flangeAcross / 2, shell.flange / 2, shell.flangeAcross / 2, 'flange', 1.2);
  for (const side of [-1, 1]) {
    face.ring((side * shell.holes) / 2, 0, 2.2, 'metal');
    face.ring((side * shell.holes) / 2, 0, 1.55, 'hole');
  }
  // the shell contact: the same metal boss as one of the
  // two mounting-hole rings just drawn — the shell's own jackscrew/ground boss
  if (def.pins.some((pin) => pin.id === 'shell')) {
    face.pin('shell', shell.holes / 2, 0, 'shell', {});
  }
  face.poly(
    [
      [-halfTop, -halfAcross],
      [halfTop, -halfAcross],
      [halfBottom, halfAcross],
      [-halfBottom, halfAcross],
    ],
    'shell',
  );
  const inset = 0.75;
  face.poly(
    [
      [-halfTop + inset, -halfAcross + inset],
      [halfTop - inset, -halfAcross + inset],
      [halfBottom - inset * 0.8, halfAcross - inset],
      [-halfBottom + inset * 0.8, halfAcross - inset],
    ],
    'insert',
  );

  let next = 1;
  const radius = shell.pitch * 0.3;
  shell.rows.forEach((n, row) => {
    const first = next;
    for (let index = 0; index < n; index += 1) {
      face.pin(String(next), uOf(row, index), vOf(row), male ? 'pin' : 'socket', { r: radius });
      next += 1;
    }
    // the first pin of each row is numbered, just outside the D at its end
    const u = uOf(row, 0);
    face.text(Math.sign(u || -1) * (halfTop + 1.25), vOf(row), String(first));
  });

  const short = highDensity ? 'HD15' : `D-${count}`;
  return face.art(def, def.label.startsWith('DB-') ? `DB-${count}` : short, def.id === 'db23-male');
}

/* ------------------------------------------------------------------ *
 * Round: mini-DIN and DIN
 * ------------------------------------------------------------------ */

interface RoundSpec {
  /** metal skirt diameter, mm */
  skirt: number;
  /** insert diameter, mm */
  insert: number;
  k: number;
  pinR: number;
  /** pin positions in the front view of the **socket** (mm, y down) */
  pins: Record<string, [number, number]>;
  /** where the shell contacts sit on the skirt: angle from 12 o'clock, clockwise */
  shells: Record<string, number>;
  key: 'mini' | 'din';
  short: string;
  /**
   * pin positions/order confirmed against a mechanical reference rather than
   * just this file's own numbering convention — defaults to `true`
   * (approximate) when not given.
   */
  approximate?: boolean;
}

function round(def: ConnectorDefinition, spec: RoundSpec): ConnectorArt | undefined {
  const allowed = new Set([...Object.keys(spec.pins), ...Object.keys(spec.shells)]);
  if (!coversAll(def, allowed)) return undefined;
  const size = Math.ceil(spec.skirt * spec.k + MARGIN * 2);
  const c = size / 2;
  const k = spec.k;
  const shapes: ArtShape[] = [];
  const pins: ConnectorPinArt[] = [];
  const labels: ArtLabel[] = [];
  const male = isMale(def);

  shapes.push(circle(c, c, (spec.skirt / 2) * k, 'shell'));
  shapes.push(circle(c, c, (spec.insert / 2) * k, 'insert'));
  if (spec.key === 'mini') {
    // the skirt's keyway at the bottom, the insert's square key above it
    shapes.push(rect(c - 0.9 * k, c + (spec.skirt / 2 - 1.1) * k, 1.8 * k, 1.2 * k, 'dark', 0.3 * k));
    shapes.push(rect(c - 0.8 * k, c + (spec.insert / 2 - 1.9) * k, 1.6 * k, 1.3 * k, 'key', 0.2 * k));
    for (const side of [-1, 1]) {
      shapes.push(rect(c + side * (spec.skirt / 2 - 0.5) * k - 0.5 * k, c - 0.6 * k, 1 * k, 1.2 * k, 'dark', 0.2 * k));
    }
  } else {
    // the DIN skirt's key groove at 12 o'clock
    shapes.push(rect(c - 0.9 * k, c - (spec.skirt / 2) * k - 0.5, 1.8 * k, 2.0 * k, 'dark', 0.3 * k));
  }

  for (const pin of def.pins) {
    const at = spec.pins[pin.id];
    if (at !== undefined) {
      // a plug's face is its socket's mirrored
      const x = c + (male ? -at[0] : at[0]) * k;
      const y = c + at[1] * k;
      pins.push({ terminal: pin.id, form: male ? 'pin' : 'socket', x: R(x), y: R(y), r: R(spec.pinR * k) });
      continue;
    }
    const angle = spec.shells[pin.id];
    if (angle === undefined) continue;
    const a = (angle * Math.PI) / 180;
    const r = (spec.skirt / 2) * k;
    pins.push({ terminal: pin.id, form: 'shell', x: R(c + Math.sin(a) * r), y: R(c - Math.cos(a) * r) });
  }
  // pin 1 numbered just outside itself, away from the centre
  const one = pins.find((pin) => pin.terminal === '1');
  if (one !== undefined) {
    const dx = one.x - c;
    const dy = one.y - c;
    const length = Math.hypot(dx, dy) || 1;
    const reach = spec.pinR * k + 5;
    labels.push(label(one.x + (dx / length) * reach, one.y + (dy / length) * reach + 3, '1'));
  }

  return {
    defId: def.id,
    view: 'face',
    short: spec.short,
    width: size,
    height: size,
    shapes,
    pins,
    labels,
    approximate: spec.approximate ?? true,
  };
}

/**
 * Mini-DIN 9 pin positions, socket front view (mm): **2 top / 4 middle / 3
 * bottom**, not the family's usual 3/3/3 — corrected from the owner's
 * description of the real the source device 2 socket:
 * "the middle row is 4 pins, then a row of 3 pins on the other side of the
 * PCB, two pins up high that we hit with 5V directly and then blue from the
 * pad on the PCB." That names the top row (5 V + Blue) as pins 2 and 1 —
 * `minidin9`'s own def (packages/catalog/data/connectors.json, citing
 * public pinout references): 1=Blue, 2=+5V, 3=Green, 4=CVBS,
 * 5=CSync, 6=mono audio, 7=Red, 8=Audio L, 9=Audio R — so rows are {1,2} top,
 * {3,4,5,6} middle, {7,8,9} bottom, sequential.
 *
 * The "other side of the PCB" claim is independently confirmed by the actual
 * production board: packages/catalog/depictions/PCA-00114-rev2/meta.json
 * `pinAnchors` (from the real PCA-00114 Rev2 the source device 2 KiCad footprint) has
 * pins 7/8/9 (`j.7`/`j.8`/`j.9`) landing on copper `side: "top"` while pins
 * 1/3/4/5 (`j.1`/`j.3`/`j.4`/`j.5`) land on `side: "bottom"` — the bottom
 * three pins really do solder to the opposite face from the rest. Pin 2
 * (+5 V) and pin 6 (mono audio, unused on this stereo build) have no board
 * pad at all, matching "we hit [5 V] directly" (a flying wire, not a PCB
 * landing).
 *
 * **Left-to-right order within each row — settled** (* 2026-09-24), by two independent references, both cross-checked against
 * *this* array (a socket/female front view) after accounting for gender and
 * for each source's own choice of which end is drawn "up":
 *
 *  - Wikimedia's `MiniDIN-9_Connector_Pinout.svg`
 *    (https://commons.wikimedia.org/wiki/File:MiniDIN-9_Connector_Pinout.svg,
 *    captioned "Looking at female connector", numbered circles at explicit
 *    mm-scale coordinates): read directly (no gender flip needed — it is
 *    already a socket/female view) and turned 180° to match this file's
 *    "key at the bottom" mini-DIN drawing convention, it gives top row
 *    (far from the key) 1-2, middle 3-4-5-6, bottom row (near the key) 7-8-9,
 *    left-to-right in every row — exactly this array;
 *  - a published "DIN-Simplified-Male" diagram ("miniDIN 9" panel,
 *    key at the top, explicitly labelled "Male ends shown"): mirrored
 *    left-right to get the equivalent socket/female view, then turned 180°
 *    for the same "key at the bottom" convention, gives the identical
 *    1-2 / 3-4-5-6 / 7-8-9 left-to-right order.
 *
 * Both independent sources agree with what was already drawn here, so no
 * position changed — only the citation and the `approximate` flag (now
 * `false` for this family; see the `mini-din` case in `connectorArt`).
 */
const MINI_DIN_9: Record<string, [number, number]> = {
  '1': [-1.05, -2.3],
  '2': [1.05, -2.3],
  '3': [-3.0, -0.1],
  '4': [-1.0, -0.1],
  '5': [1.0, -0.1],
  '6': [3.0, -0.1],
  '7': [-2.1, 2.0],
  '8': [0, 2.0],
  '9': [2.1, 2.0],
};

/**
 * Mini-DIN 10 pin positions, socket front view (mm): **3 top / 4 middle / 3
 * bottom**, already sequential and already matching a real
 * socket — rechecked alongside the Mini-DIN 9 fix
 * and left as-is. Confirmed against the production
 * boards' own KiCad pad sides, the same way as Mini-DIN 9 above:
 * packages/catalog/depictions/PCA-00115-rev3/meta.json `pinAnchors` (PCA-00115
 * Rev3, the source device) has pins 1/2/3 (`j.1`/`j.2`/`j.3`, CSync/Audio L/Audio R)
 * landing on copper `side: "bottom"` while pins 4/5/6/7 (`j.4`.."j.7"`, +5V/
 * Red/Green/Blue) land on `side: "top"` — two distinct board faces, split
 * exactly at the 3/4 row boundary already drawn here.
 *
 * **Bottom row (8-10, CVBS/Luma/Chroma) and the exact left-to-right order —
 * settled** by a published device-specific reference, which the board pad
 * check above could not reach (no populated pad for those three on the
 * board variant it used): a "DIN-Simplified-Male" diagram ("miniDIN 10"
 * panel — cross-checked against a neighbouring "miniDIN 10" panel, which
 * shares the identical pin/position geometry and differs only in the
 * audio-channel signal wired to pins 2/3, not in this connector's own
 * numbering).
 * Male, key at the top, "Male ends shown": 8-9-10 top / 4-5-6-7 middle /
 * 1-2-3 bottom, each left-to-right. Mirrored to the socket/female view this
 * array uses, then turned 180° for this file's "key at the bottom" mini-DIN
 * convention, that gives 1-2-3 top / 4-5-6-7 middle / 8-9-10 bottom,
 * left-to-right — exactly what was already drawn here. No position changed;
 * only the citation and the `approximate` flag (now `false`; see the
 * `mini-din` case in `connectorArt`).
 */
const MINI_DIN_10: Record<string, [number, number]> = {
  '1': [-2.1, -2.3],
  '2': [0, -2.3],
  '3': [2.1, -2.3],
  '4': [-3.2, -0.1],
  '5': [-1.07, -0.1],
  '6': [1.07, -0.1],
  '7': [3.2, -0.1],
  '8': [-2.1, 2.0],
  '9': [0, 2.0],
  '10': [2.1, 2.0],
};

/**
 * DIN-8: seven pins on a 7 mm circle plus one in the centre — arc order
 * settled against a published "DIN-Simplified-Male" diagram, which draws
 * three DIN-8 variants — "DIN 8 'U' 262°" (`din8-262`) and two
 * "DIN 8 'C' 270°" panels (`din8-270`) — all three sharing the *same* pin
 * topology (only the gap/key size differs by name, not the order), so one
 * order array is right for both spans, as this file already assumed.
 *
 * The diagram is male, key at 12 o'clock, "Male ends shown": pixel-measured
 * positions read clockwise from the key, 7-3-5-2-4-1-6. This array is a
 * socket/female front view (`round()` mirrors it for a male def, same as the
 * D-Sub and mini-DIN tables above) and this file's `din` key sits at 12
 * o'clock too (`round`'s `key: 'din'` branch — no additional 180° turn
 * needed, unlike the mini-DIN tables' "key at the bottom" convention).
 * Mirroring the male reading left-right for the socket view gives, clockwise
 * from the key: 6-1-4-2-5-3-7 — equivalently, in this array's own
 * decreasing-angle (counterclockwise-from-the-key) index order: 7-3-5-2-4-1-6.
 * That replaces the previous 6-3-5-1-4-2-7 guess (an IEC 60130-9 interleave
 * that turned out not to match either DIN-8 shell this catalog actually
 * uses) and resolves the "numbering disputed between references" note the
 * connector records' own `src` fields still describe as unresolved at the
 * *signal* level (which pin carries which wire) — this fixes only the
 * *geometric* pin-number-to-position order the canvas draws.
 */
function dinPins(span: number): Record<string, [number, number]> {
  const order = ['7', '3', '5', '2', '4', '1', '6'];
  const out: Record<string, [number, number]> = { '8': [0, 0] };
  order.forEach((id, index) => {
    // from 12 o'clock, clockwise: the arc's gap is centred on the key
    const deg = 360 - (360 - span) / 2 - (index * span) / (order.length - 1);
    const a = (deg * Math.PI) / 180;
    out[id] = [Math.sin(a) * 3.5, -Math.cos(a) * 3.5];
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Console multi-outs
 * ------------------------------------------------------------------ */

interface RowFace {
  long: number;
  across: number;
  k: number;
  /** pin ids per row, left to right in the front view, top row first */
  rows: string[][];
  pitch: number;
  rowGap: number;
  /** a row sits this many pitches right of centred */
  shift?: number[];
  form: PinForm;
  outline: (face: Face, hl: number, ha: number) => void;
  short: string;
}

function rowFace(def: ConnectorDefinition, spec: RowFace): ConnectorArt | undefined {
  const ids = new Set(spec.rows.flat());
  if (!coversAll(def, ids)) return undefined;
  const face = new Face(spec.long + 1, spec.across + 1, spec.k);
  const hl = spec.long / 2;
  const ha = spec.across / 2;
  spec.outline(face, hl, ha);
  const n = spec.rows.length;
  spec.rows.forEach((row, index) => {
    const v = (index - (n - 1) / 2) * spec.rowGap;
    row.forEach((id, at) => {
      const u = (at - (row.length - 1) / 2 + (spec.shift?.[index] ?? 0)) * spec.pitch;
      const size =
        spec.form === 'finger'
          ? { w: spec.pitch * 0.55, h: spec.rowGap * 0.55 }
          : spec.form === 'blade'
            ? { w: spec.pitch * 0.5, h: spec.rowGap * 0.35 }
            : { r: spec.pitch * 0.28 };
      if (def.pins.some((pin) => pin.id === id)) face.pin(id, u, v, spec.form, size);
    });
    // each row numbered at both ends, beyond its end pins
    const first = row[0];
    const last = row[row.length - 1];
    const shift = spec.shift?.[index] ?? 0;
    const reach = (row.length - 1) / 2 + 0.95;
    if (first !== undefined) face.text((-reach + shift) * spec.pitch, v, first);
    if (last !== undefined && last !== first) face.text((reach + shift) * spec.pitch, v, last);
  });
  return face.art(def, spec.short, true);
}

const range = (from: number, to: number, step = 1): string[] => {
  const out: string[] = [];
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(String(n));
  return out;
};

/* ------------------------------------------------------------------ *
 * Side profiles: RCA, TRS, BNC
 * ------------------------------------------------------------------ */

/**
 * A profile laid out cable end on the left; mirrored when the wire is on the
 * right, so the lugs always face the wire.
 */
class Profile {
  readonly shapes: ArtShape[] = [];
  readonly pins: ConnectorPinArt[] = [];
  readonly labels: ArtLabel[] = [];
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  private readonly mirror: boolean;

  constructor(width: number, height: number, mirror: boolean) {
    this.width = width;
    this.height = height;
    this.mirror = mirror;
    this.cy = height / 2;
  }

  private x(x: number): number {
    return this.mirror ? this.width - x : x;
  }

  box(x: number, y: number, w: number, h: number, tone: ArtTone, rx?: number, band?: string): void {
    this.shapes.push(rect(this.mirror ? this.width - x - w : x, y, w, h, tone, rx, band));
  }

  poly(points: readonly [number, number][], tone: ArtTone, close = true): void {
    this.shapes.push({ el: 'path', d: polygon(points.map(([x, y]) => [this.x(x), y]), close), tone });
  }

  ring(x: number, y: number, r: number, tone: ArtTone): void {
    this.shapes.push(circle(this.x(x), y, r, tone));
  }

  /** a solder lug at the cable end: a tag with a cup, the handle on the cup */
  lug(terminal: string, y: number, tone: ArtTone): void {
    this.box(6, y - 1.1, 12, 2.2, tone, 0.6);
    this.pins.push({ terminal, form: 'lug', x: R(this.x(5)), y: R(y), r: 2.6 });
  }

  /** the strain relief (boot), tapering from the cable into the grip */
  boot(from: number, to: number, cable: number, grip: number): void {
    const cy = this.cy;
    this.poly(
      [
        [from, cy - cable],
        [to, cy - grip],
        [to, cy + grip],
        [from, cy + cable],
      ],
      'boot',
    );
    for (let x = from + 5; x < to - 2; x += 5) {
      const t = (x - from) / (to - from);
      const h = cable + (grip - cable) * t;
      this.poly(
        [
          [x, cy - h + 0.8],
          [x, cy + h - 0.8],
        ],
        'knurl',
        false,
      );
    }
  }

  /** the grip: knurled, with a colour band near its front */
  grip(from: number, to: number, half: number, band?: { at: number; width: number; terminal: string }): void {
    const cy = this.cy;
    this.box(from, cy - half, to - from, half * 2, 'grip', 3);
    const stop = band === undefined ? to - 4 : band.at - 3;
    for (let x = from + 5; x <= stop; x += 4.5) {
      this.poly(
        [
          [x, cy - half + 1],
          [x, cy + half - 1],
        ],
        'knurl',
        false,
      );
    }
    if (band !== undefined) this.box(band.at, cy - half, band.width, half * 2, 'band', undefined, band.terminal);
  }

  art(def: ConnectorDefinition, short: string, facing: Facing): ConnectorArt {
    return {
      defId: def.id,
      view: 'profile',
      short,
      width: this.width,
      height: this.height,
      shapes: this.shapes,
      pins: this.pins,
      labels: this.labels,
      facing,
      approximate: false,
    };
  }
}

function rca(def: ConnectorDefinition, facing: Facing): ConnectorArt | undefined {
  if (!coversAll(def, new Set(['tip', 'sleeve']))) return undefined;
  const p = new Profile(146, 30, facing === 'right');
  const cy = p.cy;
  if (def.pins.some((pin) => pin.id === 'tip')) p.lug('tip', cy - 4, 'copper');
  if (def.pins.some((pin) => pin.id === 'sleeve')) p.lug('sleeve', cy + 4.5, 'metal');
  p.boot(18, 38, 5, 8.5);
  p.grip(38, 90, 12, { at: 78, width: 8, terminal: 'tip' });
  // RCA (Wikipedia "RCA connector"): the plug is a
  // centre pin inside a split outer ring; the jack is a central hole in an
  // insulator, inside a plain metal ring "slightly smaller in diameter and
  // longer than the ring on the plug" — no bayonet lugs, no collar (BNC's)
  if (isMale(def)) {
    // the split outer sleeve and the centre pin standing proud of it
    p.box(90, cy - 8.5, 30, 17, 'metal', 1);
    for (const dy of [-3.6, 3.6]) p.box(102, cy + dy - 0.7, 18, 1.4, 'dark');
    p.box(120, cy - 1.7, 20, 3.4, 'copper', 1.7);
  } else {
    // drawn in section: the ground ring (a plain tube, narrower than the
    // plug's sleeve and longer), the insulator filling it, and the hollow
    // centre socket open at the front
    p.box(90, cy - 7.5, 46, 15, 'metal', 1);
    p.box(100, cy - 5.9, 36, 11.8, 'insert', 0.6);
    p.box(106, cy - 2.4, 30, 4.8, 'copper', 0.8);
    p.box(112, cy - 1.3, 24, 2.6, 'dark', 0.4);
  }
  return p.art(def, 'RCA', facing);
}

function trs(def: ConnectorDefinition, facing: Facing): ConnectorArt | undefined {
  if (!coversAll(def, new Set(['tip', 'ring', 'sleeve']))) return undefined;
  const p = new Profile(146, 28, facing === 'right');
  const cy = p.cy;
  const has = (id: string): boolean => def.pins.some((pin) => pin.id === id);
  if (has('tip')) p.lug('tip', cy - 6, 'copper');
  if (has('ring')) p.lug('ring', cy, 'copper');
  if (has('sleeve')) p.lug('sleeve', cy + 6, 'metal');
  p.boot(18, 36, 4.5, 8);
  p.grip(36, 80, 10.5, { at: 70, width: 6, terminal: has('tip') ? 'tip' : 'sleeve' });
  if (isMale(def)) {
    // the 3.5 mm shaft: sleeve, insulator, ring, insulator, tip
    const h = 3.6;
    p.box(80, cy - h, 32, h * 2, 'metal');
    p.box(112, cy - h, 3, h * 2, 'dark');
    p.box(115, cy - h, 9, h * 2, 'metal');
    p.box(124, cy - h, 3, h * 2, 'dark');
    p.poly(
      [
        [127, cy - h],
        [134, cy - h],
        [139, cy - 1.2],
        [139, cy + 1.2],
        [134, cy + h],
        [127, cy + h],
      ],
      'metal',
    );
  } else {
    // a jack (the female TRS is a socket, not a plug on a shaft): drawn in section like the
    // RCA female — the ground shell, the insulator
    // bushing, and the receptacle bore, narrowing toward the opening the
    // plug goes into, with no shaft standing proud
    p.box(80, cy - 9, 44, 18, 'metal', 1.5);
    p.box(104, cy - 7, 30, 14, 'insert', 1);
    p.box(118, cy - 3.4, 21, 6.8, 'dark', 1);
    p.ring(139, cy, 3, 'dark');
  }
  return p.art(def, '3.5 mm', facing);
}

function bnc(def: ConnectorDefinition, facing: Facing): ConnectorArt | undefined {
  if (!coversAll(def, new Set(['tip', 'shell']))) return undefined;
  const p = new Profile(146, 32, facing === 'right');
  const cy = p.cy;
  if (def.pins.some((pin) => pin.id === 'tip')) p.lug('tip', cy - 4, 'copper');
  if (def.pins.some((pin) => pin.id === 'shell')) p.lug('shell', cy + 4.5, 'metal');
  p.boot(18, 34, 5, 7);
  // crimp ferrule, body, the knurled bayonet nut with its slot, the front
  p.box(34, cy - 6.5, 14, 13, 'metal', 1);
  p.box(48, cy - 8.5, 14, 17, 'metal', 1);
  p.box(62, cy - 13, 34, 26, 'grip', 2.5);
  for (let x = 66; x <= 92; x += 4) {
    p.poly(
      [
        [x, cy - 12],
        [x, cy - 7],
      ],
      'knurl',
      false,
    );
    p.poly(
      [
        [x, cy + 7],
        [x, cy + 12],
      ],
      'knurl',
      false,
    );
  }
  p.poly(
    [
      [96, cy - 1.2],
      [80, cy - 1.2],
      [74, cy + 3.4],
    ],
    'dark',
    false,
  );
  p.box(96, cy - 8, 24, 16, 'metal', 1);
  p.box(106, cy - 4.5, 14, 9, 'insert', 1);
  p.box(110, cy - 1, 18, 2, 'copper', 1);
  return p.art(def, 'BNC', facing);
}

/* ------------------------------------------------------------------ *
 * By family
 * ------------------------------------------------------------------ */

/**
 * The artwork for a connector definition, or `undefined` when its family has
 * no drawing (or its pins do not fit the family's) — the node keeps its pin
 * list.
 */
/** How many numbered positions a body has — `undefined` without one. */
function numberedOf(body: ConnectorBody | undefined): number | undefined {
  return body === undefined ? undefined : body.positions.filter((p) => /^\d+$/.test(p.id)).length;
}

export function connectorArt(input: ConnectorArtInput): ConnectorArt | undefined {
  const { def, facing, body } = input;
  const fromPack = packArtFor(def, body);
  if (fromPack !== undefined) return artOfRecord(def, fromPack);
  const drawing =
    body !== undefined
      ? bodyDrawing(body)
      : bodyDrawing({ id: def.id, label: def.label, family: def.family ?? '' });
  switch (drawing) {
    case 'd-sub':
      return dsub(def, false, numberedOf(body));
    case 'hd15':
      return dsub(def, true, numberedOf(body));
    case 'mini-din': {
      const count = def.pins.filter((pin) => /^\d+$/.test(pin.id)).length;
      const positions = body === undefined ? count : body.positions.filter((p) => /^\d+$/.test(p.id)).length;
      const pins = positions === 9 ? MINI_DIN_9 : positions === 10 ? MINI_DIN_10 : undefined;
      if (pins === undefined) return undefined;
      return round(def, {
        skirt: 9.5,
        insert: 8.1,
        k: 7.2,
        pinR: 0.55,
        pins,
        shells: { shell: 270, S1: 300, S2: 60, S3: 180 },
        key: 'mini',
        short: `Mini-DIN ${positions}`,
        // pin order settled against Wikimedia and published references
        // — see MINI_DIN_9 / MINI_DIN_10 above
        approximate: false,
      });
    }
    case 'din-270':
    case 'din-262':
      return round(def, {
        skirt: 15.5,
        insert: 12.4,
        k: 4.6,
        pinR: 0.62,
        pins: dinPins(drawing === 'din-270' ? 270 : 262),
        shells: { shell: 270 },
        key: 'din',
        short: 'DIN-8',
        // arc order settled against a published reference diagram
        // — see dinPins() above
        approximate: false,
      });
    case 'rca':
      return rca(def, facing);
    case 'trs':
      return trs(def, facing);
    case 'bnc':
      return bnc(def, facing);
    default:
      return undefined;
  }
}
