/** Source-identified PCB mask surfaces can carry the same supplied artwork as the board. */
import type { MeshPart } from './mesh.ts';

/** Exact labels supplied by the occurrence-aware STEP reader, never inferred mesh names. */
export interface SourceIdentifiedPart extends MeshPart {
  sourceProductName?: string;
  sourceOccurrenceName?: string;
  sourceAssemblyPath?: string;
}

interface CoatingBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The exporter explicitly declares this surface's role with its product/instance suffix. */
export function isSourceSolderMask(part: SourceIdentifiedPart): boolean {
  return [part.sourceProductName, part.sourceOccurrenceName].some((name) => name !== undefined && /_soldermask$/i.test(name));
}

/** The role suffix and exact source assembly context bind mask paint to its board. */
export function isCoatingOfBoard(part: SourceIdentifiedPart, board: SourceIdentifiedPart): boolean {
  const boardStem = board.sourceProductName?.match(/^(.+)_pcb$/i)?.[1];
  const maskStem = part.sourceProductName?.match(/^(.+)_soldermask$/i)?.[1];
  return boardStem !== undefined && maskStem === boardStem && board.sourceAssemblyPath !== undefined
    && board.sourceAssemblyPath.length > 0 && part.sourceAssemblyPath === board.sourceAssemblyPath;
}

/**
 * Paint identified mask shell faces, retaining their actual source geometry.
 * Call only for an opted-in occurrence profile with a uniquely identified board
 * and its two supplied rasters. Anonymous surfaces and other products retain
 * their source appearance, even when their bounds coincide with the board.
 */
export function textureBoardCoatings(
  parts: readonly SourceIdentifiedPart[],
  bounds: CoatingBounds,
  images: { top: Uint8Array; bottom: Uint8Array },
  board: SourceIdentifiedPart,
): SourceIdentifiedPart[] {
  const out: SourceIdentifiedPart[] = [];
  for (const part of parts) {
    if (!isCoatingOfBoard(part, board)) {
      out.push(part);
      continue;
    }
    const groups: Record<'top' | 'bottom' | 'edge', number[]> = { top: [], bottom: [], edge: [] };
    for (let t = 0; t < part.indices.length; t += 3) {
      const a = part.indices[t]!;
      const b = part.indices[t + 1]!;
      const c = part.indices[t + 2]!;
      const p = part.positions;
      const bx = p[b * 3]! - p[a * 3]!;
      const by = p[b * 3 + 1]! - p[a * 3 + 1]!;
      const bz = p[b * 3 + 2]! - p[a * 3 + 2]!;
      const cx = p[c * 3]! - p[a * 3]!;
      const cy = p[c * 3 + 1]! - p[a * 3 + 1]!;
      const cz = p[c * 3 + 2]! - p[a * 3 + 2]!;
      const nz = bx * cy - by * cx;
      const normalZ = nz / (Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, nz) || 1);
      groups[normalZ > 0.5 ? 'top' : normalZ < -0.5 ? 'bottom' : 'edge'].push(a, b, c);
    }
    if (groups.top.length === 0 && groups.bottom.length === 0) {
      out.push(part);
      continue;
    }
    for (const side of ['top', 'bottom', 'edge'] as const) {
      const indices = groups[side];
      if (indices.length === 0) continue;
      const split = { ...part, name: `${part.name}-${side}`, indices: Uint32Array.from(indices) };
      if (side === 'edge') {
        out.push(split);
        continue;
      }
      const uv = new Float32Array(part.positions.length / 3 * 2);
      const spanX = bounds.maxX - bounds.minX || 1;
      const spanY = bounds.maxY - bounds.minY || 1;
      for (const v of indices) {
        const x = (part.positions[v * 3]! - bounds.minX) / spanX;
        uv[v * 2] = side === 'bottom' ? 1 - x : x;
        uv[v * 2 + 1] = 1 - (part.positions[v * 3 + 1]! - bounds.minY) / spanY;
      }
      // The supplied raster is the face's paint; preserve all source identity and geometry.
      const { color: _color, ...rest } = split;
      out.push({ ...rest, uv, image: images[side] });
    }
  }
  return out;
}
