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
  it('sweeps derived models no link names (rows first, the object is blob-gc\'s), after the grace period', async () => {
    const { sweepModelCache } = await import('../../server/jobs/model-cache.ts');
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'sweep', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: fsBlobStore(join(work, 'blobs-sweep')) });
    const [live, dead] = ['e'.repeat(64), 'f'.repeat(64)];
    const uow = new UnitOfWork(deps);
    await uow.deps.modelLinks!.put({ record: 'connectors/de9-male', asset: live, files: [{ path: 'housings/de9.step', sha256: 'd'.repeat(64) }], sourceKind: 'vendor', src: 'synthetic example' });
    await uow.commit({ method: 'PUT', path: '/api/models/connectors/de9-male' });
    await deps.modelCache!.put(live, new TextEncoder().encode('live-model'));
    await deps.modelCache!.put(dead, new TextEncoder().encode('dead-model'));
    const links = await deps.modelLinks!.list();
    // built just now: inside the grace period
    const young = await sweepModelCache(deps.modelCache!, links, { now: new Date() });
    expect(young.swept).toEqual([]);
    expect(young.young).toBe(1);
    // a week and a bit later
    const later = await sweepModelCache(deps.modelCache!, links, { now: new Date(Date.now() + 8 * 86_400_000) });
    expect(later.swept).toEqual([dead]);
    expect(await deps.modelCache!.keys()).toEqual([live]);
    expect(await deps.modelCache!.has(dead)).toBe(false);
  }, 60_000);
  it('re-keys a board model link when its art is uploaded through /api/depictions (cs-h8p)', async () => {
    const { transactingDepictionDeps } = await import('../../server/api.ts');
    const { handleDepictionRequest } = await import('../../server/depictions.ts');
    const { loadDb } = await import('@wirehub/catalog');
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'rekey', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: fsBlobStore(join(work, 'blobs-rekey')) });
    const board = 'pair-terminal-board';
    const files = [{ path: 'data/model-sources/aa.kicad_pcb.txt', sha256: 'a'.repeat(64) }];
    const first = new UnitOfWork(deps);
    await first.deps.modelLinks!.put({ record: `pcbas/${board}`, asset: 'b'.repeat(64), files, sourceKind: 'kicad-board', src: 'synthetic example' });
    await first.commit({ method: 'PUT', path: `/api/models/pcbas/${board}` });
    const depictionDeps = transactingDepictionDeps({ store: deps.depictions!, loadDb: () => loadDb() }, deps);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 200 100"><rect width="200" height="100" fill="#0a0"/></svg>';
    for (const view of ['board-top', 'board-bottom']) {
      const raw = new TextEncoder().encode(JSON.stringify({ fileName: `${view}.svg`, data: Buffer.from(svg).toString('base64'), sourceKind: 'gerber' }));
      const done = await handleDepictionRequest({ method: 'POST', path: `/api/depictions/${board}/${view}`, raw, contentType: 'application/json' }, depictionDeps);
      expect(done.status, JSON.stringify('body' in done ? done.body : '')).toBe(201);
    }
    const link = await deps.modelLinks!.get(`pcbas/${board}`);
    expect(link!.asset).not.toBe('b'.repeat(64));
    expect(link!.files!.map((f) => f.path)).toEqual([files[0]!.path, `depictions/${board}/board-bottom.svg`, `depictions/${board}/board-top.svg`]);
  }, 60_000);
});
