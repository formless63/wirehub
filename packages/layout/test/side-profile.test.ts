/**
 * Side-view (profile) connector drawings as data: a facing-aware record a pack
 * contributes, mirrored when the wire leaves from the right, and the base's
 * generic plug where no pack draws the family.
 */

import { parseConnectorArt, type ConnectorArtRecord } from '@wirehub/catalog';
import type { ConnectorDefinition } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { connectorArt, registerConnectorArt } from '../src/index.ts';

const def = (id: string, family: string, pins: string[], gender: 'male' | 'female' = 'male'): ConnectorDefinition =>
  ({ id, label: id, family, gender, pins: pins.map((p) => ({ id: p, label: p })) }) as unknown as ConnectorDefinition;

const toy: ConnectorArtRecord = {
  id: 'toy-profile',
  view: 'profile',
  gender: 'male',
  families: ['rca'],
  short: 'TOY',
  width: 100,
  height: 20,
  approximate: false,
  shapes: [
    { el: 'rect', x: 6, y: 4, width: 12, height: 3, tone: 'copper', band: 'tip' },
    { el: 'path', d: 'M18 4 L40 2 L40 18 H18 V4 Z', tone: 'boot' },
    { el: 'circle', cx: 30, cy: 10, r: 2, tone: 'dark' },
  ],
  pins: [
    { terminal: 'tip', form: 'lug', x: 5, y: 5, r: 2 },
    { terminal: 'sleeve', form: 'lug', x: 5, y: 15, r: 2, ifDefined: true },
  ],
  labels: [{ x: 10, y: 19, text: 'T', anchor: 'start' }],
  src: 'test',
};

describe('a profile record', () => {
  it('draws as drawn with the wire on the left, and mirrored with the wire on the right', () => {
    const off = registerConnectorArt([toy]);
    try {
      const plug = def('p', 'rca', ['tip', 'sleeve']);
      const left = connectorArt({ def: plug, facing: 'left' })!;
      const right = connectorArt({ def: plug, facing: 'right' })!;
      expect(left).toMatchObject({ view: 'profile', facing: 'left', short: 'TOY', width: 100, approximate: false });
      expect(left.pins.map((p) => [p.terminal, p.x])).toEqual([['tip', 5], ['sleeve', 5]]);
      expect(right).toMatchObject({ view: 'profile', facing: 'right' });
      expect(right.pins.map((p) => [p.terminal, p.x, p.y])).toEqual([['tip', 95, 5], ['sleeve', 95, 15]]);
      expect(right.shapes).toEqual([
        { el: 'rect', x: 82, y: 4, width: 12, height: 3, tone: 'copper', band: 'tip' },
        { el: 'path', d: 'M82 4 L60 2 L60 18 H82 V4 Z', tone: 'boot' },
        { el: 'circle', cx: 70, cy: 10, r: 2, tone: 'dark' },
      ]);
      expect(right.labels).toEqual([{ x: 90, y: 19, text: 'T', anchor: 'end' }]);
      // mirroring twice is the identity
      expect(connectorArt({ def: plug, facing: 'left' })).toEqual(left);
    } finally {
      off();
    }
  });

  it('keeps a pin the connector may omit only when it has it, and draws nothing for a pin it lacks', () => {
    const off = registerConnectorArt([toy]);
    try {
      expect(connectorArt({ def: def('p', 'rca', ['tip']), facing: 'left' })!.pins.map((p) => p.terminal)).toEqual(['tip']);
      expect(connectorArt({ def: def('p', 'rca', ['tip', 'ring']), facing: 'left' })).toBeUndefined();
    } finally {
      off();
    }
  });

  it('matches by gender', () => {
    const off = registerConnectorArt([toy]);
    try {
      expect(connectorArt({ def: def('j', 'rca', ['tip', 'sleeve'], 'female'), facing: 'left' })?.short).toBe('Jack');
    } finally {
      off();
    }
  });

  it('is validated: a profile path a mirror cannot reflect, a bad view, a bad gender', () => {
    const issues = (patch: Record<string, unknown>): string[] => parseConnectorArt({ ...toy, ...patch }, 'x').issues.map((i) => i.message);
    expect(issues({})).toEqual([]);
    expect(issues({ shapes: [{ el: 'path', d: 'M18 4 l4 4', tone: 'boot' }] }).join()).toContain('absolute');
    expect(issues({ shapes: [{ el: 'path', d: 'M18 4 C 1 2 3 4 5 6', tone: 'boot' }] }).join()).toContain('absolute');
    expect(issues({ view: 'top' }).join()).toContain('view must be');
    expect(issues({ gender: 'neuter' }).join()).toContain('gender must be');
    // a face is never mirrored, so its paths are not held to the rule
    expect(issues({ view: 'face', shapes: [{ el: 'path', d: 'M18 4 c1 1 2 2 3 3', tone: 'boot' }] })).toEqual([]);
  });
});

describe('without a pack', () => {
  it.each([['rca'], ['trs'], ['bnc']])('draws a generic %s plug, approximate, one lug per pin', (family) => {
    const pins = family === 'trs' ? ['tip', 'ring', 'sleeve'] : family === 'bnc' ? ['tip', 'shell'] : ['tip', 'sleeve'];
    const art = connectorArt({ def: def('p', family, pins), facing: 'left' })!;
    expect(art).toMatchObject({ view: 'profile', facing: 'left', short: 'Plug', approximate: true });
    expect(art.pins.map((p) => p.terminal)).toEqual(pins);
    expect(art.pins.every((p) => p.form === 'lug')).toBe(true);
    const right = connectorArt({ def: def('p', family, pins), facing: 'right' })!;
    expect(right.pins.every((p, i) => p.x === Math.round((art.width - (art.pins[i] as { x: number }).x) * 100) / 100)).toBe(true);
    expect(connectorArt({ def: def('p', family, pins), facing: 'left' })).toEqual(art);
  });

  it('keeps the pin list for a pinout too wide for a plug', () => {
    expect(connectorArt({ def: def('p', 'rca', ['1', '2', '3', '4', '5', '6', '7']), facing: 'left' })).toBeUndefined();
  });

  it('draws a family nobody knows as the pin list', () => {
    expect(connectorArt({ def: def('p', 'mystery', ['1', '2']), facing: 'left' })).toBeUndefined();
  });
});
