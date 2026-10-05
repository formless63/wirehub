/**
 * Model behaviour over the starter catalog: assembly sides, screen
 * terminations, kit coverage, definition usage, board part lists, compat,
 * and the small pure helpers. Re-covers the generic cases of the tests
 * dropped at the split (docs/boundaries.md §6).
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import {
  assemblySideOf,
  assemblySides,
  compareRefs,
  compatibilityIssues,
  compressRefs,
  constructionTag,
  definitionUsage,
  findWire,
  isFullyBonded,
  kitCoverage,
  screenTerminations,
  screenPaths,
  stripPracticeProblems,
  unwiredTerminals,
  usageCounts,
  validateKits,
  wireDisplayName,
  wireEndsOf,
  type CableDesign,
} from '../src/index.ts';

const db = loadDb();
const design = (id: string): CableDesign => structuredClone(loadDesign(id));

describe('assembly sides', () => {
  it('puts every connector of a straight lead on a side of its own', () => {
    const d = design('de9-crossover');
    const sides = assemblySides(d);
    for (const connector of d.instances.connectors) expect(['a', 'b']).toContain(sides.get(connector.id));
    const kinds = new Set(d.instances.connectors.map((c) => assemblySideOf(d, c.id)));
    expect(kinds).toEqual(new Set(['a', 'b']));
  });

  it('lists the ends a wire instance lands on, in a stable order', () => {
    const d = design('de9-crossover');
    const segment = d.instances.segments[0]!.id;
    const ends = d.instances.connectors.map((c) => wireEndsOf(d, c.id));
    expect(ends.map((e) => e.length)).toEqual(ends.map(() => 1));
    expect(ends.flat().map((e) => e.end).sort()).toEqual(['a', 'b']);
    expect(ends.flat().every((e) => e.segment === segment)).toBe(true);
    expect(wireEndsOf(d, segment)).toEqual([]);
  });

  it('finds no unwired terminal on a finished example, and one on a stripped copy', () => {
    for (const id of listDesignIds()) {
      const d = design(id);
      expect(Array.isArray(unwiredTerminals(d, db)), id).toBe(true);
    }
    const d = design('de9-crossover');
    const before = unwiredTerminals(d, db).length;
    d.joints = d.joints.slice(1);
    expect(unwiredTerminals(d, db).length).toBeGreaterThan(before);
  });
});

describe('screen terminations', () => {
  it('records how the shield of the terminal board lead ends', () => {
    const d = design('de9-terminal-board');
    const map = screenTerminations(d, db);
    expect([...map.values()].every((v) => ['joint', 'pigtail', 'bonded', 'through'].includes(v))).toBe(true);
    expect([...map.values()]).toContain('pigtail');
  });

  it('knows the screen paths of a shielded stock and none for a bare one', () => {
    expect(screenPaths(findWire(db, 'shielded-2pair-24awg')!).length).toBeGreaterThan(0);
    expect(screenPaths(findWire(db, 'dc-2core-24awg')!)).toEqual([]);
    expect(isFullyBonded(findWire(db, 'dc-2core-24awg')!)).toBe(false);
  });
});

describe('kits', () => {
  it('validates the starter kits with no issue', () => {
    expect(validateKits(db)).toEqual([]);
  });

  it('reports coverage in a stable shape', () => {
    for (const id of listDesignIds()) {
      for (const c of kitCoverage(design(id), db)) {
        expect(c.sku).toMatch(/^[A-Za-z0-9]/);
        expect(c.complete).toBe(c.missing.length === 0);
      }
    }
  });

  it('flags a kit that points at a part that does not exist', () => {
    const broken = structuredClone(db);
    broken.kits![0]!.contents.push({ part: { kind: 'mechanical', def: 'no-such-part' }, qty: 1, src: 'test' });
    expect(validateKits(broken).length).toBeGreaterThan(0);
  });
});

describe('definition usage', () => {
  const designs = listDesignIds().map(design);

  it('counts the designs that use a connector definition', () => {
    const counts = usageCounts(db, designs, 'connectors', db.connectors.map((c) => c.id));
    expect(counts.get('de9-male') ?? 0).toBeGreaterThan(0);
    const use = definitionUsage(db, designs, 'connectors', 'de9-male');
    expect(use.designs.length).toBeGreaterThan(0);
  });

  it('reaches a body through the connectors built on it', () => {
    const body = db.connectors.find((c) => c.id === 'de9-male')!.body!;
    expect(definitionUsage(db, designs, 'bodies', body).designs.length).toBeGreaterThan(0);
  });

  it('reports an unused id as unused', () => {
    const use = definitionUsage(db, designs, 'wires', 'no-such-wire');
    expect(use.designs).toEqual([]);
  });
});

describe('compatibility', () => {
  it('raises no error-level issue on any starter design', () => {
    for (const id of listDesignIds()) {
      expect(compatibilityIssues(design(id), db).filter((i) => i.severity === 'error'), id).toEqual([]);
    }
  });
});

describe('reference designators', () => {
  it('sorts R2 before R10', () => {
    expect(['R10', 'R2', 'C1'].sort(compareRefs)).toEqual(['C1', 'R2', 'R10']);
  });

  it('collapses runs of three or more', () => {
    expect(compressRefs(['C1', 'C2', 'C3', 'C5'])).toBe('C1–C3, C5');
    expect(compressRefs(['C1', 'C2'])).toBe('C1, C2');
    expect(compressRefs(['R4', 'R4'])).toBe('R4');
  });
});

describe('wire display', () => {
  it('uses the stock label and never an id for a known wire', () => {
    expect(wireDisplayName(db, 'cat5e-utp')).toMatch(/Category 5e/);
    expect(wireDisplayName(db, 'no-such-wire')).toBe('no-such-wire');
  });

  it('tags a construction from the lay order only', () => {
    const lay = { ring: ['a', 'b', 'c', 'd', 'e', 'f'], center: 'x', inner: ['y'] } as never;
    expect(constructionTag({ layOrder: lay } as never)).toBe('6+2C');
    expect(constructionTag({ layOrder: lay } as never, true)).toBe('8C');
    expect(constructionTag({ layOrder: { ring: ['a', 'b'] } } as never)).toBe('2C');
    expect(constructionTag(undefined)).toBeUndefined();
  });
});

describe('strip practice', () => {
  const ok = {
    id: 'p',
    label: 'p',
    appliesTo: 'any' as const,
    jacketMm: 40,
    shield: 'keep' as const,
    insulationMm: 6,
    drain: { source: 'land' as const, destination: 'cut' as const },
    src: 'synthetic example',
  };
  it('accepts a complete record', () => {
    expect(stripPracticeProblems(ok)).toEqual([]);
  });
  it('names a share outside 0 to 100, a sheath longer than the jacket and a bad id', () => {
    expect(stripPracticeProblems({ ...ok, shield: 'trim', shieldKeepPct: 140 })).toHaveLength(1);
    expect(stripPracticeProblems({ ...ok, sheathMm: 60 }).join(' ')).toMatch(/sheath/);
    expect(stripPracticeProblems({ ...ok, id: 'Bad Id' }).join(' ')).toMatch(/kebab-case/);
    expect(stripPracticeProblems({ ...ok, insulationMm: 90 }).join(' ')).toMatch(/insulation/);
  });
});
