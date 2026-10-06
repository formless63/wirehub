/**
 * Runtime code modules on Postgres (`specs/runtime-modules.md`): the shared
 * session (`code-modules-scenario.ts`) over the database backend — every
 * install, update and removal one change set, the code a catalog file held in
 * the blob store, the owners' document in the catalog — and the worker told to
 * restart through `NOTIFY studio_control`.
 */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createLiveRegistry, createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { attachCodeModules } from '../../server/code-modules/index.ts';
import type { CodeModuleHost } from '../../server/code-modules/host.ts';
import { memoryEventHub, type StudioEvent } from '../../server/events.ts';
import { notifyControl } from '../../server/pg/control.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { OWNER, buildExampleBundle, bump, codeModuleScenario, unlistedPublisherRefused, type CodeBackend, type CodeModuleFixture } from '../code-modules-scenario.ts';
import { STORE_URL, createTestStore, type TestStore } from '../store-fixture.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

describePg('runtime code modules on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let store: TestStore;
  let fixture: CodeModuleFixture;
  const caches: SnapshotCache[] = [];
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    store = createTestStore();
    fixture = await buildExampleBundle(store);
  }, 120_000);
  afterAll(async () => {
    for (const cache of caches) await cache.close();
    await pgh?.close();
    await database?.drop();
    fixture?.close();
    store?.close();
  }, 60_000);

  async function pgBackend(slug: string, own: TestStore, ownFixture: CodeModuleFixture): Promise<CodeBackend & { cache: SnapshotCache }> {
    const blobs = testBlobs();
    const { orgId } = await importCatalog(pgh.db, { org: { slug, create: true }, files: readCatalogTree(dataPath('..')), blobs });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    caches.push(cache);
    const live = createLiveRegistry(createRegistry([]));
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs, modules: live });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.store = { indexes: [{ url: STORE_URL, publicKey: own.publicKey }], fetch: own.fetch };
    const attach = (): { host: CodeModuleHost; stop: () => void } => attachCodeModules(deps, { builtins: [], live, pollMs: 0, log: () => {} });
    let attached = attach();
    await attached.host.sync();
    attached.host.markBooted();
    return {
      cache,
      deps,
      live,
      get host() {
        return attached.host;
      },
      restartedHost() {
        attached.stop();
        live.replace(createRegistry([]));
        attached = attach();
        return attached.host;
      },
      store: own,
      fixture: ownFixture,
      send: (request) => handleWorkbenchRequest(request, deps),
    };
  }

  it('refuses a store pack with code whose publisher the index does not name', async () => {
    const own = createTestStore();
    try {
      const backend = await pgBackend('code-unlisted', own, await buildExampleBundle(own));
      const before = await backend.cache.version();
      await unlistedPublisherRefused(backend);
      expect(await backend.cache.version()).toBe(before);
    } finally {
      own.close();
    }
  }, 120_000);

  it('runs the whole session, each install one change set, the code in the blob store', async () => {
    const backend = await pgBackend('code-modules', store, fixture);
    const v0 = BigInt(await backend.cache.version());
    // a preview and a refusal write nothing
    expect((await backend.send({ method: 'POST', path: '/api/packs/install', body: { zip: Buffer.from(fixture.zip).toString('base64'), trustKey: store.publisherPublicKey }, user: OWNER })).status).toBe(200);
    expect(BigInt(await backend.cache.version())).toBe(v0);
    await codeModuleScenario(backend);
    const snapshot = await backend.cache.get();
    // installed from the store at the end: the entries are catalog files (blobs), the record and the owners' choice documents
    expect(snapshot.blobOf.get('data/code/example/server.mjs')).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.blobOf.get('data/code/example/browser.mjs')).toMatch(/^[0-9a-f]{64}$/);
    const settings = JSON.parse(snapshot.source.read('settings/code-modules.json') as string) as { modules: Record<string, { enabled: boolean }>; keys: unknown[] };
    expect(settings.modules['example']?.enabled).toBe(true);
    expect(settings.keys).toHaveLength(1);
    const history = await backend.send({ method: 'GET', path: '/api/history?limit=50', user: OWNER });
    expect(history.status).toBe(200);
  }, 240_000);

  it('a running worker follows signed runtime installs, updates and disable without restarting', async () => {
    const backend = await pgBackend('code-live-worker', store, fixture);
    const { startWorker } = await import('../../server/worker-run.ts');
    const workerLive = createLiveRegistry(createRegistry([]));
    const worker = await startWorker({ env: { DATABASE_URL: database.appUrl, WIREHUB_ORG: 'code-live-worker' }, modules: workerLive, builtins: [], blobs: testBlobs(), log: () => {}, attempts: 2 });
    try {
      const install = await backend.send({ method: 'POST', path: '/api/packs/install', body: { zip: Buffer.from(fixture.zip).toString('base64'), trustKey: store.publisherPublicKey, apply: true, consent: { code: 'example@0.1.0' } }, user: OWNER });
      expect(install.status, JSON.stringify(install.body)).toBe(200);
      await expect.poll(() => worker!.kinds.includes('example:recount'), { timeout: 20_000 }).toBe(true);
      expect(worker!.codeModules?.status().find((m) => m.id === 'example')).toMatchObject({ state: 'loaded', apply: 'live', restartPending: false });
      const first = await worker!.jobs.enqueue('example:recount', { only: 'connectors' });
      expect(await worker!.jobs.wait(first.id, 30_000)).toMatchObject({ status: 'done', result: { counts: { connectors: 4 } } });
      const zip = fixture.variant((files, manifest) => bump(files, manifest, '0.1.1', (code) => code.replace('return { counts };', 'return { counts, updated: true };')));
      const update = await backend.send({ method: 'POST', path: '/api/packs/install', body: { zip: Buffer.from(zip).toString('base64'), apply: true, consent: { code: 'example@0.1.1' } }, user: OWNER });
      expect(update.status, JSON.stringify(update.body)).toBe(200);
      await expect.poll(() => workerLive.module('example')?.version, { timeout: 20_000 }).toBe('0.1.1');
      const updated = await worker!.jobs.enqueue('example:recount', { only: 'connectors' });
      expect(await worker!.jobs.wait(updated.id, 30_000)).toMatchObject({ status: 'done', result: { updated: true } });
      expect((await backend.send({ method: 'POST', path: '/api/code-modules/example/disable', user: OWNER })).status).toBe(200);
      await expect.poll(() => worker!.kinds.includes('example:recount'), { timeout: 20_000 }).toBe(false);
      await expect(worker!.jobs.enqueue('example:recount', {})).rejects.toThrow(/does not run/);
    } finally {
      await worker?.stop();
    }
  }, 120_000);

  it('tells the worker to restart through the database', async () => {
    const blobs = testBlobs();
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'code-control', create: true }, files: readCatalogTree(dataPath('..')), blobs });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    caches.push(cache);
    const events = memoryEventHub();
    const heard: StudioEvent[] = [];
    events.subscribe((event) => heard.push(event));
    await cache.listen(database.appUrl, events);
    await notifyControl(pgh.db, orgId, 'restart');
    // another organisation's restart is not this worker's
    await notifyControl(pgh.db, '00000000-0000-0000-0000-000000000000', 'restart');
    for (let i = 0; i < 50 && heard.length === 0; i += 1) await new Promise((done) => setTimeout(done, 50));
    await new Promise((done) => setTimeout(done, 100));
    expect(heard).toEqual([{ type: 'control', action: 'restart' }]);
  }, 60_000);
});
