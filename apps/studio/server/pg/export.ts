/**
 * The on-demand export (`specs/postgres-backend.md` §7.6, task A9): the
 * current snapshot rendered as a file catalog — `data/` and `depictions/`
 * text, byte-identical to what the file backend would hold. Blobs (uploads,
 * saved artwork, depiction images) are never included unless asked for.
 *
 * The result is a valid file catalog: it can be committed to git, opened by
 * the file backend, or loaded into another deployment with `pg:import`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ASSET_MIME_EXT, codePointCompare, render, sha256Hex, type CatalogFiles } from '@wirehub/catalog/src/codec/index.ts';

import type { BlobStore } from '../blobs.ts';
import { blobObjectKey } from './keys.ts';
import type { Snapshot } from './snapshot.ts';

export interface CatalogExport {
  format: 'wirehub-catalog-export';
  format_version: 1;
  /** the catalog version exported (`catalog_head.version`; `files` for the file backend) */
  version: string;
  /** path (`data/…`, `depictions/…`) → text */
  files: Record<string, string>;
  /** binary files left out, path → sha256 */
  blobs: Record<string, string>;
}

export function exportSnapshot(snapshot: Snapshot): CatalogExport {
  const files: Record<string, string> = {};
  for (const [path, content] of [...snapshot.files.entries()].sort(([a], [b]) => codePointCompare(a, b))) {
    if (typeof content === 'string') files[path] = content;
  }
  const blobs: Record<string, string> = {};
  for (const a of snapshot.rows.assets) blobs[`data/assets/${a.sha256}.${ASSET_MIME_EXT[a.mime] ?? 'bin'}`] = a.sha256;
  for (const [path, sha] of snapshot.blobOf) blobs[path] = sha;
  return { format: 'wirehub-catalog-export', format_version: 1, version: snapshot.version, files, blobs: Object.fromEntries(Object.entries(blobs).sort(([a], [b]) => codePointCompare(a, b))) };
}

/** The same shape over a file catalog tree (the file backend's `GET /api/export`). */
export function exportTree(tree: CatalogFiles, version: string): CatalogExport {
  const files: Record<string, string> = {};
  const blobs: Record<string, string> = {};
  for (const [path, content] of [...tree.entries()].sort(([a], [b]) => codePointCompare(a, b))) {
    if (typeof content === 'string') files[path] = content;
    else blobs[path] = sha256Hex(content);
  }
  return { format: 'wirehub-catalog-export', format_version: 1, version, files, blobs };
}

/** Write the export into `outDir` (`<outDir>/data/…`); with `blobs`, the binary files too. Returns the number of files written. */
export async function writeExport(snapshot: Snapshot, outDir: string, options: { blobs?: BlobStore; orgId?: string } = {}): Promise<number> {
  const bytes = new Map<string, Uint8Array>();
  if (options.blobs !== undefined && options.orgId !== undefined) {
    for (const b of snapshot.rows.blobs) {
      const got = await options.blobs.get(blobObjectKey(options.orgId, b.sha256));
      if (got !== undefined) bytes.set(b.sha256, new Uint8Array(got));
    }
  }
  const files = render(snapshot.rows, { blobs: (sha) => bytes.get(sha) });
  for (const [path, content] of files) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return files.size;
}
