/**
 * Per-record licence and provenance (`docs/catalog-store.md` §2): the bundled
 * packs carry them on every record, they validate, and they survive the codec.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordMetaIssues } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { loadPackArt, parseBodyLayouts, parseConnectorArt } from '../src/art.ts';
import { parseDepictionMeta } from '../src/depictions/validate.ts';
import { explode, render, type CatalogFiles } from '../src/codec/index.ts';
import { packFiles } from '../src/packs.ts';

const modulesRoot = fileURLToPath(new URL('../../../modules', import.meta.url));
const packs = readdirSync(modulesRoot).map((name) => join(modulesRoot, name, 'pack')).filter((dir) => existsSync(join(dir, 'wirehub-pack.json')));

const LISTS = ['bodies', 'interfaces', 'connectors', 'wires', 'components', 'mechanicals', 'kits', 'pcbas'];

/** Every record and vocabulary entry of a pack (designs are files of their own, not records here). */
function recordsOf(dir: string): { where: string; record: Record<string, unknown> }[] {
  const out: { where: string; record: Record<string, unknown> }[] = [];
  for (const file of packFiles(dir)) {
    if (file.startsWith('designs/')) continue;
    const value = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    const records = Array.isArray(value) ? value : (value as { entries?: unknown[] }).entries;
    if (!Array.isArray(records) || (!file.startsWith('vocab/') && !LISTS.includes(file.replace(/\.json$/, '')))) continue;
    for (const record of records as Record<string, unknown>[]) out.push({ where: `${file}#${String(record['id'])}`, record });
  }
  return out;
}

describe('bundled packs', () => {
  it('there are packs to check', () => expect(packs.length).toBeGreaterThanOrEqual(5));

  for (const dir of packs) {
    const name = dir.split('/').at(-2) as string;
    it(`${name}: every record is CC0-1.0 with provenance drawn from its src`, () => {
      const records = recordsOf(dir);
      expect(records.length).toBeGreaterThan(0);
      for (const { where, record } of records) {
        expect(record['license'], where).toBe('CC0-1.0');
        const provenance = record['provenance'] as { method: string; sources: { title?: string }[] };
        expect(provenance.sources[0]?.title, where).toBe(record['src']);
        expect(recordMetaIssues(record, where), where).toEqual([]);
      }
    });
  }
});

/** The art files of a pack: connector drawings, the body-layout list and each depiction's meta.json. */
function artRecordsOf(dir: string): { where: string; record: Record<string, unknown> }[] {
  const out: { where: string; record: Record<string, unknown> }[] = [];
  const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
  const connectors = join(dir, 'art', 'connectors');
  if (existsSync(connectors)) for (const name of readdirSync(connectors).sort()) out.push({ where: `art/connectors/${name}`, record: json(join(connectors, name)) as Record<string, unknown> });
  const layouts = join(dir, 'art', 'body-layouts.json');
  if (existsSync(layouts)) for (const record of json(layouts) as Record<string, unknown>[]) out.push({ where: `art/body-layouts.json#${String(record['id'])}`, record });
  const depictions = join(dir, 'depictions');
  if (existsSync(depictions)) for (const name of readdirSync(depictions).sort()) out.push({ where: `depictions/${name}/meta.json`, record: json(join(depictions, name, 'meta.json')) as Record<string, unknown> });
  return out;
}

describe('bundled packs: art records', () => {
  for (const dir of packs) {
    const name = dir.split('/').at(-2) as string;
    it(`${name}: every art record is CC0-1.0 with provenance drawn from its src, and the parsers accept it`, () => {
      for (const { where, record } of artRecordsOf(dir)) {
        expect(record['license'], where).toBe('CC0-1.0');
        const provenance = record['provenance'] as { method: string; sources: { title?: string }[] };
        expect(provenance.sources[0]?.title, where).toBe(record['src']);
        expect(recordMetaIssues(record, where), where).toEqual([]);
        if (where.startsWith('art/connectors/')) expect(parseConnectorArt(record, where).issues, where).toEqual([]);
        if (where.startsWith('depictions/')) expect(parseDepictionMeta(record, where).issues.filter((i) => i.severity === 'error'), where).toEqual([]);
      }
      expect(loadPackArt(dir).issues).toEqual([]);
    });
  }

  it('art records refuse a malformed licence or provenance, like any record', () => {
    const connector = JSON.parse(readFileSync(join(modulesRoot, 'av-video', 'pack', 'art', 'connectors', 'scart-21.json'), 'utf8')) as Record<string, unknown>;
    const messages = (patch: Record<string, unknown>): string => parseConnectorArt({ ...connector, ...patch }, 'x').issues.map((i) => i.message).join(';');
    expect(messages({})).toBe('');
    expect(messages({ license: 'free for all' })).toContain('SPDX');
    expect(messages({ provenance: { method: 'guessed', sources: [] } })).toContain('provenance.method');
    expect(messages({ provenance: { method: 'derived', sources: [{ url: 'ftp://x' }] } })).toContain('http(s)');
    const layouts = JSON.parse(readFileSync(join(modulesRoot, 'av-video', 'pack', 'art', 'body-layouts.json'), 'utf8')) as Record<string, unknown>[];
    expect(parseBodyLayouts([{ ...layouts[0], license: 'nope nope' }], 'l').issues.map((i) => i.message).join()).toContain('SPDX');
    const depiction = JSON.parse(readFileSync(join(modulesRoot, 'pro-audio', 'pack', 'depictions', 'rca-male', 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(parseDepictionMeta({ ...depiction, derivedFrom: { pack: 'p' } }, 'd').issues.map((i) => i.message).join()).toContain('derivedFrom');
    expect(parseDepictionMeta(depiction, 'd').meta?.license).toBe('CC0-1.0');
  });
});

describe('the codec', () => {
  it('keeps license, provenance and derivedFrom on a record, byte for byte', () => {
    const record = {
      id: 'x-body',
      label: 'X body',
      family: 'x',
      gender: 'male',
      positions: [{ id: '1', label: '1' }],
      src: 'synthetic example',
      license: 'CC-BY-4.0',
      provenance: { method: 'derived', sources: [{ title: 'doc', url: 'https://example.org/d', retrieved: '2026-10-01' }], reviewed: [{ by: 'me', on: '2026-10-02' }] },
      derivedFrom: { pack: 'p', id: 'x-body', version: '1.0.0' },
    };
    const files: CatalogFiles = new Map([['data/bodies.json', `${JSON.stringify([record], null, 2)}\n`]]);
    const { rows, errors } = explode(files);
    expect(errors).toEqual([]);
    const row = rows.records.find((r) => r.slug === 'x-body');
    expect(JSON.parse(row?.body as string)).toEqual(record);
    expect(render(rows).get('data/bodies.json')).toBe(files.get('data/bodies.json'));
  });
});
