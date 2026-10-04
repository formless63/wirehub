/**
 * Signal tracing over the starter catalog's example designs: which terminal
 * reaches which, and what it passed through. This is the shape a
 * continuity/test spec derives from.
 */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@cable-studio/catalog';

import { reachedTerminal, trace, type CableDesign, type Db, type TerminalRef } from '../src/index.ts';

const db: Db = loadDb();

function passages(design: CableDesign, from: TerminalRef, to: string): string[] {
  const result = trace(design, db, from);
  const step = reachedTerminal(result, to);
  expect(step, `${from.instance}:${from.terminal} should reach ${to}`).toBeDefined();
  return (step?.passages ?? []).map((p) => p.description);
}

describe('db9-null-modem', () => {
  const design = loadDesign('db9-null-modem');

  it('TXD at end A reaches RXD at end B through nothing', () => {
    expect(passages(design, { instance: 'j1', terminal: '3' }, 'j2:2')).toEqual([]);
  });

  it('RXD at end A reaches TXD at end B', () => {
    expect(passages(design, { instance: 'j1', terminal: '2' }, 'j2:3')).toEqual([]);
  });

  it('signal ground runs straight through', () => {
    expect(passages(design, { instance: 'j1', terminal: '5' }, 'j2:5')).toEqual([]);
  });

  it('RTS loops back to CTS at its own end and never crosses the cable', () => {
    const result = trace(design, db, { instance: 'j1', terminal: '7' });
    expect(reachedTerminal(result, 'j1:8')).toBeDefined();
    expect(reachedTerminal(result, 'j2:8')).toBeUndefined();
  });
});

describe('rs485-de9-terminal-board', () => {
  const design = loadDesign('rs485-de9-terminal-board');

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

describe('usb-a-led-lead', () => {
  const design = loadDesign('usb-a-led-lead');

  it('VBUS reaches the module connector through the series resistor', () => {
    const via = passages(design, { instance: 'j1', terminal: '1' }, 'j2:1');
    expect(via).toHaveLength(1);
    expect(via[0]).toContain('r1');
  });

  it('GND runs straight through', () => {
    expect(passages(design, { instance: 'j1', terminal: '4' }, 'j2:2')).toEqual([]);
  });
});

describe('trs-to-2rca-y', () => {
  const design = loadDesign('trs-to-2rca-y');

  it('the tip (left) reaches the left RCA tip through the mould splice', () => {
    expect(passages(design, { instance: 'j1', terminal: 'tip' }, 'j2:tip')).toEqual([]);
  });

  it('the ring (right) reaches the right RCA tip and not the left', () => {
    const result = trace(design, db, { instance: 'j1', terminal: 'ring' });
    expect(reachedTerminal(result, 'j3:tip')).toBeDefined();
    expect(reachedTerminal(result, 'j2:tip')).toBeUndefined();
  });
});
