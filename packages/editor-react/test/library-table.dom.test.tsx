// @vitest-environment jsdom
/**
 * The Library table as a person uses it, over the starter's connectors:
 * rows by name, sort by clicking a header (ascending, descending, off),
 * filter by a facet chip and by the search text, pick a row with the mouse or
 * the keyboard, hide a column and have the choice remembered. The row and
 * column computation is `library-table.ts`; this checks the drawing of it.
 */

import './reactflow-jsdom.ts';

import type { ConnectorDefinition, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libraryColumns, libraryRows } from '../src/library-table.ts';
import { LibraryTable, type LibraryTableProps } from '../src/panels/LibraryTable.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const designs = ['de9-crossover', 'de9-terminal-board'].map(loadDesignFromDisk);

beforeEach(() => {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // storage blocked: the remembered-columns case below would say so
  }
});
afterEach(cleanup);

function table(props: Partial<LibraryTableProps> = {}): { onSelect: ReturnType<typeof vi.fn> } {
  const rows = libraryRows('connectors', db.connectors as ConnectorDefinition[], [], { db, designs });
  const onSelect = vi.fn();
  render(
    <LibraryTable
      kind="connectors"
      rows={rows}
      columns={libraryColumns('connectors')}
      query=""
      onSelect={onSelect}
      empty="No connectors match."
      {...props}
    />,
  );
  return { onSelect };
}

const names = (): string[] =>
  [...document.querySelectorAll('tbody tr[data-id]')].map((tr) => tr.querySelector('td[data-col="name"] .cs-lt-text')?.textContent ?? '');
const ids = (): string[] => [...document.querySelectorAll('tbody tr[data-id]')].map((tr) => tr.getAttribute('data-id') ?? '');

describe('<LibraryTable> over the starter connectors', () => {
  it('shows a row per connector with the kind’s columns', () => {
    table();
    expect(ids()).toEqual(['de9-female', 'de9-male', 'jst-xh-2-dc', 'terminal-block-4']);
    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent);
    for (const header of ['PN', 'Name', 'Family', 'Gender', 'Pins', 'Used', 'Flags']) expect(headers).toContain(header);
    // Id is off until turned on
    expect(headers).not.toContain('Id');
  });

  it('sorts ascending, then descending, then back to the stored order', () => {
    table();
    const stored = ids();
    const name = within(document.querySelector('th[data-col="name"]') as HTMLElement).getByRole('button');
    fireEvent.click(name);
    expect(document.querySelector('th[data-col="name"]')?.getAttribute('aria-sort')).toBe('ascending');
    const asc = names();
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
    fireEvent.click(name);
    expect(document.querySelector('th[data-col="name"]')?.getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual([...asc].reverse());
    fireEvent.click(name);
    expect(document.querySelector('th[data-col="name"]')?.getAttribute('aria-sort')).toBeNull();
    expect(ids()).toEqual(stored);
  });

  it('sorts numeric columns by number, not by text', () => {
    table();
    const pins = within(document.querySelector('th[data-col="pins"]') as HTMLElement).getByRole('button');
    fireEvent.click(pins);
    const counts = [...document.querySelectorAll('tbody td[data-col="pins"]')].map((td) => Number(td.textContent));
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('filters by a facet chip, says which is on, and resets', async () => {
    table();
    fireEvent.click(screen.getByTitle('Filter by family'));
    const menu = await screen.findByLabelText('Family filter');
    fireEvent.click(within(menu).getByRole('checkbox', { name: /terminal-block|Terminal block/i }));
    expect(ids()).toEqual(['terminal-block-4']);
    expect(screen.getByTitle('Filter by family').textContent).toMatch(/terminal/i);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(ids().length).toBe(4);
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('filters by the search text and says so when nothing matches', () => {
    const rows = libraryRows('connectors', db.connectors as ConnectorDefinition[], [], { db, designs });
    const columns = libraryColumns('connectors');
    const { rerender } = render(<LibraryTable kind="connectors" rows={rows} columns={columns} query="jst" onSelect={() => {}} empty="No connectors match." />);
    expect(ids()).toEqual(['jst-xh-2-dc']);
    rerender(<LibraryTable kind="connectors" rows={rows} columns={columns} query="no such part" onSelect={() => {}} empty="No connectors match." />);
    expect(ids()).toEqual([]);
    expect(screen.getByText('No connectors match.')).toBeDefined();
  });

  it('reports shown and total through onCount', () => {
    const onCount = vi.fn();
    const rows = libraryRows('connectors', db.connectors as ConnectorDefinition[], [], { db, designs });
    render(<LibraryTable kind="connectors" rows={rows} columns={libraryColumns('connectors')} query="de9" onSelect={() => {}} empty="-" onCount={onCount} />);
    expect(onCount).toHaveBeenLastCalledWith(2, 4);
  });

  it('selects a row by click and by Enter or Space, and marks the open one', () => {
    const { onSelect } = table({ selectedId: 'de9-male' });
    expect(document.querySelector('tr[data-id="de9-male"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('tr[data-id="de9-female"]')?.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(document.querySelector('tr[data-id="jst-xh-2-dc"]')!);
    fireEvent.keyDown(document.querySelector('tr[data-id="terminal-block-4"]')!, { key: 'Enter' });
    fireEvent.keyDown(document.querySelector('tr[data-id="de9-female"]')!, { key: ' ' });
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(['jst-xh-2-dc', 'terminal-block-4', 'de9-female']);
  });

  it('counts where each connector is used from the designs', () => {
    table();
    const used = (id: string): string => document.querySelector(`tr[data-id="${id}"] td[data-col="used"]`)?.textContent ?? '';
    expect(used('de9-female')).not.toBe('—');
    expect(used('terminal-block-4')).toBe('1');
    expect(used('jst-xh-2-dc')).toBe('0');
  });

  it('hides a column from the menu and remembers it for the next table of that kind', () => {
    table();
    expect(document.querySelector('th[data-col="gender"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = screen.getByRole('group', { name: 'Show columns' });
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Gender' }));
    expect(document.querySelector('th[data-col="gender"]')).toBeNull();
    // Name and PN are always there
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Name' })).toBeNull();
    cleanup();
    table();
    expect(document.querySelector('th[data-col="gender"]')).toBeNull();
  });

  it('turns on a column that is off by default', () => {
    table();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Show columns' })).getByRole('menuitemcheckbox', { name: 'Id' }));
    expect(document.querySelector('th[data-col="id"]')).not.toBeNull();
    expect(document.querySelector('tr[data-id="jst-xh-2-dc"] td[data-col="id"]')?.textContent).toBe('jst-xh-2-dc');
  });

  it('keeps only PN and Name beside an open record, and has no filter bar', () => {
    table({ compact: true });
    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['PN', 'Name']);
    expect(screen.queryByRole('toolbar', { name: 'filters' })).toBeNull();
  });

  it('adds a compare checkbox per row in pick mode without selecting the row', () => {
    const toggle = vi.fn();
    const { onSelect } = table({ pick: { ids: ['de9-male'], toggle } });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBe(4);
    expect(screen.getByRole('checkbox', { name: /compare .*male/i, checked: true })).toBeTruthy();
    fireEvent.click(boxes[0]!);
    expect(toggle).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
