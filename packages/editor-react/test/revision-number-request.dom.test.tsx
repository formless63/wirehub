// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RevisionsAdapter, RevisionsView } from '../src/revisions.ts';
import { RevisionsSection } from '../src/panels/RevisionsSection.tsx';

afterEach(cleanup);
const view: RevisionsView = { kind: 'pcbas', id: 'synthetic-board', label: 'Synthetic board', current: {}, revisions: [], external: [], whereUsed: { byRev: {}, unrecorded: [] }, etag: 'synthetic' };
async function mount() {
  let resolve!: (value: { ok: true; value: { suggestion: { pn: string } } }) => void;
  const adapter: RevisionsAdapter = {
    list: async () => ({ ok: true, value: view }),
    read: async () => ({ ok: false, message: 'Not used' }),
    save: vi.fn<RevisionsAdapter['save']>(async () => ({ ok: true, value: view })),
    nextNumber: vi.fn<RevisionsAdapter['nextNumber']>(() => new Promise((yes) => { resolve = yes; })),
  };
  render(<RevisionsSection kind="pcbas" id="synthetic-board" revisions={adapter} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save a revision…' }));
  return { adapter, resolve: () => resolve({ ok: true, value: { suggestion: { pn: 'SYN-01' } } }) };
}

it('keeps cancellation final when a number suggestion arrives late', async () => {
  const request = await mount();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Save revision' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => request.resolve());
  expect(screen.queryByLabelText('Revision note')).toBeNull();
  expect(screen.getByRole('button', { name: 'Save a revision…' })).toBeTruthy();
});

it('does not re-enable renumbering after it was unchecked', async () => {
  const request = await mount();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => request.resolve());
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByText(/SYN-01/)).toBeNull();
});

it('preserves notes entered while checking a number and saves that confirmed choice', async () => {
  const request = await mount();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Revision note'), { target: { value: 'Moved the connector.' } });
  fireEvent.change(screen.getByLabelText('Revision name'), { target: { value: 'Reviewed B' } });
  await act(async () => request.resolve());
  expect((screen.getByLabelText('Revision note') as HTMLTextAreaElement).value).toBe('Moved the connector.');
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
  expect(request.adapter.save).toHaveBeenCalledWith('pcbas', 'synthetic-board', { note: 'Moved the connector.', label: 'Reviewed B', renumber: true });
});
