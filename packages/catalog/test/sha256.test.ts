import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/sha256.ts';

describe('sha256Hex', () => {
  it('matches node:crypto across padding boundaries and bytes', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4097]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(sha256Hex('héllo ✓')).toBe(createHash('sha256').update('héllo ✓').digest('hex'));
  });
});
