/**
 * Controlled vocabularies:
 * the committed lists are clean, lookups follow aliases and merges, and every
 * write is append-only.
 */

import { describe, expect, it } from 'vitest';
import { listVocabIds, loadDb, loadVocab } from '@wirehub/catalog';

import {
  VOCAB_LIST_IDS,
  appendVocabEntry,
  errors,
  resolveVocab,
  validateDb,
  validateVocab,
  validateVocabList,
  vocabChangeIssues,
  vocabEntry,
  vocabReferenceIssues,
  warnings,
  type Db,
  type SignalEntry,
  type VocabList,
} from '../src/index.ts';

const vocab = loadVocab();
const ids = (list: string): string[] => (vocab[list]?.entries ?? []).map((e) => e.id);

describe('the committed lists', () => {
  it('are exactly the lists the model names, one file each', () => {
    expect(listVocabIds()).toEqual([...VOCAB_LIST_IDS].sort());
  });

  it('validate with no issue of any severity', () => {
    expect(validateVocab(vocab)).toEqual([]);
  });

  it('give every entry an id, a label and a src', () => {
    for (const list of Object.values(vocab)) {
      expect(list.src, list.id).toBeTruthy();
      for (const entry of list.entries) {
        expect(entry.id, `${list.id}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(entry.label.trim(), `${list.id}/${entry.id}`).not.toBe('');
        expect(entry.src.trim(), `${list.id}/${entry.id}`).not.toBe('');
      }
    }
  });

  it('carry the starter signals across the domains the examples use, and no video', () => {
    for (const id of ['audio-l', 'audio-hot', 'rs232-txd', 'rs485-a', 'eth-da-p', 'usb-dp', 'pwr-5v', 'gnd', 'gnd-chassis', 'nc']) {
      expect(ids('signals'), id).toContain(id);
    }
    // video belongs to the av-video module's pack
    for (const id of ['video-r', 'hsync', 'csync', 'cvbs']) expect(ids('signals'), id).not.toContain(id);
    expect(ids('lanes')).toEqual(expect.arrayContaining(['audio-l', 'audio-r', 'power', 'ground', 'spare']));
  });

  it('cover every value the model types already fix', () => {
    expect(ids('genders')).toEqual(['male', 'female']);
    expect(ids('constructions')).toEqual(['braid', 'spiral', 'foil', 'tape']);
    expect(ids('component-kinds')).toEqual(['resistor', 'capacitor', 'ic', 'switch', 'other']);
  });

  it('answer to every family string the connectors use today', () => {
    for (const connector of loadDb().connectors) {
      expect(resolveVocab(vocab, 'families', connector.family), connector.family).toBeDefined();
    }
  });

  it('map the RCA audio colour code: white left, red right', () => {
    const rca = vocabEntry<{ id: string; label: string; src: string; lanes: Record<string, string> }>(vocab, 'colour-codes', 'rca-audio');
    expect(rca?.lanes).toEqual({ white: 'audio-l', red: 'audio-r' });
  });

  it('class every return as ground', () => {
    for (const entry of vocab['signals']!.entries as SignalEntry[]) {
      if (entry.id === 'gnd' || entry.id.startsWith('gnd-')) expect(entry.kind, entry.id).toBe('ground');
    }
  });

  it('load into the db, which still validates clean', () => {
    const db = loadDb();
    expect(db.vocab).toEqual(vocab);
    expect(errors(validateDb(db))).toEqual([]);
    expect(warnings(validateDb(db))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

const sample: VocabList = {
  id: 'signals',
  label: 'Signals',
  src: 'test',
  entries: [
    { id: 'csync', label: 'CSync', aliases: ['Composite sync'], src: 'test' },
    { id: 'sync-composite', label: 'Composite (old)', deprecatedBy: 'csync', src: 'test' },
    { id: 'gun', label: 'Gun', pending: true, src: 'test' },
  ],
};
const one = { signals: sample };

describe('lookups', () => {
  it('resolve an id, a label or an alias, any case and spacing', () => {
    expect(resolveVocab(one, 'signals', 'csync')?.via).toBe('id');
    expect(resolveVocab(one, 'signals', ' CSYNC ')?.entry.id).toBe('csync');
    expect(resolveVocab(one, 'signals', 'composite  SYNC')).toMatchObject({ via: 'alias', entry: { id: 'csync' } });
    expect(resolveVocab(one, 'signals', 'nothing like it')).toBeUndefined();
  });

  it('follow a merge forward', () => {
    expect(vocabEntry(one, 'signals', 'sync-composite')?.id).toBe('csync');
    expect(resolveVocab(one, 'signals', 'Composite (old)')).toMatchObject({ deprecated: true, entry: { id: 'csync' } });
  });

  it('hide a pending entry unless asked', () => {
    expect(vocabEntry(one, 'signals', 'gun')).toBeUndefined();
    expect(vocabEntry(one, 'signals', 'gun', { includePending: true })?.id).toBe('gun');
  });
});

/* ------------------------------------------------------------------ *
 * List rules and append-only writes
 * ------------------------------------------------------------------ */

describe('list rules', () => {
  const codes = (list: VocabList): string[] => validateVocabList(list).map((i) => i.code).sort();

  it('refuse a missing src, a duplicate id, a bad id and an ambiguous spelling', () => {
    expect(codes({ ...sample, entries: [...sample.entries, { id: 'luma', label: 'Luma', src: '' }] })).toEqual(['missing-src']);
    expect(codes({ ...sample, entries: [...sample.entries, { id: 'csync', label: 'Again', src: 'x' }] })).toEqual(['duplicate-id']);
    expect(codes({ ...sample, entries: [...sample.entries, { id: 'Luma', label: 'Luma', src: 'x' }] })).toEqual(['vocab-bad-id']);
    expect(codes({ ...sample, entries: [...sample.entries, { id: 'luma', label: 'Luma', aliases: ['composite sync'], src: 'x' }] })).toEqual(['vocab-ambiguous']);
  });

  it('refuse a merge into nothing, and a merge round a circle', () => {
    expect(codes({ ...sample, entries: [{ id: 'a', label: 'A', deprecatedBy: 'z', src: 'x' }] })).toEqual(['vocab-deprecated-by-unknown']);
    expect(
      codes({ ...sample, entries: [{ id: 'a', label: 'A', deprecatedBy: 'b', src: 'x' }, { id: 'b', label: 'B', deprecatedBy: 'a', src: 'x' }] }),
    ).toEqual(['vocab-deprecated-cycle', 'vocab-deprecated-cycle']);
  });
});

describe('append-only', () => {
  it('appends a well-formed entry, accepted by default and pending when asked (Q8)', () => {
    const added = appendVocabEntry(sample, { id: 'luma', label: 'Luma (Y)', src: 'video.md §2' });
    expect(added.ok && added.list.entries.at(-1)).toEqual({ id: 'luma', label: 'Luma (Y)', src: 'video.md §2' });
    const proposed = appendVocabEntry(sample, { id: 'luma', label: 'Luma (Y)', src: 'x' }, { pending: true });
    expect(proposed.ok && proposed.list.entries.at(-1)?.pending).toBe(true);
    expect(sample.entries).toHaveLength(3);
  });

  it('refuses an entry with no src, a reused id or a spelling someone else answers to', () => {
    const codes = (entry: Parameters<typeof appendVocabEntry>[1]): string[] => {
      const result = appendVocabEntry(sample, entry);
      return result.ok ? [] : result.issues.map((i) => i.code).sort();
    };
    expect(codes({ id: 'luma', label: 'Luma', src: ' ' })).toEqual(['missing-src']);
    expect(codes({ id: 'csync', label: 'CSync 2', src: 'x' })).toEqual(['duplicate-id']);
    expect(codes({ id: 'c-sync', label: 'Composite sync', src: 'x' })).toEqual(['vocab-ambiguous']);
  });

  it('allows a rename that keeps the old label, an added alias, a merge and an acceptance', () => {
    const after: VocabList = {
      ...sample,
      entries: [
        { id: 'csync', label: 'Composite sync (CSync)', aliases: ['Composite sync', 'CSync', 'CS'], src: 'test' },
        { id: 'sync-composite', label: 'Composite (old)', deprecatedBy: 'csync', src: 'test' },
        { id: 'gun', label: 'Gun', src: 'test', deprecatedBy: 'csync' },
      ],
    };
    expect(vocabChangeIssues(sample, after)).toEqual([]);
  });

  it('refuses a removal, an unaliased rename, a dropped alias, an undone merge and a return to pending', () => {
    const after: VocabList = {
      ...sample,
      entries: [
        { id: 'csync', label: 'Sync', src: 'test' },
        { id: 'sync-composite', label: 'Composite (old)', src: 'test', pending: true },
      ],
    };
    expect(vocabChangeIssues(sample, after).map((i) => i.code).sort()).toEqual([
      'vocab-alias-removed',
      'vocab-entry-removed',
      'vocab-rename-unaliased',
      'vocab-unaccepted',
      'vocab-undeprecated',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * References from the definitions
 * ------------------------------------------------------------------ */

describe('references into the lists', () => {
  const base = (): Db => ({
    connectors: [
      {
        id: 'plug',
        label: 'Plug',
        family: 'SCART',
        pins: [
          { id: '1', label: 'CSync', signal: 'csync' },
          { id: '2', label: 'Old', signal: 'sync-composite' },
          { id: '3', label: 'Gun', signal: 'gun' },
          { id: '4', label: '?', signal: 'no-such-signal' },
          { id: '5', label: 'Either', signal: { oneOf: ['csync', 'nope'] } },
        ],
        src: 'test',
      },
    ],
    wires: [],
    components: [],
    pcbas: [
      {
        id: 'board',
        label: 'Board',
        partNumber: 'PCA-00105',
        revision: '1',
        terminals: [{ id: 'S', role: 'not-a-role' }],
        internalLinks: [],
        src: 'test',
      },
    ],
    vocab: { ...one, 'pad-roles': { id: 'pad-roles', label: 'Pad roles', src: 'x', entries: [{ id: 'sync', label: 'Sync', src: 'x' }] }, families: { id: 'families', label: 'F', src: 'x', entries: [{ id: 'din', label: 'DIN', src: 'x' }] } },
    tags: { src: 'test', wires: { stock: { colourCode: 'mystery' } } },
  });

  it('error on an unknown id, warn on a merged, pending or unlisted one', () => {
    const issues = vocabReferenceIssues(base());
    expect(issues.map((i) => `${i.severity} ${i.code} ${i.where}`)).toEqual([
      'warning vocab-deprecated connectors/plug/2',
      'warning vocab-pending connectors/plug/3',
      'error vocab-unknown connectors/plug/4',
      'error vocab-unknown connectors/plug/5',
      'warning vocab-unmatched connectors/plug',
      'error vocab-unknown pcbas/board/S',
    ]);
  });

  it('check only the lists the db carries', () => {
    const db = base();
    delete db.vocab;
    expect(vocabReferenceIssues(db)).toEqual([]);
  });
});
