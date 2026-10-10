// @vitest-environment jsdom
/**
 * Library → Browse store (`src/modules/StoreBrowser.tsx`) over the real API handler and
 * a signed test store (`store-fixture.ts`, key pair generated in the test): the list
 * with the disclaimer, licence and domain, search and the domain filter, Install with
 * the diff then one change set, and Update; a viewer sees the list but no buttons.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, installedAcross, readInstalledPacks } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toasts } from './toast-spy.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { PacksPanel } from '../src/modules/PacksPanel.tsx';
import { StoreBrowser } from '../src/modules/StoreBrowser.tsx';
import { STORE_URL, createTestStore, type TestStore } from './store-fixture.ts';

vi.mock('sonner', async () => (await import('./toast-spy.ts')).sonnerMock);

beforeEach(() => { toasts.length = 0; });

/** the plan's counts show first; the record list opens on demand */
async function showAllRecords(): Promise<string> {
  const diff = await screen.findByTestId('pack-diff');
  fireEvent.click(within(diff).getByRole('button', { name: 'Show all records' }));
  return diff.textContent ?? '';
}

let root = '';
let dir = '';
let packs = '';
let store: TestStore;
let deps: WorkbenchDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirehub-store-dom-'));
  dir = join(root, 'catalog');
  packs = join(root, 'packs');
  cpSync(join(process.cwd(), '../../packages/catalog/data'), dir, { recursive: true });
  store = createTestStore();
  store.publish('alpha', '1.0.0', '10');
  store.publish('beta', '1.0.0', '20');
  const hub = () => createCatalog(catalogWithPacksSource(dir, packs));
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => hub().loadDb(),
    modules: createRegistry([]),
    installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
    setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
    store: { indexes: [{ url: STORE_URL, publicKey: store.publicKey }], fetch: store.fetch },
  };
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: input, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const row = (id: string): HTMLElement | null => document.querySelector(`[data-store-pack="${id}"]`);

describe('Browse store', () => {
  it('explains an empty store list without registering or installing anything', async () => {
    deps.store = { indexes: [] };
    render(<StoreBrowser />);
    expect((await screen.findByRole('status')).textContent).toContain('No stores are configured');
    expect(screen.getByRole('radiogroup', { name: 'Content type' })).not.toBeNull();
    expect(installedAcross(dir, packs).packs).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Install…' })).toBeNull();
  });

  it('a viewer sees the packs, the disclaimer and the licence, but no Install', async () => {
    deps = { ...deps, localUser: { name: 'Vera', source: 'session', role: 'viewer' } };
    render(<StoreBrowser />);
    await waitFor(() => expect(row('alpha')).not.toBeNull());
    expect(screen.getByTestId('store-disclaimer').textContent).toMatch(/published by their authors, who are responsible for their content and licensing/);
    expect(row('alpha')?.textContent).toContain('licence: CC-BY-4.0');
    expect(row('alpha')?.textContent).toContain('test-domain');
    expect(screen.queryByRole('button', { name: 'Install…' })).toBeNull();
  });

  it('labels code in the offered version and exposes the index permissions as information', async () => {
    const path = join(store.site, 'index.json');
    const index = JSON.parse(readFileSync(path, 'utf8'));
    index.packs.find((p: { id: string }) => p.id === 'alpha').versions[0].module = {
      id: 'alpha', version: '1.0.0', label: 'Alpha module', apiVersion: '1.2', extensionPoints: ['integrations'], permissions: ['network'],
    };
    writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
    store.cli('sign', path, '--key', store.keyFile);
    render(<StoreBrowser />);
    const badge = await screen.findByText('Code module');
    expect(row('alpha')?.contains(badge)).toBe(true);
    expect(badge.title).toMatch(/Permissions stated by the author: network/);
    expect(row('beta')?.textContent).not.toContain('Code module');
    fireEvent.click(screen.getByRole('radio', { name: /Code modules/ }));
    expect(row('alpha')).not.toBeNull();
    expect(row('beta')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Catalog packs/ }));
    expect(row('alpha')).toBeNull();
    expect(row('beta')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    // This index claim does not make the downloaded data-only pack require code consent.
    fireEvent.change(screen.getByLabelText('Search modules and packs'), { target: { value: 'alpha' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Install…' }));
    expect((await screen.findByTestId('store-pending')).textContent).not.toContain('Alpha module');
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Installed alpha 1.0.0.'));
    expect(within(row('alpha')!).queryByRole('link', { name: 'View contents' })).toBeNull();
  });

  it('explains why a configured data-only store has no optional code modules', async () => {
    render(<StoreBrowser />);
    await waitFor(() => expect(row('alpha')).not.toBeNull());
    fireEvent.click(screen.getByRole('radio', { name: /Code modules/ }));
    expect(screen.getByRole('status').textContent).toContain('Only modules published to a configured store appear here');
    expect(screen.getByRole('status').textContent).toContain('built-in modules');
  });

  it('searches, filters by domain, installs with the diff and then offers the update', async () => {
    render(<StoreBrowser />);
    await waitFor(() => expect(row('beta')).not.toBeNull());
    fireEvent.change(screen.getByLabelText('Search modules and packs'), { target: { value: 'alpha' } });
    await waitFor(() => expect(row('beta')).toBeNull());
    expect(row('alpha')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search modules and packs'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'test-domain' }));
    await waitFor(() => expect(row('beta')).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Search modules and packs'), { target: { value: 'alpha' } });
    await waitFor(() => expect(row('beta')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install…' })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Install…' }));
    const pending = await screen.findByTestId('store-pending');
    expect(pending.textContent).toContain('Install alpha 1.0.0');
    expect(await showAllRecords()).toMatch(/Added Components: .*alpha-r/);
    expect(readInstalledPacks(packs).packs).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Installed alpha 1.0.0.'));
    expect(readInstalledPacks(packs).packs[0]).toMatchObject({ id: 'alpha', version: '1.0.0' });
    await waitFor(() => expect(within(row('alpha')!).getByRole('link', { name: 'View contents' }).getAttribute('href')).toBe('/library/connectors?pack=alpha'));
    await waitFor(() => expect(row('alpha')?.textContent).toContain('installed 1.0.0'));

    store.publish('alpha', '1.1.0', '11', true);
    cleanup();
    render(<StoreBrowser />);
    const update = await screen.findByRole('button', { name: 'Update to 1.1.0…' });
    fireEvent.click(update);
    expect(await showAllRecords()).toMatch(/Added Components: .*alpha-r2/);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Updated alpha 1.1.0.'));
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.1.0');
  });

  it('shows an index that does not verify, and lists none of its packs', async () => {
    store.override.set('index.json.minisig', null);
    render(<StoreBrowser />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/unsigned index is refused/);
    expect(screen.getByRole('status').textContent).toContain('No modules or catalog packs are available');
  });

  it('shows who signs a pack and its review, warns about a yanked version, and lets an owner install it anyway', { timeout: 60_000 }, async () => {
    store.signWith = [store.publisherKeyFile];
    store.publish('alpha', '1.0.0', '10');
    store.publish('alpha', '1.1.0', '11');
    // beta stays unsigned, from a publisher the index does not list
    store.signWith = [];
    store.publish('beta', '1.0.0', '20');
    const betaManifest = join(store.dir, 'packs', 'beta-1.0.0', 'wirehub-pack.json');
    writeFileSync(betaManifest, readFileSync(betaManifest, 'utf8').replace('"id": "tester"', '"id": "someone-else"'));
    store.cli('bundle', join(store.dir, 'packs', 'beta-1.0.0'), '--out', store.site);
    store.meta('publisher', '--id', 'tester', '--name', 'Test publisher', '--pubkey', store.publisherPublicKey);
    store.meta('review', 'alpha@1.0.0', '--status', 'reviewed', '--by', 'reviewer', '--on', '2026-10-04');
    store.meta('yank', 'alpha@1.1.0', '--reason', 'wrong value');
    render(<StoreBrowser />);
    await waitFor(() => expect(row('alpha')).not.toBeNull());
    expect(row('alpha')?.querySelector('[data-testid="store-trust"]')?.textContent).toBe('signed by Test publisher · reviewed by reviewer on 2026-10-04');
    expect(row('beta')?.querySelector('[data-testid="store-trust"]')?.textContent).toContain('not signed by a publisher');
    expect(row('alpha')?.querySelector('[data-store-warning="1.1.0"]')?.textContent).toMatch(/Version 1.1.0 was yanked: wrong value/);
    // the offered version is the newest not yanked
    expect(row('alpha')?.textContent).toContain('Install…');
    fireEvent.click(await screen.findByRole('button', { name: 'Install 1.1.0 anyway…' }));
    const pending = await screen.findByTestId('store-pending');
    expect(pending.textContent).toMatch(/This version was yanked: wrong value/);
    expect(pending.textContent).toMatch(/Signature of publisher tester verified/);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Installed alpha 1.1.0.'));
    expect(readInstalledPacks(packs).packs[0]).toMatchObject({ version: '1.1.0', origin: { publisher: 'tester' } });
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Installed: 1.1.0 was yanked by Test store: wrong value. Update to 1.0.0 suggested./));

    // the Packs panel badges the installed yanked version
    cleanup();
    render(<PacksPanel />);
    await waitFor(() => expect(document.querySelector('[data-pack-warning="alpha"]')?.textContent).toMatch(/^Yanked: 1.1.0 was yanked by Test store: wrong value. Update to 1.0.0 suggested./));
  });
});
