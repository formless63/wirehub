import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { validateDb, validateDesign, type CableDesign, type Db, type Joint } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { colourFromCode, colourToCode, exportWireViz, gaugeToMm2, importWireViz, lengthToMm, wireviz } from '../src/index.ts';

const db = loadDb();
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An example in WireViz's own documented syntax (written here, not copied). */
const EXAMPLE = `
metadata:
  title: Sensor lead
connectors:
  X1:
    type: Molex KK 254
    subtype: female
    pinlabels: [GND, +5V, SIG]
  X2:
    type: Molex KK 254
    subtype: female
    pincount: 4
    loops: [[3, 4]]
    notes: strain relief on the lead side
cables:
  W1:
    gauge: 24 AWG
    length: 0.5
    colors: [BK, RD, WHBU]
    shield: true
    wirelabels: [ground, supply, signal]
connections:
  -
    - X1: [1-3]
    - W1: [1-3]
    - X2: [1, 2, 3]
  -
    - X1: 1
    - W1: s
`;

const joint = (j: Joint): string => `${j.a.instance}.${j.a.terminal}${j.a.end ?? ''}~${j.b.instance}.${j.b.terminal}${j.b.end ?? ''}`;

describe('colours, gauge and length', () => {
  it('reads codes, stripes and hex; refuses what it does not know', () => {
    expect(colourFromCode('BK')).toBe('black');
    expect(colourFromCode('WHBU')).toBe('white-blue');
    expect(colourFromCode('#FFFF00')).toBe('#ffff00');
    expect(colourFromCode('ZZ')).toBeUndefined();
    expect(colourToCode('white-blue')).toBe('WHBU');
    expect(colourToCode('chartreuse')).toBeUndefined();
  });
  it('converts AWG and units', () => {
    expect(gaugeToMm2('0.25 mm2')).toEqual({ areaMm2: 0.25, converted: false });
    expect(gaugeToMm2('24 AWG')?.areaMm2).toBeCloseTo(0.205, 2);
    expect(gaugeToMm2('thick')).toBeUndefined();
    expect(lengthToMm(0.2)).toBe(200);
    expect(lengthToMm('2.5 ft')).toBe(762);
    expect(lengthToMm('3 parsecs')).toBeUndefined();
  });
});

describe('import', () => {
  const result = importWireViz('sensor-lead.yml', bytes(EXAMPLE), db);
  const design = result.designs![0]!;

  it('proposes connectors, a stock and a design that validate against the library', () => {
    expect(result.definitions!.connectors!.map((c) => c.pins.length)).toEqual([3, 4]);
    expect(result.definitions!.connectors![0]!.pins.map((p) => p.label)).toEqual(['GND', '+5V', 'SIG']);
    expect(result.definitions!.connectors![0]!.gender).toBe('female');
    const stock = result.definitions!.wires![0]!;
    expect(stock.structure.children.map((c) => c.kind)).toEqual(['conductor', 'conductor', 'conductor', 'shield']);
    expect((stock.structure.children[2] as { color?: string }).color).toBe('white-blue');
    expect((stock.structure.children[0] as { areaMm2?: number }).areaMm2).toBeCloseTo(0.205, 2);
    for (const r of [...result.definitions!.connectors!, ...result.definitions!.wires!]) expect(r.src).toContain('INFERRED');
    const merged: Db = { ...db, connectors: [...db.connectors, ...result.definitions!.connectors!], wires: [...db.wires, ...result.definitions!.wires!] };
    expect(validateDb(merged).filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateDesign(design, merged).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('maps connections, the shield, loops, length and wire labels', () => {
    expect(design.id).toBe('sensor-lead');
    expect(design.label).toBe('Sensor lead');
    const joints = design.joints.map(joint);
    expect(joints).toContain('x1.1~w1.w1a');
    expect(joints).toContain('w1.w3b~x2.3');
    expect(joints).toContain('x1.1~w1.shielda');
    expect(joints).toContain('x2.3~x2.4');
    expect(design.instances.segments[0]).toMatchObject({ lengthMm: 500, coreLabels: { w1: 'ground', w2: 'supply', w3: 'signal' } });
    expect(design.instances.connectors[1]!.note).toContain('strain relief');
  });

  it('reports what is lossy and what was inferred, and is deterministic', () => {
    expect(result.notes.some((n) => n.includes('INFERRED'))).toBe(true);
    expect(result.notes.some((n) => n.includes('shield is proposed as foil'))).toBe(true);
    expect(result.notes.some((n) => n.includes('24 AWG converted'))).toBe(true);
    expect(importWireViz('sensor-lead.yml', bytes(EXAMPLE), db)).toEqual(result);
    const withExtras = importWireViz('x.yml', bytes(EXAMPLE.replace('type: Molex KK 254\n    subtype: female\n    pinlabels', 'type: Molex KK 254\n    subtype: female\n    color: BK\n    image: {src: a.png}\n    pinlabels') + 'options:\n  fontname: arial\nadditional_bom_items:\n  - description: x\n'), db);
    const text = withExtras.notes.join('\n');
    expect(text).toContain("Not carried over: connector X1: 'color'");
    expect(text).toContain('Not carried over: additional_bom_items');
    expect(text).toContain("top-level 'options' (rendering only)");
  });

  it('uses a library part only when the file names its identity', () => {
    const conn = db.connectors.find((c) => c.partNumber !== undefined)!;
    const wire = db.wires.find((w) => w.partNumber !== undefined)!;
    const text = `connectors:\n  A:\n    pn: ${conn.partNumber}\n  B:\n    type: unheard-of\n    pincount: 2\ncables:\n  W:\n    pn: ${wire.partNumber}\n    length: 1 m\nconnections:\n  - - A: [1]\n    - W: [1]\n    - B: [1]\n`;
    const r = importWireViz('m.yml', bytes(text), db);
    expect(r.designs![0]!.instances.connectors.map((c) => c.def)).toEqual([conn.id, expect.stringContaining('m-b')]);
    expect(r.designs![0]!.instances.segments[0]!.def).toBe(wire.id);
    expect(r.definitions!.wires).toBeUndefined();
    expect(r.notes.join('\n')).toContain(`matched the library's '${conn.id}'`);
  });

  it('reports bad references instead of guessing', () => {
    const r = importWireViz('bad.yml', bytes(EXAMPLE.replace('X2: [1, 2, 3]', 'X2: [1, 2, 9]').replace('W1: s', 'W1: 7')), db);
    const text = r.notes.join('\n');
    expect(text).toContain("pin '9' is not on X2");
    expect(text).toContain("wire '7' is not on W1");
  });

  it('refuses what is not a harness', () => {
    expect(() => importWireViz('a.yml', bytes('- just\n- a list'), db)).toThrow(/not a WireViz harness/);
    expect(() => importWireViz('a.yml', bytes('a: [unclosed'), db)).toThrow(/not valid YAML/);
    expect(() => importWireViz('a.yml', bytes('metadata: {title: t}'), db)).toThrow(/no connectors or cables/);
  });
});

describe('export and round trip', () => {
  it('writes a YAML a reader can parse, with the loss listed on top', () => {
    const design = loadDesign('de9-crossover');
    const out = exportWireViz(design, db);
    expect(out.fileName).toBe('de9-crossover.wireviz.yml');
    expect(out.body).toContain('# Not carried over: segment w1: 1 pigtail(s).');
    const doc = parse(String(out.body)) as { connectors: Record<string, { loops?: unknown }>; cables: Record<string, { length: number; shield: boolean }>; connections: unknown[] };
    expect(Object.keys(doc.connectors)).toEqual(['J1', 'J2']);
    expect(doc.connectors['J1']!.loops).toEqual([['7', '8'], ['4', '6'], ['4', '1']]);
    expect(doc.cables['W1']).toMatchObject({ length: 1.83, shield: true });
    expect(doc.connections.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const design = loadDesign('de9-crossover');
    expect(exportWireViz(design, db)).toEqual(exportWireViz(design, db));
  });

  /** the joints WireViz can express: pin-to-wire, with a conductor path the stock reads in order */
  const expressible = (design: CableDesign, joints: Joint[]): string[] =>
    joints
      .filter((j) => !`${j.a.terminal}${j.b.terminal}`.includes('pigtail:') && !`${j.a.terminal}${j.b.terminal}`.includes('shell') && !`${j.a.terminal}${j.b.terminal}`.includes('drain'))
      .filter((j) => design.instances.connectors.some((c) => c.id === j.a.instance) || design.instances.connectors.some((c) => c.id === j.b.instance))
      .map(joint)
      .sort();

  for (const id of listDesignIds()) {
    it(`round-trips ${id} through the library with no new parts`, () => {
      const design = loadDesign(id);
      const out = exportWireViz(design, db);
      const back = importWireViz(`${id}.yml`, bytes(String(out.body)), db);
      const again = back.designs![0]!;
      const onlyConnectorsAndStocks =
        design.instances.components.length === 0 && design.instances.pcbas.length === 0 && (design.instances.breakouts ?? []).length === 0 && (design.instances.subassemblies ?? []).length === 0;
      if (!onlyConnectorsAndStocks) {
        // not expressible: the export says so
        expect(String(out.body)).toMatch(/# Not carried over:/);
        return;
      }
      // every connector and stock matched the library by its own part number or label
      expect(back.definitions?.connectors).toBeUndefined();
      expect(back.definitions?.wires).toBeUndefined();
      const rename = (j: string): string => j.toLowerCase();
      const got = new Set(again.joints.map(joint).map(rename));
      for (const j of expressible(design, design.joints)) {
        if (!j.includes('~')) continue;
        expect(got.has(rename(j)), `${id}: ${j}`).toBe(true);
      }
      expect(again.instances.segments.map((s) => s.lengthMm)).toEqual(design.instances.segments.map((s) => s.lengthMm));
    });
  }
});

describe('module', () => {
  it('registers an importer for YAML and an exporter', () => {
    const registry = createRegistry([wireviz]);
    expect(registry.importersFor('harness.yaml').map((i) => i.id)).toEqual(['wireviz-yaml']);
    expect(registry.importersFor('harness.csv')).toEqual([]);
    expect(registry.exporters().map((e) => e.id)).toEqual(['wireviz-yaml']);
  });
});
