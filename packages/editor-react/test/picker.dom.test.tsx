// @vitest-environment jsdom
/**
 * The node picker, end to end: Tab opens it — anchored
 * to a selected terminal, or listing everything when nothing is selected —
 * Fits-here filtering on a real design, choosing inserts (and, when there is
 * exactly one obvious terminal, wires) it as one undo step, and Esc closes.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@cable-studio/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CableEditor,
  type EditorChromeState,
  type EditorHandle,
  type EditorStatus,
} from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const DESIGN = loadDesignFromDisk('rs485-de9-terminal-board');

afterEach(cleanup);

function tab(container: HTMLElement): void {
  const canvas = container.querySelector('.cs-canvas');
  if (canvas === null) throw new Error('.cs-canvas not found');
  fireEvent.keyDown(canvas, { key: 'Tab' });
}

describe('Tab opens the picker', () => {
  it('with nothing selected: viewport centre, every part, no Fits here/Other split', () => {
    const { container } = render(<CableEditor design={DESIGN} db={db} />);
    tab(container);

    expect(screen.getByRole('dialog', { name: 'add a part' })).toBeDefined();
    expect(screen.queryByText('Fits here')).toBeNull();
    expect(screen.queryByText('Other')).toBeNull();
    // no anchor chip when nothing was selected
    expect(container.querySelector('.cs-picker-anchor')).toBeNull();
    // every real definition is listed — connectors, wire, components, PCBAs
    expect(container.querySelectorAll('.cs-picker-row').length).toBeGreaterThan(10);
  });

  it('Esc closes it', () => {
    const { container } = render(<CableEditor design={DESIGN} db={db} />);
    tab(container);
    const search = screen.getByLabelText('search parts');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'add a part' })).toBeNull();
  });

  it('a free handle draws its own `+`, which opens the picker anchored there', () => {
    const { container } = render(<CableEditor design={DESIGN} db={db} />);
    const plus = container.querySelector('[aria-label="add a part at j1:7"]');
    expect(plus).not.toBeNull();
    fireEvent.click(plus as Element);
    expect(container.querySelector('.cs-picker-anchor')?.textContent).toContain('7');
  });
});
