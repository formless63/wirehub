/**
 * The per-org catalog snapshot (`specs/postgres-backend.md` §2, "Snapshot
 * cache and invalidation").
 *
 * `catalog_head.version` is the correctness rule: every request asks for it
 * (one round trip, `studio.head_version`), and a mismatch reloads every row
 * of the org in one REPEATABLE READ READ ONLY transaction and renders them
 * through the codec into the same file text the file backend holds. The
 * catalog loaders then read that text (`createCatalog(memoryCatalogSource(…))`),
 * so the `Db` is the file backend's by construction.
 *
 * `LISTEN studio_catalog` only pre-warms: a notification starts the reload
 * before the next request asks. Concurrent requests share one load.
 */

import pg from 'pg';

import { createCatalog, memoryCatalogSource, type Catalog, type CatalogSource } from '@wirehub/catalog';
import { codePointCompare, dataFileMap, render, type CatalogRows, type FileContent } from '@wirehub/catalog/src/codec/index.ts';
import { sql } from 'kysely';

import { catalogHeadVersion, inOrg, type Db } from './db.ts';
import { readRows } from './rows.ts';
import type { StudioEvent } from '../events.ts';

export interface Snapshot {
  /** `catalog_head.version` the rows were read at */
  readonly version: string;
  readonly rows: CatalogRows;
  /** every text file of the catalog, `data/…` and `depictions/…`, as the file backend would hold it */
  readonly files: ReadonlyMap<string, FileContent>;
  /** `data/` as a catalog source (paths relative to `data/`) */
  readonly source: CatalogSource;
  /** the catalog loaders over `source` */
  readonly catalog: Catalog;
  /** sha256 of a binary file by its `data/…` / `depictions/…` path */
  readonly blobOf: ReadonlyMap<string, string>;
  /** how long the load took, ms (S4) */
  readonly loadMs: number;
}

/** Load the snapshot of `orgId` now. */
export async function loadSnapshot(db: Db, orgId: string): Promise<Snapshot> {
  const started = performance.now();
  const { version, rows } = await inOrg(
    db,
    orgId,
    async (tx) => {
      const head = (await sql<{ version: string }>`SELECT version::text AS version FROM studio.catalog_head`.execute(tx)).rows[0];
      if (head === undefined) throw new Error(`org ${orgId} has no catalog head row`);
      return { version: head.version, rows: await readRows(tx) };
    },
    { snapshot: true, statementTimeoutMs: 60_000 },
  );
  return snapshotOf(version, rows, performance.now() - started);
}

/** Render rows into a snapshot (also what tests and the gate use on rows they hold). */
export function snapshotOf(version: string, rows: CatalogRows, loadMs = 0): Snapshot {
  const files = render(rows);
  const source = memoryCatalogSource(dataFileMap(files), { name: `the database catalog (version ${version})` });
  const blobOf = new Map<string, string>();
  for (const a of rows.artwork) blobOf.set(`data/designs/_versions/${a.design}/artwork/${a.name}`, a.sha256);
  for (const f of rows.depictionFiles) blobOf.set(`depictions/${f.def}/${f.name}`, f.sha256);
  for (const f of rows.files) blobOf.set(f.path, f.sha256);
  return { version, rows, files, source, catalog: createCatalog(source), blobOf, loadMs };
}

/** The snapshot cache of one org in this process. */
export class SnapshotCache {
  readonly db: Db;
  readonly orgId: string;
  private current: Snapshot | undefined;
  private loading: Promise<Snapshot> | undefined;
  private listener: pg.Client | undefined;
  /** `close()` was called: no listener starts or keeps running, no notification starts a reload */
  private closed = false;
  private checked: { at: number; version: Promise<string> } | undefined;
  /**
   * How long one version answer is reused, ms. A request reads several
   * stores back to back; each would otherwise ask the database again. Short
   * enough that a commit elsewhere is seen by the next request; a commit in
   * this process calls `invalidate()`.
   */
  readonly reuseMs: number;

  constructor(db: Db, orgId: string, options: { reuseMs?: number } = {}) {
    this.db = db;
    this.orgId = orgId;
    this.reuseMs = options.reuseMs ?? 50;
  }

  /** `catalogVersion()`: the head version, as text (one round trip, shared by calls within `reuseMs`). */
  version(): Promise<string> {
    const now = performance.now();
    if (this.checked !== undefined && now - this.checked.at <= this.reuseMs) return this.checked.version;
    const version = catalogHeadVersion(this.db, this.orgId).then((v) => {
      if (v === undefined) throw new Error(`org ${this.orgId} has no catalog head row`);
      return v;
    });
    this.checked = { at: now, version };
    version.catch(() => {
      if (this.checked?.version === version) this.checked = undefined;
    });
    return version;
  }

  /** Forget the last version answer (after a commit in this process). */
  invalidate(): void {
    this.checked = undefined;
  }

  /** Forget the loaded snapshot too: the next read reloads every row (a repair must see what bypassed a commit). */
  discard(): void {
    this.current = undefined;
    this.checked = undefined;
  }

  /** A commit in this process hands over the snapshot it produced: no reload for it. */
  prime(snapshot: Snapshot): void {
    if (this.current === undefined || BigInt(snapshot.version) >= BigInt(this.current.version)) this.current = snapshot;
    this.checked = { at: performance.now(), version: Promise.resolve(snapshot.version) };
  }

  /** The snapshot at the current head version (reloaded when the head moved). */
  async get(): Promise<Snapshot> {
    const version = await this.version();
    if (this.current?.version === version) return this.current;
    return this.reload();
  }

  /** The last snapshot loaded, without asking the database (undefined before the first load). */
  peek(): Snapshot | undefined {
    return this.current;
  }

  private reload(): Promise<Snapshot> {
    this.loading ??= loadSnapshot(this.db, this.orgId)
      .then((snapshot) => {
        // never go backwards: a slow load must not replace a newer one
        if (this.current === undefined || BigInt(snapshot.version) >= BigInt(this.current.version)) this.current = snapshot;
        return this.current;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  /**
   * `LISTEN studio_catalog` on a dedicated connection: a commit's NOTIFY
   * starts the reload early. Optional — the version check alone is correct.
   */
  async listen(url: string, events?: { deliver(event: StudioEvent): void }): Promise<void> {
    if (this.listener !== undefined || this.closed) return;
    const client = new pg.Client({ connectionString: url, application_name: 'wirehub-listen' });
    client.on('error', (error) => {
      console.warn(`[pg] LISTEN connection lost (${error.message}); snapshots still follow the version check`);
      if (this.listener === client) this.listener = undefined;
      // a lost connection is closed, not forgotten: its socket must not outlive the cache
      client.end().catch(() => {});
    });
    client.on('notification', (message) => {
      if (message.payload === undefined || this.closed) return;
      try {
        const payload = JSON.parse(message.payload) as { org?: string; version?: string; record?: string };
        if (payload.org !== this.orgId) return;
        if (message.channel === 'studio_catalog') {
          this.invalidate();
          if (payload.version !== this.current?.version) void this.reload().catch(() => {});
          if (payload.version !== undefined) events?.deliver({ type: 'catalog', version: payload.version });
        } else if (message.channel === 'studio_locks' && payload.record !== undefined) events?.deliver({ type: 'locks', record: payload.record });
      } catch {
        // not ours
      }
    });
    try {
      await client.connect();
      await client.query('LISTEN studio_catalog');
      await client.query('LISTEN studio_locks');
    } catch (error) {
      // a connection that never got to listen is still a connection: close it before reporting
      await client.end().catch(() => {});
      throw error;
    }
    // closed while connecting: this client must not outlive the cache
    if (this.closed) {
      await client.end().catch(() => {});
      return;
    }
    this.listener = client;
  }

  /**
   * Stop listening and let go of every connection of this cache: the LISTEN
   * client, and any load a notification started (it holds a pool connection,
   * which the pool's `end` would otherwise wait for).
   */
  async close(): Promise<void> {
    this.closed = true;
    const client = this.listener;
    this.listener = undefined;
    if (client !== undefined) await client.end().catch(() => {});
    await this.loading?.catch(() => {});
  }
}

/** The text files of a snapshot in path order (for exports and diffs). */
export function snapshotTextFiles(snapshot: Snapshot): [string, string][] {
  return [...snapshot.files.entries()]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => codePointCompare(a, b));
}
