/**
 * The store-sources scenario (`server/store-sources.ts`, `store-settings.ts`), shared by
 * the file test and the Postgres test: two throwaway signed stores (`store-fixture.ts`),
 * one named by the deployment and one added in Settings. Keys are generated in the tests.
 */

import { storeKeyFingerprint } from '@wirehub/catalog';
import { expect } from 'vitest';

import type { StoreDeps } from '../server/store.ts';
import { STORE_URL, type TestStore } from './store-fixture.ts';

export const OTHER_URL = 'https://other.example/s/index.json';

type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;

/** one fetch for two stores: `other.example` is served by the second fixture, `store.example` by the first */
export function routedFetch(a: TestStore, b: TestStore): NonNullable<StoreDeps['fetch']> {
  return {
    lookup: async (host) => (host === 'private.example' ? ['10.0.0.5'] : ['93.184.216.34']),
    fetch: (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const target = url.host === 'other.example' ? b : a;
      url.host = 'store.example';
      return (target.fetch.fetch as typeof fetch)(url, init);
    }) as typeof fetch,
  };
}

export async function storeSourcesScenario(call: Call, setStore: (store: StoreDeps) => void, a: TestStore, b: TestStore): Promise<void> {
  const fetchOptions = routedFetch(a, b);
  const envA: StoreDeps = { indexes: [{ url: STORE_URL, publicKey: a.publicKey, origin: 'env' }], fetch: fetchOptions };
  setStore(envA);
  a.publish('alpha', '1.0.0', '10 Ω');
  b.publish('beta', '1.0.0', '5 Ω');
  const settings = async () => await call('GET', '/api/settings/stores');
  const put = async (sources: unknown[], etag: string) => await call('PUT', '/api/settings/stores', { sources }, { 'if-match': etag });
  const q = (what: string, params: Record<string, string>) => call('GET', `/api/settings/stores/${what}?${new URLSearchParams(params)}`);
  const sourceB = { url: OTHER_URL, publicKey: b.publicKey, label: 'Friends' };

  // the deployment's store is listed read-only; the official one has no key yet
  const first = await settings();
  expect(first.status).toBe(200);
  expect(first.body.allowUserSources).toBe(true);
  expect(first.body.official).toMatchObject({ state: 'not-enabled', keyId: '289BB53D1B721017' });
  expect(first.body.sources).toEqual([expect.objectContaining({ url: STORE_URL, origin: 'env', readOnly: true, enabled: true, fingerprint: storeKeyFingerprint(a.publicKey).fingerprint })]);

  // preview: the store's name, publishers, pack count and the key's fingerprint
  const preview = await q('preview', { url: OTHER_URL, key: b.publicKey });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body).toMatchObject({ ok: true, store: { name: 'Test store' }, packs: 1, ...storeKeyFingerprint(b.publicKey) });
  // refused: a different key, plain http, a private address, a missing key
  expect((await q('preview', { url: OTHER_URL, key: a.publicKey })).status).toBe(422);
  expect((await q('preview', { url: 'http://other.example/s/index.json', key: b.publicKey })).status).toBe(400);
  const priv = await q('preview', { url: 'https://private.example/s/index.json', key: b.publicKey });
  expect(priv.status).toBe(502);
  expect(priv.body.error).toMatch(/private network/);
  expect((await q('preview', { url: OTHER_URL, key: 'not a key' })).status).toBe(400);

  // fetch the key from the store's wirehub-store.pub: trust on first use, said plainly
  b.override.set('wirehub-store.pub', null);
  expect((await q('key', { url: OTHER_URL })).status).toBe(502);
  b.override.set('wirehub-store.pub', new TextEncoder().encode(`untrusted comment: minisign public key\n${b.publicKey}\n`));
  const fetchedKey = await q('key', { url: OTHER_URL });
  expect(fetchedKey.status, JSON.stringify(fetchedKey.body)).toBe(200);
  expect(fetchedKey.body).toMatchObject({ publicKey: b.publicKey, fingerprint: storeKeyFingerprint(b.publicKey).fingerprint, from: 'https://other.example/s/wirehub-store.pub' });
  expect(fetchedKey.body.notice).toMatch(/Compare the fingerprint/);
  b.override.clear();

  // saving: If-Match required and checked, the key verified, an env URL refused
  const etag0 = first.headers!['ETag']!;
  expect((await call('PUT', '/api/settings/stores', { sources: [] })).status).toBe(428);
  expect((await put([{ url: OTHER_URL, publicKey: a.publicKey }], etag0)).status).toBe(422);
  expect((await put([{ url: STORE_URL, publicKey: a.publicKey }], etag0)).status).toBe(409);
  expect((await settings()).body.sources).toHaveLength(1);
  const saved = await put([sourceB], etag0);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.sources).toEqual([expect.objectContaining({ origin: 'env', readOnly: true }), expect.objectContaining({ url: OTHER_URL, origin: 'user', label: 'Friends', enabled: true, readOnly: false })]);
  expect((await put([], etag0)).status).toBe(409);

  // browse: both stores, each pack says where it is from
  const list = (await call('GET', '/api/packs/store')).body;
  expect(list.indexes.map((i: { url: string; ok: boolean; source: string }) => [i.url, i.ok, i.source])).toEqual([[STORE_URL, true, 'env'], [OTHER_URL, true, 'user']]);
  expect(list.packs.map((p: { id: string; index: string; storeLabel: string }) => [p.id, p.index, p.storeLabel])).toEqual([['alpha', STORE_URL, 'Test store'], ['beta', OTHER_URL, 'Friends']]);

  // one store down: the other still lists, and the failure is named
  b.override.set('index.json', null);
  const down = (await call('GET', '/api/packs/store')).body;
  expect(down.indexes[1]).toMatchObject({ url: OTHER_URL, ok: false, error: expect.stringMatching(/Could not fetch the index/) });
  expect(down.packs.map((p: { id: string }) => p.id)).toEqual(['alpha']);
  // "re-check now" says the same, then recovers
  expect((await q('check', { url: OTHER_URL })).status).toBe(502);
  b.override.clear();
  expect((await q('check', { url: OTHER_URL })).body).toMatchObject({ ok: true, packs: 1 });
  expect((await q('check', { url: STORE_URL })).status).toBe(200);
  expect((await q('check', { url: 'https://nowhere.example/index.json' })).status).toBe(404);

  // install from the added store: its origin is that index; updates come only from it
  const done = await call('POST', '/api/packs/store/install', { index: OTHER_URL, id: 'beta', apply: true });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect((await call('GET', '/api/packs')).body.packs.find((p: { id: string }) => p.id === 'beta')).toMatchObject({ version: '1.0.0', origin: { index: OTHER_URL } });
  a.publish('beta', '1.5.0', '7 Ω');
  b.publish('beta', '1.1.0', '6 Ω');
  const after = (await call('GET', '/api/packs/store')).body.packs;
  expect(after.find((p: { index: string; id: string }) => p.index === OTHER_URL && p.id === 'beta')).toMatchObject({ action: 'update', installed: '1.0.0' });
  expect(after.find((p: { index: string; id: string }) => p.index === STORE_URL && p.id === 'beta')).toMatchObject({ action: 'other-store', installedFrom: OTHER_URL });

  // rename and disable: a disabled store is not browsed and cannot be installed from
  const cur = await settings();
  const renamed = await put([{ ...sourceB, label: 'Pals', enabled: false }], cur.headers!['ETag']!);
  expect(renamed.status).toBe(200);
  expect(renamed.body.sources[1]).toMatchObject({ label: 'Pals', enabled: false });
  expect((await call('GET', '/api/packs/store')).body.indexes.map((i: { url: string }) => i.url)).toEqual([STORE_URL]);
  expect((await call('POST', '/api/packs/store/install', { index: OTHER_URL, id: 'beta' })).status).toBe(404);
  // a disabled store can still be re-checked
  expect((await q('check', { url: OTHER_URL })).status).toBe(200);
  const enabled = await put([{ ...sourceB, label: 'Pals' }], renamed.headers!['ETag']!);
  expect((await call('GET', '/api/packs/store')).body.packs.find((p: { id: string; index: string }) => p.id === 'beta' && p.index === OTHER_URL).storeLabel).toBe('Pals');

  // the deployment wins on the same URL (and shows it read-only)
  setStore({ ...envA, indexes: [...envA.indexes, { url: OTHER_URL, publicKey: b.publicKey, origin: 'env', label: 'Server label' }] });
  const merged = (await call('GET', '/api/packs/store')).body;
  expect(merged.indexes.filter((i: { url: string }) => i.url === OTHER_URL)).toEqual([expect.objectContaining({ source: 'env', label: 'Server label' })]);
  expect((await settings()).body.sources.find((s: { url: string; origin: string }) => s.url === OTHER_URL && s.origin === 'user')).toMatchObject({ shadowed: true });
  setStore(envA);

  // an admin can lock sources to the environment
  setStore({ ...envA, allowUserSources: false });
  const locked = await settings();
  expect(locked.body.allowUserSources).toBe(false);
  expect((await put([], enabled.headers!['ETag']!)).status).toBe(403);
  expect((await q('preview', { url: OTHER_URL, key: b.publicKey })).status).toBe(403);
  expect((await call('GET', '/api/packs/store')).body.indexes.map((i: { url: string }) => i.url)).toEqual([STORE_URL]);
  setStore(envA);

  // remove: gone from browsing, the installed pack and its recorded origin stay
  const last = await settings();
  const removed = await put([], last.headers!['ETag']!);
  expect(removed.status).toBe(200);
  expect(removed.body.sources).toHaveLength(1);
  expect((await call('GET', '/api/packs/store')).body.indexes.map((i: { url: string }) => i.url)).toEqual([STORE_URL]);
  expect((await call('GET', '/api/packs')).body.packs.find((p: { id: string }) => p.id === 'beta')).toMatchObject({ version: '1.0.0', origin: { index: OTHER_URL } });
}
