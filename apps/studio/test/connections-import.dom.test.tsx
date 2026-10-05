// @vitest-environment jsdom
/**
 * Connections CSV import in the SPA (cs-8c4): pick a from/to pin CSV, pick each
 * part's connector, see the dry run (joints, and the rows left out with their
 * reasons), review the job's proposed design and publish it as one change set.
 * The transport is the real API router.
 */

import { join } from 'node:path';

import { csvLibrary } from '@wirehub/module-csv-library';
import { createRegistry } from '@wirehub/modules';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  const h = react.createElement;
  return {
    ...actual,
    Library(props: Record<string, unknown>) {
      const actions = props['listActions'] as Record<string, unknown> | undefined;
      return h('div', { 'data-testid': 'library' }, h('div', { 'data-testid': 'list-actions' }, actions?.['components'] as never));
    },
  };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const registry = createRegistry([csvLibrary]);
const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  deps = memoryWriteBackend(registry, join(DATA, '..')).deps;
  const store = memoryJobStore();
  deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'], pollMs: 20 });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body instanceof Uint8Array;
    const response = await handleWorkbenchRequest(
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : raw ? { body: init!.body, rawBody: init!.body } : {}) } as never,
      deps,
    );
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const CSV = ['From,To,Note', 'J1.2,J2.3,crossover', 'J1.3,J2.2,crossover', 'J1.9,J2.99,no such pin', 'X7.1,J2.1,'].join('\n');

describe('connections CSV import', () => {
  it('picks connectors, shows the dry run, reviews the proposed design and publishes it', async () => {
    render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/library/components'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);
    const input = (await screen.findByTestId('connections-import-file')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([CSV], 'my-lead.csv', { type: 'text/csv' })] } });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Connections CSV import' });
    // nothing is a connector yet: no joints, and the rows say why
    expect(within(dialog).getByTestId('connections-dry-run').textContent).toContain('0 of 4');
    expect(within(dialog).getByRole('table', { name: 'Left out' }).textContent).toContain('is not a library connector');
    fireEvent.change(within(dialog).getByLabelText('Connector for J1'), { target: { value: 'de9-male' } });
    fireEvent.change(within(dialog).getByLabelText('Connector for J2'), { target: { value: 'de9-female' } });
    expect(within(dialog).getByTestId('connections-dry-run').textContent).toContain('2 of 4');
    expect(within(dialog).getByRole('table', { name: 'Left out' }).textContent).toContain("de9-female has no pin '99'");
    fireEvent.change(within(dialog).getByLabelText('Design name'), { target: { value: 'My lead' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review the design' }));
    const job = await screen.findByRole('dialog', { name: 'Import job' });
    await waitFor(() => expect(within(job).getByTestId('job-status').getAttribute('data-status')).toBe('done'), { timeout: 5000 });
    expect(job.textContent).toContain('my-lead');
    fireEvent.click(within(job).getByRole('button', { name: /^Publish/ }));
    await waitFor(() => expect(within(job).getByTestId('job-message').textContent).toContain('Published'));
    const made = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/my-lead' }, deps);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ id: 'my-lead', label: 'My lead', instances: { connectors: [{ id: 'j1', def: 'de9-male' }, { id: 'j2', def: 'de9-female' }] } });
    expect((made.body as { joints: unknown[] }).joints).toHaveLength(2);
  }, 30_000);

  it('says so when the file has no from/to columns', async () => {
    render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/library/components'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);
    const input = (await screen.findByTestId('connections-import-file')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['pin,thing\n1,2\n'], 'x.csv', { type: 'text/csv' })] } });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Connections CSV import' });
    expect(within(dialog).getByRole('alert').textContent).toContain('needs a from column and a to column');
    expect((within(dialog).getByRole('button', { name: 'Nothing to import' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
