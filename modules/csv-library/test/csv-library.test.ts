import { loadDb } from '@wirehub/catalog';
import { validateDb, type Db } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { LIBRARY_KINDS, analyseConnections, analyseCsv, applyMapping, csvLibrary, detectKind, importConnectionList, importLibraryCsv, parseCsv, splitEnd, suggestMapping, templateCsv, toCsv } from '../src/index.ts';

const db = loadDb();
const bytes = (t: string): Uint8Array => new TextEncoder().encode(t);

describe('csv', () => {
  it('reads quotes, doubled quotes, CRLF, a BOM and blank lines, and round-trips', () => {
    const rows = [['a', 'b,c', 'say "hi"'], ['1', '', 'two\nlines']];
    expect(parseCsv(`﻿${toCsv(rows)}\r\n\r\n`)).toEqual(rows);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('x,y')).toEqual([['x', 'y']]);
  });
});

describe('templates', () => {
  for (const kind of LIBRARY_KINDS) {
    it(`the ${kind} template imports its own example row with no problems`, () => {
      const analysis = analyseCsv(templateCsv(kind), db);
      expect(analysis.rows).toHaveLength(1);
      expect(analysis.rows[0]!.problems).toEqual([]);
      expect(analysis.rows[0]!.status).toBe('new');
      expect(analysis.records[kind]).toHaveLength(1);
      expect(analysis.records[kind][0]!.src).toBe('synthetic example');
    });
  }
});

const COMPONENTS = `type,id,label,kind,value,package,terminals,src,unit_cost,currency,cost_breaks
component,r-1k,1 kΩ resistor,resistor,1 kΩ,0603,2,datasheet A,0.003,USD,1000:0.002
component,,22 nF cap,capacitor,22 nF,0603,,datasheet B,,,
component,r-bad,No source,resistor,5 kΩ,0603,2,,,,
component,r-1k,Duplicate id,resistor,2 kΩ,0603,2,datasheet C,,,
component,r-cost,Bad cost,resistor,7 kΩ,0603,2,datasheet D,abc,,
component,r-cur,Bad currency,resistor,7 kΩ,0603,2,datasheet D,1,dollars,
widget,x,Unknown type,,,,,s,,,
`;

describe('components through the importer', () => {
  const analysis = analyseCsv(COMPONENTS, db);
  it('proposes valid rows with src and prices, deriving a missing id from the name', () => {
    expect(analysis.records.components.map((c) => c.id)).toEqual(['r-1k', '22-nf-cap']);
    const first = analysis.records.components[0]!;
    expect(first.src).toBe('datasheet A');
    expect(first.cost).toEqual({ unit: 0.003, currency: 'USD', breaks: [{ minQty: 1000, unit: 0.002 }] });
    expect(analysis.records.components[0]!.terminals).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
  it('lists invalid rows with their reasons and never half-imports them', () => {
    const byRow = new Map(analysis.rows.map((r) => [r.row, r]));
    expect(byRow.get(4)!.problems.join()).toContain('no source');
    expect(byRow.get(5)!.problems.join()).toContain('already used on line 2');
    expect(byRow.get(6)!.problems.join()).toContain("unit_cost 'abc'");
    expect(byRow.get(7)!.problems.join()).toContain('three-letter');
    expect(byRow.get(8)!.problems.join()).toContain("type 'widget'");
    expect(analysis.rows.filter((r) => r.status === 'invalid').map((r) => r.row)).toEqual([4, 5, 6, 7, 8]);
  });
  it('the importer states the counts and one note per bad line, and is deterministic', () => {
    const result = importLibraryCsv('parts.csv', bytes(COMPONENTS), db);
    expect(result.notes[0]).toBe('parts.csv: 7 rows, 2 new, 0 already in the library, 5 invalid.');
    expect(result.notes.filter((n) => n.includes('was not imported'))).toHaveLength(5);
    expect(result.definitions!.components).toHaveLength(2);
    expect(importLibraryCsv('parts.csv', bytes(COMPONENTS), db)).toEqual(result);
    const merged: Db = { ...db, components: [...db.components, ...result.definitions!.components!] };
    expect(validateDb(merged).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('the other kinds', () => {
  it('builds connectors from a pin count or a list, with labels', () => {
    const text = `type,id,label,family,gender,pins,pin_labels,contact_rating_a,src\nconnector,c-a,Nine pin,D-Sub,female,9,,3,sheet\nconnector,c-b,Three pin,Header,,1;2;gnd,A;B;GND,,sheet\nconnector,c-c,Mismatch,Header,,1;2,A,,sheet\n`;
    const a = analyseCsv(text, db);
    expect(a.records.connectors.map((c) => c.pins.length)).toEqual([9, 3]);
    expect(a.records.connectors[1]!.pins.map((p) => p.label)).toEqual(['A', 'B', 'GND']);
    expect(a.rows[2]!.problems.join()).toContain('pin_labels has 1 entries for 2 pins');
  });
  it('builds a wire stock from colours, area and a shield', () => {
    const text = `type,id,label,colours,area_mm2,shield,od_mm,unit_cost,src\nwire,w-3,Three core,red;black;white,0.5,foil,4.2,0.9,sheet\n`;
    const a = analyseCsv(text, db);
    const wire = a.records.wires[0] as { structure: { children: { kind: string; color?: string }[] }; cost: unknown };
    expect(wire.structure.children.map((c) => c.kind)).toEqual(['conductor', 'conductor', 'conductor', 'shield']);
    expect(wire.cost).toEqual({ unit: 0.9 });
    expect(analyseCsv(`type,id,label,conductors,colours,src\nwire,w,W,3,red;black,s\n`, db).rows[0]!.problems.join()).toContain('colours lists 2 for 3 conductors');
  });
  it('builds mechanicals and refuses a bad kind', () => {
    const a = analyseCsv(`type,label,kind,revision,src\nmechanical,Hood,shell,A,s\nmechanical,Odd,gizmo,,s\n`, db);
    expect(a.records.mechanicals.map((m) => m.id)).toEqual(['hood']);
    expect(a.rows[1]!.problems.join()).toContain('shell, fastener or other');
  });
});

describe('existing records and the dry run', () => {
  it('shows an id the library has as existing, with the fields that differ, and never proposes it', () => {
    const have = db.components[0]!;
    const text = `type,id,label,kind,src\ncomponent,${have.id},Renamed,${have.kind},new source\n`;
    const a = analyseCsv(text, db);
    expect(a.rows[0]).toMatchObject({ status: 'exists', id: have.id });
    expect(a.rows[0]!.differs).toContain('label');
    expect(a.records.components).toEqual([]);
  });
  it('flags a part number the library already uses on another record', () => {
    const pn = db.connectors.find((c) => c.partNumber !== undefined)!.partNumber!;
    const a = analyseCsv(`type,id,label,family,pins,part_number,src\nconnector,dup-pn,Dup,X,2,${pn},s\n`, db);
    expect(a.rows[0]!.status).toBe('invalid');
  });
  it('a batch source fills rows with none, and a file with no type needs a recognisable header', () => {
    const a = analyseCsv(`type,label,kind,src\nmechanical,Nut,fastener,\n`, db, { batchSrc: 'catalog 2026' });
    expect(a.records.mechanicals[0]!.src).toBe('catalog 2026');
    expect(analyseCsv('id,label\nx,y\n', db).notes[0]).toContain('no type column');
    expect(detectKind(['Name', 'Family', 'Pins'])).toBe('connectors');
    expect(analyseCsv('id,label,family,pins,src\nc-z,Z,F,2,s\n', db).records.connectors).toHaveLength(1);
  });
});

describe('column mapping', () => {
  const sheet = parseCsv('Part,Description,Maker no,Cost,Where from\nCON-1,Pin header,HDR-2,0.10,vendor page\nCON-2,Pin socket,HDR-3,0.12,\n');
  it('suggests the columns a spreadsheet\'s headers name', () => {
    const m = suggestMapping('components', ['Part', 'Description', 'Maker no', 'Cost', 'Source']);
    expect(m).toMatchObject({ part_number: 0, label: 1, unit_cost: 3, src: 4 });
  });
  it('writes the canonical file with the batch source and fixed values filled in, which imports as the dry run said', () => {
    const mapping = { part_number: 0, label: 1, mpn: 2, unit_cost: 3, src: 4 };
    const csv = applyMapping(sheet, 'components', mapping, 'supplier catalog', { kind: 'other', currency: 'EUR' });
    const a = analyseCsv(csv, db);
    expect(a.rows.map((r) => r.problems)).toEqual([[], []]);
    expect(a.records.components.map((c) => [c.partNumber, c.src, c.cost?.currency])).toEqual([['CON-1', 'vendor page', 'EUR'], ['CON-2', 'supplier catalog', 'EUR']]);
    // without a kind the dry run says so for each row
    expect(analyseCsv(applyMapping(sheet, 'components', mapping, 'x'), db).rows.map((r) => r.problems)).toEqual([['no kind'], ['no kind']]);
  });
});

describe('module', () => {
  it('registers a CSV importer', () => {
    expect(createRegistry([csvLibrary]).importersFor('parts.csv').map((i) => i.id)).toEqual(['library-csv', 'connection-list']);
  });
});

describe('connection list → design (cs-8c4)', () => {
  const LIST = `From,To,Note
J1.2,J2.3,crossover
J1.3,J2.2,crossover
J1.5,J2.5,ground
J1.2,J2.3,again
J1.9,J2.99,no such pin
X7.1,J2.1,unknown part
J1.1,J1.1,itself
bad,J2.1,
`;
  const options = { parts: JSON.stringify({ J1: 'de9-male', J2: 'de9-female' }), design: 'my-crossover', label: 'My crossover' };

  it('reads from/to pins as direct joints between connector instances, and says why a row was left out', () => {
    const a = analyseConnections('lead.csv', LIST, db, { parts: { J1: 'de9-male', J2: 'de9-female' }, design: 'my-crossover', label: 'My crossover' });
    expect(a.design).toMatchObject({ id: 'my-crossover', label: 'My crossover', schemaVersion: 4 });
    expect(a.design!.instances.connectors).toEqual([
      { id: 'j1', def: 'de9-male' },
      { id: 'j2', def: 'de9-female' },
    ]);
    expect(a.design!.joints).toEqual([
      { a: { instance: 'j1', terminal: '2' }, b: { instance: 'j2', terminal: '3' }, note: 'crossover' },
      { a: { instance: 'j1', terminal: '3' }, b: { instance: 'j2', terminal: '2' }, note: 'crossover' },
      { a: { instance: 'j1', terminal: '5' }, b: { instance: 'j2', terminal: '5' }, note: 'ground' },
    ]);
    const why = new Map(a.rows.map((r) => [r.row, r.problems.join('; ')]));
    expect(why.get(5)).toContain('already joined');
    expect(why.get(6)).toContain("de9-female has no pin '99'");
    expect(why.get(7)).toContain("part 'X7' is not a library connector");
    expect(why.get(8)).toContain('joined to itself');
    expect(why.get(9)).toContain('is not <part>.<pin>');
    expect(a.rows.filter((r) => r.status === 'joint').map((r) => r.row)).toEqual([2, 3, 4]);
    expect(a.parts.map((p) => [p.name, p.connector])).toEqual([['J1', 'de9-male'], ['J2', 'de9-female'], ['X7', undefined]]);
    expect(a.notes.join('\n')).toContain('X7');
    expect(a.notes.join('\n')).toContain('direct pin to pin');
  });

  it('finds a connector by its own name when the part is named after one, by id, label or part number', () => {
    const csv = 'from,to\nde9-male.1,de9-female.1\n"DE-9 male, pins by number".2,DE-9 female, pins by number.2\n';
    const a = analyseConnections('x.csv', csv, db);
    expect(a.parts.map((p) => p.connector)).toEqual(['de9-male', 'de9-female']);
    expect(a.design?.joints.length).toBe(1);
    // J1:3 splits at the colon, so a dotted pin id survives
    expect(splitEnd('J1:A.1')).toEqual({ part: 'J1', pin: 'A.1' });
    expect(splitEnd('J1.3')).toEqual({ part: 'J1', pin: '3' });
    expect(splitEnd('J13')).toBeUndefined();
  });

  it('with a wire stock the rows are its conductors, in order or by the core column', () => {
    const csv = 'from,to,core\nJ1.2,J2.3,red\nJ1.3,J2.2,\nJ1.5,J2.5,black\nJ1.1,J2.1,\n';
    const a = analyseConnections('lead.csv', csv, db, { parts: { J1: 'de9-male', J2: 'de9-female' }, wire: 'dc-2core-24awg' });
    expect(a.design!.instances.segments).toEqual([{ id: 'w1', def: 'dc-2core-24awg' }]);
    expect(a.design!.joints).toEqual([
      { a: { instance: 'j1', terminal: '2' }, b: { instance: 'w1', terminal: 'red', end: 'a' } },
      { a: { instance: 'w1', terminal: 'red', end: 'b' }, b: { instance: 'j2', terminal: '3' } },
      { a: { instance: 'j1', terminal: '3' }, b: { instance: 'w1', terminal: 'black', end: 'a' } },
      { a: { instance: 'w1', terminal: 'black', end: 'b' }, b: { instance: 'j2', terminal: '2' } },
    ]);
    // row 3 took the next free conductor (black), so row 4's black is used and row 5 has none left
    expect(a.rows.map((r) => r.status)).toEqual(['joint', 'joint', 'skipped', 'skipped']);
    expect(a.rows[2]!.problems.join()).toContain('already used');
    expect(a.rows[3]!.problems.join()).toContain('no conductor left');
    expect(() => analyseConnections('x.csv', csv, db, { wire: 'no-such-stock' })).toThrow(/no wire stock/);
  });

  it('the proposed design passes the library checks, and the importer returns it with notes', () => {
    const out = importConnectionList({ fileName: 'lead.csv', bytes: bytes(LIST), options }, db);
    expect(out.designs).toHaveLength(1);
    expect(validateDb({ ...db, designs: undefined } as Db).filter((i) => i.severity === 'error')).toEqual([]);
    expect(out.notes[0]).toBe('3 joint(s) from 3 connection(s).');
    // deterministic
    expect(JSON.stringify(importConnectionList({ fileName: 'lead.csv', bytes: bytes(LIST), options }, db))).toBe(JSON.stringify(out));
  });

  it('refuses a file with no from/to columns, or no usable row', () => {
    expect(() => analyseConnections('x.csv', 'a,b\n1,2\n', db)).not.toThrow(); // a and b are valid column names
    expect(() => analyseConnections('x.csv', 'pin,thing\n1,2\n', db)).toThrow(/needs a from column and a to column/);
    expect(() => importConnectionList({ fileName: 'x.csv', bytes: bytes('from,to\nX.1,Y.1\n') }, db)).toThrow(/no usable connection/);
    expect(() => importConnectionList({ fileName: 'x.csv', bytes: bytes(LIST), options: { parts: '{oops' } }, db)).toThrow(/not JSON/);
  });

  it('is a second importer of the module, beside the library CSV', () => {
    expect(csvLibrary.importers?.map((i) => i.id)).toEqual(['library-csv', 'connection-list']);
    const registry = createRegistry([csvLibrary]);
    expect(registry.importers().map((i) => `${i.module}/${i.id}`)).toEqual(['csv-library/library-csv', 'csv-library/connection-list']);
  });
});
