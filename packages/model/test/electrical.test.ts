/** Electrical rules (cs-5k1.15): gauge vs current, contact rating, voltage drop; silent without data. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import { ampacityOfArea, electricalReport, electricalRulesProblems, validateDesign, type Db } from '../src/index.ts';

const design = loadDesign('de9-crossover');
const base = loadDb();

/** pin 3 of j1 carries `amps`; the stock's conductors are `area` mm2; the connector's contact rating is `rating` */
function dbWith(opts: { amps?: number; area?: number; rating?: number; rules?: Db['rules']; volts?: number }): Db {
  const db = structuredClone(base);
  const wire = db.wires.find((w) => w.id === 'shielded-2pair-24awg')!;
  const walk = (el: any): void => {
    if (el.kind === 'conductor' && opts.area !== undefined) el.areaMm2 = opts.area;
    for (const c of el.children ?? []) walk(c);
  };
  walk(wire.structure);
  const connector = db.connectors.find((c) => c.id === 'de9-female')!;
  if (opts.rating !== undefined) connector.contactRatingA = opts.rating;
  if (opts.amps !== undefined) connector.pins = connector.pins.map((p) => (p.id === '3' ? { ...p, currentA: opts.amps! } : p));
  if (opts.volts !== undefined) {
    // a signal with a nominal voltage on pin 3
    db.vocab = { ...(db.vocab ?? {}), signals: { ...(db.vocab?.['signals'] ?? { id: 'signals', label: 'Signals', entries: [] }), entries: [...((db.vocab?.['signals']?.entries ?? []) as any[]), { id: 'rail-x', label: 'Rail X', kind: 'power', voltageV: opts.volts, src: 'test' }] } } as Db['vocab'];
    connector.pins = connector.pins.map((p) => (p.id === '3' ? { ...p, signal: 'rail-x' } : p));
  }
  if (opts.rules !== undefined) db.rules = opts.rules;
  return db;
}
const codes = (db: Db): string[] => validateDesign(design, db).map((i) => i.code);

describe('electrical rules', () => {
  it('say nothing when no current is declared', () => {
    expect(electricalReport(design, dbWith({ area: 0.05, rating: 0.1 }))).toEqual({ rows: [], contacts: [], issues: [] });
    expect(codes(base)).not.toContain('conductor-ampacity');
  });

  it('warn when a conductor is too thin for the declared current', () => {
    const issues = electricalReport(design, dbWith({ amps: 5, area: 0.205 })).issues.filter((i) => i.code === 'conductor-ampacity');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toContain('5 A');
    expect(issues[0]!.message).toContain('3.5 A');
    expect(issues[0]!.message).toContain('PowerStream');
    expect(codes(dbWith({ amps: 0.5, area: 0.205 }))).not.toContain('conductor-ampacity');
  });

  it('skips the gauge check when the conductor has no area', () => {
    const db = dbWith({ amps: 50 });
    const wire = db.wires.find((w) => w.id === 'shielded-2pair-24awg')!;
    const strip = (el: any): void => {
      delete el.areaMm2;
      for (const c of el.children ?? []) strip(c);
    };
    strip(wire.structure);
    expect(codes(db)).not.toContain('conductor-ampacity');
  });

  it('warns when a contact is rated below the net current', () => {
    const issues = electricalReport(design, dbWith({ amps: 2, area: 1.31, rating: 1 })).issues.filter((i) => i.code === 'contact-rating');
    expect(issues.map((i) => i.where)).toContain('j1:3');
    expect(issues[0]!.message).toContain('rated 1 A');
    expect(codes(dbWith({ amps: 2, area: 1.31, rating: 3 }))).not.toContain('contact-rating');
  });

  it('computes the voltage drop over the segment length and warns above the limit', () => {
    const db = dbWith({ amps: 2, area: 0.205, rules: { electrical: { maxDropV: 0.1 } } });
    const report = electricalReport(design, db);
    const row = report.rows.find((r) => r.conductor === 'pair-1.a')!;
    // 0.017241 ohm mm2/m / 0.205 mm2 * 1.83 m * 2 A
    expect(row.dropV).toBeCloseTo((0.017241 / 0.205) * 1.83 * 2, 4);
    expect(row.lengthMm).toBe(1830);
    expect(report.issues.map((i) => i.code)).toContain('voltage-drop');
    expect(electricalReport(design, dbWith({ amps: 2, area: 0.205 })).issues.map((i) => i.code)).not.toContain('voltage-drop');
  });

  it('judges a drop as a percentage when the signal has a voltage', () => {
    const issues = electricalReport(design, dbWith({ amps: 2, area: 0.205, volts: 5, rules: { electrical: { maxDropV: 5, maxDropPct: 1 } } })).issues;
    expect(issues.find((i) => i.code === 'voltage-drop')?.message).toContain('percent of 5 V');
  });

  it('follows the organisation settings: derate, own table, switched off', () => {
    expect(codes(dbWith({ amps: 3, area: 0.205, rules: { electrical: { ampacityDerate: 0.5 } } }))).toContain('conductor-ampacity');
    expect(codes(dbWith({ amps: 3, area: 0.205, rules: { electrical: { ampacity: [{ areaMm2: 0.2, amps: 10 }] } } }))).not.toContain('conductor-ampacity');
    expect(electricalReport(design, dbWith({ amps: 9, area: 0.205, rating: 1, rules: { electrical: { enabled: false } } })).issues).toEqual([]);
  });

  it('reads the table conservatively and checks its settings', () => {
    expect(ampacityOfArea(0.205)).toBe(3.5);
    expect(ampacityOfArea(0.25)).toBe(3.5);
    expect(ampacityOfArea(100)).toBeUndefined();
    expect(electricalRulesProblems({ maxDropV: -1, ampacityDerate: 2, bogus: 1 }).length).toBe(3);
    expect(electricalRulesProblems({ maxDropV: 0.3 })).toEqual([]);
  });

  it('the crimp contact in the cavity rates the pin over the connector, when it states a rating', () => {
    const withContact = (contactA: number, connectorA: number) => {
      const db = dbWith({ amps: 2, area: 1.31, rating: connectorA });
      db.mechanicals = [...(db.mechanicals ?? []), { id: 'rated-contact', label: 'rated contact', kind: 'contact', termination: { ratedCurrentA: contactA }, src: 'test' }];
      const instance = design.instances.connectors.find((c) => c.def === 'de9-female')!.id;
      const d = structuredClone(design);
      d.instances.connectors = d.instances.connectors.map((c) => (c.id === instance ? { ...c, cavities: [{ pin: '3', contact: 'rated-contact' }] } : c));
      return electricalReport(d, db).issues.filter((i) => i.code === 'contact-rating' && i.where === `${instance}:3`);
    };
    expect(withContact(10, 1)).toEqual([]);
    const over = withContact(1, 10);
    expect(over).toHaveLength(1);
    expect(over[0]!.message).toContain("contact 'rated-contact'");
  });
});

describe('per-design current overrides', () => {
  const db = dbWith({ amps: 0.5, area: 0.205 });
  const withElectrical = (electrical: unknown) => ({ ...design, electrical }) as typeof design;

  it('a design states its own current for a pin, higher or lower than the library\'s', () => {
    expect(electricalReport(design, db).issues.filter((i) => i.code === 'conductor-ampacity')).toEqual([]);
    const higher = electricalReport(withElectrical({ currents: { 'j1:3': 5 } }), db);
    expect(higher.issues.filter((i) => i.code === 'conductor-ampacity').length).toBeGreaterThan(0);
    expect(higher.rows.some((r) => r.currentA === 5)).toBe(true);
    // lower: the override wins over the pin's declared 5 A as well
    const heavy = dbWith({ amps: 5, area: 0.205 });
    expect(electricalReport(design, heavy).issues.filter((i) => i.code === 'conductor-ampacity').length).toBeGreaterThan(0);
    expect(electricalReport(withElectrical({ currents: { 'j1:3': 1, 'j2:3': 1 } }), heavy).issues.filter((i) => i.code === 'conductor-ampacity')).toEqual([]);
  });

  it('a design can carry its own thresholds, over the organisation\'s', () => {
    const d = withElectrical({ currents: { 'j1:3': 3 }, rules: { ampacityDerate: 0.5 } });
    expect(electricalReport(d, db).issues.some((i) => i.code === 'conductor-ampacity' && i.message.includes('derated to 50 percent'))).toBe(true);
    expect(electricalReport(withElectrical({ currents: { 'j1:3': 3 }, rules: { enabled: false } }), db)).toEqual({ rows: [], contacts: [], issues: [] });
  });

  it('refuses a key that names no pin, a bad current and unknown settings', () => {
    const messages = (electrical: unknown): string[] => validateDesign(withElectrical(electrical), db).filter((i) => i.code === 'invalid-electrical').map((i) => i.message);
    expect(messages({ currents: { 'j1:3': 2 } })).toEqual([]);
    expect(messages({ currents: { 'nope:3': 2 } })[0]).toContain("'nope:3'");
    expect(messages({ currents: { 'j1:99': 2 } })).toHaveLength(1);
    expect(messages({ currents: { 'j1:3': 0 } })[0]).toContain('above 0');
    expect(messages({ wat: 1 })[0]).toContain('electrical.wat');
    expect(messages({ rules: { maxDropV: -1 } })[0]).toContain('maxDropV');
  });
});
