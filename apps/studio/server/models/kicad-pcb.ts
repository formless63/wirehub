/**
 * What the board-model assembly reads from a KiCad
 * `.kicad_pcb`: each footprint's placement and its 3D model references
 * (with the model's own offset / scale / rotate), the Edge.Cuts outline,
 * the board thickness, and the model files KiCad embeds in the board file.
 * Pure: text in, plain data out (embedded files are decompressed with
 * node:zlib's zstd — no IO).
 *
 * Coordinates stay in KiCad's board frame: millimetres, **y pointing down**,
 * angles in degrees counter-clockwise as drawn. `assembly.ts` turns them
 * into the model's z-up frame.
 */

import { zstdDecompressSync } from 'node:zlib';

import { atom, child, children, head, numbers, parseSExpr, type SExpr } from './sexpr.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FootprintModel {
  /** the path exactly as the board has it (`${KICAD9_3DMODEL_DIR}/…`, `kicad-embed://…`, a UNC path) */
  path: string;
  /** mm, KiCad's model frame (y up) */
  offset: Vec3;
  scale: Vec3;
  /** degrees, as the file writes them (KiCad applies them negated, z then y then x) */
  rotate: Vec3;
  hidden: boolean;
}

export interface FootprintPlacement {
  /** `Resistor_SMD:R_0805_2012Metric` */
  footprint: string;
  /** `R1` */
  reference: string;
  value?: string;
  /** mm, board frame */
  x: number;
  y: number;
  /** degrees CCW */
  rotation: number;
  /** on B.Cu: mirrored through the board */
  bottom: boolean;
  models: FootprintModel[];
}

export interface OutlinePoint {
  x: number;
  y: number;
}

export interface EmbeddedFile {
  name: string;
  type: string;
  /** decompressed bytes */
  bytes: Uint8Array;
}

export interface KicadBoard {
  /** mm */
  thickness: number;
  footprints: FootprintPlacement[];
  /** closed loops from Edge.Cuts, largest (the board's outer edge) first */
  outlines: OutlinePoint[][];
  /** `name` → file; only read when asked (`embeddedFile`) */
  embeddedNames: string[];
}

const IN_TO_MM = 25.4;

function vec(expr: SExpr[] | undefined, fallback: Vec3): Vec3 {
  const xyz = numbers(child(expr ?? [], 'xyz'));
  if (xyz.length < 3) return fallback;
  return { x: xyz[0]!, y: xyz[1]!, z: xyz[2]! };
}

function flag(expr: SExpr[], name: string): boolean {
  // KiCad ≥ 8 writes `(hide yes)`; older files a bare `hide` atom
  const list = child(expr, name);
  if (list !== undefined) return atom(list) !== 'no';
  return expr.includes(name);
}

function parseModel(expr: SExpr[]): FootprintModel | undefined {
  const path = atom(expr);
  if (path === undefined) return undefined;
  const offsetList = child(expr, 'offset');
  // KiCad 5 and earlier: `(at (xyz …))` in inches
  const legacyAt = child(expr, 'at');
  let offset = vec(offsetList, { x: 0, y: 0, z: 0 });
  if (offsetList === undefined && legacyAt !== undefined) {
    const inches = vec(legacyAt, { x: 0, y: 0, z: 0 });
    offset = { x: inches.x * IN_TO_MM, y: inches.y * IN_TO_MM, z: inches.z * IN_TO_MM };
  }
  return {
    path,
    offset,
    scale: vec(child(expr, 'scale'), { x: 1, y: 1, z: 1 }),
    rotate: vec(child(expr, 'rotate'), { x: 0, y: 0, z: 0 }),
    hidden: flag(expr, 'hide'),
  };
}

function property(expr: SExpr[], name: string): string | undefined {
  for (const p of children(expr, 'property')) if (atom(p) === name) return atom(p, 2);
  // KiCad 7 and earlier: `(fp_text reference "R1" …)`
  for (const t of children(expr, 'fp_text')) if (atom(t) === name.toLowerCase()) return atom(t, 2);
  return undefined;
}

/** Board-frame position of a footprint-local point. */
function toBoard(fp: { x: number; y: number; rotation: number }, local: OutlinePoint): OutlinePoint {
  const t = (fp.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: fp.x + local.x * c + local.y * s, y: fp.y - local.x * s + local.y * c };
}

function parseFootprint(expr: SExpr[]): FootprintPlacement {
  const at = numbers(child(expr, 'at'));
  const layer = atom(child(expr, 'layer')) ?? 'F.Cu';
  const models: FootprintModel[] = [];
  for (const m of children(expr, 'model')) {
    const model = parseModel(m);
    if (model !== undefined) models.push(model);
  }
  const value = property(expr, 'Value');
  return {
    footprint: atom(expr) ?? '',
    reference: property(expr, 'Reference') ?? '',
    ...(value === undefined ? {} : { value }),
    x: at[0] ?? 0,
    y: at[1] ?? 0,
    rotation: at[2] ?? 0,
    bottom: layer.startsWith('B.'),
    models,
  };
}

/** A segment of Edge.Cuts as a polyline (arcs and circles sampled). */
type Polyline = OutlinePoint[];

function xy(expr: SExpr[] | undefined): OutlinePoint | undefined {
  const n = numbers(expr);
  return n.length >= 2 ? { x: n[0]!, y: n[1]! } : undefined;
}

/** Points along the circle through `a`, `m`, `b`, from a to b through m. */
function arcPoints(a: OutlinePoint, m: OutlinePoint, b: OutlinePoint): Polyline {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return [a, b];
  const a2 = a.x * a.x + a.y * a.y;
  const m2 = m.x * m.x + m.y * m.y;
  const b2 = b.x * b.x + b.y * b.y;
  const cx = (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d;
  const cy = (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const ang = (p: OutlinePoint): number => Math.atan2(p.y - cy, p.x - cx);
  const t0 = ang(a);
  // go the way that passes through m
  const norm = (t: number): number => (((t - t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const toB = norm(ang(b));
  const sweep = toB === 0 ? 2 * Math.PI : norm(ang(m)) < toB ? toB : toB - 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const out: Polyline = [];
  for (let k = 0; k <= steps; k++) {
    const t = t0 + (sweep * k) / steps;
    out.push(k === 0 ? a : k === steps ? b : { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return out;
}

function circlePoints(c: OutlinePoint, e: OutlinePoint): Polyline {
  const r = Math.hypot(e.x - c.x, e.y - c.y);
  const steps = 48;
  const out: Polyline = [];
  for (let k = 0; k <= steps; k++) {
    const t = (2 * Math.PI * k) / steps;
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

function edgePolylines(expr: SExpr[], prefix: 'gr' | 'fp'): Polyline[] {
  const out: Polyline[] = [];
  for (const item of expr) {
    if (!Array.isArray(item)) continue;
    const name = head(item);
    if (name === undefined || !name.startsWith(`${prefix}_`)) continue;
    if (atom(child(item, 'layer')) !== 'Edge.Cuts') continue;
    const start = xy(child(item, 'start'));
    const end = xy(child(item, 'end'));
    switch (name.slice(3)) {
      case 'line':
        if (start && end) out.push([start, end]);
        break;
      case 'arc': {
        const mid = xy(child(item, 'mid'));
        if (start && mid && end) out.push(arcPoints(start, mid, end));
        break;
      }
      case 'rect':
        if (start && end) out.push([start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]);
        break;
      case 'circle': {
        const center = xy(child(item, 'center'));
        if (center && end) out.push(circlePoints(center, end));
        break;
      }
      case 'poly': {
        const pts = child(item, 'pts');
        const points = children(pts ?? [], 'xy').map((p) => xy(p)!).filter(Boolean);
        if (points.length >= 2) out.push([...points, points[0]!]);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const EPS = 0.01;
const same = (a: OutlinePoint, b: OutlinePoint): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

export function polygonArea(loop: readonly OutlinePoint[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Joins polylines end to end into closed loops, largest first; open chains are dropped. */
export function chainLoops(polylines: readonly Polyline[]): OutlinePoint[][] {
  const pool = polylines.filter((p) => p.length >= 2).map((p) => [...p]);
  const loops: OutlinePoint[][] = [];
  while (pool.length > 0) {
    const chain = pool.shift()!;
    let grew = true;
    while (!same(chain[0]!, chain[chain.length - 1]!) && grew) {
      grew = false;
      const tail = chain[chain.length - 1]!;
      for (let k = 0; k < pool.length; k++) {
        const next = pool[k]!;
        if (same(next[0]!, tail)) chain.push(...next.slice(1));
        else if (same(next[next.length - 1]!, tail)) chain.push(...[...next].reverse().slice(1));
        else continue;
        pool.splice(k, 1);
        grew = true;
        break;
      }
    }
    if (chain.length >= 4 && same(chain[0]!, chain[chain.length - 1]!)) {
      const loop = chain.slice(0, -1).filter((p, i, all) => i === 0 || !same(p, all[i - 1]!));
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}

export function parseKicadPcb(text: string): KicadBoard & { tree: SExpr[] } {
  const top = parseSExpr(text).find((e) => head(e) === 'kicad_pcb');
  if (top === undefined || !Array.isArray(top)) throw new Error('not a .kicad_pcb file (no kicad_pcb list)');
  const thickness = numbers(child(child(top, 'general') ?? [], 'thickness'))[0] ?? 1.6;
  const footprints: FootprintPlacement[] = [];
  const polylines: Polyline[] = edgePolylines(top, 'gr');
  for (const fp of children(top, 'footprint')) {
    const placement = parseFootprint(fp);
    footprints.push(placement);
    for (const line of edgePolylines(fp, 'fp')) polylines.push(line.map((p) => toBoard(placement, p)));
  }
  const embedded = child(top, 'embedded_files');
  const embeddedNames = children(embedded ?? [], 'file').map((f) => atom(child(f, 'name')) ?? '').filter((n) => n !== '');
  return { thickness, footprints, outlines: chainLoops(polylines), embeddedNames, tree: [top] };
}

/** An embedded file's bytes: KiCad stores base64 of a zstd frame. `undefined` when absent. */
export function embeddedFile(board: { tree: SExpr[] }, name: string): EmbeddedFile | undefined {
  const top = board.tree[0];
  if (!Array.isArray(top)) return undefined;
  for (const file of children(child(top, 'embedded_files') ?? [], 'file')) {
    if (atom(child(file, 'name')) !== name) continue;
    const data = atom(child(file, 'data'));
    if (data === undefined) return undefined;
    const packed = Buffer.from(data.replace(/\s+/g, ''), 'base64');
    const zstd = packed.length >= 4 && packed[0] === 0x28 && packed[1] === 0xb5 && packed[2] === 0x2f && packed[3] === 0xfd;
    return { name, type: atom(child(file, 'type')) ?? 'other', bytes: new Uint8Array(zstd ? zstdDecompressSync(packed) : packed) };
  }
  return undefined;
}
