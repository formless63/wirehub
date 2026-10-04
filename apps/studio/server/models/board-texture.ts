/**
 * A board body's top/bottom faces, painted with its own gerber-tier art
 * — the fix for "most of the solid models of the
 * PCBs/PCBAs have no styles/colors/details applied" (owner, 2026-09-29).
 *
 * The root cause (checked on real STEPs: PCA-00109, PCA-00101 Rev6,
 * PCA-00111, PCA-00108): the board designer's STEP export gives the whole PCB body **one**
 * flat STYLED_ITEM colour — the same `(0.420, 0.450, 0.290)` on every board
 * regardless of its real soldermask colour — and none of its faces carry a
 * different one (`brep_faces[i].color` is `null` for every face of the `_PCB`
 * solid on all four). `step.ts` already keeps whatever colour a STEP does
 * carry (per-face when present, the shape's own colour as a fallback
 * otherwise) — that part was not broken. There is simply no richer colour to
 * recover from the file: the fix is to paint the board's own faces with the
 * same board-top/board-bottom art the 2D Library views already render from
 * the gerbers, not to mine the STEP harder.
 *
 * Pure except `rasterizeSvg`, which is Node-only (`@resvg/resvg-js`) and
 * dynamically imported so nothing outside the conversion child ever loads
 * it — the studio's runtime and its browser bundle never see this module's
 * one dependency.
 */

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
export function looksLikeBoardPart(name: string): boolean {
  return name === 'board' || /_pcb(#\d+)?$/i.test(name);
}

/** The index of the part that is the board body, or `undefined`. */
export function findBoardPart(parts: readonly MeshPart[]): number | undefined {
  const at = parts.findIndex((p) => looksLikeBoardPart(p.name));
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

/**
 * The whole board-texturing pass: find the board body among `parts`, split
 * it into top/bottom/edge, paint the top and bottom with `art`'s rasters and
 * the edge a flat dark colour. `parts` unchanged when there is no board-like
 * part or no `art`.
 */
export async function applyBoardTexture(parts: readonly MeshPart[], art: BoardArt | undefined): Promise<MeshPart[]> {
  if (art === undefined) return [...parts];
  const at = findBoardPart(parts);
  if (at === undefined) return [...parts];
  const board = parts[at]!;
  const split = splitBoardFaces(board);
  if (split === undefined) return [...parts];
  // a board STEP may carry a separate, uncoloured "…_soldermask" solid
  // coincident with the board surface (a thin rim/pad outline, not a full
  // covering — occt-import-js reads it as its own body's
  // real-board check on PCA-00109). Z-fighting against the painted top/bottom
  // faces would otherwise hide the art behind its flat default grey.
  const withoutSoldermask = parts.filter((_, i) => i === at || !/soldermask/i.test(parts[i]!.name));
  const bounds = boundsOfXY(board);
  const [topPng, bottomPng] = await Promise.all(
    [art.top, art.bottom].map(async (svg) => {
      const sizeMm = svgSizeMm(svg) ?? { width: bounds.maxX - bounds.minX || 1, height: bounds.maxY - bounds.minY || 1 };
      return rasterizeSvg(svg, boardRasterSize(sizeMm));
    }),
  );
  // the texture is the paint now — drop whichever flat STEP/assembly colour the split faces inherited
  const { color: _topColour, ...topRest } = split.top;
  const { color: _bottomColour, ...bottomRest } = split.bottom;
  const top: MeshPart = { ...topRest, uv: boardFaceUv(split.top, bounds, false), image: topPng };
  const bottom: MeshPart = { ...bottomRest, uv: boardFaceUv(split.bottom, bounds, true), image: bottomPng };
  const edge: MeshPart = { ...split.edge, color: BOARD_EDGE_COLOUR };
  const out = [...withoutSoldermask];
  out.splice(out.indexOf(board), 1, top, bottom, edge);
  return out;
}
