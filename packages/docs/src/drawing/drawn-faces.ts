/**
 * Connector faces drawn from geometry, for the connectors the owner has not
 * drawn a sheet for — in the same visual language as the traced ones
 * (`assets.generated.ts`): a 1 pt black outline, pins as outlined shapes the
 * renderer fills by what lands on them, corner pin numbers at 10 pt.
 *
 * **The geometry is not re-derived here.** Every pitch, row, outline and
 * keying feature is the canvas's connector art
 * (`packages/layout/src/connector-art.ts` — the drawings the owner
 * reviewed, with their references in `specs/connector-art-review.md`),
 * restated in the sheet's units. `test/drawing-faces.test.ts` holds the two
 * to the same pin order, so a correction there fails here until it is carried
 * over. What differs is the view: the canvas draws the **mating face**, the
 * sheet (like every one of the owner's) the **solder side** — the same face
 * seen from behind, i.e. mirrored left to right. Where the canvas art is
 * flagged approximate, the face says so (`approximate`) and the sheet prints
 * it under the face.
 *
 * Units: the canvas's front view in mm (u along the long axis, left → right;
 * v across it, top → bottom), scaled to PostScript points per face so pin
 * pitch and pin size sit close to the traced faces' (≈ 13–20 pt pitch,
 * 7–8 pt pins).
 */

import type { ConnectorDefinition } from '@wirehub/model';
import { DSUB_SHELLS } from '@wirehub/layout';

import type { FaceArt, FaceArtPath, FacePin } from './faces.ts';

const R = (value: number): number => Math.round(value * 100) / 100;

const OUTLINE = '#000000';

/** A solder-side face: front-view mm in, sheet pt out, mirrored left↔right. */
class SolderFace {
  readonly art: FaceArtPath[] = [];
  readonly pins: FacePin[] = [];
  readonly labels: { text: string; x: number; y: number }[] = [];
  readonly width: number;
  readonly height: number;
  /** points per mm */
  readonly k: number;

  /**
   * @param long front view's long axis, mm (the face's drawn width)
   * @param across front view's short axis, mm
   * @param k points per mm
   * @param pad clear air around the outline, pt (room for the corner numbers)
   */
  constructor(long: number, across: number, k: number, pad = 2) {
    this.k = k;
    this.width = R(long * k + pad * 2);
    this.height = R(across * k + pad * 2);
  }

  /** front view mm → sheet pt, seen from the solder side */
  x(u: number): number {
    return R(this.width / 2 - u * this.k);
  }

  y(v: number): number {
    return R(this.height / 2 + v * this.k);
  }

  path(points: readonly [number, number][], extra: Partial<FaceArtPath> = {}): void {
    const d = points.map(([u, v], i) => `${i === 0 ? 'M' : 'L'}${this.x(u)} ${this.y(v)}`).join('') + 'Z';
    this.art.push({ d, stroke: OUTLINE, width: 1, ...extra });
  }

  /**
   * A polygon with its corners eased by `radius` mm (quadratic corners, as
   * the traced outlines' are).
   */
  rounded(points: readonly [number, number][], radius: number, extra: Partial<FaceArtPath> = {}): void {
    const pts = points.map(([u, v]) => ({ x: this.x(u), y: this.y(v) }));
    const r = radius * this.k;
    const parts: string[] = [];
    pts.forEach((p, i) => {
      const prev = pts[(i + pts.length - 1) % pts.length]!;
      const next = pts[(i + 1) % pts.length]!;
      const toward = (q: { x: number; y: number }): { x: number; y: number } => {
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const length = Math.hypot(dx, dy) || 1;
        const t = Math.min(r, length / 2) / length;
        return { x: R(p.x + dx * t), y: R(p.y + dy * t) };
      };
      const a = toward(prev);
      const b = toward(next);
      parts.push(`${i === 0 ? 'M' : 'L'}${a.x} ${a.y}Q${R(p.x)} ${R(p.y)} ${b.x} ${b.y}`);
    });
    this.art.push({ d: `${parts.join('')}Z`, stroke: OUTLINE, width: 1, ...extra });
  }

  box(u0: number, v0: number, u1: number, v1: number, radius: number, extra: Partial<FaceArtPath> = {}): void {
    this.rounded(
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      radius,
      extra,
    );
  }

  circle(u: number, v: number, r: number, extra: Partial<FaceArtPath> = {}): void {
    const cx = this.x(u);
    const cy = this.y(v);
    const rr = R(r * this.k);
    // two arcs as cubic quarter-circles: `flattenPath` reads C, not A
    const c = R(rr * 0.5523);
    const d =
      `M${R(cx)} ${R(cy - rr)}` +
      `C${R(cx + c)} ${R(cy - rr)} ${R(cx + rr)} ${R(cy - c)} ${R(cx + rr)} ${R(cy)}` +
      `C${R(cx + rr)} ${R(cy + c)} ${R(cx + c)} ${R(cy + rr)} ${R(cx)} ${R(cy + rr)}` +
      `C${R(cx - c)} ${R(cy + rr)} ${R(cx - rr)} ${R(cy + c)} ${R(cx - rr)} ${R(cy)}` +
      `C${R(cx - rr)} ${R(cy - c)} ${R(cx - c)} ${R(cy - rr)} ${R(cx)} ${R(cy - rr)}Z`;
    this.art.push({ d, stroke: OUTLINE, width: 1, ...extra });
  }

  pin(id: string, u: number, v: number, w: number, h: number, shape: FacePin['shape'], inner?: number): void {
    this.pins.push({
      id,
      x: this.x(u),
      y: this.y(v),
      w: R(w * this.k),
      h: R(h * this.k),
      shape,
      ...(inner === undefined ? {} : { inner: R(inner * this.k) }),
    });
  }

  /** a corner pin number, centred on (u, v), baseline dropped for 10 pt */
  label(text: string, u: number, v: number): void {
    this.labels.push({ text, x: this.x(u), y: R(this.y(v) + 3.6) });
  }

  done(material: string, src: string, extra: Partial<FaceArt> = {}): FaceArt {
    return { material, width: this.width, height: this.height, art: this.art, pins: this.pins, labels: this.labels, src, ...extra };
  }
}

const range = (from: number, to: number, step = 1): string[] => {
  const out: string[] = [];
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(String(n));
  return out;
};

/* ------------------------------------------------------------------ *
 * D-Sub (DE-9, DA-15, DB-23, DB-25, DC-37)
 *
 * connector-art.ts `DSUB_SHELLS` / `dsub()`: pitch 2.77 × row gap 2.84 mm,
 * long row on top numbered 1..n left → right on the male mating face, the
 * short row n+1.. under it; the D's sides drafted 10°, ends 2.6 mm past the
 * outermost pin, 2.3 mm below the last row; jackscrew holes at `holes`
 * spacing. Drawn like the owner's traced HD15: the D and the two screw
 * bosses, no flange.
 * ------------------------------------------------------------------ */

/**
 * The shells themselves are the canvas's own table, imported — not restated
 *.
 */
export { DSUB_SHELLS };

function dsubFace(def: ConnectorDefinition): FaceArt | undefined {
  const numbered = def.pins.filter((pin) => /^\d+$/.test(pin.id));
  const shell = DSUB_SHELLS[String(numbered.length)];
  if (shell === undefined) return undefined;
  const male = def.gender !== 'female';
  const k = 4.8;
  const boss = 2.4;
  const face = new SolderFace(shell.holes + boss * 2, 12.5, k, 1);
  const rowCount = shell.rows.length;
  const vOf = (row: number): number => (row - (rowCount - 1) / 2) * shell.rowGap;
  const uOf = (row: number, index: number): number => {
    const n = shell.rows[row] ?? 0;
    const u = (index - (n - 1) / 2) * shell.pitch;
    // a socket's mating face is the pin face mirrored
    return male ? u : -u;
  };
  const reach = ((shell.rows[0] ?? 0) - 1) / 2 * shell.pitch;
  const halfTop = reach + 2.6;
  const halfAcross = vOf(rowCount - 1) + 2.3;
  const halfBottom = halfTop - Math.tan((10 * Math.PI) / 180) * halfAcross * 2;
  face.rounded(
    [
      [-halfTop, -halfAcross],
      [halfTop, -halfAcross],
      [halfBottom, halfAcross],
      [-halfBottom, halfAcross],
    ],
    1.3,
    { fill: '#ffffff' },
  );
  for (const side of [-1, 1]) face.circle((side * shell.holes) / 2, 0, 1.28);
  let next = 1;
  shell.rows.forEach((n, row) => {
    const first = next;
    for (let index = 0; index < n; index += 1) {
      face.pin(String(next), uOf(row, index), vOf(row), 1.48, 1.48, 'circle');
      next += 1;
    }
    const last = next - 1;
    // the row's two end pins numbered just outside the D, between it and the
    // screw boss, as on the HD15 sheet
    const end = (index: number): number => Math.sign(uOf(row, index) || 1) * (halfTop + 1.45);
    face.label(String(first), end(0), vOf(row));
    face.label(String(last), end(n - 1), vOf(row));
  });
  const count = numbered.length;
  return face.done(
    `${male ? 'Male' : 'Female'} DB-${count}`,
    `drawn from connector-art.ts dsub() (DSUB_SHELLS['${count}']), solder side`,
    def.id === 'db23-male'
      ? {
          // specs/connector-art-review.md: a device's non-standard shell
          approximate: 'Approx. shell size (non-standard DB-23)',
        }
      : {},
  );
}

/* ------------------------------------------------------------------ *
 * Console multi-outs — connector-art.ts `rowFace()` specs
 * ------------------------------------------------------------------ */

interface RowSpec {
  long: number;
  across: number;
  k: number;
  rows: string[][];
  pitch: number;
  rowGap: number;
  /** the contact's size in the front view, mm (along u, along v) */
  pin: [number, number];
  outline: (face: SolderFace, hl: number, ha: number) => void;
}

function rowFace(def: ConnectorDefinition, spec: RowSpec, material: string, src: string, approximate: string): FaceArt | undefined {
  const ids = new Set(spec.rows.flat());
  if (!def.pins.every((pin) => ids.has(pin.id))) return undefined;
  const face = new SolderFace(spec.long, spec.across, spec.k, 12);
  spec.outline(face, spec.long / 2, spec.across / 2);
  const n = spec.rows.length;
  spec.rows.forEach((row, index) => {
    const v = (index - (n - 1) / 2) * spec.rowGap;
    row.forEach((id, at) => {
      const u = (at - (row.length - 1) / 2) * spec.pitch;
      if (def.pins.some((pin) => pin.id === id)) face.pin(id, u, v, spec.pin[0], spec.pin[1], 'rect');
    });
    // each row numbered at both ends, just outside the outline
    const out = spec.long / 2 + 6.5 / spec.k;
    const first = row[0];
    const last = row[row.length - 1];
    if (first !== undefined) face.label(first, -out, v);
    if (last !== undefined && last !== first) face.label(last, out, v);
  });
  return face.done(material, src, { approximate });
}

/* ------------------------------------------------------------------ *
 * Round single-signal plugs — an end view: the sleeve (or shell) as a ring,
 * the centre contact in the middle, each filled by what lands on it
 * ------------------------------------------------------------------ */

function endView(
  def: ConnectorDefinition,
  rings: { id: string; outer: number; inner?: number }[],
  body: number,
  material: string,
  src: string,
): FaceArt | undefined {
  if (!def.pins.every((pin) => rings.some((ring) => ring.id === pin.id))) return undefined;
  const k = 3.6;
  const face = new SolderFace(body, body, k, 12);
  face.circle(0, 0, body / 2, { fill: '#ffffff' });
  for (const ring of rings) {
    if (!def.pins.some((pin) => pin.id === ring.id)) continue;
    face.pin(ring.id, 0, 0, ring.outer, ring.outer, ring.inner === undefined ? 'circle' : 'ring', ring.inner);
  }
  return face.done(material, src, { subtitle: 'End View' });
}

function bncFace(def: ConnectorDefinition): FaceArt | undefined {
  // connector-art.ts bnc(): the bayonet nut 26 across the grip → the shell
  // ring; the insulator and the centre pin
  return endView(
    def,
    [
      { id: 'shell', outer: 9.6, inner: 6.4 },
      { id: 'tip', outer: 1.6 },
    ],
    14,
    'Male BNC',
    'drawn from connector-art.ts bnc(), end view',
  );
}

function rcaFace(def: ConnectorDefinition): FaceArt | undefined {
  // Wikipedia "RCA connector": a 3.2 mm centre pin in
  // an ~8.4 mm split ring (plug); a central hole in an insulator inside a
  // slightly smaller, thin ground ring (jack) — the socket is hollow
  const male = def.gender !== 'female';
  return endView(
    def,
    male
      ? [
          { id: 'sleeve', outer: 8.4, inner: 6.6 },
          { id: 'tip', outer: 3.2 },
        ]
      : [
          { id: 'sleeve', outer: 8.0, inner: 6.8 },
          { id: 'tip', outer: 4.4, inner: 3.2 },
        ],
    12,
    male ? 'Male RCA' : 'Female RCA',
    'drawn from connector-art.ts rca(), end view',
  );
}

function trsFace(def: ConnectorDefinition): FaceArt | undefined {
  // not a real end view (a 3.5 mm plug shows only its tip end-on) but the
  // same concentric reading the sheet uses for every round plug: sleeve,
  // ring, tip, outside in
  return endView(
    def,
    [
      { id: 'sleeve', outer: 9, inner: 6.2 },
      { id: 'ring', outer: 5.6, inner: 3.4 },
      { id: 'tip', outer: 2.6 },
    ],
    12,
    def.gender === 'female' ? 'Female 3.5 MM TRS' : 'Male 3.5 MM TRS',
    'drawn from connector-art.ts trs(), end view (schematic rings)',
  );
}

/** A drawn face for the definition, when its family has one. */
export function drawnFace(def: ConnectorDefinition): FaceArt | undefined {
  const family = (def.family ?? '').toLowerCase();
  const id = def.id.toLowerCase();
  switch (family) {
    case 'd-sub':
      return dsubFace(def);
    case 'bnc':
      return bncFace(def);
    case 'rca':
      return rcaFace(def);
    case '3.5mm':
    case 'trs':
      return trsFace(def);
    default:
      return undefined;
  }
}
