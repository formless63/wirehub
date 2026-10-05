// @vitest-environment jsdom
/**
 * The Library's Compare (cs-5k1.21): the base's generic field diff opens for any
 * kind, and a module's own compare view takes over for the kinds it declares.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRegistry, defineModule } from '@wirehub/modules';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  deps = { ...memoryWriteBackend(undefined, join(DATA, '..')).deps, loadPartNumberFiles: () => ({}) };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const withView = createRegistry([
  defineModule({
    id: 'cmp',
    label: 'Compare module',
    version: '1.0.0',
    compareViews: [{ id: 'shells', label: 'Shell compare', kinds: ['mechanicals'], component: (p: { a: { id: string } }) => h('div', { 'data-testid': 'module-compare' }, `module view for ${p.a.id}`) }],
  }),
]);
const bare = createRegistry([]);

const mount = (path: string, modules: typeof bare) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={modules} />);

async function compareButton(): Promise<HTMLElement> {
  return await screen.findByRole('button', { name: 'Compare', description: 'Open this part in the compare view' }, { timeout: 8000 });
}

describe('Library Compare', () => {
  it('opens the base field diff for a connector, with the second record chosen in the view', async () => {
    const [first, second] = (await (await fetch('/api/db')).json()).connectors as { id: string }[];
    mount(`/library/connectors/${first!.id}`, bare);
    fireEvent.click(await compareButton());
    const dialog = await screen.findByRole('dialog', { name: 'Compare records' });
    fireEvent.change(within(dialog).getByLabelText('Compare with'), { target: { value: `connectors/${second!.id}` } });
    expect(await within(dialog).findByRole('table', { name: 'Field differences' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Compare records' })).toBeNull();
  });

  it('lets a module\'s compare view take over for the kinds it declares, and only those', async () => {
    const db = await (await fetch('/api/db')).json();
    const shell = (db.mechanicals as { id: string }[])[0]!;
    mount(`/library/hardware/${shell.id}`, withView);
    fireEvent.click(await compareButton());
    expect((await screen.findByTestId('module-compare')).textContent).toBe(`module view for ${shell.id}`);
    expect(screen.queryByRole('dialog', { name: 'Compare records' })).toBeNull();
    cleanup();
    const connector = (db.connectors as { id: string }[])[0]!;
    mount(`/library/connectors/${connector.id}`, withView);
    fireEvent.click(await compareButton());
    expect(await screen.findByRole('dialog', { name: 'Compare records' })).toBeTruthy();
    expect(screen.queryByTestId('module-compare')).toBeNull();
  });
});
