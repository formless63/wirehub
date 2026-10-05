/**
 * The catalog codec (`src/codec/`, Postgres plan task A3): coverage, the
 * skip list against `.gitignore`, and byte identity — `render(explode(tree))`
 * is the tree, byte for byte — on the starter catalog, the fixture catalog,
 * and the starter with every bundled module pack installed.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { dataPath, fixtureCatalogRoot, installPack, installPackLayer } from '../src/index.ts';
import { classifyPath, entitiesOf, explode, isSkippedPath, render, sha256Hex, type CatalogFiles } from '../src/codec/index.ts';
import { readCatalogTree, readFlattenedCatalog } from '../src/codec/tree.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const modulesRoot = join(repoRoot, 'modules');

const work = mkdtempSync(join(tmpdir(), 'wirehub-codec-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The starter catalog with every bundled module's pack installed, in a temp copy. */
function starterWithPacks(name = 'with-packs'): string {
  const root = join(work, name);
  cpSync(dataPath(''), join(root, 'data'), { recursive: true });
  for (const name of readdirSync(modulesRoot).sort()) {
    const pack = join(modulesRoot, name, 'pack');
    if (existsSync(join(pack, 'wirehub-pack.json'))) installPack(join(root, 'data'), pack);
  }
  return root;
}

function expectIdentity(files: CatalogFiles): void {
  const { rows, errors } = explode(files);
  expect(errors).toEqual([]);
  const blobs = new Map(rows.blobs.flatMap((b) => (b.bytes === undefined ? [] : [[b.sha256, b.bytes] as const])));
  const back = render(rows, { blobs: (sha) => blobs.get(sha) });
  expect([...back.keys()]).toEqual([...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const [path, content] of files) {
    const again = back.get(path);
    if (typeof content === 'string') expect(again, path).toBe(content);
    else expect(sha256Hex(again as Uint8Array), path).toBe(sha256Hex(content as Uint8Array));
  }
}

describe('codec byte identity', () => {
  it('the starter catalog', () => {
    const files = readCatalogTree(packageRoot);
    expect(files.size).toBeGreaterThan(30);
    expectIdentity(files);
  });

  it('the fixture catalog', () => {
    expectIdentity(readCatalogTree(fixtureCatalogRoot()));
  });

  it('the starter catalog with every bundled module pack installed', () => {
    const root = starterWithPacks();
    const files = readCatalogTree(root);
    expect(files.has('data/packs.json')).toBe(true);
    expectIdentity(files);
    const { rows } = explode(files);
    // the packs' designs are records of their own entities
    expect(entitiesOf(rows).filter((e) => e.kind === 'design').length).toBeGreaterThan(8);
  });

  it('packs installed as layers flatten to the catalog the merging installer made', () => {
    const merged = readCatalogTree(starterWithPacks('merged-reference'));
    const root = join(work, 'layered');
    const packsDir = join(work, 'layered-packs');
    cpSync(dataPath(''), join(root, 'data'), { recursive: true });
    for (const name of readdirSync(modulesRoot).sort()) {
      const pack = join(modulesRoot, name, 'pack');
      if (existsSync(join(pack, 'wirehub-pack.json'))) installPackLayer(join(root, 'data'), packsDir, pack);
    }
    const flat = readFlattenedCatalog(root, packsDir);
    expect([...flat.keys()]).toEqual([...merged.keys()]);
    for (const [path, text] of merged) expect(flat.get(path), path).toBe(text);
    expectIdentity(flat);
  });

  it('a synthetic tree with every typed file kind', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const sha = sha256Hex(png);
    const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
    const files = new Map<string, string | Uint8Array>([
      ['data/LICENSE', 'CC0\n'],
      ['data/assets/index.json', json([{ id: sha, mime: 'image/png', originalName: 'x.png', src: 'synthetic example', bytes: png.length }])],
      [`data/assets/${sha}.png`, png],
      ['data/connectors.json', json([{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }])],
      ['data/designs/_versions/demo/1.json', json({ rev: 1, designId: 'demo' })],
      [`data/designs/_versions/demo/artwork/${sha}.png`, png],
      ['data/designs/_versions/demo/drafts/1.json', json({ reason: 'r' })],
      ['data/designs/_versions/demo/working.json', json({ basedOnRev: 1 })],
      ['data/designs/demo.json', json({ id: 'demo', label: 'Demo' })],
      ['data/drawings/demo.json', json({ title: 'T' })],
      ['data/drawings/demo.photo-ref.json', json({ assetId: sha })],
      ['data/drawings/old.photo.png', png],
      ['data/kicad-maps/x.json', json({ k: 1 })],
      ['data/models.json', json({ src: 's', links: [{ record: 'connectors/a', asset: 'h', sourceKind: 'uploaded', src: 's' }, { record: 'kits/z', asset: 'h', sourceKind: 'vendor', src: 's' }] })],
      ['data/tags/report.md', '# Report\n\n- one\n'],
      ['data/wires.json', '[]\n'],
      ['depictions/de9-female/face.svg', '<svg/>'],
      ['depictions/de9-female/meta.json', json({ views: ['face'] })],
    ]);
    // the reader hands SVG over as bytes; do the same
    files.set('depictions/de9-female/face.svg', new TextEncoder().encode('<svg/>'));
    expectIdentity(files);
    const { rows } = explode(files);
    expect(rows.records.filter((r) => r.kind === 'connector').map((r) => [r.slug, r.ord])).toEqual([['b', 0], ['a', 1]]);
    expect(rows.files.map((f) => f.path)).toEqual(['data/drawings/old.photo.png']);
    expect(rows.blobs.length).toBe(2);
  });
});

describe('codec coverage and refusals', () => {
  it('skips the gitignored caches and temp files of the catalog', () => {
    // every pattern in the catalog section of .gitignore
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n');
    const catalogPatterns = gitignore
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
      .filter((line) => /^(packages\/catalog\/data\/\.|\.model-cache|\.\*\.tmp|\*\.import-tmp)/.test(line));
    expect(catalogPatterns.length).toBeGreaterThanOrEqual(4);
    for (const pattern of catalogPatterns) {
      const sample = `data/${pattern.replace(/^packages\/catalog\/data\//, '').replace(/\/$/, '/x.glb').replace(/\*/g, 'tmpname')}`;
      expect(isSkippedPath(sample), `${pattern} → ${sample}`).toBe(true);
    }
    expect(isSkippedPath('data/designs/x.json')).toBe(false);
    expect(isSkippedPath('data/packs.json')).toBe(false);
  });

  it('every file of the starter catalog maps to exactly one non-catch-all entry or a module doc', () => {
    for (const path of readCatalogTree(packageRoot).keys()) expect(classifyPath(path), path).toBeDefined();
  });

  it('reports uncovered, malformed and non-canonical files instead of importing them', () => {
    const files = new Map<string, string | Uint8Array>([
      ['depictions/stray.svg', '<svg/>'],
      ['data/designs/Bad Name.json', '{}\n'],
      ['data/connectors.json', '[\n  {\n    "label": "no id"\n  }\n]\n'],
      ['data/vocab/colours.json', '{"id":"colours"}'],
      ['data/models.json', `${JSON.stringify({ src: 's', links: [{ record: 'kits/z' }, { record: 'connectors/a' }] }, null, 2)}\n`],
      ['data/drawings/x.photo-ref.json', `${JSON.stringify({ assetId: 'a'.repeat(64) }, null, 2)}\n`],
    ]);
    const { errors } = explode(files);
    expect(errors.some((e) => e.startsWith('depictions/stray.svg: not covered'))).toBe(true);
    expect(errors.some((e) => e.startsWith('data/designs/Bad Name.json'))).toBe(true);
    expect(errors.some((e) => e.includes('item 0 has no usable "id"'))).toBe(true);
    expect(errors.some((e) => e.startsWith('data/vocab/colours.json: not canonical'))).toBe(true);
    expect(errors.some((e) => e.startsWith('data/models.json: links are not unique and sorted'))).toBe(true);
    expect(errors.some((e) => e.includes('is not in assets/index.json'))).toBe(true);
  });
});
