/** The pluggable part-number scheme and its built-in default. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesigns, loadPartNumberScheme } from '@wirehub/catalog';

import {
  DEFAULT_PART_NUMBER_SCHEME,
  canonicalPartNumber,
  knownPartNumbers,
  parsePrefixSchemeConfig,
  prefixPartNumberScheme,
} from '../src/index.ts';

describe('the default prefix scheme', () => {
  const scheme = DEFAULT_PART_NUMBER_SCHEME;

  it('parses and canonicalises its own numbers', () => {
    expect(scheme.parse(' con-00012 ')).toBe('CON-00012');
    expect(scheme.parse('CBL-00012-A')).toBe('CBL-00012-A');
    expect(scheme.parse('not a number')).toBeUndefined();
    expect(canonicalPartNumber('wir-00001')).toBe('WIR-00001');
  });

  it('checks the prefix against the kind, as warnings', () => {
    expect(scheme.check('CON-00001', 'connector')).toEqual([]);
    expect(scheme.check('CON-00001', 'wire').map((i) => i.code)).toEqual(['pn-wrong-kind']);
    expect(scheme.check('ZZZ-00001').map((i) => i.code)).toEqual(['pn-unknown-prefix']);
    expect(scheme.check('CON-1').map((i) => i.code)).toEqual(['pn-malformed']);
    expect(scheme.check('CON-1').every((i) => i.severity === 'warning')).toBe(true);
  });

  it('suggests the next free number per prefix, never a taken one', () => {
    const known = knownPartNumbers(loadDb(), loadDesigns());
    const wire = scheme.suggest({ kind: 'wire', label: 'a new stock' }, known);
    expect(wire?.pn).toBe('WIR-00007');
    expect(wire?.fallback).toBe(true);
    expect(known.some((k) => k.pn === wire?.pn)).toBe(false);
    expect(scheme.suggest({ kind: 'design', label: 'x' }, [])?.pn).toBe('CBL-00001');
  });
});

describe('a configured scheme', () => {
  it('reads part-numbers.json and refuses a bad one', () => {
    const scheme = prefixPartNumberScheme(parsePrefixSchemeConfig({ prefixes: { connector: 'J' }, digits: 3, separator: '.' }));
    expect(scheme.parse('j.007')).toBe('J.007');
    expect(scheme.suggest({ kind: 'connector', label: 'x' }, [{ pn: 'J.007', source: 'test' }])?.pn).toBe('J.008');
    expect(scheme.suggest({ kind: 'wire', label: 'x' }, [])).toBeUndefined();
    expect(() => parsePrefixSchemeConfig({ prefixes: { gizmo: 'G' } })).toThrow(/not a part-number kind/);
  });

  it('the catalog without a part-numbers.json uses the default scheme', () => {
    expect(loadPartNumberScheme().id).toBe('prefix');
  });
});
