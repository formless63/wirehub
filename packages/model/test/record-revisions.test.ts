/** Revisions of library records (`record-revisions.ts`) and the prefix scheme's variant numbers, over the starter catalog. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import {
  DEFAULT_PART_NUMBER_SCHEME,
  createVersion,
  findLibraryRecord,
  recordRevisionProblems,
  revisionOfRecord,
  revisionsWhereUsed,
  saveRecordRevision,
  type Db,
} from '../src/index.ts';

const db = loadDb();
const AT = '2026-10-05T12:00:00.000Z';

describe('record revisions', () => {
  it('numbers revisions, keeps the number, art and model, and finds the one a record equals', () => {
    const record = findLibraryRecord(db, 'connectors', 'de9-female')!;
    expect(record['id']).toBe('de9-female');
    const one = saveRecordRevision(undefined, 'connectors', 'de9-female', record, { note: 'first', at: AT, by: 'Olive', art: { view: 'mating-face', svg: '<svg/>' }, model: { asset: 'a'.repeat(64) } });
    const changed = { ...record, label: 'relabelled' };
    const two = saveRecordRevision(one, 'connectors', 'de9-female', changed, { note: 'second', at: AT, label: 'Rev B' });
    expect(two.revisions.map((r) => [r.rev, r.note, r.label, r.partNumber])).toEqual([
      [1, 'first', undefined, record['partNumber']],
      [2, 'second', 'Rev B', record['partNumber']],
    ]);
    expect(two.revisions[0]!.art?.view).toBe('mating-face');
    expect(revisionOfRecord(two, record)?.rev).toBe(1);
    expect(revisionOfRecord(two, changed)?.rev).toBe(2);
    expect(revisionOfRecord(two, { ...record, label: 'other' })).toBeUndefined();
    expect(recordRevisionProblems(two, 'connectors', 'de9-female')).toEqual([]);
  });

  it('refuses a malformed history', () => {
    const record = findLibraryRecord(db, 'connectors', 'de9-female')!;
    const bad = { kind: 'connectors', id: 'de9-female', revisions: [{ rev: 1, note: 'x', savedAt: AT, record }, { rev: 1, note: 'y', savedAt: 'yesterday', record: { id: 'other' }, art: { view: 'x', svg: 'not svg' }, model: { asset: 'nope' } }] };
    const problems = recordRevisionProblems(bad, 'connectors', 'de9-female');
    expect(problems.join(' | ')).toMatch(/appears twice/);
    expect(problems.join(' | ')).toMatch(/savedAt/);
    expect(problems.join(' | ')).toMatch(/snapshot is of 'other'/);
    expect(problems.join(' | ')).toMatch(/art/);
    expect(problems.join(' | ')).toMatch(/sha256/);
    expect(recordRevisionProblems({ kind: 'wires', id: 'x', revisions: [] }, 'connectors', 'de9-female')[0]).toMatch(/not connectors\/de9-female/);
  });

  it('says which revision each saved version was built with, and what the working copies use', () => {
    const design = loadDesign('de9-crossover');
    const record = findLibraryRecord(db, 'connectors', 'de9-female')!;
    const history = saveRecordRevision(undefined, 'connectors', 'de9-female', record, { note: 'first', at: AT });
    const v1 = createVersion({ design, db, rev: 1, at: AT, by: 'Olive', note: 'built with rev 1' } as never);
    const changedDb: Db = { ...db, connectors: db.connectors.map((c) => (c.id === 'de9-female' ? { ...c, label: 'relabelled' } : c)) };
    const v2 = createVersion({ design, db: changedDb, rev: 2, at: AT, by: 'Olive', note: 'built after the change' } as never);
    const now = findLibraryRecord(changedDb, 'connectors', 'de9-female');
    const used = revisionsWhereUsed(history, 'connectors', 'de9-female', now, [{ id: design.id, label: design.label }], [v1, v2], new Map([[design.id, 1]]));
    expect(used.byRev[1]).toEqual([{ design: design.id, label: design.label, version: 1, released: true }]);
    expect(used.unrecorded).toEqual([
      { design: design.id, label: design.label, version: 2 },
      { design: design.id, label: design.label },
    ]);
  });
});

describe('variant numbers under the prefix scheme', () => {
  it('proposes the next free two-digit variant of a number', () => {
    const known = [{ pn: 'CON-00012', kind: 'connector' as const, label: 'x', source: 'a' }, { pn: 'CON-00012-01', kind: 'connector' as const, label: 'y', source: 'b' }];
    expect(DEFAULT_PART_NUMBER_SCHEME.suggest({ kind: 'connector', label: 'x', variantOf: 'CON-00012' }, known)?.pn).toBe('CON-00012-02');
    expect(DEFAULT_PART_NUMBER_SCHEME.suggest({ kind: 'connector', label: 'x', variantOf: 'CON-00013' }, known)?.pn).toBe('CON-00013-01');
    // a family pattern's variants
    expect(DEFAULT_PART_NUMBER_SCHEME.suggest({ kind: 'design', label: 'x', variantOf: 'CBL-00090-XX' }, [])?.pn).toBe('CBL-00090-01');
    // not a number of this scheme: the next free number of the kind
    expect(DEFAULT_PART_NUMBER_SCHEME.suggest({ kind: 'connector', label: 'x', variantOf: 'nonsense' }, known)?.pn).toBe('CON-00013');
  });
});
