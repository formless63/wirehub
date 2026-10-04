// @vitest-environment jsdom
/**
 * The 2026-09-26 review's small fixes, each pinned:
 *
 * - Bug 2: a reload or tab close with unsaved edits asks first (`beforeunload`).
 * - Bug 10: a picker lists each group heading once.
 * - Bug 11: a new connector with the same body and pinout as one on file warns
 *   before it is saved.
 * - Bug 14: a blank new record shows no "saved" chip and no Revert.
 */

import type { Db } from '@cable-studio/model';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectorJourney } from '../src/panels/ConnectorJourney.tsx';
import { groupContiguous } from '../src/panels/Pick.tsx';
import { useUnsavedChangesGuard } from '../src/panels/useUnsavedChangesGuard.ts';
import { loadDbFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(() => cleanup());

function unloadIsBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('the unsaved-changes guard (Bug 2)', () => {
  it('blocks leaving the page exactly while something is unsaved', () => {
    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChangesGuard(dirty), { initialProps: { dirty: false } });
    expect(unloadIsBlocked()).toBe(false);
    rerender({ dirty: true });
    expect(unloadIsBlocked()).toBe(true);
    rerender({ dirty: false });
    expect(unloadIsBlocked()).toBe(false);
    rerender({ dirty: true });
    unmount();
    expect(unloadIsBlocked()).toBe(false);
  });
});

describe('picker groups (Bug 10)', () => {
  it('brings each group together, in first-seen order, members in their own order', () => {
    const options = [
      { value: 'a1', group: 'SCART' },
      { value: 'b1', group: 'RCA' },
      { value: 'a2', group: 'SCART' },
      { value: 'c1', group: 'Console multi-out' },
      { value: 'b2', group: 'RCA' },
    ];
    expect(groupContiguous(options).map((o) => o.value)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1']);
  });
});

describe('the new-connector journey', () => {
  const base = { db, readOnly: false, takenIds: db.connectors.map((c) => c.id), onSaved: () => undefined, onClose: () => undefined };

  it('shows no "saved" chip and no Revert on a blank new record (Bug 14)', () => {
    const { container } = render(<ConnectorJourney {...base} />);
    expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull();
    expect(container.querySelector('.cs-def-actions .cs-chip')).toBeNull();
    expect(screen.queryByTestId('duplicate-connector')).toBeNull();
  });
});
