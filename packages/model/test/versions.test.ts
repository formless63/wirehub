/**
 * Design versions: a snapshot freezes what it references,
 * validates against its own frozen definitions, survives a Library change,
 * diffs, and records unlock/edit/relock in its history.
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import {
  approvalStepProblem,
  approveVersion,
  rejectVersion,
  releasedRevision,
  submitVersion,
  createVersion,
  describeJointMove,
  designChangeLines,
  diffLines,
  diffVersions,
  editVersion,
  errors,
  formatVersionJson,
  freezeDefinitions,
  moveJointEnds,
  nextRevision,
  relockVersion,
  unlockVersion,
  validateDesign,
  validateVersion,
  versionDb,
  versionSummary,
  type CableDesign,
} from '../src/index.ts';

const db = loadDb();
const ID = 'de9-terminal-board';
const design = loadDesign(ID);

function v0(): ReturnType<typeof createVersion> {
  return createVersion({ design, db, rev: 0, at: '2026-09-25T10:00:00.000Z', by: 'Owner', note: 'first release' });
}

describe('freezing', () => {
  it('keeps only the definitions the design references, sorted', () => {
    const frozen = freezeDefinitions(design, db);
    expect(frozen.connectors.map((c) => c.id)).toEqual(expect.arrayContaining(['de9-male']));
    expect(frozen.wires.map((w) => w.id)).toEqual(['shielded-2pair-24awg']);
    expect(frozen.pcbas.map((p) => p.id)).toEqual(['pair-terminal-board']);
    expect(frozen.connectors.length).toBeLessThan(db.connectors.length);
  });

  it('every catalog design validates against its own frozen definitions', () => {
    for (const id of listDesignIds()) {
      const d = loadDesign(id);
      const live = errors(validateDesign(d, db)).length;
      const frozen = errors(validateVersion(createVersion({ design: d, db, rev: 0, at: 't', by: 'x', note: 'n' }))).length;
      expect([id, frozen]).toEqual([id, live]);
    }
  });

  it('an old version renders against its frozen definitions after a Library change', () => {
    const version = v0();
    const changed = structuredClone(db);
    const de9 = changed.connectors.find((c) => c.id === 'de9-male');
    if (de9 === undefined) throw new Error('fixture');
    de9.label = 'renamed later';
    const resolved = versionDb(version.definitions, changed);
    expect(resolved.connectors.find((c) => c.id === 'de9-male')?.label).not.toBe('renamed later');
    // something the version never referenced still comes from the live library
    expect(resolved.connectors.length).toBe(changed.connectors.length);
  });
});

describe('the file', () => {
  it('is deterministic and records the save', () => {
    expect(formatVersionJson(v0())).toBe(formatVersionJson(v0()));
    const text = formatVersionJson(v0());
    expect(Object.keys(JSON.parse(text) as object).slice(0, 7)).toEqual(['format', 'designId', 'rev', 'savedAt', 'savedBy', 'note', 'design']);
    expect(v0().history).toEqual([{ action: 'save', at: '2026-09-25T10:00:00.000Z', by: 'Owner', note: 'first release' }]);
    expect(versionSummary(v0())).toMatchObject({ rev: 0, locked: true, edits: 0 });
  });

  it('refuses a version without a note', () => {
    const bad = { ...v0(), note: ' ' };
    expect(validateVersion(bad).map((i) => i.code)).toContain('version-note');
  });
});

describe('numbers', () => {
  it('starts from the drawing revision, then counts up', () => {
    expect(nextRevision([])).toBe(0);
    expect(nextRevision([], '1')).toBe(1);
    expect(nextRevision([], 'Rev 2')).toBe(2);
    expect(nextRevision([], 'A')).toBe(0);
    expect(nextRevision([1, 2], '1')).toBe(3);
  });
});

describe('diff', () => {
  it('names added/removed instances, joints and changed fields', () => {
    const before = { design, definitions: freezeDefinitions(design, db) };
    const edited: CableDesign = structuredClone(design);
    edited.label = 'changed';
    edited.joints = edited.joints.slice(1);
    edited.instances.pcbas = edited.instances.pcbas.filter((c) => c.id !== 'u1');
    const diff = diffVersions(before, { design: edited, definitions: freezeDefinitions(edited, db) });
    expect(diff.fields).toEqual(['label']);
    expect(diff.joints.removed.length).toBeGreaterThan(0);
    expect(diff.instances.removed.map((i) => i.id)).toEqual(['u1']);
    expect(diff.definitions.removed).toContain('connector terminal-block-4');
    expect(diffLines(diff)[0]).toBe('~ label');
    expect(diffLines(diffVersions(before, before))).toEqual([]);
  });
});

describe('locking', () => {
  it('unlock → edit records the reason and the change, and re-locks', () => {
    const unlocked = unlockVersion(v0(), 't1', 'Alex', 'typo in the note');
    expect(versionSummary(unlocked).locked).toBe(false);
    const edited = structuredClone(design);
    edited.notes = [...(edited.notes ?? []), 'extra'];
    const after = editVersion(unlocked, edited, db, 't2', 'Alex');
    expect(after.unlocked).toBeUndefined();
    expect(after.history.map((h) => h.action)).toEqual(['save', 'unlock', 'edit']);
    expect(after.history[2]).toMatchObject({ note: 'typo in the note', changes: ['~ notes'] });
    expect(versionSummary(after)).toMatchObject({ locked: true, edits: 1 });
  });

  it('relock without an edit is recorded', () => {
    const after = relockVersion(unlockVersion(v0(), 't1', 'Alex', 'look'), 't2', 'Alex');
    expect(after.unlocked).toBeUndefined();
    expect(after.history.map((h) => h.action)).toEqual(['save', 'unlock', 'relock']);
  });
});

describe('a re-pin in the diff', () => {
  const hd15 = loadDesign('de9-crossover');
  const purple = hd15.joints.findIndex((j) => j.a.terminal === 'pair-1.a' && j.b.instance === 'j2');
  const noted: CableDesign = {
    ...hd15,
    joints: hd15.joints.map((j, i) => (i === purple ? { ...j, note: 'TX to RX, per the bench sheet' } : j)),
  };
  const moved = moveJointEnds(noted, [{ index: purple, side: 'b', to: { instance: 'j2', terminal: '9' } }]);

  it('is one "moved" line naming the wire end, both pins and the note the move cleared', () => {
    expect(moved.joints[purple]?.note).toBeUndefined();
    const lines = diffLines(diffVersions({ design: noted, definitions: freezeDefinitions(noted, db) }, { design: moved, definitions: freezeDefinitions(moved, db) }));
    expect(lines).toEqual(['~ moved w1:pair-1.a@b from j2:2 to j2:9 (note was: "TX to RX, per the bench sheet")']);
    expect(designChangeLines(noted, moved)).toEqual(lines);
  });

  it('the editor`s own description says the same thing', () => {
    expect(describeJointMove(noted, { index: purple, side: 'b', to: { instance: 'j2', terminal: '9' } })).toBe(
      'moved w1:pair-1.a@b from j2:2 to j2:9 (note was: "TX to RX, per the bench sheet")',
    );
    expect(describeJointMove(hd15, { index: purple, side: 'b', to: { instance: 'j2', terminal: '9' } })).toBe(
      'moved w1:pair-1.a@b from j2:2 to j2:9 (note was: "crossed to 2")',
    );
  });

  it('an unrelated add and remove stay an add and a remove', () => {
    const red = hd15.joints.findIndex((j) => j.a.terminal === 'pair-1.b');
    const other: CableDesign = {
      ...hd15,
      joints: [
        ...hd15.joints.filter((_, i) => i !== red),
        { a: { instance: 'w1', terminal: 'pair-2.b', end: 'a' }, b: { instance: 'j1', terminal: '9' } },
      ],
    };
    const diff = diffVersions({ design: hd15, definitions: freezeDefinitions(hd15, db) }, { design: other, definitions: freezeDefinitions(other, db) });
    expect(diff.joints.moved).toEqual([]);
    expect(diff.joints.added).toHaveLength(1);
    expect(diff.joints.removed).toHaveLength(1);
  });
});

describe('approval steps (cs-5k1.11)', () => {
  const file = (): ReturnType<typeof createVersion> =>
    createVersion({ design: loadDesign('de9-crossover'), db: loadDb(), rev: 0, at: '2026-10-01T10:00:00.000Z', by: 'A', note: 'first' });

  it('walks submit, reject, resubmit, approve, with the trail in history', () => {
    let v = file();
    expect(approvalStepProblem(v, 'approve')).toContain('not been submitted');
    v = submitVersion(v, 't1', 'Ann', ' look at pin 3 ');
    expect(v.approval).toMatchObject({ state: 'submitted', by: 'Ann', comment: 'look at pin 3' });
    expect(approvalStepProblem(v, 'submit')).toContain('already waiting');
    v = rejectVersion(v, 't2', 'Bob', 'wrong');
    expect(approvalStepProblem(v, 'submit')).toBeUndefined();
    v = submitVersion(v, 't3', 'Ann', 'fixed');
    v = approveVersion(v, 't4', 'Bob', 'ok');
    expect(v.approval).toMatchObject({ state: 'approved', by: 'Bob', submittedBy: 'Ann', submittedAt: 't3' });
    expect(v.history.map((h) => h.action)).toEqual(['save', 'submit', 'reject', 'submit', 'approve']);
    expect(versionSummary(v).approval?.state).toBe('approved');
    expect(releasedRevision([versionSummary(v), { rev: 1 }], true)).toBe(0);
    expect(releasedRevision([{ rev: 0 }, { rev: 1 }], true)).toBeUndefined();
    expect(releasedRevision([{ rev: 0 }, { rev: 1 }], false)).toBe(1);
  });

  it('an edit sends an approved version back to draft', () => {
    const approved = approveVersion(submitVersion(file(), 't1', 'A', 'x'), 't2', 'B', 'y');
    const unlocked = unlockVersion(approved, 't3', 'A', 'typo');
    expect(approvalStepProblem(unlocked, 'submit')).toContain('unlocked');
    const edited = editVersion(unlocked, { ...unlocked.design, notes: ['n'] }, loadDb(), 't4', 'A');
    expect(edited.approval).toBeUndefined();
  });
});
