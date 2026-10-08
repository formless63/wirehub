/** The BOM cost roll-up (cs-5k1.17): nothing without prices, explicit currency, breaks by build quantity. */

import type { Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import { BOM_COST_HEADERS, BOM_HEADERS, baseExport, bomTable, deriveBomSheet, deriveCost, renderBomMarkdown, renderBomSheet } from '../src/index.ts';

const base = loadDb();
const design = loadDesign('de9-crossover');
const sheet = deriveBomSheet(design, base, {});

/** The starter catalog with prices on the first connector, wire and component the design uses. */
function priced(extra: Partial<Db> = {}): Db {
  const wireId = design.instances.segments[0]!.def;
  const connId = design.instances.connectors[0]!.def;
  const compId = design.instances.components[0]?.def;
  return {
    ...base,
    ...extra,
    wires: base.wires.map((w) => (w.id === wireId ? { ...w, cost: { unit: 2, breaks: [{ minQty: 10, unit: 1.5 }] } } : w)),
    connectors: base.connectors.map((c) => (c.id === connId ? { ...c, cost: { unit: 1.25, currency: 'USD', breaks: [{ minQty: 10, unit: 1 }] } } : c)),
    components: base.components.map((c) => (c.id === compId ? { ...c, cost: { unit: 0.1 } } : c)),
  };
}

describe('deriveCost', () => {
  it('prints nothing when nothing is priced', () => {
    expect(sheet.cost).toBeUndefined();
    expect(bomTable(design, base).headers).toEqual(BOM_HEADERS);
    expect(renderBomMarkdown(design, base)).not.toContain('## Cost');
    expect(renderBomSheet(design, base)).not.toContain('cs-cost');
  });

  it('prices lines, lists the unpriced and totals in the organisation currency', () => {
    const db = priced({ rules: { costing: { currency: 'USD', labourRatePerHour: 60 } } });
    const withLabour = { ...design, labourMinutes: 30 };
    const cost = deriveBomSheet(withLabour, db, {}).cost!;
    expect(cost.currency).toBe('USD');
    expect(cost.lines.length).toBeGreaterThan(0);
    expect(cost.unpriced.length).toBeGreaterThan(0);
    expect(cost.materials).toBeCloseTo(cost.lines.reduce((s, l) => s + l.extended, 0), 6);
    expect(cost.labour).toEqual({ minutes: 30, ratePerHour: 60, cost: 30 });
    expect(cost.total).toBeCloseTo(cost.materials + 30, 6);
    expect(cost.notes.join(' ')).toContain('no price');
    const wire = cost.lines.find((l) => l.unit === 'm')!;
    expect(wire.quantity).toBeGreaterThan(0);
    expect(wire.extended).toBeCloseTo(wire.quantity * 2, 4);
  });

  it('reads the quantity breaks at the build quantity, and totals the build', () => {
    const db = priced({ rules: { costing: { currency: 'USD' } } });
    const one = deriveBomSheet(design, db, {}).cost!;
    const many = deriveBomSheet(design, db, { buildQty: 100 }).cost!;
    const connOne = one.lines.find((l) => l.unitPrice === 1.25)!;
    expect(connOne.tier).toBeUndefined();
    const connMany = many.lines.find((l) => l.sourceKey === connOne.sourceKey)!;
    expect(connMany.unitPrice).toBe(1);
    expect(connMany.tier).toBe(10);
    expect(many.total).toBeLessThan(one.total);
    expect(many.buildTotal).toBeCloseTo(many.total * 100, 4);
  });

  it('leaves a line in another currency out of the total and says so', () => {
    const db = priced({ rules: { costing: { currency: 'EUR' } } });
    const cost = deriveBomSheet(design, db, {}).cost!;
    expect(cost.currency).toBe('EUR');
    expect([...new Set(cost.foreign.map((l) => l.currency))]).toEqual(['USD']);
    expect(cost.notes.join(' ')).toContain('another currency');
    expect(cost.materials).toBeCloseTo(cost.lines.reduce((s, l) => s + l.extended, 0), 6);
  });

  it('uses the one currency every price shares when the organisation sets none, else says none is set', () => {
    const connectorsOnly = { ...priced(), wires: base.wires, components: base.components };
    expect(deriveBomSheet(design, connectorsOnly, {}).cost!.currency).toBe('USD');
    // a price with no currency and none set for the organisation is ambiguous next to a USD one
    const mixed = deriveBomSheet(design, priced(), {}).cost!;
    expect(mixed.currency).toBeUndefined();
    expect(mixed.notes[0]).toContain('No currency is set');
  });

  it('reports labour without a rate and a labour-only design', () => {
    const only = deriveCost({ ...design, labourMinutes: 15 }, base, [], {})!;
    expect(only.labour).toEqual({ minutes: 15 });
    expect(only.total).toBe(0);
    expect(only.notes.join(' ')).toContain('no labour rate');
    expect(deriveCost(design, base, [], {})).toBeUndefined();
  });

  it('adds cost columns and summary rows to the BOM CSV and the renderings, only when priced', () => {
    const db = priced({ rules: { costing: { currency: 'USD', labourRatePerHour: 60 } } });
    const d = { ...design, labourMinutes: 6 };
    const table = bomTable(d, db, { buildQty: 10 });
    expect(table.headers).toEqual([...BOM_HEADERS, ...BOM_COST_HEADERS]);
    for (const row of table.rows) expect(row).toHaveLength(table.headers.length);
    const labels = table.rows.map((r) => r[0]);
    expect(labels.slice(-3)).toEqual(['Labour', 'Total', 'Total x 10']);
    const csv = baseExport('bom.csv')!.render(d, db, { buildQty: 10 });
    expect(String(csv.body)).toContain('unit_cost,extended_cost,currency');
    expect(renderBomMarkdown(d, db)).toContain('## Cost');
    expect(renderBomSheet(d, db, { buildQty: 10 })).toContain('Total, 10 units');
  });
});
