import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';
import { adoptLabour, estimateWork, MODULE_ID, settingsOf, workCsv, workIssues, workProblems, type WorkSettings } from '../src/logic.ts';

const settings = (): WorkSettings => ({ schema: 1, operations: [
  { id: 'prepare', label: 'Prepare', minutes: 0.5, quantity: 4, basis: 'per-cable', src: 'synthetic timing fixture' },
  { id: 'assemble', label: 'Assemble', minutes: 1.25, quantity: 2, basis: 'per-cable', src: 'synthetic timing fixture' },
  { id: 'setup', label: 'Setup', minutes: 12, quantity: 1, basis: 'per-batch', src: 'synthetic timing fixture' },
  { id: 'verify-batch', label: 'Verify batch', minutes: 3, quantity: 2, basis: 'per-batch', src: 'synthetic timing fixture' },
] });
const design = (): CableDesign => loadDesign('dc-led-lead');

describe('recorded standard work', () => {
  it('starts with a detached blank table, never an invented free-labour estimate', () => {
    const d = design(); const blank = settingsOf(d);
    expect(blank).toEqual({ schema: 1, operations: [] });
    expect(workProblems(blank)).toEqual([]); expect(workIssues(d)).toEqual([]);
    expect(() => estimateWork(blank)).toThrow(/Record at least one operation/);
    expect(() => adoptLabour(d, blank)).toThrow(/Record at least one operation/);
    expect(() => workCsv(d, loadDb(), blank)).toThrow(/Record at least one operation/);
    expect(d.labourMinutes).toBeUndefined();
  });
  it('separates batch setup from per-cable work and allocates it once per build', () => {
    const table = settings(); const before = structuredClone(table);
    expect(estimateWork(table, 4)).toEqual({ builds: 4, perCableMinutes: 4.5, batchMinutes: 18, runMinutes: 36, allocatedPerCableMinutes: 9 });
    expect(estimateWork(table, 1).allocatedPerCableMinutes).toBe(22.5);
    expect(estimateWork(table, 12).allocatedPerCableMinutes).toBe(6);
    expect(table).toEqual(before);
  });
  it('rejects every missing/non-finite time even when quantity is zero', () => {
    for (const minutes of [undefined, null, '', 'unknown', NaN, Infinity, -1]) {
      const table = settings(); Object.assign(table.operations[0]!, { minutes, quantity: 0 });
      expect(workProblems(table).join(' ')).toMatch(/measured minutes/);
      expect(() => estimateWork(table)).toThrow(/measured minutes/);
      expect(() => adoptLabour(design(), table)).toThrow(/measured minutes/);
    }
  });
  it('allows explicitly recorded zero time and quantities', () => {
    const table = settings(); table.operations = [{ ...table.operations[0]!, minutes: 0, quantity: 0 }];
    expect(workProblems(table)).toEqual([]);
    expect(estimateWork(table, 2)).toMatchObject({ runMinutes: 0, allocatedPerCableMinutes: 0 });
    expect(adoptLabour(design(), table, 2).labourMinutes).toBe(0);
  });
  it('rounds only final totals and preserves positive measurements below rounding precision', () => {
    const table = settings(); table.operations = [
      { ...table.operations[0]!, minutes: 0.1, quantity: 3 },
      { ...table.operations[2]!, minutes: 0.2, quantity: 1 },
    ];
    expect(estimateWork(table, 3)).toEqual({ builds: 3, perCableMinutes: 0.3, batchMinutes: 0.2, runMinutes: 1.1, allocatedPerCableMinutes: 0.366667 });
    table.operations = [{ ...table.operations[0]!, minutes: 1e-10, quantity: 1 }];
    expect(estimateWork(table).allocatedPerCableMinutes).toBe(1e-10);
    expect(adoptLabour(design(), table).labourMinutes).toBeGreaterThan(0);
  });
  it('bounds build count, measurements, table size and total arithmetic', () => {
    for (const builds of [0, -1, 1.5, Infinity, NaN, 1_000_001]) expect(() => estimateWork(settings(), builds)).toThrow(/Build quantity/);
    const large = settings(); large.operations = [{ ...large.operations[0]!, minutes: 1_000_000, quantity: 1_000_000 }];
    expect(workProblems(large).join(' ')).toMatch(/totals/);
    expect(() => estimateWork(large)).toThrow(/totals/);
    large.operations[0]!.quantity = 1;
    expect(() => estimateWork(large, 1_000_000)).toThrow(/total/);
    const tooMany = settings(); tooMany.operations = Array.from({ length: 501 }, (_, i) => ({ ...tooMany.operations[0]!, id: `step-${i}` }));
    expect(workProblems(tooMany).join(' ')).toMatch(/at most 500/);
  });
  it('refuses floating-point underflow rather than adopting free zero work', () => {
    const table = settings(); table.operations = [{ ...table.operations[0]!, minutes: 1e-200, quantity: 1e-200 }];
    expect(() => estimateWork(table)).toThrow(/too small/);
    table.operations = [{ ...table.operations[0]!, minutes: Number.MIN_VALUE, quantity: 1, basis: 'per-batch' }];
    expect(() => adoptLabour(design(), table, 2)).toThrow(/too small/);
  });
  it('validates source, identity, basis, quantities, schema and stored adoption without inventing defaults', () => {
    for (const patch of [{ id: 'Bad ID' }, { label: '' }, { src: '' }, { basis: 'unknown' }, { quantity: undefined }, { quantity: -1 }, { quantity: Infinity }]) {
      const table = settings(); Object.assign(table.operations[0]!, patch); expect(workProblems(table).length).toBeGreaterThan(0);
    }
    const duplicate = settings(); duplicate.operations[1]!.id = duplicate.operations[0]!.id;
    expect(workProblems(duplicate).join(' ')).toMatch(/repeats/);
    for (const value of [null, [], {}, { schema: 2, operations: [] }, { schema: 1, operations: [null] }, { schema: 1, operations: [], adoption: { builds: 0, minutes: 0 } }]) expect(workProblems(value).length).toBeGreaterThan(0);
    const d = design(); d.extensions = { [MODULE_ID]: { schema: 1, operations: [{ id: 'unknown-time' }] } };
    expect(() => settingsOf(d)).toThrow(/measured minutes/);
    expect(workIssues(d).every(i => i.severity === 'error')).toBe(true);
    expect(workIssues(d).map(i => i.message).join(' ')).toMatch(/timing source/);
  });
  it('adopts only explicitly, preserving other design data and detaching every modified value', () => {
    const d = design(); d.labourMinutes = 77; d.extensions = { another: { nested: ['retained'] } };
    const table = settings(); const beforeDesign = structuredClone(d); const beforeSettings = structuredClone(table);
    const adopted = adoptLabour(d, table, 4);
    expect(d).toEqual(beforeDesign); expect(table).toEqual(beforeSettings);
    expect(adopted.labourMinutes).toBe(9);
    expect(settingsOf(adopted).adoption).toEqual({ builds: 4, minutes: 9 });
    expect(adopted.extensions!['another']).toEqual(d.extensions['another']);
    expect(adopted.extensions!['another']).not.toBe(d.extensions['another']);
    table.operations[0]!.minutes = 999;
    expect(settingsOf(adopted).operations[0]!.minutes).toBe(0.5);
    const edited = settingsOf(adopted); edited.operations[0]!.minutes = 10;
    adopted.extensions![MODULE_ID] = edited;
    expect(estimateWork(edited, 4).allocatedPerCableMinutes).not.toBe(adopted.labourMinutes);
    expect(adopted.labourMinutes).toBe(9); expect(edited.adoption).toEqual({ builds: 4, minutes: 9 });
    expect(workProblems(edited)).toEqual([]);
    expect(adoptLabour(adopted, edited, 4).labourMinutes).toBe(estimateWork(edited, 4).allocatedPerCableMinutes);
  });
});

describe('work CSV', () => {
  it('uses the ordinary labour rate/currency and shows batch, total and allocated costs separately', () => {
    const db = loadDb(); db.rules = { ...db.rules, costing: { labourRatePerHour: 60, currency: 'EUR' } };
    const d = design(); d.labourMinutes = 77;
    const csv = workCsv(d, db, settings(), 4);
    const total = csv.split('\r\n').find(row => row.includes('"build-total"'))!;
    expect(total).toContain('"36","4","EUR","60","36"');
    const allocated = csv.split('\r\n').find(row => row.includes('"allocated-per-cable"'))!;
    expect(allocated).toContain('"9","4","EUR","60","9"');
    expect(csv).toContain('"batch-setup"'); expect(csv).toContain('"77"'); expect(csv).toContain('synthetic timing fixture');
    expect(d.labourMinutes).toBe(77);
  });
  it('leaves costs blank for absent rate or currency and accepts an explicit zero rate', () => {
    const db = loadDb();
    for (const costing of [{ currency: 'USD' }, { labourRatePerHour: 60 }, {}]) {
      db.rules = { ...db.rules, costing };
      const row = workCsv(design(), db, settings(), 4).split('\r\n').find(row => row.includes('"build-total"'))!;
      expect(row).toContain('"","No labour'); expect(row).not.toContain('"0"');
    }
    db.rules = { ...db.rules, costing: { labourRatePerHour: 0, currency: 'USD' } };
    const row = workCsv(design(), db, settings(), 4).split('\r\n').find(row => row.includes('"build-total"'))!;
    expect(row).toContain('"USD","0","0"');
    for (const rate of [-1, Infinity, NaN, 1_000_001]) {
      db.rules = { ...db.rules, costing: { labourRatePerHour: rate, currency: 'USD' } };
      expect(() => workCsv(design(), db, settings())).toThrow(/labour rate/);
    }
  });
  it('protects formula-like labels/sources and retains the previous adoption calculation', () => {
    const table = settings(); table.operations[0]!.src = '=SUM(A1:A4)';
    const d = adoptLabour(design(), table, 4);
    const csv = workCsv(d, loadDb(), settingsOf(d), 12);
    expect(csv).toContain('"\'=SUM(A1:A4)"');
    const row = csv.split('\r\n').find(row => row.includes('"prior-adoption"'))!;
    expect(row).toContain('"9","4"');
    expect(csv).toContain('"6","12"');
  });
});
