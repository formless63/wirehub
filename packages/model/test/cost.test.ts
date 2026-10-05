import { describe, expect, it } from 'vitest';

import { costIssues, costingRulesProblems, costUnit, recordMetaIssues, unitPriceAt, validateDesign, type CableDesign } from '../src/index.ts';

describe('part cost', () => {
  it('reads no cost as fine', () => {
    expect(costIssues({}, 'components/x')).toEqual([]);
    expect(recordMetaIssues({ cost: { unit: 0.5, currency: 'EUR', breaks: [{ minQty: 10, unit: 0.4 }] } }, 'components/x')).toEqual([]);
  });

  it('refuses malformed prices, one issue per fault', () => {
    const issues = costIssues({ cost: { unit: -1, currency: 'usd', per: 'kg', moq: 0, breaks: [{ minQty: 5, unit: 1 }, { minQty: 5, unit: 2 }, { minQty: 0, unit: -2 }] } }, 'wires/w');
    const text = issues.map((i) => i.message).join('\n');
    expect(issues.every((i) => i.code === 'record-cost' && i.severity === 'error')).toBe(true);
    for (const part of ['unit must be', 'currency must be', "per must be", 'moq must be', 'listed twice', 'breaks[2].minQty', 'breaks[2].unit']) expect(text).toContain(part);
    expect(costIssues({ cost: 'cheap' }, 'x')).toHaveLength(1);
  });

  it('picks the unit price by quantity', () => {
    const cost = { unit: 1, breaks: [{ minQty: 100, unit: 0.6 }, { minQty: 10, unit: 0.8 }] };
    expect([1, 9, 10, 99, 100, 5000].map((q) => unitPriceAt(cost, q))).toEqual([1, 1, 0.8, 0.8, 0.6, 0.6]);
  });

  it('prices wire per metre unless told otherwise', () => {
    expect(costUnit({ unit: 1 }, true)).toBe('m');
    expect(costUnit({ unit: 1, per: 'each' }, true)).toBe('each');
    expect(costUnit({ unit: 1 }, false)).toBe('each');
  });

  it('checks the organisation settings', () => {
    expect(costingRulesProblems({ currency: 'USD', labourRatePerHour: 40 })).toEqual([]);
    expect(costingRulesProblems({ currency: 'dollars', labourRatePerHour: -1, rate: 2 })).toHaveLength(3);
  });

  it('checks the design labour field', () => {
    const base = { schemaVersion: 4, id: 'd', label: 'D', instances: { connectors: [], segments: [], components: [], pcbas: [] }, joints: [], src: 's' } as CableDesign;
    const db = { connectors: [], wires: [], components: [], pcbas: [] };
    expect(validateDesign({ ...base, labourMinutes: 12 }, db).filter((i) => i.code === 'invalid-labour')).toEqual([]);
    expect(validateDesign({ ...base, labourMinutes: -3 }, db).filter((i) => i.code === 'invalid-labour')).toHaveLength(1);
  });
});
