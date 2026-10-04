/** Structural validation: the example designs are clean, and broken variants name the right issue. */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import { errors, validateDesign, type CableDesign } from '../src/index.ts';

const db = loadDb();
const codes = (design: CableDesign): string[] => validateDesign(design, db).map((i) => i.code);
const clone = (id: string): CableDesign => structuredClone(loadDesign(id));

describe('the example designs', () => {
  for (const id of listDesignIds()) {
    it(`${id} has no issues at all`, () => {
      expect(validateDesign(loadDesign(id), db)).toEqual([]);
    });
  }
});

describe('broken variants', () => {
  it('flags an unknown connector definition', () => {
    const d = clone('de9-crossover');
    d.instances.connectors[0]!.def = 'no-such-connector';
    expect(codes(d)).toContain('unknown-def');
  });

  it('flags a segment terminal with no end', () => {
    const d = clone('de9-crossover');
    delete d.joints[0]!.b.end;
    expect(errors(validateDesign(d, db)).length).toBeGreaterThan(0);
  });

  it('flags an end on a connector terminal', () => {
    const d = clone('de9-crossover');
    d.joints[0]!.a.end = 'a';
    expect(errors(validateDesign(d, db)).length).toBeGreaterThan(0);
  });

  it('flags a joint onto the jacket (not electrical)', () => {
    const d = clone('de9-crossover');
    d.joints[0]!.b.terminal = 'jacket';
    expect(errors(validateDesign(d, db)).length).toBeGreaterThan(0);
  });

  it('flags an unresolvable element path and an unknown pin', () => {
    const d = clone('de9-crossover');
    d.joints[0]!.b.terminal = 'pair-9.a';
    d.joints[1]!.b.terminal = '99';
    expect(errors(validateDesign(d, db)).length).toBeGreaterThanOrEqual(2);
  });

  it('flags a duplicate instance id', () => {
    const d = clone('de9-crossover');
    d.instances.connectors[1]!.id = 'j1';
    expect(codes(d)).toContain('duplicate-instance-id');
  });

  it('warns about a conductor landed at one end only', () => {
    const d = clone('de9-crossover');
    d.joints = d.joints.filter((j) => !(j.a.instance === 'w1' && j.a.terminal === 'pair-1.a' && j.a.end === 'b'));
    expect(validateDesign(d, db).some((i) => i.severity === 'warning')).toBe(true);
  });

  it('refuses extensions that are not an object', () => {
    const d = { ...clone('de9-crossover'), extensions: ['nope'] as unknown } as unknown as CableDesign;
    expect(codes(d)).toContain('invalid-extensions');
  });

  it('carries module extension data through validation untouched', () => {
    const d = clone('de9-crossover');
    d.extensions = { example: { anything: [1, 2, 3] } };
    expect(validateDesign(d, db)).toEqual([]);
  });
});
