/**
 * Galvanic nets, plus the two kinds of net boundary: discrete components and
 * `via`-annotated PCBA links.
 */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import { deriveNets, netForTerminal } from '../src/index.ts';

const db = loadDb();

describe('the DE-9 crossover lead', () => {
  const design = loadDesign('de9-crossover');
  const nets = deriveNets(design, db);
  const keysOf = (instance: string, terminal: string): string[] =>
    (netForTerminal(nets, { instance, terminal })?.terminals ?? []).map((t) => t.key);

  it('crosses 2 and 3 end to end and runs 5 straight', () => {
    expect(keysOf('j1', '3')).toContain('j2:2');
    expect(keysOf('j1', '3')).not.toContain('j2:3');
    expect(keysOf('j1', '2')).toContain('j2:3');
    expect(keysOf('j1', '5')).toContain('j2:5');
  });

  it('joins the loopback jumpers at each end into one net, apart from the far end', () => {
    expect(keysOf('j1', '4')).toEqual(expect.arrayContaining(['j1:1', 'j1:6']));
    expect(keysOf('j1', '4')).not.toContain('j2:4');
  });
});

describe('the terminal adapter board lead', () => {
  const design = loadDesign('de9-terminal-board');
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
  const design = loadDesign('dc-led-lead');
  const nets = deriveNets(design, db);

  it('components split nets: the supply stops at the resistor', () => {
    const keys = (netForTerminal(nets, { instance: 'j1', terminal: '1' })?.terminals ?? []).map((t) => t.key);
    expect(keys).toContain('r1:a');
    expect(keys).not.toContain('r1:b');
    expect(keys).not.toContain('j2:1');
  });
});
