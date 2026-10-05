/**
 * A pack that ships a drawing's product photo (cs-8re): the image goes in as `assets/<sha>.png` with its
 * `assets/index.json` entry, the photo pointer names it, and the asset follows the pack: installed with it,
 * replaced on update, gone on disable. Postgres half; the file backend's is `pack-photo.server.test.ts`.
 */

import { createHash } from 'node:crypto';

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
import { photoBundle } from '../pack-photo-fixture.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

describePg('a pack that ships a drawing photo on Postgres', () => {
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

  it('installs, replaces the photo on update, and removes it on disable', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'photo', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
    const index = async () => JSON.parse(((await cache.get()).files.get('data/assets/index.json') as string | undefined) ?? '[]') as { id: string }[];

    const one = photoBundle('1.0.0', 1);
    const preview = await call('POST', '/api/packs/install', { bundle: one.bundle });
    expect(preview.body, JSON.stringify(preview.body)).toMatchObject({ applicable: true, problems: [] });
    const done = await call('POST', '/api/packs/install', { bundle: one.bundle, apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await index()).map((e) => e.id)).toEqual([one.sha]);
    expect((await call('GET', `/api/drawings/${one.design}`)).body.photo).toMatch(/^data:image\/png;base64,/);
    expect((await call('GET', `/api/assets/${one.sha}`)).status).toBe(200);

    const two = photoBundle('1.1.0', 2);
    expect(createHash('sha256').update(two.bytes).digest('hex')).toBe(two.sha);
    const updated = await call('POST', '/api/packs/install', { bundle: two.bundle, apply: true });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect((await index()).map((e) => e.id)).toEqual([two.sha]);
    expect((await call('GET', `/api/drawings/${one.design}`)).body.photo).toMatch(/^data:image\/png;base64,/);
    expect((await call('GET', `/api/assets/${one.sha}`)).status).toBe(404);

    expect((await call('DELETE', `/api/packs/${one.packId}`)).status).toBe(200);
    expect(await index()).toEqual([]);
    expect((await call('GET', `/api/drawings/${one.design}`)).body.photo).toBeUndefined();
    expect((await call('GET', `/api/assets/${two.sha}`)).status).toBe(404);
  }, 180_000);
});
