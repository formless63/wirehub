/**
 * Store sources on the file backend: stores added in Settings alongside the
 * deployment's (`server/store-sources.ts`, `store-settings.ts`). Scenario shared
 * with Postgres (`store-sources-scenario.ts`); key pairs are generated in the test.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { fileDocStore } from '../server/storage/doc-store.ts';
import { storeIndexesFromEnv } from '../server/store.ts';
import { checkSource } from '../server/store-sources.ts';
import { createTestStore, type TestStore } from './store-fixture.ts';
import { storeSourcesScenario } from './store-sources-scenario.ts';

describe('store sources (files)', { timeout: 180_000 }, () => {
  let root = '';
  let a: TestStore;
  let b: TestStore;
  let deps: WorkbenchDeps;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-sources-'));
    const dir = join(root, 'catalog');
    const packs = join(root, 'packs');
    cpSync(dataPath(''), dir, { recursive: true });
    a = createTestStore();
    b = createTestStore();
    deps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => createCatalog(catalogWithPacksSource(dir, packs)).loadDb(),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
      setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
      docs: fileDocStore(join(root, 'docs')),
    };
  });
  afterEach(() => {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('adds, previews, browses, disables, renames, locks and removes stores', async () => {
    await storeSourcesScenario(
      async (method, path, body, headers) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) }, deps)) as { status: number; body: any; headers?: Record<string, string> },
      (store) => {
        deps.store = store;
      },
      a,
      b,
    );
  });

  it('shows the official store as trusted when the hub lists it, with the recorded key', async () => {
    deps.store = storeIndexesFromEnv({});
    const got = (await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/stores' }, deps)) as { status: number; body: any };
    expect(got.body.official).toMatchObject({ state: 'trusted', keyId: '289BB53D1B721017' });
    expect(got.body.sources).toEqual([expect.objectContaining({ origin: 'official', readOnly: true })]);
  });

  it('reads the lock from the environment and checks a source entry', () => {
    expect(storeIndexesFromEnv({}).allowUserSources).toBeUndefined();
    expect(storeIndexesFromEnv({ WIREHUB_STORE_ALLOW_USER_SOURCES: 'true' }).allowUserSources).toBeUndefined();
    for (const off of ['false', '0', 'no', 'off']) expect(storeIndexesFromEnv({ WIREHUB_STORE_ALLOW_USER_SOURCES: off }).allowUserSources).toBe(false);
    expect(checkSource({ url: 'http://x.example/i.json', publicKey: a.publicKey }, 'x')).toMatchObject({ error: expect.stringMatching(/https only/) });
    expect(checkSource({ url: 'https://u:p@x.example/i.json', publicKey: a.publicKey }, 'x')).toMatchObject({ error: expect.stringMatching(/user name/) });
    expect(checkSource({ url: 'https://x.example/i.json', publicKey: 'RWnope' }, 'x')).toMatchObject({ error: expect.stringMatching(/minisign/) });
    expect(checkSource({ url: 'https://x.example/i.json', publicKey: a.publicKey, label: '  Mine ' }, 'x')).toEqual({ source: { url: 'https://x.example/i.json', publicKey: a.publicKey, label: 'Mine', enabled: true } });
  });
});
