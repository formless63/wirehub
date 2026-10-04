/**
 * Minimal-diff JSON writes: a GUI save of a
 * hand-formatted file changes the lines that changed and nothing else.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { dataPath } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { canonicalJson, patchJsonText } from '../server/json-text.ts';

/** lines of `b` not in `a`, plus lines of `a` not in `b` — a rough diff size */
function changedLines(a: string, b: string): number {
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const ca = count(a.split('\n'));
  const cb = count(b.split('\n'));
  let n = 0;
  for (const [line, k] of cb) n += Math.max(0, k - (ca.get(line) ?? 0));
  for (const [line, k] of ca) n += Math.max(0, k - (cb.get(line) ?? 0));
  return n;
}

const HAND = `{
  "id": "x",
  "joints": [
    { "a": "j1.1", "b": "w1.red@a" },
    { "a": "j1.2", "b": "w1.green@a" },

    { "a": "j1.5", "b": "w1.shield@a" }
  ],
  "pins": [{ "id": "1", "label": "Red" }, { "id": "2", "label": "Green" }]
}
`;

describe('patchJsonText', () => {
  it('returns the text untouched when nothing changed', () => {
    expect(patchJsonText(HAND, JSON.parse(HAND))).toBe(HAND);
  });

  it('changes one value in place, keeping one-line objects and blank-line groups', () => {
    const next = JSON.parse(HAND);
    next.joints[2].b = 'w1.drain@a';
    const out = patchJsonText(HAND, next);
    expect(out).toBe(HAND.replace('w1.shield@a', 'w1.drain@a'));
  });

  it('adds, removes and inserts elements in the neighbours style', () => {
    const next = JSON.parse(HAND);
    next.joints.splice(1, 1);
    next.joints.push({ a: 'j1.9', b: 'w1.blue@a' });
    next.pins.push({ id: '3', label: 'Blue' });
    next.note = 'added';
    const out = patchJsonText(HAND, next);
    expect(JSON.parse(out)).toEqual(next);
    expect(out).toContain('    { "a": "j1.9", "b": "w1.blue@a" }');
    expect(out).toContain('{ "id": "3", "label": "Blue" }]');
    expect(out).toContain('\n\n    { "a": "j1.5"');
    expect(out).toContain('  "note": "added"\n}');
  });

  it('removes a member without leaving a stray comma', () => {
    const next = JSON.parse(HAND);
    delete next.pins;
    const out = patchJsonText(HAND, next);
    expect(JSON.parse(out)).toEqual(next);
    expect(out.trimEnd().endsWith(']\n}')).toBe(true);
  });

  it('falls back to the canonical form for a file that will not parse', () => {
    expect(patchJsonText('{ nope', { a: 1 })).toBe(canonicalJson({ a: 1 }));
  });

  it('a one-field edit to every real design and definition file is a small diff', () => {
    const files = [
      ...readdirSync(dataPath('designs')).filter((f) => f.endsWith('.json')).map((f) => dataPath(`designs/${f}`)),
      ...['connectors', 'components', 'wires', 'pcbas', 'mechanicals'].map((k) => dataPath(`${k}.json`)),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const value = JSON.parse(text);
      const target = Array.isArray(value) ? value[Math.floor(value.length / 2)] : value;
      if (target === undefined) continue;
      target.label = `${String(target.label ?? '')} (edited)`;
      const out = patchJsonText(text, value);
      expect(JSON.parse(out), file).toEqual(value);
      // the label line, before and after — nothing else moves
      expect(changedLines(text, out), file).toBeLessThanOrEqual(2);
    }
  });
});
