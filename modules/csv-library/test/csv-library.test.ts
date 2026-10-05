import { loadDb } from '@wirehub/catalog';
import { validateDb, type Db } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { LIBRARY_KINDS, analyseConnections, analyseCsv, applyMapping, csvLibrary, detectKind, importConnectionList, importLibraryCsv, importLibraryFile, parseCsv, readXlsx, splitEnd, suggestMapping, templateCsv, toCsv } from '../src/index.ts';

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
    expect(createRegistry([csvLibrary]).importersFor('parts.csv').map((i) => i.id)).toEqual(['library-csv', 'library-csv-update', 'connection-list']);
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

  it('is an importer of the module, beside the library CSV ones', () => {
    expect(csvLibrary.importers?.map((i) => i.id)).toEqual(['library-csv', 'library-csv-update', 'connection-list']);
    const registry = createRegistry([csvLibrary]);
    expect(registry.importers().map((i) => `${i.module}/${i.id}`)).toEqual(['csv-library/library-csv', 'csv-library/library-csv-update', 'csv-library/connection-list']);
  });
});

const HEAD_COMPONENT = 'type,id,label,kind,value,package,terminals,src,unit_cost';

describe('update existing', () => {
  const existing = db.components[0]!; // r-150
  const row = (over: Partial<Record<string, string>> = {}): string => {
    const c: Record<string, string> = { id: existing.id, label: existing.label, kind: 'resistor', value: existing.value ?? '', package: existing.package ?? '', terminals: '', src: 'datasheet X', unit_cost: '', ...over };
    return `${HEAD_COMPONENT}\ncomponent,${['id', 'label', 'kind', 'value', 'package', 'terminals', 'src', 'unit_cost'].map((k) => `"${c[k]}"`).join(',')}\n`;
  };

  it('without update mode an existing id is skipped and the differences listed', () => {
    const a = analyseCsv(row({ package: '0805' }), db);
    expect(a.rows[0]).toMatchObject({ status: 'exists', differs: ['package'] });
    expect(a.updates.components).toEqual([]);
  });

  it('diffs and applies: the changed fields, the whole record kept otherwise, the file\'s src', () => {
    const a = analyseCsv(row({ package: '0805', unit_cost: '0.01' }), db, { update: true });
    expect(a.rows[0]).toMatchObject({ status: 'update', differs: ['package', 'cost', 'src'] });
    expect(a.rows[0]!.changes!.find((c) => c.field === 'package')).toEqual({ field: 'package', before: 'axial', after: '0805' });
    const updated = a.updates.components[0]!;
    expect(updated).toMatchObject({ id: existing.id, package: '0805', partNumber: existing.partNumber, tolerance: existing.tolerance, terminals: existing.terminals, cost: { unit: 0.01 }, src: 'datasheet X' });
    expect(a.records.components).toEqual([]);
  });

  it('a row that changes nothing is unchanged, even with a different citation', () => {
    const a = analyseCsv(row(), db, { update: true });
    expect(a.rows[0]).toMatchObject({ status: 'exists', differs: [] });
    expect(a.updates.components).toEqual([]);
  });

  it('a new id in update mode is still new, and a bad update is invalid and not applied', () => {
    const csv = `${HEAD_COMPONENT}\ncomponent,r-new,New one,resistor,1 kΩ,0603,2,datasheet,\ncomponent,${existing.id},"${existing.label}",,,,,datasheet,\n`;
    const a = analyseCsv(csv, db, { update: true });
    expect(a.rows.map((r) => r.status)).toEqual(['new', 'invalid']);
    expect(a.rows[1]!.problems.join()).toContain('no kind');
    expect(a.records.components.map((c) => c.id)).toEqual(['r-new']);
  });

  it('the importer proposes updates beside new records, and notes them', () => {
    const csv = row({ package: '0805' }).trimEnd() + '\ncomponent,r-new,New one,resistor,1 kΩ,0603,2,datasheet,\n';
    const r = importLibraryCsv('p.csv', bytes(csv), db, { update: true });
    expect(r.definitions!.components!.map((c) => c.id)).toEqual(['r-new']);
    expect(r.updates!.components!.map((c) => c.id)).toEqual([existing.id]);
    expect(r.notes.join('\n')).toContain('1 to update');
  });

  it('connector pins keep what they carry beyond a label; a flat wire stock is replaced, a structured one left alone', () => {
    const male = db.connectors.find((c) => c.id === 'de9-male')!;
    const pins = male.pins.map((p) => p.id).join(';');
    const csv = `type,id,label,family,pins,src,contact_rating_a\nconnector,de9-male,"${male.label}",${male.family},${pins},cited,5\n`;
    const a = analyseCsv(csv, db, { update: true });
    expect(a.rows[0]!.problems).toEqual([]);
    expect(a.updates.connectors[0]!.pins).toEqual(male.pins);
    expect(a.updates.connectors[0]!.contactRatingA).toBe(5);
    const wire = db.wires.find((w) => w.id === 'cat5e-utp')!;
    const w = analyseCsv(`type,id,label,conductors,colours,src,od_mm\nwire,cat5e-utp,"${wire.label}",2,red;black,cited,6\n`, db, { update: true });
    expect(w.updates.wires[0]!.structure).toEqual(wire.structure);
    expect(w.updates.wires[0]!.odMm).toBe(6);
    expect(w.notes.join()).toContain('structure');
  });
});

describe('boards and kits', () => {
  const PCBA = 'type,id,label,part_number,revision,terminals,terminal_labels,links,src\n';
  it('imports a board with terminals and declared continuity', () => {
    const a = analyseCsv(`${PCBA}pcba,my-board,My board,PCA-9,B,a;b;gnd,A in;B out;Ground,a>b:C1 100 nF;gnd>gnd,datasheet\n`, db);
    expect(a.rows[0]!.problems).toEqual([]);
    expect(a.records.pcbas[0]).toMatchObject({ id: 'my-board', partNumber: 'PCA-9', revision: 'B', terminals: [{ id: 'a', label: 'A in' }, { id: 'b', label: 'B out' }, { id: 'gnd', label: 'Ground' }], internalLinks: [{ from: 'a', to: 'b', via: 'C1 100 nF' }, { from: 'gnd', to: 'gnd' }] });
  });
  it('refuses a board with a link to a terminal it does not have, or a bad link', () => {
    const a = analyseCsv(`${PCBA}pcba,b1,B1,P,A,a;b,,a>zz,s\npcba,b2,B2,P2,A,a;b,,a-b,s\n`, db);
    expect(a.rows.map((r) => r.status)).toEqual(['invalid', 'invalid']);
    expect(a.rows[1]!.problems.join()).toContain('from>to');
  });
  it('updates a board without losing pads or structured links', () => {
    const board = db.pcbas[0]!;
    const links = board.internalLinks.map((l) => `${l.from}>${l.to}${l.via === undefined ? '' : `:${l.via}`}`).join(';');
    const csv = `${PCBA}pcba,${board.id},"${board.label}",${board.partNumber},Rev2,${board.terminals.map((t) => t.id).join(';')},,${links},cited\n`;
    const a = analyseCsv(csv, db, { update: true });
    expect(a.rows[0]).toMatchObject({ status: 'update', differs: ['revision', 'src'] });
    expect(a.updates.pcbas[0]).toMatchObject({ terminals: board.terminals, internalLinks: board.internalLinks, integratedConnectors: board.integratedConnectors });
  });
  it('imports a kit from kind:id:quantity lines, and refuses a part the library does not have', () => {
    const KIT = 'type,id,label,sku,contents,src\n';
    const ok = analyseCsv(`${KIT}kit,kit-a,Kit A,KIT-9,connector:de9-male;mechanical:jackscrew-4-40:2,cited\n`, db);
    expect(ok.records.kits[0]!.contents).toEqual([{ part: { kind: 'connector', def: 'de9-male' }, qty: 1 }, { part: { kind: 'mechanical', def: 'jackscrew-4-40' }, qty: 2 }]);
    const bad = analyseCsv(`${KIT}kit,kit-b,Kit B,KIT-8,connector:nope:1,cited\nkit,kit-c,Kit C,KIT-7,widget:x,cited\n`, db);
    expect(bad.rows.map((r) => r.status)).toEqual(['invalid', 'invalid']);
    expect(bad.rows[0]!.problems.join()).toContain('does not have');
  });
  it('a kit and a part may share an id, since kits have their own id space; updating a kit keeps line notes', () => {
    const kit = db.kits![0]!;
    const contents = kit.contents.map((l) => `${l.part.kind}:${l.part.def}:${l.qty + 1}`).join(';');
    const a = analyseCsv(`type,id,label,sku,contents,src\nkit,${kit.id},${kit.label},${kit.sku},${contents},cited\n`, db, { update: true });
    expect(a.rows[0]!.status).toBe('update');
    expect(a.updates.kits[0]!.contents.map((l) => [l.qty, l.src])).toEqual(kit.contents.map((l) => [l.qty + 1, l.src]));
  });
});

/** A one-sheet workbook as a zip, hand-built: stored or deflated entries, shared strings or inline. */
function workbook(sheetXml: string, options: { deflate: boolean; shared?: string[] }): Uint8Array {
  const crc = (data: Uint8Array): number => {
    let c = ~0;
    for (const b of data) {
      c ^= b;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const files: [string, string][] = [
    ['xl/workbook.xml', '<workbook xmlns:r="x"><sheets><sheet name="Parts" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml],
    ...(options.shared === undefined ? [] : ([['xl/sharedStrings.xml', `<sst>${options.shared.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`]] as [string, string][])),
  ];
  const out: number[] = [];
  const central: number[] = [];
  const le = (v: number, n: number): number[] => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xff);
  for (const [name, text] of files) {
    const raw = new TextEncoder().encode(text);
    const data = options.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nm = [...new TextEncoder().encode(name)];
    const method = options.deflate ? 8 : 0;
    const common = [...le(0, 2), ...le(method, 2), ...le(0, 4), ...le(crc(raw), 4), ...le(data.length, 4), ...le(raw.length, 4), ...le(nm.length, 2), ...le(0, 2)];
    central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...common.slice(0, 16), ...common.slice(16), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(out.length, 4), ...nm);
    out.push(...le(0x04034b50, 4), ...le(20, 2), ...common, ...nm, ...data);
  }
  const dir = out.length;
  out.push(...central, ...le(0x06054b50, 4), ...le(0, 4), ...le(files.length, 2), ...le(files.length, 2), ...le(central.length, 4), ...le(dir, 4), ...le(0, 2));
  return Uint8Array.from(out);
}

describe('XLSX input', () => {
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>src</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>r-xlsx</t></is></c><c r="B2"><v>12.5</v></c><c r="D2" t="s"><v>2</v></c></row>' +
    '</sheetData></worksheet>';
  for (const deflate of [false, true]) {
    it(`reads shared and inline strings, numbers and skipped columns (${deflate ? 'deflated' : 'stored'})`, async () => {
      const rows = await readXlsx(workbook(sheet, { deflate, shared: ['id', 'value', 'cited &amp; checked'] }));
      expect(rows).toEqual([['id', 'value', '', 'src'], ['r-xlsx', '12.5', '', 'cited & checked']]);
    });
  }
  it('imports a workbook like the CSV of its sheet, in both modes', async () => {
    const xml =
      '<worksheet><sheetData><row r="1">' +
      ['type', 'id', 'label', 'kind', 'value', 'package', 'src'].map((h, i) => `<c r="${'ABCDEFG'[i]}1" t="inlineStr"><is><t>${h}</t></is></c>`).join('') +
      '</row><row r="2">' +
      ['component', 'r-xlsx', 'Sheet resistor', 'resistor', '2 kΩ', '0603', 'datasheet'].map((h, i) => `<c r="${'ABCDEFG'[i]}2" t="inlineStr"><is><t>${h}</t></is></c>`).join('') +
      '</row></sheetData></worksheet>';
    const file = workbook(xml, { deflate: true });
    const first = await importLibraryFile('parts.xlsx', file, db);
    expect(first.definitions!.components!.map((c) => c.id)).toEqual(['r-xlsx']);
    const withIt: typeof db = { ...db, components: [...db.components, first.definitions!.components![0]!] };
    expect((await importLibraryFile('parts.xlsx', file, withIt)).notes.join()).toContain('already in the library');
    expect((await importLibraryFile('parts.xlsx', file, withIt, { update: true })).notes.join()).toContain('changes nothing');
  });
  it('says what is wrong with a file that is not a workbook', async () => {
    await expect(readXlsx(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('not an XLSX workbook');
  });
});
