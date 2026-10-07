/**
 * A board model built from its KiCad file, for a
 * released board that has no Solid Model STEP: the Edge.Cuts outline
 * extruded to the board's thickness, and every footprint's 3D model placed
 * the way KiCad's own 3D viewer places it. Pure: placements and meshes in,
 * meshes out; the STEP reading happens in the conversion child
 * (`convert-worker.ts`), one board at a time.
 *
 * KiCad's transform for a footprint model, in its z-up 3D frame (board y
 * negated, top surface at the board thickness, bottom at 0):
 *
 *   T(x, −y, z) · Rz(orientation) · [bottom: Rx(180°)] · T(offset) · Rz(−rz) · Ry(−ry) · Rx(−rx) · S(scale)
 */

import { kicadLibraryRef } from './kicad-library.ts';
import type { FootprintModel, FootprintPlacement, KicadBoard, OutlinePoint } from './kicad-pcb.ts';
import { embeddedFile, polygonArea } from './kicad-pcb.ts';
import type { MeshPart } from './mesh.ts';
import type { SExpr } from './sexpr.ts';

/** Column-major 4×4. */
export type Mat4 = number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

const rad = (deg: number): number => (deg * Math.PI) / 180;
/** cos/sin with the exact zeros a quarter turn should give */
const cs = (deg: number): [number, number] => {
  const q = ((deg % 360) + 360) % 360;
  if (q === 0) return [1, 0];
  if (q === 90) return [0, 1];
  if (q === 180) return [-1, 0];
  if (q === 270) return [0, -1];
  return [Math.cos(rad(deg)), Math.sin(rad(deg))];
};

export function rotationX(deg: number): Mat4 {
  const [c, s] = cs(deg);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function rotationY(deg: number): Mat4 {
  const [c, s] = cs(deg);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function rotationZ(deg: number): Mat4 {
  const [c, s] = cs(deg);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** The model's own placement inside its footprint (offset, rotate, scale). */
export function modelMatrix(model: Pick<FootprintModel, 'offset' | 'rotate' | 'scale'>): Mat4 {
  return [
    translation(model.offset.x, model.offset.y, model.offset.z),
    rotationZ(-model.rotate.z),
    rotationY(-model.rotate.y),
    rotationX(-model.rotate.x),
    scaling(model.scale.x, model.scale.y, model.scale.z),
  ].reduce(multiply);
}

/** Where one footprint model sits on the board; `origin` is subtracted (board frame) so the board is centred. */
export function placementMatrix(
  fp: Pick<FootprintPlacement, 'x' | 'y' | 'rotation' | 'bottom'>,
  model: Pick<FootprintModel, 'offset' | 'rotate' | 'scale'>,
  thickness: number,
  origin: OutlinePoint = { x: 0, y: 0 },
): Mat4 {
  const place = multiply(translation(fp.x - origin.x, -(fp.y - origin.y), fp.bottom ? 0 : thickness), rotationZ(fp.rotation));
  return multiply(fp.bottom ? multiply(place, rotationX(180)) : place, modelMatrix(model));
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

function determinant3(m: Mat4): number {
  return m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
}

/** A copy of `part` moved by `m`; a mirroring `m` keeps the faces facing out. */
export function transformPart(part: MeshPart, m: Mat4, name = part.name): MeshPart {
  const positions = new Float32Array(part.positions.length);
  for (let i = 0; i < positions.length; i += 3) positions.set(transformPoint(m, part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!), i);
  let normals: Float32Array | undefined;
  if (part.normals !== undefined) {
    normals = new Float32Array(part.normals.length);
    const r = [...m.slice(0, 12), 0, 0, 0, 1];
    for (let i = 0; i < normals.length; i += 3) {
      const [x, y, z] = transformPoint(r, part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!);
      const len = Math.hypot(x, y, z) || 1;
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    }
  }
  let indices = part.indices;
  if (determinant3(m) < 0) {
    indices = new Uint32Array(part.indices.length);
    for (let t = 0; t < indices.length; t += 3) {
      indices[t] = part.indices[t]!;
      indices[t + 1] = part.indices[t + 2]!;
      indices[t + 2] = part.indices[t + 1]!;
    }
  }
  return { name, positions, indices, ...(part.sourceProductName === undefined ? {} : { sourceProductName: part.sourceProductName }), ...(part.sourceOccurrenceName === undefined ? {} : { sourceOccurrenceName: part.sourceOccurrenceName }), ...(part.sourceAssemblyPath === undefined ? {} : { sourceAssemblyPath: part.sourceAssemblyPath }), ...(normals === undefined ? {} : { normals }), ...(part.color === undefined ? {} : { color: part.color }) };
}

/* ------------------------------------------------------------------ *
 * The board itself
 * ------------------------------------------------------------------ */

/** Ear clipping; indices into `loop`, counter-clockwise. */
export function triangulate(loop: readonly OutlinePoint[]): number[] {
  const n = loop.length;
  if (n < 3) return [];
  const order = [...Array(n).keys()];
  if (polygonArea(loop) < 0) order.reverse();
  const out: number[] = [];
  const cross = (a: OutlinePoint, b: OutlinePoint, c: OutlinePoint): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inside = (p: OutlinePoint, a: OutlinePoint, b: OutlinePoint, c: OutlinePoint): boolean =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (order.length > 3 && guard < n * n) {
    guard += 1;
    let clipped = false;
    for (let i = 0; i < order.length; i++) {
      const ia = order[(i + order.length - 1) % order.length]!;
      const ib = order[i]!;
      const ic = order[(i + 1) % order.length]!;
      const a = loop[ia]!;
      const b = loop[ib]!;
      const c = loop[ic]!;
      if (cross(a, b, c) <= 1e-12) continue;
      let blocked = false;
      for (const j of order) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(loop[j]!, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(ia, ib, ic);
      order.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate outline: take what we have
  }
  if (order.length === 3) out.push(order[0]!, order[1]!, order[2]!);
  return out;
}

/** Solder-mask green, as KiCad's viewer draws it (linear rgb). */
export const BOARD_COLOUR: [number, number, number] = [0.02, 0.2, 0.06];

/** The outline (board frame, y down) as a slab from z = 0 to `thickness`, centred on `origin`. */
export function boardSlab(outline: readonly OutlinePoint[], thickness: number, origin: OutlinePoint): MeshPart {
  const pts = outline.map((p) => ({ x: p.x - origin.x, y: -(p.y - origin.y) }));
  const n = pts.length;
  const tris = triangulate(pts);
  const positions: number[] = [];
  const indices: number[] = [];
  const ccw = polygonArea(pts) > 0;
  // top (z = t) and bottom (z = 0) faces, each with its own vertices so they shade flat
  for (const p of pts) positions.push(p.x, p.y, thickness);
  for (const p of pts) positions.push(p.x, p.y, 0);
  for (let t = 0; t < tris.length; t += 3) {
    indices.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);
    indices.push(n + tris[t]!, n + tris[t + 2]!, n + tris[t + 1]!);
  }
  // the edge: a quad per side, outward
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const base = positions.length / 3;
    positions.push(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, thickness, a.x, a.y, thickness);
    if (ccw) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { name: 'board', positions: Float32Array.from(positions), indices: Uint32Array.from(indices), color: BOARD_COLOUR };
}

/** The centre of an outline's bounding box (board frame). */
export function outlineCentre(outline: readonly OutlinePoint[]): OutlinePoint {
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** Parts of one colour become one part — a board with fifty 0603s stays a handful of meshes. */
export function mergeByColour(parts: readonly MeshPart[]): MeshPart[] {
  const groups = new Map<string, MeshPart[]>();
  for (const part of parts) {
    const key = `${part.color === undefined ? '' : part.color.map((c) => c.toFixed(3)).join(',')}|${part.normals === undefined ? 'flat' : 'smooth'}`;
    groups.set(key, [...(groups.get(key) ?? []), part]);
  }
  const out: MeshPart[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.some((part) => part.sourceProductName !== undefined || part.sourceOccurrenceName !== undefined || part.sourceAssemblyPath !== undefined)) {
      out.push(...group);
      continue;
    }
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const vertexCount = group.reduce((n, p) => n + p.positions.length / 3, 0);
    const positions = new Float32Array(vertexCount * 3);
    const normals = key.endsWith('smooth') ? new Float32Array(vertexCount * 3) : undefined;
    const indices = new Uint32Array(group.reduce((n, p) => n + p.indices.length, 0));
    let v = 0;
    let i = 0;
    for (const part of group) {
      positions.set(part.positions, v * 3);
      if (normals !== undefined) normals.set(part.normals!, v * 3);
      for (let k = 0; k < part.indices.length; k++) indices[i + k] = part.indices[k]! + v;
      v += part.positions.length / 3;
      i += part.indices.length;
    }
    out.push({
      name: group[0]!.name === 'board' ? 'board' : `parts-${out.length + 1}`,
      positions,
      indices,
      ...(normals === undefined ? {} : { normals }),
      ...(group[0]!.color === undefined ? {} : { color: group[0]!.color }),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The plan the conversion child runs
 * ------------------------------------------------------------------ */

export interface AssemblyPlan {
  /** the board slab; absent for a single part placed with an offset */
  board?: { outline: OutlinePoint[]; thickness: number };
  /** each distinct model file once */
  models: { name: string; bytes: Uint8Array }[];
  /** where each copy goes */
  instances: { model: number; matrix: Mat4 }[];
}

/** The placed meshes — `meshes[i]` is `plan.models[i]` read. */
export function assemble(plan: Pick<AssemblyPlan, 'board' | 'instances'>, meshes: readonly (readonly MeshPart[])[]): MeshPart[] {
  const parts: MeshPart[] = [];
  if (plan.board !== undefined) parts.push(boardSlab(plan.board.outline, plan.board.thickness, { x: 0, y: 0 }));
  for (const [at, instance] of plan.instances.entries()) {
    for (const part of meshes[instance.model] ?? []) {
      const placed = transformPart(part, instance.matrix);
      // Reader-local ancestry is meaningful only within this model occurrence.
      if (placed.sourceAssemblyPath !== undefined) placed.sourceAssemblyPath = `model:${instance.model}/instance:${at}${placed.sourceAssemblyPath}`;
      parts.push(placed);
    }
  }
  return mergeByColour(parts);
}

/* ------------------------------------------------------------------ *
 * A board's plan, from its parsed .kicad_pcb
 * ------------------------------------------------------------------ */

export interface BoardModelSummary {
  /** library files placed, `Resistor_SMD.3dshapes/…` */
  library: string[];
  /** models KiCad embedded in the board file, by name */
  embedded: string[];
  /** model paths that point somewhere this box cannot read (a network share, a custom library) */
  unavailable: string[];
  /** footprint models placed */
  instances: number;
}

/** The KiCad library files a board's footprints name (hidden models left out), sorted. */
export function boardLibraryRefs(board: Pick<KicadBoard, 'footprints'>): string[] {
  const refs = new Set<string>();
  for (const fp of board.footprints) {
    for (const model of fp.models) {
      if (model.hidden) continue;
      const ref = kicadLibraryRef(model.path);
      if (ref !== undefined) refs.add(ref);
    }
  }
  return [...refs].sort();
}

/**
 * The conversion child's plan for a board: its outer Edge.Cuts loop,
 * centred, and one instance per visible footprint model this box has bytes
 * for — a library file (`libraryBytes`) or a model embedded in the board.
 */
export function boardAssemblyPlan(
  board: KicadBoard & { tree: SExpr[] },
  libraryBytes: (libraryPath: string) => Uint8Array | undefined,
): { plan: AssemblyPlan; summary: BoardModelSummary } {
  const outline = board.outlines[0];
  if (outline === undefined) throw new Error('the board file has no closed Edge.Cuts outline');
  const origin = outlineCentre(outline);
  const models: AssemblyPlan['models'] = [];
  const index = new Map<string, number>();
  const instances: AssemblyPlan['instances'] = [];
  const library = new Set<string>();
  const embedded = new Set<string>();
  const unavailable = new Set<string>();
  const modelIndex = (key: string, name: string, bytes: () => Uint8Array | undefined): number | undefined => {
    const known = index.get(key);
    if (known !== undefined) return known;
    const b = bytes();
    if (b === undefined) return undefined;
    models.push({ name, bytes: b });
    index.set(key, models.length - 1);
    return models.length - 1;
  };
  for (const fp of board.footprints) {
    for (const model of fp.models) {
      if (model.hidden) continue;
      const ref = kicadLibraryRef(model.path);
      let at: number | undefined;
      if (ref !== undefined) {
        at = modelIndex(`lib:${ref}`, ref.split('/').pop()!, () => libraryBytes(ref));
        if (at !== undefined) library.add(ref);
      } else if (model.path.startsWith('kicad-embed://')) {
        const name = model.path.slice('kicad-embed://'.length);
        at = modelIndex(`embed:${name}`, name, () => embeddedFile(board, name)?.bytes);
        if (at !== undefined) embedded.add(name);
      }
      if (at === undefined) {
        unavailable.add(model.path);
        continue;
      }
      instances.push({ model: at, matrix: placementMatrix(fp, model, board.thickness, origin) });
    }
  }
  return {
    plan: { board: { outline: outline.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y })), thickness: board.thickness }, models, instances },
    summary: { library: [...library].sort(), embedded: [...embedded].sort(), unavailable: [...unavailable].sort(), instances: instances.length },
  };
}
