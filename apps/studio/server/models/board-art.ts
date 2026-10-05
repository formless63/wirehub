/**
 * A board's Gerber art on its 3D model (cs-5k1.29).
 *
 * The model-cache job paints `depictions/<id>/board-top.svg` and
 * `board-bottom.svg` onto the board body (`board-texture.ts`) when they are
 * among a link's `files`. This is how they get there: the art files of a
 * board whose depiction is gerber-tier, with the sha256 each has, and the
 * re-keyed link — the cache key (`sourceKey`) depends on the art, so a new
 * art import builds a new model and the old key simply stops being live.
 * Only gerber-tier art is painted: the KiCad tier is an outline and pads,
 * which the model already shows as geometry.
 */

import type { DepictionStore } from '../depictions.ts';
import { isArtFile, sha256Hex, sourceKey, type SourceFile } from './cache.ts';
import { MAX_MODEL_TRIANGLES } from './finish.ts';
import { budgetOf } from './build.ts';
import type { ModelLink } from './links.ts';

const TOP = 'board-top.svg';
const BOTTOM = 'board-bottom.svg';

/** The art files to paint on `defId`'s board, or `[]` when it has no gerber-tier top and bottom. */
export async function boardArtFiles(depictions: DepictionStore | undefined, defId: string): Promise<SourceFile[]> {
  if (depictions === undefined) return [];
  const meta = await depictions.readMeta(defId);
  const views = (meta as { views?: Record<string, { sourceKind?: unknown; file?: unknown }> } | undefined)?.views;
  if (views === undefined || typeof views !== 'object') return [];
  if (views['board-top']?.sourceKind !== 'gerber' || views['board-bottom']?.sourceKind !== 'gerber') return [];
  const out: SourceFile[] = [];
  for (const file of [BOTTOM, TOP]) {
    const bytes = await depictions.readAsset(defId, file);
    if (bytes === undefined) return [];
    out.push({ path: `depictions/${defId}/${file}`, sha256: sha256Hex(bytes) });
  }
  return out;
}

/**
 * `link` with its art files replaced by `art`, re-keyed; `undefined` when
 * nothing changes (an upload, a link that is not built from sources, the
 * same art already there).
 */
export function relinkWithArt(link: ModelLink, art: readonly SourceFile[]): ModelLink | undefined {
  if (link.files === undefined) return undefined;
  const have = link.files.filter((f) => isArtFile(f.path));
  const same = have.length === art.length && art.every((a) => have.some((h) => h.path === a.path && h.sha256 === a.sha256));
  if (same) return undefined;
  const budget = budgetOf(link) ?? MAX_MODEL_TRIANGLES;
  const files = [...link.files.filter((f) => !isArtFile(f.path)), ...art];
  return { ...link, files, asset: sourceKey(files, budget, link.build) };
}
