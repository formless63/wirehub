/** Target/pack drift: every declared target id is unique and its pack is one the runner knows. */

import { describe, expect, it } from 'vitest';

import { firmwareTargets, packOfTarget } from '../server/firmware/targets.ts';
import { TOOL_PACKS } from '../server/tools/packs.ts';

describe('firmware targets', () => {
  it('have unique ids and registered packs', () => {
    const targets = firmwareTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
    for (const t of targets) {
      expect(TOOL_PACKS[t.pack ?? ''], t.id).toBeDefined();
      expect(packOfTarget(t.id)).toBe(t.pack);
    }
  });
});
