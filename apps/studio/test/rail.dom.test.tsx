// @vitest-environment jsdom
/**
 * The left rail with every official extension installed (module routes declare a place, not a
 * rail item): at most 9 destinations, no module item by default, and Board import in the
 * Library's Import menu instead.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { boardImport } from '@wirehub/module-board-import';
import { csvLibrary } from '@wirehub/module-csv-library';
import { example } from '@wirehub/module-example';
import { wireviz } from '@wirehub/module-wireviz';
import { createRegistry } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const registry = createRegistry([csvLibrary, boardImport, wireviz, example]);
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

beforeEach(() => {
  clearOfflineCache();
  deps = { ...memoryWriteBackend(registry, join(DATA, '..')).deps, localUser: { name: 'Ada', email: 'ada@example.com', source: 'session', role: 'owner' }, instance: { accounts: true } };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(response.bytes !== undefined ? (response.bytes as unknown as BodyInit) : JSON.stringify(response.body), { status: response.status, headers: { 'content-type': response.contentType ?? 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const mount = (path: string) => render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} modules={registry} />);

describe('the rail', () => {
  it('groups the rail: Work, Activity, then Extensions and Settings, with at most 8 items plus the avatar', async () => {
    mount('/cables');
    const rail = await screen.findByRole('navigation', { name: 'sections' });
    await waitFor(() => expect(rail.querySelector('.cs-navigation-links a')).not.toBeNull());
    const names = (label: string): string[] => [...rail.querySelectorAll(`[role="group"][aria-label="${label}"] a`)].map((a) => a.getAttribute('aria-label') ?? '');
    expect(names('Work')).toEqual(['Designs', 'Library', 'Find a design', 'Products']);
    expect(names('Activity')).toEqual(['History', 'Jobs']);
    expect(names('Hub')).toEqual(['Extensions', 'Settings']);
    const destinations = [...rail.querySelectorAll('a')];
    expect(destinations.length).toBeLessThanOrEqual(8);
    expect(destinations.map((a) => a.getAttribute('href')).some((href) => href?.startsWith('/m/'))).toBe(false);
    // People and API tokens are not rail items
    expect(destinations.map((a) => a.getAttribute('href'))).not.toContain('/settings/people');
  });

  it('opens the avatar menu with My account, API tokens, Theme and Sign out', async () => {
    mount('/cables');
    const avatar = await screen.findByRole('button', { name: /Account menu/ });
    fireEvent.pointerDown(avatar, { button: 0, ctrlKey: false });
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(items).toEqual(['My account', 'API tokens', expect.stringMatching(/theme/i), 'Sign out']);
  });

  it('puts Board import in the Library Import menu', async () => {
    mount('/library/components');
    const trigger = await screen.findByTestId('library-import-menu');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: /Board import/ });
    expect(item).toBeTruthy();
  });
});
