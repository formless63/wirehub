/**
 * Install and update from a signed store index on Postgres (`server/store.ts`): the
 * index verified, the download checked against it, then the ordinary install flow,
 * one change set per apply and none for a preview or a refusal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import type { StudioUser } from '../../server/me.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { STORE_URL, createTestStore, type TestStore } from '../store-fixture.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('store install on Postgres', () => {
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

  it('lists, previews, installs and updates from a verified index, one change set each', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'store', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    deps.store = { indexes: [{ url: STORE_URL, publicKey: store.publicKey }], fetch: store.fetch };
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
    store.publish('alpha', '1.0.0', '10 Ω', false, 'one');

    const v0 = BigInt(await cache.version());
    expect((await call('GET', '/api/packs/store')).body.packs[0]).toMatchObject({ id: 'alpha', action: 'install', license: 'CC-BY-4.0' });
    const preview = await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'alpha' });
    expect(preview.body).toMatchObject({ kind: 'install', verified: true });
    expect(BigInt(await cache.version())).toBe(v0);

    // a tampered download: refused, nothing written
    const name = 'alpha-1.0.0.zip';
    const bytes = new Uint8Array(readFileSync(join(store.site, name)));
    const changed = bytes.slice();
    changed[changed.length - 30] = (changed[changed.length - 30]! + 1) % 256;
    store.override.set(name, changed);
    expect((await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true })).status).toBe(422);
    expect(BigInt(await cache.version())).toBe(v0);
    store.override.clear();

    const done = await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(BigInt(await cache.version())).toBe(v0 + 1n);
    expect((await call('GET', '/api/definitions/components/alpha-r')).body.value).toBe('10 Ω');
    expect((await call('GET', '/api/packs/store')).body.packs[0]).toMatchObject({ installed: '1.0.0', action: 'current' });

    store.publish('alpha', '1.1.0', '11 Ω', true, 'two');
    expect((await call('GET', '/api/packs/store')).body.packs[0]).toMatchObject({ action: 'update' });
    const update = await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true });
    expect(update.body).toMatchObject({ kind: 'update', installed: true, version: '1.1.0' });
    expect(BigInt(await cache.version())).toBe(v0 + 2n);
    expect((await call('GET', '/api/definitions/components/alpha-r')).body.value).toBe('11 Ω');
    expect((await call('GET', '/api/definitions/components/alpha-r2')).status).toBe(200);
    expect((await call('GET', '/api/packs')).body.packs[0]).toMatchObject({ id: 'alpha', version: '1.1.0' });

    // the pack's depiction manifest: installed with it, replaced by the update, gone with a disable (cs-093)
    const note = async () => ((await deps.depictions?.readMeta('alpha-face')) as { note?: string } | undefined)?.note;
    expect(await note()).toBe('two');
    store.publish('alpha', '1.2.0', '11 Ω', true, null);
    expect((await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true })).body).toMatchObject({ installed: true, version: '1.2.0' });
    expect(await note()).toBeUndefined();
    store.publish('alpha', '1.3.0', '11 Ω', true, 'three');
    expect((await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true })).status).toBe(200);
    expect(await note()).toBe('three');
    expect((await call('DELETE', '/api/packs/alpha')).status).toBe(200);
    expect(await note()).toBeUndefined();
    expect(await deps.depictions?.listDefIds()).not.toContain('alpha-face');
  }, 180_000);

  it('phase 5: verifies the publisher signature, records the origin, refuses yanked and revoked versions without a change set, and flags the installed one', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'store-trust', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    const trust = createTestStore();
    try {
      deps.store = { indexes: [{ url: STORE_URL, publicKey: trust.publicKey }], fetch: trust.fetch };
      const call = async (method: string, path: string, body?: unknown, user?: StudioUser) =>
        (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(user === undefined ? {} : { user }) }, deps)) as { status: number; body: any };
      trust.signWith = [trust.publisherKeyFile];
      trust.publish('gamma', '1.0.0', '1 Ω');
      trust.publish('gamma', '1.1.0', '2 Ω');
      trust.meta('publisher', '--id', 'tester', '--name', 'Test publisher', '--pubkey', trust.publisherPublicKey);
      trust.meta('yank', 'gamma@1.1.0', '--reason', 'wrong value');

      const v0 = BigInt(await cache.version());
      // the yanked version: refused (and for an editor even when forced), nothing written
      expect((await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'gamma', version: '1.1.0', apply: true })).status).toBe(409);
      expect((await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'gamma', version: '1.1.0', apply: true, force: true }, { name: 'Ed', source: 'local', role: 'editor' })).status).toBe(403);
      expect(BigInt(await cache.version())).toBe(v0);
      // the offered version, signed: one change set, its origin recorded in packs.json
      const done = await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'gamma', apply: true });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.from).toMatchObject({ version: '1.0.0', publisher: 'tester', signedBy: [trust.publisherPublicKey] });
      expect(BigInt(await cache.version())).toBe(v0 + 1n);
      expect((await call('GET', '/api/packs')).body.packs[0]).toMatchObject({ id: 'gamma', version: '1.0.0', origin: { index: STORE_URL, publisher: 'tester', signedBy: [trust.publisherPublicKey] } });

      // the key is revoked: a new install of anything it alone signs is refused, the installed pack flagged
      trust.meta('revoke', '--pubkey', trust.publisherPublicKey, '--reason', 'key lost');
      const refused = await call('POST', '/api/packs/store/install', { index: STORE_URL, id: 'gamma', version: '1.1.0', apply: true, force: true });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatch(/signed only by a revoked key: key lost/);
      expect(BigInt(await cache.version())).toBe(v0 + 1n);
      const list = (await call('GET', '/api/packs/store')).body;
      expect(list.notices).toEqual([expect.objectContaining({ id: 'gamma', version: '1.0.0', revoked: [expect.objectContaining({ reason: 'key lost' })] })]);
    } finally {
      trust.close();
    }
  }, 180_000);
});
