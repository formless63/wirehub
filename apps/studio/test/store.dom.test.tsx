// @vitest-environment jsdom
/**
 * Library → Browse store (`src/modules/StoreBrowser.tsx`) over the real API handler and
 * a signed test store (`store-fixture.ts`, key pair generated in the test): the list
 * with the disclaimer, licence and domain, search and the domain filter, Install with
 * the diff then one change set, and Update; a viewer sees the list but no buttons.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, installedAcross, readInstalledPacks } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { StoreBrowser } from '../src/modules/StoreBrowser.tsx';
import { STORE_URL, createTestStore, type TestStore } from './store-fixture.ts';

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
  it('a viewer sees the packs, the disclaimer and the licence, but no Install', async () => {
    deps = { ...deps, localUser: { name: 'Vera', source: 'session', role: 'viewer' } };
    render(<StoreBrowser />);
    await waitFor(() => expect(row('alpha')).not.toBeNull());
    expect(screen.getByTestId('store-disclaimer').textContent).toMatch(/published by their authors, who are responsible for their content and licensing/);
    expect(row('alpha')?.textContent).toContain('licence: CC-BY-4.0');
    expect(row('alpha')?.textContent).toContain('test-domain');
    expect(screen.queryByRole('button', { name: 'Install…' })).toBeNull();
  });

  it('searches, filters by domain, installs with the diff and then offers the update', async () => {
    render(<StoreBrowser />);
    await waitFor(() => expect(row('beta')).not.toBeNull());
    fireEvent.change(screen.getByLabelText('Search packs'), { target: { value: 'alpha' } });
    await waitFor(() => expect(row('beta')).toBeNull());
    expect(row('alpha')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search packs'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'test-domain' } });
    await waitFor(() => expect(row('beta')).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Search packs'), { target: { value: 'alpha' } });
    await waitFor(() => expect(row('beta')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install…' })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Install…' }));
    const pending = await screen.findByTestId('store-pending');
    expect(pending.textContent).toContain('Install alpha 1.0.0');
    expect((await screen.findByTestId('pack-diff')).textContent).toContain('added components alpha-r');
    expect(readInstalledPacks(packs).packs).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await screen.findByText('Installed alpha 1.0.0.');
    expect(readInstalledPacks(packs).packs[0]).toMatchObject({ id: 'alpha', version: '1.0.0' });
    await waitFor(() => expect(row('alpha')?.textContent).toContain('installed 1.0.0'));

    store.publish('alpha', '1.1.0', '11', true);
    cleanup();
    render(<StoreBrowser />);
    const update = await screen.findByRole('button', { name: 'Update to 1.1.0…' });
    fireEvent.click(update);
    expect((await screen.findByTestId('pack-diff')).textContent).toContain('added components alpha-r2');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await screen.findByText('Updated alpha 1.1.0.');
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.1.0');
  });

  it('shows an index that does not verify, and lists none of its packs', async () => {
    store.override.set('index.json.minisig', null);
    render(<StoreBrowser />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/unsigned index is refused/);
    expect(screen.getByText('No packs to show.')).not.toBeNull();
  });
});
