// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RevisionsSection } from '../src/panels/RevisionsSection.tsx';
import type { RevisionsAdapter, RevisionsView } from '../src/revisions.ts';

afterEach(cleanup);

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
