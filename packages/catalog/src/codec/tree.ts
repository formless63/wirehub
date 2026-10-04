/**
 * Read a catalog tree from disk for the codec: `<root>/data/**` and
 * `<root>/depictions/**`, every file whose name the codec does not skip
 * (`isSkippedPath`), text files as strings and everything else as bytes.
 *
 * `root` is a directory laid out like `packages/catalog/` (it holds `data/`
 * and, optionally, `depictions/`). Paths in the result are relative to it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { codePointCompare, isSkippedPath, isTextPath, type CatalogFiles } from './index.ts';

export function readCatalogTree(root: string, options: { dataDir?: string; depictionsDir?: string } = {}): CatalogFiles {
  const files = new Map<string, string | Uint8Array>();
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => codePointCompare(a.name, b.name))) {
      const path = `${prefix}/${entry.name}`;
      if (isSkippedPath(path)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) files.set(path, isTextPath(path) ? readFileSync(join(dir, entry.name), 'utf8') : new Uint8Array(readFileSync(join(dir, entry.name))));
    }
  };
  walk(options.dataDir ?? join(root, 'data'), 'data');
  walk(options.depictionsDir ?? join(root, 'depictions'), 'depictions');
  return files;
}
