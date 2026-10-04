/**
 * The live catalog, loaded the way a browser-path test can load it: the
 * committed files read through Vite's `import.meta.glob` (as raw text, at test
 * time only — the app bundle carries no catalog data) into a
 * `memoryCatalogSource`, so the catalog's own
 * loaders run with `node:fs` still the throwing shim.
 *
 * `cableListRows()` builds `/cables`' rows by the same rule the API uses
 * (`cable-list.ts`), from the same inputs `GET /api/designs` reads.
 */

import { createCatalog, memoryCatalogSource, type Catalog } from '@cable-studio/catalog';
import type { DrawingMeta } from '@cable-studio/docs';

import { cableListEntry, type CableListEntry } from '../src/cable-list.ts';

const files = import.meta.glob(
  [
    '../../../packages/catalog/data/*.json',
    '../../../packages/catalog/data/{designs,vocab,tags,builds,drawings}/*.json',
    '!**/*.photo-ref.json',
  ],
  { eager: true, query: '?raw', import: 'default' },
) as Record<string, string>;

let catalog: Catalog | undefined;
export function liveCatalogInMemory(): Catalog {
  catalog ??= createCatalog(memoryCatalogSource(files, { prefix: '/packages/catalog/data/', name: 'the catalog (in memory)' }));
  return catalog;
}

export function cableListRows(): CableListEntry[] {
  const c = liveCatalogInMemory();
  const db = c.loadDb();
  const makers = new Map((db.vocab?.manufacturers?.entries ?? []).map((e) => [e.id, e.label] as const));
  const wireVendors = Object.fromEntries(
    c.loadWireRecipes().flatMap((r) => (r.manufacturer === undefined ? [] : [[r.id, makers.get(r.manufacturer) ?? r.manufacturer]])),
  );
  return c.listDesignIds().map((id) => {
    const drawing = c.readJsonFile<DrawingMeta>(`drawings/${id}.json`);
    return cableListEntry(c.loadDesign(id), db, {
      wireVendors,
      ...(drawing === undefined ? {} : { drawing }),
    });
  });
}
