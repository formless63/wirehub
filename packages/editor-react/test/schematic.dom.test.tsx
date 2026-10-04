// @vitest-environment jsdom
/**
 * The Schematic view: `view="schematic"` draws the
 * render-svg schematic full size, with its own Fit/100% controls, and keeps
 * drawing the same schematic the old dock's tab drew — same `renderPreview`
 * call, so this is wiring, not a second renderer to keep in sync.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { SchematicPane } from '../src/panels/Schematic.tsx';
import { diskDepictions, loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const design = loadDesignFromDisk('de9-terminal-board');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<SchematicPane>', () => {
  it('draws the schematic full size, with Fit and 100% controls', async () => {
    vi.useFakeTimers();
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));

    expect(container.querySelector('.cs-schematic-sheet svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeDefined();
    expect(screen.getByRole('button', { name: '100%' })).toBeDefined();

    // neither control throws even though jsdom never lays anything out (0
    // client size) — `fit()` is guarded for exactly that
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(container.querySelector('.cs-schematic-zoom')?.textContent).toBe('100%');
  });

  it('pans on drag and zooms on wheel — the sheet carries the transform', async () => {
    vi.useFakeTimers();
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));

    const view = container.querySelector('.cs-schematic-view') as HTMLElement;
    const sheet = container.querySelector('.cs-schematic-sheet') as HTMLElement;
    Object.assign(view, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });

    fireEvent.wheel(view, { deltaY: -100 });
    const zoomedTransform = sheet.style.transform;

    fireEvent.pointerDown(view, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(view, { clientX: 40, clientY: 25, pointerId: 1 });
    fireEvent.pointerUp(view, { pointerId: 1 });

    expect(sheet.style.transform).not.toBe(zoomedTransform);
    expect(sheet.style.transform).toContain('translate(40px, 25px)');
  });

  it('wheel-zooms centred on the cursor, not the sheet origin', async () => {
    vi.useFakeTimers();
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));

    const view = container.querySelector('.cs-schematic-view') as HTMLElement;
    const sheet = container.querySelector('.cs-schematic-sheet') as HTMLElement;
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;

    // zooming with the cursor away from the sheet's (0, 0) origin must move
    // the pan so that point stays under the cursor — a pure re-scale about
    // the origin (the pre-fix behaviour) would leave pan at (0, 0)
    fireEvent.wheel(view, { deltaY: -200, clientX: 300, clientY: 200 });
    expect(sheet.style.transform).not.toContain('translate(0px, 0px)');
  });

  it('arrow keys pan, +/- zoom, 0 fits', async () => {
    vi.useFakeTimers();
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));

    const view = container.querySelector('.cs-schematic-view') as HTMLElement;
    const sheet = container.querySelector('.cs-schematic-sheet') as HTMLElement;

    fireEvent.keyDown(view, { key: 'ArrowRight' });
    expect(sheet.style.transform).toContain('translate(-80px, 0px)');

    fireEvent.keyDown(view, { key: 'ArrowDown' });
    expect(sheet.style.transform).toContain('translate(-80px, -80px)');

    const zoomBefore = container.querySelector('.cs-schematic-zoom')?.textContent;
    fireEvent.keyDown(view, { key: '+' });
    expect(container.querySelector('.cs-schematic-zoom')?.textContent).not.toBe(zoomBefore);

    // fit() is guarded for jsdom's zero layout (no real client size to fit
    // to) — '0' must reach it without throwing
    expect(() => fireEvent.keyDown(view, { key: '0' })).not.toThrow();
  });

  it('"Copy text" copies the sheet\'s labels — the sheet itself has selection off', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));

    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied.length).toBeGreaterThan(0);
    // whatever text the sheet drew is really in there, not a placeholder
    const svg = container.querySelector('.cs-schematic-sheet svg') as SVGSVGElement;
    const firstLabel = svg.querySelector('text')?.textContent ?? '';
    expect(copied).toContain(firstLabel);
  });
});

describe('<SchematicPane> trace highlighting', () => {
  it('traces what is clicked, sums it up in a chip, and clears on Esc or empty paper', () => {
    vi.useFakeTimers();
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));
    const view = container.querySelector('.cs-schematic-view') as HTMLElement;
    Object.assign(view, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
    const svg = container.querySelector('.cs-schematic-sheet svg') as SVGSVGElement;
    const joint = svg.querySelector('.joint[data-a] path') as SVGPathElement;

    const click = (target: Element): void => {
      fireEvent.pointerDown(target, { clientX: 5, clientY: 5, button: 0, pointerId: 1 });
      fireEvent.pointerUp(view, { clientX: 5, clientY: 5, pointerId: 1 });
    };
    click(joint);
    expect(container.querySelector('.cs-trace-chip')).not.toBeNull();
    expect(svg.classList.contains('is-tracing')).toBe(true);
    expect(joint.closest('.joint')?.classList.contains('on-trace')).toBe(true);
    // a pan re-renders the pane but keeps the same sheet, trace and all
    fireEvent.wheel(view, { deltaY: -100 });
    expect(container.querySelector('.cs-schematic-sheet svg')).toBe(svg);
    expect(svg.classList.contains('is-tracing')).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.cs-trace-chip')).toBeNull();
    expect(svg.classList.contains('is-tracing')).toBe(false);

    click(joint);
    click(svg.querySelector('.page') as Element);
    expect(container.querySelector('.cs-trace-chip')).toBeNull();
  });

  it('a drag pans and never traces', () => {
    vi.useFakeTimers();
    const { container } = render(<SchematicPane design={design} db={db} debounceMs={10} />);
    act(() => void vi.advanceTimersByTime(10));
    const view = container.querySelector('.cs-schematic-view') as HTMLElement;
    Object.assign(view, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
    const joint = container.querySelector('.cs-schematic-sheet .joint[data-a] path') as Element;
    fireEvent.pointerDown(joint, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(view, { clientX: 40, clientY: 25, pointerId: 1 });
    fireEvent.pointerUp(view, { clientX: 40, clientY: 25, pointerId: 1 });
    expect(container.querySelector('.cs-trace-chip')).toBeNull();
  });
});

describe('<CableEditor> — the schematic view', () => {
  it('view="schematic" renders it in place of the canvas', async () => {
    const { container } = render(<CableEditor design={design} db={db} view="schematic" chrome="host" />);
    expect(container.querySelector('.cs-schematic')).not.toBeNull();
    expect(container.querySelector('.cs-canvas')).toBeNull();
    await waitFor(() => expect(container.querySelector('.cs-schematic-sheet svg')).not.toBeNull());
  });

});
