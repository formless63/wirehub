/**
 * An installed pack's artwork on Postgres: the images of a pack's `depictions/`
 * go to the blob store through the codec's blob handling and are served by
 * content address, as the file backend serves them (cs-3hx).
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { contentSha } from '@wirehub/catalog/src/codec/index.ts';
import { readCatalogTree, readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { registry } from '../../server/modules.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { exportSnapshot, exportTree } from '../../server/pg/export.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { handleSetupRequest } from '../../server/setup.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('a pack\'s artwork on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-art-'));
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('stores the images in the blob store and serves them as the file backend does', async () => {
    const now = () => '2026-10-05T09:00:00.000Z';
    const modules = ['pc-serial', 'av-video'];
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'art', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: true, now });
    deps.modules = registry;
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/setup', body: { modules } }, deps)).status).toBe(200);

    const copy = join(work, 'data');
    const packsDir = join(work, 'packs');
    cpSync(dataPath(''), copy, { recursive: true });
    cpSync(join(dataPath('..'), 'depictions'), join(work, 'depictions'), { recursive: true });
    expect((await handleSetupRequest({ method: 'POST', body: { modules } }, { dataDir: copy, packsDir, prompt: true, now }, registry)).status).toBe(200);
    const tree = readFlattenedCatalog(work, packsDir);
    const packImages = [...tree.keys()].filter((p) => /^depictions\/(usb-a-plug|hd15-male)\/.+\.svg$/.test(p));
    expect(packImages.length).toBe(4);

    // the same binary files, by path and content, in the database as in the file backend's flattened tree
    const snapshot = await cache.get();
    const files = exportTree(tree, '0').blobs;
    const pg = exportSnapshot(snapshot).blobs;
    for (const path of packImages) expect(pg[path], path).toBe(files[path]);
    expect(Object.keys(pg).filter((p) => p.startsWith('depictions/'))).toEqual(Object.keys(files).filter((p) => p.startsWith('depictions/')));

    // …and served by content address from the blob store
    for (const path of packImages) {
      const served = await deps.blob?.(pg[path] as string);
      expect(served?.mediaType, path).toBe('image/svg+xml');
      expect(contentSha(served?.bytes as Uint8Array), path).toBe(files[path]);
    }
    // the depiction store lists the pack's depictions and reads their files
    const store = deps.depictions;
    expect(await store?.listDefIds()).toEqual(expect.arrayContaining(['usb-a-plug', 'hd15-male']));
    expect(await store?.readAsset('usb-a-plug', 'mating-face.svg')).toBeDefined();
  }, 120_000);
});
