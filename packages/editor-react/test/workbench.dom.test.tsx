// @vitest-environment jsdom
/**
 * The owner's first hour with the canvas, as tests: parts that can be grabbed,
 * an arrangement that survives an edit, panes that move, and a minimap that
 * looks like it was meant.
 *
 * Kept shallow, as the house pattern asks: the arithmetic is proved in
 * `layout.test.ts`, `positions.test.ts` and `splitters.test.ts`; what is proved
 * here is that it is wired to the DOM at all.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { memoryLayoutStore } from '../src/layout-store.ts';
import { POSITION_SAVE_DEBOUNCE_MS } from '../src/remember.ts';
import { DEFAULT_PANES, PANE_KEY_STEP } from '../src/splitters.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

/**
 * A host of the shape the studio is: it keeps the design it is handed and
 * passes it straight back down. Anything that treats that echo as "a new
 * document from outside" throws the user's work away on every edit.
 */
function EchoHost({ initial }: { initial: CableDesign }): JSX.Element {
  const [design, setDesign] = useState(initial);
  return (
    <CableEditor design={design} db={db} savedDesign={initial} onDesignChange={setDesign} />
  );
}

/** where each part sits on the canvas, by instance id */
function placement(container: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of container.querySelectorAll('.react-flow__node')) {
    out[node.getAttribute('data-id') ?? ''] = (node as HTMLElement).style.transform;
  }
  return out;
}

const transforms = (container: HTMLElement): string[] =>
  Object.values(placement(container));

describe('the arrangement', () => {

  it('is read from and written back to the host’s layout store', () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    const store = memoryLayoutStore();
    store.savePositions(design.id, { j1: { x: 900, y: 800 } });
    const { container } = render(<CableEditor design={design} db={db} layout={store} />);
    expect(transforms(container)).toContain('translate(900px,800px)');
  });

  it('is laid out again, and only then, when the user asks', () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    const store = memoryLayoutStore();
    store.savePositions(design.id, { j1: { x: 900, y: 800 } });
    const { container } = render(<CableEditor design={design} db={db} layout={store} />);

    fireEvent.click(screen.getByRole('button', { name: /auto-arrange/ }));
    expect(transforms(container)).not.toContain('translate(900px,800px)');
    expect(
      [...container.querySelectorAll('.cs-chip')].some((chip) =>
        /auto-arranged/.test(chip.textContent ?? ''),
      ),
    ).toBe(true);
  });
});

describe('what the host is told to remember', () => {
  it('is nothing at all until the user moves something', async () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    const store = memoryLayoutStore();
    render(<CableEditor design={design} db={db} layout={store} />);
    await new Promise((resolve) => setTimeout(resolve, POSITION_SAVE_DEBOUNCE_MS + 100));
    // an untouched canvas is today's auto-layout, not a person's arrangement:
    // storing it would freeze this design's look against every later change
    expect(store.positions(design.id)).toBeUndefined();
  });

});

describe('the panes', () => {
  it('opens with a splitter between each pair', () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    render(<CableEditor design={design} db={db} />);
    const bars = screen.getAllByRole('separator');
    expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
      'drag to resize the parts palette',
      'drag to resize the schematic preview',
      'drag to resize the inspector',
    ]);
    expect(bars[1]?.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('resizes from the keyboard, and resets on a double-click', () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    const { container } = render(<CableEditor design={design} db={db} />);
    const body = container.querySelector('.cs-body') as HTMLElement;
    const palette = screen.getAllByRole('separator')[0] as HTMLElement;

    expect(body.style.gridTemplateColumns).toContain(`${DEFAULT_PANES.palette}px`);
    fireEvent.keyDown(palette, { key: 'ArrowRight' });
    expect(body.style.gridTemplateColumns).toContain(
      `${DEFAULT_PANES.palette + PANE_KEY_STEP}px`,
    );

    fireEvent.doubleClick(palette);
    expect(body.style.gridTemplateColumns).toContain(`${DEFAULT_PANES.palette}px`);
  });

  it('opens at the sizes the host remembers', () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    const store = memoryLayoutStore();
    store.savePanes({ palette: 190, side: 400, dock: 520 });
    const { container } = render(<CableEditor design={design} db={db} layout={store} />);
    const body = container.querySelector('.cs-body') as HTMLElement;
    expect(body.style.gridTemplateColumns).toContain('190px');
    expect(body.style.gridTemplateColumns).toContain('400px');
    expect((container.querySelector('.cs-dock') as HTMLElement).style.flex).toContain('520px');
  });
});

describe('the canvas overview', () => {
  it('is drawn in the editor’s own colours, not React Flow’s white default', () => {
    const design = loadDesignFromDisk('de9-terminal-board');
    const { container } = render(<CableEditor design={design} db={db} />);
    const minimap = container.querySelector('.react-flow__minimap');
    expect(minimap).not.toBeNull();
    expect(minimap?.classList.contains('cs-minimap')).toBe(true);
  });
});
