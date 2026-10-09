// @vitest-environment jsdom
/**
 * The node picker, end to end: Tab opens it — anchored
 * to a selected terminal, or listing everything when nothing is selected —
 * Fits-here filtering on a real design, choosing inserts (and, when there is
 * exactly one obvious terminal, wires) it as one undo step, and Esc closes.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CableEditor,
  type EditorChromeState,
  type EditorHandle,
  type EditorStatus,
} from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const DESIGN = loadDesignFromDisk('de9-terminal-board');

afterEach(cleanup);

function tab(container: HTMLElement): void {
  const canvas = container.querySelector('.cs-canvas');
  if (canvas === null) throw new Error('.cs-canvas not found');
  fireEvent.keyDown(canvas, { key: 'Tab' });
}

describe('Tab opens the picker', () => {
  it('with nothing selected: viewport centre, every part, grouped by kind, no Fits here', () => {
    const { container } = render(<CableEditor design={DESIGN} db={db} />);
    tab(container);

    expect(screen.getByRole('dialog', { name: 'add a part' })).toBeDefined();
    expect(screen.queryByText('Fits here')).toBeNull();
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

describe('the node creator', () => {
  const LEAD = loadDesignFromDisk('dc-pigtail-lead');

  it('groups parts by kind and offers the store matches under "From the store"', async () => {
    const open = vi.fn();
    const store = { search: vi.fn(async () => [{ id: 'xlr-pack', label: 'XLR family', detail: 'pro-audio' }]), open };
    const { container } = render(<CableEditor design={DESIGN} db={db} partStore={store} />);
    tab(container);
    for (const title of ['Connectors', 'Wire stocks', 'Components', 'Boards']) {
      expect(container.querySelector(`.cs-picker-list [role="group"][aria-label="${title}"]`)).not.toBeNull();
    }
    fireEvent.change(screen.getByLabelText('search parts'), { target: { value: 'xlr' } });
    const row = await waitFor(() => {
      const found = container.querySelector('[data-picker-row="store:xlr-pack"]');
      if (found === null) throw new Error('no store row yet');
      return found;
    });
    expect(container.querySelector('[role="group"][aria-label="From the store"]')).not.toBeNull();
    fireEvent.mouseDown(row);
    expect(open).toHaveBeenCalledWith({ id: 'xlr-pack', label: 'XLR family', detail: 'pro-audio' });
    expect(screen.queryByRole('dialog', { name: 'add a part' })).toBeNull();
  });

  it('adds a connector at a free pin in three keystrokes: open, one letter, Enter', () => {
    const changes: { instances: { connectors: unknown[] }; joints: unknown[] }[] = [];
    const { container } = render(<CableEditor design={LEAD} db={db} onDesignChange={(d) => changes.push(d as never)} />);
    const before = LEAD.instances.connectors.length;
    // the pin's `+` (a pointer click) or, with the pin selected, Tab on the canvas: either way the picker is open
    fireEvent.click(container.querySelector('[aria-label="add a part at w1:red@b"]')!);
    const search = screen.getByLabelText('search parts');
    fireEvent.change(search, { target: { value: 'c' } });
    // the active row is the first connector that fits the free wire end
    const first = container.querySelector('.cs-picker-row.is-active') as HTMLElement;
    expect(first.dataset['pickerRow']).toMatch(/^connector:/);
    fireEvent.keyDown(search, { key: 'Enter' });
    const placed = changes.at(-1)!;
    expect(placed.instances.connectors.length).toBe(before + 1);
    expect(placed.joints.length).toBe(LEAD.joints.length + 1);
  });
});

describe('Tab from a selected pin', () => {
  it('opens anchored and Enter places the best fit: two keystrokes', () => {
    const changes: { instances: { segments: unknown[] } }[] = [];
    const { container } = render(<CableEditor design={DESIGN} db={db} onDesignChange={(d) => changes.push(d as never)} />);
    fireEvent.click(container.querySelector('[data-terminal="j1:7"]')!);
    tab(container);
    expect(container.querySelector('.cs-picker-anchor')?.textContent).toContain('j1');
    expect(container.querySelector('[role="group"][aria-label="Fits here"]')).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText('search parts'), { key: 'Enter' });
    expect(changes.length).toBe(1);
  });
});
