/**
 * The write path on Postgres (tasks B1–B4, B7, B9): the contract's write
 * session against a pg studio — every step answered as the in-memory commit
 * tree answers it (which answers as the file backend does,
 * `writes-files.server.test.ts`), the same catalog at the end byte for byte,
 * the database's own invariants after the writes (generated etags, reference
 * edges, attribution), and the S1 gate between the result and its export.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { fsBlobStore, type BlobStore } from '../../server/blobs.ts';
import { handleWorkbenchRequest } from '../../server/api.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { writeExport } from '../../server/pg/export.ts';
import { formatGateReport, runGate } from '../../server/pg/gate.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import type { DepictionStore } from '../../server/depictions.ts';
import { batchScenario } from '../storage-contract/batch.ts';
import { memoryWriteBackend, writeScenario } from '../storage-contract/writes.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('the write path on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let blobs: BlobStore;
  let work: string;
  let orgId: string;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-writes-'));
    blobs = fsBlobStore(join(work, 'blobs'));
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('answers the write session exactly as the commit tree (and so the file backend) does', async () => {
    const memoryBackend = memoryWriteBackend();
    const memory = await writeScenario(memoryBackend);
    const memoryBatch = await batchScenario(memoryBackend.deps);
    const cache = new SnapshotCache(pgh.db, orgId);
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs });
    const pg = await writeScenario({ deps, depictionDeps: { store: deps.depictions as DepictionStore, loadDb: deps.loadDb, loadDesigns: async () => (await cache.get()).catalog.loadDesigns() } });
    const pgBatch = await batchScenario(deps);
    const drop = (log: string[]) => log.filter((line) => !line.startsWith('export:') && !line.startsWith('read export:'));
    expect(drop(pg.log)).toEqual(drop(memory.log));
    expect(drop(pgBatch)).toEqual(drop(memoryBatch));
    expect(pg.exported.files).toEqual(memory.exported.files);
    expect(pg.exported.blobs).toEqual(memory.exported.blobs);
  }, 120_000);

  it('keeps the database invariants: one change set per commit, attributed, with its changes; edges follow the records', async () => {
    // a signed-in person's save is theirs; with the login off it is the local studio's (as the git export's author)
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId), db: pgh.db, blobs });
    const user = { name: 'Alex Example', email: 'Alex@Example.com', source: 'session' as const };
    const vocab = await handleWorkbenchRequest({ method: 'POST', path: '/api/vocab/families', body: { label: 'Signed-in family', src: 'contract test' }, user }, deps);
    expect(vocab.status).toBe(201);
    await inOrg(pgh.db, orgId, async (tx) => {
      const sets = (await sql<{ source: string; actor_label: string; n: string; message: string }>`
        SELECT s.source, s.actor_label, s.message, (SELECT count(*)::text FROM studio.change c WHERE c.change_set_id = s.id) AS n
          FROM studio.change_set s ORDER BY s.catalog_version`.execute(tx)).rows;
      expect(sets[0]?.source).toBe('import');
      expect(sets.length).toBeGreaterThan(15);
      expect(sets[sets.length - 1]?.actor_label).toBe('Alex Example');
      for (const s of sets.slice(1, -1)) {
        expect(s.actor_label).toBe('WireHub (local)');
        expect(Number(s.n)).toBeGreaterThan(0);
        expect(s.message).toMatch(/^studio: |^Relabel two cables and add a family$|^Batch of \d+ requests$/);
      }
      // the batch of three writes is one change set
      const batch = sets.filter((s) => s.message === 'Relabel two cables and add a family');
      expect(batch.length).toBe(1);
      expect(Number(batch[0]?.n)).toBeGreaterThanOrEqual(3);
      const head = (await sql<{ version: string }>`SELECT version::text AS version FROM studio.catalog_head`.execute(tx)).rows[0]?.version;
      expect(Number(head)).toBe(sets.length);
      const person = (await sql<{ email: string }>`SELECT email FROM studio.person`.execute(tx)).rows.map((r) => r.email);
      expect(person).toEqual(['alex@example.com']);
      const unattributed = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.audit_log WHERE change_set_id IS NULL AND org_id = ${orgId}::uuid`.execute(tx)).rows[0]?.n;
      expect(unattributed).toBe('0');
      // the renamed design kept its entity (and so its uuid): no design entity is left without rows
      const orphans = (await sql<{ slug: string }>`
        SELECT e.slug FROM studio.entity e WHERE e.kind = 'design'
           AND NOT EXISTS (SELECT 1 FROM studio.record r WHERE r.entity_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM studio.design_revision v WHERE v.design_id = e.id)`.execute(tx)).rows;
      expect(orphans).toEqual([]);
    });
  });

  it('passes the S1 gate against its own export after the writes', async () => {
    const out = join(work, 'export');
    const cache = new SnapshotCache(pgh.db, orgId);
    await writeExport(await cache.get(), out, { blobs, orgId });
    const gate = await runGate({ tree: readCatalogTree(out), root: out, pg: { db: pgh.db, cache, blobs } });
    console.log(`[gate after writes]\n${formatGateReport(gate)}`);
    expect(gate.checks.filter((c) => c.diffs.length > 0)).toEqual([]);
  }, 120_000);

  it('refuses to delete what the database still references (deferred FK → 409), writing nothing', async () => {
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs });
    const before = await cache.version();
    // the definitions route refuses a used part itself; drop the whole connectors list behind its back
    const list = await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/connectors' }, deps);
    const { UnitOfWork } = await import('../../server/storage/unit-of-work.ts');
    const uow = new UnitOfWork(deps);
    await uow.deps.definitions!.write('connectors', []);
    await expect(uow.commit({ method: 'PUT', path: '/api/definitions/connectors' })).rejects.toThrow(/still used/);
    expect(await cache.version()).toBe(before);
    expect(list.status).toBe(200);
  });
});
