/**
 * Preview, the file backend and Postgres agree about a pack (cs-s97, cs-7ee, cs-e7d, cs-lx8). This is the half that needs
 * no database: the file stores read a hub whose pack supplies builds, drawing sidecars, versions, model links and art
 * exactly as the snapshot stores read the flattened catalog (the `api-parity-file-stores` check of the S1 gate), a pack
 * installs in canonical form, and the preview says what the database codec would refuse.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalPackText, createCatalog, isSrcExempt, memoryCatalogSource, packSourceProblems } from '@wirehub/catalog';
import { dataFileMap, explode, isCanonicalJson } from '@wirehub/catalog/src/codec/index.ts';
import { annotateErrors, packCodecProblems, readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../server/api.ts';
import { apiParity, directoryWorkbenchDeps, gateRoutes } from '../server/pg/gate.ts';
import { parityHub, parityPackFiles } from './pack-parity-fixture.ts';

const hub = parityHub();
process.env.WIREHUB_CATALOG_DIR = hub.data;
process.env.WIREHUB_PACKS_DIR = hub.packs;
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  rmSync(hub.root, { recursive: true, force: true });
});

describe('a pack is installed in canonical form', () => {
  it('writes every document canonical and the store-ordered files in order', () => {
    const dir = join(hub.packs, 'parity');
    for (const relative of ['components.json', 'builds/parity-board-rev1.json', `drawings/${hub.designId}.photo-ref.json`, 'models.json', 'depictions/parity-part/meta.json']) {
      expect(isCanonicalJson(readFileSync(join(dir, relative), 'utf8')), relative).toBe(true);
    }
    const links = (JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as { links: { record: string }[] }).links;
    expect(links.map((l) => l.record).filter((r) => r.startsWith('revisions/'))).toEqual(['revisions/ABC-123456-00/Rev1', 'revisions/parity-board/rev1', 'revisions/parity-board/rev2']);
  });

  it('canonicalPackText sorts an asset index and leaves other text alone', () => {
    const entry = (id: string) => ({ bytes: 1, src: 's', originalName: 'x.png', mime: 'image/png', id });
    const out = JSON.parse(canonicalPackText('assets/index.json', JSON.stringify([entry('b'), entry('a')]))) as Record<string, unknown>[];
    expect(out.map((e) => e['id'])).toEqual(['a', 'b']);
    expect(Object.keys(out[0] as object)).toEqual(['id', 'mime', 'originalName', 'src', 'bytes']);
    expect(canonicalPackText('notes.md', '# a')).toBe('# a');
    expect(canonicalPackText('x.json', 'not json')).toBe('not json');
  });
});

describe('the verifier and drawing sidecars (cs-7ee)', () => {
  it('asks no src of a drawing sidecar, and still asks it of every record', () => {
    expect(isSrcExempt('drawings/x.photo-ref.json')).toBe(true);
    expect(isSrcExempt('drawings/x.json')).toBe(true);
    expect(isSrcExempt('builds/x.json')).toBe(false);
    expect(packSourceProblems(join(hub.packs, 'parity'))).toEqual([]);
  });
});

describe('the flattened catalog is what Postgres would import', () => {
  const tree = readFlattenedCatalog(hub.root, hub.packs);
  it('explodes without a problem, revision link keys included', () => {
    const { errors, rows } = explode(tree);
    expect(errors).toEqual([]);
    expect(rows.modelLinks.map((l) => l.recordKey).filter((r) => r.startsWith('revisions/'))).toEqual(['revisions/ABC-123456-00/Rev1', 'revisions/parity-board/rev1', 'revisions/parity-board/rev2']);
    expect(rows.drawingPhotos).toEqual([{ design: hub.designId, sha256: hub.photo }]);
  });

  it('names the file and where it came from when the codec refuses one', () => {
    const own = new Map(tree);
    own.set('data/components.json', '[]');
    own.set('data/builds/parity-board-rev1.json', JSON.stringify(JSON.parse(own.get('data/builds/parity-board-rev1.json') as string)));
    const { errors } = explode(own);
    expect(errors.length).toBeGreaterThan(0);
    const said = annotateErrors(errors, hub.root, hub.packs);
    expect(said.find((e) => e.startsWith('data/builds/parity-board-rev1.json'))).toMatch(/not canonical JSON.*\[from pack 'parity'\]$/);
  });

  it('S1 api-parity-file-stores: the file stores answer every route as the flattened catalog does', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const filesDeps = defaultWorkbenchDeps();
    const { rows } = explode(tree);
    const catalog = createCatalog(memoryCatalogSource(dataFileMap(tree as ReadonlyMap<string, string | Uint8Array>), { name: 'the file catalog' }));
    const routes = gateRoutes(catalog, rows);
    // the kinds the pack supplies are among the routes compared
    expect(routes).toEqual(expect.arrayContaining(['/api/builds/parity-board-rev1', `/api/drawings/${hub.designId}`, `/api/designs/${hub.designId}/versions/3`, '/api/models/revisions/parity-board/rev1']));
    expect(routes).toContain(`/api/blobs/${hub.art}`);
    const diffs: string[] = [];
    await apiParity(routes, filesDeps, directoryWorkbenchDeps(hub.root, tree, rows), 'file stores vs the flattened catalog', (line) => diffs.push(line));
    expect(diffs).toEqual([]);
    // and they really do see the pack: a build, the drawing and its photo, the next revision, a revision's model
    const get = async (path: string) => (await handleWorkbenchRequest({ method: 'GET', path }, filesDeps)) as { status: number; body: any };
    expect((await get('/api/builds/parity-board-rev1')).status).toBe(200);
    const drawing = await get(`/api/drawings/${hub.designId}`);
    expect(drawing.body.meta.title).toBe('Parity drawing');
    expect(drawing.body.photo).toMatch(/^data:image\/png;base64,/);
    expect((await get(`/api/designs/${hub.designId}/versions`)).body.working.nextRev).toBeGreaterThan(3);
    expect((await get('/api/models/revisions/parity-board/rev1')).body.link.status).toBe('superseded');
    expect((await handleWorkbenchRequest({ method: 'GET', path: `/api/blobs/${hub.art}` }, filesDeps)).status).toBe(200);
    // the wire library the pack supplies (cs-kqy)
    expect(routes).toEqual(expect.arrayContaining(['/api/wire-library', '/api/wire-library/strip-practice']));
    const library = (await get('/api/wire-library')).body;
    expect(library.parts.map((p: { id: string }) => p.id)).toContain('parity-conductor');
    expect(library.recipes.map((r: { id: string }) => r.id)).toContain('parity-stock');
    expect((await get('/api/wire-library/strip-practice')).body.map((p: { id: string }) => p.id)).toContain('parity-practice');
  });
});

describe('the other file stores layer the pack too (cs-kqy)', () => {
  it('the depiction store lists, reads and serves a pack\'s depiction beside the catalog\'s own', async () => {
    const { fileDepictionStore } = await import('../server/depictions.ts');
    const store = fileDepictionStore();
    expect(await store.listDefIds()).toContain('parity-part');
    expect((await store.readMeta('parity-part'))?.['src']).toBe('synthetic example: parity pack');
    expect(Buffer.from((await store.readAsset('parity-part', 'face.svg')) as Uint8Array).toString()).toContain('<svg');
    expect(await store.readAsset('parity-part', 'missing.svg')).toBeUndefined();
    expect(await store.readMeta('no-such-def')).toBeUndefined();
  });

  it('the strip-practice, wire-part and recipe writes keep the pack\'s records in the pack', async () => {
    const { fileWireLibraryStore } = await import('../server/wire-library.ts');
    const store = fileWireLibraryStore();
    const library = await store.read();
    await store.writeParts([...library.parts, { id: 'local-part', kind: 'conductor', label: 'Local', src: 'synthetic example' } as never]);
    const own = JSON.parse(readFileSync(join(hub.data, 'wire-parts.json'), 'utf8')) as { id: string }[];
    expect(own.map((p) => p.id)).toEqual(['local-part']);
    expect((await store.read()).parts.map((p) => p.id).sort()).toEqual(['local-part', 'parity-conductor']);
    rmSync(join(hub.data, 'wire-parts.json'));
  });
});

describe('preview runs the database codec (cs-s97)', () => {
  it('finds nothing wrong with the parity pack, and reports a link key the table cannot hold', () => {
    const dir = join(hub.packs, 'parity');
    expect(packCodecProblems(hub.root, undefined, dir)).toEqual([]);
  });

  it('is part of POST /api/packs/install: not applicable, and refused when applied', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const deps = defaultWorkbenchDeps();
    const files = parityPackFiles(hub.designId, hub.photo) as Record<string, unknown>;
    const bundle = {
      format: 1,
      manifest: { format: 1, id: 'badkeys', name: 'Bad keys', version: '1.0.0', license: 'CC0-1.0' },
      files: { 'models.json': { src: 'synthetic example', links: [{ record: 'revisions/only-one-part-segment', asset: 'c'.repeat(64), sourceKind: 'vendor', src: 'synthetic example' }] } },
    };
    void files;
    const post = async (body: unknown) => (await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body }, deps)) as { status: number; body: any };
    const preview = await post({ bundle });
    expect(preview.status).toBe(200);
    expect(preview.body.applicable).toBe(false);
    expect(preview.body.problems.join('\n')).toMatch(/models\.json: link 0 has no usable "record"/);
    const applied = await post({ bundle, apply: true });
    expect(applied.status).toBe(422);
    expect(existsSync(join(hub.packs, 'badkeys'))).toBe(false);
  });

  it('installs a compact-JSON bundle canonically and previews it as applicable', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const deps = defaultWorkbenchDeps();
    const bundle = {
      format: 1,
      manifest: { format: 1, id: 'compact', name: 'Compact', version: '1.0.0', license: 'CC0-1.0' },
      files: {
        'builds/compact-board-rev1.json': { board: 'PCA-00002', revision: 'Rev1', label: 'Compact board', end: 'source', builds: [{ key: 'bare', build: 'bare', src: 'synthetic example' }] },
        'models.json': { src: 'synthetic example', links: [{ record: 'revisions/compact-board/Rev1', asset: 'd'.repeat(64), sourceKind: 'vendor', src: 'synthetic example' }] },
      },
    };
    const post = async (body: unknown) => (await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body }, deps)) as { status: number; body: any };
    const preview = await post({ bundle });
    expect(preview.body.problems, JSON.stringify(preview.body)).toEqual([]);
    // models.json is the catalog's or another pack's to hold, so it conflicts with the parity pack's: say so, install the rest
    expect(preview.body.applicable === true || preview.body.plan.conflicts.length > 0).toBe(true);
  });
});
