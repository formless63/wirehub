/**
 * Uploaded and store packs with an SVG face on Postgres (`pack-bundle-flow.ts`): the images
 * go to the blob store through the depiction staging, are served by `/api/blobs`, replaced on
 * update and removed on disable.
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
import { packWithFace, runFaceFlow, zipFiles } from '../pack-bundle-flow.ts';
import { STORE_URL, createTestStore, type TestStore } from '../store-fixture.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('uploaded and store pack images on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let store: TestStore;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    store = createTestStore();
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    store?.close();
  }, 60_000);

  async function hub(slug: string) {
    const { orgId } = await importCatalog(pgh.db, { org: { slug, create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; bytes?: Uint8Array };
    const readFace = async (def: string) => deps.depictions?.readAsset(def, 'mating-face.svg');
    return { deps, call, readFace, cache };
  }

  it('upload (zip): install, served by /api/blobs, update with a changed SVG, disable removes it', async () => {
    const { call, readFace, cache } = await hub('upload-face');
    const v0 = BigInt(await cache.version());
    await runFaceFlow({
      call,
      id: 'upload',
      readFace,
      source: async (version, face) => ({ path: '/api/packs/install', body: { zip: Buffer.from(zipFiles(Object.fromEntries(Object.entries(packWithFace('upload', version, face)).map(([k, v]) => [`upload-${version}/${k}`, v])))).toString('base64') } }),
    });
    // install, update, disable: one change set each, and none for the previews
    expect(BigInt(await cache.version())).toBe(v0 + 3n);
    const snapshot = await cache.get();
    expect([...snapshot.blobOf.keys()].some((k) => k.startsWith('depictions/upload-face/'))).toBe(false);
  }, 180_000);

  it('upload (JSON bundle): art/ images go to the blob store and are owned by the pack', async () => {
    const { call, cache } = await hub('bundle-art');
    const files = packWithFace('jb', '1.0.0', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    const bundle = { format: 1, manifest: JSON.parse(files['wirehub-pack.json']!), files: { 'components.json': JSON.parse(files['components.json']!), 'art/logo.png': Buffer.from(png).toString('base64') } };
    const done = await call('POST', '/api/packs/install', { bundle, apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    let snapshot = await cache.get();
    expect(snapshot.blobOf.has('data/art/logo.png')).toBe(true);
    expect((JSON.parse(snapshot.files.get('data/packs.json') as string).packs as any[]).find((p) => p.id === 'jb').assets).toHaveProperty(['art/logo.png']);
    expect((await call('DELETE', '/api/packs/jb')).status).toBe(200);
    snapshot = await cache.get();
    expect(snapshot.blobOf.has('data/art/logo.png')).toBe(false);
  }, 180_000);

  it('store: the same flow from a signed index', async () => {
    const { deps, call, readFace } = await hub('store-face');
    deps.store = { indexes: [{ url: STORE_URL, publicKey: store.publicKey }], fetch: store.fetch };
    await runFaceFlow({
      call,
      id: 'alpha',
      readFace,
      source: async (version, face) => {
        store.publish('alpha', version, '10', false, null, face);
        return { path: '/api/packs/store/install', body: { index: STORE_URL, id: 'alpha', version } };
      },
    });
  }, 180_000);
});
