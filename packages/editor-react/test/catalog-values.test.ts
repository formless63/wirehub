/**
 * The Library's suggestion lists are read off the catalog itself —
 * no vocabulary of their own.
 */

import { describe, expect, it } from 'vitest';

import { catalogValues, distinctValues } from '../src/catalog-values.ts';
import { loadDbFromDisk } from './fixture.ts';

describe('catalogValues', () => {
  const db = loadDbFromDisk();
  const values = catalogValues(db);

  it('offers every connector family and board build the catalog uses', () => {
    for (const connector of db.connectors) {
      if (connector.family !== undefined && connector.family.trim() !== '') {
        expect(values.connectorFamilies.map((f) => f.toLowerCase())).toContain(connector.family.trim().toLowerCase());
      }
    }
    for (const pcba of db.pcbas) {
      if (pcba.build !== undefined && pcba.build.trim() !== '') {
        expect(values.pcbaBuilds.map((b) => b.toLowerCase())).toContain(pcba.build.trim().toLowerCase());
      }
    }
  });

  it('reads materials and colours out of the wire structures', () => {
    expect(values.colors.length).toBeGreaterThan(0);
    expect(values.insulationMaterials.length).toBeGreaterThan(0);
    expect(values.shieldMaterials.length).toBeGreaterThan(0);
  });

  it('dedupes case-insensitively, keeps the first spelling, drops blanks', () => {
    expect(distinctValues(['PVC', 'pvc', ' ', undefined, 'Copper', 'PVC '])).toEqual(['Copper', 'PVC']);
  });
});
