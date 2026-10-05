/**
 * `pgWorkbenchDeps` — `defaultWorkbenchDeps()` on Postgres
 * (`specs/postgres-backend.md` §4). Picked by `WIREHUB_BACKEND=pg`
 * (`default-deps.ts`); the handlers, the model and the browser do not change.
 *
 * Phase A: every read is the database's (through the snapshot); writes
 * answer 503 until Phase B. Still on the file side, by design for now: the
 * converted-model cache (gitignored, rebuilt — B10 moves it to derived
 * blobs), edit locks in memory (B6), depictions in the file tree (B7).
 */

import { sql } from 'kysely';
import { CURRENT_SCHEMA_VERSION } from '@wirehub/model';

import type { WorkbenchDeps } from '../api.ts';
import type { BlobStore } from '../blobs.ts';
import type { BackupControl, BackupStatus } from '../backup/status.ts';
import type { DepictionDeps, DepictionStore } from '../depictions.ts';
import { memoryLockStore } from '../locks/lock-store.ts';
import { localStudioUser } from '../me.ts';
import { fileModelCache } from '../models/cache.ts';
import { registry } from '../modules.ts';
import { PgConfigError, pgAppConfigFromEnv, redactUrl } from './config.ts';
import { inOrg, openPg, orgCount, resolveOrgId, type Db, type PgHandle } from './db.ts';
import { migrationFiles, MIGRATION_SCHEMA } from './migrate.ts';
import { exportSnapshot } from './export.ts';
import { pgCommit } from './commit.ts';
import { pgModelCache } from './model-cache.ts';
import { pgSetupDeps } from './setup.ts';
import { claimSetupDeps, emptyDepictionStore, ownerCount, setupModeDeps } from './setup-mode.ts';
import { authRequested } from '../auth/config.ts';
import type { StudioAuth } from '../auth/studio-auth.ts';
import { parseSuggestedModules } from '../setup.ts';
import { pgLockStore } from './locks.ts';
import type { PgBoss } from 'pg-boss';
import { remoteConvert } from '../jobs/convert.ts';
import { stageImportInput } from '../jobs/import.ts';
import { modelCacheTrigger } from '../jobs/model-cache.ts';
import { notifierFromEnv } from '../jobs/notify.ts';
import { createJobService, inlineJobRunner } from '../jobs/service.ts';
import { JOB_KINDS } from '../jobs/types.ts';
import { bossJobRunner, lastBeat, pgJobHandlers, pgJobStore, startBoss } from './jobs.ts';
import { deliveredEventHub, type EventHub } from '../events.ts';
import { blobObjectKey } from './keys.ts';
import { SnapshotCache, type Snapshot } from './snapshot.ts';
import {
  pgAssetStore,
  pgBuildsStore,
  pgCommitReadOnly,
  pgDefinitionStore,
  pgDepictionStore,
  pgDocStore,
  pgDesignStore,
  pgDrawingStore,
  pgModelLinkStore,
  pgTagStore,
  pgVersionStore,
  pgVocabStore,
  pgWireLibraryStore,
  type PgReadContext,
} from './stores.ts';

/** Where the snapshot stores read: the pg cache, or (the gate's file side) a snapshot of a directory. */
export interface SnapshotSource {
  readonly orgId: string;
  get(): Promise<Snapshot>;
  version(): Promise<string>;
}

export interface PgDepsOptions {
  cache: SnapshotSource;
  /** the database: given (with a SnapshotCache), the studio writes; absent, it is read-only */
  db?: Db;
  /** the event stream, fed by LISTEN (`SnapshotCache.listen`) */
  events?: EventHub;
  blobs?: BlobStore;
  /** where today's depiction artwork lives (the file tree until B7); absent → versions copy none */
  depictionsDir?: string;
}

export function pgWorkbenchDeps(options: PgDepsOptions): WorkbenchDeps {
  const { cache } = options;
  const context: PgReadContext = { snapshot: () => cache.get(), blobs: options.blobs, orgId: cache.orgId };
  const assets = pgAssetStore(context);
  return {
    designs: pgDesignStore(context),
    definitions: pgDefinitionStore(context),
    drawings: pgDrawingStore(context, assets),
    assets,
    modelLinks: pgModelLinkStore(context),
    // converted models: derived blobs in the database when it has one (B10), else the gitignored file cache
    modelCache: options.db !== undefined ? pgModelCache(options.db, cache.orgId, options.blobs) : fileModelCache(),
    vocab: pgVocabStore(context),
    tags: pgTagStore(context),
    wireLibrary: pgWireLibraryStore(context),
    builds: pgBuildsStore(context),
    versions: pgVersionStore(context, options.depictionsDir),
    loadDb: async () => (await cache.get()).catalog.loadDb(),
    catalogVersion: () => cache.version(),
    loadPartNumberFiles: async () => {
      const text = (await cache.get()).source.read('part-numbers.json');
      return text === undefined ? {} : { scheme: JSON.parse(text) as unknown };
    },
    depictions: pgDepictionStore(context),
    docs: pgDocStore(context),
    commit:
      options.db !== undefined && cache instanceof SnapshotCache
        ? pgCommit({ db: options.db, cache, ...(options.blobs === undefined ? {} : { blobs: options.blobs }), verify: process.env.WIREHUB_BLOB_VERIFY !== 'off' })
        : pgCommitReadOnly,
    exportCatalog: async () => exportSnapshot(await cache.get()),
    // the indicator: the database is the history (plan §7.6, D6) — its last change set
    ...(options.db === undefined ? {} : { backup: databaseBackupControl(options.db, cache.orgId) }),
    blob: async (sha) => {
      const row = (await cache.get()).rows?.blobs.find((b) => b.sha256 === sha);
      if (row === undefined || options.blobs === undefined) return undefined;
      const bytes = await options.blobs.get(blobObjectKey(cache.orgId, sha));
      return bytes === undefined ? undefined : { bytes: new Uint8Array(bytes), mediaType: row.mediaType };
    },
    localUser: localStudioUser(process.env),
    // one lease table for every process when there is a database (B6)
    locks: options.db !== undefined ? pgLockStore(options.db, cache.orgId) : memoryLockStore(),
    ...(options.events === undefined ? {} : { events: options.events }),
    modules: registry,
  };
}

/** Refuse to serve a database whose schema is behind the code, or whose catalog is ahead of the model. */
export async function checkDatabase(db: Db, orgId: string | undefined): Promise<void> {
  let applied: string[];
  try {
    applied = (await sql<{ name: string }>`SELECT name FROM ${sql.table(`${MIGRATION_SCHEMA}.kysely_migration`)}`.execute(db)).rows.map((r) => r.name);
  } catch {
    throw new PgConfigError('The database has no migrations applied. Run `pnpm --filter studio db:migrate` first.');
  }
  const pending = migrationFiles()
    .map((m) => m.name)
    .filter((name) => !applied.includes(name));
  if (pending.length > 0) throw new PgConfigError(`The database is missing migration(s) ${pending.join(', ')}. Run \`pnpm --filter studio db:migrate\` first.`);
  if (orgId === undefined) return;
  const schema = await inOrg(db, orgId, async (tx) => (await sql<{ schema_version: number }>`SELECT schema_version FROM studio.catalog_head`.execute(tx)).rows[0]?.schema_version);
  if (schema !== undefined && schema > CURRENT_SCHEMA_VERSION) {
    throw new PgConfigError(`The catalog is at design schema ${schema}; this studio reads up to ${CURRENT_SCHEMA_VERSION}. Upgrade the studio.`);
  }
}

export interface PgBackend {
  handle: PgHandle;
  /** the org's snapshot cache (throws while the hub is in first-run setup) */
  readonly cache: SnapshotCache;
  /** the workbench deps: one object, filled in place when first-run setup creates the org */
  deps: WorkbenchDeps;
  /** the artwork routes' deps, over the same stores (B7) */
  depictionDeps: DepictionDeps;
  /** the org id, once there is one */
  orgId(): string | undefined;
  /** true until first-run setup created the org (plan §9.1) */
  setupMode(): boolean;
  /** the sign-in, for the admin account first-run setup makes */
  attachAuth(auth: StudioAuth | undefined): void;
  close(): Promise<void>;
}

export interface OpenPgOptions {
  blobs?: BlobStore;
  /**
   * Who runs jobs: the worker process through pg-boss (`worker`, the
   * default), or this process (`inline`, `WIREHUB_WORKER=off`: no worker
   * service; STEP uploads then convert in the studio, as on files).
   */
  jobs?: 'worker' | 'inline';
  depictionsDir?: string;
  listen?: boolean;
  setupCode?: string;
}

/**
 * Open the Postgres backend from the environment: connect, check, warm the
 * snapshot, listen. A database with no org yet starts in **setup mode**
 * (plan §9.1): every API route but `/api/setup` answers 503, and `/setup`
 * creates the org, its catalog and the admin, then the same deps object is
 * filled with the org's stores — no restart.
 */
export async function openPgBackend(env: Record<string, string | undefined>, options: OpenPgOptions = {}): Promise<PgBackend> {
  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { applicationName: 'wirehub-studio' });
  const caches: SnapshotCache[] = [];
  try {
    await checkDatabase(handle.db, undefined);
    let orgId = await resolveOrgId(handle.db, config.org);
    if (orgId === undefined && config.org !== undefined) throw new PgConfigError(`${redactUrl(config.url)} has no org '${config.org}'.`);
    // no org at all: first-run setup; several and none named: refuse
    if (orgId === undefined && (await orgCount(handle.db)) > 0) {
      throw new PgConfigError(`${redactUrl(config.url)} holds more than one org; set WIREHUB_ORG to the one this studio serves.`);
    }
    await checkDatabase(handle.db, orgId);
    const deps = {} as WorkbenchDeps;
    const depictionDeps = {} as DepictionDeps;
    const events = deliveredEventHub();
    let current: SnapshotCache | undefined;
    let boss: Promise<PgBoss> | undefined;
    let claimPending = false;
    let auth: StudioAuth | undefined;
    const suggested = parseSuggestedModules(env.WIREHUB_SUGGESTED_MODULES);

    const activate = async (id: string): Promise<void> => {
      const cache = new SnapshotCache(handle.db, id);
      caches.push(cache);
      const snapshot = await cache.get();
      if (options.blobs === undefined && snapshot.rows.blobs.length > 0) {
        throw new PgConfigError(`The catalog holds ${snapshot.rows.blobs.length} binary file(s) in the blob store; set WIREHUB_BLOBS (s3 or fs:<dir>) to serve them.`);
      }
      if (options.listen !== false) await cache.listen(config.url, events).catch((error: unknown) => console.warn(`[pg] LISTEN unavailable: ${error instanceof Error ? error.message : String(error)}`));
      const real = pgWorkbenchDeps({ cache, db: handle.db, events, ...(options.blobs === undefined ? {} : { blobs: options.blobs }), ...(options.depictionsDir === undefined ? {} : { depictionsDir: options.depictionsDir }) });
      // jobs (Phase C): recorded in job_run; run by the worker through pg-boss, or here
      const store = pgJobStore(handle.db, id);
      const jobMode = options.jobs ?? (env.WIREHUB_WORKER === 'off' ? 'inline' : 'worker');
      const notify = notifierFromEnv(env);
      const runner =
        jobMode === 'worker'
          ? bossJobRunner(() => (boss ??= startBoss(config.url, 'studio')), () => id)
          : inlineJobRunner(store, () => pgJobHandlers({ deps: real, db: handle.db, orgId: id, cache, ...(options.blobs === undefined ? {} : { blobs: options.blobs }), env, notify }));
      const kinds = JOB_KINDS.filter((k) => k !== 'convert' || (jobMode === 'worker' && options.blobs !== undefined));
      real.jobs = createJobService({
        store,
        runner,
        kinds,
        worker: () => lastBeat(handle.db, id),
        stageInput: async (bytes) => ({ ...(await stageImportInput(bytes, options.blobs, id)) }),
      });
      real.afterCommit = modelCacheTrigger(() => deps.jobs);
      // a STEP upload converts in the worker, whose memory budget is sized for it (S6)
      if (jobMode === 'worker' && options.blobs !== undefined) real.convertModel = remoteConvert({ jobs: real.jobs, blobs: options.blobs, orgId: () => id });
      // first-run setup installs the domain modules' packs into the database (WIREHUB_SETUP_PROMPT as on files)
      const stored = snapshot.source.read('setup.json');
      const completed = stored !== undefined && (JSON.parse(stored) as { completed?: boolean }).completed === true;
      real.setup = pgSetupDeps(real, cache, {
        // a hub whose setup completed never prompts again (and the boot banner stays quiet)
        prompt: env.WIREHUB_SETUP_PROMPT === '1' && !completed,
        now: () => new Date().toISOString(),
        ...(options.setupCode === undefined ? {} : { code: options.setupCode }),
        ...(suggested === undefined ? {} : { suggested }),
      });
      // an org nobody owns yet (a file deployment the migrate step adopted) with sign-in on: the first
      // admin is claimed at /setup with the setup code; until then the hub stays in setup mode
      if (authRequested(env) && (await ownerCount(handle.db, id)) === 0) {
        claimPending = true;
        const realSetup = real.setup;
        real.setupMode = () => claimPending;
        real.setup = claimSetupDeps({
          db: handle.db,
          orgId: id,
          base: realSetup,
          ...(options.setupCode === undefined ? {} : { code: options.setupCode }),
          auth: () => auth,
          done: () => {
            claimPending = false;
            delete deps.setupMode;
            deps.setup = realSetup;
          },
        });
      }
      // the host may have set what the browser shows about the instance: it stays
      const instance = deps.instance;
      for (const key of Object.keys(deps)) delete (deps as unknown as Record<string, unknown>)[key];
      Object.assign(deps, real, instance === undefined ? {} : { instance });
      Object.assign(depictionDeps, { store: real.depictions as DepictionStore, loadDb: real.loadDb, loadDesigns: async () => (await cache.get()).catalog.loadDesigns() });
      current = cache;
      orgId = id;
    };

    if (orgId !== undefined) await activate(orgId);
    else {
      Object.assign(
        deps,
        setupModeDeps({
          db: handle.db,
          ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
          ...(options.setupCode === undefined ? {} : { code: options.setupCode }),
          ...(suggested === undefined ? {} : { suggested }),
          auth: () => auth,
          activate: async (id) => {
            await activate(id);
            return deps;
          },
        }),
      );
      Object.assign(depictionDeps, { store: emptyDepictionStore(), loadDb: () => deps.loadDb() });
    }
    return {
      handle,
      get cache(): SnapshotCache {
        if (current === undefined) throw new Error('this hub has no organisation yet: finish first-run setup');
        return current;
      },
      deps,
      depictionDeps,
      orgId: () => orgId,
      setupMode: () => current === undefined || claimPending,
      attachAuth: (value) => {
        auth = value;
      },
      close: async () => {
        if (boss !== undefined) await (await boss.catch(() => undefined))?.stop({ graceful: false }).catch(() => undefined);
        for (const cache of caches) await cache.close();
        await handle.close();
      },
    };
  } catch (error) {
    for (const cache of caches) await cache.close();
    await handle.close();
    throw error;
  }
}

/** `GET /api/backup` on the database backend: `{ state: 'database', lastChangeSet }` (plan §7.6). */
export function databaseBackupControl(db: Db, orgId: string): BackupControl {
  return {
    async status(): Promise<BackupStatus> {
      const last = await inOrg(db, orgId, async (tx) =>
        (await sql<{ version: string; at: Date; by: string }>`SELECT catalog_version::text AS version, created_at AS at, actor_label AS by FROM studio.change_set ORDER BY id DESC LIMIT 1`.execute(tx)).rows[0],
      );
      return {
        enabled: true,
        state: 'database',
        message: 'Every save is a change set in the database; backups are database dumps.',
        lastCommit: null,
        lastPush: null,
        pendingCommits: 0,
        remote: '',
        branch: '',
        nextAttemptAt: null,
        lastChangeSet: last === undefined ? null : { version: last.version, at: last.at.toISOString(), by: last.by },
      };
    },
    retry() {},
  };
}
