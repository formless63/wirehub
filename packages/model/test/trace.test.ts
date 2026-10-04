/**
 * Signal tracing over the starter catalog's example designs: which terminal
 * reaches which, and what it passed through. This is the shape a
 * continuity/test spec derives from.
 */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import { reachedTerminal, trace, type CableDesign, type Db, type TerminalRef } from '../src/index.ts';

const db: Db = loadDb();

function passages(design: CableDesign, from: TerminalRef, to: string): string[] {
  const result = trace(design, db, from);
  const step = reachedTerminal(result, to);
  expect(step, `${from.instance}:${from.terminal} should reach ${to}`).toBeDefined();
  return (step?.passages ?? []).map((p) => p.description);
}

describe('de9-crossover', () => {
  const design = loadDesign('de9-crossover');

  it('pin 3 at end A reaches pin 2 at end B through nothing', () => {
    expect(passages(design, { instance: 'j1', terminal: '3' }, 'j2:2')).toEqual([]);
  });

  it('pin 2 at end A reaches pin 3 at end B', () => {
    expect(passages(design, { instance: 'j1', terminal: '2' }, 'j2:3')).toEqual([]);
  });

  it('pin 5 runs straight through', () => {
    expect(passages(design, { instance: 'j1', terminal: '5' }, 'j2:5')).toEqual([]);
  });

  it('the 7–8 loopback stays at its own end and never crosses the cable', () => {
    const result = trace(design, db, { instance: 'j1', terminal: '7' });
    expect(reachedTerminal(result, 'j1:8')).toBeDefined();
    expect(reachedTerminal(result, 'j2:8')).toBeUndefined();
  });
});

describe('de9-terminal-board', () => {
  const design = loadDesign('de9-terminal-board');

  it('B (pin 3) reaches terminal 2 of the board through nothing', () => {
    expect(passages(design, { instance: 'j1', terminal: '3' }, 'u1:tb.2')).toEqual([]);
  });

  it('A (pin 8) reaches B across the 120 Ω termination', () => {
    const via = passages(design, { instance: 'j1', terminal: '8' }, 'j1:3');
    expect(via).toHaveLength(1);
    expect(via[0]).toContain('120 Ω');
  });

  it('the shield lands on terminal 4 through the drain pigtail', () => {
    expect(passages(design, { instance: 'j1', terminal: 'shell' }, 'u1:tb.4')).toEqual([]);
  });
});

describe('dc-led-lead', () => {
  const design = loadDesign('dc-led-lead');

  it('the supply reaches the module connector through the series resistor', () => {
    const via = passages(design, { instance: 'j1', terminal: '1' }, 'j2:1');
    expect(via).toHaveLength(1);
    expect(via[0]).toContain('r1');
  });

  it('0 V runs straight through', () => {
    expect(passages(design, { instance: 'j1', terminal: '2' }, 'j2:2')).toEqual([]);
  });
});

describe('dc-y-splitter', () => {
  const design = loadDesign('dc-y-splitter');

  it('channel 1 + reaches the channel 1 plug through the mould splice', () => {
    expect(passages(design, { instance: 'j1', terminal: '1' }, 'j2:1')).toEqual([]);
  });

  it('channel 2 + reaches the channel 2 plug and not channel 1', () => {
    const result = trace(design, db, { instance: 'j1', terminal: '3' });
    expect(reachedTerminal(result, 'j3:1')).toBeDefined();
    expect(reachedTerminal(result, 'j2:1')).toBeUndefined();
  });
});
