/**
 * Depiction loader.
 *
 *   import { loadDepictions, loadDepiction } from '@wirehub/catalog/…/depictions';
 *   const { index, issues } = loadDepictions(loadDb());
 *
 * Reads `packages/catalog/depictions/<def-id>/meta.json`, parses it
 * structurally, then validates it referentially. Loading is a pure read: each
 * call returns fresh objects, and — like `core`'s validators — it never throws
 * on bad data. A depiction directory that cannot be read at all becomes an
 * issue, not an exception.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db, Issue } from '@wirehub/model';

import { parseDepictionMeta, validateDepiction } from './validate.ts';
import type { DepictionIndex, DepictionMeta } from './model.ts';

/** Absolute path of this package's `depictions/` directory. */
export function depictionsRoot(): string {
  // beside a catalog kept elsewhere (WIREHUB_CATALOG_DIR names its data/), like dataPath
  const elsewhere = typeof process === 'undefined' ? undefined : process.env?.WIREHUB_CATALOG_DIR;
  if (elsewhere !== undefined && elsewhere !== '') return join(elsewhere, '..', 'depictions');
  return fileURLToPath(new URL('../../depictions/', import.meta.url));
}

/** Absolute path of one definition's depiction directory. */
export function depictionDir(defId: string, root = depictionsRoot()): string {
  return join(root, defId);
}

/** Definition ids that have a depiction directory, in sorted order. */
export function listDepictionDefIds(root = depictionsRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, name, 'meta.json')))
    .sort();
}

export interface LoadedDepiction {
  meta?: DepictionMeta;
  issues: Issue[];
}

/** One depiction, parsed and validated. */
export function loadDepiction(
  defId: string,
  options: { db?: Db; root?: string } = {},
): LoadedDepiction {
  const root = options.root ?? depictionsRoot();
  const dir = depictionDir(defId, root);
  const file = join(dir, 'meta.json');
  const where = `depictions/${defId}`;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      issues: [
        {
          code: 'unreadable-depiction',
          severity: 'error',
          message: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
          where,
        },
      ],
    };
  }

  const parsed = parseDepictionMeta(raw, where);
  if (parsed.meta === undefined) return { issues: parsed.issues };

  const issues = [...parsed.issues];
  if (parsed.meta.defId !== defId) {
    issues.push({
      code: 'defid-directory-mismatch',
      severity: 'error',
      message: `meta.json declares defId '${parsed.meta.defId}' but sits in directory '${defId}'`,
      where,
    });
  }
  issues.push(
    ...validateDepiction(parsed.meta, {
      dir,
      ...(options.db === undefined ? {} : { db: options.db }),
    }),
  );
  return { meta: parsed.meta, issues };
}

export interface LoadedDepictions {
  index: DepictionIndex;
  issues: Issue[];
}

/**
 * Every depiction in the package, keyed by definition id. Pass a `db` to have
 * anchor ids checked against the definitions they claim.
 */
export function loadDepictions(db?: Db, root = depictionsRoot()): LoadedDepictions {
  const index: DepictionIndex = {};
  const issues: Issue[] = [];
  for (const defId of listDepictionDefIds(root)) {
    const loaded = loadDepiction(defId, { root, ...(db === undefined ? {} : { db }) });
    issues.push(...loaded.issues);
    if (loaded.meta !== undefined) index[defId] = loaded.meta;
  }
  return { index, issues };
}

/**
 * Absolute path of one view's asset file, or `undefined` when the manifest
 * names something outside its own directory (a path separator or a `..` hop is
 * a manifest bug, never a legitimate asset).
 */
function assetPath(
  meta: DepictionMeta,
  view: string,
  root: string,
): string | undefined {
  const asset = meta.views[view];
  if (asset === undefined) return undefined;
  if (asset.file.includes('/') || asset.file.includes('\\') || asset.file.includes('..')) {
    return undefined;
  }
  const file = join(depictionDir(meta.defId, root), asset.file);
  return existsSync(file) ? file : undefined;
}

/**
 * The raw bytes of one view's asset — SVG source for vector art, so the
 * renderer can inline it as a `<g>`.
 */
export function readDepictionAsset(
  meta: DepictionMeta,
  view: string,
  root = depictionsRoot(),
): string | undefined {
  const file = assetPath(meta, view, root);
  if (file === undefined) return undefined;
  return readFileSync(file, 'utf8');
}

/** File extension → media type, for the raster tier's data URIs. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * One view's asset as a `data:` URI, so raster art embeds into a drawing that
 * must stay self-contained (no `<image href="…file.png">` ever leaves the SVG).
 * `undefined` when the file is missing or its extension is not a known image
 * type — the caller falls back rather than emitting a broken reference.
 */
export function readDepictionAssetDataUri(
  meta: DepictionMeta,
  view: string,
  root = depictionsRoot(),
): string | undefined {
  const file = assetPath(meta, view, root);
  if (file === undefined) return undefined;
  const dot = file.lastIndexOf('.');
  const media = dot === -1 ? undefined : MEDIA_TYPES[file.slice(dot).toLowerCase()];
  if (media === undefined) return undefined;
  return `data:${media};base64,${readFileSync(file).toString('base64')}`;
}
