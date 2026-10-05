// @vitest-environment jsdom
/**
 * Import jobs in the SPA (cs-01l.12): the Library's Import… queues a job,
 * follows its progress, shows the plan, and Publish commits it; the Jobs page
 * lists jobs and reopens one that is waiting for review. The transport is the
 * real API router over the in-memory commit tree with the in-process job runner.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { exampleRegistry, EXAMPLE_CSV, EXAMPLE_FILE } from './fixtures/example-importer.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  const h = react.createElement;
  return {
    ...actual,
    Library(props: Record<string, unknown>) {
      const actions = props['listActions'] as Record<string, unknown> | undefined;
      return h('div', { 'data-testid': 'library' }, h('div', { 'data-testid': 'list-actions' }, actions?.['mechanicals'] as never));
    },
  };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

function serve(withJobs: boolean): void {
  deps = memoryWriteBackend(exampleRegistry, join(DATA, '..')).deps;
  if (withJobs) {
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'], pollMs: 20 });
  }
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={exampleRegistry} />);

const pickFile = async (csv: string): Promise<void> => {
  const input = (await screen.findByTestId('module-import-file')) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([csv], EXAMPLE_FILE, { type: 'text/csv' })] } });
  });
};

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('an import as a job', () => {
  it('queues, shows the plan when it is done, and publishes it as one change set', async () => {
    serve(true);
    mount('/library/mechanicals');
    await pickFile(EXAMPLE_CSV);
    const dialog = await screen.findByRole('dialog', { name: 'Import job' });
    // progress, then the plan to review
    await waitFor(() => expect(within(dialog).getByTestId('job-status').getAttribute('data-status')).toBe('done'), { timeout: 5000 });
    expect(within(dialog).getByTestId('job-steps').textContent).toContain('proposed');
    expect(dialog.textContent).toContain('1 new mechanicals: hd15-backshell-test');
    expect(dialog.textContent).toContain('Already in the library, skipped: mechanicals/de9-backshell');
    expect(within(dialog).getByTestId('job-files').textContent).toContain('mechanicals.json');
    // nothing is in the catalog before Publish
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/mechanicals/hd15-backshell-test' }, deps)).status).toBe(404);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish 1 record' }));
    await waitFor(() => expect(within(dialog).getByTestId('job-message').textContent).toContain('Published'));
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/mechanicals/hd15-backshell-test' }, deps)).status).toBe(200);
    expect(within(dialog).queryByRole('button', { name: /Publish/ })).toBeNull();
  }, 20_000);

  it('says why a job failed', async () => {
    serve(true);
    mount('/library/mechanicals');
    // the importer proposes a record the library refuses (no label)
    await pickFile('bad-part,,SHL-00092,shell');
    const dialog = await screen.findByRole('dialog', { name: 'Import job' });
    await waitFor(() => expect(within(dialog).getByTestId('job-status').getAttribute('data-status')).toBe('failed'), { timeout: 5000 });
    expect(within(dialog).getByRole('alert').textContent).toMatch(/refused/);
    expect(within(dialog).queryByRole('button', { name: /Publish/ })).toBeNull();
  }, 20_000);

  it('shows a plan that moved since the run as the server\'s refusal, with nothing written', async () => {
    serve(true);
    mount('/library/mechanicals');
    await pickFile('hd15-backshell-two,Another,SHL-00093,shell');
    const dialog = await screen.findByRole('dialog', { name: 'Import job' });
    await waitFor(() => expect(within(dialog).getByTestId('job-status').getAttribute('data-status')).toBe('done'), { timeout: 5000 });
    const list = (await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/mechanicals' }, deps)).body as { records: { id: string; label: string }[] };
    const { contentETag } = await import('../server/etag.ts');
    const current = list.records[0]!;
    expect((await handleWorkbenchRequest({ method: 'PUT', path: `/api/definitions/mechanicals/${current.id}`, body: { ...current, label: 'Edited meanwhile' }, headers: { 'if-match': contentETag(current) } }, deps)).status).toBe(200);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish 1 record' }));
    await waitFor(() => expect(within(dialog).getByTestId('job-message').textContent).toContain('changed since the import ran'));
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/mechanicals/hd15-backshell-two' }, deps)).status).toBe(404);
  }, 20_000);

  it('falls back to the one-request preview when the studio runs no jobs', async () => {
    serve(false);
    mount('/library/mechanicals');
    await pickFile(EXAMPLE_CSV);
    expect(await screen.findByRole('dialog', { name: 'Review import' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Import job' })).toBeNull();
  });
});

describe('the Jobs page', () => {
  it('lists jobs and reopens an import that is waiting for review', async () => {
    serve(true);
    const queued = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/example-parts/_import/mechanicals-csv', body: { fileName: EXAMPLE_FILE, base64: Buffer.from(EXAMPLE_CSV).toString('base64'), job: true }, user: { name: 'Ada', source: 'session' } }, deps);
    const id = (queued.body as { job: { id: string } }).job.id;
    await deps.jobs!.wait(id, 10_000);
    mount('/jobs');
    const row = await screen.findByText(/example.parts.csv/);
    const tr = row.closest('tr')!;
    expect(tr.textContent).toContain('Ada');
    expect(tr.textContent).toContain('ready to publish');
    expect(screen.getByTestId('jobs-runner').textContent).toContain('Run by in this process');
    fireEvent.click(within(tr).getByRole('button', { name: 'Review…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import job' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Publish 1 record' }));
    await waitFor(() => expect(within(dialog).getByTestId('job-message').textContent).toContain('Published'));
    await waitFor(() => expect(tr.textContent).toContain('published'), { timeout: 20_000 });
  }, 40_000);

  it('says so when this studio runs no jobs', async () => {
    serve(false);
    mount('/jobs');
    expect((await screen.findByRole('alert')).textContent).toContain('does not run jobs');
  });
});
