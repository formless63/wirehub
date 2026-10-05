/** A pack carrying a numbering scheme and validation rules, on Postgres (the pack lands in the database as one change set). */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import type { StudioUser } from '../../server/me.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { runDeclarativePackFlow } from '../declarative-pack-flow.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('a data pack with a scheme and rules on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
  }, 60_000);

  it('installs without switching the scheme, runs the pack\'s rules, lets an owner adopt the scheme, and disables cleanly', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'declarative-pack', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T12:00:00.000Z' });
    deps.modules = createRegistry([]);
    await runDeclarativePackFlow({
      call: async (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>) =>
        (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string> },
    });
    expect(await cache.version()).toBeDefined();
  }, 60_000);
});
