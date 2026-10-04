/**
 * The Library's logic.
 *
 * The load-bearing claim of the definition editors is that the *form is the
 * record* — that showing a wire stock as boxes and rows instead of JSON loses
 * nothing. That is not an opinion, it is a round trip, and it is checked here
 * against every definition in the committed catalog: draft it, map it back,
 * and demand the same document.
 */

import { loadDb } from '@wirehub/catalog';
import type { Db, WireDefinition } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  blankCoreDraft,
  blankPinRow,
  componentDraftOf,
  componentOf,
  connectorDraftOf,
  connectorOf,
  corePaths,
  countLabel,
  definitionDetail,
  definitionSummary,
  isOldRevision,
  draftIssues,
  duplicateRowIds,
  isNumberField,
  matchesDefinition,
  numberOf,
  pcbaDraftOf,
  pcbaOf,
  pcbaTerminalChoices,
  pinRowsReducer,
  wireDefinitionOf,
  wireFormIssues,
  wireFormOf,
  type PinRow,
  type WireDraft,
  followNameId,
} from '../src/library.ts';

const db: Db = loadDb();

function form(id: string): WireDraft {
  const wire = db.wires.find((candidate) => candidate.id === id) as WireDefinition;
  const draft = wireFormOf(wire);
  if (draft === undefined) throw new Error(`${id} did not fit the wire form`);
  return draft;
}

/* ------------------------------------------------------------------ *
 * Round trips
 * ------------------------------------------------------------------ */

describe('the form is the record', () => {
  it('round-trips every connector in the catalog', () => {
    for (const connector of db.connectors) {
      expect(connectorOf(connectorDraftOf(connector))).toEqual(connector);
    }
  });

  it('round-trips every component in the catalog', () => {
    for (const component of db.components) {
      expect(componentOf(componentDraftOf(component))).toEqual(component);
    }
  });

  it('round-trips every board in the catalog', () => {
    for (const pcba of db.pcbas) {
      expect(pcbaOf(pcbaDraftOf(pcba))).toEqual(pcba);
    }
  });
});

describe('wireFormOf', () => {

  it('refuses a tree the form cannot hold, rather than flattening it', () => {
    const wire = db.wires[0] as WireDefinition;
    const nested: WireDefinition = {
      ...wire,
      structure: {
        ...wire.structure,
        children: [
          {
            kind: 'group',
            id: 'bundle',
            role: 'bundle',
            children: [{ kind: 'conductor', id: 'inner', odMm: 0.5 }],
          },
        ],
      },
    };
    expect(wireFormOf(nested)).toBeUndefined();
  });

  it('refuses a core whose layers are in an order it does not draw', () => {
    const wire = db.wires[0] as WireDefinition;
    const upside: WireDefinition = {
      ...wire,
      structure: {
        ...wire.structure,
        children: [
          {
            kind: 'group',
            id: 'core-odd',
            role: 'coax',
            children: [
              { kind: 'shield', id: 'shield', construction: 'braid', odMm: 1.9 },
              { kind: 'conductor', id: 'center', odMm: 0.36 },
            ],
          },
        ],
      },
    };
    expect(wireFormOf(upside)).toBeUndefined();
  });

});

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

describe('the row builder', () => {
  const rows: PinRow[] = [
    { id: '1', label: 'Red', aliases: '', note: '', signal: '' },
    { id: '2', label: 'Green', aliases: '', note: '', signal: '' },
    { id: '3', label: 'Blue', aliases: '', note: '', signal: '' },
  ];

  it('adds a blank row at the end', () => {
    expect(pinRowsReducer(rows, { type: 'add' })).toEqual([...rows, blankPinRow()]);
  });

  it('removes by index without touching the others', () => {
    expect(pinRowsReducer(rows, { type: 'remove', index: 1 }).map((row) => row.id)).toEqual([
      '1',
      '3',
    ]);
  });

  it('moves a row up and down', () => {
    expect(pinRowsReducer(rows, { type: 'move', index: 2, by: -1 }).map((row) => row.id)).toEqual([
      '1',
      '3',
      '2',
    ]);
    expect(pinRowsReducer(rows, { type: 'move', index: 0, by: 1 }).map((row) => row.id)).toEqual([
      '2',
      '1',
      '3',
    ]);
  });

  it('does nothing when a move would run off the end', () => {
    expect(pinRowsReducer(rows, { type: 'move', index: 0, by: -1 })).toBe(rows);
    expect(pinRowsReducer(rows, { type: 'move', index: 2, by: 1 })).toBe(rows);
    expect(pinRowsReducer(rows, { type: 'move', index: 9, by: -1 })).toBe(rows);
  });

  it('patches one field of one row and leaves the array otherwise alone', () => {
    const next = pinRowsReducer(rows, { type: 'update', index: 1, patch: { label: 'G' } });
    expect(next[1]).toEqual({ id: '2', label: 'G', aliases: '', note: '', signal: '' });
    expect(next[0]).toBe(rows[0]);
  });

  it('never mutates what it was given', () => {
    pinRowsReducer(rows, { type: 'move', index: 0, by: 1 });
    pinRowsReducer(rows, { type: 'remove', index: 0 });
    expect(rows.map((row) => row.id)).toEqual(['1', '2', '3']);
  });

  it('finds ids typed twice, and ignores the blanks', () => {
    expect(
      duplicateRowIds([{ id: '1' }, { id: ' 1 ' }, { id: '' }, { id: '' }, { id: '2' }]),
    ).toEqual(['1']);
  });
});

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

describe('number fields', () => {
  it('treats blank as "not stated" and nonsense as an error', () => {
    expect(isNumberField('')).toBe(true);
    expect(isNumberField('  ')).toBe(true);
    expect(isNumberField('1.4')).toBe(true);
    expect(isNumberField('1.4 mm')).toBe(false);
    expect(numberOf('')).toBeUndefined();
    expect(numberOf('1.4 mm')).toBeUndefined();
    expect(numberOf(' 1.4 ')).toBe(1.4);
  });
});

describe('wireFormIssues', () => {

  it('gives a new core the layers its kind implies', () => {
    expect(blankCoreDraft('coax', 'core-x').sheath?.id).toBe('sheath');
    expect(blankCoreDraft('shielded-core', 'core-x').sheath).toBeUndefined();
    expect(blankCoreDraft('plain', 'core-x').shield).toBeUndefined();
    expect(blankCoreDraft('plain', 'core-x').conductor.id).toBe('core-x');
  });
});

/* ------------------------------------------------------------------ *
 * The immediate check
 * ------------------------------------------------------------------ */

describe('draftIssues', () => {

  it('catches a duplicate pin inside the record itself', () => {
    const connector = db.connectors.find((c) => c.id === 'rca-male')!;
    const issues = draftIssues(db, 'connectors', {
      ...connector,
      pins: [...connector.pins, connector.pins[0]!],
    });
    expect(issues[0]?.code).toBe('duplicate-terminal-id');
  });
});

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

describe('the list', () => {

  it('marks a generated board as read-only', () => {
    expect(definitionSummary('pcbas', db.pcbas[0]!, true).readOnly).toBe(true);
  });

  it('counts in words', () => {
    expect(countLabel('wires', 1)).toBe('1 wire stock');
    expect(countLabel('wires', 3)).toBe('3 wire stocks');
  });
});

describe('a new definition\'s id follows its name (50a.29)', () => {
  const blank = { id: '', label: '' };
  it('suggests from the name, unique across the whole library', () => {
    expect(followNameId(blank, { id: '', label: 'SCART male' }, []).id).toBe('scart-male');
    expect(followNameId(blank, { id: '', label: 'SCART male' }, ['scart-male']).id).toBe('scart-male-2');
  });
  it('keeps following while the id is still the suggestion, and stops once the user types one', () => {
    const a = followNameId(blank, { id: '', label: 'Cap' }, []);
    expect(followNameId(a, { ...a, label: 'Cap 220' }, []).id).toBe('cap-220');
    const own = { id: 'my-cap', label: 'Cap' };
    expect(followNameId(own, { ...own, label: 'Cap 220' }, []).id).toBe('my-cap');
    // the id edit itself is left alone
    expect(followNameId(a, { ...a, id: 'typed' }, []).id).toBe('typed');
  });
});
