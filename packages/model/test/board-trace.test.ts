/**
 * traceConductor across a board's native nets (synthetic example board): the
 * invariant that matters is that a missing or contradicting fact never turns
 * into a continuity claim, and that two occurrences of one board trace on
 * their own declarations.
 */

import { describe, expect, it } from 'vitest';
import { loadDb } from '@wirehub/catalog';

import { traceConductor, type CableDesign, type Db, type PcbaDefinition } from '../src/index.ts';

const board: PcbaDefinition = {
  id: 'synthetic-trace-board',
  label: 'Synthetic trace board',
  partNumber: 'SYNTH-TRACE',
  revision: '1',
  terminals: [{ id: 'IN' }, { id: 'MID' }, { id: 'OUT' }, { id: 'AUX' }, { id: 'GND' }],
  // declared as plain copper, but the board file splits IN and OUT: a contradiction
  internalLinks: [{ from: 'IN', to: 'OUT' }],
  netlist: {
    src: 'synthetic example',
    terminals: { IN: '/IN', MID: '/MID', OUT: '/OUT', AUX: '/AUX', GND: 'GND' },
    parts: [
      { ref: 'R1', category: 'resistor', value: '1 kΩ', pins: { '1': '/IN', '2': '/MID' } },
      { ref: 'JP1', category: 'jumper', pins: { '1': '/MID', '2': '/OUT' } },
      { ref: 'R2', category: 'resistor', value: '10 kΩ', dnp: true, pins: { '1': '/MID', '2': '/AUX' } },
      { ref: 'U1', category: 'ic', pins: { '1': '/IN', '2': '/AUX', '3': 'GND' } },
      { ref: 'C1', category: 'capacitor', pins: { '1': '/IN', '2': 'GND' } },
    ],
  },
  src: 'synthetic example',
};

const db: Db = { ...loadDb(), pcbas: [...loadDb().pcbas, board] };

const design: CableDesign = {
  schemaVersion: 4,
  id: 'synthetic-trace',
  label: 'synthetic',
  instances: {
    connectors: [{ id: 'j1', def: 'de9-male' }],
    segments: [],
    components: [],
    pcbas: [
      { id: 'u1', def: board.id, partStates: { JP1: 'closed' } },
      { id: 'u2', def: board.id },
    ],
  },
  joints: [
    { a: { instance: 'j1', terminal: '1' }, b: { instance: 'u1', terminal: 'IN' } },
    { a: { instance: 'j1', terminal: '2' }, b: { instance: 'u2', terminal: 'IN' } },
  ],
} as unknown as CableDesign;

describe('traceConductor', () => {
  it('passes a resistor and a closed jumper, stops at silicon and at a do-not-populate part', () => {
    const result = traceConductor(design, db, { instance: 'j1', terminal: '1' });
    const out = result.reached.find((end) => end.terminal.key === 'u1:OUT');
    expect(out?.kind).toBe('passive');
    expect(out?.hops.filter((h) => h.kind !== 'copper').map((h) => h.description)).toEqual(['u1 R1 1 kΩ']);
    // nothing past U1 or the DNP R2 is claimed
    expect(result.reached.some((end) => end.terminal.key === 'u1:AUX')).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['trace-active-part', 'trace-dnp', 'trace-declared-copper-split']));
    // the decoupling capacitor reaches GND as a passage, but U1's ground pin is not continuity
    expect(result.reached.find((end) => end.terminal.key === 'u1:GND')?.kind).toBe('passive');
  });

  it('a second occurrence without the jumper declared stops there as unknown', () => {
    const result = traceConductor(design, db, { instance: 'j1', terminal: '2' });
    expect(result.reached.some((end) => end.terminal.key === 'u2:MID')).toBe(true);
    expect(result.reached.some((end) => end.terminal.key === 'u2:OUT')).toBe(false);
    expect(result.reached.some((end) => end.terminal.instance === 'u1')).toBe(false);
    expect(result.findings.find((f) => f.code === 'trace-state-undeclared')?.instance).toBe('u2');
  });
});
