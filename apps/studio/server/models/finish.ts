/**
 * The last step every conversion shares: keep the model under the triangle
 * budget, lay a multi-file part out, write the GLB, and say what happened.
 */

import { writeGlb, type GlbExtras } from './glb.ts';
import { layOut, simplify, triangleCount, type MeshPart } from './mesh.ts';

export interface ConversionStats {
  /** triangles in the stored model */
  triangles: number;
  /** triangles before any simplification */
  sourceTriangles: number;
  simplified: boolean;
  parts: number;
  glbBytes: number;
  ms?: number;
  peakRssMb?: number;
  tessellatedTriangles?: number;
  deflection?: number;
  /** an assembly's model files OpenCascade could not read, left out */
  unreadModels?: string[];
}

/** The triangle budget for one stored model — enough for a housing at print detail. */
export const MAX_MODEL_TRIANGLES = 300_000;

/**
 * `arrange`: the parts are separate files of one part (a housing's top and
 * bottom) and may be set side by side; never for one file's own bodies —
 * a board's components overlap its laminate on purpose.
 */
export function finishParts(
  parts: readonly MeshPart[],
  maxTriangles: number,
  extras: GlbExtras = {},
  arrange = false,
): { glb: Uint8Array; stats: ConversionStats } {
  const source = triangleCount(parts);
  let out = [...parts];
  if (source > maxTriangles) {
    // each part keeps its share of the budget, but never below a floor that
    // would turn a small part into a blob; a textured part (a board face,
    //) is exempt — clustering would scramble its uv
    out = parts.map((part) => (part.uv !== undefined ? part : simplify(part, Math.max(2_000, Math.floor((maxTriangles * part.indices.length) / 3 / source)))));
  }
  if (arrange) out = layOut(out);
  const glb = writeGlb(out, extras);
  return {
    glb,
    stats: { triangles: triangleCount(out), sourceTriangles: source, simplified: source > maxTriangles, parts: out.length, glbBytes: glb.byteLength },
  };
}
