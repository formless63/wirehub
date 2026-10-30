/**
 * Release to this hub on Postgres: the same flow as the file backend (`pack-release-flow.ts`), each
 * write one change set; the release changes only `packs.json` (the records are already ordinary rows),
 * and the pack's photo stays in the blob store.
 */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { PACK, runReleaseFlow } from '../pack-release-flow.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

describePg('release a pack to the hub on Postgres', () => {
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

  it('previews, releases, and then the records are the hub\'s own; a re-install is refused', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'release', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    await runReleaseFlow({
      call: async (method, path, body, extra) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(extra?.user === undefined ? {} : { user: extra.user }), ...(extra?.headers === undefined ? {} : { headers: extra.headers }) }, deps)) as { status: number; body: any; headers?: Record<string, string> },
    });
    // the release is history in the catalog's packs.json: no pack installed, the released one recorded
    const record = JSON.parse((await cache.get()).files.get('data/packs.json') as string) as { packs: unknown[]; released: { id: string; releasedAt: string; releasedBy?: string }[] };
    expect(record.packs).toEqual([]);
    expect(record.released).toEqual([expect.objectContaining({ id: PACK, releasedAt: '2026-10-05T09:00:00.000Z', releasedBy: 'owner-a' })]);
  }, 180_000);
});
