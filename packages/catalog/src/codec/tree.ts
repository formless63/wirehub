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

import { catalogWithPacksSource, installedPackSources, packFiles, readInstalledPacks } from '../packs.ts';
import { fsCatalogSource } from '../source.ts';
import { canonicalJson, codePointCompare, isSkippedPath, isTextPath, type BlobRef, type CatalogFiles } from './index.ts';

/** `<packs>/derived/` (as `@wirehub/catalog`'s `derivedDir`, without importing the package's entry) */
const derivedDir = (packsDir: string): string => join(packsDir, 'derived');

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

/**
 * A file catalog with its installed packs (`WIREHUB_PACKS_DIR`), flattened:
 * every file as the live catalog reads it (derived files, then the catalog's
 * own, then the packs, merged record by record — `catalogWithPacksSource`),
 * plus the packs directory's `packs.json` and `setup.json` at the data root.
 * The database backend holds a catalog this way: its packs are ordinary
 * records, as the installer used to merge them. Without a packs directory (or
 * with nothing installed) this is `readCatalogTree`.
 */
export function readFlattenedCatalog(root: string, packsDir: string | undefined): CatalogFiles {
  const base = readCatalogTree(root);
  if (packsDir === undefined) return base;
  const installed = readInstalledPacks(packsDir);
  const packSetup = join(packsDir, 'setup.json');
  if (installed.packs.length === 0 && !existsSync(packSetup)) return base;
  const dataDir = join(root, 'data');
  const derived = derivedDir(packsDir);
  const source = catalogWithPacksSource(dataDir, packsDir, { first: () => [fsCatalogSource(derived, 'derived files')] });
  const relatives = new Set<string>();
  for (const path of base.keys()) if (path.startsWith('data/')) relatives.add(path.slice('data/'.length));
  for (const pack of installedPackSources(packsDir)) for (const relative of packFiles(pack.root as string)) relatives.add(relative);
  if (existsSync(derived)) for (const relative of packFiles(derived)) relatives.add(relative);
  const out = new Map<string, string | Uint8Array | BlobRef>([...base.entries()].filter(([path]) => !path.startsWith('data/')));
  for (const relative of [...relatives].sort(codePointCompare)) {
    const own = base.get(`data/${relative}`);
    if (own !== undefined && typeof own !== 'string') {
      out.set(`data/${relative}`, own);
      continue;
    }
    const text = source.read(relative);
    if (text !== undefined) out.set(`data/${relative}`, text);
  }
  // the stored selection and the install record live beside the packs: at the data root, flattened
  const record = readInstalledPacks(dataDir);
  const packs = [...record.packs.filter((p) => !installed.packs.some((q) => q.id === p.id)), ...installed.packs];
  if (packs.length > 0) out.set('data/packs.json', canonicalJson({ ...record, src: installed.src ?? record.src, packs }));
  if (existsSync(packSetup)) out.set('data/setup.json', readFileSync(packSetup, 'utf8'));
  return new Map([...out.entries()].sort(([a], [b]) => codePointCompare(a, b)));
}
