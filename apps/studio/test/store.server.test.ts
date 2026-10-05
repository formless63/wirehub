/**
 * Store browsing and install from a signed index (`server/store.ts`), on the file
 * backend: the index is verified against the trusted key, the download against the
 * index, and the install goes through the ordinary pack lifecycle (diff, then one
 * change set). The index, bundles and signature are made by `scripts/store-index.mjs`
 * with a key pair generated in the test.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross, readInstalledPacks, storePublicKeyOf } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { scopeFor } from '../server/auth/tokens.ts';
import { OFFICIAL_STORE_INDEX_URL, OFFICIAL_STORE_PUBLIC_KEY, storeIndexesFromEnv } from '../server/store.ts';
import { STORE_URL, createTestStore, type TestStore } from './store-fixture.ts';

describe('WIREHUB_STORE_INDEXES', () => {
  const key = storePublicKeyOf(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
  it('reads "<url> <key>" entries separated by commas or new lines, and says what it ignored', () => {
    const read = storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: `https://a.example/index.json ${key},\nhttps://b.example/store/index.json ${key}, http://c.example/i.json ${key}, https://d.example/i.json nonsense, lonely` });
    expect(read.indexes.map((i) => i.url)).toEqual(['https://a.example/index.json', 'https://b.example/store/index.json']);
    expect(read.problems?.join('\n')).toMatch(/https only[\s\S]*not a minisign public key[\s\S]*'lonely'/);
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: '' }).indexes).toEqual([]);
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: 'none' }).indexes).toEqual([]);
  });
  it('trusts the official index by default: the recorded key, origin official, nothing fetched at construction', () => {
    expect(OFFICIAL_STORE_PUBLIC_KEY).toMatch(/^RW/);
    expect(storeIndexesFromEnv({}).indexes).toEqual([{ url: OFFICIAL_STORE_INDEX_URL, publicKey: OFFICIAL_STORE_PUBLIC_KEY, origin: 'official' }]);
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: 'official' }).indexes.map((i) => i.origin)).toEqual(['official']);
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: 'none' }).indexes).toEqual([]);
  });
  it('takes an injected official index (a test key and a local URL) instead of the recorded one', () => {
    const official = { url: 'https://official.test/index.json', publicKey: key };
    expect(storeIndexesFromEnv({}, official).indexes).toEqual([{ ...official, origin: 'official' }]);
    expect(storeIndexesFromEnv({}, { ...official, publicKey: '' }).indexes).toEqual([]);
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: 'official' }, { ...official, publicKey: '' }).problems?.[0]).toMatch(/no public key/);
  });
  it('the test environment trusts no official index (so no test reaches the real one)', () => {
    expect(storeIndexesFromEnv().indexes).toEqual([]);
  });
  it('lets no API token install from the store', () => {
    expect(scopeFor('POST', '/api/packs/store/install')).toBeUndefined();
    expect(scopeFor('GET', '/api/packs/store')).toBe('read');
  });
});

describe('/api/packs/store', () => {
  let root = '';
  let dir = '';
  let packs = '';
  let store: TestStore;
  let deps: WorkbenchDeps;
  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; body: any }> =>
    (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
  const hub = () => createCatalog(catalogWithPacksSource(dir, packs));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-store-hub-'));
    dir = join(root, 'catalog');
    packs = join(root, 'packs');
    cpSync(dataPath(''), dir, { recursive: true });
    store = createTestStore();
    store.publish('alpha', '1.0.0', '10');
    deps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => hub().loadDb(),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
      setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
      store: { indexes: [{ url: STORE_URL, publicKey: store.publicKey }], fetch: store.fetch },
    };
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the packs of a verified index, with the disclaimer, licence and domain as information', async () => {
    const list = await call('/api/packs/store');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.disclaimer).toMatch(/published by their authors, who are responsible/);
    expect(list.body.indexes).toEqual([{ url: STORE_URL, ok: true, source: 'env', label: 'Test store', store: { id: 'test-store', name: 'Test store' }, packs: 1 }]);
    expect(list.body.packs).toEqual([
      expect.objectContaining({ index: STORE_URL, id: 'alpha', name: 'Store alpha', domain: 'test-domain', license: 'CC-BY-4.0', author: { id: 'tester', name: 'Test publisher' }, latest: expect.objectContaining({ version: '1.0.0' }), action: 'install' }),
    ]);
    expect(list.body.domains).toEqual(['test-domain']);
    expect(store.fetched).toEqual([STORE_URL, `${STORE_URL}.minisig`]);
  });

  it('refuses an index whose signature does not match the trusted key, or that is unsigned', async () => {
    const other = storePublicKeyOf(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
    deps.store = { indexes: [{ url: STORE_URL, publicKey: other }], fetch: store.fetch };
    let list = await call('/api/packs/store');
    expect(list.body.packs).toEqual([]);
    expect(list.body.indexes[0]).toMatchObject({ ok: false, error: /refused: the index was signed by a different key/ });
    // a changed index under the right key
    deps.store = { indexes: [{ url: STORE_URL, publicKey: store.publicKey }], fetch: store.fetch };
    const text = readFileSync(join(store.site, 'index.json'), 'utf8').replace('"Store alpha"', '"Store alpha!"');
    store.override.set('index.json', new TextEncoder().encode(text));
    list = await call('/api/packs/store');
    expect(list.body.indexes[0]).toMatchObject({ ok: false, error: /does not match the index/ });
    // no signature at all
    store.override.clear();
    store.override.set('index.json.minisig', null);
    list = await call('/api/packs/store');
    expect(list.body.indexes[0]).toMatchObject({ ok: false, error: /unsigned index is refused/ });
    expect((await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true })).status).toBe(502);
    expect(readInstalledPacks(packs).packs).toEqual([]);
  });

  it('previews the diff, installs as one change set, then offers and applies an update', async () => {
    const preview = await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha' });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ kind: 'install', source: 'zip', verified: true, applicable: true, from: { id: 'alpha', version: '1.0.0', license: 'CC-BY-4.0' } });
    expect(preview.body.plan.diff.added.map((r: { id: string }) => r.id)).toEqual(['alpha-r']);
    expect(readInstalledPacks(packs).packs).toEqual([]);

    const done = await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ installed: true, id: 'alpha', version: '1.0.0' });
    expect(hub().loadDb().components.find((c) => c.id === 'alpha-r')?.value).toBe('10');
    expect((await call('/api/packs/store')).body.packs[0]).toMatchObject({ installed: '1.0.0', action: 'current' });

    store.publish('alpha', '1.1.0', '11', true);
    const listed = (await call('/api/packs/store')).body.packs[0];
    expect(listed).toMatchObject({ installed: '1.0.0', action: 'update', latest: { version: '1.1.0' }, versions: ['1.1.0', '1.0.0'] });
    const update = await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha' });
    expect(update.body).toMatchObject({ kind: 'update' });
    expect(update.body.plan.diff.changed.map((r: { id: string }) => r.id)).toEqual(['alpha-r']);
    expect(update.body.plan.diff.added.map((r: { id: string }) => r.id)).toEqual(['alpha-r2']);
    expect((await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true })).body.installed).toBe(true);
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.1.0');
    // an older listed version through the same door (a downgrade, previewed)
    expect((await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', version: '1.0.0' })).body).toMatchObject({ kind: 'update', from: { version: '1.0.0' } });
    // and the installed pack is managed like any other: disable
    expect((await call('/api/packs/alpha', undefined, 'DELETE')).body).toMatchObject({ disabled: 'alpha' });
  });

  it('refuses a download whose sha256 or size does not match the index, before the install flow runs', async () => {
    const name = 'alpha-1.0.0.zip';
    const bytes = new Uint8Array(readFileSync(join(store.site, name)));
    const changed = bytes.slice();
    changed[changed.length - 30] = (changed[changed.length - 30]! + 1) % 256;
    store.override.set(name, changed);
    const refused = await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/does not match the index \(sha256 differs\)/);
    store.override.set(name, bytes.subarray(0, bytes.length - 1));
    expect((await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true })).body.error).toMatch(/size/);
    expect(readInstalledPacks(packs).packs).toEqual([]);
  });

  it('refuses a bundle that is another pack than the index says, an unknown index, pack or version', async () => {
    // re-sign an index that points alpha's entry at beta's bundle
    store.publish('beta', '1.0.0', '20');
    const index = JSON.parse(readFileSync(join(store.site, 'index.json'), 'utf8'));
    const beta = index.packs.find((p: { id: string }) => p.id === 'beta').versions[0];
    index.packs.find((p: { id: string }) => p.id === 'alpha').versions[0] = { ...beta, version: '1.0.0' };
    writeFileSync(join(store.site, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    store.cli('sign', join(store.site, 'index.json'), '--key', store.keyFile);
    const mixed = await call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', apply: true });
    expect(mixed.status).toBe(422);
    expect(mixed.body.error).toMatch(/lists as alpha 1.0.0 is beta 1.0.0/);
    expect((await call('/api/packs/store/install', { index: 'https://elsewhere.example/index.json', id: 'alpha' })).status).toBe(404);
    expect((await call('/api/packs/store/install', { index: STORE_URL, id: 'gamma' })).status).toBe(404);
    expect((await call('/api/packs/store/install', { index: STORE_URL, id: 'beta', version: '9.9.9' })).body.hint).toMatch(/1\.0\.0/);
    expect((await call('/api/packs/store/install', { id: 'beta' })).status).toBe(400);
    // other methods on /api/packs/store are the pack lifecycle's (a pack whose id is 'store')
    expect((await call('/api/packs/store', undefined, 'DELETE')).status).toBe(404);
    expect(readInstalledPacks(packs).packs).toEqual([]);
  });

  it('fetches the official index only when the store is listed, and shows it as down when unreachable', async () => {
    const official = storeIndexesFromEnv({}, { url: STORE_URL, publicKey: store.publicKey });
    const seen: string[] = [];
    const down = (async (input: URL | string): Promise<never> => {
      seen.push(String(input));
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    deps.store = { ...official, fetch: { fetch: down, lookup: async () => ['93.184.216.34'] } };
    expect(seen).toEqual([]);
    const list = await call('/api/packs/store');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.indexes).toEqual([expect.objectContaining({ url: STORE_URL, ok: false, source: 'official', error: expect.any(String) })]);
    expect(list.body.packs).toEqual([]);
  });

  it('lists the official index, when reachable, as source official', async () => {
    deps.store = { ...storeIndexesFromEnv({}, { url: STORE_URL, publicKey: store.publicKey }), fetch: store.fetch };
    const list = await call('/api/packs/store');
    expect(list.body.indexes).toEqual([expect.objectContaining({ url: STORE_URL, ok: true, source: 'official' })]);
  });

  it('says when no index is configured', async () => {
    deps.store = { indexes: [] };
    const list = await call('/api/packs/store');
    expect(list.body).toMatchObject({ packs: [], indexes: [], hint: /WIREHUB_STORE_INDEXES/ });
  });
});

describe('scripts/store-index.mjs', { timeout: 60_000 }, () => {
  let store: TestStore;
  beforeEach(() => {
    store = createTestStore();
  });
  afterEach(() => store.close());

  it('prints the public key of a private key, verifies, and leaves an index unsigned (saying so) without a key', () => {
    expect(store.cli('pubkey', '--key', store.keyFile).trim()).toBe(store.publicKey);
    store.publish('alpha', '1.0.0', '10');
    expect(store.cli('verify', join(store.site, 'index.json'), '--pubkey', store.publicKey)).toMatch(/verified/);
    expect(store.cli('sign', join(store.site, 'index.json'))).toMatch(/UNSIGNED/);
    expect(() => store.cli('sign', join(store.site, 'index.json'), '--required')).toThrow();
    // the same pack always bundles to the same bytes
    const first = readFileSync(join(store.site, 'alpha-1.0.0.zip'));
    store.publish('alpha', '1.0.0', '10');
    expect(readFileSync(join(store.site, 'alpha-1.0.0.zip')).equals(first)).toBe(true);
  });

  it('refuses to write a key pair inside the repository', () => {
    expect(() => store.cli('keygen', '--out', join(process.cwd(), 'tmp-keys'))).toThrow();
  });

  it('builds the official index of the bundled packs (not the example), unsigned until CI signs it', () => {
    const out = join(store.dir, 'official');
    const modules = join(process.cwd(), '../../modules');
    const bundled = readdirSync(modules).filter((id) => id !== 'example' && existsSync(join(modules, id, 'pack/wirehub-pack.json'))).sort();
    expect(bundled).toContain('pro-audio');
    expect(store.cli('official', '--out', out)).toMatch(new RegExp(`index: .*${bundled.length} packs`));
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.store.id).toBe('wirehub');
    expect(index.packs.map((p: { id: string }) => p.id)).toEqual(bundled.map((id) => JSON.parse(readFileSync(join(modules, id, 'pack/wirehub-pack.json'), 'utf8')).id).sort());
    expect(index.packs.every((p: { license: string }) => p.license === 'CC0-1.0')).toBe(true);
  });
});
