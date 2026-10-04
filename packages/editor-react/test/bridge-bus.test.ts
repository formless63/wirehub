/**
 * — the geometry of a part's quiet ground bus: groups of
 * commoned terminals, one straight trunk each in the channel between the pin
 * rows, square stubs to it.
 */

import { describe, expect, it } from 'vitest';

import { bridgeGroups, busPaths, type Bridge } from '../src/bridge-bus.ts';

const bridge = (a: string, b: string, index: number, selected = false): Bridge => ({ a, b, index, selected });

describe('bridgeGroups', () => {
  it('joins bridges that share a terminal into one group, keeps separate ones apart', () => {
    const groups = bridgeGroups([bridge('j1:6', 'j1:5', 5), bridge('j1:6', 'j1:7', 6), bridge('j1:1', 'j1:2', 9), bridge('j1:7', 'j1:10', 7)]);
    expect(groups.map((g) => g.keys)).toEqual([
      ['j1:1', 'j1:2'],
      ['j1:10', 'j1:5', 'j1:6', 'j1:7'],
    ]);
    expect(groups[1]!.bridges.map((b) => b.index)).toEqual([5, 6, 7]);
  });
});

describe('busPaths', () => {
  // a D-sub-ish face: row 1 at y=10, row 2 at y=20, row 3 at y=30
  const points = new Map([
    ['j1:5', { x: 50, y: 10 }],
    ['j1:6', { x: 10, y: 20 }],
    ['j1:7', { x: 20, y: 20 }],
    ['j1:8', { x: 30, y: 20 }],
    ['j1:10', { x: 50, y: 20 }],
    ['j1:13', { x: 30, y: 30 }],
  ]);
  const hd15 = [bridge('j1:6', 'j1:5', 5), bridge('j1:6', 'j1:7', 6), bridge('j1:6', 'j1:8', 7), bridge('j1:6', 'j1:10', 8)];

  it('runs the trunk in the channel between the rows the group sits on, stubs square to it', () => {
    const [path] = busPaths(points, hd15);
    expect(path?.keys).toEqual(['j1:10', 'j1:5', 'j1:6', 'j1:7', 'j1:8']);
    expect(path?.joints).toEqual([5, 6, 7, 8]);
    // trunk at y = 15 (between rows 1 and 2), across x 10…50
    expect(path?.d.startsWith('M10 15H50')).toBe(true);
    for (const stub of ['M50 10V15', 'M10 20V15', 'M20 20V15', 'M30 20V15', 'M50 20V15']) expect(path?.d).toContain(stub);
    expect(path?.d).toMatch(/^(M[-\d.]+ [-\d.]+[HV][-\d.]+)+$/);
  });

  it('a group on one row sits a gap off it, toward the part', () => {
    const [path] = busPaths(points, [bridge('j1:6', 'j1:7', 1)], { gap: 4, toward: { x: 30, y: 0 } });
    expect(path?.d).toBe('M10 16H20M10 20V16M20 20V16');
  });

  it('a column of pads gets a vertical trunk', () => {
    const column = new Map([
      ['u1:gnd1', { x: 100, y: 10 }],
      ['u1:gnd2', { x: 100, y: 40 }],
    ]);
    const [path] = busPaths(column, [bridge('u1:gnd1', 'u1:gnd2', 3)], { gap: 5, toward: { x: 50, y: 25 } });
    expect(path?.d).toBe('M95 10V40M100 10H95M100 40H95');
  });

  it('marks the group selected when any of its bridges is, and skips a group with a terminal it cannot place', () => {
    expect(busPaths(points, [bridge('j1:6', 'j1:7', 1, true)])[0]?.selected).toBe(true);
    expect(busPaths(points, [bridge('j1:6', 'j1:99', 1)])).toEqual([]);
  });
});
