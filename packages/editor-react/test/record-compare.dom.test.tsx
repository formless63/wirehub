// @vitest-environment jsdom
/** The base's generic compare (cs-5k1.21): a field diff of two records of one kind. */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecordCompare } from '../src/panels/RecordCompare.tsx';
import { diffRecords, libraryRecord } from '../src/record-diff.ts';
import { loadDbFromDisk } from './fixture.ts';

const db = loadDbFromDisk();
afterEach(cleanup);

describe('diffRecords', () => {
  it('flattens, keys arrays of id-bearing objects by id, and names what changed or is on one side only', () => {
    const rows = diffRecords(
      { id: 'x', label: 'One', pins: [{ id: '1', signal: 'a' }, { id: '2', signal: 'b' }], only: 1, tags: ['p', 'q'] },
      { id: 'y', label: 'One', pins: [{ id: '2', signal: 'c' }, { id: '1', signal: 'a' }], extra: true, tags: ['p'] },
    );
    const by = Object.fromEntries(rows.map((r) => [r.path, r.status]));
    expect(by).toMatchObject({ id: 'changed', label: 'same', 'pins[1].signal': 'same', 'pins[2].signal': 'changed', only: 'only-a', extra: 'only-b', 'tags[0]': 'same', 'tags[1]': 'only-a' });
  });

  it('two equal records have no differing rows', () => {
    const c = db.connectors[0]!;
    expect(diffRecords(c, structuredClone(c)).every((r) => r.status === 'same')).toBe(true);
  });
});

describe('RecordCompare', () => {
  it('asks for the second record, then shows only the differing fields, and unchanged ones on request', () => {
    const [first, second] = db.components;
    render(<RecordCompare db={db} a={{ kind: 'components', id: first!.id }} onClose={vi.fn()} />);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: second!.id } });
    const table = screen.getByRole('table', { name: 'Field differences' });
    const paths = within(table).getAllByRole('row').slice(1).map((r) => r.querySelector('code')!.textContent);
    expect(paths).toContain('id');
    const shown = paths.length;
    fireEvent.click(screen.getByLabelText(/show unchanged fields/));
    expect(within(table).getAllByRole('row').length - 1).toBeGreaterThanOrEqual(shown);
  });

  it('opens with both records when both are given, and closes', () => {
    const [first, second] = db.mechanicals!;
    const onClose = vi.fn();
    render(<RecordCompare db={db} a={{ kind: 'mechanicals', id: first!.id }} b={{ kind: 'mechanicals', id: second!.id }} onClose={onClose} />);
    expect(screen.getByRole('table', { name: 'Field differences' })).toBeTruthy();
    expect(libraryRecord(db, 'mechanicals', first!.id)).toBe(first);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
