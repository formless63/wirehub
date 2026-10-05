/**
 * Jobs on Postgres (plan Phase C): the job store over `job_run`/`job_file`;
 * the import job — in this process and through the worker (pg-boss) —
 * giving the same plan, the same publish answers and the same catalog as on
 * the file backend (the go/no-go: "an example module importer publishes
 * through the worker with the same result as on files"); the worker's boot
 * sweep building every live model key into derived blobs; its heartbeat;
 * blob GC's rules (§5.4) and the backup watch (§8.4); the derive repair.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const work = mkdtempSync(join(tmpdir(), 'wirehub-pg-jobs-'));
const catalogPackage = fileURLToPath(new URL('../../../../packages/catalog', import.meta.url));
cpSync(join(catalogPackage, 'data'), join(work, 'catalog', 'data'), { recursive: true });
// the file side of the comparison edits this copy, never the repository
process.env.WIREHUB_CATALOG_DIR = join(work, 'catalog', 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

const TETRA = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/models/tetra.stl', import.meta.url))));
const quiet = (): void => {};

describePg('jobs on Postgres', () => {
  let database: TestDatabase;
  let filesLog: string[];
  let filesExport: Record<string, string>;

  beforeAll(async () => {
    database = await freshDatabase();
    // the reference: the same scenario on the file backend
    const { defaultWorkbenchDeps } = await import('../../server/default-deps.ts');
    const { exampleRegistry } = await import('../fixtures/example-importer.ts');
    const { importScenario } = await import('../jobs-scenario.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../../server/jobs/handlers.ts');
    const deps = defaultWorkbenchDeps({ modules: exampleRegistry });
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps }), quiet), kinds: ['import'] });
    const files = await importScenario(deps);
    filesLog = files.log;
    filesExport = files.exported.files;
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  /** a database org holding the starter catalog, with the pg deps over it */
  async function starterOrg(db: TestDatabase, slug: string) {
    const { openPg } = await import('../../server/pg/db.ts');
    const { importCatalog } = await import('../../server/pg/import.ts');
    const { SnapshotCache } = await import('../../server/pg/snapshot.ts');
    const { pgWorkbenchDeps } = await import('../../server/pg/deps.ts');
    const { fsBlobStore } = await import('../../server/blobs.ts');
    const handle = openPg(db.appUrl, { max: 4 });
    const { orgId } = await importCatalog(handle.db, { org: { slug, create: true }, files: readCatalogTree(catalogPackage) });
    const blobs = fsBlobStore(join(work, `blobs-${slug}`));
    const cache = new SnapshotCache(handle.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: handle.db, blobs });
    return { handle, orgId, blobs, cache, deps };
  }

  it('runs an import in process with the same plan, answers and catalog as the file backend', async () => {
    const { exampleRegistry } = await import('../fixtures/example-importer.ts');
    const { importScenario } = await import('../jobs-scenario.ts');
    const { createJobService, inlineJobRunner } = await import('../../server/jobs/service.ts');
    const { pgJobHandlers, pgJobStore } = await import('../../server/pg/jobs.ts');
    const { handle, orgId, blobs, deps } = await starterOrg(database, 'inline');
    try {
      deps.modules = exampleRegistry;
      const store = pgJobStore(handle.db, orgId);
      deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => pgJobHandlers({ deps, db: handle.db, orgId, blobs }), quiet), kinds: ['import'] });
      const run = await importScenario(deps);
      expect(run.log).toEqual(filesLog);
      expect(run.exported.files).toEqual(filesExport);
      // the plan is job_file rows, the publish is a change set the job names
      const rows = await sql<{ path: string; status: string; change_set: string | null; source: string; actor: string }>`
        SELECT f.path, f.status, j.change_set_id::text AS change_set, s.source, s.actor_label AS actor
          FROM studio.job_run j JOIN studio.job_file f ON f.job_id = j.id JOIN studio.change_set s ON s.id = j.change_set_id`.execute(handle.db).catch(() => ({ rows: [] }));
      // RLS: nothing without the org set
      expect(rows.rows).toEqual([]);
      const { inOrg } = await import('../../server/pg/db.ts');
      const scoped = await inOrg(handle.db, orgId, async (tx) =>
        (
          await sql<{ path: string; status: string; message: string; actor: string }>`
            SELECT f.path, f.status, s.message, s.actor_label AS actor
              FROM studio.job_run j JOIN studio.job_file f ON f.job_id = j.id JOIN studio.change_set s ON s.id = j.change_set_id`.execute(tx)
        ).rows,
      );
      expect(scoped).toEqual([{ path: 'data/mechanicals.json', status: 'changed', message: expect.any(String), actor: 'Importer Person' }]);
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('works through the worker: the boot sweep builds every live model key, an import publishes as on files, and the heartbeat beats', async () => {
    const own = await freshDatabase();
    const { exampleRegistry } = await import('../fixtures/example-importer.ts');
    const { importScenario } = await import('../jobs-scenario.ts');
    const { createJobService } = await import('../../server/jobs/service.ts');
    const { bossJobRunner, lastBeat, pgJobStore, startBoss } = await import('../../server/pg/jobs.ts');
    const { startWorker } = await import('../../server/worker-run.ts');
    const { UnitOfWork } = await import('../../server/storage/unit-of-work.ts');
    const { sourceKey, sha256Hex } = await import('../../server/models/cache.ts');
    const { MAX_MODEL_TRIANGLES } = await import('../../server/models/finish.ts');
    const { handle, orgId, blobs, deps } = await starterOrg(own, 'worker');
    const sources = join(work, 'sources');
    mkdirSync(join(sources, 'housings'), { recursive: true });
    writeFileSync(join(sources, 'housings', 'tetra.stl'), TETRA);
    const files = [{ path: 'housings/tetra.stl', sha256: sha256Hex(TETRA) }];
    const key = sourceKey(files, MAX_MODEL_TRIANGLES);
    // an imported model link, committed before the worker starts (as after a restore: no derived blobs)
    const uow = new UnitOfWork(deps);
    await uow.deps.modelLinks!.put({ record: 'mechanicals/de9-backshell', asset: key, files, sourceKind: 'resin-print', src: 'synthetic example' });
    await uow.commit({ method: 'PUT', path: '/api/models/mechanicals/de9-backshell' });
    expect(await deps.modelCache!.has(key)).toBe(false);

    const logs: string[] = [];
    const worker = await startWorker(
      {
        env: { DATABASE_URL: own.appUrl, WIREHUB_MODEL_SOURCES: sources, WIREHUB_WORKER_BEAT_FILE: join(work, 'beat'), TZ: 'UTC' },
        modules: exampleRegistry,
        blobs,
        log: (line) => logs.push(line),
        attempts: 2,
      },
    );
    let studioBoss: Awaited<ReturnType<typeof startBoss>> | undefined;
    try {
      expect(worker).toBeDefined();
      expect([...worker!.kinds].sort()).toEqual(['backup', 'blob-gc', 'convert', 'derive', 'import', 'model-cache']);
      // the boot sweep
      const deadline = Date.now() + 60_000;
      while (!(await deps.modelCache!.has(key)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
      expect(await deps.modelCache!.has(key), logs.join('\n')).toBe(true);
      const store = pgJobStore(handle.db, orgId);
      const sweep = (await store.list({ kind: 'model-cache' }))[0]!;
      expect(sweep.request['reason']).toBe('boot');
      expect(sweep.status).toBe('done');
      expect((sweep.result!['built'] as { key: string }[]).map((b) => b.key)).toEqual([key]);
      const { inOrg } = await import('../../server/pg/db.ts');
      const derived = await inOrg(handle.db, orgId, async (tx) => (await sql<{ triangles: number; inputs: unknown; job_id: string }>`SELECT triangles, inputs, job_id::text AS job_id FROM studio.derived_blob WHERE key = ${key}`.execute(tx)).rows[0]);
      expect(derived?.triangles).toBe(4);
      expect(derived?.inputs).toEqual([{ kind: 'source', ref: 'housings/tetra.stl', sha256: files[0]!.sha256 }]);
      expect(derived?.job_id).toBe(sweep.id);
      // the gate's derived-blob check (C6): every live key built, the same bytes as the file backend's cache
      const { runGate } = await import('../../server/pg/gate.ts');
      const { memoryModelCache } = await import('../../server/models/cache.ts');
      const fileCache = memoryModelCache();
      const { buildLinkedModel, folderSources } = await import('../../server/models/build.ts');
      const link = (await deps.modelLinks!.list()).find((l) => l.asset === key)!;
      await fileCache.put(key, (await buildLinkedModel(link, folderSources(sources))).glb);
      const { SnapshotCache } = await import('../../server/pg/snapshot.ts');
      const gate = await runGate({ tree: readCatalogTree(catalogPackage), root: catalogPackage, pg: { db: handle.db, cache: new SnapshotCache(handle.db, orgId), blobs }, models: { fileCache } });
      expect(gate.checks.find((c) => c.name === 'derived-blobs')).toMatchObject({ compared: 1, diffs: [] });
      // the heartbeat
      const beat = await lastBeat(handle.db, orgId);
      expect(beat?.queues.sort()).toEqual([...worker!.kinds].sort());
      expect(Date.now() - Date.parse(beat!.beatAt)).toBeLessThan(60_000);

      // the studio's side: send through pg-boss, the worker runs it
      deps.modules = exampleRegistry;
      studioBoss = await startBoss(own.appUrl, 'studio', quiet);
      const started = studioBoss;
      deps.jobs = createJobService({ store, runner: bossJobRunner(async () => started, () => orgId), kinds: ['import'], pollMs: 100 });
      const run = await importScenario(deps, { timeoutMs: 60_000 });
      expect(run.log).toEqual(filesLog);
      // the same catalog, plus the model link this org was given above
      const { 'data/models.json': models, ...rest } = run.exported.files;
      expect(rest).toEqual(filesExport);
      expect(models).toContain(key);
    } finally {
      await studioBoss?.stop({ graceful: false }).catch(() => undefined);
      await worker?.stop();
      await handle.close();
      await own.drop();
    }
  }, 180_000);

  it('collects garbage by the rules: orphans after a later backup, derived blobs past their key, stray objects', async () => {
    const own = await freshDatabase();
    const { runBlobGcJob, runBackupJob } = await import('../../server/pg/gc.ts');
    const { inOrg } = await import('../../server/pg/db.ts');
    const { blobObjectKey, derivedObjectKey } = await import('../../server/pg/keys.ts');
    const { handle, orgId, blobs } = await starterOrg(own, 'gc');
    const owner = new pg.Client({ connectionString: own.ownerUrl });
    await owner.connect();
    try {
      const sha = (c: string): string => c.repeat(64);
      // a record blob no row names (an orphan to be), one named by an asset, and a derived blob no key names
      const put = async (s: string, cls: 'record' | 'derived', key: string): Promise<void> => {
        await blobs.put(key, Buffer.from(s), 'application/octet-stream');
        await inOrg(handle.db, orgId, async (tx) => {
          await sql`INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state, created_at)
                    VALUES (${orgId}::uuid, ${s}, 1, 'application/octet-stream', ${cls}, ${key}, 'stored', now() - interval '40 days')`.execute(tx);
        });
      };
      await put(sha('a'), 'record', blobObjectKey(orgId, sha('a')));
      await put(sha('d'), 'derived', derivedObjectKey(orgId, sha('d')));
      await inOrg(handle.db, orgId, async (tx) => {
        await sql`INSERT INTO studio.derived_blob (org_id, cache, key, sha256, builder_version, inputs, built_at)
                  VALUES (${orgId}::uuid, 'model', ${sha('e')}, ${sha('d')}, 'old-version', '[]', now() - interval '10 days')`.execute(tx);
      });
      // a stray object (a rolled-back upload), old, and a fresh one
      await blobs.put(`${orgId}/sha256/ff/ff/${sha('f')}`, Buffer.from('x'), 'application/octet-stream');
      await blobs.put(`${orgId}/jobs/input/${sha('9')}`, Buffer.from('y'), 'application/octet-stream');
      const old = new Date(Date.now() - 48 * 3600_000);
      utimesSync(join(work, 'blobs-gc', orgId, 'sha256', 'ff', 'ff', sha('f')), old, old);

      const job = { id: '00000000-0000-7000-8000-00000000000a', kind: 'blob-gc' as const, status: 'running' as const, request: {}, steps: [], createdAt: '' };
      const context = { job, step: async () => {} };
      const backups = join(work, 'backups');
      mkdirSync(join(backups, 'postgres'), { recursive: true });
      // first pass, no backup completed yet: the orphan is marked, kept
      const first = await runBlobGcJob(context, { db: handle.db, orgId, blobs, backupDir: backups, orphanDays: 0 });
      expect(first.result).toMatchObject({ orphaned: 1, deletedRecord: 0, expiredDerived: 1, deletedDerived: 1, deletedObjects: 1, completedBackup: null });
      expect(await blobs.has(blobObjectKey(orgId, sha('a')))).toBe(true);
      expect(await blobs.has(derivedObjectKey(orgId, sha('d')))).toBe(false);
      expect(await blobs.has(`${orgId}/sha256/ff/ff/${sha('f')}`)).toBe(false);
      expect(await blobs.has(`${orgId}/jobs/input/${sha('9')}`)).toBe(true);
      // a backup that completed before the orphan was marked does not count
      writeFileSync(join(backups, '.last-snapshot'), '');
      utimesSync(join(backups, '.last-snapshot'), old, old);
      expect((await runBlobGcJob(context, { db: handle.db, orgId, blobs, backupDir: backups, orphanDays: 0 })).result['deletedRecord']).toBe(0);
      // one completed after it: the orphan goes, object and row
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(backups, '.last-snapshot'), later, later);
      expect((await runBlobGcJob(context, { db: handle.db, orgId, blobs, backupDir: backups, orphanDays: 0 })).result['deletedRecord']).toBe(1);
      expect(await blobs.has(blobObjectKey(orgId, sha('a')))).toBe(false);
      // the catalog's own blobs are never touched
      const left = await inOrg(handle.db, orgId, async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM studio.blob WHERE state = 'orphan'`.execute(tx)).rows[0]!.n);
      expect(left).toBe(0);

      // the backup watch: a dump with its counts file, the snapshot marker
      writeFileSync(join(backups, 'postgres', 'wirehub-20261005T020000Z.dump'), 'dump');
      writeFileSync(join(backups, 'postgres', 'wirehub-20261005T020000Z.dump.counts'), 'studio.blob 1\n');
      symlinkSync('wirehub-20261005T020000Z.dump', join(backups, 'postgres', 'latest.dump'));
      const alerts: string[] = [];
      const watched = await runBackupJob({ ...context, job: { ...job, kind: 'backup' } }, { db: handle.db, orgId, dir: backups, notify: { enabled: true, notify: async (e) => void alerts.push(e.event) } });
      expect(watched.result).toMatchObject({ configured: true, dump: 'wirehub-20261005T020000Z.dump', stale: false });
      expect(alerts).toEqual([]);
      const stale = await runBackupJob({ ...context, job: { ...job, kind: 'backup' } }, { db: handle.db, orgId, dir: backups, now: () => new Date(Date.now() + 31 * 3600_000), notify: { enabled: true, notify: async (e) => void alerts.push(e.event) } });
      expect(stale.result['stale']).toBe(true);
      expect(alerts).toEqual(['backup-dump-stale']);
      expect((await runBackupJob(context, { db: handle.db, orgId, dir: join(work, 'no-backups') })).result).toEqual({ configured: false });
    } finally {
      await owner.end();
      await handle.close();
      await own.drop();
    }
  }, 120_000);

  it('repairs derived records only when they are stale', async () => {
    const own = await freshDatabase();
    const { runDeriveJob, staleDerivedFiles } = await import('../../server/jobs/derive.ts');
    const { handle, deps, cache, orgId } = await starterOrg(own, 'derive');
    const owner = new pg.Client({ connectionString: own.ownerUrl });
    await owner.connect();
    try {
      const job = { id: '00000000-0000-7000-8000-00000000000b', kind: 'derive' as const, status: 'running' as const, request: {}, steps: [], createdAt: '' };
      expect(await staleDerivedFiles(deps)).toEqual([]);
      const before = await cache.version();
      expect((await runDeriveJob({ job, step: async () => {} }, deps, { refresh: () => cache.discard() })).result).toEqual({ stale: [], repaired: false });
      expect(await cache.version()).toBe(before);
      // something bypassed a commit: a derived table edited by hand
      await owner.query("SELECT set_config('studio.org_id', $1, false)", [orgId]);
      const path = (await owner.query<{ path: string }>("SELECT path FROM studio.derived_doc WHERE derived_kind = 'tags' ORDER BY path LIMIT 1")).rows[0]!.path;
      await owner.query("UPDATE studio.derived_doc SET body = '{}' WHERE path = $1", [path]);
      // the cache follows the version, which a hand edit does not move: the repair reloads
      expect(await staleDerivedFiles(deps)).toEqual([]);
      cache.discard();
      expect(await staleDerivedFiles(deps)).toEqual([path]);
      const repaired = await runDeriveJob({ job, step: async () => {} }, deps, { refresh: () => cache.discard() });
      expect(repaired.result).toMatchObject({ stale: [path], repaired: true });
      expect(await staleDerivedFiles(deps)).toEqual([]);
      expect(await cache.version()).not.toBe(before);
    } finally {
      await owner.end();
      await handle.close();
      await own.drop();
    }
  }, 120_000);
});
