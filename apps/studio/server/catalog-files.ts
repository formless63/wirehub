/**
 * Catalog files as the hub sees them: the catalog's own file with the
 * installed packs under it (`@wirehub/catalog`, `catalogWithPacksSource`).
 *
 * Installed packs live in their own directory (`WIREHUB_PACKS_DIR`: the
 * container's `/data/packs`, a checkout's gitignored `data/packs/`), never in
 * the starter catalog. A store reads a file through `readCatalogText` (the
 * merged view), and before writing it asks `localValueFor` for the part that
 * belongs in the catalog's own file: the records a pack supplies unchanged are
 * left out, so an edit never copies a pack into the catalog — only an edited
 * pack record is stored locally, where it shadows the pack's.
 *
 * Derived tag tables (`tags/signal-tags.json` …) cover every record, packs'
 * included; once a pack is installed they are written beside the packs
 * (`<packs>/derived/`, read above the catalog) instead of into it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { catalogWithPacksSource, dataPath, derivedDir, fsCatalogSource, installedPackSources, livePacksDir, localPartOf, readInstalledPacks, type CatalogSource } from '@wirehub/catalog';

/**
 * The catalog as the hub sees it: the catalog's own directory with the installed packs under it (and the
 * derived files above), read per call. What every file store reads through, so a pack's builds, drawing
 * sidecars, saved versions and model links are seen as the database's flattened catalog holds them (S1).
 */
export function hubCatalogSource(): CatalogSource {
  const root = dataPath('');
  const packs = livePacksDir();
  if (packs === undefined) return fsCatalogSource(root, 'the catalog');
  return catalogWithPacksSource(root, packs, { name: 'the catalog', first: () => [fsCatalogSource(derivedDir(packs), 'derived files')] });
}

/** A catalog file's text, merged over the installed packs; `undefined` when no layer has it. */
export function readCatalogText(relative: string): string | undefined {
  return hubCatalogSource().read(relative);
}

/** A catalog file, parsed, merged over the installed packs; `undefined` when no layer has it. */
export function readCatalogJson<T>(relative: string): T | undefined {
  const text = readCatalogText(relative);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

/**
 * The value to store in the catalog's own `relative` for the merged `value`
 * a store is writing; `undefined` when nothing belongs there (the file does
 * not exist and every record came unchanged from a pack).
 */
export function localValueFor<T>(relative: string, value: T): T | undefined {
  const packs = livePacksDir();
  if (packs === undefined) return value;
  return localPartOf(relative, value, installedPackSources(packs), existsSync(dataPath(relative))) as T | undefined;
}

/** Whether any pack is installed in the live packs directory. */
export function packsInstalled(): boolean {
  const packs = livePacksDir();
  return packs !== undefined && readInstalledPacks(packs).packs.length > 0;
}

/**
 * Absolute path a derived file is written to: beside the packs once one is
 * installed (so a pack's records never reach the catalog's derived tables),
 * else the catalog's own file.
 */
export function derivedPath(relative: string): string {
  const packs = livePacksDir();
  return packs !== undefined && packsInstalled() ? join(derivedDir(packs), relative) : dataPath(relative);
}
