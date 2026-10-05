/**
 * The board-import module on Postgres (cs-5k1.13, cs-5k1.12): the same
 * scenario as `test/board-import.server.test.ts` — a KiCad board, its Gerber
 * art and its BOM imported as jobs and published, its board file built as a
 * 3D model by the model-cache job — through the pg job store, with the same
 * answers and the same exported catalog as on the file backend.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const work = mkdtempSync(join(tmpdir(), 'wirehub-pg-boards-'));
const catalogPackage = fileURLToPath(new URL('../../../../packages/catalog', import.meta.url));
cpSync(join(catalogPackage, 'data'), join(work, 'catalog', 'data'), { recursive: true });
cpSync(join(catalogPackage, 'depictions'), join(work, 'catalog', 'depictions'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'catalog', 'data');
process.env.MODEL_CACHE_DIR = join(work, 'model-cache');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.MODEL_CACHE_DIR;
  rmSync(work, { recursive: true, force: true });
});

const quiet = (): void => {};

describePg('board import on Postgres', () => {
  let database: TestDatabase;
  let filesLog: string[];
  let filesExport: Record<string, string>;

  beforeAll(async () => {
    database = await freshDatabase();
    const { defaultWorkbenchDeps } = await import('../../server/default-deps.ts');
    const { boardImportRegistry, boardImportScenario } = await import('../board-import-scenario.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../../server/jobs/handlers.ts');
    const deps = defaultWorkbenchDeps({ modules: boardImportRegistry });
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps }), quiet), kinds: ['import'] });
    const files = await boardImportScenario(deps);
    filesLog = files.log;
    filesExport = files.exported.files;
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  it('imports, plans and publishes as on files, and builds the board model into derived blobs', async () => {
    const { openPg } = await import('../../server/pg/db.ts');
    const { importCatalog } = await import('../../server/pg/import.ts');
    const { SnapshotCache } = await import('../../server/pg/snapshot.ts');
    const { pgWorkbenchDeps } = await import('../../server/pg/deps.ts');
    const { fsBlobStore } = await import('../../server/blobs.ts');
    const { createJobService, inlineJobRunner } = await import('../../server/jobs/service.ts');
    const { pgJobHandlers, pgJobStore } = await import('../../server/pg/jobs.ts');
    const { boardImportRegistry, boardImportScenario } = await import('../board-import-scenario.ts');
    const handle = openPg(database.appUrl, { max: 4 });
    try {
      const { orgId } = await importCatalog(handle.db, { org: { slug: 'boards', create: true }, files: readCatalogTree(catalogPackage), blobs: testBlobs() });
      const blobs = fsBlobStore(join(work, 'blobs'));
      const cache = new SnapshotCache(handle.db, orgId, { reuseMs: 0 });
      const deps = pgWorkbenchDeps({ cache, db: handle.db, blobs });
      deps.modules = boardImportRegistry;
      const store = pgJobStore(handle.db, orgId);
      deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => pgJobHandlers({ deps, db: handle.db, orgId, blobs }), quiet), kinds: ['import'] });
      const run = await boardImportScenario(deps);
      expect(run.log).toEqual(filesLog);
      expect(run.exported.files).toEqual(filesExport);
    } finally {
      await handle.close();
    }
  }, 180_000);
});
