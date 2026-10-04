/**
 * The node picker's compatibility and ranking (
 *), on real designs and real free terminals: core's
 * `jointCompatibility` decides what fits, `picker.ts` ranks what does.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { profileTerminal, type Db, type TerminalRef } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { paletteEntries } from '../src/panels/Palette.tsx';
import {
  anchorSide,
  autoWireTerminal,
  compatibleTerminals,
  defTerminals,
  fitsAnchor,
  rankDefinitions,
  rankTerminals,
} from '../src/picker.ts';

const db: Db = loadDb();
const entries = paletteEntries(db);

describe('defTerminals', () => {
  it('lists a connector by pin id', () => {
    expect(defTerminals('connector', 'rca-male', db).length).toBeGreaterThan(0);
  });

  it('lists a wire element at both ends', () => {
    const terminals = defTerminals('segment', 'mic-2core-braid', db);
    expect(terminals.length).toBeGreaterThan(0);
    expect(terminals.every((t) => t.end === 'a' || t.end === 'b')).toBe(true);
  });

  it('an unknown definition has no terminals to try', () => {
    expect(defTerminals('connector', 'no-such-def', db)).toEqual([]);
  });
});

describe("a board's cable-side data pad — u1:A on the RS-485 board design", () => {
  // a pad may take more than one wire, so the picker ranks against it
  // whether or not something is already on it
  const design = loadDesign('rs485-de9-terminal-board');
  const anchor: TerminalRef = { instance: 'u1', terminal: 'A' };
  const { fits, other } = rankDefinitions(design, db, anchor, entries);

  it('other boards do not fit a signal pad — boards are linked by wire', () => {
    expect(fits.some((entry) => entry.kind === 'pcba')).toBe(false);
    expect(other.some((entry) => entry.kind === 'pcba')).toBe(true);
  });
});


describe('a shield handle — w1:drain@b on the RS-485 board design', () => {
  // the drain is a screen: whatever it lands on must be at ground
  const design = loadDesign('rs485-de9-terminal-board');
  const anchor: TerminalRef = { instance: 'w1', terminal: 'drain', end: 'b' };
  const { fits, other } = rankDefinitions(design, db, anchor, entries);

  it('only ground-ish terminals fit', () => {
    expect(fits.length).toBeGreaterThan(0);
    for (const entry of fits) {
      for (const candidate of compatibleTerminals(design, db, anchor, entry.kind, entry.def)) {
        const profile = profileTerminal(db, entry.kind, entry.def, candidate.terminal);
        expect(profile?.ground, `${entry.def}:${candidate.terminal}`).toBe(true);
      }
    }
  });

  it('a signal-only part does not fit (a resistor lead is not ground)', () => {
    expect(other.some((entry) => entry.kind === 'component')).toBe(true);
    expect(fits.some((entry) => entry.kind === 'component')).toBe(false);
  });

  it('many equally good ground pins — nothing is auto-wired', () => {
    expect(autoWireTerminal(rankTerminals(design, db, anchor, 'connector', 'scart-male'))).toBeUndefined();
    // …but a connector with exactly one ground terminal is unambiguous
    expect(autoWireTerminal(rankTerminals(design, db, anchor, 'connector', 'rca-male'))).toEqual({ terminal: 'sleeve' });
  });
});

describe('fitsAnchor / compatibleTerminals agree with the ranking', () => {
  const design = loadDesign('rs485-de9-terminal-board');
  const anchor: TerminalRef = { instance: 'j1', terminal: '7' };

  it('fits iff at least one terminal is compatible', () => {
    for (const entry of entries) {
      const compatible = compatibleTerminals(design, db, anchor, entry.kind, entry.def);
      expect(fitsAnchor(design, db, anchor, entry.kind, entry.def)).toBe(compatible.length > 0);
    }
  });

  it('an anchor or definition core cannot resolve fits nothing', () => {
    expect(fitsAnchor(design, db, anchor, 'connector', 'no-such-def')).toBe(false);
    expect(rankDefinitions(design, db, { instance: 'nope', terminal: '1' }, entries).fits).toEqual([]);
  });
});
