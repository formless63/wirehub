/** Real database persistence/reopen check; skipped explicitly without disposable Postgres 18. */
import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { handleWorkbenchRequest } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { resolveCover, type RepresentationView } from '../../src/representations.ts';
import { representationFixture } from '../representation-fixture.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

describePg('persisted board cover on Postgres', () => {
  let database: TestDatabase;
  let handle: PgHandle;
  beforeAll(async () => { database = await freshDatabase(); handle = openPg(database.appUrl, { max: 2 }); }, 60_000);
  afterAll(async () => { await handle?.close(); await database?.drop(); }, 60_000);
  it('keeps bottom selection, native artwork and input identity across closing and reopening the database', async () => {
    const { board, depiction, sourceHash } = await representationFixture();
    const files = new Map(readCatalogTree(dataPath('..')));
    files.set('data/pcbas.json', `${JSON.stringify([board], null, 2)}\n`);
    files.set(`depictions/${board.id}/meta.json`, `${JSON.stringify(depiction.meta, null, 2)}\n`);
    for (const [file, svg] of Object.entries(depiction.files)) files.set(`depictions/${board.id}/${file}`, svg);
    const blobs = testBlobs();
    const { orgId } = await importCatalog(handle.db, { org: { slug: 'cover-test', create: true }, files, blobs });
    const path = `/api/representations/pcbas/${board.id}`;
    const makeDeps = () => pgWorkbenchDeps({ cache: new SnapshotCache(handle.db, orgId, { reuseMs: 0 }), db: handle.db, blobs });
    const deps = makeDeps();
    const initial = await handleWorkbenchRequest({ method: 'GET', path }, deps);
    expect(initial.status).toBe(200);
    const bottom = (initial.body as RepresentationView).candidates[1]!;
    const choice = { view: bottom.view, lineage: bottom.lineage };
    const saved = await handleWorkbenchRequest({ method: 'PUT', path, body: { choice }, headers: { 'if-match': initial.headers!.ETag! } }, deps);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await handle.close();
    handle = openPg(database.appUrl, { max: 2 });
    const reopened = makeDeps();
    const fresh = await handleWorkbenchRequest({ method: 'GET', path }, reopened);
    expect(resolveCover(fresh.body as RepresentationView)).toMatchObject({ state: 'chosen', selected: { view: 'board-bottom', sources: [{ sha256: sourceHash }] } });
    const asset = await handleWorkbenchRequest({ method: 'GET', path: `/api/blobs/${bottom.asset}` }, reopened);
    expect(asset.status).toBe(200);
    expect(new TextDecoder().decode(asset.bytes)).toBe(depiction.files['board-bottom.svg']);
    const stale = await handleWorkbenchRequest({ method: 'PUT', path, body: { choice: null }, headers: { 'if-match': initial.headers!.ETag! } }, reopened);
    expect(stale.status).toBe(409);
    const automatic = await handleWorkbenchRequest({ method: 'PUT', path, body: { choice: null }, headers: { 'if-match': fresh.headers!.ETag! } }, reopened);
    expect(resolveCover(automatic.body as RepresentationView)).toMatchObject({ state: 'automatic', selected: { view: 'board-top' } });
  });
});
