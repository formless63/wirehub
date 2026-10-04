/**
 * The store. This is where the one architectural rule is enforced, so it is
 * tested hardest: **no path may change `state.design` without `validateDesign`
 * approving the whole candidate document.**
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import {
  errors,
  terminalKey,
  terminalsOf,
  validateDesign,
  type CableDesign,
  type Db,
  type TerminalRef,
} from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  commit,
  editorReducer,
  initialEditorState,
  jointIndexFor,
  nextInstanceId,
  type EditorState,
} from '../src/store.ts';
import { floatingEndNote } from '../src/panels/Notes.tsx';

const db: Db = loadDb();

function stateFor(id: string): EditorState {
  return initialEditorState(loadDesign(id as never), db);
}

function usedKeys(design: CableDesign): Set<string> {
  const keys = new Set<string>();
  for (const joint of design.joints) {
    keys.add(terminalKey(joint.a));
    keys.add(terminalKey(joint.b));
  }
  return keys;
}

/** A terminal of `instanceId` that nothing is soldered to yet. */
function freeTerminal(state: EditorState, instanceId: string): TerminalRef {
  const used = usedKeys(state.design);
  const free = terminalsOf(state.design, state.db, instanceId).find(
    (terminal) => !used.has(terminal.key),
  );
  if (free === undefined) throw new Error(`no free terminal on ${instanceId}`);
  return free.end === undefined
    ? { instance: free.instance, terminal: free.terminal }
    : { instance: free.instance, terminal: free.terminal, end: free.end };
}

describe('initial state', () => {
  it('validates the loaded design and keeps issues in sync with it', () => {
    const state = stateFor('rs485-de9-terminal-board');
    expect(state.issues).toEqual(validateDesign(state.design, db));
    expect(errors(state.issues)).toHaveLength(0);
    expect(state.rejection).toBeUndefined();
  });

  it('keeps coordinates out of the design document', () => {
    const state = stateFor('rs485-de9-terminal-board');
    expect(Object.keys(state.positions).length).toBeGreaterThan(0);
    expect(JSON.stringify(state.design)).not.toContain('position');
  });
});

describe('joints', () => {
  let state: EditorState;
  beforeEach(() => {
    state = stateFor('rs485-de9-terminal-board');
  });

  it('accepts a joint between two real, unused terminals', () => {
    const before = state.design;
    const a = freeTerminal(state, 'j1');
    const b = freeTerminal(state, 'u1');
    const next = editorReducer(state, { type: 'add-joint', a, b });

    expect(next.design).not.toBe(before);
    expect(next.design.joints).toHaveLength(before.joints.length + 1);
    expect(next.design.joints.at(-1)).toEqual({ a, b });
    expect(errors(next.issues)).toHaveLength(0);
    expect(next.issues).toEqual(validateDesign(next.design, db));
    expect(next.rejection).toBeUndefined();
    expect(next.selection).toEqual({
      kind: 'joint',
      index: next.design.joints.length - 1,
    });
    // the previous document is untouched — every edit is a new document
    expect(before.joints).toHaveLength(state.design.joints.length);
  });

  it('rejects a joint to a pin the connector does not have, with the validator message', () => {
    const before = state.design;
    const next = editorReducer(state, {
      type: 'add-joint',
      a: { instance: 'j1', terminal: '99' },
      b: freeTerminal(state, 'u1'),
    });

    expect(next.design).toBe(before);
    expect(next.issues).toBe(state.issues);
    expect(next.rejection).toContain('rejected');
    expect(next.rejection).toContain("has no pin '99'");
    // the message is the validator's own, not one the editor invented
    const wouldBe = {
      ...before,
      joints: [
        ...before.joints,
        { a: { instance: 'j1', terminal: '99' }, b: freeTerminal(state, 'u1') },
      ],
    };
    const message = errors(validateDesign(wouldBe, db))[0]?.message ?? '';
    expect(message).not.toBe('');
    expect(next.rejection).toContain(message);
  });

  it('rejects soldering a terminal to itself', () => {
    const a = freeTerminal(state, 'j1');
    const next = editorReducer(state, { type: 'add-joint', a, b: a });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('itself');
  });

  it('rejects a joint that already exists, in either order', () => {
    const existing = state.design.joints[0];
    if (existing === undefined) throw new Error('fixture has no joints');
    const next = editorReducer(state, {
      type: 'add-joint',
      a: existing.b,
      b: existing.a,
    });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('already jointed');
  });

  it('deletes a joint by index and refreshes the derived issues', () => {
    const before = state.design;
    const next = editorReducer(state, { type: 'delete-joint', index: 0 });
    expect(next.design.joints).toHaveLength(before.joints.length - 1);
    expect(next.design.joints[0]).toEqual(before.joints[1]);
    expect(next.issues).toEqual(validateDesign(next.design, db));
    expect(next.selection).toBeUndefined();
  });

  it('refuses to delete a joint that is not there', () => {
    const next = editorReducer(state, { type: 'delete-joint', index: 9999 });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('no joint at index');
  });

  it('edits a joint note, as one undo step, and clears it when emptied', () => {
    const added = editorReducer(state, {
      type: 'update-joint',
      index: 0,
      patch: { note: 'twisted with the drain' },
    });
    expect(added.design.joints[0]?.note).toBe('twisted with the drain');
    expect(added.past[added.past.length - 1]?.design).toBe(state.design);

    const cleared = editorReducer(added, { type: 'update-joint', index: 0, patch: { note: '' } });
    expect(cleared.design.joints[0]?.note).toBeUndefined();
  });

  it('refuses to edit the note of a joint that is not there', () => {
    const next = editorReducer(state, {
      type: 'update-joint',
      index: 9999,
      patch: { note: 'x' },
    });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('no joint at index');
  });
});

describe('instances', () => {
  let state: EditorState;
  beforeEach(() => {
    state = stateFor('rs485-de9-terminal-board');
  });

  it('adds a connector with the next free shop-style id and selects it', () => {
    const id = nextInstanceId(state.design, 'connector', 'rca-male');
    const next = editorReducer(state, {
      type: 'add-instance',
      kind: 'connector',
      def: 'rca-male',
      position: { x: 10, y: 20 },
    });
    expect(next.design.instances.connectors.map((i) => i.id)).toContain(id);
    expect(next.design.instances.connectors.at(-1)).toEqual({ id, def: 'rca-male' });
    expect(errors(next.issues)).toHaveLength(0);
    expect(next.positions[id]).toEqual({ x: 10, y: 20 });
    expect(next.selection).toEqual({ kind: 'instance', id });
  });

  describe('add-instance-near (the node picker, e5c.6)', () => {
    it('places without wiring when no anchor is given — same as a plain add-instance', () => {
      const id = nextInstanceId(state.design, 'connector', 'rca-male');
      const next = editorReducer(state, { type: 'add-instance-near', kind: 'connector', def: 'rca-male' });
      expect(next.design.instances.connectors.map((i) => i.id)).toContain(id);
      expect(next.design.joints).toHaveLength(state.design.joints.length);
      expect(next.selection).toEqual({ kind: 'instance', id });
      expect(errors(next.issues)).toHaveLength(0);
    });

    it('inserts and wires an anchor terminal in one commit — one undo step for both', () => {
      const anchor = freeTerminal(state, 'j1'); // j1:7 — a free pin (see picker.test.ts)
      const id = nextInstanceId(state.design, 'connector', 'rca-male');
      const next = editorReducer(state, {
        type: 'add-instance-near',
        kind: 'connector',
        def: 'rca-male',
        anchor,
        wireTerminal: { terminal: 'tip' },
      });
      expect(next.design.instances.connectors.map((i) => i.id)).toContain(id);
      expect(next.design.joints).toHaveLength(state.design.joints.length + 1);
      expect(jointIndexFor(next.design, anchor, { instance: id, terminal: 'tip' })).toBeGreaterThanOrEqual(0);
      expect(errors(next.issues)).toHaveLength(0);
      // one commit, one undo step — undoing restores both the instance and the joint
      expect(next.past.at(-1)?.description).toContain('wired to');
      const before = next.design;
      const undone = editorReducer(next, { type: 'undo' });
      expect(undone.design).toBe(state.design);
      expect(undone.design).not.toBe(before);
      expect(undone.design.instances.connectors.map((i) => i.id)).not.toContain(id);
      expect(undone.design.joints).toHaveLength(state.design.joints.length);
    });

    it('rejects the whole insert when the anchor is not a real terminal — nothing half-applied', () => {
      const bogus: TerminalRef = { instance: 'nope', terminal: 'x' };
      const next = editorReducer(state, {
        type: 'add-instance-near',
        kind: 'connector',
        def: 'rca-male',
        anchor: bogus,
        wireTerminal: { terminal: 'tip' },
      });
      expect(next.design).toBe(state.design);
      expect(next.rejection).toContain('unknown instance');
    });
  });

  it('rejects an instance of a definition the library does not have', () => {
    const next = editorReducer(state, {
      type: 'add-instance',
      kind: 'connector',
      def: 'no-such-connector',
    });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('unknown connector definition');
  });

  it('deletes an instance together with the joints that land on it', () => {
    const before = state.design;
    const attached = before.joints.filter(
      (joint) => joint.a.instance === 'u1' || joint.b.instance === 'u1',
    ).length;
    expect(attached).toBeGreaterThan(0);

    const next = editorReducer(state, { type: 'delete-instance', id: 'u1' });
    expect(next.design.instances.pcbas.map((i) => i.id)).not.toContain('u1');
    expect(next.design.joints).toHaveLength(before.joints.length - attached);
    expect(
      next.design.joints.some((j) => j.a.instance === 'u1' || j.b.instance === 'u1'),
    ).toBe(false);
    expect(errors(next.issues)).toHaveLength(0);
  });

  it('refuses to delete an instance that is not there', () => {
    const next = editorReducer(state, { type: 'delete-instance', id: 'nope' });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain("no instance 'nope'");
  });

  describe('delete-instances (docked boards)', () => {
    it('a batch with no docked pair just deletes every id, still one commit', () => {
      const before = stateFor('rs485-de9-terminal-board');
      // w1 and u2 are unrelated — neither mounts on the other
      const ids = ['w1', 'u1'];
      const next = editorReducer(before, { type: 'delete-instances', ids });
      expect(next.design.instances.segments.map((s) => s.id)).not.toContain('w1');
      expect(next.design.instances.pcbas.map((p) => p.id)).not.toContain('u1');
      expect(next.past.length).toBe(before.past.length + 1);
    });

  });

  it('refuses to edit an instance that is not there', () => {
    const next = editorReducer(state, {
      type: 'update-instance',
      id: 'ghost',
      patch: { note: 'x' },
    });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain("no instance 'ghost'");
  });
});

describe('presentation state', () => {
  it('moving a node changes coordinates and nothing else', () => {
    const state = stateFor('rs485-de9-terminal-board');
    const next = editorReducer(state, {
      type: 'move-node',
      id: 'j1',
      position: { x: -5, y: 12 },
    });
    expect(next.positions['j1']).toEqual({ x: -5, y: 12 });
    expect(next.design).toBe(state.design);
    expect(next.issues).toBe(state.issues);
  });

  it('a drag gesture is one undo step that puts the parts back, the design untouched (udy.10)', () => {
    const state = stateFor('rs485-de9-terminal-board');
    const before = state.positions['j1'];
    let next = editorReducer(state, { type: 'begin-move' });
    for (const x of [1, 2, 3]) next = editorReducer(next, { type: 'move-node', id: 'j1', position: { x, y: x } });
    next = editorReducer(next, { type: 'end-move' });
    expect(next.past).toHaveLength(1);
    expect(next.past[0]!.description).toBe('move j1');
    expect(next.moveStart).toBeUndefined();
    const undone = editorReducer(next, { type: 'undo' });
    expect(undone.positions['j1']).toEqual(before);
    expect(undone.design).toBe(state.design);
    expect(undone.layouts[state.design.id]!['j1']).toEqual(before);
    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.positions['j1']).toEqual({ x: 3, y: 3 });
    expect(redone.past).toHaveLength(1);
    expect(redone.future).toHaveLength(0);
  });

  it('a click (a gesture that moves nothing) leaves no undo step', () => {
    const state = stateFor('rs485-de9-terminal-board');
    const next = editorReducer(editorReducer(state, { type: 'begin-move' }), { type: 'end-move' });
    expect(next.past).toHaveLength(0);
  });

  it('moves and edits interleave on one stack; undoing an edit leaves the arrangement alone', () => {
    const state = stateFor('rs485-de9-terminal-board');
    let next = editorReducer(state, { type: 'begin-move' });
    next = editorReducer(next, { type: 'move-node', id: 'j1', position: { x: 9, y: 9 } });
    next = editorReducer(next, { type: 'end-move' });
    next = editorReducer(next, { type: 'update-instance', id: 'j1', patch: { note: 'x' } });
    expect(next.past.map((e) => e.positions === undefined)).toEqual([false, true]);
    const one = editorReducer(next, { type: 'undo' });
    expect(one.positions['j1']).toEqual({ x: 9, y: 9 });
    expect(one.design).toBe(state.design);
    const two = editorReducer(one, { type: 'undo' });
    expect(two.positions['j1']).toEqual(state.positions['j1']);
  });

  it('auto-arrange is undoable', () => {
    const state = editorReducer(stateFor('rs485-de9-terminal-board'), { type: 'move-node', id: 'j1', position: { x: 4321, y: 1234 } });
    const arranged = editorReducer(state, { type: 'auto-arrange' });
    expect(arranged.past.at(-1)?.description).toBe('auto-arrange');
    expect(editorReducer(arranged, { type: 'undo' }).positions['j1']).toEqual({ x: 4321, y: 1234 });
  });

  it('selection never touches the design', () => {
    const state = stateFor('rs485-de9-terminal-board');
    const next = editorReducer(state, {
      type: 'select',
      selection: { kind: 'terminal', ref: { instance: 'j1', terminal: '1' } },
    });
    expect(next.design).toBe(state.design);
  });
});

describe('commit', () => {
  it('is the only door into the design, and it is locked from the error side', () => {
    const state = stateFor('rs485-de9-terminal-board');
    const broken: CableDesign = {
      ...state.design,
      instances: {
        ...state.design.instances,
        connectors: [
          ...state.design.instances.connectors,
          { id: 'j1', def: 'rca-male' },
        ],
      },
    };
    const next = commit(state, broken, 'duplicate j1');
    expect(next.design).toBe(state.design);
    expect(next.issues).toBe(state.issues);
    expect(next.rejection).toContain("duplicate instance id 'j1'");
  });

});
