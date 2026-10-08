/**
 * The store template (`templates/store`) end to end, locally: throwaway keys in a
 * temporary directory, the build the action runs (`.github/actions/build-store/build-store.sh`,
 * the very script the workflow calls), verification of the result, and a store-sources
 * preview in the app accepting it (served through the fixture's injected fetch).
 * No key is committed; the keys live in the temporary directory.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross } from '@wirehub/catalog';
import { parseStoreIndex, storeKeyFingerprint } from '@wirehub/catalog/src/server.ts';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { fileDocStore } from '../server/storage/doc-store.ts';
import { createTestStore, STORE_URL, type TestStore } from './store-fixture.ts';

// process.cwd() is apps/studio under vitest
const repo = join(process.cwd(), '../..');
const template = join(repo, 'templates/store');
const action = join(repo, '.github/actions/build-store');
const tool = join(repo, 'scripts/store-index.mjs');

const node = (...args: string[]): string => execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WIREHUB_STORE_SIGNING_KEY: '', WIREHUB_PACK_SIGNING_KEY: '' } });

/** the build the workflow runs, in `cwd`, with the secrets as environment */
function build(cwd: string, env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync('bash', [join(action, 'build-store.sh')], { cwd, encoding: 'utf8', env: { ...process.env, WIREHUB_STORE_SIGNING_KEY: '', WIREHUB_PACK_SIGNING_KEY: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', STORE_ID: 'My_Test Store', STORE_NAME: 'My test store', ...env } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the store template', { timeout: 180_000 }, () => {
  let root = '';
  let repoDir = '';
  let keys = '';
  let fixture: TestStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-template-'));
    repoDir = join(root, 'my-store');
    keys = join(root, 'keys');
    cpSync(template, repoDir, { recursive: true });
    fixture = createTestStore();
  });
  afterEach(() => {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** what README step 2 does: both key pairs, and the publisher's key in store-meta.json */
  function makeKeys(): { storePub: string; publisherPub: string } {
    node('keygen', '--out', join(keys, 'store'));
    node('publisher-keygen', '--out', join(keys, 'publisher'), '--id', 'my-shop', '--name', 'My shop');
    const publisherPub = node('pubkey', '--key', join(keys, 'publisher', 'wirehub-publisher.key')).trim();
    const metaFile = join(repoDir, 'store-meta.json');
    writeFileSync(metaFile, readFileSync(metaFile, 'utf8').replace('RWREPLACE-WITH-YOUR-PUBLISHER-PUBLIC-KEY', publisherPub));
    return { storePub: node('pubkey', '--key', join(keys, 'store', 'wirehub-store.key')).trim(), publisherPub };
  }
  const secrets = (): Record<string, string> => ({
    WIREHUB_STORE_SIGNING_KEY: readFileSync(join(keys, 'store', 'wirehub-store.key'), 'utf8'),
    WIREHUB_PACK_SIGNING_KEY: readFileSync(join(keys, 'publisher', 'wirehub-publisher.key'), 'utf8'),
  });

  it('builds, signs and verifies, and a hub accepts the result as a store source', async () => {
    const { storePub, publisherPub } = makeKeys();
    const run = build(repoDir, secrets());
    expect(run.status, run.output).toBe(0);

    const site = join(repoDir, '_site');
    expect(readdirSync(site).sort()).toEqual(['example-pack-0.1.0.zip', 'index.html', 'index.json', 'index.json.minisig', 'wirehub-store.pub']);
    expect(readFileSync(join(site, 'wirehub-store.pub'), 'utf8')).toContain(storePub);
    const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
    expect(parseStoreIndex(index).problems).toEqual([]);
    expect(index.store).toMatchObject({ id: 'my-test-store', name: 'My test store' });
    expect(index.publishers).toEqual([expect.objectContaining({ id: 'my-shop', key: publisherPub })]);
    expect(index.packs).toEqual([expect.objectContaining({ id: 'example-pack', versions: [expect.objectContaining({ version: '0.1.0', url: 'example-pack-0.1.0.zip', signedBy: [publisherPub] })] })]);

    // the same checks a person can run by hand
    expect(node('verify', join(site, 'index.json'), '--pubkey', join(site, 'wirehub-store.pub'))).toMatch(/verified/);
    expect(node('verify-pack-signature', join(site, 'example-pack-0.1.0.zip'), '--pubkey', publisherPub)).toMatch(/verified/);
    // the packs directory of the repository was not touched by signing
    expect(existsSync(join(repoDir, 'packs/example-pack/wirehub-pack.sig'))).toBe(false);

    // a hub previews it in Settings > Store sources, and fetches its key from beside the index
    rmSync(fixture.site, { recursive: true, force: true });
    cpSync(site, fixture.site, { recursive: true });
    const catalog = join(root, 'catalog');
    const packs = join(root, 'packs');
    cpSync(dataPath(''), catalog, { recursive: true });
    const deps: WorkbenchDeps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => createCatalog(catalogWithPacksSource(catalog, packs)).loadDb(),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(catalog, packs).packs }),
      setup: { dataDir: catalog, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
      docs: fileDocStore(join(root, 'docs')),
      store: { indexes: [], fetch: fixture.fetch },
    };
    const get = async (path: string) => (await handleWorkbenchRequest({ method: 'GET', path }, deps)) as { status: number; body: any };
    const preview = await get(`/api/settings/stores/preview?${new URLSearchParams({ url: STORE_URL, key: storePub })}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, store: { name: 'My test store' }, packs: 1, ...storeKeyFingerprint(storePub) });
    const fetched = await get(`/api/settings/stores/key?${new URLSearchParams({ url: STORE_URL })}`);
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    expect(JSON.stringify(fetched.body)).toContain(storePub);
    // the wrong key is refused
    expect((await get(`/api/settings/stores/preview?${new URLSearchParams({ url: STORE_URL, key: fixture.publicKey })}`)).status).toBe(422);
  });

  it('builds a code module from modules/ into a signed pack beside the data packs', () => {
    const { publisherPub } = makeKeys();
    // a module package, as a store repository holds it (its own files only: @wirehub/* come from the tooling)
    cpSync(join(repo, 'modules/example'), join(repoDir, 'modules/example'), { recursive: true, filter: (path) => !path.includes('node_modules') });
    const run = build(repoDir, secrets());
    expect(run.status, run.output.slice(-3000)).toBe(0);
    const site = join(repoDir, '_site');
    expect(readdirSync(site).filter((f) => f.endsWith('.zip')).sort()).toEqual(['example-0.1.0.zip', 'example-pack-0.1.0.zip']);
    const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
    expect(index.packs.find((p: { id: string }) => p.id === 'example')).toMatchObject({ versions: [expect.objectContaining({ version: '0.1.0', signedBy: [publisherPub] })] });
    expect(node('verify-pack-signature', join(site, 'example-0.1.0.zip'), '--pubkey', publisherPub)).toMatch(/verified/);
    // without the publisher key there is no build: a hub would refuse unsigned code anyway
    const unsigned = build(repoDir, { ...secrets(), WIREHUB_PACK_SIGNING_KEY: '' });
    expect(unsigned.status).not.toBe(0);
    expect(unsigned.output).toMatch(/holds code modules/);
  });

  it('keeps every version directory and refuses a build that is not set up', () => {
    const { publisherPub } = makeKeys();
    // a second version beside the first, as the README says to release
    const next = join(repoDir, 'packs/example-pack-0.2.0');
    cpSync(join(repoDir, 'packs/example-pack'), next, { recursive: true });
    writeFileSync(join(next, 'wirehub-pack.json'), readFileSync(join(next, 'wirehub-pack.json'), 'utf8').replace('"0.1.0"', '"0.2.0"'));
    const run = build(repoDir, secrets());
    expect(run.status, run.output).toBe(0);
    const index = JSON.parse(readFileSync(join(repoDir, '_site/index.json'), 'utf8'));
    expect(index.packs[0].versions.map((v: { version: string }) => v.version)).toEqual(['0.2.0', '0.1.0']);

    // no store key: refused, nothing is published unsigned
    const none = build(repoDir, { ...secrets(), WIREHUB_STORE_SIGNING_KEY: '' });
    expect(none.status).not.toBe(0);
    expect(none.output).toMatch(/WIREHUB_STORE_SIGNING_KEY/);
    // the publisher is listed but the packs are not signed: the build says so
    const unsigned = build(repoDir, { ...secrets(), WIREHUB_PACK_SIGNING_KEY: '' });
    expect(unsigned.status).not.toBe(0);
    expect(unsigned.output).toMatch(/publisher 'my-shop'/);
    expect(publisherPub).toMatch(/^RW/);
  });

  it('refuses the placeholder publisher key of a fresh template', () => {
    node('keygen', '--out', join(keys, 'store'));
    const run = build(repoDir, { WIREHUB_STORE_SIGNING_KEY: readFileSync(join(keys, 'store', 'wirehub-store.key'), 'utf8') });
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/placeholder publisher key/);
  });

  it('publishes without pack signatures when the publisher is dropped', () => {
    node('keygen', '--out', join(keys, 'store'));
    writeFileSync(join(repoDir, 'store-meta.json'), '{}\n');
    const run = build(repoDir, { WIREHUB_STORE_SIGNING_KEY: readFileSync(join(keys, 'store', 'wirehub-store.key'), 'utf8') });
    expect(run.status, run.output).toBe(0);
    expect(existsSync(join(repoDir, '_site/index.json.minisig'))).toBe(true);
  });

  it('ignores key files in the template, and its workflows are well formed', () => {
    const ignore = readFileSync(join(template, '.gitignore'), 'utf8').split('\n');
    for (const pattern of ['*.key', '*.pem', 'wirehub-store.key', 'wirehub-publisher.key']) expect(ignore).toContain(pattern);
    // the template's pack is a valid pack by the repository's own checker, and CC0
    const out = execFileSync(process.execPath, [join(repo, '.agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs'), join(template, 'packs/example-pack')], { encoding: 'utf8' });
    expect(out).not.toMatch(/error/i);
    expect(JSON.parse(readFileSync(join(template, 'packs/example-pack/wirehub-pack.json'), 'utf8')).license).toBe('CC0-1.0');
    expect(spawnSync('bash', ['-n', join(action, 'build-store.sh')]).status).toBe(0);
    for (const file of ['action.yml', 'build-store.sh']) expect(existsSync(join(action, file))).toBe(true);

    const lint = spawnSync('actionlint', [join(template, '.github/workflows/publish.yml')], { encoding: 'utf8' });
    if ((lint.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      console.warn('actionlint is not installed: workflow lint skipped (install it to lint templates/store/.github/workflows/publish.yml)');
      return;
    }
    expect(`${lint.stdout}${lint.stderr}`).toBe('');
  });
});
