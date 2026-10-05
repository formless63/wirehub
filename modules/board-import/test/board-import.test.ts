import { deflateRawSync } from 'node:zlib';

import { loadDb } from '@wirehub/catalog';
import { parseDepictionMeta, stripUnsafeSvg, validateDepiction } from '@wirehub/catalog/src/depictions/index.ts';
import { errors, validateDb, type Db, type PcbaDefinition } from '@wirehub/model';
import { createRegistry, manifestProblems } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import {
  boardImport,
  boardParts,
  boardPartsFromKicad,
  deriveBoard,
  fabBomImporter,
  gerberImporter,
  kicadBoardImporter,
  kicadDepiction,
  layerRole,
  parseExcellon,
  parseKicadNetlist,
  parseKicadPcb,
  plotGerber,
  readBom,
  readGerberSet,
  readZip,
  splitRefs,
  writeZip,
  BOARD_BOM_FORMAT,
} from '../src/index.ts';
import { formatOhms, parseFarads, parseOhms } from '../src/values.ts';
import { BOM_CSV, CPL_CSV, gerberFiles, kicadNetlist, kicadPcb, ODD_BOM_CSV } from './synthetic.ts';

const enc = new TextEncoder();
const SHA = '0'.repeat(64);

function starter(): Db {
  return loadDb();
}

function withBoard(db: Db, pcba: PcbaDefinition): Db {
  return { ...db, pcbas: [...db.pcbas, pcba] };
}

describe('the module', () => {
  it('registers cleanly: three importers and a page', () => {
    expect(manifestProblems([boardImport])).toEqual([]);
    const registry = createRegistry([boardImport]);
    expect(registry.importers().map((i) => i.id)).toEqual(['kicad-board', 'gerbers', 'fab-bom']);
    expect(registry.importersFor('x.kicad_pcb').map((i) => i.id)).toEqual(['kicad-board']);
    expect(registry.importersFor('x.board-bom.json').map((i) => i.id)).toEqual(['fab-bom']);
    expect(registry.routes().map((r) => r.path)).toEqual(['boards']);
  });
});

describe('values', () => {
  it('reads resistances and capacitances as boards print them', () => {
    expect(parseOhms('4k7')).toBe(4700);
    expect(parseOhms('120R')).toBe(120);
    expect(parseOhms('1M')).toBe(1e6);
    expect(parseOhms('330 Ω')).toBe(330);
    expect(formatOhms(4700)).toBe('4.7 kΩ');
    expect(parseFarads('100n')).toBeCloseTo(1e-7);
    expect(parseFarads('4u7')).toBeCloseTo(4.7e-6);
    expect(splitRefs('R1, R2 R5-R7')).toEqual(['R1', 'R2', 'R5', 'R6', 'R7']);
  });
});

describe('KiCad board → PCBA', () => {
  const source = parseKicadPcb(kicadPcb(), 'synthetic-adapter.kicad_pcb');

  it('reads footprints, pads, nets, the title block and the outline', () => {
    expect(source.title).toBe('Synthetic adapter');
    expect(source.revision).toBe('2');
    expect(source.footprints.map((f) => f.ref)).toEqual(['C1', 'C2', 'J1', 'R1', 'R2', 'TP1', 'TP2', 'TP3', 'TP4', 'TP5', 'TP6', 'U1']);
    expect(source.frame).toEqual({ x0: 100, y0: 100, width: 40, height: 20 });
    const tp4 = source.footprints.find((f) => f.ref === 'TP4')!;
    expect(tp4.side).toBe('bottom');
    expect(tp4.pads[0]).toMatchObject({ net: 'GND', x: 110, y: 115, layers: ['B.Cu', 'B.Paste', 'B.Mask'] });
  });

  it('derives terminals with their pads, plain links, links through parts, and leaves decoupling and ICs out', () => {
    const { pcba, notes } = deriveBoard(source, { sha256: SHA });
    expect(pcba).toMatchObject({ id: 'synthetic-adapter-rev-2', label: 'Synthetic adapter', partNumber: 'Synthetic adapter', revision: '2', kicadProject: 'synthetic-adapter' });
    expect(pcba.terminals.map((t) => t.id)).toEqual(['j1.1', 'j1.2', 'j1.3', 'A', 'B', 'GND', 'OUT', '5V']);
    const gnd = pcba.terminals.find((t) => t.id === 'GND')!;
    expect(gnd.pads).toEqual([
      { ref: 'TP3', side: 'top', x: 5, y: 15 },
      { ref: 'TP4', side: 'bottom', x: 10, y: 15 },
    ]);
    expect(pcba.terminals.find((t) => t.id === 'j1.2')).toMatchObject({ label: 'B', pads: [{ ref: 'J1', side: 'both', x: 30, y: 7.54, note: 'pad 2' }] });
    expect(pcba.internalLinks.map((l) => `${l.from}→${l.to}${l.via === undefined ? '' : ` via ${l.via}`}`)).toEqual([
      'j1.1→A',
      'j1.2→B',
      'j1.3→GND',
      'j1.1→j1.2 via R1 120 Ω',
      'j1.2→OUT via R2 1 kΩ → C1 100 nF',
    ]);
    expect(pcba.internalLinks[3]!.elements).toEqual([{ text: 'R1 120 Ω', kind: 'resistor', designator: 'R1', value: '120 Ω', ohms: 120 }]);
    expect(notes.join('\n')).toContain('U1 has more than two nets');
    expect(errors(validateDb(withBoard(starter(), pcba)))).toEqual([]);
  });

  it('reads the same board from its netlist, without positions', () => {
    const fromNet = deriveBoard(parseKicadNetlist(kicadNetlist(), 'synthetic-adapter.net'), { sha256: SHA });
    const fromPcb = deriveBoard(source, { sha256: SHA });
    expect(fromNet.pcba.terminals.map((t) => t.id)).toEqual(fromPcb.pcba.terminals.map((t) => t.id));
    expect(fromNet.pcba.internalLinks).toEqual(fromPcb.pcba.internalLinks);
    expect(fromNet.pcba.terminals.every((t) => t.pads === undefined)).toBe(true);
    expect(fromNet.notes.join('\n')).toContain('A netlist has no pad positions');
  });

  it('integrates a Library connector named in the review step', () => {
    const db = starter();
    const connector = db.connectors.find((c) => c.pins.some((p) => p.id === '1') && c.pins.some((p) => p.id === '3'))!;
    const { pcba } = deriveBoard(source, { sha256: SHA, id: 'adapter-x', connectors: { J1: connector.id } }, db);
    expect(pcba.integratedConnectors).toEqual([{ connectorDefId: connector.id, terminalPrefix: 'j1' }]);
    expect(pcba.terminals.some((t) => t.id.startsWith('j1.'))).toBe(false);
    expect(pcba.internalLinks.slice(0, 3).map((l) => `${l.from}→${l.to}`)).toEqual(['j1.1→A', 'j1.2→B', 'j1.3→GND']);
    expect(errors(validateDb(withBoard(db, pcba)))).toEqual([]);
  });

  it('draws kicad-tier art whose anchors sit on the terminals’ pads and that the host accepts', () => {
    const derived = deriveBoard(source, { sha256: SHA });
    const art = kicadDepiction(source, derived.pcba.id, derived.pads, { path: 'synthetic-adapter.kicad_pcb', sha256: SHA })!;
    const meta = art.meta as { pinAnchors: Record<string, { x: number; y: number; side: string; pads: unknown[] }> };
    expect(meta.pinAnchors['A']).toMatchObject({ x: 5, y: 5, side: 'top' });
    expect(meta.pinAnchors['GND']!.pads).toHaveLength(2);
    for (const svg of Object.values(art.files)) {
      const clean = stripUnsafeSvg(svg);
      expect(clean.error).toBeUndefined();
      expect(clean.removed).toEqual([]);
    }
    const parsed = parseDepictionMeta(art.meta, 'test');
    expect(parsed.issues).toEqual([]);
    expect(errors(validateDepiction(parsed.meta!, { db: withBoard(starter(), derived.pcba) }))).toEqual([]);
  });

  it('is deterministic', async () => {
    const one = await kicadBoardImporter.import({ fileName: 'synthetic-adapter.kicad_pcb', bytes: enc.encode(kicadPcb()) }, starter());
    const two = await kicadBoardImporter.import({ fileName: 'synthetic-adapter.kicad_pcb', bytes: enc.encode(kicadPcb()) }, starter());
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.definitions?.pcbas?.[0]?.src).toMatch(/sha256 [0-9a-f]{16}…/);
  });
});

describe('Gerber set → board art', () => {
  it('plots apertures, macros, arcs, regions and clear polarity', () => {
    const top = gerberFiles().find((f) => f.path.endsWith('.gtl'))!.text;
    const plot = plotGerber(top);
    expect(plot.warnings).toEqual([]);
    expect(plot.attributes['.FileFunction']).toBe('Copper,L1,Top');
    expect(plot.elements.some((e) => !e.dark)).toBe(true);
    // a clockwise quarter arc: small, and counter-clockwise once y points down
    expect(plot.elements.some((e) => e.svg.includes('M110 105A2 2 0 0 0 112 107'))).toBe(true);
    // the macro flash of R1's first pad: R1 at (115, 107.5) rotated 90°, its pad 1 lands 0.775 mm below its centre
    expect(plot.flashes.some((f) => Math.abs(f.x - 115) < 1e-6 && Math.abs(f.y - 108.275) < 1e-6)).toBe(true);
    expect(layerRole('board-F_Cu.gbr')).toBe('copper-top');
    expect(layerRole('board.GBO')).toBe('silk-bottom');
    expect(layerRole('x.gbr', { '.FileFunction': 'Soldermask,Bot' })).toBe('mask-bottom');
  });

  it('reads Excellon drills', () => {
    const { drills } = parseExcellon(gerberFiles().find((f) => f.path.endsWith('.drl'))!.text);
    expect(drills).toHaveLength(3);
    expect(drills[0]).toMatchObject({ x: 130, y: 105, diameter: 1, plated: true });
  });

  it('repeats a step-and-repeat block, and moves only the flashes by %LM/%LR/%LS', () => {
    const file = (body: string): string => ['%FSLAX24Y24*%', '%MOMM*%', '%ADD10C,1.0*%', '%ADD11R,2.0X1.0*%', ...body.split('\n'), 'M02*'].join('\n');
    // 3 x 2 copies, 10 mm across and 5 mm up: one flash and one stroke per copy
    const panel = plotGerber(file('%SRX3Y2I10.0J5.0*%\nD10*\nX10000Y10000D03*\nX10000Y10000D02*\nX20000Y10000D01*\n%SR*%\nX0Y0D03*'));
    expect(panel.warnings).toEqual([]);
    expect(panel.flashes.map((f) => [f.x + 0, f.y + 0]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)).toEqual([
      [0, 0],
      [1, -6],
      [1, -1],
      [11, -6],
      [11, -1],
      [21, -6],
      [21, -1],
    ]);
    expect(panel.strokes).toHaveLength(6);
    // the block's copies are drawn dark; the bounds cover the last copy (the stroke ends at x 2, plus 20, plus its half width; y -6 and up)
    expect(panel.bounds!.x1).toBeCloseTo(22.5);
    expect(panel.bounds!.y0).toBeCloseTo(-6.5);
    expect(panel.elements.filter((e) => e.svg.startsWith('<g transform="translate(20 -5)')).length).toBeGreaterThan(0);
    // %SRX1Y1% ends a block without repeating
    expect(plotGerber(file('%SRX2Y1I4.0J0*%\nD10*\nX0Y0D03*\n%SRX1Y1*%\nX0Y10000D03*')).flashes).toHaveLength(3);
    // a mirrored, rotated and scaled rectangle: only the flash moves, the stroke does not
    const moved = plotGerber(file('D11*\n%LMX*%\n%LR90*%\n%LS2*%\nX10000Y10000D03*\n%LMN*%\n%LR0*%\n%LS1*%\nX20000Y10000D03*\nD10*\nX20000Y10000D02*\nX30000Y10000D01*'));
    expect(moved.warnings).toEqual([]);
    const [flashed, plain] = moved.flashes;
    // 2 x 1 rotated a quarter turn and doubled: 2 x 4 across, so half extents 1 and 2
    expect([flashed!.hw, flashed!.hh]).toEqual([1, 2]);
    expect([plain!.hw, plain!.hh]).toEqual([1, 0.5]);
    expect(moved.elements[0]!.svg).toContain('<g transform="translate(1 -1) scale(2) rotate(-90) scale(-1 1) translate(-1 1)">');
    expect(moved.elements[1]!.svg).not.toContain('<g');
  });

  it('reads inch aperture macros in inches, in millimetres out', () => {
    const inch = plotGerber(
      ['%FSLAX24Y24*%', '%MOIN*%', '%AMPAD*', '1,1,$1,0,0*', '21,1,0.04,$1,0.1,0.05,0*%', '%ADD10PAD,0.02*%', 'D10*', 'X10000Y20000D03*', 'M02*'].join('\n'),
    );
    expect(inch.warnings).toEqual([]);
    const mm = plotGerber(
      ['%FSLAX33Y33*%', '%MOMM*%', '%AMPAD*', '1,1,$1,0,0*', '21,1,1.016,$1,2.54,1.27,0*%', '%ADD10PAD,0.508*%', 'D10*', 'X25400Y50800D03*', 'M02*'].join('\n'),
    );
    // the same pad, 0.02 in = 0.508 mm, at (1 in, 2 in) = (25.4, 50.8) mm
    expect(inch.flashes).toHaveLength(1);
    expect(inch.flashes[0]!.x).toBeCloseTo(25.4);
    expect(inch.flashes[0]!.y).toBeCloseTo(-50.8);
    expect(inch.elements.map((e) => e.svg)).toEqual(mm.elements.map((e) => e.svg));
    expect(inch.flashes[0]!.hw).toBeCloseTo(mm.flashes[0]!.hw);
  });

  it('reads routed Excellon slots, and draws them in the art', () => {
    const drl = [
      'M48',
      'METRIC,TZ',
      'T1C1.000',
      'T2C0.800',
      '%',
      'G90',
      'G05',
      'T1',
      'X10.000Y10.000',
      'G05',
      'T2',
      'X20.000Y5.000G85X26.000Y5.000',
      'G00X30.000Y8.000',
      'M15',
      'G01X30.000Y12.000',
      'G01X34.000Y12.000',
      'M16',
      'X40.000Y40.000',
      'M30',
      '',
    ].join('\n');
    const { drills, warnings } = parseExcellon(drl);
    expect(warnings).toEqual([]);
    expect(drills).toEqual([
      { x: 10, y: -10, diameter: 1 },
      { x: 20, y: -5, diameter: 0.8, to: { x: 26, y: -5 } },
      { x: 30, y: -8, diameter: 0.8, to: { x: 30, y: -12 } },
      { x: 30, y: -12, diameter: 0.8, to: { x: 34, y: -12 } },
      { x: 40, y: -40, diameter: 0.8 },
    ]);
    // inch, with a G85 on its own line
    const inch = parseExcellon(['M48', 'INCH', 'T1C0.0394', '%', 'T1', 'X1.0Y1.0', 'G85X2.0Y1.0', 'M30'].join('\n'));
    expect(inch.drills[1]).toMatchObject({ x: 25.4, y: -25.4, to: { x: 50.8, y: -25.4 } });
  });

  it('reads stored and deflated zip entries', async () => {
    const stored = writeZip([{ path: 'a/b.txt', bytes: enc.encode('hello') }]);
    expect((await readZip(stored)).map((e) => [e.path, new TextDecoder().decode(e.bytes)])).toEqual([['a/b.txt', 'hello']]);
    // a deflated entry, as most zip tools write them
    const data = enc.encode('deflated text, deflated text, deflated text');
    const packed = deflateRawSync(data);
    const zip = writeZip([{ path: 'c.txt', bytes: packed }]);
    // flip the method to deflate (8) in the local and central headers, and set the sizes
    const view = new DataView(zip.buffer);
    view.setUint16(8, 8, true);
    view.setUint32(22, data.length, true);
    const central = 30 + 'c.txt'.length + packed.length;
    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 24, data.length, true);
    expect(new TextDecoder().decode((await readZip(zip))[0]!.bytes)).toBe('deflated text, deflated text, deflated text');
  });

  it('renders top and bottom art over the KiCad import’s pads, every anchor on copper', async () => {
    const source = parseKicadPcb(kicadPcb(), 'synthetic-adapter.kicad_pcb');
    const { pcba } = deriveBoard(source, { sha256: SHA });
    const db = withBoard(starter(), pcba);
    const zip = writeZip(gerberFiles().map((f) => ({ path: f.path, bytes: enc.encode(f.text) })));
    // matched by the Gerbers' KiCad project id, no option needed
    const result = await gerberImporter.import({ fileName: 'fab.zip', bytes: zip }, db);
    const art = result.depictions![0]!;
    expect(art.defId).toBe(pcba.id);
    expect(art.replaces).toEqual(['kicad', 'gerber']);
    const meta = art.meta as { views: Record<string, { sourceKind: string; widthUnits: number; heightUnits: number }>; pinAnchors: Record<string, { x: number; y: number }> };
    expect(meta.views['board-top']).toMatchObject({ sourceKind: 'gerber', widthUnits: 40, heightUnits: 20 });
    expect(meta.pinAnchors['A']).toMatchObject({ x: 5, y: 5 });
    expect(result.notes.join('\n')).not.toMatch(/not on a copper flash/);
    expect(result.notes.join('\n')).toContain('Not drawn: gerbers/synthetic-adapter-job.gbrjob');
    for (const svg of Object.values(art.files)) {
      expect(stripUnsafeSvg(svg).removed).toEqual([]);
      expect(svg).toContain(`id="${pcba.id}-`);
    }
    expect(art.files['board-bottom.svg']).toContain('scale(-1 1)');
    expect(errors(validateDepiction(parseDepictionMeta(art.meta, 't').meta!, { db }))).toEqual([]);
  });

  it('says when a board is not known, and when pads are off the copper', async () => {
    const zip = writeZip(gerberFiles().map((f) => ({ path: f.path, bytes: enc.encode(f.text) })));
    await expect(gerberImporter.import({ fileName: 'fab.zip', bytes: zip }, starter())).rejects.toThrow(/Which board is fab.zip for/);
    const { pcba } = deriveBoard(parseKicadPcb(kicadPcb(), 'synthetic-adapter.kicad_pcb'), { sha256: SHA });
    const moved: PcbaDefinition = { ...pcba, terminals: pcba.terminals.map((t) => (t.id === 'A' ? { ...t, pads: [{ ref: 'TP1', side: 'top', x: 1, y: 1 }] } : t)) };
    const result = await gerberImporter.import({ fileName: 'fab.zip', bytes: zip, options: { board: pcba.id } }, withBoard(starter(), moved));
    expect(result.notes.join('\n')).toMatch(/1 anchored pad\(s\) are not on a copper flash.*A \(TP1/);
  });

  it('draws only the layers it knows', () => {
    const set = readGerberSet(gerberFiles().map((f) => ({ path: f.path, name: f.path.split('/').pop()!, bytes: enc.encode(f.text) })));
    expect(Object.keys(set.layers).sort()).toEqual(['copper-bottom', 'copper-top', 'mask-bottom', 'mask-top', 'outline', 'silk-top']);
    expect(set.project).toBe('synthetic-adapter');
  });
});

describe('fab BOM and placement → parts on the board', () => {
  const pcba = deriveBoard(parseKicadPcb(kicadPcb(), 'synthetic-adapter.kicad_pcb'), { sha256: SHA }).pcba;

  it('finds the columns, splits designators and dedupes parts', () => {
    const { lines, columns } = readBom(BOM_CSV);
    expect(columns).toEqual({ refs: 'Designator', value: 'Comment', footprint: 'Footprint', supplierPart: 'LCSC' });
    expect(lines.find((l) => l.refs.includes('C2'))!.refs).toEqual(['C1', 'C2']);
    const out = boardParts(pcba, { fileName: 'bom.csv', sha256: SHA, text: BOM_CSV }, { fileName: 'cpl.csv', sha256: SHA, text: CPL_CSV }, starter());
    expect(out.components.map((c) => c.id)).toEqual(['capacitor-100nf-0603', 'connector-conn-01x03-pinheader-1x03-p2.54mm-vertical', 'ic-xcvr-soic-8', 'resistor-120r-0603', 'resistor-1k-0603']);
    const cap = out.components.find((c) => c.id === 'capacitor-100nf-0603')!;
    expect(cap).toMatchObject({ kind: 'capacitor', category: 'capacitor', value: '100 nF', package: '0603', suppliers: [{ supplier: 'LCSC', number: 'C0003' }], terminals: [{ id: 'a' }, { id: 'b' }] });
    expect(cap.usedOn).toEqual([{ board: pcba.partNumber, revision: '2', refs: ['C1', 'C2'] }]);
    expect(out.entry.parts.map((p) => `${p.ref}:${p.component}:${p.side ?? '-'}`)).toEqual([
      'C1:capacitor-100nf-0603:top',
      'C2:capacitor-100nf-0603:top',
      'J1:connector-conn-01x03-pinheader-1x03-p2.54mm-vertical:top',
      'R1:resistor-120r-0603:top',
      'R2:resistor-1k-0603:top',
      'U1:ic-xcvr-soic-8:top',
    ]);
    expect(out.notes.join('\n')).toContain('1 part(s) are placed but not in the BOM: TP4');
    expect(errors(validateDb({ ...withBoard(starter(), pcba), components: [...starter().components, ...out.components] }))).toEqual([]);
  });

  it('takes the review step’s column mapping and a bundle of both files', async () => {
    const db = withBoard(starter(), pcba);
    await expect(fabBomImporter.import({ fileName: 'parts.csv', bytes: enc.encode(ODD_BOM_CSV), options: { board: pcba.id } }, db)).rejects.toThrow(/No reference-designator column/);
    const mapped = await fabBomImporter.import(
      { fileName: 'parts.csv', bytes: enc.encode(ODD_BOM_CSV), options: { board: pcba.id, mapping: JSON.stringify({ bom: { refs: 'Where', value: 'What', footprint: 'Shape', mpn: 'Maker PN' } }) } },
      db,
    );
    expect(mapped.definitions?.components?.map((c) => c.id)).toEqual(['rc-0603-120r', 'rc-0603-1k']);
    const bundle = { format: BOARD_BOM_FORMAT, version: 1, bom: { fileName: 'bom.csv', text: BOM_CSV }, cpl: { fileName: 'cpl.csv', text: CPL_CSV } };
    const both = await fabBomImporter.import({ fileName: 'x.board-bom.json', bytes: enc.encode(JSON.stringify(bundle)), options: { board: pcba.id } }, db);
    expect(both.boardParts?.[0]).toMatchObject({ board: pcba.partNumber, revision: '2', sources: [{ path: 'bom.csv', role: 'bom' }, { path: 'cpl.csv', role: 'cpl' }] });
    // a part the Library has (by supplier number) is reused, not proposed
    const known = { ...db, components: [...db.components, { id: 'my-120r', label: '120 Ω', kind: 'resistor', terminals: [], suppliers: [{ supplier: 'LCSC', number: 'C0001' }], src: 'synthetic example' }] };
    const again = await fabBomImporter.import({ fileName: 'x.board-bom.json', bytes: enc.encode(JSON.stringify(bundle)), options: { board: pcba.id } }, known);
    expect(again.definitions?.components?.some((c) => c.id === 'resistor-120r-0603')).toBe(false);
    expect(again.boardParts?.[0]?.parts.find((p) => p.ref === 'R1')?.component).toBe('my-120r');
  });
});

describe('KiCad footprints → components and placed parts (cs-5k1.30)', () => {
  /** the synthetic board with what a real one carries: an MPN and a supplier number on R1, DNP on C2, a fiducial, a hand-fitted jack */
  function board(): string {
    let text = kicadPcb();
    const after = (needle: string, add: string): void => {
      const at = text.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      const end = text.indexOf('\n', at) + 1;
      text = text.slice(0, end) + add + text.slice(end);
    };
    after('(property "Value" "120"', '\t\t(property "MPN" "RC0603FR-07120RL" (at 0 0 0) (layer "F.Fab"))\n\t\t(property "Manufacturer" "Yageo" (at 0 0 0) (layer "F.Fab"))\n\t\t(property "LCSC Part #" "C22787" (at 0 0 0) (layer "F.Fab"))\n');
    after('(property "Value" "Conn_01x03"', '\t\t(attr through_hole exclude_from_bom)\n');
    after('(property "Value" "TestPoint"', '\t\t(attr smd board_only)\n');
    return text;
  }
  const source = parseKicadPcb(board(), 'synthetic-adapter.kicad_pcb');
  const pcba = deriveBoard(source, { sha256: SHA }).pcba;
  const file = { fileName: 'synthetic-adapter.kicad_pcb', sha256: SHA };

  it('proposes one component per distinct part, with the footprint properties as the BOM columns', () => {
    const out = boardPartsFromKicad(pcba, source, file, starter());
    const r1 = out.components.find((c) => c.mpn === 'RC0603FR-07120RL')!;
    expect(r1).toMatchObject({ id: 'rc0603fr-07120rl', category: 'resistor', value: '120 Ω', package: '0603', manufacturer: 'Yageo', suppliers: [{ supplier: 'LCSC', number: 'C22787' }], footprint: 'Resistor_SMD:R_0603_1608Metric' });
    expect(r1.src).toContain('footprint R1');
    expect(r1.src).toContain('KiCad board');
    expect(r1.usedOn).toEqual([{ board: pcba.partNumber, revision: '2', refs: ['R1'] }]);
    // the capacitors are one part, told apart from the rest by category, value and package
    const caps = out.components.filter((c) => c.category === 'capacitor');
    expect(caps.map((c) => c.usedOn![0]!.refs)).toEqual([['C1', 'C2']]);
  });

  it('places every footprint, says what KiCad says of it, and leaves board-only ones out', () => {
    const out = boardPartsFromKicad(pcba, source, file, starter());
    const refs = out.entry.parts.map((p) => p.ref);
    expect(refs).not.toContain('TP5');
    expect(out.entry.parts.find((p) => p.ref === 'J1')).toMatchObject({ excludeFromBom: true, side: 'top', src: 'synthetic-adapter.kicad_pcb:footprint J1' });
    expect(out.entry.parts.find((p) => p.ref === 'TP4')?.side).toBe('bottom');
    expect(out.entry.sources).toEqual([{ path: 'synthetic-adapter.kicad_pcb', sha256: SHA, role: 'kicad' }]);
    expect(out.notes.join('\n')).toMatch(/1 board-only footprint\(s\) left out \(TP5\)/);
    expect(out.notes.join('\n')).toContain('Read from the footprints, not a fab BOM');
    expect(errors(validateDb({ ...withBoard(starter(), pcba), components: [...starter().components, ...out.components] }))).toEqual([]);
  });

  it('reuses a component the Library already has by MPN', () => {
    const known = { ...starter(), components: [...starter().components, { id: 'my-120r', label: '120 Ω', kind: 'resistor' as const, terminals: [], mpn: 'RC0603FR-07120RL', src: 'synthetic example' }] };
    const out = boardPartsFromKicad(pcba, source, file, known);
    expect(out.components.some((c) => c.mpn === 'RC0603FR-07120RL')).toBe(false);
    expect(out.entry.parts.find((p) => p.ref === 'R1')?.component).toBe('my-120r');
    expect(out.reused).toEqual(['my-120r']);
  });

  it('is the kicad-board importer\'s parts option, off by default', async () => {
    const bytes = enc.encode(board());
    const plain = await kicadBoardImporter.import({ fileName: 'synthetic-adapter.kicad_pcb', bytes }, starter());
    expect(plain.definitions?.components).toBeUndefined();
    expect(plain.boardParts).toBeUndefined();
    const withParts = await kicadBoardImporter.import({ fileName: 'synthetic-adapter.kicad_pcb', bytes, options: { parts: 'yes' } }, starter());
    expect(withParts.definitions?.pcbas).toHaveLength(1);
    expect(withParts.definitions?.components?.length).toBeGreaterThan(0);
    expect(withParts.boardParts?.[0]).toMatchObject({ board: withParts.definitions!.pcbas![0]!.partNumber, revision: '2' });
    expect(withParts.depictions).toHaveLength(1);
    // from a netlist too (no positions)
    const net = await kicadBoardImporter.import({ fileName: 'synthetic-adapter.net', bytes: enc.encode(kicadNetlist()), options: { parts: 'yes' } }, starter());
    expect(net.boardParts?.[0]?.parts.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(boardPartsFromKicad(pcba, source, file, starter()))).toBe(JSON.stringify(boardPartsFromKicad(pcba, source, file, starter())));
  });
});
