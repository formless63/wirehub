/**
 * The workbench's default dependency wiring: the catalog directory as the
 * store, and the definition library re-read per request.
 *
 * Shared by every host — `plugin.ts`'s Vite dev-server plugin and
 * `hono-adapter.ts`'s standalone server — so neither one hand-rolls its own
 * idea of "the real catalog", and the two hosts can never quietly drift apart
 * on what `/api/*` is backed by.
 *
 * Re-read on purpose. A host lives for hours (or, for the standalone server,
 * days) while its own endpoints rewrite the files under `data/`; a db cached
 * at startup would validate this afternoon's save against this morning's
 * parts list. Four JSON files is a cheap read.
 */

import { existsSync, readFileSync } from 'node:fs';

import { dataPath, loadDb } from '@cable-studio/catalog';

import type { WorkbenchDeps } from './api.ts';
import { fileAssetStore } from './assets.ts';
import { fileModelLinkStore } from './models/links.ts';
import { fileModelCache } from './models/cache.ts';
import { fileBuildsStore } from './builds.ts';
import { fileDefinitionStore } from './definition-store.ts';
import { fileDesignStore } from './designs.ts';
import { fileDrawingStore } from './drawings.ts';
import { fileTagStore, fileVocabStore } from './vocab-store.ts';
import { fileWireLibraryStore } from './wire-library.ts';
import { fileVersionStore } from './versions.ts';
import { localStudioUser } from './me.ts';
import { memoryLockStore } from './locks/lock-store.ts';
import { fileCatalogVersion } from './storage/catalog-version.ts';
import { registry } from './modules.ts';

/** A catalog data file, parsed; `undefined` when it is not there. */
function rawJson(relative: string): unknown {
  const path = dataPath(relative);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}

export function defaultWorkbenchDeps(): WorkbenchDeps {
  // one asset store, shared: `drawings` dedups every photo it is handed
  // against exactly this store, and `assets` is what the picker lists
  const assets = fileAssetStore();
  return {
    designs: fileDesignStore(),
    definitions: fileDefinitionStore(),
    drawings: fileDrawingStore(assets),
    assets,
    // the Library's 3D model links (50a.55): data/models.json, bytes in `assets`
    modelLinks: fileModelLinkStore(),
    // converted models (gitignored cache)
    modelCache: fileModelCache(),
    vocab: fileVocabStore(),
    tags: fileTagStore(),
    wireLibrary: fileWireLibraryStore(),
    builds: fileBuildsStore(),
    versions: fileVersionStore(),
    loadDb,
    // the unit of work reuses the loaded db until one of its files changes (50a.49)
    catalogVersion: () => fileCatalogVersion(dataPath('')),
    // the catalog's part-number configuration, as stored (absent: the scheme's defaults)
    loadPartNumberFiles: () => ({ scheme: rawJson('part-numbers.json') }),
    // who a studio without a login names (read once: env, else git config)
    localUser: localStudioUser(process.env),
    // edit leases: in memory — one process, and a
    // restart just means every holder re-takes its lease on the next heartbeat
    locks: memoryLockStore(),
    // the deployment's modules (modules.config.ts)
    modules: registry,
  };
}
