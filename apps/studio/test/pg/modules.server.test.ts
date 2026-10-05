/**
 * The module session (`../storage-contract/modules.ts`) on Postgres: every step
 * answered as the in-memory commit tree (and so the file backend) answers it,
 * the same catalog at the end byte for byte, a module's derived records kept in
 * `studio.derived_doc` (derived_kind 'module', module_id) and moved by the
 * commit that moved their inputs, and the S1 gate clean against the export.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { fsBlobStore, type BlobStore } from '../../server/blobs.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { writeExport } from '../../server/pg/export.ts';
import { formatGateReport, runGate } from '../../server/pg/gate.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { exampleRegistry, moduleScenario } from '../storage-contract/modules.ts';
import { memoryWriteBackend } from '../storage-contract/writes.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

describePg('modules on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let blobs: BlobStore;
  let work: string;
  let orgId: string;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-modules-'));
    blobs = fsBlobStore(join(work, 'blobs'));
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')) })).orgId;
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('answers the module session exactly as the commit tree does, derived records included', async () => {
    const memoryBackend = memoryWriteBackend(exampleRegistry);
    const memory = await moduleScenario(memoryBackend.deps);
    const cache = new SnapshotCache(pgh.db, orgId);
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs, modules: exampleRegistry });
    const pg = await moduleScenario(deps);
    expect(pg).toEqual(memory);
    const memoryFiles = (await memoryBackend.deps.exportCatalog!()).files;
    const pgFiles = (await deps.exportCatalog!()).files;
    for (const path of ['data/derived/example/summary.json', 'data/derived/example/summary.md', 'data/components.json']) expect(pgFiles[path]).toBe(memoryFiles[path]);
  }, 120_000);

  it('keeps the derived records as module rows, computed over the head version', async () => {
    await inOrg(pgh.db, orgId, async (tx) => {
      const rows = (await sql<{ path: string; derived_kind: string; module_id: string | null; inputs_version: string }>`
        SELECT path, derived_kind, module_id, inputs_version::text AS inputs_version FROM studio.derived_doc WHERE derived_kind = 'module' ORDER BY path`.execute(tx)).rows;
      expect(rows.map((r) => [r.path, r.module_id])).toEqual([
        ['data/derived/example/summary.json', 'example'],
        ['data/derived/example/summary.md', 'example'],
      ]);
      const head = (await sql<{ version: string }>`SELECT version::text AS version FROM studio.catalog_head`.execute(tx)).rows[0]?.version;
      // the last commit moved them (a design was duplicated), so they are as fresh as the head
      expect(rows.every((r) => r.inputs_version === head)).toBe(true);
      // the tag tables are still the only other kind
      const kinds = (await sql<{ derived_kind: string }>`SELECT DISTINCT derived_kind FROM studio.derived_doc ORDER BY 1`.execute(tx)).rows.map((r) => r.derived_kind);
      expect(kinds).toEqual(['module', 'tags']);
    });
  });

  it('passes the S1 gate against its own export, module files included', async () => {
    const out = join(work, 'export');
    const cache = new SnapshotCache(pgh.db, orgId);
    await writeExport(await cache.get(), out, { blobs, orgId });
    const gate = await runGate({ tree: readCatalogTree(out), root: out, pg: { db: pgh.db, cache, blobs } });
    console.log(`[gate after module writes]\n${formatGateReport(gate)}`);
    expect(gate.checks.filter((c) => c.diffs.length > 0)).toEqual([]);
  }, 120_000);
});
