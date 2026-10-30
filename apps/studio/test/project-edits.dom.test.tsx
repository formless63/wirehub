import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '../src/knowledge.ts';
import type { ProjectDraft } from '../src/knowledge.browser.ts';

const state = vi.hoisted(() => ({ project: undefined as Project | undefined, revision: 1, writes: [] as ProjectDraft[], release: undefined as (() => void) | undefined }));
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<object>(), useParams: () => ({ id: 'test-project' }), useNavigate: () => () => undefined, Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('../src/studio-context.tsx', () => ({ useStudio: () => ({ me: { role: 'owner' } }) }));
vi.mock('../src/shell/RouteHeader.tsx', () => ({ RouteHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('../src/history/HistoryPanel.tsx', () => ({ HistoryButton: () => null }));
vi.mock('../src/knowledge/NotesPanel.tsx', () => ({ NotesPanel: () => null, AttachmentList: () => null }));
vi.mock('../src/knowledge/refs.tsx', () => ({
  useItemRefs: () => ({ options: [{ value: 'pcbas/alpha', label: 'Alpha board' }, { value: 'pcbas/beta', label: 'Beta board' }], resolve: (record: string) => ({ record, label: record === 'pcbas/alpha' ? 'Alpha board' : 'Beta board', noun: 'Board' }) }),
  RefChip: ({ item }: { item: { label: string } }) => <span>{item.label}</span>,
}));
vi.mock('../src/knowledge.browser.ts', async (original) => ({
  ...await original<object>(),
  fetchProject: async () => ({ project: structuredClone(state.project!), itemNotes: {}, notes: [], etag: String(state.revision) }),
  saveProject: async (_id: string, draft: ProjectDraft, etag: string) => {
    state.writes.push(draft);
    if (state.writes.length === 1) await new Promise<void>((resolve) => { state.release = resolve; });
    if (etag !== String(state.revision)) return { ok: false, message: 'Stale project' };
    state.project = { ...state.project!, ...draft }; state.revision++;
    return { ok: true, value: state.project };
  },
}));
const { ProjectRoute } = await import('../src/routes/ProjectsRoute.tsx');
afterEach(cleanup);
it('keeps rapid item picks and lets a project be renamed without changing its identity', async () => {
  state.project = { id: 'test-project', title: 'Test project', summary: '', status: 'active', items: [], attachments: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  state.revision = 1; state.writes = [];
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectRoute /></QueryClientProvider>);
  const pick = async (label: string) => {
    const input = await screen.findByRole('combobox', { name: 'Add an item' });
    fireEvent.focus(input); fireEvent.change(input, { target: { value: label } });
    fireEvent.click(await screen.findByRole('option', { name: label }));
  };
  await pick('Alpha board'); await waitFor(() => expect(state.release).toBeDefined());
  await pick('Beta board'); expect(state.writes).toHaveLength(1);
  state.release!();
  await waitFor(() => expect(state.project!.items).toEqual([{ record: 'pcbas/alpha' }, { record: 'pcbas/beta' }]));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Renamed project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('heading', { name: 'Renamed project' });
  expect(state.project!.id).toBe('test-project');
});
