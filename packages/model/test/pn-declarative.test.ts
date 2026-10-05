/** Declarative part-number schemes: parse, check, propose, health report, bounds. */

import { describe, expect, it } from 'vitest';

import {
  declarativePartNumberScheme,
  declarativeSchemeProblems,
  partNumberReport,
  schemeFromConfig,
  type DeclarativeSchemeConfig,
  type Db,
} from '../src/index.ts';

/** the generic example in docs/part-numbers.md: <Level><Type>-NNNNNN-VV */
export const EXAMPLE: DeclarativeSchemeConfig = {
  type: 'declarative',
  id: 'level-type-seq',
  label: 'Level and type, sequence, variant',
  template: '{level}{type}-{seq}-{variant}',
  segments: [
    {
      id: 'level',
      type: 'choice',
      label: 'Level',
      values: [
        { value: '1', label: 'Part', kinds: ['connector', 'wire', 'component', 'shell'] },
        { value: '2', label: 'Assembly', kinds: ['pcba', 'design'] },
      ],
    },
    {
      id: 'type',
      type: 'choice',
      label: 'Type',
      values: [
        { value: 'C', label: 'Connector', kinds: ['connector', 'shell'] },
        { value: 'W', label: 'Wire', kinds: ['wire'] },
        { value: 'E', label: 'Component', kinds: ['component'] },
        { value: 'B', label: 'Board', kinds: ['pcba'] },
        { value: 'A', label: 'Cable assembly', kinds: ['design'] },
      ],
    },
    {
      id: 'seq',
      type: 'counter',
      label: 'Sequence',
      width: 6,
      per: ['level', 'type'],
      ranges: [
        { match: { level: '1', type: 'C' }, from: 100, to: 199999 },
        { from: 1, to: 999999 },
      ],
    },
    { id: 'variant', type: 'variant', label: 'Variant', style: 'numeric', width: 2, first: '00', max: '20', kinds: ['connector', 'wire', 'design'] },
  ],
  validation: { regex: '^[12][A-Z]-\\d{6}-\\d{2}$', message: 'must look like 1C-000100-00' },
  immutable: true,
  src: 'synthetic example',
};

describe('a valid definition', () => {
  const scheme = declarativePartNumberScheme(EXAMPLE);

  it('has no problems and a readable shape', () => {
    expect(declarativeSchemeProblems(EXAMPLE)).toEqual([]);
    expect(scheme.shape).toBe('<level><type>-NNNNNN-VV');
    expect(scheme.immutable).toBe(true);
    expect(schemeFromConfig(EXAMPLE).id).toBe('level-type-seq');
  });

  it('parses and canonicalises its own numbers, and nothing else', () => {
    expect(scheme.parse(' 1c-000100-00 ')).toBe('1C-000100-00');
    expect(scheme.parse('2A-000001-03')).toBe('2A-000001-03');
    expect(scheme.parse('1C-100-00')).toBeUndefined();
    expect(scheme.parse('3C-000100-00')).toBeUndefined();
    expect(scheme.parse('1C-000100')).toBeUndefined();
    expect(scheme.parse('x'.repeat(500))).toBeUndefined();
  });

  it('checks values against the kind, ranges, variants and the regex', () => {
    expect(scheme.check('1C-000100-00', 'connector')).toEqual([]);
    expect(scheme.check('1C-000100-00', 'wire').map((i) => i.code)).toEqual(['pn-wrong-kind']);
    expect(scheme.check('1C-000050-00', 'connector').map((i) => i.code)).toEqual(['pn-out-of-range']);
    expect(scheme.check('1W-000001-21', 'wire').map((i) => i.code)).toEqual(['pn-out-of-range']);
    expect(scheme.check('1E-000001-01', 'component').map((i) => i.code)).toEqual(['pn-wrong-kind']);
    const bad = scheme.check('not-a-number');
    expect(bad.map((i) => i.code)).toEqual(['pn-malformed']);
    expect(bad[0]?.severity).toBe('warning');
  });

  it('proposes the next free number per combination, within its range', () => {
    const known = [
      { pn: '1C-000100-00', source: 'a' },
      { pn: '1C-000101-00', source: 'b' },
      { pn: '1W-000007-00', source: 'c' },
      { pn: '2A-000009-00', source: 'd' },
    ];
    expect(scheme.suggest({ kind: 'connector', label: 'x' }, known)?.pn).toBe('1C-000102-00');
    expect(scheme.suggest({ kind: 'connector', label: 'x' }, [])?.pn).toBe('1C-000100-00');
    expect(scheme.suggest({ kind: 'wire', label: 'x' }, known)?.pn).toBe('1W-000008-00');
    expect(scheme.suggest({ kind: 'design', label: 'x' }, known)?.pn).toBe('2A-000010-00');
    // a kind no value names is not numbered
    expect(scheme.suggest({ kind: 'kit', label: 'x' }, known)).toBeUndefined();
    // a kind that carries no variant, in a scheme whose variant is required, is not numbered
    expect(scheme.suggest({ kind: 'component', label: 'x' }, known)).toBeUndefined();
  });

  it('proposes the next variant of an existing number', () => {
    const known = [
      { pn: '2A-000009-00', source: 'a' },
      { pn: '2A-000009-01', source: 'b' },
    ];
    expect(scheme.suggest({ kind: 'design', label: 'x', variantOf: '2A-000009-00' }, known)?.pn).toBe('2A-000009-02');
    expect(scheme.suggest({ kind: 'pcba', label: 'x', variantOf: '2B-000001-00' }, known)).toBeUndefined();
  });

  it('stops when a range is used up', () => {
    const tight = declarativePartNumberScheme({ ...EXAMPLE, segments: EXAMPLE.segments.map((s) => (s.id === 'seq' && s.type === 'counter' ? { ...s, ranges: [{ from: 1, to: 2 }] } : s)) });
    const known = [{ pn: '1W-000001-00', source: 'a' }, { pn: '1W-000002-00', source: 'b' }];
    expect(tight.suggest({ kind: 'wire', label: 'x' }, known)).toBeUndefined();
  });

  it('works with the health report: duplicates, unnumbered, format findings', () => {
    const db = {
      connectors: [
        { id: 'a', label: 'A', partNumber: '1c-000100-00' },
        { id: 'b', label: 'B', partNumber: '1C-000100-00' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D', partNumber: 'CON-00001' },
      ],
      wires: [],
      components: [],
      pcbas: [],
    } as unknown as Db;
    const report = partNumberReport(db, [], {}, scheme);
    expect(report.duplicates.map((d) => d.pn)).toEqual(['1C-000100-00']);
    expect(report.unnumbered.find((u) => u.id === 'c')?.suggestion?.pn).toBe('1C-000101-00');
    expect(report.format.map((f) => f.code)).toEqual(['pn-malformed']);
  });
});

describe('an optional variant and a plain scheme', () => {
  const plain = declarativePartNumberScheme({
    type: 'declarative',
    template: 'P{seq}[-{rev}]',
    segments: [
      { id: 'seq', type: 'counter', width: 4 },
      { id: 'rev', type: 'variant', style: 'alpha', width: 2, optional: true },
    ],
  });
  it('reads a number with or without the group and keeps what it read', () => {
    expect(plain.parse('p0007')).toBe('P0007');
    expect(plain.parse('p0007-b')).toBe('P0007-B');
    expect(plain.suggest({ kind: 'wire', label: 'x' }, [{ pn: 'P0007-B', source: 'a' }])?.pn).toBe('P0008');
    expect(plain.suggest({ kind: 'wire', label: 'x', variantOf: 'P0007' }, [{ pn: 'P0007-B', source: 'a' }])?.pn).toBe('P0007-C');
    expect(plain.suggest({ kind: 'wire', label: 'x', variantOf: 'P0007' }, [])?.pn).toBe('P0007-A');
  });
  it('is not immutable unless it says so', () => {
    expect(plain.immutable).toBeUndefined();
  });
});

describe('a bad definition is refused with every problem named', () => {
  const problems = (patch: Record<string, unknown>): string[] => declarativeSchemeProblems({ ...EXAMPLE, ...patch });
  it('names template and segment problems', () => {
    expect(problems({ template: '{level}{nope}' }).join(' ')).toMatch(/\{nope\} is not a segment/);
    expect(problems({ template: '{level}{type}-{seq}' }).join(' ')).toMatch(/'variant' is not placed/);
    expect(problems({ template: '{level}{level}{type}{seq}{variant}' }).join(' ')).toMatch(/used twice/);
    expect(problems({ template: '{level' }).join(' ')).toMatch(/no closing/);
    expect(problems({ segments: [] }).join(' ')).toMatch(/at least one segment/);
    expect(problems({ type: 'x' }).join(' ')).toMatch(/declarative/);
  });
  it('is bounded', () => {
    expect(problems({ template: '{level}'.repeat(40) }).join(' ')).toMatch(/longer than/);
    expect(problems({ segments: Array.from({ length: 13 }, (_, i) => ({ id: `s${String.fromCharCode(97 + i)}`, type: 'counter', width: 2 })) }).join(' ')).toMatch(/at most 12/);
  });
  it('refuses a validation regex that could run away or is code-like', () => {
    expect(problems({ validation: { regex: '(a+)+$' } }).join(' ')).toMatch(/nested quantifiers/);
    expect(problems({ validation: { regex: '(a)\\1' } }).join(' ')).toMatch(/backreferences/);
    expect(problems({ validation: { regex: '(?<=a)b' } }).join(' ')).toMatch(/lookbehind/);
    expect(problems({ validation: { regex: '(' } }).join(' ')).not.toBe('');
    expect(problems({ validation: { regex: 'x'.repeat(300) } }).join(' ')).toMatch(/longer/);
  });
  it('checks ranges, defaults and variant values', () => {
    const seg = EXAMPLE.segments;
    const set = (id: string, patch: Record<string, unknown>): string[] => problems({ segments: seg.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    expect(set('seq', { ranges: [{ from: 5, to: 1 }] }).join(' ')).toMatch(/from <= to/);
    expect(set('seq', { ranges: [{ from: 1, to: 99999999 }] }).join(' ')).toMatch(/more than 6 digits/);
    expect(set('seq', { per: ['seq'] }).join(' ')).toMatch(/not a choice segment/);
    expect(set('seq', { ranges: [{ match: { level: '9' }, from: 1, to: 5 }] }).join(' ')).toMatch(/not one of its values/);
    expect(set('level', { default: 'Z' }).join(' ')).toMatch(/default/);
    expect(set('variant', { first: 'AA' }).join(' ')).toMatch(/does not fit/);
    expect(set('level', { values: [{ value: '1' }, { value: '1' }] }).join(' ')).toMatch(/twice/);
  });
  it('throws from the builders, and falls back to the prefix scheme for a prefix config', () => {
    expect(() => declarativePartNumberScheme({ ...EXAMPLE, template: '' })).toThrow(/template/);
    expect(schemeFromConfig({ prefixes: { connector: 'J' } }).parse('j-00001')).toBe('J-00001');
  });
});

describe('exclusions, range unions and multi-segment combinations', () => {
  const withSeq = (patch: Record<string, unknown>): DeclarativeSchemeConfig => ({
    ...EXAMPLE,
    segments: EXAMPLE.segments.map((s) => (s.id === 'seq' && s.type === 'counter' ? ({ ...s, ranges: undefined, ...patch } as typeof s) : s)),
  });
  const pn = (n: number, p = '1W'): { pn: string; source: string } => ({ pn: `${p}-${String(n).padStart(6, '0')}-00`, source: 's' });

  it('never issues an excluded number or span, and reports one that is in use', () => {
    const s = declarativePartNumberScheme(withSeq({ exclude: [3, { from: 5, to: 7 }] }));
    expect(declarativeSchemeProblems(withSeq({ exclude: [3, { from: 5, to: 7 }] }))).toEqual([]);
    expect(s.suggest({ kind: 'wire', label: 'x' }, [pn(1), pn(2)])?.pn).toBe('1W-000004-00');
    expect(s.suggest({ kind: 'wire', label: 'x' }, [pn(1), pn(2), pn(4)])?.pn).toBe('1W-000008-00');
    expect(s.check('1W-000006-00', 'wire').map((i) => i.code)).toEqual(['pn-excluded']);
    expect(s.check('1W-000008-00', 'wire')).toEqual([]);
  });

  it('a range-level exclusion applies only to that range', () => {
    const s = declarativePartNumberScheme(withSeq({ ranges: [{ match: { type: 'W' }, from: 1, to: 20, exclude: [2] }, { from: 1, to: 20 }] }));
    expect(s.suggest({ kind: 'wire', label: 'x' }, [pn(1)])?.pn).toBe('1W-000003-00');
    expect(s.suggest({ kind: 'connector', label: 'x' }, [pn(1, '1C')])?.pn).toBe('1C-000002-00');
  });

  it('a counter may use a union of disjoint ranges, in order', () => {
    const cfg = withSeq({ ranges: [{ spans: [{ from: 100, to: 102 }, { from: 500, to: 501 }, { from: 10, to: 11 }] }] });
    expect(declarativeSchemeProblems(cfg)).toEqual([]);
    const s = declarativePartNumberScheme(cfg);
    const next = (known: number[]): string | undefined => s.suggest({ kind: 'wire', label: 'x' }, known.map((n) => pn(n)))?.pn;
    expect(next([])).toBe('1W-000010-00');
    expect(next([10])).toBe('1W-000011-00');
    expect(next([10, 11])).toBe('1W-000100-00');
    expect(next([100, 102])).toBe('1W-000500-00');
    expect(next([501])).toBeUndefined();
    expect(s.check('1W-000300-00', 'wire').map((i) => i.code)).toEqual(['pn-out-of-range']);
    expect(s.check('1W-000501-00', 'wire')).toEqual([]);
  });

  it('a range matches several combinations of several segments without matching the cross product', () => {
    const cfg = withSeq({
      ranges: [
        { match: [{ level: '1', type: 'C' }, { level: '2', type: 'A' }], from: 1000, to: 1999 },
        { from: 1, to: 99 },
      ],
    });
    expect(declarativeSchemeProblems(cfg)).toEqual([]);
    const s = declarativePartNumberScheme(cfg);
    expect(s.suggest({ kind: 'connector', label: 'x' }, [])?.pn).toBe('1C-001000-00');
    expect(s.suggest({ kind: 'design', label: 'x' }, [])?.pn).toBe('2A-001000-00');
    expect(s.suggest({ kind: 'wire', label: 'x' }, [])?.pn).toBe('1W-000001-00');
  });

  it('refuses bad exclusions, spans and matches with every problem named', () => {
    const p = (patch: Record<string, unknown>): string => declarativeSchemeProblems(withSeq(patch)).join(' | ');
    expect(p({ exclude: [{ from: 9, to: 1 }] })).toMatch(/exclude.*from <= to/);
    expect(p({ exclude: ['x'] })).toMatch(/exclude/);
    expect(p({ ranges: [{ spans: [], }] })).toMatch(/spans is a list/);
    expect(p({ ranges: [{ spans: [{ from: 1, to: 5 }], from: 1, to: 2 }] })).toMatch(/not both/);
    expect(p({ ranges: [{ spans: [{ from: 1, to: 9999999 }] }] })).toMatch(/more than 6 digits/);
    expect(p({ ranges: [{ match: [{ level: '9' }], from: 1, to: 2 }] })).toMatch(/not one of its values/);
    expect(p({ ranges: [{ match: [], from: 1, to: 2 }] })).toMatch(/list of them/);
    expect(p({ exclude: Array.from({ length: 101 }, (_, i) => i) })).toMatch(/at most 100/);
  });
});
