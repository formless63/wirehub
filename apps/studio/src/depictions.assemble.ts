/**
 * Depiction modules assembled into a `DepictionSource` — the pure half of
 * `depictions.browser.ts` (no bundler globs), so the server's headless renders
 * (`server/render/depictions.ts`) assemble a source the way the browser does.
 */

import { parseDepictionMeta, type DepictionMeta } from '@wirehub/catalog';
import type { DepictionArtwork, DepictionSource } from '@wirehub/editor-react';

/** File extension → media type, for the raster tier's data URIs. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** The raw modules a glob hands back, keyed by path. */
export interface DepictionModules {
  /** `…/depictions/<defId>/meta.json` → the parsed manifest JSON */
  meta: Record<string, unknown>;
  /** `…/depictions/<defId>/<file>.svg` → the file's source text */
  vector: Record<string, string>;
  /** `…/depictions/<defId>/<file>.png` → a `data:` URI (Vite's `?inline`) */
  raster?: Record<string, string>;
}

/** `…/depictions/PCA-00114-rev2/board-top.svg` → `PCA-00114-rev2`. */
export function defIdOf(path: string): string | undefined {
  const parts = path.split('/');
  return parts[parts.length - 2];
}

function fileNameOf(path: string): string | undefined {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Assemble a `DepictionSource` from globbed modules.
 *
 * Pure and glob-agnostic so it can be tested without a bundler. It follows the
 * catalog loader's manners exactly: **nothing throws**. A manifest that will
 * not parse simply never enters the index, an asset file that is missing or
 * whose manifest names a path (rather than a plain file name) comes back
 * `undefined`, and in both cases the layout pass records its own diagnostic and
 * draws the abstract block — the same fallback the command-line renderer takes.
 */
export function assembleDepictionSource(modules: DepictionModules): DepictionSource {
  const index: Record<string, DepictionMeta> = {};
  for (const [path, raw] of Object.entries(modules.meta)) {
    const defId = defIdOf(path);
    if (defId === undefined) continue;
    const parsed = parseDepictionMeta(raw, `depictions/${defId}`);
    // the manifest's own defId is the one that counts, as it does on disk;
    // a directory/defId mismatch is the catalog's build to fail, not ours
    if (parsed.meta !== undefined && parsed.meta.defId === defId) index[defId] = parsed.meta;
  }

  /** `<defId>/<file>` → bytes, in whichever form the renderer wants them. */
  const files = new Map<string, DepictionArtwork>();
  const collect = (
    source: Record<string, string> | undefined,
    make: (value: string, file: string) => DepictionArtwork | undefined,
  ): void => {
    for (const [path, value] of Object.entries(source ?? {})) {
      const defId = defIdOf(path);
      const file = fileNameOf(path);
      if (defId === undefined || file === undefined) continue;
      const artwork = make(value, file);
      if (artwork !== undefined) files.set(`${defId}/${file}`, artwork);
    }
  };

  collect(modules.vector, (source) => ({ kind: 'vector', source }));
  collect(modules.raster, (value, file) => {
    const dot = file.lastIndexOf('.');
    if (dot === -1 || MEDIA_TYPES[file.slice(dot).toLowerCase()] === undefined) return undefined;
    // `?inline` yields a data URI; anything else would be a URL out of the
    // bundle, which the schematic's "no external references" rule forbids
    return value.startsWith('data:') ? { kind: 'raster', dataUri: value } : undefined;
  });

  return {
    meta: (defId) => index[defId],
    artwork: (defId, view) => {
      const asset = index[defId]?.views[view];
      if (asset === undefined) return undefined;
      // a manifest may only name a plain file inside its own directory
      if (asset.file.includes('/') || asset.file.includes('\\') || asset.file.includes('..')) {
        return undefined;
      }
      const artwork = files.get(`${defId}/${asset.file}`);
      // the manifest's declared kind decides how the renderer embeds it, so a
      // file whose bytes arrived in the other form is not usable art
      return artwork?.kind === asset.kind ? artwork : undefined;
    },
  };
}


/**
 * A saved revision's own artwork: versions copy their
 * parts' depiction files when saved, so an old revision draws exactly what
 * it was released with. `covered` are the definitions whose artwork the
 * revision fixes — they draw only from `own` (a part that had no artwork then
 * stays an abstract block); anything else (a part added while the revision is
 * unlocked, or every part of a v1 file that kept only hashes) draws from `live`.
 */
export function versionDepictionSource(own: DepictionModules, covered: ReadonlySet<string>, live: DepictionSource): DepictionSource {
  const inner = assembleDepictionSource(own);
  return {
    meta: (defId) => (covered.has(defId) ? inner.meta(defId) : live.meta(defId)),
    artwork: (defId, view) => (covered.has(defId) ? inner.artwork(defId, view) : live.artwork(defId, view)),
  };
}
