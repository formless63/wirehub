// @vitest-environment jsdom
/** DataTable: the keyboard contract (arrows, Enter, Space), selection into a SidePanel, sorting and the column menu. */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DataTable, EmptyState, PageBody, PageHeader, SidePanel, Toolbar, type DataColumn } from '../src/ui/index.ts';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

interface Row { id: string; name: string; qty: number; note: string }
const ROWS: Row[] = [
  { id: 'b', name: 'Bravo', qty: 2, note: 'second' },
  { id: 'a', name: 'Alpha', qty: 10, note: 'first' },
  { id: 'c', name: 'Charlie', qty: 1, note: 'third' },
];
const COLUMNS: DataColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name, fixed: true },
  { id: 'qty', header: 'Qty', cell: (r) => String(r.qty), sortValue: (r) => r.qty, numeric: true },
  { id: 'note', header: 'Note', cell: (r) => r.note },
];

function Harness({ onActivate }: { onActivate?: (r: Row) => void }) {
  const [selected, setSelected] = useState<string>();
  const row = ROWS.find((r) => r.id === selected);
  return (
    <>
      <PageHeader title="Parts" count="3 parts" />
      <Toolbar label="Part tools">tools</Toolbar>
      <PageBody
        panel={row === undefined ? undefined : <SidePanel title={row.name} subtitle={row.id} onClose={() => setSelected(undefined)}>detail of {row.name}</SidePanel>}
      >
        <DataTable label="Parts" rows={ROWS} columns={COLUMNS} getRowId={(r) => r.id} selectedId={selected} onSelect={(r) => setSelected(r.id)} {...(onActivate === undefined ? {} : { onActivate })} columnsKey="test" empty={<EmptyState>No parts.</EmptyState>} />
      </PageBody>
    </>
  );
}

const names = (): string[] => within(screen.getByRole('table', { name: 'Parts' })).getAllByRole('row').slice(1).map((r) => r.querySelector('td')?.textContent ?? '');

describe('DataTable', () => {
  it('has one heading, a named table and one tab stop', () => {
    render(<Harness />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('moves with the arrow keys, selects with Enter and opens the side panel', async () => {
    render(<Harness />);
    const first = screen.getAllByRole('row')[1] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getAllByRole('row')[2] as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(second));
    fireEvent.keyDown(second, { key: 'End' });
    const last = screen.getAllByRole('row')[3] as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(last));
    fireEvent.keyDown(last, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(screen.queryByRole('region', { name: 'Details' })).toBeNull();
    fireEvent.keyDown(second, { key: 'Enter' });
    const panel = await screen.findByRole('region', { name: 'Details' });
    expect(panel.textContent).toContain('detail of Alpha');
    expect(second.getAttribute('aria-selected')).toBe('true');
    // Escape inside the panel closes it
    fireEvent.keyDown(within(panel).getByRole('button', { name: 'Close details' }), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Details' })).toBeNull();
  });

  it('activates on Enter once the row is selected', () => {
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    const row = screen.getAllByRole('row')[1] as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getAllByRole('row')[1] as HTMLElement, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith(ROWS[0]);
  });

  it('sorts from the header and reports aria-sort', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(screen.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('hides a column from the column menu and remembers it', async () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByRole('columnheader', { name: 'Note' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Note' }));
    expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull();
    unmount();
    render(<Harness />);
    expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull();
  });

  it('says so when there are no rows', () => {
    render(<DataTable label="Empty" rows={[] as Row[]} columns={COLUMNS} getRowId={(r) => r.id} empty={<EmptyState>No parts.</EmptyState>} />);
    expect(screen.getByTestId('empty-state').textContent).toContain('No parts.');
  });
});
