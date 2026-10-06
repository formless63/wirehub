import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import { deriveBomSheet } from '@wirehub/docs';
import { withAssemblies, type CableDesign, type Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';
import { convertAmount, costReportCsv, settingsOf, snapshotProblems } from '../src/logic.ts';
import type { FxSettings, FxSnapshot } from '../src/types.ts';

const snapshot: FxSnapshot = { base: 'EUR', date: '2026-01-02', retrievedAt: '2026-01-03T04:05:06Z', rates: { USD: 2, GBP: 0.5 }, source: 'synthetic example' };
const settings: FxSettings = { schema: 1, snapshot, target: 'EUR' };
const base = createCatalog(fsCatalogSource(dataPath(''))).loadDb();
const connector = base.connectors[0]!;
const empty = (id = 'synthetic'): CableDesign => ({ id, label: id, schemaVersion: 5, src: 'synthetic example', instances: { connectors: [], segments: [], components: [], pcbas: [], mechanical: [] }, joints: [] });
const design: CableDesign = { ...empty(), instances: { ...empty().instances, connectors: [{ id: 'j1', def: connector.id }, { id: 'j2', def: connector.id }] } };
const priced = (extra: Partial<Db> = {}): Db => ({ ...base, ...extra, connectors: base.connectors.map((c) => c.id === connector.id ? { ...c, cost: { unit: 2, currency: 'USD', breaks: [{ minQty: 10, unit: 1 }] } } : c) });

/** Small CSV reader for our quoted cells, including deliberate spreadsheet escaping. */
const rows = (csv: string): string[][] => csv.trimEnd().split('\r\n').map((line) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) => m[1]!.replaceAll('""', '"')));

describe('saved reference snapshot', () => {
  it('validates persisted shape and exposes only schema1 settings', () => {
    expect(snapshotProblems(snapshot)).toEqual([]);
    expect(settingsOf({ extensions: { 'fx-rates': settings } })).toBe(settings);
    expect(settingsOf({ extensions: { 'fx-rates': { ...settings, schema: 2 } } })).toBeUndefined();
    expect(settingsOf({})).toBeUndefined();
  });

  it.each([
    undefined, { ...snapshot, base: 'USD' }, { ...snapshot, date: '2026-02-30' },
    { ...snapshot, retrievedAt: '2026-01-03' }, { ...snapshot, rates: { USD: 0 } },
    { ...snapshot, rates: { USD: Number.POSITIVE_INFINITY } }, { ...snapshot, rates: { usd: 2 } },
    { ...snapshot, rates: { EUR: 2 } }, { ...snapshot, rates: [] }, { ...snapshot, source: '' },
    { ...snapshot, date: '2027-01-01' }, { ...snapshot, retrievedAt: '2026-02-30T00:00:00Z' },
  ])('rejects invalid snapshots', (value) => expect(snapshotProblems(value).length).toBeGreaterThan(0));

  it('cross-converts via EUR, handles identity without rates, and excludes unknowns', () => {
    expect(convertAmount(4, 'USD', 'EUR', snapshot)).toBe(2);
    expect(convertAmount(4, 'USD', 'GBP', snapshot)).toBe(1);
    expect(convertAmount(1, 'EUR', 'USD', snapshot)).toBe(2);
    expect(convertAmount(5, 'XYZ', 'XYZ', undefined)).toBe(5);
    expect(convertAmount(5, undefined, 'EUR', snapshot)).toBeUndefined();
    expect(convertAmount(5, 'XYZ', 'EUR', snapshot)).toBeUndefined();
    expect(convertAmount(5, 'USD', 'XYZ', snapshot)).toBeUndefined();
    expect(convertAmount(Number.NaN, 'USD', 'EUR', snapshot)).toBeUndefined();
  });
});

describe('FX cost report', () => {
  it('preserves source prices, changes tiers at build quantity and never mutates input', () => {
    const db = priced();
    const before = JSON.stringify({ design, db, settings });
    const one = rows(costReportCsv(design, db, settings));
    const many = rows(costReportCsv(design, db, settings, 10));
    const part = one.find((r) => r[1] === 'connector')!;
    expect(part.slice(4, 13)).toEqual(['2', 'each', 'USD', '2', '4', 'EUR', '0.5', '2', '2']);
    expect(many.find((r) => r[1] === 'connector')!.slice(7, 13)).toEqual(['1', '2', 'EUR', '0.5', '1', '10']);
    expect(JSON.stringify({ design, db, settings })).toBe(before);
  });

  it('reproduces saved build quantity and rejects malformed saved quantities', () => {
    const saved = { ...settings, builds: 10 };
    expect(costReportCsv(design, priced(), saved)).toBe(costReportCsv(design, priced(), settings, 10));
    expect(settingsOf({ extensions: { 'fx-rates': saved } })).toBe(saved);
    for (const builds of [0, -1, 1.5, 1000001, '10', Number.POSITIVE_INFINITY]) {
      expect(settingsOf({ extensions: { 'fx-rates': { ...settings, builds } } })).toBeUndefined();
    }
  });

  it('labels missing source currency and missing rates as excluded, never free', () => {
    const unknownDb = { ...priced(), connectors: base.connectors.map((c) => c.id === connector.id ? { ...c, cost: { unit: 2 } } : c) };
    const unknown = rows(costReportCsv(design, unknownDb, settings));
    expect(unknown.find((r) => r[1] === 'connector')![13]).toContain('source currency is unknown');
    expect(unknown.find((r) => r[1] === 'Subtotal')![13]).toContain('1 excluded');
    const missing = rows(costReportCsv(design, priced(), { ...settings, snapshot: { ...snapshot, rates: { GBP: 0.5 } } }));
    expect(missing.find((r) => r[1] === 'connector')![11]).toBe('');
    expect(missing.find((r) => r[1] === 'connector')![13]).toContain('rate is unavailable');
  });

  it('includes known-currency labour and excludes labour whose currency was never set', () => {
    const labour = { ...design, labourMinutes: 30 };
    const unknown = rows(costReportCsv(labour, priced({ rules: { costing: { labourRatePerHour: 10 } } }), settings));
    expect(unknown.find((r) => r[1] === 'labour')![13]).toContain('source currency is unknown');
    const known = rows(costReportCsv(labour, priced({ rules: { costing: { currency: 'GBP', labourRatePerHour: 10 } } }), settings, 3));
    expect(known.find((r) => r[1] === 'labour')!.slice(6, 13)).toEqual(['GBP', '10', '5', 'EUR', '2', '10', '30']);
  });

  it('opens pinned subassemblies, preserves child foreign prices and prices tiers at placed build quantity', () => {
    const child = { ...design, id: 'child', labourMinutes: 60 };
    const parent = { ...empty('parent'), instances: { ...empty().instances, subassemblies: [{ id: 'a', def: child.id, rev: 1 }, { id: 'b', def: child.id, rev: 1 }] } };
    const childDb = priced({ rules: { costing: { currency: 'GBP', labourRatePerHour: 5 } } });
    const db = withAssemblies(childDb, { working: [], versions: [{ designId: child.id, rev: 1, released: true, design: child, definitions: { connectors: childDb.connectors, bodies: childDb.bodies ?? [], interfaces: childDb.interfaces ?? [], wires: childDb.wires, components: childDb.components, pcbas: childDb.pcbas, mechanicals: childDb.mechanicals ?? [] } }] });
    expect(deriveBomSheet(parent, db, { buildQty: 5 }).cost!.lines[0]!.unitPrice).toBe(5); // base subtotal omits USD child parts
    const report = rows(costReportCsv(parent, db, settings, 5));
    expect(report.find((r) => r[1] === 'connector')!.slice(4, 13)).toEqual(['4', 'each', 'USD', '1', '4', 'EUR', '0.5', '2', '10']);
    expect(report.find((r) => r[1] === 'labour')![11]).toBe('20');
    expect(report.find((r) => r[1] === 'Subtotal')![11]).toBe('22');
    expect(report.filter((r) => r[1] === 'subassembly')).toHaveLength(1);
  });

  it('reports absent/cyclic subassemblies and unpriced rows without guessing totals', () => {
    const parent = { ...empty('parent'), instances: { ...empty().instances, subassemblies: [{ id: 'a', def: 'parent' }] } };
    const db = withAssemblies(base, { working: [parent] });
    expect(costReportCsv(parent, db, settings)).toContain('subassembly is unavailable or cyclic');
    expect(costReportCsv(design, base, settings)).toContain('Excluded: no price.');
  });

  it('preserves wire lengths in metres and prices the whole build at the applicable tier', () => {
    const stock = base.wires[0]!;
    const wireDesign = { ...empty('wire'), instances: { ...empty().instances, segments: [{ id: 'w1', def: stock.id, lengthMm: 750 }, { id: 'w2', def: stock.id, lengthMm: 250 }] } };
    const db = { ...base, wires: base.wires.map((w) => w.id === stock.id ? { ...w, cost: { unit: 4, currency: 'USD', per: 'm' as const, breaks: [{ minQty: 10, unit: 2 }] } } : w) };
    const wire = rows(costReportCsv(wireDesign, db, settings, 40)).find((r) => r[1] === 'wire')!;
    expect(wire.slice(4, 13)).toEqual(['0.75', 'm', 'USD', '2', '1.5', 'EUR', '0.5', '0.75', '30']);
  });

  it('rejects unsafe converted build totals and subtotal overflow', () => {
    const hugeDb = { ...priced(), connectors: base.connectors.map((c) => c.id === connector.id ? { ...c, cost: { unit: 1e303, currency: 'USD' } } : c) };
    expect(() => costReportCsv(design, hugeDb, { ...settings, target: 'USD' }, 1_000_000)).toThrow('subtotal or build total is too large');
    const other = base.connectors[1]!;
    const two = { ...empty(), instances: { ...empty().instances, connectors: [{ id: 'j1', def: connector.id }, { id: 'j2', def: other.id }] } };
    const db = { ...base, connectors: base.connectors.map((c) => [connector.id, other.id].includes(c.id) ? { ...c, cost: { unit: 5e299, currency: 'USD' } } : c) };
    expect(() => costReportCsv(two, db, { ...settings, snapshot: { ...snapshot, rates: { USD: 5e-9 } } })).toThrow('subtotal or build total is too large');
    const manyDb = { ...db, connectors: db.connectors.map((c) => [connector.id, other.id].includes(c.id) ? { ...c, cost: { unit: 1.5e302, currency: 'USD' } } : c) };
    expect(() => costReportCsv(two, manyDb, { ...settings, target: 'USD' }, 1_000_000)).toThrow('subtotal or build total is too large');
  });

  it('labels invalid source extended amounts instead of emitting Infinity as a price', () => {
    const db = { ...priced(), connectors: base.connectors.map((c) => c.id === connector.id ? { ...c, cost: { unit: 1e308, currency: 'USD' } } : c) };
    const report = costReportCsv(design, db, settings);
    expect(report).toContain('source amount is invalid or too large');
    expect(report).not.toContain('Infinity');
  });

  it('uses spreadsheet-safe cells and rejects invalid settings/build counts', () => {
    const unsafe = { ...design, label: '=1+1' };
    const db = { ...priced(), connectors: priced().connectors.map((c) => c.id === connector.id ? { ...c, label: '=CMD()' } : c) };
    expect(costReportCsv(unsafe, db, settings)).toContain("'=CMD()");
    expect(() => costReportCsv(design, db, settings, 0)).toThrow('Build quantity');
    expect(() => costReportCsv(design, db, { ...settings, target: '' })).toThrow('valid saved');
  });
});
