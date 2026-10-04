/**
 * Part-number search (`src/pn-search.ts`): a cable answers to its own PN,
 * its drawing's PN (a length family too), each length's variation PN, a
 * family query, and its parts' PNs.
 */

import { describe, expect, it } from 'vitest';

import { variationPartNumbers } from '../src/cable-list.ts';
import { cableListRows } from './catalog-in-memory.ts';
import { entryMatches, looksLikePartNumber, matchedPartNumber, pnMatches } from '../src/pn-search.ts';

const rows = cableListRows();
const find = (q: string): string[] => rows.filter((r) => entryMatches(r, q)).map((r) => r.id);

describe('PN matching', () => {
  it('a substring, a family query, and a length inside a family PN', () => {
    expect(pnMatches('00012', 'CBL-00012-03')).toBe(true);
    expect(pnMatches('cbl-00012-3x', 'CBL-00012-34')).toBe(true);
    expect(pnMatches('CBL-00012-35', 'CBL-00012-3X')).toBe(true);
    expect(pnMatches('CBL-00012-45', 'CBL-00012-3X')).toBe(false);
    expect(looksLikePartNumber('xlr cable')).toBe(false);
  });

  it("a drawing's lengths are its variation PNs; the X is notation only", () => {
    expect(variationPartNumbers('CBL-00010-XX', [{ suffix: '-03' }, { suffix: '-10' }])).toEqual(['CBL-00010-03', 'CBL-00010-10']);
  });
});

describe('the starter cable list', () => {
  it("finds the mic cable by its drawing's family PN and by a length's variation PN", () => {
    expect(find('CBL-00010-XX')).toContain('xlr-mic-cable');
    expect(find('CBL-00010-05')).toEqual(['xlr-mic-cable']);
  });

  it("finds cables by a part's PN", () => {
    expect(find('WIR-00002').sort()).toEqual(['db9-null-modem', 'rs485-de9-terminal-board']);
    expect(matchedPartNumber(rows.find((r) => r.id === 'xlr-mic-cable')!, 'WIR-00003')).toBe('WIR-00003');
  });

  it('finds nothing for a number no cable carries', () => {
    expect(find('ZZZ-99999')).toEqual([]);
  });
});
