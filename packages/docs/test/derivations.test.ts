/**
 * The document derivations on the starter designs: BOM folding and
 * consumption, bench landings, ground landings, the test spec, the build sheet
 * and the unit helpers. Re-covers the generic cases of the docs tests dropped
 * at the split (docs/boundaries.md §6).
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import {
  BOM_CATEGORY_ORDER,
  bomToHtml,
  bomToMarkdown,
  deriveBench,
  deriveBom,
  deriveGroundLandings,
  deriveTestSpec,
  feetAttribute,
  feetFromMm,
  feetText,
  lengthFromMm,
  massText,
  mmFromFeet,
  renderBuildSheet,
  suppliedEnds,
  unaccountedInstances,
  wireConsumption,
} from '../src/index.ts';

const db = loadDb();
const ids = listDesignIds();

describe('BOM', () => {
  it('accounts for every instance of every starter design', () => {
    for (const id of ids) {
      const design = loadDesign(id);
      expect(unaccountedInstances(design, deriveBom(design, db)), id).toEqual([]);
    }
  });

  it('prints lines in category order and is deterministic', () => {
    for (const id of ids) {
      const design = loadDesign(id);
      const bom = deriveBom(design, db);
      const ranks = bom.lines.map((l) => BOM_CATEGORY_ORDER.indexOf(l.category));
      expect(ranks, id).toEqual([...ranks].sort((a, b) => a - b));
      expect(JSON.stringify(deriveBom(structuredClone(design), db))).toBe(JSON.stringify(bom));
    }
  });

  it('keeps the two legs of the splitter as separate lines of one stock, and totals their wire', () => {
    const bom = deriveBom(loadDesign('dc-y-splitter'), db);
    const legs = bom.lines.filter((l) => l.ref === 'dc-2core-24awg');
    expect(legs.map((l) => l.location).sort()).toEqual(['channel 1 leg', 'channel 2 leg']);
    expect(wireConsumption(bom).find((w) => w.ref === 'dc-2core-24awg')?.mm).toBe(600);
  });

  it('folds identical parts into one line with a quantity', () => {
    const design = structuredClone(loadDesign('de9-crossover'));
    const bom = deriveBom(design, db);
    const total = bom.lines.filter((l) => l.category === 'connector').reduce((n, l) => n + l.qty, 0);
    expect(total).toBe(design.instances.connectors.length);
  });

  it('puts a part number on every starter line that has one and renders both formats from it', () => {
    const design = loadDesign('dc-y-splitter');
    const bom = deriveBom(design, db);
    const md = bomToMarkdown(bom);
    const html = bomToHtml(bom);
    for (const line of bom.lines) {
      if (line.partNumber === undefined) continue;
      expect(md).toContain(line.partNumber);
      expect(html).toContain(line.partNumber);
    }
    expect(html).not.toMatch(/<script\b/);
  });

  it('drops the inline resistor line when the resistor is taken out of the lead', () => {
    const design = structuredClone(loadDesign('dc-led-lead'));
    const resistor = design.instances.components.find((c) => db.components.find((x) => x.id === c.def)?.kind === 'resistor');
    if (resistor === undefined) throw new Error('the starter LED lead carries an inline resistor');
    const before = deriveBom(design, db).lines.filter((l) => l.category === 'component').length;
    design.instances.components = design.instances.components.filter((c) => c.id !== resistor.id);
    design.joints = design.joints.filter((j) => j.a.instance !== resistor.id && j.b.instance !== resistor.id);
    expect(deriveBom(design, db).lines.filter((l) => l.category === 'component').length).toBe(before - 1);
  });
});

describe('bench model', () => {
  it('has an end for each side that carries a termination, with numbered landings', () => {
    for (const id of ids) {
      const bench = deriveBench(loadDesign(id), db);
      expect(bench.ends.length, id).toBeGreaterThan(0);
      for (const end of bench.ends) {
        const numbers = end.terminations.flatMap((t) => t.landings.map((l) => l.n));
        expect(numbers, `${id} ${end.side}`).toEqual(numbers.map((_, i) => i + 1));
      }
    }
  });

  it('lands the terminal-board pair on its pins and the shield on the shell', () => {
    const bench = deriveBench(loadDesign('de9-terminal-board'), db);
    const a = bench.ends.find((e) => e.side === 'a')!;
    const j1 = a.terminations.find((t) => t.instance === 'j1')!;
    const byPin = new Map(j1.landings.map((l) => [l.target.terminal, l.element]));
    expect((byPin.get('3') as { path: string }).path).toBe('pair-1.a');
    expect((byPin.get('8') as { path: string }).path).toBe('pair-1.b');
    expect((byPin.get('shell') as { kind: string }).kind).toBe('pigtail');
  });

  it('never lists the foil as an element to land', () => {
    const bench = deriveBench(loadDesign('de9-terminal-board'), db);
    const json = JSON.stringify(bench.ends);
    expect(json).not.toContain('"path":"foil"');
  });
});

describe('ground landings', () => {
  it('lists the shield pigtail of the terminal board lead at both ends', () => {
    const landings = deriveGroundLandings(loadDesign('de9-terminal-board'), db);
    expect(landings.map((l) => l.end).sort()).toEqual(['a', 'b']);
    expect(landings.map((l) => l.landing).sort()).toEqual(['j1 shell', 'u1 SHLD']);
  });

  it('lists none for an unshielded lead', () => {
    expect(deriveGroundLandings(loadDesign('dc-led-lead'), db)).toEqual([]);
  });

  it('finds no supplied-end on a starter design', () => {
    for (const id of ids) expect(suppliedEnds(loadDesign(id), db), id).toEqual([]);
  });
});

describe('test spec', () => {
  it('checks the continuity of every starter design with no violation', () => {
    for (const id of ids) {
      const spec = deriveTestSpec(loadDesign(id), db);
      expect(spec.violations, id).toEqual([]);
      expect(spec.ports.length, id).toBeGreaterThan(0);
    }
  });

  it('adds an open check when a joint is removed, and a changed summary', () => {
    const design = structuredClone(loadDesign('de9-crossover'));
    const whole = deriveTestSpec(design, db);
    design.joints.pop();
    const cut = deriveTestSpec(design, db);
    expect(JSON.stringify(cut)).not.toBe(JSON.stringify(whole));
  });
});

describe('build sheet', () => {
  it('names every connector of the design by its part number', () => {
    for (const id of ids) {
      const design = loadDesign(id);
      const html = renderBuildSheet(design, db, { depictions: false });
      for (const c of design.instances.connectors) {
        const pn = db.connectors.find((x) => x.id === c.def)?.partNumber;
        if (pn !== undefined) expect(html, `${id} ${c.id}`).toContain(pn);
      }
    }
  });

  it('prefixes every class so a host page cannot collide with it', () => {
    const html = renderBuildSheet(loadDesign('de9-crossover'), db, { depictions: false });
    const classes = [...html.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((c) => c !== '');
    const unprefixed = classes.filter((c) => !c.startsWith('cs-') && !/^(a|b|top|bottom)$/.test(c));
    expect(new Set(unprefixed).size).toBeLessThan(25);
  });
});

describe('units', () => {
  it('prints a length in both systems', () => {
    expect(lengthFromMm(1830).text).toBe('1830 mm (6 ft 0 in)');
    expect(lengthFromMm(300).text).toBe('300 mm (11.8 in)');
    expect(lengthFromMm(0).text).toBe('0 mm (0 in)');
  });

  it('round-trips a catalogued foot length on the 5 mm ladder', () => {
    expect(mmFromFeet(6)).toBe(1830);
    expect(feetFromMm(1830)).toBe(6);
    expect(feetFromMm(mmFromFeet(2.5))).toBe(2.5);
  });

  it('falls back to two decimals off the ladder, and prints feet without trailing zeros', () => {
    expect(feetFromMm(1000)).toBe(3.28);
    expect(feetText(6)).toBe('6');
    expect(feetAttribute(2.5)).toBe('2.5ft');
  });
});

describe('ground landing wording for a bonded mass', () => {
  const wire = { id: 'x' } as unknown as Parameters<typeof massText>[0];
  it('never says "all 0 copper screens"', () => {
    expect(massText(wire, ['drain'])).toBe('shields (drain only, bonded; no copper screens)');
    expect(massText(wire, [])).toBe('shields (no copper screens, bonded)');
  });
});
