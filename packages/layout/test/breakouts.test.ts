/** Breakout moulds on the schematic. */

import { describe, expect, it } from 'vitest';

import { loadDb, loadDesign } from '@wirehub/catalog';

import { layoutSchematic } from '../src/index.ts';

const db = loadDb();

describe('breakout moulds', () => {
  it('dc-y-splitter: the legs run on out of the mould, the stem’s screen marked NC', () => {
    const diagram = layoutSchematic(loadDesign('dc-y-splitter'), db, { depictions: false });
    const mould = diagram.breakouts?.[0];
    expect(mould).toBeDefined();
    expect(mould!.rows.filter((row) => row.fate === 'nc').map((row) => row.key).sort()).toEqual(['w1:drain@b']);
    const trunk = diagram.bands.find((band) => band.segment === 'w1')!;
    for (const leg of diagram.bands.filter((band) => band.segment !== 'w1')) {
      expect(leg.rect.x).toBeGreaterThan(trunk.rect.x + trunk.rect.w);
      expect(leg.leftEnd).toBe('a');
    }
  });

  it('a design without breakouts has none on its diagram', () => {
    expect(layoutSchematic(loadDesign('dc-led-lead'), db, { depictions: false }).breakouts).toBeUndefined();
  });
});
