/** Per-record licence, provenance and derivedFrom: shape checks and where validateDb applies them. */

import { describe, expect, it } from 'vitest';
import { loadDb } from '@wirehub/catalog';

import { errors, isSourceUrl, isSpdxLike, recordMetaIssues, validateDb, type Db } from '../src/index.ts';

describe('isSpdxLike', () => {
  it('accepts ids and expressions', () => {
    for (const v of ['CC0-1.0', 'CC-BY-4.0', 'MIT', 'Apache-2.0+', 'CC-BY-SA-4.0 OR CC0-1.0', '(MIT AND CC0-1.0)', 'GPL-2.0-only WITH Classpath-exception-2.0', 'LicenseRef-vendor-terms']) {
      expect(isSpdxLike(v), v).toBe(true);
    }
  });
  it('rejects sentences and broken expressions', () => {
    for (const v of ['', 'free to use', 'CC0-1.0 OR', 'OR MIT', '(MIT', 'MIT)', 'MIT AND AND CC0-1.0', 'a/b', 3, undefined]) {
      expect(isSpdxLike(v), String(v)).toBe(false);
    }
  });
});

describe('isSourceUrl', () => {
  it('wants an absolute http(s) URL', () => {
    expect(isSourceUrl('https://example.org/spec.pdf')).toBe(true);
    expect(isSourceUrl('ftp://example.org')).toBe(false);
    expect(isSourceUrl('example.org')).toBe(false);
    expect(isSourceUrl('https://exa mple.org')).toBe(false);
  });
});

describe('recordMetaIssues', () => {
  const good = {
    license: 'CC0-1.0',
    provenance: {
      method: 'transcribed',
      sources: [{ title: 'TIA-574 clause 4', url: 'https://example.org/x', retrieved: '2026-09-30' }, { title: 'a datasheet' }],
      reviewed: [{ by: 'someone', on: '2026-10-01' }],
    },
    derivedFrom: { pack: 'pc-serial', id: 'x', version: '0.1.0' },
  };
  it('passes a well-formed record and a record with none of the fields', () => {
    expect(recordMetaIssues(good, 'x')).toEqual([]);
    expect(recordMetaIssues({}, 'x')).toEqual([]);
  });
  it('names each malformed field', () => {
    const codes = (r: object): string[] => recordMetaIssues(r, 'x').map((i) => i.code);
    expect(codes({ license: 'free to use' })).toEqual(['record-license']);
    expect(codes({ provenance: 'see datasheet' })).toEqual(['record-provenance']);
    expect(codes({ provenance: { method: 'guessed', sources: [{ title: 't' }] } })).toEqual(['record-provenance']);
    expect(codes({ provenance: { method: 'measured', sources: [] } })).toEqual(['record-provenance']);
    expect(codes({ provenance: { method: 'measured', sources: [{}] } })).toEqual(['record-provenance']);
    expect(codes({ provenance: { method: 'measured', sources: [{ url: 'nope' }] } })).toEqual(['record-provenance']);
    expect(codes({ provenance: { method: 'measured', sources: [{ title: 't', retrieved: 'yesterday' }] } })).toEqual(['record-provenance']);
    expect(codes({ provenance: { method: 'measured', sources: [{ title: 't' }], reviewed: [{ by: 'x' }] } })).toEqual(['record-provenance']);
    expect(codes({ derivedFrom: { pack: 'Bad Pack', id: 'x', version: '1' } })).toEqual(['record-derived-from']);
  });
});

describe('validateDb applies them to every record kind', () => {
  const base: Db = loadDb();
  it('is clean with valid fields and an error per bad record', () => {
    const meta = { license: 'CC0-1.0', provenance: { method: 'synthetic' as const, sources: [{ title: 'synthetic example' }] } };
    const ok: Db = {
      ...base,
      connectors: base.connectors.map((c, i) => (i === 0 ? { ...c, ...meta } : c)),
      wires: base.wires.map((w, i) => (i === 0 ? { ...w, ...meta } : w)),
      bodies: (base.bodies ?? []).map((b, i) => (i === 0 ? { ...b, ...meta } : b)),
    };
    expect(validateDb(ok)).toEqual([]);

    const bad = { license: 'not a licence' };
    const broken: Db = {
      ...base,
      connectors: base.connectors.map((c, i) => (i === 0 ? { ...c, ...bad } : c)),
      components: base.components.map((c, i) => (i === 0 ? { ...c, ...bad } : c)),
      wires: base.wires.map((w, i) => (i === 0 ? { ...w, ...bad } : w)),
      pcbas: base.pcbas.map((p, i) => (i === 0 ? { ...p, ...bad } : p)),
      mechanicals: (base.mechanicals ?? []).map((m, i) => (i === 0 ? { ...m, ...bad } : m)),
      bodies: (base.bodies ?? []).map((b, i) => (i === 0 ? { ...b, ...bad } : b)),
      interfaces: (base.interfaces ?? []).map((b, i) => (i === 0 ? { ...b, ...bad } : b)),
      kits: (base.kits ?? []).map((b, i) => (i === 0 ? { ...b, ...bad } : b)),
    };
    const found = errors(validateDb(broken)).filter((i) => i.code === 'record-license');
    const kinds = new Set(found.map((i) => (i.where ?? '').split('/')[0]));
    expect([...kinds].sort()).toEqual(['bodies', 'components', 'connectors', 'interfaces', 'kits', 'mechanicals', 'pcbas', 'wires'].filter((k) => (broken[k as keyof Db] as unknown[] | undefined)?.length));
  });
});
