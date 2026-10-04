/**
 * The arrangement is the user's, and nothing but the user may move it
 *.
 *
 * The rule under every test here: **auto-layout happens once**, the first time
 * a design is opened by someone who has never arranged it — or when the user
 * asks for it by name. A save, a reload of the same document, an undo, a
 * definition library swap and a trip to another design and back are all things
 * that must leave the parts exactly where they were put.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { autoLayout } from '../src/derive.ts';
import { memoryLayoutStore } from '../src/layout-store.ts';
import { editorReducer, initialEditorState, type EditorState } from '../src/store.ts';

const db: Db = loadDb();
const OPEN = 'de9-terminal-board';
const OTHER = 'de9-crossover';

function stateFor(id: string): EditorState {
  return initialEditorState(loadDesign(id as never), db);
}

/** the arrangement after someone dragged one part somewhere memorable */
function dragged(state: EditorState, id: string): EditorState {
  return editorReducer(state, { type: 'move-node', id, position: { x: 4242, y: -1337 } });
}

describe('first open', () => {
  it('auto-arranges a design nobody has arranged', () => {
    const design = loadDesign(OPEN);
    expect(initialEditorState(design, db).positions).toEqual(autoLayout(design, db).positions);
  });

  it('uses the host’s remembered arrangement instead, when it has one', () => {
    const design = loadDesign(OPEN);
    const remembered = { j1: { x: 11, y: 22 } };
    const state = initialEditorState(design, db, remembered);
    expect(state.positions).toEqual(remembered);
    expect(state.positions).not.toEqual(autoLayout(design, db).positions);
  });
});

describe('a dragged part stays where it was put', () => {
  it('through the save round-trip — the host handing its own design back', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const saved = editorReducer(moved, { type: 'load-design', design: moved.design });
    expect(saved.positions['j1']).toEqual({ x: 4242, y: -1337 });
    expect(saved.positions).toEqual(moved.positions);
  });

  it('when the host hands back a re-read copy of the same design', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    // a fresh object with the same id: a reload, a save, a revert
    const copy = JSON.parse(JSON.stringify(moved.design)) as CableDesign;
    const reloaded = editorReducer(moved, { type: 'load-design', design: copy });
    expect(reloaded.design).not.toBe(moved.design);
    expect(reloaded.positions['j1']).toEqual({ x: 4242, y: -1337 });
  });

  it('through an undo, and through the edit it undoes', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const edited = editorReducer(moved, {
      type: 'add-instance',
      kind: 'connector',
      def: 'jst-xh-2-dc',
      position: { x: 0, y: 0 },
    });
    expect(edited.positions['j1']).toEqual({ x: 4242, y: -1337 });
    const undone = editorReducer(edited, { type: 'undo' });
    expect(undone.design).toEqual(moved.design);
    expect(undone.positions['j1']).toEqual({ x: 4242, y: -1337 });
  });

  it('through a definition library swap', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const swapped = editorReducer(moved, { type: 'load-db', db });
    expect(swapped.positions).toEqual(moved.positions);
  });

  it('and comes back when the user opens another design and returns', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const away = editorReducer(moved, { type: 'load-design', design: loadDesign(OTHER) });
    expect(away.positions).toEqual(autoLayout(loadDesign(OTHER), db).positions);
    const back = editorReducer(away, { type: 'load-design', design: loadDesign(OPEN) });
    expect(back.positions['j1']).toEqual({ x: 4242, y: -1337 });
  });
});

describe('auto-layout happens once', () => {
  it('never on a design the editor already has an arrangement for', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const auto = autoLayout(moved.design, db).positions;
    for (const design of [moved.design, JSON.parse(JSON.stringify(moved.design)) as CableDesign]) {
      const next = editorReducer(moved, { type: 'load-design', design });
      expect(next.positions).not.toEqual(auto);
    }
  });

  it('and the host’s arrangement wins over the editor’s own', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const away = editorReducer(moved, { type: 'load-design', design: loadDesign(OTHER) });
    const back = editorReducer(away, {
      type: 'load-design',
      design: loadDesign(OPEN),
      positions: { j1: { x: 1, y: 2 } },
    });
    expect(back.positions).toEqual({ j1: { x: 1, y: 2 } });
  });

  it('or when the user asks for it by name', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const arranged = editorReducer(moved, { type: 'auto-arrange' });
    expect(arranged.positions).toEqual(autoLayout(moved.design, db).positions);
    expect(arranged.design).toBe(moved.design);
    expect(arranged.lastAccepted).toMatch(/auto-arrange/);
    // not a design edit, but undoable as a move (udy.10): one entry, the design unchanged
    expect(arranged.past.slice(0, -1)).toEqual(moved.past);
    expect(arranged.past.at(-1)).toMatchObject({ design: moved.design, description: 'auto-arrange', positions: moved.positions });
  });
});

describe('a part added from the palette', () => {
  it('is placed clear of everything already on the canvas', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    const added = editorReducer(moved, {
      type: 'add-instance',
      kind: 'connector',
      def: 'jst-xh-2-dc',
    });
    const spot = added.positions['j2'];
    expect(spot).toBeDefined();
    for (const [id, other] of Object.entries(added.positions)) {
      if (id === 'j2') continue;
      expect(spot).not.toEqual(other);
    }
  });

  it('lands exactly where it was dropped, when it was dropped', () => {
    const state = stateFor(OPEN);
    const added = editorReducer(state, {
      type: 'add-instance',
      kind: 'connector',
      def: 'jst-xh-2-dc',
      position: { x: 12, y: 34 },
    });
    expect(added.positions['j2']).toEqual({ x: 12, y: 34 });
  });
});

describe('the layouts the editor remembers', () => {
  it('are keyed by design id, and always include the open one', () => {
    const moved = dragged(stateFor(OPEN), 'j1');
    expect(moved.layouts[OPEN]).toEqual(moved.positions);
    const away = editorReducer(moved, { type: 'load-design', design: loadDesign(OTHER) });
    expect(away.layouts[OPEN]?.['j1']).toEqual({ x: 4242, y: -1337 });
    expect(away.layouts[OTHER]).toEqual(away.positions);
  });
});

describe('the memory layout store', () => {
  it('answers with what it was told, and with nothing for an unknown design', () => {
    const store = memoryLayoutStore();
    expect(store.positions(OPEN)).toBeUndefined();
    expect(store.panes()).toBeUndefined();
    store.savePositions(OPEN, { j1: { x: 3, y: 4 } });
    expect(store.positions(OPEN)).toEqual({ j1: { x: 3, y: 4 } });
    expect(store.positions(OTHER)).toBeUndefined();
  });
});
