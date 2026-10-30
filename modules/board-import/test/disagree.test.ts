/** The KiCad check's safety row: a curated supply on a net named for another voltage (or a ground) comes first. */

import { loadVocab } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { deriveBoard } from '../src/derive.ts';
import { boardDisagreements, signalNetContradiction, signalNetUnstated } from '../src/disagree.ts';
import { parseKicadPcb } from '../src/kicad.ts';
import { kicadPcb } from './synthetic.ts';

const vocab = loadVocab();

describe('curated signal vs net name', () => {
  it('flags a supply of another voltage, or on a ground net, and nothing on an unnumbered or unnamed net', () => {
    expect(signalNetContradiction(vocab, 'pwr-5v', undefined, ['1.5V'])).toBe('curated +5 V, net 1.5V');
    expect(signalNetContradiction(vocab, 'pwr-5v', undefined, ['/3V3'])).toBe('curated +5 V, net 3V3');
    expect(signalNetContradiction(vocab, 'pwr-5v', undefined, ['GND'])).toBe('curated +5 V, net GND');
    expect(signalNetContradiction(vocab, 'gnd', undefined, ['+5V'])).toBe('curated ground, net +5V');
    expect(signalNetContradiction(vocab, 'pwr-5v', undefined, ['+5V'])).toBeUndefined();
    expect(signalNetContradiction(vocab, 'pwr-5v', undefined, ['/V_IN'])).toBeUndefined();
    expect(signalNetContradiction(vocab, 'pwr-5v', undefined, ['Net-(U1-Pad4)'])).toBeUndefined();
  });

  it('marks a supply whose net states no voltage and names no supply, and stays quiet on a stated or conventional rail', () => {
    expect(signalNetUnstated(vocab, 'pwr-5v', undefined, ['/V_IN'])).toBe('curated +5 V, net V_IN');
    expect(signalNetUnstated(vocab, 'pwr-5v', undefined, ['Net-(U1-Pad4)'])).toBe('curated +5 V, net Net-(U1-Pad4)');
    for (const net of ['+5V', '/3V3', 'VBUS', 'VCC', 'AVDD', 'GND']) expect(signalNetUnstated(vocab, 'pwr-5v', undefined, [net])).toBeUndefined();
    expect(signalNetUnstated(vocab, 'pwr-5v', undefined, [])).toBeUndefined();
    expect(signalNetUnstated(vocab, 'gnd', undefined, ['/V_IN'])).toBeUndefined();
    // a contradiction stays red, never amber
    const board = parseKicadPcb(kicadPcb(), 'synthetic-adapter.kicad_pcb');
    const def = deriveBoard(board, { sha256: '0'.repeat(64), id: 'synthetic-adapter' }).pcba;
    const curated = { ...def, terminals: def.terminals.map((t) => (t.id === 'GND' ? { ...t, signal: 'pwr-5v' } : t)) };
    const row = boardDisagreements(curated, board, undefined, vocab).rows[0]!;
    expect(row.issues).toContain('signal-net');
    expect(row.issues).not.toContain('voltage-unstated');
  });

  it('puts the contradicting terminal first in the check', () => {
    const board = parseKicadPcb(kicadPcb(), 'synthetic-adapter.kicad_pcb');
    const def = deriveBoard(board, { sha256: '0'.repeat(64), id: 'synthetic-adapter' }).pcba;
    const curated = { ...def, terminals: def.terminals.map((t) => (t.id === 'GND' ? { ...t, signal: 'pwr-5v' } : t)) };
    const rows = boardDisagreements(curated, board, undefined, vocab).rows;
    expect(rows[0]).toMatchObject({ terminal: 'GND', contradiction: 'curated +5 V, net GND' });
    expect(rows[0]!.issues).toContain('signal-net');
    expect(rows.filter((r) => r.issues.length > 0).map((r) => r.terminal)).toEqual(['GND']);
  });
});
