// @vitest-environment jsdom
/** The "New hub" strip (dismissal is the hub's), the help `(?)`, and the empty states with their docs links. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { DEFAULT_DOCS_BASE, helpForPath, helpUrl } from '../src/help.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { DATABASE_HISTORY } from '../server/history/pg.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

function serve(): void {
  deps = { ...memoryWriteBackend(undefined, join(DATA, '..')).deps, loadPartNumberFiles: () => ({}) };
  const store = memoryJobStore();
  deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'], pollMs: 20 });
  deps.history = { capabilities: async () => DATABASE_HISTORY, list: async () => ({ entries: [] }), record: async () => ({ entries: [] }), detail: async () => undefined, stateAt: async () => undefined } as never;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe('the help map', () => {
  it('points every route at the docs site, most specific first', () => {
    expect(helpForPath('/products/x').url).toBe(`${DEFAULT_DOCS_BASE}reference/products/#in-the-app`);
    expect(helpForPath('/library/store').url).toBe(helpUrl('store'));
    expect(helpForPath('/settings/people').topic).toBe('people');
    expect(helpForPath('/nowhere').topic).toBeUndefined();
    expect(helpUrl('designs')).toBe('https://formless63.github.io/wirehub/docs/first-design/');
  });
});

describe('the New hub strip', () => {
  it('shows on a fresh hub, and a dismissal is the hub\'s: it stays gone after a reload', async () => {
    serve();
    mount('/cables');
    const strip = await screen.findByTestId('new-hub-strip');
    expect(strip.querySelectorAll('a, button').length).toBeGreaterThanOrEqual(5);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('new-hub-strip')).toBeNull());
    await waitFor(async () => expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/hub' }, deps)).body).toEqual({ welcomeDismissed: true }));
    cleanup();
    window.localStorage.clear();
    mount('/cables');
    await screen.findByLabelText('Filter cables');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('new-hub-strip')).toBeNull();
  });

  it('puts a (?) with this page\'s docs in the top bar', async () => {
    serve();
    mount('/products');
    const help = await screen.findByTestId('help-link');
    expect(help.getAttribute('href')).toBe(helpUrl('products'));
  });
});

describe('empty states', () => {
  it.each([['/products', 'products'], ['/jobs', 'jobs'], ['/history', 'history']] as const)('%s says one line, offers one action and links to the docs', async (path, topic) => {
    serve();
    {
      mount(path);
      const empty = await screen.findByTestId('empty-state');
      expect(empty.querySelectorAll('button, a:not([href^="http"])').length, path).toBe(1);
      expect(empty.querySelector('a[href^="http"]')?.getAttribute('href'), path).toBe(helpUrl(topic));
      cleanup();
    }
  });
});

describe('a hub that hosts its own docs', () => {
  it('WIREHUB_DOCS_URL moves every help link to that base, and a Settings section has a help link', async () => {
    const before = process.env['WIREHUB_DOCS_URL'];
    process.env['WIREHUB_DOCS_URL'] = 'https://docs.example.org/wh';
    try {
      serve();
      expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/hub' }, deps)).body).toEqual({ welcomeDismissed: false, docsUrl: 'https://docs.example.org/wh' });
      mount('/settings?section=rules');
      const help = await screen.findByTestId('settings-help-link');
      await waitFor(() => expect(help.getAttribute('href')).toBe('https://docs.example.org/wh/reference/validation-rules/'));
      await waitFor(() => expect(screen.getByTestId('help-link').getAttribute('href')).toBe('https://docs.example.org/wh/reference/self-hosting/#settings'));
    } finally {
      if (before === undefined) delete process.env['WIREHUB_DOCS_URL'];
      else process.env['WIREHUB_DOCS_URL'] = before;
    }
  });
});
