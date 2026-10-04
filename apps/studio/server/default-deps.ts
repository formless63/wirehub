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

import { dataPath, loadDb } from '@wirehub/catalog';

import type { WorkbenchDeps } from './api.ts';
import { fileAssetStore } from './assets.ts';
import type { BlobStore } from './blobs.ts';
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
import { memoryEventHub } from './events.ts';
import { defaultDepictionDeps, fileDepictionStore, type DepictionDeps } from './depictions.ts';
import { fileDocStore } from './storage/doc-store.ts';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { exportTree } from './pg/export.ts';
import { backendFromEnv, type Backend } from './pg/config.ts';

/** A catalog data file, parsed; `undefined` when it is not there. */
function rawJson(relative: string): unknown {
  const path = dataPath(relative);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}

export function defaultWorkbenchDeps(options: { blobs?: BlobStore } = {}): WorkbenchDeps {
  // one asset store, shared: `drawings` dedups every photo it is handed
  // against exactly this store, and `assets` is what the picker lists; its
  // bytes go to the blob store when the host configured one (WIREHUB_BLOBS)
  const assets = fileAssetStore(options.blobs);
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
    // artwork and catalog documents, staged like the rest (B7)
    depictions: fileDepictionStore(),
    docs: fileDocStore(),
    versions: fileVersionStore(),
    loadDb,
    // the unit of work reuses the loaded db until one of its files changes (50a.49)
    catalogVersion: () => fileCatalogVersion(dataPath('')),
    // GET /api/blobs/:sha: the file backend's content-addressed files are its uploads
    blob: async (sha) => {
      const found = await assets.get(sha);
      return found === undefined ? undefined : { bytes: new Uint8Array(found.bytes), mediaType: found.record.mime };
    },
    // GET /api/export: the catalog's text files, the same shape the database backend answers
    exportCatalog: async () => exportTree(readCatalogTree(dataPath('..')), fileCatalogVersion(dataPath(''))),
    // the catalog's part-number configuration, as stored (absent: the scheme's defaults)
    loadPartNumberFiles: () => ({ scheme: rawJson('part-numbers.json') }),
    // who a studio without a login names (read once: env, else git config)
    localUser: localStudioUser(process.env),
    // edit leases: in memory — one process, and a
    // restart just means every holder re-takes its lease on the next heartbeat
    locks: memoryLockStore(),
    // what changed, for GET /api/events: this process is the only writer
    events: memoryEventHub(),
    // the deployment's modules (modules.config.ts)
    modules: registry,
    // first-run setup: domain modules' packs go into the live catalog; the
    // container image sets WIREHUB_SETUP_PROMPT=1 so a fresh hub opens on /setup
    setup: {
      dataDir: dataPath(''),
      prompt: process.env.WIREHUB_SETUP_PROMPT === '1',
      now: () => new Date().toISOString(),
    },
  };
}

/**
 * The deps `WIREHUB_BACKEND` picks (`specs/postgres-backend.md` §2): the file
 * stores above (`files`, the default), or the Postgres backend (`pg`, read-only
 * until its write path lands). The pg module is loaded only when asked for.
 */
export async function workbenchDepsFromEnv(
  env: Record<string, string | undefined>,
  options: { blobs?: BlobStore } = {},
): Promise<{ backend: Backend; deps: WorkbenchDeps; depictionDeps: DepictionDeps; describe: string; close: () => Promise<void>; pg?: { db: import('./pg/db.ts').Db; orgId: string; url: string } }> {
  const backend = backendFromEnv(env);
  if (backend === 'files') {
    return { backend, deps: defaultWorkbenchDeps(options), depictionDeps: defaultDepictionDeps(), describe: 'files (packages/catalog/data)', close: async () => {} };
  }
  const { openPgBackend } = await import('./pg/deps.ts');
  const pg = await openPgBackend(env, options);
  const snapshot = pg.cache.peek();
  return {
    backend,
    deps: pg.deps,
    depictionDeps: pg.depictionDeps,
    describe: `pg (org ${pg.cache.orgId}, catalog version ${snapshot?.version ?? '?'})`,
    close: pg.close,
    pg: { db: pg.handle.db, orgId: pg.cache.orgId, url: (env.DATABASE_URL ?? '').trim() },
  };
}
