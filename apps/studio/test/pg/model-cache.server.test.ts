/**
 * Converted models as derived blobs (task B10): an imported model's link
 * answers "not built" until the cache holds its key, then serves the GLB;
 * a cache write bumps no catalog version and writes no change set.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { UnitOfWork } from '../../server/storage/unit-of-work.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('model cache on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-models-'));
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('serves an imported model once built, and answers not-built before', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: fsBlobStore(join(work, 'blobs')) });
    const key = 'c'.repeat(64);
    const uow = new UnitOfWork(deps);
    await uow.deps.modelLinks!.put({ record: 'connectors/de9-male', asset: key, files: [{ path: 'housings/de9.step', sha256: 'd'.repeat(64) }], sourceKind: 'vendor', src: 'synthetic example' });
    await uow.commit({ method: 'PUT', path: '/api/models/connectors/de9-male' });
    const before = await handleWorkbenchRequest({ method: 'GET', path: `/api/assets/${key}` }, deps);
    expect(before.status).toBe(404);
    expect((before.body as { state?: string }).state).toBe('not-built');
    const version = await cache.version();
    await deps.modelCache!.put(key, new TextEncoder().encode('glTF-built-model'));
    expect(await cache.version()).toBe(version);
    expect(await deps.modelCache!.keys()).toEqual([key]);
    const after = await handleWorkbenchRequest({ method: 'GET', path: `/api/assets/${key}` }, deps);
    expect(after.status).toBe(200);
    expect(new TextDecoder().decode(after.bytes)).toBe('glTF-built-model');
    const list = (await handleWorkbenchRequest({ method: 'GET', path: '/api/models' }, deps)).body as { models: { id: string; built: boolean }[] };
    expect(list.models.find((m) => m.id === key)?.built).toBe(true);
  }, 60_000);
});
