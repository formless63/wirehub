/**
 * A pack's depictions and art on the file backend (cs-093): `packs.json` records the files a
 * pack installed (`assets`, path → sha256; an old `packs.json` without it still reads); a
 * merged layout keeps them beside the catalog (`depictions/` next to `data/`, art in
 * `data/art/`), where an update replaces or removes them and a disable removes them, the
 * catalog's own files always winning; a layered install keeps them in the layer.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyPackAssets, dataPath, installPack, installPackLayer, packOwnedAssets, readInstalledPacks } from '@wirehub/catalog';
import { readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry, defineModule } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handlePacksRequest } from '../server/packs.ts';
import type { SetupDeps } from '../server/setup.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const src = 'synthetic example: depiction pack';
const meta = (defId: string) => ({ defId, views: {}, src, license: 'CC0-1.0' });
const svg = (mark: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><title>${mark}</title></svg>\n`;
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n]);

function writePack(dir: string, version: string, files: Record<string, string | Uint8Array>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version, license: 'CC0-1.0' }));
  writeFileSync(join(dir, 'components.json'), json([{ id: 'r-60', label: '60 resistor', kind: 'resistor', value: '60 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src }]));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
const demo = (version: string, root: string) =>
  defineModule({ id: 'demo', label: 'Demo', version: '0.1.0', license: 'MIT', setup: { kind: 'domain', description: 'demo' }, catalogPacks: [{ id: 'demo', label: 'Demo', version, root: pathToFileURL(`${root}/`).href, license: 'CC0-1.0' }] });

describe('a pack\'s depictions and art on the file backend', () => {
  let root: string;
  let v1: string;
  let v2: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-assets-'));
    cpSync(dataPath(''), join(root, 'catalog/data'), { recursive: true });
    v1 = join(root, 'demo-1');
    v2 = join(root, 'demo-2');
    writePack(v1, '1.0.0', {
      'depictions/demo-def/meta.json': json(meta('demo-def')),
      'depictions/demo-def/a.svg': svg('a1'),
      'depictions/demo-def/b.svg': svg('b1'),
      'depictions/demo-def/c.svg': svg('c1'),
      'depictions/demo-own/own.svg': svg('pack-own'),
      'art/logo.png': png(1),
    });
    writePack(v2, '1.1.0', {
      'depictions/demo-def/meta.json': json(meta('demo-def')),
      'depictions/demo-def/a.svg': svg('a2'),
      'depictions/demo-def/c.svg': svg('c2'),
      'depictions/demo-def/d.svg': svg('d2'),
      'depictions/demo-own/own.svg': svg('pack-own-2'),
      'art/logo2.png': png(2),
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = (deps: SetupDeps, version: string, dir: string, method: string, path: string) =>
    handlePacksRequest({ method, path }, deps, createRegistry([demo(version, dir)])) as Promise<{ status: number; body: any }>;
  const owned = (dir: string) => Object.keys(readInstalledPacks(dir).packs[0]?.assets ?? {});

  it('merged: with ownership recorded, replaces and removes on update, removes on disable, keeps the catalog\'s own files', async () => {
    const dataDir = join(root, 'catalog/data');
    const depictions = join(root, 'catalog/depictions');
    // the catalog's own depiction, there before the pack
    mkdirSync(join(depictions, 'demo-own'), { recursive: true });
    writeFileSync(join(depictions, 'demo-own/own.svg'), svg('catalog-own'));
    // the state a Postgres scratch copy is in: records merged, files beside the catalog, ownership in packs.json
    // (the legacy merging installer, `installPack`, records records only)
    installPack(dataDir, v1);
    const packsFile = join(dataDir, 'packs.json');
    const record = JSON.parse(readFileSync(packsFile, 'utf8'));
    record.packs[0].assets = applyPackAssets(dataDir, v1, undefined, packOwnedAssets(v1));
    writeFileSync(packsFile, json(record));
    expect(owned(dataDir)).toEqual(['art/logo.png', 'depictions/demo-def/a.svg', 'depictions/demo-def/b.svg', 'depictions/demo-def/c.svg', 'depictions/demo-def/meta.json']);
    expect(readFileSync(join(depictions, 'demo-def/a.svg'), 'utf8')).toContain('a1');
    expect(existsSync(join(dataDir, 'art/logo.png'))).toBe(true);
    expect(readFileSync(join(depictions, 'demo-own/own.svg'), 'utf8')).toContain('catalog-own');

    const deps: SetupDeps = { dataDir, prompt: false, now: () => '2026-10-05T09:00:00.000Z' };
    // the catalog edits c.svg: from now on it is the catalog's
    writeFileSync(join(depictions, 'demo-def/c.svg'), svg('c-edited'));
    const updated = await call(deps, '1.1.0', v2, 'POST', '/api/packs/demo/update');
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(readFileSync(join(depictions, 'demo-def/a.svg'), 'utf8')).toContain('a2');
    expect(existsSync(join(depictions, 'demo-def/b.svg'))).toBe(false);
    expect(readFileSync(join(depictions, 'demo-def/c.svg'), 'utf8')).toContain('c-edited');
    expect(readFileSync(join(depictions, 'demo-def/d.svg'), 'utf8')).toContain('d2');
    expect(readFileSync(join(depictions, 'demo-own/own.svg'), 'utf8')).toContain('catalog-own');
    expect(existsSync(join(dataDir, 'art/logo.png'))).toBe(false);
    expect(existsSync(join(dataDir, 'art/logo2.png'))).toBe(true);
    expect(owned(dataDir)).toEqual(['art/logo2.png', 'depictions/demo-def/a.svg', 'depictions/demo-def/d.svg', 'depictions/demo-def/meta.json']);

    const disabled = await call(deps, '1.1.0', v2, 'DELETE', '/api/packs/demo');
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(readdirOf(join(depictions, 'demo-def'))).toEqual(['c.svg']);
    expect(readFileSync(join(depictions, 'demo-own/own.svg'), 'utf8')).toContain('catalog-own');
    expect(existsSync(join(dataDir, 'art/logo2.png'))).toBe(false);
    expect(readInstalledPacks(dataDir).packs).toEqual([]);
  });

  it('layered: the layer carries the files and records them; update replaces, disable removes the layer', async () => {
    const dataDir = join(root, 'catalog/data');
    const packsDir = join(root, 'packs');
    installPackLayer(dataDir, packsDir, v1);
    expect(owned(packsDir)).toEqual(['art/logo.png', 'depictions/demo-def/a.svg', 'depictions/demo-def/b.svg', 'depictions/demo-def/c.svg', 'depictions/demo-def/meta.json', 'depictions/demo-own/own.svg']);
    const deps: SetupDeps = { dataDir, packsDir, prompt: false, now: () => '2026-10-05T09:00:00.000Z' };
    expect(await call(deps, '1.1.0', v2, 'POST', '/api/packs/demo/update')).toMatchObject({ status: 200 });
    const tree = readFlattenedCatalog(join(root, 'catalog'), packsDir);
    expect([...tree.keys()].filter((p) => p.startsWith('depictions/') || p.startsWith('data/art/'))).toEqual([
      'data/art/logo2.png',
      'depictions/demo-def/a.svg',
      'depictions/demo-def/c.svg',
      'depictions/demo-def/d.svg',
      'depictions/demo-def/meta.json',
      'depictions/demo-own/own.svg',
    ]);
    expect(await call(deps, '1.1.0', v2, 'DELETE', '/api/packs/demo')).toMatchObject({ status: 200 });
    expect(existsSync(join(packsDir, 'demo'))).toBe(false);
    expect([...readFlattenedCatalog(join(root, 'catalog'), packsDir).keys()].filter((p) => p.startsWith('depictions/'))).toEqual([]);
  });

  it('reads a packs.json from before ownership was recorded, and disables such a pack without touching files', async () => {
    const dataDir = join(root, 'catalog/data');
    installPack(dataDir, v1);
    applyPackAssets(dataDir, v1, undefined, packOwnedAssets(v1));
    const path = join(dataDir, 'packs.json');
    const old = JSON.parse(readFileSync(path, 'utf8'));
    delete old.packs[0].assets;
    writeFileSync(path, json(old));
    const deps: SetupDeps = { dataDir, prompt: false, now: () => '2026-10-05T09:00:00.000Z' };
    expect(readInstalledPacks(dataDir).packs[0]?.assets).toBeUndefined();
    expect(await call(deps, '1.0.0', v1, 'DELETE', '/api/packs/demo')).toMatchObject({ status: 200 });
    expect(existsSync(join(root, 'catalog/depictions/demo-def/a.svg'))).toBe(true);
  });
});

const readdirOf = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
