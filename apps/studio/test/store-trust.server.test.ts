/**
 * Catalog store phase 5 on the file backend (`server/store.ts`): publisher
 * signatures over pack manifests, review status (and the deployment setting that
 * hides unreviewed versions), yanked versions and revoked keys. The index, bundles
 * and signatures are made by `scripts/store-index.mjs` with key pairs generated in
 * the test (`store-fixture.ts`); nothing here is a real key.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross, readInstalledPacks } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { StudioUser } from '../server/me.ts';
import { readPackBytes } from '../server/pack-archive.ts';
import { storeIndexesFromEnv } from '../server/store.ts';
import { STORE_URL, createTestStore, type TestStore } from './store-fixture.ts';

const editor: StudioUser = { name: 'Ed', source: 'local', role: 'editor' };
const owner: StudioUser = { name: 'Ow', source: 'local', role: 'owner' };

describe('catalog store phase 5', { timeout: 120_000 }, () => {
  let root = '';
  let dir = '';
  let packs = '';
  let store: TestStore;
  let deps: WorkbenchDeps;
  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', user?: StudioUser): Promise<{ status: number; body: any }> =>
    (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(user === undefined ? {} : { user }) }, deps)) as { status: number; body: any };
  const install = (body: object, user?: StudioUser) => call('/api/packs/store/install', { index: STORE_URL, id: 'alpha', ...body }, 'POST', user);
  const hub = () => createCatalog(catalogWithPacksSource(dir, packs));
  const listed = async () => (await call('/api/packs/store')).body;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-store5-'));
    dir = join(root, 'catalog');
    packs = join(root, 'packs');
    cpSync(dataPath(''), dir, { recursive: true });
    store = createTestStore();
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

  /** a publisher `tester` with the test key, and alpha 1.0.0 signed by it */
  const signedStore = (): void => {
    store.signWith = [store.publisherKeyFile];
    store.publish('alpha', '1.0.0', '10');
    store.meta('publisher', '--id', 'tester', '--name', 'Test publisher', '--pubkey', store.publisherPublicKey, '--url', 'https://tester.example');
  };

  it('installs a pack signed by its publisher and records where it came from and who signed it', async () => {
    signedStore();
    const list = await listed();
    expect(list.packs[0]).toMatchObject({ id: 'alpha', publisher: { id: 'tester', name: 'Test publisher', url: 'https://tester.example' }, latest: { version: '1.0.0', review: { status: 'unreviewed' } }, releases: [{ version: '1.0.0', review: { status: 'unreviewed' } }] });
    expect(list.notices).toEqual([]);
    const done = await install({ apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.from).toMatchObject({ publisher: 'tester', signedBy: [store.publisherPublicKey], review: { status: 'unreviewed' } });
    expect(readInstalledPacks(packs).packs[0]?.origin).toEqual({ index: STORE_URL, publisher: 'tester', signedBy: [store.publisherPublicKey] });
    expect((await call('/api/packs')).body.packs[0]).toMatchObject({ id: 'alpha', origin: { publisher: 'tester' } });
    // installing it again from a file forgets the store origin (an update to another version from the file)
    store.publish('alpha', '1.1.0', '11');
    const file = readFileSync(join(store.site, 'alpha-1.1.0.zip'));
    expect((await call('/api/packs/install', { zip: file.toString('base64'), apply: true })).body).toMatchObject({ installed: true, signed: true });
    expect(readInstalledPacks(packs).packs[0]?.origin).toBeUndefined();
  });

  it('refuses a pack the index says is signed when it is unsigned, signed by another key, or its files differ', async () => {
    signedStore();
    const index = () => JSON.parse(readFileSync(join(store.site, 'index.json'), 'utf8'));
    const zip = new Uint8Array(readFileSync(join(store.site, 'alpha-1.0.0.zip')));
    const read = readPackBytes(zip);
    const manifest = JSON.parse(new TextDecoder().decode(read.shipped.get('wirehub-pack.json')));
    const components = JSON.parse(new TextDecoder().decode(read.shipped.get('components.json')));
    const bundle = (over: object) => new TextEncoder().encode(JSON.stringify({ format: 1, manifest, files: { 'components.json': components }, signature: read.signature, ...over }));

    // the same pack as a JSON bundle verifies (canonical JSON pins)
    store.relist('alpha', '1.0.0', bundle({}));
    expect((await install({})).body, 'json bundle').toMatchObject({ verified: true, from: { publisher: 'tester' } });
    // unsigned
    const { signature: _drop, ...unsigned } = JSON.parse(new TextDecoder().decode(bundle({})));
    store.relist('alpha', '1.0.0', new TextEncoder().encode(JSON.stringify(unsigned)));
    let refused = await install({ apply: true });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/not signed/);
    // a file changed after signing
    store.relist('alpha', '1.0.0', bundle({ files: { 'components.json': [{ ...components[0], value: '99' }] } }));
    refused = await install({ apply: true });
    expect(refused.body.error).toMatch(/do not match the signed manifest.*components\.json/);
    // the manifest changed after signing
    store.relist('alpha', '1.0.0', bundle({ manifest: { ...manifest, name: 'Alpha!' } }));
    expect((await install({ apply: true })).body.error).toMatch(/signature does not hold.*does not match the manifest/);
    // the index names a publisher whose key did not sign it
    store.relist('alpha', '1.0.0', zip);
    const fresh = index();
    fresh.publishers[0].key = store.otherPublicKey;
    writeFileSync(join(store.site, 'index.json'), `${JSON.stringify(fresh, null, 2)}\n`);
    store.cli('sign', join(store.site, 'index.json'), '--key', store.keyFile);
    expect((await install({ apply: true })).body.error).toMatch(/no signature in it is by a key of its publisher/);
    expect(readInstalledPacks(packs).packs).toEqual([]);
  });

  it('accepts a rotated key, refuses a pack signed only by a revoked key, and flags one installed before the revocation', async () => {
    signedStore();
    expect((await install({ apply: true })).status).toBe(200);
    // rotation: 1.1.0 is signed by both keys, the publisher's current key is the new one (the old stays valid)
    store.signWith = [store.publisherKeyFile, store.otherKeyFile];
    store.publish('alpha', '1.1.0', '11');
    store.meta('publisher', '--id', 'tester', '--name', 'Test publisher', '--pubkey', store.otherPublicKey);
    // then the old key is revoked: 1.0.0 (only the old key) is refused and flagged where installed; 1.1.0 still verifies with the new one
    store.meta('revoke', '--pubkey', store.publisherPublicKey, '--reason', 'key lost', '--on', '2026-10-05');
    const list = await listed();
    expect(list.packs[0].releases).toEqual([
      { version: '1.1.0', review: { status: 'unreviewed' } },
      { version: '1.0.0', review: { status: 'unreviewed' }, revoked: true },
    ]);
    expect(list.notices).toEqual([expect.objectContaining({ id: 'alpha', version: '1.0.0', revoked: [{ key: store.publisherPublicKey, reason: 'key lost', on: '2026-10-05' }], suggest: '1.1.0' })]);
    const refused = await install({ version: '1.0.0', apply: true, force: true });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/signed only by a revoked key: key lost/);
    const update = await install({ apply: true });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body.from.signedBy).toEqual([store.otherPublicKey]);
    expect((await listed()).notices).toEqual([]);
  });

  it('warns about a yanked version, never offers it, and installs it only when an owner forces it', async () => {
    store.publish('alpha', '1.0.0', '10');
    store.publish('alpha', '1.1.0', '11');
    store.meta('yank', 'alpha@1.1.0', '--reason', 'wrong value', '--on', '2026-10-05');
    let list = await listed();
    expect(list.packs[0]).toMatchObject({ latest: { version: '1.0.0' }, action: 'install', releases: [{ version: '1.1.0', yanked: { reason: 'wrong value', on: '2026-10-05' } }, { version: '1.0.0' }] });
    // the default install takes the newest version that is not yanked
    expect((await install({})).body.from.version).toBe('1.0.0');
    const named = await install({ version: '1.1.0', apply: true });
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({ error: /yanked by the index publisher: wrong value/, hint: /1\.0\.0 is.*force/, yanked: { reason: 'wrong value' } });
    expect((await install({ version: '1.1.0', apply: true, force: true }, editor)).status).toBe(403);
    expect(readInstalledPacks(packs).packs).toEqual([]);
    const forced = await install({ version: '1.1.0', apply: true, force: true }, owner);
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    expect(forced.body.from).toMatchObject({ version: '1.1.0', yanked: { reason: 'wrong value' } });
    // installed and yanked: flagged, with the version to move to
    list = await listed();
    expect(list.notices).toEqual([expect.objectContaining({ id: 'alpha', version: '1.1.0', yanked: { reason: 'wrong value', on: '2026-10-05' }, suggest: '1.0.0' })]);
    store.publish('alpha', '1.2.0', '12');
    expect((await listed()).notices[0]).toMatchObject({ suggest: '1.2.0' });
    // every version yanked: nothing offered
    store.meta('yank', 'alpha@1.0.0', '--reason', 'old');
    store.meta('yank', 'alpha@1.2.0', '--reason', 'also wrong');
    expect((await listed()).packs[0]).toMatchObject({ action: 'current' });
    rmSync(packs, { recursive: true, force: true });
    expect((await listed()).packs[0]).toMatchObject({ action: 'unavailable' });
    expect((await install({})).status).toBe(409);
  });

  it('shows the review status, flags an installed flagged version, and hides unreviewed versions when the deployment asks', async () => {
    store.publish('alpha', '1.0.0', '10');
    store.publish('alpha', '1.1.0', '11');
    store.publish('beta', '1.0.0', '20');
    store.meta('review', 'alpha@1.0.0', '--status', 'reviewed', '--by', 'reviewer', '--on', '2026-10-04');
    store.meta('review', 'alpha@1.1.0', '--status', 'flagged', '--reason', 'values not sourced');
    const list = await listed();
    const alpha = list.packs.find((p: { id: string }) => p.id === 'alpha');
    expect(alpha.latest).toMatchObject({ version: '1.1.0', review: { status: 'flagged', reason: 'values not sourced' } });
    expect(alpha.releases[1]).toEqual({ version: '1.0.0', review: { status: 'reviewed', by: 'reviewer', on: '2026-10-04' } });
    expect((await install({ apply: true })).status).toBe(200);
    expect((await listed()).notices).toEqual([expect.objectContaining({ id: 'alpha', version: '1.1.0', review: { status: 'flagged', reason: 'values not sourced' } })]);

    // the setting: unreviewed versions (beta, all of it) are hidden and not installed from the store
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: 'none', WIREHUB_STORE_HIDE_UNREVIEWED: 'true' }).hideUnreviewed).toBe(true);
    expect(storeIndexesFromEnv({ WIREHUB_STORE_INDEXES: 'none' }).hideUnreviewed).toBeUndefined();
    deps.store = { ...deps.store!, hideUnreviewed: true };
    const hidden = await listed();
    expect(hidden.packs.map((p: { id: string }) => p.id)).toEqual(['alpha']);
    expect(hidden).toMatchObject({ hideUnreviewed: true, hidden: 1 });
    const refused = await call('/api/packs/store/install', { index: STORE_URL, id: 'beta' });
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatch(/only reviewed versions/);
  });

  it('refuses a file install whose manifest pins files that do not match', async () => {
    store.signWith = [store.publisherKeyFile];
    store.publish('alpha', '1.0.0', '10');
    const read = readPackBytes(new Uint8Array(readFileSync(join(store.site, 'alpha-1.0.0.zip'))));
    const manifest = JSON.parse(new TextDecoder().decode(read.shipped.get('wirehub-pack.json')));
    const refused = await call('/api/packs/install', { bundle: { format: 1, manifest, files: { 'components.json': [{ id: 'alpha-r', label: 'x', kind: 'resistor', terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example' }] } }, apply: true });
    expect(refused.status).toBe(422);
    expect(refused.body.problems[0]).toMatch(/does not match the sha256 the manifest pins/);
  });
});
