/** Static mass on records: input units convert to grams, the fields are checked, a connector falls back to its body. */

import { describe, expect, it } from 'vitest';

import { effectivePieceMass, fromGrams, massIssues, recordMetaIssues, toGrams, toGramsPerMetre, type ConnectorBody, type ConnectorDefinition, type Db } from '../src/index.ts';

describe('mass', () => {
  it('converts oz, lb and per-kft figures to grams, six decimals', () => {
    expect(toGrams(1, 'oz')).toBe(28.349523);
    expect(toGrams(2, 'lb')).toBe(907.18474);
    expect(toGrams(1.5, 'kg')).toBe(1500);
    // 22 lb per 1000 ft of stock
    expect(toGramsPerMetre(22, 'lb', 'kft')).toBe(32.739607);
    expect(toGramsPerMetre(5, 'g', 'ft')).toBe(16.404199);
    expect(fromGrams(453.59237, 'lb')).toBe(1);
  });

  it('refuses malformed or misplaced mass fields as record-mass errors', () => {
    expect(recordMetaIssues({ mass: { g: 0, src: 'weighed' } }, 'connectors/x')).toEqual([]);
    expect(recordMetaIssues({ massPerLength: { gPerM: 21.5 } }, 'wires/w')).toEqual([]);
    const bad = [
      massIssues({ mass: { g: -1 } }, 'components/c'),
      massIssues({ mass: { g: 1, unit: 'oz' } }, 'pcbas/p'),
      massIssues({ mass: { g: Number.POSITIVE_INFINITY } }, 'bodies/b'),
      massIssues({ mass: { g: 2 } }, 'wires/w'),
      massIssues({ massPerLength: { gPerM: 2 } }, 'mechanicals/m'),
      massIssues({ mass: { g: 2 } }, 'kits/k'),
    ];
    for (const issues of bad) {
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: 'record-mass', severity: 'error' });
    }
    // a bare id (no directory) is checked for shape only
    expect(massIssues({ mass: { g: 2 } }, 'w')).toEqual([]);
  });

  it("weighs a connector by its own mass, else its body's", () => {
    const body = { id: 'body-a', label: 'Body A', family: 'test', positions: [], src: 'synthetic example', mass: { g: 5 } } as ConnectorBody;
    const plain = { id: 'plug-a', label: 'Plug A', family: 'test', pins: [], body: 'body-a', src: 'synthetic example' } as ConnectorDefinition;
    const db = { connectors: [plain, { ...plain, id: 'plug-b', mass: { g: 7 } }], wires: [], components: [], pcbas: [], bodies: [body] } as Db;
    expect(effectivePieceMass(db, 'connectors', 'plug-a')).toEqual({ g: 5, from: 'bodies/body-a' });
    expect(effectivePieceMass(db, 'connectors', 'plug-b')).toEqual({ g: 7, from: 'connectors/plug-b' });
    expect(effectivePieceMass({ ...db, bodies: [{ ...body, mass: undefined } as unknown as ConnectorBody] }, 'connectors', 'plug-a')).toBeUndefined();
  });
});
