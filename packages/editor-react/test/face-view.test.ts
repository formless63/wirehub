/**
 * The connector face view: a dense face (HD15's 15 pins in 3 rows) is enlarged so every pin has a
 * 16 px target, the toggle is presentation state that auto-arrange measures, and a tall face's
 * thumbnail keeps its shape.
 */

import { describe, expect, it } from 'vitest';

import { MIN_PIN_PITCH, closestPins, denseFace, scalePath, type ConnectorArt } from '../src/connector-art.ts';
import { autoLayout, deriveNodes } from '../src/derive.ts';
import { estimateNodeSize } from '../src/layout-size.ts';
import { editorReducer, initialEditorState } from '../src/store.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db = loadDbFromDisk();

/** An HD15-like face: three rows of five pins, 5.5 px between centres. */
function hd15(): ConnectorArt {
  const pins = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 5; col += 1) pins.push({ terminal: String(row * 5 + col + 1), form: 'pin' as const, x: 10 + col * 5.5, y: 8 + row * 5.5, r: 1.4 });
  }
  return {
    defId: 'hd15',
    view: 'face',
    short: 'HD-15',
    width: 40,
    height: 28,
    shapes: [
      { el: 'path', d: 'M2 2 H38 A4 4 0 0 1 42 6 V22 L36 26 H4 Z', tone: 'shell' },
      { el: 'rect', x: 4, y: 4, width: 30, height: 20, rx: 2, tone: 'insert' },
      { el: 'circle', cx: 6, cy: 14, r: 1.5, tone: 'hole' },
    ],
    pins,
    labels: [{ x: 10, y: 6, text: '1', anchor: 'middle' }],
    approximate: false,
  };
}

describe('a dense face', () => {
  it('is enlarged until no two pins are closer than 16 px', () => {
    const art = hd15();
    expect(closestPins(art)).toBeCloseTo(5.5, 5);
    const roomy = denseFace(art);
    expect(closestPins(roomy)!).toBeGreaterThanOrEqual(MIN_PIN_PITCH - 0.01);
    expect(roomy.width).toBeGreaterThan(art.width);
    // the labels and the drawing moved with the pins
    expect(roomy.labels[0]!.x).toBeCloseTo(10 * (MIN_PIN_PITCH / 5.5), 0);
    expect(roomy.shapes[2]).toMatchObject({ el: 'circle' });
  });

  it('leaves a roomy face alone', () => {
    const art = { ...hd15(), pins: hd15().pins.map((p, i) => ({ ...p, x: (i % 5) * 20, y: Math.floor(i / 5) * 20 })) };
    expect(denseFace(art)).toBe(art);
  });

  it('scales a path, leaving an arc’s rotation and flags alone', () => {
    expect(scalePath('M2 2 H38 A4 4 0 0 1 42 6 V22 Z', 2)).toBe('M 4 4 H 76 A 8 8 0 0 1 84 12 V 44 Z');
  });
});

describe('the face toggle', () => {
  const design = loadDesignFromDisk('de9-crossover');

  it('is presentation state: it changes no design, makes no undo step, and the node follows', () => {
    const state = initialEditorState(design, db);
    const shown = editorReducer(state, { type: 'set-face', id: 'j1', on: true });
    expect(shown.design).toBe(state.design);
    expect(shown.past).toEqual(state.past);
    expect(shown.faces).toEqual(['j1']);
    const flow = (faces: readonly string[]) => deriveNodes(design, db, { positions: state.positions, faces }).find((n) => n.id === 'j1')!;
    expect(flow([]).data).not.toHaveProperty('face');
    expect(flow(['j1']).data).toMatchObject({ kind: 'connector', face: true });
    const hidden = editorReducer(shown, { type: 'set-face', id: 'j1', on: false });
    expect(hidden.faces).toEqual([]);
  });

  it('is known to auto-arrange: the node reserves the face’s room', () => {
    const list = estimateNodeSize(deriveNodes(design, db, {}).find((n) => n.id === 'j1')!.data);
    const face = estimateNodeSize(deriveNodes(design, db, { faces: ['j1'] }).find((n) => n.id === 'j1')!.data);
    expect(face).not.toEqual(list);
    const withFace = autoLayout(design, db, undefined, ['j1']).positions;
    const without = autoLayout(design, db).positions;
    expect(Object.keys(withFace).sort()).toEqual(Object.keys(without).sort());
  });
});
