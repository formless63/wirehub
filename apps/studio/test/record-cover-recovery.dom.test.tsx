// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordCover } from '../src/RecordCover.tsx';
import { CoverAccessDenied, readCover, type CoverView } from '../src/representations.browser.ts';

vi.mock('../src/representations.browser.ts', async (original) => ({
  ...await original<typeof import('../src/representations.browser.ts')>(), readCover: vi.fn(),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
const identity = { record: 'pcbas/synthetic-adapter', revision: '2', build: 'as-designed' };
const view: CoverView = { identity, choice: null, etag: 'test', candidates: [{
  view: 'board-top', label: 'Board top', identity, lineage: 'native-source', asset: 'a'.repeat(64),
  sourceKind: 'kicad', fidelity: 'Native outline and pads', limitations: [], src: 'synthetic example', sources: [],
}] };
async function mount() {
  vi.useFakeTimers();
  vi.mocked(readCover).mockResolvedValue(view);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><RecordCover id="synthetic-adapter" label="Synthetic adapter" compact />
    <RecordCover id="synthetic-adapter" label="Synthetic adapter" /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  return client;
}
it('shares one request between row/header, does not poll, and refreshes on catalog invalidation', async () => {
  const client = await mount();
  expect(screen.getAllByAltText('Synthetic adapter — Board top')).toHaveLength(2);
  expect(readCover).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
  expect(readCover).toHaveBeenCalledTimes(1);
  await act(async () => { await client.invalidateQueries({ queryKey: ['representations'] }); });
  expect(readCover).toHaveBeenCalledTimes(2);
});
it('retries a transient same-hash image once, then offers explicit retry without a request loop', async () => {
  await mount();
  fireEvent.error(screen.getAllByAltText('Synthetic adapter — Board top')[1]!);
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(screen.getAllByAltText('Synthetic adapter — Board top')).toHaveLength(2);
  fireEvent.error(screen.getAllByAltText('Synthetic adapter — Board top')[1]!);
  await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
  expect(screen.getAllByAltText('Synthetic adapter — Board top')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
  expect(screen.getAllByAltText('Synthetic adapter — Board top')).toHaveLength(2);
});
it('retains a cached preview on transient metadata failure, but hides it on access denial', async () => {
  const client = await mount();
  vi.mocked(readCover).mockRejectedValueOnce(new Error('Temporary transport failure'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['representations'] }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(screen.getAllByAltText('Synthetic adapter — Board top')).toHaveLength(2);
  vi.mocked(readCover).mockRejectedValueOnce(new CoverAccessDenied('Access denied'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['representations'] }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(screen.queryAllByAltText('Synthetic adapter — Board top')).toHaveLength(0);
});
