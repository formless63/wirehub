import { loadDb } from '@wirehub/catalog';
import { validateDb, type Db } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { LIBRARY_KINDS, analyseCsv, applyMapping, csvLibrary, detectKind, importLibraryCsv, parseCsv, suggestMapping, templateCsv, toCsv } from '../src/index.ts';

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
    expect(createRegistry([csvLibrary]).importersFor('parts.csv').map((i) => i.id)).toEqual(['library-csv']);
  });
});
