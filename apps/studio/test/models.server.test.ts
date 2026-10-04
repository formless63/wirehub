/**
 * 3D models of Library parts: the STL reader, the GLB
 * writer, the converter (STL in process, STEP in the child), the source
 * matcher on fixture paths, and the attach / upload / detach API.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDb } from '@cable-studio/catalog';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryAssetStore } from '../server/assets.ts';
import { convertModel, convertModelFiles, ModelRefusal, sniffModel } from '../server/models/convert.ts';
import { readGlbJson, writeGlb } from '../server/models/glb.ts';
import { linkETag } from '../server/models/api.ts';
import { memoryModelLinkStore } from '../server/models/links.ts';
import { memoryModelCache, sourceKey } from '../server/models/cache.ts';
import { boundsOf, layOut, parseStl, simplify, weld, type MeshPart } from '../server/models/mesh.ts';
import { recordsOfWrite } from '../src/locks/records.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TETRA = new Uint8Array(readFileSync(join(here, 'fixtures/models/tetra.stl')));
/** a tiny STEP cube that ships inside the pinned occt-import-js package's own tests */
const CUBE_STEP = new Uint8Array(
  readFileSync(join(dirname(createRequire(import.meta.url).resolve('occt-import-js')), '../test/testfiles/simple-basic-cube/cube.stp')),
);

/** The tetra fixture as a binary STL. */
function binaryStl(part: MeshPart): Uint8Array {
  const count = part.indices.length / 3;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const v = part.indices[t * 3 + k]!;
      for (let a = 0; a < 3; a++) view.setFloat32(84 + t * 50 + 12 + k * 12 + a * 4, part.positions[v * 3 + a]!, true);
    }
  }
  return out;
}

describe('STL', () => {
  it('reads an ASCII STL, welded', () => {
    const part = parseStl(TETRA, 'tetra');
    expect(part.positions.length / 3).toBe(4);
    expect(part.indices.length / 3).toBe(4);
    expect(boundsOf([part])).toEqual({ min: [0, 0, 0], max: [10, 10, 5] });
  });

  it('reads the same shape as binary, and sniffs both', () => {
    const binary = binaryStl(parseStl(TETRA, 'tetra'));
    expect(sniffModel(binary)).toBe('stl');
    expect(sniffModel(TETRA)).toBe('stl');
    expect(parseStl(binary, 'b').indices.length).toBe(12);
  });

  it('drops degenerate triangles', () => {
    expect(weld(Float32Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1]), 'x').indices.length).toBe(0);
  });
});

describe('GLB writer', () => {
  it('writes a self-describing, quantized binary glTF', () => {
    const glb = writeGlb([{ ...parseStl(TETRA, 'tetra'), color: [0.1, 0.5, 0.2] }], { source: 'stl' });
    expect(sniffModel(glb)).toBe('glb');
    const json = readGlbJson(glb)!;
    expect(json['extensionsRequired']).toEqual(['KHR_mesh_quantization']);
    const accessors = json['accessors'] as { min?: number[]; max?: number[]; normalized?: boolean }[];
    // raw int16 bounds, as glTF wants them for a normalized accessor
    expect(accessors[0]!.normalized).toBe(true);
    expect(accessors[0]!.max!.every((v) => Number.isInteger(v) && Math.abs(v) <= 32767)).toBe(true);
    // the Z-up → Y-up root
    const nodes = json['nodes'] as { name?: string }[];
    expect(nodes[nodes.length - 1]!.name).toBe('z-up');
    expect((json['materials'] as unknown[]).length).toBe(1);
  });

  it('is deterministic — same meshes, same bytes (the asset store dedups on that)', () => {
    const part = parseStl(TETRA, 'tetra');
    expect(Buffer.from(writeGlb([part])).equals(Buffer.from(writeGlb([part])))).toBe(true);
  });

  it('matches the viewer package fixture byte for byte', () => {
    const fixture = readFileSync(join(here, '../../../packages/editor-react/test/fixtures/tetra.glb'));
    expect(Buffer.from(writeGlb([parseStl(TETRA, 'tetra')])).equals(fixture)).toBe(true);
  });
});

describe('simplify and layout', () => {
  it('keeps a part under its triangle budget', () => {
    // a 60×60 grid of quads = 7 200 triangles
    const positions: number[] = [];
    const indices: number[] = [];
    const n = 61;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) positions.push(x, y, Math.sin(x / 5) * 2);
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const i = y * n + x;
        indices.push(i, i + 1, i + n, i + 1, i + n + 1, i + n);
      }
    }
    const part: MeshPart = { name: 'grid', positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    const out = simplify(part, 2000);
    expect(out.indices.length / 3).toBeLessThanOrEqual(2000);
    expect(out.indices.length / 3).toBeGreaterThan(500);
    expect(simplify(part, 10_000)).toBe(part);
  });

  it('sets overlapping parts side by side, and leaves a laid-out plate alone', () => {
    const a = parseStl(TETRA, 'top');
    const [x, y] = layOut([a, parseStl(TETRA, 'bottom')]);
    expect(boundsOf([y!]).min[0]).toBeGreaterThan(boundsOf([x!]).max[0]);
    const apart = { ...a, positions: a.positions.map((v, i) => (i % 3 === 0 ? v + 100 : v)) };
    const kept = layOut([a, apart]);
    expect(kept[1]!.positions).toBe(apart.positions);
  });
});

describe('convertModel', () => {
  it('converts an STL to a GLB', async () => {
    const out = await convertModel(TETRA, 'tetra.stl');
    expect(out.format).toBe('stl');
    expect(out.stats.triangles).toBe(4);
    expect(sniffModel(out.glb)).toBe('glb');
  });

  it('combines a top and a bottom into one model', async () => {
    const out = await convertModelFiles([
      { bytes: TETRA, name: 'a Top.stl' },
      { bytes: TETRA, name: 'a Bottom.stl' },
    ]);
    expect(out.stats.parts).toBe(2);
    expect(out.stats.triangles).toBe(8);
  });

  it('refuses what the bytes are not, whatever the name says', async () => {
    await expect(convertModel(TETRA, 'tetra.step')).rejects.toBeInstanceOf(ModelRefusal);
    await expect(convertModel(new TextEncoder().encode('<html>hello</html>'), 'x.stl')).rejects.toThrow(/not an STL, STEP or GLB/);
    await expect(convertModel(new Uint8Array(), 'x.stl')).rejects.toThrow(/empty/);
    await expect(convertModel(new Uint8Array(25 * 1024 * 1024), 'big.stl')).rejects.toThrow(/takes up to 24 MB/);
  });

  it('refuses a GLB that reaches outside itself', async () => {
    const glb = writeGlb([parseStl(TETRA, 't')]);
    const json = readGlbJson(glb)!;
    (json['buffers'] as Record<string, unknown>[])[0]!['uri'] = 'https://example.com/steal.bin';
    const text = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array((text.length + 3) & ~3).fill(0x20);
    padded.set(text);
    const out = new Uint8Array(20 + padded.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, out.length, true);
    view.setUint32(12, padded.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(padded, 20);
    await expect(convertModel(out, 'evil.glb')).rejects.toThrow(/outside itself/);
  });

  it('converts a STEP in the child process and reports its memory', async () => {
    const out = await convertModel(CUBE_STEP, 'cube.stp');
    expect(out.format).toBe('step');
    expect(out.stats.triangles).toBeGreaterThanOrEqual(12);
    expect(out.stats.peakRssMb).toBeGreaterThan(0);
    expect(sniffModel(out.glb)).toBe('glb');
  }, 60_000);
});

const db = loadDb();
const BOARD = 'rs485-terminal-board';

describe('/api/models', () => {
  let deps: WorkbenchDeps;
  let assets: ReturnType<typeof memoryAssetStore>;
  let links: ReturnType<typeof memoryModelLinkStore>;
  let glbId: string;

  beforeEach(async () => {
    assets = memoryAssetStore();
    links = memoryModelLinkStore();
    const glb = writeGlb([parseStl(TETRA, 'tetra')]);
    glbId = (await assets.put(Buffer.from(glb), 'model/gltf-binary', 'tetra.glb', 'test fixture')).id;
    await assets.put(Buffer.from('%PDF-1.4 datasheet'), 'application/pdf', 'sheet.pdf', 'test');
    deps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: true }), remove: () => undefined },
      loadDb: () => db,
      assets,
      modelLinks: links,
      today: () => '2026-09-29',
    };
  });

  const call = async (method: string, path: string, body?: unknown, ifMatch?: string) =>
    (await handleWorkbenchRequest(
      { method, path, ...(body === undefined ? {} : { body }), ...(ifMatch === undefined ? {} : { headers: { 'if-match': ifMatch } }) },
      deps,
    )) as { status: number; body: any; headers?: Record<string, string> };

  it('lists stored models, and keeps them out of the vendor-document index', async () => {
    const listed = await call('GET', '/api/models');
    expect(listed.body.models.map((m: { id: string }) => m.id)).toEqual([glbId]);
    const index = await call('GET', '/api/assets/index');
    expect(index.body.assets.map((a: { mime: string }) => a.mime)).toEqual(['application/pdf']);
  });

  it('attaches a stored model with If-Match, then detaches it', async () => {
    const before = await call('GET', `/api/models/pcbas/${BOARD}`);
    expect(before.body.link).toBeNull();
    const etag = before.headers!['ETag']!;
    expect(etag).toBe(linkETag(undefined));

    const attached = await call('PUT', `/api/models/pcbas/${BOARD}`, { asset: glbId, sourceKind: 'vendor' }, etag);
    expect(attached.status).toBe(200);
    expect(attached.body.link).toMatchObject({ record: `pcbas/${BOARD}`, asset: glbId, sourceKind: 'vendor' });
    expect(links.links).toHaveLength(1);

    // the old version is stale now
    expect((await call('DELETE', `/api/models/pcbas/${BOARD}`, undefined, etag)).status).toBe(409);
    const detached = await call('DELETE', `/api/models/pcbas/${BOARD}`, undefined, attached.headers!['ETag']);
    expect(detached.status).toBe(200);
    expect(links.links).toHaveLength(0);
    // the stored model stays — others may use it
    expect(await assets.get(glbId)).toBeDefined();
  });

  it('needs If-Match on every write', async () => {
    const refused = await call('PUT', `/api/models/pcbas/${BOARD}`, { asset: glbId });
    expect(refused.status).toBe(428);
    expect(links.links).toHaveLength(0);
  });

  it('uploads an STL: converts it, stores the GLB, links it as uploaded', async () => {
    const data = Buffer.from(TETRA).toString('base64');
    const up = await call('POST', `/api/models/pcbas/${BOARD}/upload`, { name: 'tetra.stl', data }, '*');
    expect(up.status).toBe(200);
    expect(up.body.link.sourceKind).toBe('uploaded');
    expect(up.body.link.src).toMatch(/tetra\.stl \(STL, converted to GLB\), uploaded by .* on 2026-09-29/);
    expect(up.body.stats.triangles).toBe(4);
    const stored = await assets.get(up.body.link.asset);
    expect(stored?.record.mime).toBe('model/gltf-binary');
  });

  it('refuses a file that is not a model, and writes nothing', async () => {
    const up = await call('POST', `/api/models/pcbas/${BOARD}/upload`, { name: 'x.stl', data: Buffer.from('not a model').toString('base64') }, '*');
    expect(up.status).toBe(422);
    expect(links.links).toHaveLength(0);
  });

  it('refuses paths, unknown kinds, unknown records and non-model assets', async () => {
    expect((await call('GET', '/api/models/pcbas/..%2F..%2Fetc')).status).toBe(400);
    expect((await call('GET', '/api/models/secrets/x')).status).toBe(400);
    expect((await call('PUT', '/api/models/pcbas/no-such-board', { asset: glbId }, '*')).status).toBe(404);
    const pdf = (await assets.list()).find((a) => a.mime === 'application/pdf')!.id;
    expect((await call('PUT', `/api/models/pcbas/${BOARD}`, { asset: pdf }, '*')).status).toBe(404);
    expect((await call('POST', `/api/models/pcbas/${BOARD}/upload`, { name: '../../x.stl', data: '' }, '*')).status).toBe(400);
  });

  describe('imported models (the generated cache, never committed)', () => {
    const files = [{ path: 'alex-resin/SHL-00103 (x)/Rev1/SHL-00103-00 (HD15 Coax Top) Rev1.stl', sha256: 'b'.repeat(64) }];
    const key = sourceKey(files, 150_000);
    const imported = {
      record: `pcbas/${BOARD}`,
      asset: key,
      sourceKind: 'resin-print' as const,
      src: 'alex-resin/… — Revision 1',
      revision: 'Rev1',
      name: 'SHL-00103-00 Rev1',
      files,
    };

    it('keys the cache by the sources and the converter, not by when it ran', () => {
      expect(sourceKey(files, 150_000)).toBe(key);
      expect(sourceKey(files, 80_000)).not.toBe(key);
      expect(sourceKey([{ ...files[0]!, sha256: 'c'.repeat(64) }], 150_000)).not.toBe(key);
    });

    it('answers "not built yet" in words while the cache lacks it, then serves it through the asset API', async () => {
      const cache = memoryModelCache();
      deps.modelCache = cache;
      await links.put(imported);
      const before = await call('GET', `/api/models/pcbas/${BOARD}`);
      expect(before.body.built).toBe(false);
      const missing = await call('GET', `/api/assets/${key}`);
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ state: 'not-built', error: expect.stringMatching(/not been built/) });
      expect(missing.body.hint).toMatch(/model importer/);

      await cache.put(key, writeGlb([parseStl(TETRA, 'tetra')]));
      const served = await call('GET', `/api/assets/${key}`);
      expect(served.status).toBe(200);
      expect((served as unknown as { contentType: string }).contentType).toBe('model/gltf-binary');
      expect((await call('GET', `/api/models/pcbas/${BOARD}`)).body.built).toBe(true);
      // an id nothing links is the ordinary 404
      expect((await call('GET', `/api/assets/${'d'.repeat(64)}`)).body.state).toBeUndefined();
    });

  });

  it("is an edit of the record, so the record's edit lock covers it", () => {
    expect(recordsOfWrite('PUT', `/api/models/pcbas/${BOARD}`)).toEqual([`definition:pcbas:${BOARD}`]);
    expect(recordsOfWrite('POST', `/api/models/mechanicals/shell-x/upload`)).toEqual(['definition:mechanicals:shell-x']);
    expect(recordsOfWrite('GET', `/api/models/pcbas/${BOARD}`)).toEqual([]);
  });
});
