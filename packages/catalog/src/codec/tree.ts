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

import { canonicalPackText, catalogWithPacksSource, installedPackDir, installedPackSources, mergeCatalogFile, packAssetFiles, packFiles, readInstalledPacks } from '../packs.ts';
import { fsCatalogSource } from '../source.ts';
import { canonicalJson, codePointCompare, explode, isSkippedPath, isTextPath, type BlobRef, type CatalogFiles } from './index.ts';

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
  const sources = installedPackSources(packsDir);
  // a pack's depictions are not catalog documents: they are `depictions/<def>/…` files (below)
  const isDepiction = (relative: string): boolean => relative.startsWith('depictions/');
  for (const pack of sources) for (const relative of packFiles(pack.root as string)) if (!isDepiction(relative)) relatives.add(relative);
  if (existsSync(derived)) for (const relative of packFiles(derived)) relatives.add(relative);
  const out = new Map<string, string | Uint8Array | BlobRef>([...base.entries()].filter(([path]) => !path.startsWith('data/')));
  for (const relative of [...relatives].sort(codePointCompare)) {
    const own = base.get(`data/${relative}`);
    if (own !== undefined && typeof own !== 'string') {
      out.set(`data/${relative}`, own);
      continue;
    }
    const text = source.read(relative);
    // what only a pack (or the derived files) supplies is stored canonical, as the install would have written it
    if (text !== undefined) out.set(`data/${relative}`, own === undefined ? canonicalPackText(relative, text) : text);
  }
  // an installed pack's images and manifests: `depictions/<def>/…` beside the catalog's own (which win),
  // a pack's other binary art under `data/art/`; bytes, held as blobs by the codec
  for (const pack of sources) {
    const root = pack.root as string;
    const add = (path: string, relative: string): void => {
      if (out.has(path)) return;
      out.set(path, isTextPath(path) ? canonicalPackText(relative, readFileSync(join(root, relative), 'utf8')) : new Uint8Array(readFileSync(join(root, relative))));
    };
    for (const relative of packFiles(root)) if (isDepiction(relative) && !isSkippedPath(relative)) add(relative, relative);
    for (const relative of packAssetFiles(root)) add(isDepiction(relative) ? relative : `data/${relative}`, relative);
  }
  // the stored selection and the install record live beside the packs: at the data root, flattened
  const record = readInstalledPacks(dataDir);
  const packs = [...record.packs.filter((p) => !installed.packs.some((q) => q.id === p.id)), ...installed.packs];
  if (packs.length > 0) out.set('data/packs.json', canonicalJson({ ...record, src: installed.src ?? record.src, packs }));
  if (existsSync(packSetup)) out.set('data/setup.json', readFileSync(packSetup, 'utf8'));
  return new Map([...out.entries()].sort(([a], [b]) => codePointCompare(a, b)));
}

/**
 * Which packs supply each file of the flattened catalog: flat path (`data/…`, `depictions/…`)
 * → the ids of the installed packs whose layer holds it. A file the catalog also has of its own
 * is still listed (it is merged); a path no pack holds is the catalog's own.
 */
export function packOrigins(packsDir: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (packsDir === undefined) return out;
  for (const pack of readInstalledPacks(packsDir).packs) {
    const dir = installedPackDir(packsDir, pack.id);
    if (!existsSync(dir)) continue;
    for (const relative of [...packFiles(dir), ...packAssetFiles(dir)]) {
      const flat = relative.startsWith('depictions/') ? relative : `data/${relative}`;
      out.set(flat, [...(out.get(flat) ?? []), pack.id]);
    }
  }
  return out;
}

/**
 * Words for where a file the codec complained about came from, for an error naming it:
 * "(from pack 'x')", "(merged from the catalog and pack 'x')" or "(the catalog's own file)".
 */
export function describeOrigin(path: string, origins: ReadonlyMap<string, string[]>, ownFiles: ReadonlySet<string>): string {
  const packs = origins.get(path);
  if (packs === undefined || packs.length === 0) return "the catalog's own file";
  const names = `${packs.length === 1 ? 'pack' : 'packs'} ${packs.map((id) => `'${id}'`).join(', ')}`;
  return ownFiles.has(path) ? `merged from the catalog and ${names}` : `from ${names}`;
}

/**
 * Annotate the codec's errors (`<path>: …`) with where their file came from, so an operator knows whether
 * to fix the catalog or the pack. An error that names no known path is returned as it is.
 */
export function annotateErrors(errors: readonly string[], root: string, packsDir: string | undefined): string[] {
  const origins = packOrigins(packsDir);
  const own = new Set<string>();
  const ownTree = readCatalogTree(root);
  for (const path of ownTree.keys()) own.add(path);
  return errors.map((error) => {
    const path = /^((?:data|depictions)\/[^:\s]+): /.exec(error)?.[1];
    return path === undefined ? error : `${error} [${describeOrigin(path, origins, own)}]`;
  });
}

/**
 * What the Postgres codec would refuse once this pack is installed into the catalog at `root` (with
 * its packs in `packsDir`): the sentences `explode` reports over the flattened catalog with the pack's
 * documents merged in, that it did not already report without them, and those over the pack's own
 * documents alone (a pack that replaces an installed one is read on its own too). Binary files are
 * left out (the codec's checks of documents do not read them). Empty: the pack would import.
 */
export function packCodecProblems(root: string, packsDir: string | undefined, packDir: string): string[] {
  const text = (files: CatalogFiles): Map<string, string> => new Map([...files].filter((e): e is [string, string] => typeof e[1] === 'string'));
  const current = text(readFlattenedCatalog(root, packsDir));
  const next = new Map(current);
  const alone = new Map<string, string>();
  for (const relative of packFiles(packDir)) {
    const flat = relative.startsWith('depictions/') ? relative : `data/${relative}`;
    const packText = canonicalPackText(relative, readFileSync(join(packDir, relative), 'utf8'));
    alone.set(flat, packText);
    const have = next.get(flat);
    next.set(flat, have === undefined ? packText : mergeCatalogFile(relative, [have, packText]));
  }
  const known = new Set(explode(current).errors);
  // a pack reads on its own without the catalog's other files: what it cites there is not its problem
  const crossFile = /not in assets\/index\.json|no entry of assets\/index\.json names it/;
  const found = [...explode(next).errors, ...explode(alone).errors.filter((e) => !crossFile.test(e))].filter((e) => !known.has(e));
  return [...new Set(found)];
}
