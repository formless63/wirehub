// @vitest-environment jsdom
/** Extensions › Installed: an owner lets a module add an item to the rail (a hub setting); nobody else may. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { createRegistry, type WireHubModule } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const railMod: WireHubModule = { id: 'railmod', label: 'Rail module', version: '1.0.0', routes: [{ path: 'page', label: 'Rail page', placement: 'rail', component: () => null }] };
const registry = createRegistry([railMod]);
const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function serve(user: { name: string; source: 'local'; role: 'owner' | 'editor' }): void {
  deps = { ...memoryWriteBackend(registry, join(DATA, '..')).deps, localUser: user };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}
const mount = (path: string) => render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

describe('Extensions › Installed', () => {
  it('lets an owner put a module in the rail, and takes it out again', async () => {
    serve({ name: 'Ada', source: 'local', role: 'owner' });
    mount('/extensions?tab=installed');
    const toggle = await screen.findByRole('switch', { name: 'Show Rail module in the rail' });
    expect(screen.queryByRole('link', { name: 'Rail page' })).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'sections' })).getByRole('link', { name: 'Rail page' })).toBeTruthy());
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/hub' }, deps)).body).toMatchObject({ railModules: ['railmod'] });
    fireEvent.click(screen.getByRole('switch', { name: 'Show Rail module in the rail' }));
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'sections' })).queryByRole('link', { name: 'Rail page' })).toBeNull());
  });

  it('shows the switch to an editor as read-only', async () => {
    serve({ name: 'Eve', source: 'local', role: 'editor' });
    mount('/extensions?tab=installed');
    const toggle = await screen.findByRole('switch', { name: 'Show Rail module in the rail' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
  });
});
