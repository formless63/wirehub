import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import type { PanelProps } from '@wirehub/modules';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FxPanel } from '../../../modules/fx-rates/src/ui.ts';
import { StandardWorkPanel } from '../../../modules/standard-work/src/ui.ts';

const design = (): CableDesign => ({ schemaVersion: 4, id: 'costing-test', label: 'Synthetic costing', src: 'synthetic example', instances: { connectors: [], segments: [], components: [], pcbas: [] }, joints: [] });
const db = () => createCatalog(fsCatalogSource(dataPath(''))).loadDb();
const snapshot = { base: 'EUR', date: '2026-01-02', rates: { USD: 2, GBP: 0.5 }, source: 'synthetic example', retrievedAt: '2026-01-02T16:00:00Z' };
const props = (d: CableDesign): PanelProps => ({ slot: 'cable-inspector', module: 'fx-rates', design: d, db: db(), readOnly: false, api: vi.fn(async () => ({ status: 200, body: { snapshot } })), onChange: vi.fn() });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('retrieves FX rates only on request and saves a snapshot without modifying catalog costs', async () => {
  const context = props(design());
  const before = structuredClone(context.db);
  render(<FxPanel {...context} />);
  expect(context.api).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Save FX snapshot' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retrieve reference rates' }));
  await screen.findByText(/Rate date 2026-01-02/);
  fireEvent.change(screen.getByLabelText('Report currency'), { target: { value: 'GBP' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save FX snapshot' }));
  expect(context.onChange).toHaveBeenCalledWith(expect.objectContaining({ extensions: { 'fx-rates': { schema: 1, snapshot, target: 'GBP' } } }), 'Save FX rate snapshot');
  expect(context.design?.extensions).toBeUndefined();
  expect(context.db).toEqual(before);
});

it('ignores late FX responses after switching designs and preserves the saved snapshot on failure', async () => {
  let resolve!: (value: { status: number; body: unknown }) => void;
  const context = props(design());
  context.api = vi.fn(() => new Promise(done => { resolve = done; }));
  const view = render(<FxPanel {...context} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retrieve reference rates' }));
  view.rerender(<FxPanel {...context} design={{ ...design(), id: 'next-design' }} />);
  await act(async () => resolve({ status: 200, body: { snapshot } }));
  expect(screen.queryByText(/Rate date 2026-01-02/)).toBeNull();
  const saved = { ...design(), extensions: { 'fx-rates': { schema: 1, snapshot, target: 'USD' } } };
  view.rerender(<FxPanel {...context} design={saved} api={async () => ({ status: 503, body: {} })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retrieve reference rates' }));
  await screen.findByRole('alert');
  expect(screen.getByText(/Rate date 2026-01-02/)).toBeTruthy();
  expect(context.onChange).not.toHaveBeenCalled();
});

it('records operation times separately and adopts batch-allocated labour only explicitly', async () => {
  const context = props({ ...design(), labourMinutes: 7 });
  render(<StandardWorkPanel {...context} module="standard-work" />);
  expect((screen.getByRole('button', { name: 'Adopt labour estimate' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add operation' }));
  fireEvent.change(screen.getByLabelText('Operation name'), { target: { value: 'Fixture setup' } });
  fireEvent.change(screen.getByLabelText('Timing source'), { target: { value: 'synthetic example' } });
  expect((screen.getByRole('button', { name: 'Adopt labour estimate' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Minutes per operation'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('Timing basis'), { target: { value: 'per-batch' } });
  fireEvent.change(screen.getByLabelText('Labour build quantity'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save operation table' }));
  expect(context.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ labourMinutes: 7 }), 'Save operation times');
  fireEvent.click(screen.getByRole('button', { name: 'Adopt labour estimate' }));
  expect(context.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ labourMinutes: 2, extensions: { 'standard-work': expect.objectContaining({ adoption: { builds: 10, minutes: 2 } }) } }), 'Adopt operation labour estimate');
  expect(context.design?.labourMinutes).toBe(7);
});

it.each([true, false])('prevents editing in locked views or hosts without the edit callback: readOnly=%s', async readOnly => {
  const context = props({ ...design(), extensions: { 'fx-rates': { schema: 1, snapshot, target: 'USD' } } });
  const view = render(<FxPanel {...context} readOnly={readOnly} onChange={readOnly ? context.onChange : undefined} />);
  expect((screen.getByRole('button', { name: 'Save FX snapshot' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Retrieve reference rates' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  render(<StandardWorkPanel {...context} readOnly={readOnly} onChange={readOnly ? context.onChange : undefined} />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Add operation' }) as HTMLButtonElement).disabled).toBe(true));
});
