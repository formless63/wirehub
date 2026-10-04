/**
 * Pane sizes. The arithmetic is the whole risk: a
 * splitter that can hide a pane is worse than a pane that cannot move, because
 * there is no gesture that brings the hidden one back.
 */

import { describe, expect, it } from 'vitest';

import {
  CANVAS_MIN,
  DEFAULT_PANES,
  PANE_MIN,
  SPLITTER_SIZE,
  clampPane,
  isPaneSizes,
  paneColumns,
  paneLimit,
  paneSizesOf,
  resetPane,
  resizePane,
  type PaneSizes,
} from '../src/splitters.ts';

const WIDE = 1600;
const TALL = 900;

describe('clamping', () => {
  it('never lets a pane go below its floor', () => {
    for (const key of ['palette', 'side', 'dock'] as const) {
      expect(clampPane(DEFAULT_PANES, key, -500, WIDE)).toBe(PANE_MIN[key]);
      expect(clampPane(DEFAULT_PANES, key, 0, WIDE)).toBe(PANE_MIN[key]);
    }
  });

  it('leaves the canvas its own floor, however far the pointer goes', () => {
    const palette = clampPane(DEFAULT_PANES, 'palette', 99999, WIDE);
    expect(palette).toBe(WIDE - DEFAULT_PANES.side - CANVAS_MIN.width - SPLITTER_SIZE * 2);
    const dock = clampPane(DEFAULT_PANES, 'dock', 99999, TALL);
    expect(dock).toBe(TALL - CANVAS_MIN.height - SPLITTER_SIZE);
  });

  it('imposes no ceiling before the container has been measured', () => {
    expect(paneLimit(DEFAULT_PANES, 'palette', 0)).toBe(Number.POSITIVE_INFINITY);
    expect(clampPane(DEFAULT_PANES, 'palette', 5000, 0)).toBe(5000);
    expect(clampPane(DEFAULT_PANES, 'palette', 5, 0)).toBe(PANE_MIN.palette);
  });

  it('rounds to whole pixels and survives nonsense', () => {
    expect(clampPane(DEFAULT_PANES, 'side', 300.4, WIDE)).toBe(300);
    expect(clampPane(DEFAULT_PANES, 'side', Number.NaN, WIDE)).toBe(DEFAULT_PANES.side);
  });

  it('never squeezes a pane below its floor even in a tiny window', () => {
    for (const available of [0, 100, 320, 700]) {
      for (const key of ['palette', 'side', 'dock'] as const) {
        expect(clampPane(DEFAULT_PANES, key, 10, available)).toBeGreaterThanOrEqual(
          PANE_MIN[key],
        );
      }
    }
  });
});

describe('resizing one pane', () => {
  it('moves that pane and no other', () => {
    const next = resizePane(DEFAULT_PANES, 'palette', 300, WIDE);
    expect(next.palette).toBe(300);
    expect(next.side).toBe(DEFAULT_PANES.side);
    expect(next.dock).toBe(DEFAULT_PANES.dock);
  });

  it('returns the same object when the size did not change', () => {
    expect(resizePane(DEFAULT_PANES, 'palette', DEFAULT_PANES.palette, WIDE)).toBe(
      DEFAULT_PANES,
    );
    // clamped to the floor it is already on
    expect(resizePane({ ...DEFAULT_PANES, side: PANE_MIN.side }, 'side', 10, WIDE).side).toBe(
      PANE_MIN.side,
    );
  });

  it('lets the preview grow to nearly the whole middle column', () => {
    const grown = resizePane(DEFAULT_PANES, 'dock', TALL, TALL);
    expect(grown.dock).toBeGreaterThan(TALL * 0.8);
    expect(grown.dock).toBeLessThan(TALL);
  });

  it('puts a pane back where the stylesheet had it', () => {
    const moved = resizePane(DEFAULT_PANES, 'dock', 700, TALL);
    expect(moved.dock).not.toBe(DEFAULT_PANES.dock);
    expect(resetPane(moved, 'dock', TALL)).toEqual(DEFAULT_PANES);
  });
});

describe('sizes read back from a host', () => {
  it('accepts three finite positive numbers and nothing else', () => {
    expect(isPaneSizes({ palette: 200, side: 300, dock: 250 })).toBe(true);
    expect(isPaneSizes({ palette: 200, side: 300 })).toBe(false);
    expect(isPaneSizes({ palette: 200, side: 300, dock: '250' })).toBe(false);
    expect(isPaneSizes({ palette: 200, side: 300, dock: Number.NaN })).toBe(false);
    expect(isPaneSizes({ palette: 0, side: 300, dock: 250 })).toBe(false);
    expect(isPaneSizes(null)).toBe(false);
    expect(isPaneSizes('248px')).toBe(false);
  });

  it('falls back to the defaults, and floors what it accepts', () => {
    expect(paneSizesOf(undefined)).toEqual(DEFAULT_PANES);
    expect(paneSizesOf({ nonsense: true })).toEqual(DEFAULT_PANES);
    const tiny: PaneSizes = { palette: 1, side: 1, dock: 1 };
    expect(paneSizesOf(tiny)).toEqual({
      palette: PANE_MIN.palette,
      side: PANE_MIN.side,
      dock: PANE_MIN.dock,
    });
  });
});

describe('the columns the body is given', () => {
  it('names the two splitters between the three panes', () => {
    expect(paneColumns({ palette: 200, side: 300, dock: 250 })).toBe(
      `200px ${SPLITTER_SIZE}px minmax(0, 1fr) ${SPLITTER_SIZE}px 300px`,
    );
  });
});
