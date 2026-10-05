// @vitest-environment jsdom
/**
 * The History panel and page in the SPA (cs-5k1.4): a record's entries open
 * to a field-level diff, Restore asks first and then posts the entry with the
 * versions the person saw, a page filters by person and kind, and a hub
 * without history says why instead of offering it. The transport is the real
 * API router over the in-memory commit tree; the history source is a stub
 * (the sources themselves are tested on files and on Postgres).
 */

import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { contentETag } from '../server/etag.ts';
import { NO_HISTORY, noHistorySource, type HistoryQuery, type HistorySource } from '../server/history/source.ts';
import { DATABASE_HISTORY } from '../server/history/pg.ts';
import { RecordHistory } from '../src/history/HistoryPanel.tsx';
import { known, type HistoryEntry } from '../src/history/types.ts';
import { HistoryRoute } from '../src/routes/HistoryRoute.tsx';
import { memoryWriteBackend } from './storage-contract/writes.ts';

// jsdom gives import.meta.url an http scheme: name the catalog by path
const ROOT = join(process.cwd(), '..', '..', 'packages', 'catalog');
const memory = (): WorkbenchDeps => memoryWriteBackend(undefined, ROOT).deps;
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;
const calls: { method: string; path: string; body?: unknown }[] = [];

const entry = (id: string, name: string, message: string): HistoryEntry => ({
  id,
  at: '2026-10-05T10:00:00.000Z',
  by: { name, email: `${name.toLowerCase()}@example.com` },
  source: 'studio',
  message,
  version: id,
  touches: [{ subject: 'design:dc-led-lead', label: 'design dc-led-lead — design', kind: 'design', op: 'put', part: 'design', fields: ['label'] }],
});

function stubSource(design: { label: string }): { source: HistorySource; queries: HistoryQuery[] } {
  const queries: HistoryQuery[] = [];
  const entries = [entry('7', 'Bob', 'studio: update design dc-led-lead'), entry('5', 'Alice', 'studio: update design dc-led-lead')];
  return {
    queries,
    source: {
      capabilities: async () => DATABASE_HISTORY,
      list: async (query) => {
        queries.push(query);
        return { entries: entries.filter((e) => query.person === undefined || e.by.name.toLowerCase().includes(query.person.toLowerCase())) };
      },
      record: async () => ({ entries }),
      detail: async (id) => ({
        entry: entries.find((e) => e.id === id)!,
        records: [{ subject: 'design:dc-led-lead', label: 'design dc-led-lead — design', part: 'design', op: 'changed', before: known({ label: 'Old label' }), after: known({ label: 'New label' }), restorable: true }],
      }),
      stateAt: async () => ({ parts: { design: known({ ...design, label: 'Restored label' }), drawing: 'current' } }),
    },
  };
}

function serve(source: HistorySource): void {
  deps = { ...memory(), history: source };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: String(input), ...(body === undefined ? {} : { body }) });
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(body === undefined ? {} : { body }) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('a record\'s History', () => {
  it('opens an entry to its diff, and restores after asking', async () => {
    const design = (await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/dc-led-lead' }, memory())).body as { label: string };
    serve(stubSource(design).source);
    const restored = vi.fn();
    render(<RecordHistory subject="design:dc-led-lead" label="design dc-led-lead" onRestored={restored} />);
    const rows = await screen.findAllByRole('button', { expanded: false });
    expect(screen.getByTestId('history-capabilities').getAttribute('data-backend')).toBe('database');
    expect(rows[0]?.textContent).toContain('Bob');
    expect(rows[0]?.textContent).toContain('label');
    fireEvent.click(rows[1]!);
    const diff = await screen.findByTestId('history-diff');
    expect(diff.textContent).toContain('label');
    expect(diff.textContent).toContain('"Old label"');
    expect(diff.textContent).toContain('"New label"');
    fireEvent.click(screen.getByTestId('history-restore'));
    fireEvent.click(await screen.findByTestId('history-restore-confirm'));
    await waitFor(() => expect(restored).toHaveBeenCalled(), { timeout: 8000 });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/history/records/design%3Adc-led-lead/restore');
    expect(post?.body).toEqual({ entry: '5', current: { design: contentETag(design), drawing: expect.any(String) } });
    expect(((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/dc-led-lead' }, deps)).body as { label: string }).label).toBe('Restored label');
  }, 20_000);

  it('cannot restore while the editor holds unsaved edits', async () => {
    serve(stubSource({ label: 'x' }).source);
    render(<RecordHistory subject="design:dc-led-lead" label="design dc-led-lead" restoreBlocked="Save first" />);
    const rows = await screen.findAllByRole('button', { expanded: false });
    fireEvent.click(rows[0]!);
    const button = await screen.findByTestId('history-restore');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Save first');
  });
});

describe('the History page', () => {
  it('lists the hub\'s changes and filters by person and kind', async () => {
    const stub = stubSource({ label: 'x' });
    serve(stub.source);
    render(<HistoryRoute />);
    await waitFor(() => expect(screen.getByTestId('history').querySelectorAll('[data-entry]').length).toBe(2));
    fireEvent.change(screen.getByTestId('history-person'), { target: { value: 'ali' } });
    fireEvent.change(screen.getByTestId('history-kind'), { target: { value: 'design' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(screen.getByTestId('history').querySelectorAll('[data-entry]').length).toBe(1));
    expect(stub.queries[stub.queries.length - 1]).toMatchObject({ person: 'ali', kind: 'design' });
    expect(within(screen.getByTestId('history')).getByText('Alice')).toBeDefined();
  });

  it('a hub without history says why', async () => {
    serve(noHistorySource());
    render(<HistoryRoute />);
    const note = await screen.findByTestId('history-capabilities');
    expect(note.getAttribute('data-backend')).toBe('none');
    expect(note.textContent).toBe(NO_HISTORY.note);
  });
});
