/**
 * The Designs list's Tags, Project and Route filters (`/cables?tag=…&project=…&route=…`) narrow the
 * rows, the text filter reads tags too, and bulk tagging sends the matching designs in one request.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CableListEntry } from '../src/cable-list.ts';
import type { CablesSearch } from '../src/router.tsx';

const state = vi.hoisted(() => ({ search: {} as CablesSearch, sent: [] as unknown[] }));

vi.mock('sonner', async () => (await import('./toast-spy.ts')).sonnerMock);
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => () => undefined,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../src/router.tsx', () => ({ cablesRoute: { id: '/cables', useSearch: () => state.search } }));
vi.mock('../src/studio-context.tsx', () => ({ useStudio: () => ({ me: { role: 'editor' }, dirtyIds: [], openNewCableWizard: () => undefined }) }));
vi.mock('../src/shell/RouteHeader.tsx', () => ({ RouteHeader: ({ count }: { count?: string }) => <h1 data-testid="count">{count}</h1> }));
vi.mock('../src/shell/NewHubStrip.tsx', () => ({ NewHubStrip: () => null }));
vi.mock('../src/locks/LockMarker.tsx', () => ({ LockMarker: () => null }));
vi.mock('../src/RecordCover.tsx', () => ({ RecordCover: () => null }));

function entry(id: string, tags: string[] | undefined, route?: 'make' | 'contract' | 'buy'): CableListEntry {
  return {
    id, label: `Lead ${id} → Plug`, status: 'active', source: `Lead ${id}`, destination: 'Plug', destinationMain: 'Plug', destinationShort: 'Plug',
    wires: [], features: [], wireLabels: [], boardLabels: [], partCount: 2, jointCount: 1, partNumbers: [], partNumber: { basis: 'none', note: '' },
    ...(tags === undefined ? {} : { tags }), ...(route === undefined ? {} : { route }),
  };
}

const ENTRIES = [
  entry('lead-a', ['Phase 1'], 'contract'),
  entry('lead-b', ['Phase 1', 'Checked'], 'contract'),
  entry('lead-c', ['Phase 2'], 'contract'),
  entry('lead-d', undefined, 'make'),
  entry('lead-e', ['Phase 2']),
];

vi.mock('../src/queries.ts', async (original) => ({
  ...(await original<object>()),
  loadCableList: async () => ({ entries: ENTRIES, offline: false }),
}));
vi.mock('../src/knowledge.browser.ts', async (original) => ({
  ...(await original<object>()),
  fetchKnowledgeIndex: async () => ({
    notes: [],
    projects: [{ id: 'batch-7', title: 'Batch 7', status: 'active', items: ['design:lead-a', 'design:lead-b', 'design:lead-c', 'definition:pcbas:some-board'], text: '', updatedAt: '2026-01-01' }],
  }),
}));
vi.mock('../src/persistence.browser.ts', async (original) => ({
  ...(await original<object>()),
  retagDesigns: async (change: { designs: string[]; add?: string[] }) => {
    state.sent.push(change);
    return { ok: true, value: { add: change.add ?? [], remove: [], changed: change.designs.length - 1, unchanged: 1, skipped: 0, results: [] } };
  },
}));

const { CablesRoute } = await import('../src/routes/CablesRoute.tsx');
const { toasts } = await import('./toast-spy.ts');

beforeEach(() => {
  state.sent = [];
  toasts.length = 0;
});
afterEach(cleanup);

function mount(search: CablesSearch): void {
  state.search = search;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CablesRoute />
    </QueryClientProvider>,
  );
}

async function shownIds(expected: string[]): Promise<void> {
  const table = await screen.findByTestId('cable-list');
  await waitFor(() => expect([...table.querySelectorAll('[data-row-id]')].map((row) => row.getAttribute('data-row-id')).sort()).toEqual(expected));
}

it('narrows by tags (any of them), by project, by route, and finds tags by text', async () => {
  mount({ tag: ['Phase 1'] });
  await shownIds(['lead-a', 'lead-b']);
  cleanup();

  mount({ tag: ['Phase 1', 'Phase 2'] });
  await shownIds(['lead-a', 'lead-b', 'lead-c', 'lead-e']);
  cleanup();

  // one order as a group, one of its build phases inside it
  mount({ project: ['batch-7'] });
  await shownIds(['lead-a', 'lead-b', 'lead-c']);
  cleanup();
  mount({ project: ['batch-7'], tag: ['Phase 2'] });
  await shownIds(['lead-c']);
  cleanup();

  mount({ route: ['make', 'none'] });
  await shownIds(['lead-d', 'lead-e']);
  cleanup();

  mount({ q: 'checked' });
  await shownIds(['lead-b']);
  // the row shows its tags as chips
  const table = screen.getByTestId('cable-list');
  expect(within(table).getByLabelText('Tags: Phase 1, Checked')).toBeTruthy();
});

it('tags every design the filter shows in one request and reports it', async () => {
  mount({ project: ['batch-7'] });
  await shownIds(['lead-a', 'lead-b', 'lead-c']);
  fireEvent.click(screen.getByRole('button', { name: 'select 3' }));
  expect(screen.getByTestId('picked-count').textContent).toBe('3 selected');
  // a tick box takes one off again
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Lead lead-c → Plug' }));
  expect(screen.getByTestId('picked-count').textContent).toBe('2 selected');

  fireEvent.click(screen.getByRole('button', { name: 'Add tag…' }));
  fireEvent.change(await screen.findByLabelText('Tag to add'), { target: { value: 'Phase 3' } });
  fireEvent.click(screen.getByRole('button', { name: /Add “Phase 3” to 2 designs/ }));
  await waitFor(() => expect(state.sent).toEqual([{ designs: ['lead-a', 'lead-b'], add: ['Phase 3'] }]));
  await waitFor(() => expect(toasts.map((t) => t.title)).toEqual(['Tagged 1 design: +Phase 3.']));
  expect(toasts[0]!.description).toBe('1 design already was as asked.');
});
