/**
 * Solder-side connector faces for the drawing sheet.
 *
 * A face is presentation, not truth: outline artwork plus where each pin sits,
 * keyed by connector definition id. Traced faces (hand-drawn artwork a
 * deployment may supply, `assets.ts`) win; otherwise a connector is drawn from
 * the canvas's reviewed connector geometry (`drawn-faces.ts`), in the same
 * visual language, and marked where that geometry is approximate. One nobody
 * has drawn at all still gets a face — a plain pin grid — because a drawing
 * that refuses to render is worse than one with a generic block on it.
 *
 * Traced *plugs* are side views of secondary plugs (TRS, RCA, BNC), supplied
 * the same way.
 *
 * Coordinates are PostScript points (1/72 in), origin top-left of the face,
 * exactly the unit the ANSI A sheet is laid out in.
 */

import type { ConnectorDefinition } from '@cable-studio/model';

import { TRACED_FACES, TRACED_PLUGS } from './assets.ts';
import { drawnFace } from './drawn-faces.ts';

export interface FaceArtPath {
  d: string;
  fill?: string | null;
  stroke?: string | null;
  width?: number;
  evenOdd?: boolean;
  /** this path is a contact seen from the side (an RCA's centre pin): fill it by what lands on that pin */
  pin?: string;
}

export interface FacePin {
  id: string;
  /** centre */
  x: number;
  y: number;
  w: number;
  h: number;
  /** `ring`: an annulus, `w` across the outside and `inner` across the hole (a sleeve seen end-on) */
  shape: 'circle' | 'rect' | 'ring';
  inner?: number;
}

/**
 * How a plug drawn in side view sits on its lead: which way its business end
 * points, and where (art coordinates) and which way the lead leaves it.
 */
export interface PlugGeometry {
  tip: 'left' | 'right' | 'up';
  lead: { x: number; y: number; dir: 'left' | 'right' | 'down' };
}

export interface FaceArt {
  /** what the BOM calls it: "Male Mini-DIN 10" */
  material: string;
  width: number;
  height: number;
  art: readonly FaceArtPath[];
  pins: readonly FacePin[];
  /** corner pin numbers, baseline-anchored and centred */
  labels: readonly { text: string; x: number; y: number }[];
  src: string;
  /**
   * The geometry is the family's general shape, not a mechanical drawing
   * (`specs/connector-art-review.md`): the short note the sheet prints under
   * the face ("Approx. outline").
   */
  approximate?: string;
  /** what the sheet prints under the designator; defaults to "Solder Side" */
  subtitle?: string;
  /** side-view plugs only */
  plug?: PlugGeometry;
}

/**
 * Title-case the gender word, keep everything before the parenthetical — and
 * before a `, <construction>` segment and without a `21-pin` count, which the
 * naming rule adds to the label but a face drawing does
 * not need ("DIN-8 270° male, solder cup (the source device)" → "Male DIN-8 270°").
 */
export function materialFromLabel(def: ConnectorDefinition): string {
  const base = def.label
    .replace(/\s*\(.*$/, '')
    .replace(/,.*$/, '')
    .replace(/\s+\d+-pin\b/i, '')
    .replace(/\s+(male|female)\b/i, '')
    .trim();
  const gender = def.gender === undefined ? '' : `${def.gender[0]?.toUpperCase()}${def.gender.slice(1)} `;
  return `${gender}${base}`;
}

const GRID_PITCH = 13;
const GRID_PIN = 8;
const GRID_PER_ROW = 10;

/**
 * The fallback: a rounded plate with every mating pin in reading order, pitch
 * and pin size borrowed from the traced mini-DIN so it sits comfortably next to
 * a traced face. Each pin gets its id printed above it — with no artwork to
 * orient by, the numbers are the only way to read it.
 */
export function genericFace(def: ConnectorDefinition, pinIds: readonly string[]): FaceArt {
  const ids = pinIds.length > 0 ? pinIds : def.pins.map((pin) => pin.id);
  const perRow = Math.min(GRID_PER_ROW, Math.max(1, ids.length));
  const rows = Math.max(1, Math.ceil(ids.length / perRow));
  const pad = 10;
  const rowHeight = GRID_PITCH + 9;
  const width = pad * 2 + (perRow - 1) * GRID_PITCH + GRID_PIN;
  const height = pad * 2 + rows * rowHeight - 4;
  const pins: FacePin[] = ids.map((id, index) => ({
    id,
    x: pad + GRID_PIN / 2 + (index % perRow) * GRID_PITCH,
    y: pad + 9 + GRID_PIN / 2 + Math.floor(index / perRow) * rowHeight,
    w: GRID_PIN,
    h: GRID_PIN,
    shape: 'circle',
  }));
  return {
    material: materialFromLabel(def),
    width,
    height,
    art: [
      {
        d: `M4 0H${width - 4}Q${width} 0 ${width} 4V${height - 4}Q${width} ${height} ${width - 4} ${height}H4Q0 ${height} 0 ${height - 4}V4Q0 0 4 0Z`,
        fill: '#ffffff',
        stroke: '#000000',
        width: 1,
      },
    ],
    pins,
    labels: pins.map((pin) => ({ text: pin.id, x: pin.x, y: pin.y - GRID_PIN / 2 - 1.5 })),
    src: `generic pin grid for ${def.id} — no traced face yet`,
  };
}

/**
 * Connectors that share another connector's traced shell with a different
 * pinout: same physical face, same pin positions, different signals.
 */
const SAME_SHELL: Readonly<Record<string, string>> = {
  // the Peritel plug with the JP21 signal layout: one traced face serves both
  'jp21-male': 'scart-male',
};

export type FaceSource = 'traced' | 'drawn' | 'generic';

/**
 * The owner's traced face when there is one; else a face drawn from the
 * canvas's reviewed connector geometry (`drawn-faces.ts`); else the generic
 * numbered grid. `traced` is true for the first two — a real face.
 */
export function faceFor(def: ConnectorDefinition, pinIds: readonly string[]): { face: FaceArt; traced: boolean; source: FaceSource } {
  const shell = SAME_SHELL[def.id];
  const traced = TRACED_FACES[def.id] ?? (shell === undefined ? undefined : TRACED_FACES[shell]);
  if (traced !== undefined) {
    // same shell, own name: the BOM line is this connector's
    const face = shell === undefined ? traced : { ...traced, material: materialFromLabel(def), src: `${traced.src}, same shell as ${shell}` };
    return { face, traced: true, source: 'traced' };
  }
  const drawn = drawnFace(def);
  if (drawn !== undefined) return { face: drawn, traced: true, source: 'drawn' };
  return { face: genericFace(def, pinIds), traced: false, source: 'generic' };
}

/** Connector definition ids that have a traced face. */
export function tracedFaceIds(): string[] {
  return Object.keys(TRACED_FACES).sort();
}

/**
 * A plug drawn in side view at the end of its lead (a TRS or RCA whip, a
 * breakout's BNCs), when one is traced. `angled` asks for the 90° version
 * where the owner has drawn one (the 3.5 mm TRS).
 */
export function plugFor(defId: string, options: { angled?: boolean } = {}): FaceArt | undefined {
  if (options.angled === true) {
    const angled = TRACED_PLUGS[`${defId}-ra`];
    if (angled !== undefined) return angled;
  }
  return TRACED_PLUGS[defId];
}

/** Connector definition ids with a side-view plug (the `-ra` ones are the 90° versions). */
export function tracedPlugIds(): string[] {
  return Object.keys(TRACED_PLUGS).sort();
}

/* ------------------------------------------------------------------ *
 * Where a line meets the face's outline
 *
 * The cable's two outline lines, and a lead's two lines, have to stop at the
 * face's outer edge — as the owner's sheets draw them — not run on to its
 * centre. The edge is read off the artwork itself: every path is flattened to
 * a polyline and intersected with the line, so a round DIN, the SCART's
 * chamfered corner and a D-sub's shell all come out right.
 * ------------------------------------------------------------------ */

type Point = { x: number; y: number };

const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/gi;

/** Flatten an SVG path (the M L H V C Q Z and relative h v our faces use) to polylines. */
export function flattenPath(d: string): Point[][] {
  const out: Point[][] = [];
  let line: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  let start: Point = at;
  for (const [, command, args] of d.matchAll(/([MLHVCQZmlhvcqz])([^MLHVCQZmlhvcqz]*)/g)) {
    const v = (args!.match(NUMBER) ?? []).map(Number);
    switch (command) {
      case 'M':
        if (line.length > 1) out.push(line);
        at = { x: v[0]!, y: v[1]! };
        start = at;
        line = [at];
        for (let i = 2; i + 1 < v.length; i += 2) line.push((at = { x: v[i]!, y: v[i + 1]! }));
        break;
      case 'L':
        for (let i = 0; i + 1 < v.length; i += 2) line.push((at = { x: v[i]!, y: v[i + 1]! }));
        break;
      case 'H':
        for (const x of v) line.push((at = { x, y: at.y }));
        break;
      case 'h':
        for (const dx of v) line.push((at = { x: at.x + dx, y: at.y }));
        break;
      case 'V':
        for (const y of v) line.push((at = { x: at.x, y }));
        break;
      case 'v':
        for (const dy of v) line.push((at = { x: at.x, y: at.y + dy }));
        break;
      case 'C':
        for (let i = 0; i + 5 < v.length; i += 6) {
          const [c1, c2, end] = [
            { x: v[i]!, y: v[i + 1]! },
            { x: v[i + 2]!, y: v[i + 3]! },
            { x: v[i + 4]!, y: v[i + 5]! },
          ];
          const from = at;
          for (let t = 1; t <= 12; t += 1) {
            const u = t / 12;
            const w = 1 - u;
            line.push({
              x: w * w * w * from.x + 3 * w * w * u * c1.x + 3 * w * u * u * c2.x + u * u * u * end.x,
              y: w * w * w * from.y + 3 * w * w * u * c1.y + 3 * w * u * u * c2.y + u * u * u * end.y,
            });
          }
          at = end;
        }
        break;
      case 'Q':
        for (let i = 0; i + 3 < v.length; i += 4) {
          const [c, end] = [{ x: v[i]!, y: v[i + 1]! }, { x: v[i + 2]!, y: v[i + 3]! }];
          const from = at;
          for (let t = 1; t <= 8; t += 1) {
            const u = t / 8;
            const w = 1 - u;
            line.push({ x: w * w * from.x + 2 * w * u * c.x + u * u * end.x, y: w * w * from.y + 2 * w * u * c.y + u * u * end.y });
          }
          at = end;
        }
        break;
      case 'Z':
      case 'z':
        line.push((at = start));
        break;
      default:
        break;
    }
  }
  if (line.length > 1) out.push(line);
  return out;
}

function crossings(face: FaceArt, axis: 'x' | 'y', value: number): number[] {
  const other = axis === 'y' ? 'x' : 'y';
  const hits: number[] = [];
  for (const path of face.art) {
    for (const poly of flattenPath(path.d)) {
      for (let i = 1; i < poly.length; i += 1) {
        const p = poly[i - 1]!;
        const q = poly[i]!;
        if ((p[axis] - value) * (q[axis] - value) > 0 || p[axis] === q[axis]) continue;
        const t = (value - p[axis]) / (q[axis] - p[axis]);
        hits.push(p[other] + t * (q[other] - p[other]));
      }
    }
  }
  return hits;
}

/**
 * The outermost x where the horizontal line `y` meets the face's outline, on
 * the given side (face coordinates). Falls back to the face's box edge.
 */
export function faceEdgeX(face: FaceArt, y: number, side: 'left' | 'right'): number {
  const hits = crossings(face, 'y', y);
  if (hits.length === 0) return side === 'right' ? face.width : 0;
  return side === 'right' ? Math.max(...hits) : Math.min(...hits);
}

/** The topmost y where the vertical line `x` meets the face's outline. */
export function faceEdgeTop(face: FaceArt, x: number): number {
  const hits = crossings(face, 'x', x);
  return hits.length === 0 ? 0 : Math.min(...hits);
}
