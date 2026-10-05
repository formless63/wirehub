/**
 * Per-record licence and provenance (`docs/catalog-store.md` §2): the bundled
 * packs carry them on every record, they validate, and they survive the codec.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordMetaIssues } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

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
