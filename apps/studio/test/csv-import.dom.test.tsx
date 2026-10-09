// @vitest-environment jsdom
/**
 * Bulk CSV import in the SPA (cs-5k1.19): pick a file, map its columns, see the
 * dry run (new, existing, invalid with reasons), review the job's plan and
 * publish it as one change set. The transport is the real API router.
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


// the pieces of the platform Radix pokes that jsdom lacks
Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
async function choose(scope: HTMLElement, name: string, option: string | RegExp): Promise<void> {
  const trigger = within(scope).getByRole('combobox', { name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const CSV = ['Part,Name,Kind,Where from,Price', 'RT-1,Test resistor 1,resistor,vendor page,0.01', 'RT-2,Test resistor 2,resistor,,0.02', 'RT-3,,resistor,x,'].join('\n');

describe('bulk CSV import', () => {
  it('maps columns, shows the dry run, reviews the job and publishes', async () => {
    render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/library/components'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);
    const input = (await screen.findByTestId('csv-import-file')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([CSV], 'parts.csv', { type: 'text/csv' })] } });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Bulk CSV import' });
    // headers the file has are paired with fields by name; the rest are mapped by hand
    expect(within(dialog).getByRole('combobox', { name: 'Column for Name' }).textContent).toBe('Name');
    expect(within(dialog).getByRole('combobox', { name: 'Column for Kind' }).textContent).toBe('Kind');
    await choose(dialog, 'Column for Part number', 'Part');
    await choose(dialog, 'Column for Reference', 'Where from');
    await choose(dialog, 'Column for Unit price', 'Price');
    // row 2 has no source and row 3 no name: the dry run says so
    expect(within(dialog).getByTestId('csv-dry-run').textContent).toContain('1 new, 0 already in the library (left as they are), 2 invalid');
    expect(within(dialog).getByRole('table', { name: 'Dry run' }).textContent).toContain('no source');
    // a batch source rescues row 2
    fireEvent.change(within(dialog).getByLabelText('Batch source'), { target: { value: 'supplier catalog' } });
    expect(within(dialog).getByTestId('csv-dry-run').textContent).toContain('2 new');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review 2 new records' }));
    const job = await screen.findByRole('dialog', { name: 'Import job' });
    await waitFor(() => expect(within(job).getByTestId('job-status').getAttribute('data-status')).toBe('done'), { timeout: 5000 });
    expect(job.textContent).toContain('2 new components: test-resistor-1, test-resistor-2');
    fireEvent.click(within(job).getByRole('button', { name: 'Publish 2 records' }));
    await waitFor(() => expect(within(job).getByTestId('job-message').textContent).toContain('Published'));
    const made = await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/test-resistor-2' }, deps);
    expect(made.body).toMatchObject({ partNumber: 'RT-2', src: 'supplier catalog', cost: { unit: 0.02 } });
  }, 30_000);

  it('update mode shows each change in the dry run and reviews it as an update', async () => {
    render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/library/components'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);
    const input = (await screen.findByTestId('csv-import-file')) as HTMLInputElement;
    const file = ['type,id,label,kind,value,package,src', 'component,r-150,"Resistor 150 Ω, 0.25 W",resistor,150 Ω,0805,datasheet'].join('\n');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([file], 'update.csv', { type: 'text/csv' })] } });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Bulk CSV import' });
    expect(within(dialog).getByTestId('csv-dry-run').textContent).toContain('1 already in the library (left as they are)');
    fireEvent.click(within(dialog).getByLabelText('Update existing records'));
    expect(within(dialog).getByTestId('csv-dry-run').textContent).toContain('1 to update, 0 unchanged');
    expect(within(dialog).getByRole('table', { name: 'Dry run' }).textContent).toContain('package: axial → 0805');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review 1 updated record' }));
    const job = await screen.findByRole('dialog', { name: 'Import job' });
    await waitFor(() => expect(within(job).getByTestId('job-status').getAttribute('data-status')).toBe('done'), { timeout: 5000 });
    expect(job.textContent).toContain('1 updated components: r-150');
    fireEvent.click(within(job).getByRole('button', { name: 'Publish 1 record' }));
    await waitFor(() => expect(within(job).getByTestId('job-message').textContent).toContain('Published'));
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/r-150' }, deps)).body).toMatchObject({ package: '0805' });
  }, 30_000);
});
