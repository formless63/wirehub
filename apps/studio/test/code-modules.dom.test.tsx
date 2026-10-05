// @vitest-environment jsdom
/**
 * Runtime code modules in the SPA (`specs/runtime-modules.md` §3): the page
 * loads the browser entry the server lists — fetched by content address, its
 * sha256 checked against the integrity — and the module's panel appears in the
 * open cable without a reload; a module whose bytes do not match is refused; a
 * module that goes away leaves the page and asks for a refresh to finish. The
 * entry's import is stood in for (jsdom imports no blob URLs): it hands back
 * the example module; everything else is the real page over the in-memory API.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { example } from '@wirehub/module-example';
import type { CableDesign, Db } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  const h = react.createElement;
  return {
    ...actual,
    CableEditor(props: Record<string, unknown>) {
      const design = props['design'] as CableDesign;
      const db = props['db'] as Db;
      const ext = props['extensions'] as import('@wirehub/editor-react').EditorExtensions | undefined;
      return h('div', { 'data-testid': 'editor' }, h('span', { 'data-testid': 'open-id' }, design.id), h('div', { 'data-testid': 'inspector-slot' }, ext?.inspector?.({ design, db, readOnly: false })));
    },
  };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry, builtinModules } = await import('../src/modules.browser.ts');
const { setModuleImporter } = await import('../src/code-modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const code = new TextEncoder().encode('export default "the example module, as the server built it";\n');
const sha = createHash('sha256').update(code).digest('hex');
const integrity = `sha256-${createHash('sha256').update(code).digest('base64')}`;
const realFetch = globalThis.fetch;
let listed: { id: string; version: string; js: { url: string; integrity: string }; commitHook: boolean }[] = [];
let served = code;
let deps: WorkbenchDeps;
let imported = 0;

function serve(): void {
  deps = memoryWriteBackend(createRegistry([]), join(DATA, '..')).deps;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/code-modules/browser') return new Response(JSON.stringify({ generation: 1, modules: listed }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === `/api/code-modules/files/${sha}.mjs`) return new Response(served as unknown as BodyInit, { status: 200, headers: { 'content-type': 'text/javascript' } });
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(response.bytes !== undefined ? (response.bytes as unknown as BodyInit) : JSON.stringify(response.body), { status: response.status, headers: { 'content-type': response.contentType ?? 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} />);

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  serve();
  setModuleImporter(async () => {
    imported += 1;
    return { default: example };
  });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('runtime code modules in the page', () => {
  it('loads a verified browser entry and mounts its panel in the open page, and drops it when the server does', async () => {
    // the live event stream, stood in for: the page re-syncs its modules on every catalog event
    const streams: { listeners: Map<string, (event: { data?: string }) => void> }[] = [];
    class FakeEventSource {
      listeners = new Map<string, (event: { data?: string }) => void>();
      onerror: ((event: unknown) => void) | null = null;
      constructor() {
        streams.push(this);
      }
      addEventListener(type: string, listener: (event: { data?: string }) => void): void {
        this.listeners.set(type, listener);
      }
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const emit = (type: string, data: object): void => {
      for (const stream of streams) stream.listeners.get(type)?.({ data: JSON.stringify(data) });
    };
    listed = [];
    mount('/cables/de9-crossover');
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe('de9-crossover'));
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    emit('hello', { version: '1' });
    expect(screen.queryByTestId('example-inspector')).toBeNull();
    // an owner installed the example: the commit's event reaches the page, which loads the module, and the open cable shows its panel
    listed = [{ id: 'example', version: '0.1.0', js: { url: `/api/code-modules/files/${sha}.mjs`, integrity }, commitHook: true }];
    emit('catalog', { version: '2' });
    await waitFor(() => expect(within(screen.getByTestId('inspector-slot')).getByTestId('example-inspector').textContent).toContain('No edits recorded yet'));
    expect(imported).toBe(1);
    expect(registry.modules.map((m) => m.id)).toEqual([...builtinModules.map((m) => m.id), 'example']);
    expect(screen.getByTestId('open-id').textContent).toBe('de9-crossover');
    // turned off on the server: gone from the page, which asks for a refresh to finish unloading the old code
    listed = [];
    emit('catalog', { version: '3' });
    await waitFor(() => expect(screen.queryByTestId('example-inspector')).toBeNull());
    expect(registry.module('example')).toBeUndefined();
    await waitFor(() => expect(document.body.textContent).toContain('Refresh the page to finish unloading'));
    vi.unstubAllGlobals();
  });

  it('refuses an entry whose bytes do not match the integrity the server lists', async () => {
    served = new TextEncoder().encode('export default "something else";\n');
    listed = [{ id: 'example', version: '0.1.0', js: { url: `/api/code-modules/files/${sha}.mjs`, integrity }, commitHook: true }];
    const before = imported;
    try {
      mount('/cables/de9-crossover');
      await waitFor(() => expect(document.body.textContent).toContain('could not be loaded in this page'));
      expect(imported).toBe(before);
      expect(registry.module('example')).toBeUndefined();
    } finally {
      served = code;
    }
  });
});
