// @vitest-environment jsdom
/**
 * The trace journey on the schematic sheet, over the starter's DE-9 crossover:
 * click a pin to light its whole path, see the chip name the ends, Alt+hover
 * to preview another path without committing, Esc and a click on empty paper
 * to clear. Connectivity is the model's; this file checks the wiring — that a
 * click on the drawn sheet reaches the trace and the sheet's own elements
 * take the classes.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SchematicPane } from '../src/panels/Schematic.tsx';
import { pickOf, traceFromPick } from '../src/trace-highlight.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const design = loadDesignFromDisk('de9-crossover');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open() {
  vi.useFakeTimers();
  const utils = render(<SchematicPane design={design} db={db} debounceMs={10} />);
  act(() => void vi.advanceTimersByTime(10));
  const view = utils.container.querySelector('.cs-schematic-view') as HTMLElement;
  Object.assign(view, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false), releasePointerCapture: vi.fn() });
  const svg = utils.container.querySelector('.cs-schematic-sheet svg') as SVGElement;
  return { ...utils, view, svg };
}

/** A click: press and release on the element, without moving. */
function click(view: HTMLElement, target: Element): void {
  fireEvent.pointerDown(target, { clientX: 5, clientY: 5, button: 0, pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: 5, clientY: 5, pointerId: 1 });
  expect(view).toBeDefined();
}

/** Two drawn terminals on different nets, found by what the sheet stamps on them. */
function terminalsOnDifferentNets(svg: Element): [Element, Element] {
  const seen = new Map<string, Element>();
  for (const el of svg.querySelectorAll('[data-terminal][data-net]')) {
    const net = el.getAttribute('data-net') ?? '';
    if (!net.includes(' ') && !seen.has(net)) seen.set(net, el);
  }
  const [first, second] = [...seen.values()];
  if (first === undefined || second === undefined) throw new Error('the sheet draws fewer than two nets');
  return [first, second];
}

describe('click-to-trace on the schematic sheet', () => {
  it('draws pickable terminals carrying their nets, and nothing lit to begin with', () => {
    const { svg } = open();
    expect(svg.querySelectorAll('[data-terminal][data-net]').length).toBeGreaterThan(4);
    expect(svg.classList.contains('is-tracing')).toBe(false);
    expect(svg.querySelectorAll('.on-trace').length).toBe(0);
    expect(screen.getByText('trace')).toBeDefined();
  });

  it('lights the picked pin’s net, dims the rest, and the chip names the path', () => {
    const { view, svg } = open();
    const [pin] = terminalsOnDifferentNets(svg);
    const expected = traceFromPick(design, db, pickOf(pin!)!);
    expect(expected?.nets.length).toBeGreaterThan(0);
    click(view, pin!);

    expect(svg.classList.contains('is-tracing')).toBe(true);
    const lit = [...svg.querySelectorAll('.on-trace')];
    expect(lit.length).toBeGreaterThan(0);
    // exactly the elements on the nets the model's trace reaches are lit
    const onSheet = [...svg.querySelectorAll('[data-net]')];
    const reaches = (el: Element): boolean => (el.getAttribute('data-net') ?? '').split(/\s+/).some((n) => expected!.nets.includes(n));
    expect(lit).toEqual(onSheet.filter(reaches));
    expect(onSheet.some((el) => !reaches(el))).toBe(true);
    expect(pin!.classList.contains('on-trace')).toBe(true);
    const chip = screen.getByRole('status');
    for (const end of expected!.ends.slice(0, 2)) expect(chip.textContent).toContain(end);
    expect(screen.queryByText('trace')).toBeNull();
  });

  it('lights a different set for a pin on another net, and only that one', () => {
    const { view, svg } = open();
    const [a, b] = terminalsOnDifferentNets(svg);
    click(view, a!);
    const first = new Set([...svg.querySelectorAll('.on-trace')]);
    click(view, b!);
    const second = new Set([...svg.querySelectorAll('.on-trace')]);
    expect(second.has(b!)).toBe(true);
    expect(first.has(b!)).toBe(false);
    expect(second.has(a!)).toBe(false);
  });

  it('a drag is a pan, not a pick', () => {
    const { view, svg } = open();
    const [pin] = terminalsOnDifferentNets(svg);
    fireEvent.pointerDown(pin!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(view, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(view, { clientX: 60, clientY: 40, pointerId: 1 });
    expect(svg.classList.contains('is-tracing')).toBe(false);
  });

  it('previews on Alt+hover without committing, and the preview goes away with the key', () => {
    const { view, svg } = open();
    const [pin] = terminalsOnDifferentNets(svg);
    fireEvent.pointerMove(pin!, { altKey: true, clientX: 1, clientY: 1, pointerId: 1 });
    expect(svg.classList.contains('is-tracing')).toBe(true);
    // a preview has no clear button: nothing is committed
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
    fireEvent.pointerMove(view, { altKey: false, clientX: 2, clientY: 2, pointerId: 1 });
    expect(svg.classList.contains('is-tracing')).toBe(false);
  });

  it('Esc clears a committed trace', () => {
    const { view, svg } = open();
    const [pin] = terminalsOnDifferentNets(svg);
    click(view, pin!);
    expect(svg.classList.contains('is-tracing')).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(svg.classList.contains('is-tracing')).toBe(false);
    expect(svg.querySelectorAll('.on-trace').length).toBe(0);
  });

  it('a click on empty paper clears it too', () => {
    const { view, svg } = open();
    const [pin] = terminalsOnDifferentNets(svg);
    click(view, pin!);
    click(view, svg);
    expect(svg.classList.contains('is-tracing')).toBe(false);
  });
});
