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
import type { DepictionDeps, DepictionStore } from '../depictions.ts';
import { memoryLockStore } from '../locks/lock-store.ts';
import { localStudioUser } from '../me.ts';
import { fileModelCache } from '../models/cache.ts';
import { registry } from '../modules.ts';
import { PgConfigError, pgAppConfigFromEnv, redactUrl } from './config.ts';
import { inOrg, openPg, resolveOrgId, type Db, type PgHandle } from './db.ts';
import { migrationFiles, MIGRATION_SCHEMA } from './migrate.ts';
import { exportSnapshot } from './export.ts';
import { pgCommit } from './commit.ts';
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
    modelCache: fileModelCache(),
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
    blob: async (sha) => {
      const row = (await cache.get()).rows?.blobs.find((b) => b.sha256 === sha);
      if (row === undefined || options.blobs === undefined) return undefined;
      const bytes = await options.blobs.get(blobObjectKey(cache.orgId, sha));
      return bytes === undefined ? undefined : { bytes: new Uint8Array(bytes), mediaType: row.mediaType };
    },
    localUser: localStudioUser(process.env),
    locks: memoryLockStore(),
    modules: registry,
  };
}

/** Refuse to serve a database whose schema is behind the code, or whose catalog is ahead of the model. */
export async function checkDatabase(db: Db, orgId: string): Promise<void> {
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
  const schema = await inOrg(db, orgId, async (tx) => (await sql<{ schema_version: number }>`SELECT schema_version FROM studio.catalog_head`.execute(tx)).rows[0]?.schema_version);
  if (schema !== undefined && schema > CURRENT_SCHEMA_VERSION) {
    throw new PgConfigError(`The catalog is at design schema ${schema}; this studio reads up to ${CURRENT_SCHEMA_VERSION}. Upgrade the studio.`);
  }
}

export interface PgBackend {
  handle: PgHandle;
  cache: SnapshotCache;
  deps: WorkbenchDeps;
  /** the artwork routes' deps, over the same stores (B7) */
  depictionDeps: DepictionDeps;
  close(): Promise<void>;
}

/** Open the Postgres backend from the environment: connect, check, warm the snapshot, listen. */
export async function openPgBackend(env: Record<string, string | undefined>, options: { blobs?: BlobStore; depictionsDir?: string; listen?: boolean } = {}): Promise<PgBackend> {
  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { applicationName: 'wirehub-studio' });
  try {
    const orgId = await resolveOrgId(handle.db, config.org);
    if (orgId === undefined) {
      throw new PgConfigError(
        config.org === undefined
          ? `${redactUrl(config.url)} holds no org (or more than one). Import a catalog first (\`pnpm --filter studio pg:import --create-org\`), or set WIREHUB_ORG.`
          : `${redactUrl(config.url)} has no org '${config.org}'.`,
      );
    }
    await checkDatabase(handle.db, orgId);
    const cache = new SnapshotCache(handle.db, orgId);
    const snapshot = await cache.get();
    if (options.blobs === undefined && snapshot.rows.blobs.length > 0) {
      throw new PgConfigError(`The catalog holds ${snapshot.rows.blobs.length} binary file(s) in the blob store; set WIREHUB_BLOBS (s3 or fs:<dir>) to serve them.`);
    }
    if (options.listen !== false) await cache.listen(config.url).catch((error: unknown) => console.warn(`[pg] LISTEN unavailable: ${error instanceof Error ? error.message : String(error)}`));
    const deps = pgWorkbenchDeps({ cache, db: handle.db, ...(options.blobs === undefined ? {} : { blobs: options.blobs }), ...(options.depictionsDir === undefined ? {} : { depictionsDir: options.depictionsDir }) });
    return {
      handle,
      cache,
      deps,
      depictionDeps: { store: deps.depictions as DepictionStore, loadDb: deps.loadDb, loadDesigns: async () => (await cache.get()).catalog.loadDesigns() },
      close: async () => {
        await cache.close();
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
