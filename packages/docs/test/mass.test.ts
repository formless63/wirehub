/** Derived mass: a floor that names what is missing, sub-assemblies counted once, and a BOM CSV that only grows when a mass is recorded. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign, loadDesigns } from '@wirehub/catalog';
import { withAssemblies, type Db } from '@wirehub/model';

import { BOM_HEADERS, BOM_MASS_HEADERS, bomTable, deriveMass } from '../src/index.ts';

const live = loadDb();

/** Every connector, mechanical and wire stock of the starter catalog weighed (synthetic figures). */
const weighed = (db: Db): Db => ({
  ...db,
  connectors: db.connectors.map((c) => ({ ...c, mass: { g: 8.2 } })),
  mechanicals: (db.mechanicals ?? []).map((m) => ({ ...m, mass: { g: 0.3 } })),
  wires: db.wires.map((w) => ({ ...w, massPerLength: { gPerM: 21.5 } })),
});

describe('deriveMass', () => {
  it('gives a floor that names the board without a mass and the run without a length', () => {
    const design = structuredClone(loadDesign('de9-terminal-board'));
    delete design.instances.segments[0]!.lengthMm;
    const mass = deriveMass(design, weighed(live));
    expect(mass.total.bound).toBe('floor');
    // the connector and its backshell are known; the board and the unlengthed run are not counted
    expect(mass.total.g).toBe(8.5);
    expect(mass.missing.map((m) => [m.reason, m.record, m.instances])).toEqual(
      expect.arrayContaining([
        ['no-mass', `pcbas/${design.instances.pcbas[0]!.def}`, ['u1']],
        ['no-length', `wires/${design.instances.segments[0]!.def}`, ['w1']],
      ]),
    );
    expect(mass.missing.every((m) => m.line !== undefined)).toBe(true);
  });

  it('weighs a sub-assembly once, the same with or without explode', () => {
    const db = withAssemblies(weighed(live), { working: loadDesigns() });
    const y = loadDesign('dc-y-from-leads');
    const lead = deriveMass(loadDesign('dc-pigtail-lead'), db).total;
    const block = deriveMass(y, db);
    const exploded = deriveMass(y, db, { explode: true });
    expect(lead.bound).toBe('exact');
    expect(block.total.bound).toBe('exact');
    expect(block.total.g).toBeCloseTo(2 * lead.g! + 8.2, 6);
    expect(exploded.total).toEqual(block.total);
    expect(exploded.lines.some((l) => l.category === 'subassembly')).toBe(false);
    expect(block.lines.filter((l) => l.category === 'subassembly').map((l) => l.rate)).toEqual([
      { gEach: lead.g, bound: 'exact', from: 'designs/dc-pigtail-lead' },
      { gEach: lead.g, bound: 'exact', from: 'designs/dc-pigtail-lead' },
    ]);
  });
});

describe('the BOM CSV', () => {
  const design = loadDesign('de9-crossover');

  it('is unchanged without masses and gains the mass columns and a Mass row with one', () => {
    const plain = bomTable(design, live);
    expect(plain.headers).toEqual(BOM_HEADERS);
    expect(plain.rows.some((r) => r[0] === 'Mass')).toBe(false);

    const wire = design.instances.segments[0]!.def;
    const heavy = bomTable(design, { ...live, wires: live.wires.map((w) => (w.id === wire ? { ...w, massPerLength: { gPerM: 21.5 } } : w)) });
    expect(heavy.headers).toEqual([...BOM_HEADERS, ...BOM_MASS_HEADERS]);
    const mass = heavy.rows.at(-1)!;
    expect(mass[0]).toBe('Mass');
    expect(mass.at(-1)).toBe('floor');
    expect(String(mass[2])).toMatch(/^one unit; \d+ line\(s\) without a mass$/);
    // every other cell is the plain BOM's, byte for byte
    expect(heavy.rows.slice(0, -1).map((r) => r.slice(0, BOM_HEADERS.length))).toEqual(plain.rows);
    const wireRow = heavy.rows.find((r) => r[0] === 'Wire')!;
    expect(wireRow.slice(BOM_HEADERS.length)).toEqual(['', 21.5, 39.345, 'exact']);
  });
});
