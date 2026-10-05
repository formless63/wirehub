/**
 * Images in uploaded and store packs (`server/pack-archive.ts`): a zip or JSON bundle carries
 * `depictions/**` and `art/**` images (base64 in a bundle), allowlisted by type and size, SVG
 * stripped of anything active; installed through the ordinary reconcile (file backend here,
 * Postgres in `pg/pack-bundle-assets.server.test.ts`); `store-index.mjs bundle` includes them.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross, readInstalledPacks } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { MAX_PACK_ASSET_BYTES, PackArchiveError, isPackFilePath, readPackBytes } from '../server/pack-archive.ts';
import { STORE_URL, createTestStore, type TestStore } from './store-fixture.ts';
import { packWithFace, runFaceFlow, svgFace, zipFiles } from './pack-bundle-flow.ts';

const png = (n: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

describe('pack images: archive reading', () => {
  it('keeps depictions and art images from a zip (wrapper folder stripped), skipping other files and images elsewhere', () => {
    const files = packWithFace('imgs', '1.0.0', svgFace('a'));
    const read = readPackBytes(zipFiles({ ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`imgs-1.0.0/${k}`, v])), 'imgs-1.0.0/art/logo.png': png(1), 'imgs-1.0.0/depictions/x/photo.jpg': jpg, 'imgs-1.0.0/depictions/x/w.webp': webp, 'imgs-1.0.0/docs/shot.png': png(2), 'imgs-1.0.0/art/readme.txt': 'x' }));
    expect(read.format).toBe('zip');
    expect([...read.files.keys()].sort()).toEqual(['art/logo.png', 'components.json', 'depictions/imgs-face/meta.json', 'depictions/imgs-face/mating-face.svg', 'depictions/x/photo.jpg', 'depictions/x/w.webp', 'wirehub-pack.json'].sort());
    const svg = new TextDecoder().decode(read.files.get('depictions/imgs-face/mating-face.svg'));
    expect(svg).toContain('<rect');
    expect(svg).not.toMatch(/script|onload|evil\.example/);
  });

  it('takes images in a JSON bundle as base64', () => {
    const bundle = { format: 1, manifest: { format: 1, id: 'b', name: 'B', version: '1.0.0', license: 'CC0-1.0' }, files: { 'art/logo.png': Buffer.from(png(3)).toString('base64'), 'depictions/b/face.svg': Buffer.from(svgFace('b')).toString('base64') } };
    const read = readPackBytes(new TextEncoder().encode(JSON.stringify(bundle)));
    expect(read.format).toBe('bundle');
    expect([...(read.files.get('art/logo.png') ?? [])]).toEqual([...png(3)]);
    expect(new TextDecoder().decode(read.files.get('depictions/b/face.svg'))).not.toContain('<script');
  });

  it('allows only the image types, and only under depictions/ and art/', () => {
    expect(['art/a.png', 'depictions/d/a.SVG'.toLowerCase(), 'depictions/d/a.jpeg', 'art/sub/a.webp'].every(isPackFilePath)).toBe(true);
    for (const bad of ['art/a.gif', 'art/a.PNG', 'docs/a.png', 'a.png', 'art/../a.png', 'art/.hidden.png', 'art/a.svg.exe', '/art/a.png']) expect(isPackFilePath(bad), bad).toBe(false);
  });

  it('refuses a mismatched type, an empty or oversize image, a bad base64 value and an SVG that is not one', () => {
    const wrap = (files: Record<string, string>) => new TextEncoder().encode(JSON.stringify({ format: 1, manifest: { format: 1, id: 'b', name: 'B', version: '1.0.0', license: 'CC0-1.0' }, files }));
    const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64');
    expect(() => readPackBytes(wrap({ 'art/a.png': b64(jpg) }))).toThrow(/kind of image/);
    expect(() => readPackBytes(wrap({ 'art/a.png': '' }))).toThrow(/empty/);
    expect(() => readPackBytes(wrap({ 'art/a.png': b64(new Uint8Array(MAX_PACK_ASSET_BYTES + 1).fill(1)) }))).toThrow(PackArchiveError);
    expect(() => readPackBytes(wrap({ 'art/a.png': '***' }))).toThrow(/base64/);
    expect(() => readPackBytes(wrap({ 'art/a.svg': b64('<html><body>hi</body></html>') }))).toThrow(/not a usable SVG/);
    expect(() => readPackBytes(wrap({ 'art/a.svg': b64('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>') }))).toThrow(/entity/);
    const big = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`art/big${i}.png`, b64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(MAX_PACK_ASSET_BYTES - 16)]))]));
    expect(() => readPackBytes(wrap(Object.fromEntries(Object.entries(big).concat(Object.entries(big).map(([k, v]) => [k.replace('big', 'bag'), v])).concat(Object.entries(big).map(([k, v]) => [k.replace('big', 'bug'), v])).slice(0, 12))))).toThrow(/Too|unpack|add up|larger/i);
  });
});

describe('uploaded and store packs with an SVG face (file backend)', () => {
  let root = '';
  let packs = '';
  let store: TestStore | undefined;
  let deps: WorkbenchDeps;
  const hub = () => createCatalog(catalogWithPacksSource(join(root, 'catalog/data'), packs));
  const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; bytes?: Uint8Array };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-bundle-assets-'));
    packs = join(root, 'packs');
    cpSync(dataPath(''), join(root, 'catalog/data'), { recursive: true });
    const dataDir = join(root, 'catalog/data');
    deps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => hub().loadDb(),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(dataDir, packs).packs }),
      // /api/blobs/<sha256>: every depiction file of the catalog and its packs, by content address
      blob: async (sha) => {
        const { createHash } = await import('node:crypto');
        const { readFlattenedCatalog } = await import('@wirehub/catalog/src/codec/tree.ts');
        for (const [path, content] of readFlattenedCatalog(join(root, 'catalog'), packs)) {
          if (typeof content === 'string' || !path.startsWith('depictions/')) continue;
          if (createHash('sha256').update(content as Uint8Array).digest('hex') === sha) return { bytes: new Uint8Array(content as Uint8Array), mediaType: 'image/svg+xml' };
        }
        return undefined;
      },
      setup: { dataDir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
    };
  });
  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(root, { recursive: true, force: true });
  });
  const readFace = (id: string) => async (def: string): Promise<Uint8Array | undefined> => {
    const file = join(packs, id, 'depictions', def, 'mating-face.svg');
    return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
  };

  it('upload (zip): install, face served by /api/blobs, update with a changed SVG, disable removes the file', async () => {
    await runFaceFlow({
      call,
      id: 'upload',
      readFace: readFace('upload'),
      strictRemoval: true,
      source: async (version, face) => ({ path: '/api/packs/install', body: { zip: Buffer.from(zipFiles(Object.fromEntries(Object.entries(packWithFace('upload', version, face)).map(([k, v]) => [`upload-${version}/${k}`, v])))).toString('base64') } }),
    });
    expect(readInstalledPacks(packs).packs).toEqual([]);
  });

  it('upload (JSON bundle with base64 images) and art/ images arrive and are owned', async () => {
    const files = packWithFace('jb', '1.0.0', svgFace('j'));
    const bundle = { format: 1, manifest: JSON.parse(files['wirehub-pack.json']!), files: { 'components.json': JSON.parse(files['components.json']!), 'depictions/jb-face/meta.json': JSON.parse(files['depictions/jb-face/meta.json']!), 'depictions/jb-face/mating-face.svg': Buffer.from(svgFace('j')).toString('base64'), 'art/logo.png': Buffer.from(png(4)).toString('base64') } };
    const done = await call('POST', '/api/packs/install', { bundle, apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(Object.keys(readInstalledPacks(packs).packs[0]?.assets ?? {})).toEqual(['art/logo.png', 'depictions/jb-face/mating-face.svg', 'depictions/jb-face/meta.json']);
    expect([...readFileSync(join(packs, 'jb/art/logo.png'))]).toEqual([...png(4)]);
    expect((await call('DELETE', '/api/packs/jb')).status).toBe(200);
    expect(existsSync(join(packs, 'jb'))).toBe(false);
  });

  it('refuses an upload whose image is not what its name says, installing nothing', async () => {
    const files = { ...packWithFace('bad', '1.0.0', svgFace('x')), 'art/logo.png': jpg };
    const done = await call('POST', '/api/packs/install', { zip: Buffer.from(zipFiles(files)).toString('base64'), apply: true });
    expect(done.status).toBe(400);
    expect(done.body.error).toMatch(/kind of image/);
    expect(existsSync(join(packs, 'bad'))).toBe(false);
  });

  it('store: the same flow from a signed index (bundles made by store-index.mjs, images included)', async () => {
    const s = createTestStore();
    store = s;
    deps.store = { indexes: [{ url: STORE_URL, publicKey: s.publicKey }], fetch: s.fetch };
    await runFaceFlow({
      call,
      id: 'alpha',
      readFace: readFace('alpha'),
      strictRemoval: true,
      source: async (version, face) => {
        s.publish('alpha', version, '10', false, null, face);
        return { path: '/api/packs/store/install', body: { index: STORE_URL, id: 'alpha', version } };
      },
    });
  });

  it('store-index.mjs bundle: images included, the same bytes every time, a refused image is refused', () => {
    const s = createTestStore();
    store = s;
    const pack = join(root, 'packsrc');
    mkdirSync(join(pack, 'art'), { recursive: true });
    for (const [path, content] of Object.entries(packWithFace('det', '1.0.0', svgFace('d')))) {
      mkdirSync(join(pack, path, '..'), { recursive: true });
      writeFileSync(join(pack, path), content);
    }
    writeFileSync(join(pack, 'art/logo.png'), png(5));
    const once = readFileSync(s.cli('bundle', pack, '--out', join(root, 'o1')).trim().replace(/^bundle: /, ''));
    const twice = readFileSync(s.cli('bundle', pack, '--out', join(root, 'o2')).trim().replace(/^bundle: /, ''));
    expect(Buffer.compare(once, twice)).toBe(0);
    const read = readPackBytes(new Uint8Array(once));
    expect(read.files.has('art/logo.png')).toBe(true);
    expect(read.files.has('depictions/det-face/mating-face.svg')).toBe(true);
    writeFileSync(join(pack, 'art/Logo2.PNG'), png(6));
    expect(() => s.cli('bundle', pack, '--out', join(root, 'o3'))).toThrow(/image a studio would not install/);
    rmSync(join(pack, 'art/Logo2.PNG'));
    writeFileSync(join(pack, 'art/fake.png'), jpg);
    expect(() => s.cli('bundle', pack, '--out', join(root, 'o4'))).toThrow(/kind of image/);
  });
});
