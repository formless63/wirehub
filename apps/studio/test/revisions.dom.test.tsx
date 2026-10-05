// @vitest-environment jsdom
/** A library record's revisions on its page: save one, see it, change the record, compare the revision with now. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRegistry } from '@wirehub/modules';
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
    const response = await handleWorkbenchRequest(
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}), headers: Object.fromEntries(new Headers(init?.headers).entries()) },
      deps,
    );
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={createRegistry([])} />);

describe('record revisions', () => {
  it('saves a revision, and compares it with the record after a change', async () => {
    mount('/library/connectors/de9-female');
    const section = await screen.findByTestId('revisions', undefined, { timeout: 8000 });
    await vi.waitFor(() => expect(within(section).getByTestId('revisions-now').textContent).toContain('No revision saved yet'));
    fireEvent.click(within(section).getByRole('button', { name: 'Save a revision…' }));
    fireEvent.change(within(section).getByLabelText('Revision note'), { target: { value: 'first drawn' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save revision' }));
    await vi.waitFor(() => expect(within(section).getByTestId('revisions-now').textContent).toContain('revision 1'));
    expect(section.textContent).toContain('first drawn');

  }, 30_000);

  it('compares a revision with the record as it is now, after a change', async () => {
    const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) }, deps);
    expect((await call('POST', '/api/revisions/connectors/de9-female', { note: 'first drawn' })).status).toBe(201);
    const record = await call('GET', '/api/definitions/connectors/de9-female');
    expect((await call('PUT', '/api/definitions/connectors/de9-female', { ...(record.body as object), label: 'DE-9 female, relabelled' }, { 'if-match': record.headers?.ETag ?? '' })).status).toBe(200);
    mount('/library/connectors/de9-female');
    const section = await screen.findByTestId('revisions', undefined, { timeout: 8000 });
    await vi.waitFor(() => expect(within(section).getByTestId('revisions-now').textContent).toContain('Changed since revision 1'));
    fireEvent.click(within(section).getByRole('button', { name: 'Compare with now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compare records' });
    const table = await within(dialog).findByRole('table', { name: 'Field differences' });
    await vi.waitFor(() => expect(table.textContent).toContain('DE-9 female, relabelled'));
  }, 30_000);
});
