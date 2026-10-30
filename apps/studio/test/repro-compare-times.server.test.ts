/** A real change on a line that also carries a time stamp is a difference, not "only times". */

import { describe, expect, it } from 'vitest';

import { lineDiff } from '../server/repro/compare.ts';

describe('only-times rule', () => {
  it('compact JSON: a changed value next to a stamp differs', () => {
    expect(lineDiff('{"generatedAt":"2026-10-21T00:00:00Z","wallMm":2}', '{"generatedAt":"2026-10-22T00:00:00Z","wallMm":9}').onlyTimes).toBe(false);
    expect(lineDiff('{"generatedAt":"2026-10-21T00:00:00Z","wallMm":2}', '{"generatedAt":"2026-10-22T00:00:00Z","wallMm":2}').onlyTimes).toBe(true);
  });

  it('STEP/SVG header lines: only the stamp may move', () => {
    const step = (at: string, name: string): string => `ISO-10303-21;\nFILE_NAME('${name}','${at}',(''),(''),'','','');\nENDSEC;`;
    expect(lineDiff(step('2026-10-21T01:02:03', 'box.step'), step('2026-10-22T04:05:06', 'box.step')).onlyTimes).toBe(true);
    expect(lineDiff(step('2026-10-21T01:02:03', 'box.step'), step('2026-10-22T04:05:06', 'lid.step')).onlyTimes).toBe(false);
    expect(lineDiff('<!-- made 2026-10-21 10:00:00 --><rect width="2"/>', '<!-- made 2026-10-22 11:00:00 --><rect width="3"/>').onlyTimes).toBe(false);
  });
});
