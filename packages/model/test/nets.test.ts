/**
 * Galvanic nets, plus the two kinds of net boundary: discrete components and
 * `via`-annotated PCBA links.
 */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@cable-studio/catalog';

import { deriveNets, netForTerminal } from '../src/index.ts';

const db = loadDb();

describe('the RJ45 patch cord', () => {
  const design = loadDesign('rj45-patch-t568b');
  const nets = deriveNets(design, db);

  it('has one net per pin, each joining the same pin at both ends', () => {
    for (let pin = 1; pin <= 8; pin += 1) {
      const keys = (netForTerminal(nets, { instance: 'j1', terminal: String(pin) })?.terminals ?? []).map((t) => t.key);
      expect(keys).toContain(`j2:${pin}`);
      for (let other = 1; other <= 8; other += 1) if (other !== pin) expect(keys).not.toContain(`j2:${other}`);
    }
  });
});

describe('the RS-485 adapter', () => {
  const design = loadDesign('rs485-de9-terminal-board');
  const nets = deriveNets(design, db);
  const keysOf = (instance: string, terminal: string): string[] =>
    (netForTerminal(nets, { instance, terminal })?.terminals ?? []).map((t) => t.key);

  it('the shield net holds the shell, the foil and drain at both ends, and the board shield terminal', () => {
    const keys = keysOf('j1', 'shell');
    expect(keys).toEqual(expect.arrayContaining(['w1:foil@a', 'w1:drain@a', 'w1:foil@b', 'w1:drain@b', 'u1:SHLD', 'u1:tb.4']));
  });

  it('the termination resistor is a net boundary: A and B are different nets', () => {
    expect(keysOf('u1', 'A')).not.toContain('u1:B');
  });
});

describe('the LED lead', () => {
  const design = loadDesign('usb-a-led-lead');
  const nets = deriveNets(design, db);

  it('components split nets: VBUS stops at the resistor', () => {
    const keys = (netForTerminal(nets, { instance: 'j1', terminal: '1' })?.terminals ?? []).map((t) => t.key);
    expect(keys).toContain('r1:a');
    expect(keys).not.toContain('r1:b');
    expect(keys).not.toContain('j2:1');
  });
});
