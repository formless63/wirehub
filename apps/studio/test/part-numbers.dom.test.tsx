// @vitest-environment jsdom
/** The part-number report page (cs-5k1.3) on the starter catalog and on a catalog with a number used twice. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Db } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

function serve(tamper?: (db: Db) => void): void {
  deps = { ...memoryWriteBackend(undefined, join(DATA, '..')).deps, loadPartNumberFiles: () => ({}) };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    if (tamper !== undefined && String(input) === '/api/db') tamper(response.body as Db);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = () =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/part-numbers'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe('part-number report', () => {
  it('lists the starter catalog\'s unnumbered cables and parts with a suggestion each, and no duplicates', async () => {
    serve();
    mount();
    const unnumbered = await screen.findByTestId('pn-unnumbered');
    expect(within(unnumbered).getAllByRole('row').length).toBeGreaterThan(2);
    expect(within(unnumbered).getAllByText(/^[A-Z]+-\d+$/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('pn-duplicates').textContent).toContain('Every number names one part.');
    expect(screen.getByTestId('pn-disagreements').textContent).toContain('match');
  });

  it('lists a number used twice, naming both places', async () => {
    let wirePn = '';
    let componentId = '';
    serve((db) => {
      wirePn = db.wires.find((w) => w.partNumber !== undefined)!.partNumber!;
      const c = db.components.find((x) => x.partNumber !== undefined)!;
      componentId = c.id;
      c.partNumber = wirePn;
    });
    mount();
    const dup = await screen.findByTestId('pn-duplicates');
    await vi.waitFor(() => expect(within(dup).getByText(wirePn)).toBeTruthy());
    expect(dup.textContent).toContain(`components/${componentId}`);
  });
});
