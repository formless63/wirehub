/**
 * Canonical JSON guard (Postgres plan task A0, `specs/postgres-backend.md` §7.1).
 *
 * Every JSON file of a catalog tree — the starter catalog, the frozen fixture
 * catalog and every bundled module's pack — is exactly
 * `JSON.stringify(JSON.parse(text), null, 2) + '\n'`. The codec renders JSON
 * that way, so this is what lets the import gate demand strict byte identity
 * (`render(explode(files))` equal to the files, byte for byte).
 *
 * A failure names every offending file; the fix is to rewrite it canonically
 * (the values do not change, only whitespace and number spelling).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isCanonicalJson } from '../src/codec/index.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const modulesRoot = fileURLToPath(new URL('../../../modules', import.meta.url));

/** Every `.json` file under `dir`, skipping dot-directories (gitignored caches). */
function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

const trees: [string, string][] = [
  ['the starter catalog', join(packageRoot, 'data')],
  ['the starter depictions', join(packageRoot, 'depictions')],
  ['the fixture catalog', join(packageRoot, 'fixtures/v1/data')],
  ['the fixture depictions', join(packageRoot, 'fixtures/v1/depictions')],
  ...readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(modulesRoot, entry.name, 'pack')))
    .map((entry): [string, string] => [`the ${entry.name} pack`, join(modulesRoot, entry.name, 'pack')]),
];

describe('canonical JSON', () => {
  it('covers the starter catalog and at least one module pack', () => {
    expect(jsonFiles(join(packageRoot, 'data')).length).toBeGreaterThan(10);
    expect(trees.filter(([name]) => name.endsWith('pack')).length).toBeGreaterThan(0);
  });

  for (const [name, dir] of trees) {
    it(`${name} is canonical JSON`, () => {
      const offenders = jsonFiles(dir).filter((path) => !isCanonicalJson(readFileSync(path, 'utf8')));
      expect(offenders.map((path) => relative(packageRoot, path))).toEqual([]);
    });
  }
});
