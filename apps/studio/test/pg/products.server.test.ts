/** The device resolver over the API on Postgres: the same flow as on files (`../products-flow.ts`). */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { runProductsFlow } from '../products-flow.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('products and the lineup on Postgres', () => {
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

  it('runs the products flow', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'products', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T12:00:00.000Z' });
    deps.modules = createRegistry([]);
    const raised: string[] = [];
    deps.webhooks = { emit: async (list) => void raised.push(...list.map((e) => `${e.type}:${e.subject.id}`)), jobFinished: async () => {}, catalogChanged: async () => {}, test: async () => undefined, redeliver: async () => undefined };
    await runProductsFlow({
      events: () => raised,
      call: async (method, path, body, user, headers) =>
        (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as never,
    });
  }, 120_000);
});
