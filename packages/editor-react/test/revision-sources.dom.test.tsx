// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RevisionsSection } from '../src/panels/RevisionsSection.tsx';
import type { RevisionsAdapter, RevisionsView } from '../src/revisions.ts';

vi.mock('../src/panels/ModelViewer3d.tsx', () => ({ default: ({ label }: { label: string }) => <p>{label}</p> }));
afterEach(() => { cleanup(); window.localStorage.clear(); });

it('shows a readable source revision and keeps its full citation available behind Source', async () => {
  const value: RevisionsView = {
    kind: 'pcbas', id: 'synthetic-board', label: 'Synthetic board', current: {}, revisions: [],
    external: [{ module: 'synthetic-source', source: 'parts', label: 'Recorded source revisions', revisions: [
      { rev: 'B', label: 'B', note: 'Moved the header.\nRecorded status: superseded.', savedAt: '2026-10-01', src: 'Synthetic source citation with complete provenance.' },
    ] }], whereUsed: { byRev: {}, unrecorded: [] }, etag: 'synthetic',
  };
  const adapter: RevisionsAdapter = {
    list: async () => ({ ok: true, value }),
    read: async () => ({ ok: false, message: 'No recorded snapshot' }),
    save: async () => ({ ok: false, message: 'Read-only source' }),
    nextNumber: async () => ({ ok: false, message: 'Read-only source' }),
  };
  render(<RevisionsSection kind="pcbas" id="synthetic-board" revisions={adapter} readOnly />);
  expect(await screen.findByText(/Moved the header/)).toBeTruthy();
  const summary = screen.getByText('Reference');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('complete provenance');
  expect(screen.queryByText('(B)')).toBeNull();
  expect(screen.getByText(/2026-10-01/)).toBeTruthy();
});


it('opens source model revisions with no saved definition snapshots and does not offer a historical comparison', async () => {
  window.localStorage.setItem('cs-model-panel-open', 'false');
  const value: RevisionsView = { kind: 'pcbas', id: 'synthetic-board', label: 'Synthetic board', current: { partNumber: 'BOARD-1' }, revisions: [], external: [], whereUsed: { byRev: {}, unrecorded: [] }, etag: 'synthetic' };
  const models: import('../src/models.ts').ModelsAdapter = {
    get: async () => ({ ok: true, value: null }),
    list: async () => ({ ok: true, value: { models: [], links: [{ record: 'revisions/BOARD-1/Rev2', asset: 'a'.repeat(64), sourceKind: 'uploaded', src: 'Synthetic source citation' }] } }),
    fetchModel: vi.fn(async () => ({ ok: true as const, value: { bytes: new ArrayBuffer(16), mime: 'model/gltf-binary' } })),
    attach: vi.fn(async () => ({ ok: false as const, message: 'read-only' })), upload: vi.fn(async () => ({ ok: false as const, message: 'read-only' })), detach: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  const revisions: RevisionsAdapter = { list: async () => ({ ok: true, value }), read: async () => ({ ok: false, message: 'no snapshots' }), save: async () => ({ ok: false, message: 'read-only' }), nextNumber: async () => ({ ok: false, message: 'read-only' }) };
  const onCompare = vi.fn();
  render(<RevisionsSection kind="pcbas" id="synthetic-board" revisions={revisions} models={models} readOnly onCompare={onCompare} />);
  fireEvent.click(await screen.findByRole('button', { name: 'View 3D · Rev2' }));
  expect(await screen.findByText('Synthetic board · source Rev2')).toBeTruthy();
  expect(screen.getByText(/do not establish historical definitions/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Compare with now' })).toBeNull();
  expect(models.fetchModel).toHaveBeenCalledWith('a'.repeat(64)); expect(onCompare).not.toHaveBeenCalled();
  expect(models.attach).not.toHaveBeenCalled(); expect(models.upload).not.toHaveBeenCalled();
});
