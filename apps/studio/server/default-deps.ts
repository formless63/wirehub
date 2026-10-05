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

import type { CableDesign } from '@wirehub/model';
import type { ModuleRegistry } from '@wirehub/modules';
import { dataPath, derivedDir, installedAcross, livePacksDir, loadDb } from '@wirehub/catalog';

import type { WorkbenchDeps } from './api.ts';
import { fileAssetStore } from './assets.ts';
import type { BlobStore } from './blobs.ts';
import { rekeyBoardLinks } from './models/board-art.ts';
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
import { moduleDerivedStore } from './module-derived.ts';
import { memoryEventHub } from './events.ts';
import { defaultDepictionDeps, fileDepictionStore, type DepictionDeps } from './depictions.ts';
import { fileDocStore } from './storage/doc-store.ts';
import { checkoutPacksDir } from './env.ts';
import { parseSuggestedModules } from './setup.ts';
import { readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';
import { createHash } from 'node:crypto';
import { exportTree } from './pg/export.ts';
import { gitHistorySource } from './history/git.ts';
import { backendFromEnv, type Backend } from './pg/config.ts';
import { baseJobHandlers } from './jobs/handlers.ts';
import { createWebhookEmitter } from './webhooks/emitter.ts';
import { moduleJobHandlers, moduleJobKinds } from './jobs/module-queues.ts';
import { modelCacheTrigger } from './jobs/model-cache.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from './jobs/service.ts';
import { testDefaultsFromEnv } from './documents.ts';
import { pdfEngineFromEnv } from './render/browser-pdf.ts';
import { DEFAULT_AUTH_DATA_DIR } from './auth/config.ts';
import { createRuntimeSettings, type RuntimeSettings } from './runtime-settings.ts';
import { fileSecretStore, settingsCipherFromEnv, type SecretStore } from './settings-secrets.ts';
import type { Env } from './env.ts';

/** A catalog data file, parsed; `undefined` when it is not there. */
function rawJson(relative: string): unknown {
  const path = dataPath(relative);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}

export interface DefaultDepsOptions {
  /** the module registry; default: the build's own (`modules.config.ts`) */
  modules?: ModuleRegistry;
  blobs?: BlobStore;
  /** the first-run setup code (`WIREHUB_SETUP_CODE`, or one `serve.ts` made up); absent: none asked */
  setupCode?: string;
  /** the environment the runtime settings lie under (default `process.env`) */
  env?: Env;
}

export { settingsCipherFromEnv };

/** Where the file backend keeps the secrets entered in Settings: beside the sign-in data, never in the catalog. */
export function fileSecretsPath(env: Env): string {
  return `${(env['AUTH_DATA_DIR'] ?? '').trim() || DEFAULT_AUTH_DATA_DIR}/settings-secrets.json`;
}

/** The file backend's runtime settings: the catalog's settings documents, the secrets file, refreshed on every commit. */
export function fileRuntimeSettings(deps: WorkbenchDeps, env: Env, secrets: SecretStore = fileSecretStore(fileSecretsPath(env))): RuntimeSettings {
  const cipher = settingsCipherFromEnv(env);
  const settings = createRuntimeSettings({ env, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', ...(cipher === undefined ? {} : { cipher }) });
  settings.follow(deps.events);
  return settings;
}

const DEPICTION_MEDIA: Readonly<Record<string, string>> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2' };

/** The binary files a pack installs beside the catalog: its vendor PDFs (`docs/`, `assets/`) and fonts. */
const PACK_BLOB_PATH = /^data\/(?:docs|pack-assets|fonts)\//;

/**
 * A depiction file (the base's `depictions/`, a pack's) by content address:
 * the database backend serves every binary file of the catalog from its blob
 * store, so the file backend answers for the same set (S1).
 */
export function depictionBlob(sha: string, packsDir: string | undefined, root: string = dataPath('..')): { bytes: Uint8Array; mediaType: string; filename?: string } | undefined {
  for (const [path, content] of readFlattenedCatalog(root, packsDir)) {
    if (typeof content === 'string' || !(path.startsWith('depictions/') || PACK_BLOB_PATH.test(path))) continue;
    const bytes = content as Uint8Array;
    if (createHash('sha256').update(bytes).digest('hex') !== sha) continue;
    return { bytes: new Uint8Array(bytes), mediaType: DEPICTION_MEDIA[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream', ...(PACK_BLOB_PATH.test(path) ? { filename: path.slice(path.lastIndexOf('/') + 1) } : {}) };
  }
  return undefined;
}

export function defaultWorkbenchDeps(options: DefaultDepsOptions = {}): WorkbenchDeps {
  const modules = options.modules ?? registry;
  // one asset store, shared: `drawings` dedups every photo it is handed
  // against exactly this store, and `assets` is what the picker lists; its
  // bytes go to the blob store when the host configured one (WIREHUB_BLOBS)
  const assets = fileAssetStore(options.blobs);
  // installed packs: WIREHUB_PACKS_DIR (the hosts default it, `env.ts`), never the starter catalog
  const packsDir = livePacksDir() ?? checkoutPacksDir();
  const tags = fileTagStore();
  const suggested = parseSuggestedModules(process.env.WIREHUB_SUGGESTED_MODULES);
  const designs = fileDesignStore();
  const docs = fileDocStore();
  const derived = moduleDerivedStore(modules, {
    loadDb,
    loadDesigns: async () => (await Promise.all((await designs.list()).map((d) => designs.read(d.id)))).filter((d): d is CableDesign => d !== undefined),
    docs,
  });
  const deps: WorkbenchDeps = {
    designs,
    definitions: fileDefinitionStore(),
    drawings: fileDrawingStore(assets),
    assets,
    // the Library's 3D model links: data/models.json, bytes in `assets`
    modelLinks: fileModelLinkStore(),
    // converted models (gitignored cache)
    modelCache: fileModelCache(),
    vocab: fileVocabStore(),
    tags,
    wireLibrary: fileWireLibraryStore(),
    builds: fileBuildsStore(),
    // artwork and catalog documents, staged like the rest (B7)
    depictions: fileDepictionStore(),
    docs,
    versions: fileVersionStore(),
    loadDb,
    // which records came from a pack (read-only; fork to edit): both the layers and anything merged into the catalog
    installedPacks: () => ({ src: 'installed catalog packs', packs: installedAcross(dataPath(''), packsDir).packs }),
    // the unit of work reuses the loaded db until one of its files changes
    // …and the packs directory: an install (packs.json) or regenerated derived tags change it too
    catalogVersion: () => `${fileCatalogVersion(dataPath(''), modules.catalogDirs())}:${fileCatalogVersion(packsDir)}:${fileCatalogVersion(derivedDir(packsDir))}`,
    // GET /api/blobs/:sha: the file backend's content-addressed files are its uploads
    blob: async (sha) => {
      const found = await assets.get(sha);
      if (found !== undefined) return { bytes: new Uint8Array(found.bytes), mediaType: found.record.mime, filename: found.record.originalName };
      return depictionBlob(sha, livePacksDir());
    },
    // a restore reads an earlier drawing photo by its hash: uploads are never removed
    blobByHash: async (sha) => {
      const found = await assets.get(sha);
      return found === undefined ? undefined : new Uint8Array(found.bytes);
    },
    // GET /api/export: the catalog's text files, the same shape the database backend answers
    exportCatalog: async () => exportTree(readFlattenedCatalog(dataPath('..'), livePacksDir()), fileCatalogVersion(dataPath(''))),
    // change history: the git log of the catalog directory, when it is in a git work tree (cs-5k1.4)
    history: gitHistorySource({ dataDir: dataPath('') }),
    // the catalog's part-number configuration, as stored (absent: the scheme's defaults)
    loadPartNumberFiles: () => ({ scheme: rawJson('part-numbers.json') }),
    // who a studio without a login names (read once: env, else git config)
    localUser: localStudioUser(process.env),
    // edit leases: in memory — one process, and a
    // restart just means every holder re-takes its lease on the next heartbeat
    locks: memoryLockStore(),
    // what changed, for GET /api/events: this process is the only writer
    events: memoryEventHub(),
    // the deployment's modules (modules.config.ts), and the derived records they keep
    modules,
    ...(derived === undefined ? {} : { derived }),
    // first-run setup: domain modules' packs go into the packs directory, layered
    // under the catalog; the container image sets WIREHUB_SETUP_PROMPT=1 so a
    // fresh hub opens on /setup
    setup: {
      dataDir: dataPath(''),
      packsDir,
      prompt: process.env.WIREHUB_SETUP_PROMPT === '1',
      now: () => new Date().toISOString(),
      ...(options.setupCode === undefined ? {} : { code: options.setupCode }),
      ...(suggested === undefined ? {} : { suggested }),
      // the tag tables cover every record: rebuild them over the new packs
      // …and a board's model link is keyed to its art, which a pack update or disable may have changed (cs-d97)
      afterInstall: async () => {
        await tags.regenerate();
        await rekeyBoardLinks(deps.depictions, deps.modelLinks);
      },
    },
  };
  // jobs (imports, model builds) run in this process, one at a time, and are remembered in memory
  const jobStore = memoryJobStore();
  deps.jobs = createJobService({
    store: jobStore,
    runner: inlineJobRunner(jobStore, () => ({ ...baseJobHandlers({ deps, liveEnv: () => deps.runtimeSettings?.env() ?? process.env, ...(options.blobs === undefined ? {} : { blobs: options.blobs }) }), ...moduleJobHandlers(deps.modules, deps) }), undefined, (job) => deps.webhooks?.jobFinished(job)),
    // the module queues follow the registry: a runtime code module's queue runs here as soon as it is loaded
    kinds: () => ['import', 'model-cache', 'webhook', ...moduleJobKinds(deps.modules)],
  });
  // outbound event webhooks: deliveries are jobs, signed with a secret kept in the settings secrets store
  deps.webhooks = createWebhookEmitter({ docs: () => deps.docs, jobs: () => deps.jobs, env: () => deps.runtimeSettings?.env() ?? process.env });
  const trigger = modelCacheTrigger(() => deps.jobs);
  deps.afterCommit = async (set) => {
    await trigger(set);
    await deps.webhooks?.catalogChanged(set);
  };
  // what Settings changes without a restart (runtime-settings.ts), over this environment
  deps.runtimeSettings = fileRuntimeSettings(deps, options.env ?? process.env);
  void deps.runtimeSettings.refresh().catch((error: unknown) => console.warn(`[settings] ${error instanceof Error ? error.message : String(error)}`));
  return deps;
}

/**
 * The deps `WIREHUB_BACKEND` picks (`specs/postgres-backend.md` §2): the file
 * stores above (`files`, the default), or the Postgres backend (`pg`, read-only
 * until its write path lands). The pg module is loaded only when asked for.
 */
export async function workbenchDepsFromEnv(
  env: Record<string, string | undefined>,
  options: DefaultDepsOptions = {},
): Promise<{
  backend: Backend;
  deps: WorkbenchDeps;
  depictionDeps: DepictionDeps;
  describe: string;
  close: () => Promise<void>;
  /** the runtime settings the deps read (`runtime-settings.ts`) */
  settings: RuntimeSettings;
  pg?: { db: import('./pg/db.ts').Db; orgId: () => string | undefined; setupMode: () => boolean; url: string; attachAuth: (auth: import('./auth/studio-auth.ts').StudioAuth | undefined) => void };
}> {
  const backend = backendFromEnv(env);
  const testDefaults = testDefaultsFromEnv(env);
  // a value the environment sets that the server would refuse stops the start, as before; the engine
  // itself is read from the live settings at each print (`pdfEngineOf`), so Settings can name one
  pdfEngineFromEnv(env);
  if (backend === 'files') {
    const deps = defaultWorkbenchDeps({ ...options, env });
    if (testDefaults !== undefined) deps.testDefaults = testDefaults;
    await deps.runtimeSettings?.refresh();
    return { backend, deps, depictionDeps: defaultDepictionDeps(), describe: 'files (packages/catalog/data)', close: async () => {}, settings: deps.runtimeSettings as RuntimeSettings };
  }
  const { openPgBackend } = await import('./pg/deps.ts');
  const { pgSecretStore } = await import('./pg/settings-secrets.ts');
  // the settings read the org's documents and secrets once there is an org (after first-run setup)
  let opened: Awaited<ReturnType<typeof openPgBackend>> | undefined;
  const cipher = settingsCipherFromEnv(env);
  const settings = createRuntimeSettings({
    env,
    docs: () => opened?.deps.docs,
    secrets: () => {
      const id = opened?.orgId();
      return opened === undefined || id === undefined || opened.setupMode() ? undefined : pgSecretStore(opened.handle.db, id);
    },
    org: () => opened?.orgId() ?? 'none',
    ...(cipher === undefined ? {} : { cipher }),
  });
  const pg = await openPgBackend(env, { ...(options.blobs === undefined ? {} : { blobs: options.blobs }), ...(options.setupCode === undefined ? {} : { setupCode: options.setupCode }), runtimeSettings: settings });
  opened = pg;
  pg.deps.runtimeSettings = settings;
  await settings.refresh();
  if (testDefaults !== undefined) pg.deps.testDefaults = testDefaults;
  return {
    backend,
    deps: pg.deps,
    depictionDeps: pg.depictionDeps,
    describe: pg.setupMode() ? 'pg (no organisation yet: first-run setup creates it)' : `pg (org ${pg.orgId()}, catalog version ${pg.cache.peek()?.version ?? '?'})`,
    close: pg.close,
    settings,
    pg: { db: pg.handle.db, orgId: pg.orgId, setupMode: pg.setupMode, url: (env.DATABASE_URL ?? '').trim(), attachAuth: pg.attachAuth },
  };
}
