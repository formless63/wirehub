// @vitest-environment jsdom
/**
 * The Parts drawer: host chrome (apps/studio's Build
 * view) has no permanent palette, so dragging a part onto the
 * canvas needs a toggleable stand-in. This proves the toggle, the drag
 * itself, and that it lands through the exact same `add-instance` dispatch
 * the node picker uses — one undo step, not a second code path.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import type { EditorChromeState } from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const REAL = loadDesignFromDisk('de9-terminal-board');

afterEach(cleanup);

/** A minimal `DataTransfer` stand-in — jsdom does not implement the real one. */
function fakeDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'copy',
    dropEffect: 'copy',
  } as unknown as DataTransfer;
}

describe('the Parts drawer, host chrome', () => {
  it('is closed by default and toggles open from the canvas toolbar', () => {
    const { container } = render(<CableEditor design={REAL} db={db} chrome="host" />);
    expect(container.querySelector('.cs-parts-drawer')).toBeNull();

    fireEvent.click(screen.getByLabelText('Parts'));
    expect(container.querySelector('.cs-parts-drawer')).not.toBeNull();
    expect(container.querySelector('.cs-parts-drawer .cs-part-item')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Close parts'));
    expect(container.querySelector('.cs-parts-drawer')).toBeNull();
  });

  it('is not offered in full chrome, which already has the palette pinned open', () => {
    const { container } = render(<CableEditor design={REAL} db={db} />);
    expect(screen.queryByLabelText('Parts')).toBeNull();
    expect(container.querySelector('.cs-palette')).not.toBeNull();
  });

  it('dragging a part onto the canvas adds it — one undo step, same as the node picker', async () => {
    const onChromeStateChange = (state: EditorChromeState): void => {
      states.push(state);
    };
    const states: EditorChromeState[] = [];

    const { container } = render(
      <CableEditor design={REAL} db={db} chrome="host" onChromeStateChange={onChromeStateChange} />,
    );

    fireEvent.click(screen.getByLabelText('Parts'));
    const item = screen.getByTitle('jst-xh-2-dc — drag onto the canvas');
    const canvas = container.querySelector('.cs-canvas');
    if (canvas === null) throw new Error('canvas missing');

    const before = container.querySelectorAll('.cs-node').length;

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(item, { dataTransfer });
    fireEvent.dragOver(canvas, { dataTransfer });
    fireEvent.drop(canvas, { dataTransfer, clientX: 320, clientY: 220 });

    await waitFor(() => expect(container.querySelectorAll('.cs-node')).toHaveLength(before + 1));
    await waitFor(() =>
      expect(states[states.length - 1]?.undoLabel).toContain('add connector jst-xh-2-dc'),
    );
    expect(states[states.length - 1]?.dirty).toBe(true);

    // the drawer stays open across the drop — dragging a second part in is
    // the point, not a one-shot dialog
    expect(container.querySelector('.cs-parts-drawer')).not.toBeNull();
  });
});
