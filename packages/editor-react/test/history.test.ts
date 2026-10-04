/**
 * Undo/redo.
 *
 * History is a consequence of the store's one rule rather than a feature beside
 * it: `commit` is the only door into `state.design`, so it is the only writer of
 * the stack, and every entry is a document the validator already accepted. These
 * tests hold that line — a refused edit leaves no trace, a node drag is not an
 * edit, the stack is bounded, and switching documents starts a fresh history.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { terminalKey, terminalsOf, type Db, type TerminalRef } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  HISTORY_LIMIT,
  editorReducer,
  exportDesignJson,
  initialEditorState,
  redoDescription,
  undoDescription,
  type EditorState,
} from '../src/store.ts';

const db: Db = loadDb();
const DESIGN = 'rs485-de9-terminal-board';

function stateFor(id: string = DESIGN): EditorState {
  return initialEditorState(loadDesign(id as never), db);
}

/** A terminal of `instanceId` that nothing is soldered to yet. */
function freeTerminal(state: EditorState, instanceId: string): TerminalRef {
  const used = new Set(
    state.design.joints.flatMap((joint) => [terminalKey(joint.a), terminalKey(joint.b)]),
  );
  const free = terminalsOf(state.design, state.db, instanceId).find(
    (terminal) => !used.has(terminal.key),
  );
  if (free === undefined) throw new Error(`no free terminal on ${instanceId}`);
  return free.end === undefined
    ? { instance: free.instance, terminal: free.terminal }
    : { instance: free.instance, terminal: free.terminal, end: free.end };
}

/* ------------------------------------------------------------------ *
 * Push · undo · redo
 * ------------------------------------------------------------------ */

describe('history over committed designs', () => {
  it('starts empty — nothing to undo before the first edit', () => {
    const state = stateFor();
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(undoDescription(state)).toBeUndefined();
    expect(redoDescription(state)).toBeUndefined();
    // and undoing nothing is a no-op, not a crash
    expect(editorReducer(state, { type: 'undo' })).toBe(state);
    expect(editorReducer(state, { type: 'redo' })).toBe(state);
  });

  it('pushes the design an accepted edit replaced, labelled with that edit', () => {
    const before = stateFor();
    const after = editorReducer(before, {
      type: 'add-instance',
      kind: 'connector',
      def: 'rca-male',
    });

    expect(after.rejection).toBeUndefined();
    expect(after.past).toHaveLength(1);
    expect(after.past[0]?.design).toBe(before.design);
    expect(undoDescription(after)).toBe('add connector rca-male as j2');
    expect(after.future).toEqual([]);
  });

  it('undo restores the exact previous document and redo puts it back', () => {
    const start = stateFor();
    const added = editorReducer(start, {
      type: 'add-instance',
      kind: 'connector',
      def: 'rca-male',
    });
    const undone = editorReducer(added, { type: 'undo' });

    expect(undone.design).toBe(start.design);
    expect(exportDesignJson(undone.design)).toBe(exportDesignJson(start.design));
    expect(undone.past).toEqual([]);
    expect(redoDescription(undone)).toBe('add connector rca-male as j2');
    expect(undone.lastAccepted).toBe('undo add connector rca-male as j2');

    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.design).toBe(added.design);
    expect(undoDescription(redone)).toBe('add connector rca-male as j2');
    expect(redone.future).toEqual([]);
    expect(redone.lastAccepted).toBe('redo add connector rca-male as j2');
  });

  it('keeps `issues` describing the design it restores', () => {
    const start = stateFor();
    const joint = editorReducer(start, {
      type: 'add-joint',
      a: freeTerminal(start, 'j1'),
      b: freeTerminal(start, 'w1'),
    });
    const undone = editorReducer(joint, { type: 'undo' });
    expect(undone.issues).toEqual(start.issues);
    expect(undone.selection).toBeUndefined();
  });

  it('walks back through several edits in order, newest first', () => {
    let state = stateFor();
    for (const def of ['rca-male', 'rca-male', 'rca-male']) {
      state = editorReducer(state, { type: 'add-instance', kind: 'connector', def });
    }
    expect(state.past.map((entry) => entry.description)).toEqual([
      'add connector rca-male as j2',
      'add connector rca-male as j3',
      'add connector rca-male as j4',
    ]);

    const ids = (): string[] => state.design.instances.connectors.map((item) => item.id);
    expect(ids()).toEqual(['j1', 'j2', 'j3', 'j4']);
    state = editorReducer(state, { type: 'undo' });
    expect(ids()).toEqual(['j1', 'j2', 'j3']);
    state = editorReducer(state, { type: 'undo' });
    expect(ids()).toEqual(['j1', 'j2']);
    state = editorReducer(state, { type: 'redo' });
    expect(ids()).toEqual(['j1', 'j2', 'j3']);
  });

});

/* ------------------------------------------------------------------ *
 * What never enters the stack
 * ------------------------------------------------------------------ */

describe('what history refuses to record', () => {
  it('a rejected edit — the stack holds none but validated states', () => {
    const start = stateFor();
    const one = editorReducer(start, {
      type: 'add-instance',
      kind: 'connector',
      def: 'rca-male',
    });

    // every flavour of refusal: an unknown target, a self-joint, a duplicate
    // joint, an out-of-range index, and a candidate the validator rejects
    const refusals: EditorState[] = [
      editorReducer(one, { type: 'delete-instance', id: 'nope' }),
      editorReducer(one, {
        type: 'add-joint',
        a: freeTerminal(one, 'j1'),
        b: freeTerminal(one, 'j1'),
      }),
      editorReducer(one, { type: 'delete-joint', index: 999 }),
      editorReducer(one, { type: 'update-instance', id: 'nope', patch: { note: 'x' } }),
      editorReducer(one, { type: 'import-json', json: '{"schemaVersion":1}' }),
    ];

    for (const state of refusals) {
      expect(state.rejection).toBeDefined();
      expect(state.design).toBe(one.design);
      expect(state.past).toBe(one.past);
      expect(state.past).toHaveLength(1);
      expect(state.future).toBe(one.future);
    }
  });

  it('a rejected joint between two live terminals', () => {
    const start = stateFor();
    const existing = start.design.joints[0];
    expect(existing).toBeDefined();
    if (existing === undefined) return;
    // re-soldering an existing joint is refused before it ever reaches `commit`
    const again = editorReducer(start, { type: 'add-joint', a: existing.a, b: existing.b });
    expect(again.rejection).toBeDefined();
    expect(again.past).toEqual([]);
  });

  it('a node drag — positions are presentation, not a fact about the cable', () => {
    const start = stateFor();
    const moved = editorReducer(start, {
      type: 'move-node',
      id: 'j1',
      position: { x: 400, y: 120 },
    });
    expect(moved.positions['j1']).toEqual({ x: 400, y: 120 });
    expect(moved.past).toEqual([]);
    expect(moved.future).toEqual([]);
  });

  it('undo leaves positions where the user put them', () => {
    let state = stateFor();
    state = editorReducer(state, { type: 'move-node', id: 'j1', position: { x: 9, y: 9 } });
    state = editorReducer(state, { type: 'add-instance', kind: 'connector', def: 'rca-male' });
    const undone = editorReducer(state, { type: 'undo' });
    expect(undone.positions['j1']).toEqual({ x: 9, y: 9 });
  });

  it('selection alone is not an edit', () => {
    const state = editorReducer(stateFor(), {
      type: 'select',
      selection: { kind: 'instance', id: 'j1' },
    });
    expect(state.past).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The bound
 * ------------------------------------------------------------------ */

describe('the history cap', () => {
  it(`keeps the newest ${HISTORY_LIMIT} steps and drops the oldest`, () => {
    let state = stateFor();
    const steps = HISTORY_LIMIT + 5;
    for (let n = 1; n <= steps; n += 1) {
      state = editorReducer(state, {
        type: 'update-instance',
        id: 'j1',
        patch: { note: `pass ${n}` },
      });
      expect(state.rejection).toBeUndefined();
    }

    expect(state.past).toHaveLength(HISTORY_LIMIT);
    // the surviving window is the newest one, in order
    const first = state.past[0]?.design.instances.connectors.find((item) => item.id === 'j1');
    expect(first?.note).toBe(`pass ${steps - HISTORY_LIMIT}`);
    const last = state.past[state.past.length - 1]?.design.instances.connectors.find(
      (item) => item.id === 'j1',
    );
    expect(last?.note).toBe(`pass ${steps - 1}`);

    // undoing the whole stack lands on the oldest state still remembered, not
    // on the original document — the dropped steps are gone, not corrupt
    for (let n = 0; n < HISTORY_LIMIT; n += 1) state = editorReducer(state, { type: 'undo' });
    expect(state.past).toEqual([]);
    const survivor = state.design.instances.connectors.find((item) => item.id === 'j1');
    expect(survivor?.note).toBe(`pass ${steps - HISTORY_LIMIT}`);
    expect(state.future).toHaveLength(HISTORY_LIMIT);
  });

  it('redo is bounded the same way', () => {
    let state = stateFor();
    for (let n = 1; n <= HISTORY_LIMIT + 3; n += 1) {
      state = editorReducer(state, {
        type: 'update-instance',
        id: 'j1',
        patch: { note: `pass ${n}` },
      });
    }
    for (let n = 0; n < HISTORY_LIMIT; n += 1) state = editorReducer(state, { type: 'undo' });
    for (let n = 0; n < HISTORY_LIMIT; n += 1) state = editorReducer(state, { type: 'redo' });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    expect(state.future).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Per-document history
 * ------------------------------------------------------------------ */

describe('history belongs to one document', () => {
  it('loading another design starts a fresh history', () => {
    const start = stateFor();
    const edited = editorReducer(start, {
      type: 'add-instance',
      kind: 'connector',
      def: 'rca-male',
    });
    expect(edited.past).toHaveLength(1);

    const other = editorReducer(edited, {
      type: 'load-design',
      design: loadDesign('db9-null-modem'),
    });
    expect(other.past).toEqual([]);
    expect(other.future).toEqual([]);
    expect(undoDescription(other)).toBeUndefined();

    // and coming back to the first design does not resurrect its steps
    const back = editorReducer(other, { type: 'load-design', design: edited.design });
    expect(back.past).toEqual([]);
    expect(back.design).toBe(edited.design);
  });

  it('an import is one undoable step, not a new document', () => {
    const start = stateFor();
    const other = loadDesign('db9-null-modem');
    const imported = editorReducer(start, {
      type: 'import-json',
      json: exportDesignJson(other),
    });

    expect(imported.rejection).toBeUndefined();
    expect(imported.design.id).toBe(other.id);
    expect(imported.past).toHaveLength(1);
    expect(undoDescription(imported)).toBe(`imported ${other.id}`);

    const undone = editorReducer(imported, { type: 'undo' });
    expect(undone.design).toBe(start.design);
    expect(editorReducer(undone, { type: 'redo' }).design.id).toBe(other.id);
  });
});
