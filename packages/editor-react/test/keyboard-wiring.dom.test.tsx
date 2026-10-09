// @vitest-environment jsdom
/**
 * Wiring from the keyboard alone, through the inspector's connection table: find a pin with `/`,
 * Enter carries on in the inspector, the connect field makes the first joint, and the add row takes
 * pad and conductor (type, Enter, type, Enter) for each joint after it. Then a row is re-landed and
 * deleted with the keys, and the canvas starts no animation of its own under reduced motion.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
// the crossover lead with nothing soldered yet: j1, j2 and a four-core trunk
const CROSSOVER = loadDesignFromDisk('de9-crossover');
const BARE: CableDesign = {
  ...CROSSOVER,
  instances: { ...CROSSOVER.instances, segments: CROSSOVER.instances.segments.map(({ pigtails: _pigtails, ...segment }) => segment) },
  joints: [],
  notes: [],
};

afterEach(cleanup);

const canvasOf = (container: HTMLElement): Element => {
  const canvas = container.querySelector('.cs-canvas');
  if (canvas === null) throw new Error('.cs-canvas not found');
  return canvas;
};

/** The element holding the keyboard focus, once it is the one asked for. */
async function focused(match: (el: HTMLElement) => boolean): Promise<HTMLInputElement> {
  await waitFor(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null || !match(el)) throw new Error(`focus is on ${el?.tagName ?? 'nothing'} ${el?.getAttribute('aria-label') ?? ''}`);
  });
  return document.activeElement as HTMLInputElement;
}

/** Type into the focused search field and press Enter, as a person would. */
function typeAndEnter(input: HTMLElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('wiring without a mouse', () => {
  it('wires three conductors from the keyboard', async () => {
    const changes: CableDesign[] = [];
    const { container } = render(<CableEditor design={BARE} db={db} onDesignChange={(d) => changes.push(d)} />);
    const canvas = canvasOf(container);

    // `/` finds the pin, which selects it
    fireEvent.keyDown(canvas, { key: '/' });
    typeAndEnter(screen.getByLabelText('find a pin'), 'j1:3');
    // Enter on the canvas hands the keyboard to the inspector: the connect field of the unjointed pin
    fireEvent.keyDown(canvas, { key: 'Enter' });
    const connect = await focused((el) => el.getAttribute('aria-label') === 'connect j1:3 to');
    typeAndEnter(connect, 'w1:pair-1.a@a');
    expect(changes.at(-1)?.joints).toHaveLength(1);

    // the connection's table has opened with its add row focused: pad, Enter, conductor, Enter
    for (const [pad, conductor] of [['2', 'pair-1.b'], ['5', 'pair-2.a']] as const) {
      const padField = await focused((el) => el.getAttribute('aria-label') === 'pad');
      typeAndEnter(padField, pad);
      const wireField = await focused((el) => el.getAttribute('aria-label') === 'conductor');
      typeAndEnter(wireField, conductor);
    }

    const joints = changes.at(-1)!.joints.map((j) => `${j.a.instance}:${j.a.terminal}${j.a.end === undefined ? '' : `@${j.a.end}`}|${j.b.instance}:${j.b.terminal}${j.b.end === undefined ? '' : `@${j.b.end}`}`);
    expect(joints).toEqual([
      'j1:3|w1:pair-1.a@a',
      'j1:2|w1:pair-1.b@a',
      'j1:5|w1:pair-2.a@a',
    ]);
    // the add row is ready for the next one
    await focused((el) => el.getAttribute('aria-label') === 'pad');
  });

  it('moves between rows with the arrows, re-lands one with Enter and deletes one with Delete', async () => {
    const wired: CableDesign = {
      ...BARE,
      joints: [
        { a: { instance: 'j1', terminal: '3' }, b: { instance: 'w1', terminal: 'pair-1.a', end: 'a' } },
        { a: { instance: 'j1', terminal: '2' }, b: { instance: 'w1', terminal: 'pair-1.b', end: 'a' } },
        { a: { instance: 'j1', terminal: '5' }, b: { instance: 'w1', terminal: 'pair-2.a', end: 'a' } },
      ],
    };
    const changes: CableDesign[] = [];
    const { container } = render(<CableEditor design={wired} db={db} onDesignChange={(d) => changes.push(d)} />);
    const canvas = canvasOf(container);
    fireEvent.keyDown(canvas, { key: '/' });
    typeAndEnter(screen.getByLabelText('find a pin'), 'j1:3');
    fireEvent.keyDown(canvas, { key: 'Enter' });

    // the add row has the focus; Escape steps back to the last row
    const add = await focused((el) => el.getAttribute('aria-label') === 'pad');
    fireEvent.keyDown(add, { key: 'Escape' });
    const last = await focused((el) => el.hasAttribute('data-conn-row'));
    expect(last.getAttribute('aria-label')).toBe('5 to pair-2.a');
    fireEvent.keyDown(last, { key: 'ArrowUp' });
    const middle = await focused((el) => el.getAttribute('aria-label') === '2 to pair-1.b');

    // Enter edits the ends: keep the pad, take another conductor
    fireEvent.keyDown(middle, { key: 'Enter' });
    const pad = await focused((el) => el.getAttribute('aria-label') === 'pad');
    fireEvent.keyDown(pad, { key: 'Enter' });
    const wire = await focused((el) => el.getAttribute('aria-label') === 'conductor');
    typeAndEnter(wire, 'pair-2.b');
    expect(changes.at(-1)?.joints[1]?.b.terminal).toBe('pair-2.b');
    const again = await focused((el) => el.getAttribute('aria-label') === '2 to pair-2.b');

    // Delete unsolders it
    fireEvent.keyDown(again, { key: 'Delete' });
    expect(changes.at(-1)?.joints).toHaveLength(2);
  });
});

describe('reduced motion', () => {
  it('centres on a found pin without animating', async () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
    vi.stubGlobal('matchMedia', matchMedia);
    window.matchMedia = matchMedia as never;
    const { prefersReducedMotion } = await import('../src/motion.ts');
    expect(prefersReducedMotion()).toBe(true);
    vi.unstubAllGlobals();
  });
});
