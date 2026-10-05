// @vitest-environment jsdom
/**
 * Store sources in the UI: the Settings section (a store's URL and key, the fetched
 * key and its fingerprint, preview before saving, manage) and Browse store grouped by
 * store with one store down. Real API handler, throwaway signed stores whose key
 * pairs are generated in the test (`store-fixture.ts`).
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { catalogWithPacksSource, createCatalog, installedAcross, storeKeyFingerprint } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryDocStore } from '../server/storage/doc-store.ts';
import { StoreBrowser } from '../src/modules/StoreBrowser.tsx';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { STORE_URL, createTestStore, type TestStore } from './store-fixture.ts';
import { OTHER_URL, routedFetch } from './store-sources-scenario.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

let root = '';
let a: TestStore;
let b: TestStore;
let deps: WorkbenchDeps;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  root = mkdtempSync(join(tmpdir(), 'wirehub-sources-dom-'));
  const dir = join(root, 'catalog');
  const packs = join(root, 'packs');
  cpSync(join(process.cwd(), '../../packages/catalog/data'), dir, { recursive: true });
  a = createTestStore();
  b = createTestStore();
  a.publish('alpha', '1.0.0', '10');
  b.publish('beta', '1.0.0', '20');
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => createCatalog(catalogWithPacksSource(dir, packs)).loadDb(),
    modules: createRegistry([]),
    installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
    setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
    docs: memoryDocStore(),
    store: { indexes: [{ url: STORE_URL, publicKey: a.publicKey, origin: 'env' }], fetch: routedFetch(a, b) },
  };
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: input, headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  a.close();
  b.close();
  rmSync(root, { recursive: true, force: true });
});

const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

describe('Settings: store sources', () => {
  it('shows the server store read-only, then adds a store after fetching its key and confirming the fingerprint', async () => {
    mount('/settings');
    const section = await screen.findByTestId('store-sources');
    await waitFor(() => expect(within(section).getByTestId('store-official').textContent).toMatch(/not enabled/));
    const env = await waitFor(() => section.querySelector(`[data-store-source="${STORE_URL}"]`) as HTMLElement);
    expect(env.textContent).toContain('set by the server');
    expect(within(env).queryByRole('button', { name: 'Remove' })).toBeNull();

    fireEvent.change(within(section).getByLabelText('Store index URL'), { target: { value: OTHER_URL } });
    b.override.set('wirehub-store.pub', new TextEncoder().encode(`untrusted comment: minisign public key\n${b.publicKey}\n`));
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: /Fetch key from the store/ }));
    });
    await waitFor(() => expect((within(section).getByLabelText('Store public key') as HTMLInputElement).value).toBe(b.publicKey));
    expect(within(section).getByTestId('store-key-note').textContent).toMatch(/Compare the fingerprint/);
    // saving is blocked until the store is checked and the fingerprint confirmed
    expect((within(section).getByRole('button', { name: 'Add store' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Check store' }));
    });
    const shown = await within(section).findByTestId('store-preview');
    expect(shown.textContent).toContain('Test store');
    expect(shown.textContent).toContain(storeKeyFingerprint(b.publicKey).fingerprint);
    expect(shown.textContent).toMatch(/trusting it on first use/);
    expect((within(section).getByRole('button', { name: 'Add store' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(section).getByRole('checkbox'));
    fireEvent.change(within(section).getByLabelText('Label'), { target: { value: 'Friends' } });
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Add store' }));
    });
    const added = await waitFor(() => section.querySelector(`[data-store-source="${OTHER_URL}"]`) as HTMLElement);
    expect(added.textContent).toContain('Friends');
    expect(added.textContent).toContain('added here');

    // disable, re-check, remove
    await act(async () => {
      fireEvent.click(within(added).getByRole('button', { name: 'Disable' }));
    });
    await waitFor(() => expect(within(section.querySelector(`[data-store-source="${OTHER_URL}"]`) as HTMLElement).getByRole('button', { name: 'Enable' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(section.querySelector(`[data-store-source="${OTHER_URL}"]`) as HTMLElement).getByRole('button', { name: 'Re-check now' }));
    });
    await waitFor(() => expect((section.querySelector(`[data-store-source="${OTHER_URL}"]`) as HTMLElement).textContent).toMatch(/Verified: Test store, 1 pack/));
    await act(async () => {
      fireEvent.click(within(section.querySelector(`[data-store-source="${OTHER_URL}"]`) as HTMLElement).getByRole('button', { name: 'Remove' }));
    });
    await waitFor(() => expect(section.querySelector(`[data-store-source="${OTHER_URL}"]`)).toBeNull());
  });
});

describe('Browse store with several stores', () => {
  it('groups packs by store, filters by store, and keeps the others when one is down', async () => {
    deps.docs!.write('data/settings/stores.json', { sources: [{ url: OTHER_URL, publicKey: b.publicKey, label: 'Friends', enabled: true }], src: 'test' });
    render(<StoreBrowser />);
    await waitFor(() => expect(document.querySelector('[data-store-pack="beta"]')).not.toBeNull());
    expect(document.querySelector(`[data-store-group="${STORE_URL}"] [data-store-pack="alpha"]`)).not.toBeNull();
    const group = document.querySelector(`[data-store-group="${OTHER_URL}"]`) as HTMLElement;
    expect(group.textContent).toContain('Friends');
    expect(group.textContent).toContain('added here');
    fireEvent.change(screen.getByLabelText('Store'), { target: { value: OTHER_URL } });
    await waitFor(() => expect(document.querySelector('[data-store-pack="alpha"]')).toBeNull());
    cleanup();

    b.override.set('index.json', null);
    render(<StoreBrowser />);
    await waitFor(() => expect(document.querySelector(`[data-store-down="${OTHER_URL}"]`)).not.toBeNull());
    expect(document.querySelector('[data-store-pack="alpha"]')).not.toBeNull();
    expect(document.querySelector('[data-store-pack="beta"]')).toBeNull();
  });
});
