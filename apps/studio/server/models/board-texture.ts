/**
 * A board body's top/bottom faces, painted with its own gerber-tier art
 * — the fix for solid models of PCBs/PCBAs that
 * have no styles, colours or details applied.
 *
 * Supplied board-top/board-bottom artwork is the source for surface detail;
 * it does not infer component colors or replace styles on other products.
 * The legacy/exporter profiles retain their historical behavior. The opt-in
 * occurrence profile also paints source-identified coating shells belonging
 * to that board, preserving their geometry and all other recovered styles.
 *
 * Pure except `rasterizeSvg`, which is Node-only (`@resvg/resvg-js`) and
 * dynamically imported so nothing outside the conversion child ever loads
 * it — the studio's runtime and its browser bundle never see this module's
 * one dependency.
 */

import type { BoardTextureProfile } from './cache.ts';
import { textureBoardCoatings } from './board-coating.ts';
import type { MeshPart } from './mesh.ts';

/** A board's two sides of gerber-tier art, SVG text — `board-top`/`board-bottom` (or a revision's). */
export interface BoardArt {
  top: string;
  bottom: string;
}

/** Rasterised at this many pixels per millimetre... */
export const BOARD_TEXTURE_PX_PER_MM = 20;
/** ...capped on the longer side, so a large board still fits the model budget. */
export const BOARD_TEXTURE_MAX_PX = 4096;

/** Dark, unlit FR4 edge — the cut edge of the laminate, never painted. */
export const BOARD_EDGE_COLOUR: [number, number, number] = [0.03, 0.03, 0.03];

export interface Bounds2D {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The XY bounding box of a part's vertices. */
export function boundsOfXY(part: Pick<MeshPart, 'positions'>): Bounds2D {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const p = part.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** The name convention a board body's mesh part gets, from either source. */
export function looksLikeBoardPart(name: string, profile: BoardTextureProfile = 'exporter'): boolean {
  return name === 'board' || /_pcb(#\d+)?$/i.test(name) || (profile !== 'legacy' && /^board~[a-z0-9]{1,64}(?:#\d{1,6})?$/i.test(name));
}

/** The index of the part that is the board body, or `undefined`. */
export function findBoardPart(parts: readonly MeshPart[], profile: BoardTextureProfile = 'exporter'): number | undefined {
  const at = parts.findIndex((p) => looksLikeBoardPart(p.name, profile));
  return at === -1 ? undefined : at;
}

function triangleNormalZ(p: Float32Array, ia: number, ib: number, ic: number): number {
  const ax = p[ia * 3]!;
  const ay = p[ia * 3 + 1]!;
  const az = p[ia * 3 + 2]!;
  const bx = p[ib * 3]! - ax;
  const by = p[ib * 3 + 1]! - ay;
  const bz = p[ib * 3 + 2]! - az;
  const cx = p[ic * 3]! - ax;
  const cy = p[ic * 3 + 1]! - ay;
  const cz = p[ic * 3 + 2]! - az;
  // z of (b × c); the triangle's own area scales it, which is fine — only the sign and roughly its size matter here
  const nz = bx * cy - by * cx;
  const len = Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, nz) || 1;
  return nz / len;
}

/**
 * A flat slab's triangles, grouped by which way they face: `top` (normal
 * mostly +Z), `bottom` (mostly -Z), `edge` (the cut side, near-vertical
 * normal). Works whether the slab came in as one STEP solid with the top,
 * bottom and edge as different brep faces already merged into one mesh (a
 * Solid Model board), or was built face-by-face as three explicit triangle
 * groups (`assembly.ts`'s `boardSlab`) — either way this only looks at
 * geometry. `undefined` when `part` does not look like a flat board (no
 * meaningful top and bottom).
 */
export function splitBoardFaces(part: MeshPart): { top: MeshPart; bottom: MeshPart; edge: MeshPart } | undefined {
  const top: number[] = [];
  const bottom: number[] = [];
  const edge: number[] = [];
  const idx = part.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    const nz = triangleNormalZ(part.positions, a, b, c);
    const bucket = nz > 0.5 ? top : nz < -0.5 ? bottom : edge;
    bucket.push(a, b, c);
  }
  const totalTriangles = idx.length / 3;
  // a board has real area on both faces; a few stray near-vertical triangles from a
  // slightly domed top don't disqualify it, but a slab with (almost) no underside does
  if (totalTriangles === 0 || top.length === 0 || bottom.length === 0) return undefined;
  if (top.length / 3 < totalTriangles * 0.05 || bottom.length / 3 < totalTriangles * 0.05) return undefined;
  const pick = (indices: number[], suffix: string): MeshPart => ({
    name: `${part.name}-${suffix}`,
    positions: part.positions,
    indices: Uint32Array.from(indices),
    ...(part.normals === undefined ? {} : { normals: part.normals }),
    ...(part.color === undefined ? {} : { color: part.color }),
    ...(part.alpha === undefined ? {} : { alpha: part.alpha }),
    ...(part.sourceProductName === undefined ? {} : { sourceProductName: part.sourceProductName }),
    ...(part.sourceOccurrenceName === undefined ? {} : { sourceOccurrenceName: part.sourceOccurrenceName }),
    ...(part.sourceAssemblyPath === undefined ? {} : { sourceAssemblyPath: part.sourceAssemblyPath }),
    ...(part.readerMeshId === undefined ? {} : { readerMeshId: part.readerMeshId }),
  });
  return { top: pick(top, 'top'), bottom: pick(bottom, 'bottom'), edge: pick(edge, 'edge') };
}

/**
 * UV for every vertex `indices` touches, from its (x, y) within `bounds`.
 * `v = 0` at the north edge (max Y) so it lands at the top of the image, the
 * way `assembly.ts` negates Y going from KiCad's page frame (Y down) to this
 * mesh's frame — and the way KiCad's own STEP export does for a whole board,
 * the same convention `assembly.ts`'s header comment already documents for
 * a placed footprint. `mirrored`: the underside, seen from below by turning
 * the board over left↔right (`u` mirrors) — exactly how the depiction
 * pipeline renders `board-bottom.svg` ("mirrored about x") from the real
 * bottom-copper gerbers, so no extra flip belongs in the image itself.
 */
export function boardFaceUv(part: Pick<MeshPart, 'positions' | 'indices'>, bounds: Bounds2D, mirrored: boolean): Float32Array {
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const uv = new Float32Array((part.positions.length / 3) * 2);
  const seen = new Uint8Array(part.positions.length / 3);
  for (const v of part.indices) {
    if (seen[v] === 1) continue;
    seen[v] = 1;
    const x = part.positions[v * 3]!;
    const y = part.positions[v * 3 + 1]!;
    const nx = (x - bounds.minX) / spanX;
    const ny = (y - bounds.minY) / spanY;
    uv[v * 2] = mirrored ? 1 - nx : nx;
    uv[v * 2 + 1] = 1 - ny;
  }
  return uv;
}

/** An SVG's physical size in millimetres, from its `viewBox` (tracespace's board art is mm-true, `mmPerUnit: 1`). */
export function svgSizeMm(svg: string): { width: number; height: number } | undefined {
  const box = /viewBox\s*=\s*"([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"/.exec(svg);
  if (box === null) return undefined;
  const width = Number(box[3]);
  const height = Number(box[4]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

/** Deterministic raster size for a board side: `pxPerMm`, capped on the longer side, at least 1px. */
export function boardRasterSize(sizeMm: { width: number; height: number }, pxPerMm = BOARD_TEXTURE_PX_PER_MM, maxPx = BOARD_TEXTURE_MAX_PX): { width: number; height: number } {
  const longer = Math.max(sizeMm.width, sizeMm.height);
  const scale = longer * pxPerMm > maxPx ? maxPx / (longer * pxPerMm) : 1;
  const px = (mm: number): number => Math.max(1, Math.round(mm * pxPerMm * scale));
  return { width: px(sizeMm.width), height: px(sizeMm.height) };
}

/**
 * SVG → PNG, at a deterministic pixel size. Node-only (a native binding,
 * `@resvg/resvg-js`) and loaded only here, inside the conversion child —
 * never at runtime, never in the browser bundle.
 */
export async function rasterizeSvg(svg: string, size: { width: number; height: number }): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size.width }, background: 'white' });
  const png = resvg.render().asPng();
  return new Uint8Array(png);
}

/** One original board reader mesh may have been split into several color groups. */
function occurrenceBoard(parts: readonly MeshPart[]): { board: MeshPart; members: Set<MeshPart> } | undefined {
  const groups = new Map<string, MeshPart[]>();
  parts.forEach((part, at) => {
    if (!looksLikeBoardPart(part.name, 'occurrence')) return;
    // Missing reader identity can only establish a singleton, never merge bodies.
    const key = part.readerMeshId ?? `unidentified:${at}`;
    groups.set(key, [...(groups.get(key) ?? []), part]);
  });
  if (groups.size !== 1) return undefined;
  const group = [...groups.values()][0]!;
  const first = group[0]!;
  if (group.length === 1) return { board: first, members: new Set(group) };
  if (group.some((part) => part.sourceProductName !== first.sourceProductName
    || part.sourceOccurrenceName !== first.sourceOccurrenceName
    || part.sourceAssemblyPath !== first.sourceAssemblyPath
    || part.alpha !== first.alpha
    || (part.normals === undefined) !== (first.normals === undefined))) return undefined;
  const count = group.reduce((n, p) => n + p.positions.length, 0);
  const positions = new Float32Array(count);
  const normals = first.normals === undefined ? undefined : new Float32Array(count);
  const indices = new Uint32Array(group.reduce((n, p) => n + p.indices.length, 0));
  let offset = 0;
  let triangleOffset = 0;
  for (const part of group) {
    positions.set(part.positions, offset);
    if (normals !== undefined) normals.set(part.normals!, offset);
    for (const index of part.indices) indices[triangleOffset++] = index + offset / 3;
    offset += part.positions.length;
  }
  // Joining color groups changes no source vertex or triangle, and supplies one
  // shared XY frame for all sides. It cannot combine separate reader bodies.
  return { board: { ...first, positions, indices, ...(normals === undefined ? {} : { normals }) }, members: new Set(group) };
}

/** Paint one source board's faces and its explicitly associated coating shells. */
export async function applyBoardTexture(parts: readonly MeshPart[], art: BoardArt | undefined, profile: BoardTextureProfile = 'exporter'): Promise<MeshPart[]> {
  if (art === undefined) return [...parts];
  const grouped = (profile === 'occurrence' || profile === 'appearance') ? occurrenceBoard(parts) : undefined;
  if ((profile === 'occurrence' || profile === 'appearance') && grouped === undefined) return [...parts];
  const at = findBoardPart(parts, profile);
  if (at === undefined) return [...parts];
  const board = grouped?.board ?? parts[at]!;
  const split = splitBoardFaces(board);
  if (split === undefined) return [...parts];
  const withoutSoldermask = (profile === 'occurrence' || profile === 'appearance') ? [...parts] : parts.filter((_, i) => i === at || !/soldermask/i.test(parts[i]!.name));
  const bounds = boundsOfXY(board);
  // Render serially: simultaneous large renders would double resident memory.
  const rasters: Uint8Array[] = [];
  for (const svg of [art.top, art.bottom]) {
    const sizeMm = svgSizeMm(svg) ?? { width: bounds.maxX - bounds.minX || 1, height: bounds.maxY - bounds.minY || 1 };
    rasters.push(await rasterizeSvg(svg, boardRasterSize(sizeMm)));
  }
  const [topPng, bottomPng] = rasters as [Uint8Array, Uint8Array];
  const { color: _topColour, ...topRest } = split.top;
  const { color: _bottomColour, ...bottomRest } = split.bottom;
  const top: MeshPart = { ...topRest, uv: boardFaceUv(split.top, bounds, false), image: topPng };
  const bottom: MeshPart = { ...bottomRest, uv: boardFaceUv(split.bottom, bounds, true), image: bottomPng };
  const edge: MeshPart = { ...split.edge, color: BOARD_EDGE_COLOUR };
  if (grouped !== undefined) {
    const out: MeshPart[] = [];
    let inserted = false;
    for (const part of withoutSoldermask) {
      if (!grouped.members.has(part)) out.push(part);
      else if (!inserted) { out.push(top, bottom, edge); inserted = true; }
    }
    return textureBoardCoatings(out, bounds, { top: topPng, bottom: bottomPng }, board);
  }
  const out = [...withoutSoldermask];
  out.splice(out.indexOf(board), 1, top, bottom, edge);
  return out;
}
