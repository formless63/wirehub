/**
 * Artwork logic: the coordinate mapping, the anchoring state machine, the
 * mirror derivation, and the overlay that keeps the schematic honest.
 *
 * The mapping is the correctness-critical piece and is tested with concrete
 * numbers rather than round-trip identities alone. An anchor placed slightly
 * wrong does not *look* wrong — it looks like a pin that is nearly right — and
 * "nearly right" is the one thing a wiring document may not be.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_OVERLAY,
  IDENTITY_VIEW,
  ZOOM_RANGE,
  anchorAt,
  anchorProgress,
  anchorsDiffer,
  armTerminal,
  beginAnchoring,
  clampToFrame,
  clearAnchor,
  derivedAnchors,
  endDrag,
  fitScale,
  isAnchored,
  mirrorCounterpart,
  moveAnchor,
  nextUnanchored,
  overlayIsEmpty,
  overlaySource,
  overlayWith,
  panBy,
  placeArmed,
  placement,
  reflectAnchor,
  roundUnits,
  startDrag,
  toArtwork,
  toStage,
  unanchoredSentence,
  zoomAbout,
  type ArtworkTerminal,
  type DepictionMeta,
  type Frame,
  type PinAnchor,
  type Stage,
} from '../src/artwork.ts';
import type { DepictionSource } from '@wirehub/render-svg';

/** A 20 × 10 mm board in a 400 × 300 px box — deliberately not square. */
const FRAME: Frame = { widthUnits: 20, heightUnits: 10 };
const STAGE: Stage = { width: 400, height: 300 };

/* ------------------------------------------------------------------ *
 * The mapping
 * ------------------------------------------------------------------ */

describe('screen ↔ artwork, with the numbers written out', () => {
  it('fits by the tighter axis', () => {
    // 400/20 = 20 px per mm across, 300/10 = 30 down; the picture must fit, so 20
    expect(fitScale(FRAME, STAGE)).toBe(20);
    expect(fitScale({ widthUnits: 10, heightUnits: 30 }, STAGE)).toBe(10);
  });

  it('centres the picture at rest', () => {
    const place = placement(FRAME, STAGE, IDENTITY_VIEW);
    expect(place.scale).toBe(20);
    // 20 mm × 20 px/mm = 400 px wide, exactly the stage: no slack across
    expect(place.offsetX).toBe(0);
    // 10 mm × 20 = 200 px tall in a 300 px box: 50 px of letterbox each side
    expect(place.offsetY).toBe(50);
  });

  it('puts a known artwork point at a known pixel', () => {
    const place = placement(FRAME, STAGE, IDENTITY_VIEW);
    expect(toStage({ x: 0, y: 0 }, place)).toEqual({ x: 0, y: 50 });
    expect(toStage({ x: 20, y: 10 }, place)).toEqual({ x: 400, y: 250 });
    // a pad 5 mm in and 2.5 mm down
    expect(toStage({ x: 5, y: 2.5 }, place)).toEqual({ x: 100, y: 100 });
  });

  it('reads a click back to the millimetre it landed on', () => {
    const place = placement(FRAME, STAGE, IDENTITY_VIEW);
    expect(toArtwork({ x: 100, y: 100 }, place)).toEqual({ x: 5, y: 2.5 });
    expect(toArtwork({ x: 0, y: 50 }, place)).toEqual({ x: 0, y: 0 });
  });

  it('is exactly invertible at any zoom and pan', () => {
    for (const view of [
      IDENTITY_VIEW,
      { zoom: 3.5, panX: -120, panY: 44 },
      { zoom: 0.4, panX: 210, panY: -73 },
      { zoom: 17, panX: 5, panY: 5 },
    ]) {
      const place = placement(FRAME, STAGE, view);
      for (const point of [
        { x: 0, y: 0 },
        { x: 7.3, y: 1.1 },
        { x: 20, y: 10 },
      ]) {
        const back = toArtwork(toStage(point, place), place);
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it('scales and shifts by zoom and pan, in that order', () => {
    // 4× the fit is 80 px per mm; the 1600 px-wide picture overhangs a 400 px
    // stage by 600 px each side, and the pan slides it another 30 px right
    const place = placement(FRAME, STAGE, { zoom: 4, panX: 30, panY: 0 });
    expect(place.scale).toBe(80);
    expect(place.offsetX).toBe(30 + (400 - 1600) / 2);
    expect(toStage({ x: 10, y: 5 }, place)).toEqual({ x: 30 + 200, y: 150 });
  });

  it('holds the artwork point under the cursor still while zooming', () => {
    const cursor = { x: 275, y: 190 };
    let view = IDENTITY_VIEW;
    const held = toArtwork(cursor, placement(FRAME, STAGE, view));
    for (const factor of [1.2, 1.2, 1.2, 0.5, 2.4]) {
      view = zoomAbout(view, cursor, factor, FRAME, STAGE);
      const now = toArtwork(cursor, placement(FRAME, STAGE, view));
      expect(now.x).toBeCloseTo(held.x, 9);
      expect(now.y).toBeCloseTo(held.y, 9);
    }
  });

  it('holds it still even when the zoom clamp bites', () => {
    const cursor = { x: 40, y: 40 };
    const view = zoomAbout({ zoom: 19, panX: 0, panY: 0 }, cursor, 8, FRAME, STAGE);
    expect(view.zoom).toBe(ZOOM_RANGE.max);
    const zoomedOut = zoomAbout(view, cursor, 0.001, FRAME, STAGE);
    expect(zoomedOut.zoom).toBe(ZOOM_RANGE.min);
    // the point under the cursor is the same one it was before the clamp
    const before = toArtwork(cursor, placement(FRAME, STAGE, view));
    const after = toArtwork(cursor, placement(FRAME, STAGE, zoomedOut));
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('pans by whole pixels of drag', () => {
    expect(panBy({ zoom: 2, panX: 5, panY: 5 }, -30, 12)).toEqual({
      zoom: 2,
      panX: -25,
      panY: 17,
    });
  });

  it('clamps a click outside the picture back onto it', () => {
    expect(clampToFrame({ x: -3, y: 40 }, FRAME)).toEqual({ x: 0, y: 10 });
    expect(clampToFrame({ x: 999, y: -1 }, FRAME)).toEqual({ x: 20, y: 0 });
  });

  it('stores two decimals, and never a negative zero', () => {
    expect(roundUnits(3.14159)).toBe(3.14);
    expect(roundUnits(-0.0001)).toBe(0);
    expect(Object.is(roundUnits(-0.0001), -0)).toBe(false);
  });

  it('turns a pixel click straight into a storable anchor', () => {
    const place = placement(FRAME, STAGE, { zoom: 4, panX: 0, panY: 0 });
    // stage centre is the artwork centre at any zoom, because the picture is centred
    expect(anchorAt({ x: 200, y: 150 }, FRAME, place)).toEqual({ x: 10, y: 5 });
  });

  it('survives a stage that has not been measured yet', () => {
    const place = placement(FRAME, { width: 0, height: 0 }, IDENTITY_VIEW);
    expect(Number.isFinite(place.scale)).toBe(true);
    expect(Number.isFinite(toArtwork({ x: 10, y: 10 }, place).x)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The mirror rule
 * ------------------------------------------------------------------ */

describe('the derived view is computed, never entered', () => {
  it('pairs each view with the side opposite it', () => {
    expect(mirrorCounterpart('mating-face')).toBe('solder-side');
    expect(mirrorCounterpart('solder-side')).toBe('mating-face');
    expect(mirrorCounterpart('board-top')).toBe('board-bottom');
    expect(mirrorCounterpart('illustration')).toBeUndefined();
  });

  it('reflects across the vertical centre line for x — what flipping a board does', () => {
    expect(reflectAnchor({ x: 3, y: 4 }, 'x', FRAME)).toEqual({ x: 17, y: 4 });
    expect(reflectAnchor({ x: 3, y: 4 }, 'y', FRAME)).toEqual({ x: 3, y: 6 });
    // the note travels with the anchor: it is provenance, not geometry
    expect(reflectAnchor({ x: 0, y: 0, note: 'pad 1 of 3' }, 'x', FRAME)).toEqual({
      x: 20,
      y: 0,
      note: 'pad 1 of 3',
    });
  });

  it('recomputes the whole derived set from the authored frame', () => {
    const authored = { '1': { x: 2, y: 1 }, '2': { x: 5, y: 1 }, '3': { x: 18, y: 9 } };
    expect(derivedAnchors(authored, 'x', FRAME)).toEqual({
      '1': { x: 18, y: 1 },
      '2': { x: 15, y: 1 },
      '3': { x: 2, y: 9 },
    });
  });

  it('is its own inverse, so nothing drifts as the user keeps editing', () => {
    const authored = { a: { x: 1.37, y: 8.02 }, b: { x: 19.9, y: 0.1 } };
    expect(derivedAnchors(derivedAnchors(authored, 'x', FRAME), 'x', FRAME)).toEqual(authored);
  });

  it('follows the authored set as it grows, one pin at a time', () => {
    let state = beginAnchoring({});
    state = armTerminal(state, 'p1');
    state = placeArmed(state, { x: 4, y: 2 }, [{ id: 'p1' }, { id: 'p2' }]);
    expect(derivedAnchors(state.anchors, 'x', FRAME)).toEqual({ p1: { x: 16, y: 2 } });
    state = placeArmed(state, { x: 6, y: 3 }, [{ id: 'p1' }, { id: 'p2' }]);
    expect(derivedAnchors(state.anchors, 'x', FRAME)).toEqual({
      p1: { x: 16, y: 2 },
      p2: { x: 14, y: 3 },
    });
  });
});

/* ------------------------------------------------------------------ *
 * The anchoring state machine
 * ------------------------------------------------------------------ */

const TERMINALS: ArtworkTerminal[] = [
  { id: '1', label: 'DATA' },
  { id: '2', label: 'GND', aliases: ['ground'] },
  { id: '3', label: '+5V' },
];

describe('click a pin, click the picture', () => {
  it('does nothing at all when a click lands with nothing armed', () => {
    const state = beginAnchoring({});
    expect(placeArmed(state, { x: 1, y: 1 }, TERMINALS)).toBe(state);
  });

  it('places the armed pin and arms the next one still waiting', () => {
    let state = armTerminal(beginAnchoring({}), '1');
    expect(state.armed).toBe('1');
    state = placeArmed(state, { x: 3, y: 4 }, TERMINALS);
    expect(state.anchors).toEqual({ '1': { x: 3, y: 4 } });
    expect(state.armed).toBe('2');
    state = placeArmed(state, { x: 5, y: 6 }, TERMINALS);
    state = placeArmed(state, { x: 7, y: 8 }, TERMINALS);
    // three pins, three clicks, and nothing left armed
    expect(Object.keys(state.anchors).sort()).toEqual(['1', '2', '3']);
    expect(state.armed).toBeUndefined();
  });

  it('arming the armed pin puts it down again', () => {
    const state = armTerminal(armTerminal(beginAnchoring({}), '2'), '2');
    expect(state.armed).toBeUndefined();
  });

  it('counts a pin as done when any of its aliases is anchored', () => {
    const anchors: Record<string, PinAnchor> = { ground: { x: 1, y: 1 } };
    expect(isAnchored(TERMINALS[1] as ArtworkTerminal, anchors)).toBe(true);
    expect(isAnchored(TERMINALS[0] as ArtworkTerminal, anchors)).toBe(false);
    expect(anchorProgress(TERMINALS, anchors).todo).toEqual(['1', '3']);
  });

  it('reports the checklist, and knows when it is finished', () => {
    const none = anchorProgress(TERMINALS, {});
    expect(none.todo).toEqual(['1', '2', '3']);
    expect(none.complete).toBe(false);
    const all = anchorProgress(TERMINALS, {
      '1': { x: 0, y: 0 },
      '2': { x: 0, y: 0 },
      '3': { x: 0, y: 0 },
    });
    expect(all.complete).toBe(true);
    expect(all.todo).toEqual([]);
  });

  it('notices anchors that no longer name anything on the part', () => {
    const progress = anchorProgress(TERMINALS, { '1': { x: 0, y: 0 }, '99': { x: 0, y: 0 } });
    expect(progress.stray).toEqual(['99']);
  });

  it('walks the list and wraps exactly once', () => {
    expect(nextUnanchored(TERMINALS, {})).toBe('1');
    expect(nextUnanchored(TERMINALS, { '1': { x: 0, y: 0 } }, '1')).toBe('2');
    // after the last one, wrap round to the first still waiting
    expect(nextUnanchored(TERMINALS, { '2': { x: 0, y: 0 }, '3': { x: 0, y: 0 } }, '3')).toBe('1');
    expect(
      nextUnanchored(TERMINALS, {
        '1': { x: 0, y: 0 },
        '2': { x: 0, y: 0 },
        '3': { x: 0, y: 0 },
      }),
    ).toBeUndefined();
    expect(nextUnanchored([], {})).toBeUndefined();
  });

  it('moves an anchor by dragging it, keeping its note', () => {
    let state = beginAnchoring({ '1': { x: 1, y: 1, note: 'the left pad' } });
    state = startDrag(state, '1');
    expect(state.dragging).toBe('1');
    state = moveAnchor(state, '1', { x: 9, y: 2 });
    expect(state.anchors['1']).toEqual({ x: 9, y: 2, note: 'the left pad' });
    state = endDrag(state);
    expect(state.dragging).toBeUndefined();
  });

  it('refuses to drag or move something that was never placed', () => {
    const state = beginAnchoring({});
    expect(startDrag(state, 'nope').dragging).toBeUndefined();
    expect(moveAnchor(state, 'nope', { x: 1, y: 1 })).toBe(state);
  });

  it('taking an anchor off re-arms that pin', () => {
    const state = clearAnchor(beginAnchoring({ '2': { x: 1, y: 1 } }), '2');
    expect(state.anchors).toEqual({});
    expect(state.armed).toBe('2');
  });

  it('knows when the working set says something the stored one does not', () => {
    const stored = { '1': { x: 1, y: 1 } };
    expect(anchorsDiffer({ '1': { x: 1, y: 1 } }, stored)).toBe(false);
    expect(anchorsDiffer({ '1': { x: 1, y: 2 } }, stored)).toBe(true);
    expect(anchorsDiffer({}, stored)).toBe(true);
    expect(anchorsDiffer({ '1': { x: 1, y: 1 }, '2': { x: 0, y: 0 } }, stored)).toBe(true);
    expect(anchorsDiffer({ '1': { x: 1, y: 1, note: 'new' } }, stored)).toBe(true);
  });

  it('says what the missing anchors cost, in a builder’s words', () => {
    expect(unanchoredSentence(anchorProgress(TERMINALS, {}), 'DE-9 male')).toContain(
      'plain pin table',
    );
    expect(
      unanchoredSentence(anchorProgress(TERMINALS, { '1': { x: 0, y: 0 } }), 'DE-9 male'),
    ).toContain('2 of 3 pins');
    expect(
      unanchoredSentence(
        anchorProgress(TERMINALS, {
          '1': { x: 0, y: 0 },
          '2': { x: 0, y: 0 },
          '3': { x: 0, y: 0 },
        }),
        'DE-9 male',
      ),
    ).toBeUndefined();
  });

  it('counts only the pins cables solder to, when the host says which', () => {
    const none = anchorProgress(TERMINALS, {});
    expect(unanchoredSentence(none, 'DE-9 male', {})).toBeUndefined();
    const one = unanchoredSentence(none, 'DE-9 male', { '2': ['a-cable'] });
    expect(one).toContain('One pin that designs solder to has no spot yet (2)');
    expect(one).toContain('that design draws the pin table');
    expect(unanchoredSentence(none, 'DE-9 male', { '1': ['x', 'y'], '3': ['y'] })).toContain('2 pins that designs solder to have no spot yet (1, 3) — those 2 designs');
  });
});

/* ------------------------------------------------------------------ *
 * The overlay
 * ------------------------------------------------------------------ */

const META: DepictionMeta = {
  defId: 'demo-part',
  views: {
    'board-top': { file: 'board-top.svg', kind: 'vector', mmPerUnit: 1, sourceKind: 'svg', src: 'x' },
  },
  pinAnchors: { '1': { x: 1, y: 1 } },
  anchorFrame: 'board-top',
  src: 'test',
};

describe('artwork uploaded since the page loaded', () => {
  it('starts out empty and stays out of the way', () => {
    expect(overlayIsEmpty(EMPTY_OVERLAY)).toBe(true);
    const base: DepictionSource = {
      meta: (defId) => (defId === 'bundled' ? META : undefined),
      artwork: () => ({ kind: 'vector', source: '<svg/>' }),
    };
    const source = overlaySource(base, EMPTY_OVERLAY);
    expect(source.meta('bundled')).toBe(META);
    expect(source.meta('demo-part')).toBeUndefined();
  });

  it('answers for a definition the bundle has never heard of', () => {
    const overlay = overlayWith(EMPTY_OVERLAY, 'demo-part', META, {
      'board-top': { kind: 'vector', source: '<svg id="fresh"/>' },
    });
    expect(overlayIsEmpty(overlay)).toBe(false);
    const source = overlaySource(undefined, overlay);
    expect(source.meta('demo-part')).toBe(META);
    expect(source.artwork('demo-part', 'board-top')?.source).toContain('fresh');
  });

  it('wins over the bundle for what it holds, and defers for what it does not', () => {
    const base: DepictionSource = {
      meta: () => ({ ...META, src: 'from the bundle' }),
      artwork: (_defId, view) => ({ kind: 'vector', source: `<svg data-view="${view}"/>` }),
    };
    const overlay = overlayWith(EMPTY_OVERLAY, 'demo-part', META, {
      'board-top': { kind: 'vector', source: '<svg id="fresh"/>' },
    });
    const source = overlaySource(base, overlay);
    expect(source.meta('demo-part')?.src).toBe('test');
    expect(source.artwork('demo-part', 'board-top')?.source).toContain('fresh');
    // a view the overlay has no bytes for still draws whatever shipped
    expect(source.artwork('demo-part', 'illustration')?.source).toContain('illustration');
    // and a definition it knows nothing about is left entirely to the bundle
    expect(source.artwork('other-part', 'board-top')?.source).toContain('board-top');
  });

  it('accumulates across several saves without losing the earlier ones', () => {
    let overlay = overlayWith(EMPTY_OVERLAY, 'a', META, {
      'board-top': { kind: 'vector', source: 'A' },
    });
    overlay = overlayWith(overlay, 'b', { ...META, defId: 'b' }, {
      'board-top': { kind: 'vector', source: 'B' },
    });
    const source = overlaySource(undefined, overlay);
    expect(source.artwork('a', 'board-top')?.source).toBe('A');
    expect(source.artwork('b', 'board-top')?.source).toBe('B');
  });
});
