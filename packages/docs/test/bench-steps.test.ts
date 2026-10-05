/**
 * The work-instruction hook: a registered provider replaces the generic bench
 * steps for the phases it answers, and removing it restores them byte for byte.
 */

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { registerBenchSteps, renderBuildSheet } from '../src/index.ts';

const db = loadDb();
const design = loadDesign(listDesignIds()[0]!);

describe('registerBenchSteps', () => {
  it('swaps the generic steps for a shop\'s own and restores them', () => {
    const before = renderBuildSheet(design, db);
    expect(before).not.toContain('SHOP-WI-7');
    const off = registerBenchSteps({
      prep: () => [{ text: 'Strip per SHOP-WI-7.', src: 'shop work instruction 7' }],
      solder: { text: 'Solder per SHOP-WI-9.', src: 'shop work instruction 9' },
      qa: [{ text: 'Final check per SHOP-WI-11.', src: 'shop work instruction 11' }],
    });
    try {
      const during = renderBuildSheet(design, db);
      expect(during).toContain('SHOP-WI-7');
      expect(during).toContain('SHOP-WI-9');
      expect(during).toContain('SHOP-WI-11');
      expect(during).not.toContain('Cut to length');
    } finally {
      off();
    }
    expect(renderBuildSheet(design, db)).toBe(before);
  });
});
