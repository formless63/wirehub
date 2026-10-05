/**
 * Drawing sidecars through the workbench API: the title-block facts and photo
 * for a design's drawing sheet, stored beside the design.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDb, loadDesign } from '@wirehub/catalog';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore, readDrawingMeta, readPhoto } from '../server/drawings.ts';
import { withLoadedVersion } from './loaded-version.ts';

const DRAWINGS = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data', 'drawings');
const db = loadDb();
const REAL = loadDesign('de9-crossover');

function designs(): DesignStore {
  const files = new Map([[REAL.id, formatDesignJson(REAL)]]);
  return {
    list: () => [...files.keys()].map((id) => ({ id, label: REAL.label })),
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? JSON.parse(files.get(id) as string) : undefined),
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

let drawings: ReturnType<typeof memoryDrawingStore>;
let deps: WorkbenchDeps;

beforeEach(async () => {
  drawings = memoryDrawingStore();
  deps = { designs: designs(), drawings, loadDb: () => db };
});

const call = async (method: string, path: string, body?: unknown) =>
  await handleWorkbenchRequest(await withLoadedVersion({ method, path, ...(body === undefined ? {} : { body }) }, deps), deps) as { status: number; body: any };

const META = {
  partNumber: 'CBL-00101-3X',
  revision: '1',
  lengths: [{ suffix: '-36', mm: 1830 }],
  materials: { u2: 'PCA-00103-00' },
};

describe('/api/drawings/:id', () => {
  it('answers an empty sidecar for a design that has none yet', async () => {
    expect(await call('GET', `/api/drawings/${REAL.id}`)).toMatchObject({ status: 200, body: { meta: {} } });
  });

  it('carries a version (ETag), and refuses a save without it (428) or with a stale one (409)', async () => {
    const tag = ((await handleWorkbenchRequest({ method: 'GET', path: `/api/drawings/${REAL.id}` }, deps)).headers ?? {})['ETag'];
    expect(tag).toMatch(/^".+"$/);
    const put = async (headers: Record<string, string>) =>
      (await handleWorkbenchRequest({ method: 'PUT', path: `/api/drawings/${REAL.id}`, body: META, headers }, deps)).status;
    expect(await put({})).toBe(428);
    expect(await put({ 'if-match': tag as string })).toBe(200);
    // that save moved the version on: the tag it was made from is stale now
    expect(await put({ 'if-match': tag as string })).toBe(409);
  });

  it('stores what it is sent and reads it back', async () => {
    expect((await call('PUT', `/api/drawings/${REAL.id}`, META)).status).toBe(200);
    expect((await call('GET', `/api/drawings/${REAL.id}`)).body).toEqual({ meta: META });
  });

  it('refuses fields it does not know, and changes nothing', async () => {
    const response = await call('PUT', `/api/drawings/${REAL.id}`, { partNumbr: 'typo' });
    expect(response.status).toBe(422);
    expect(response.body.hint).toContain("'partNumbr' is not a drawing field");
    expect(drawings.files.size).toBe(0);
  });

  it('will not keep details for a design that does not exist', async () => {
    expect((await call('PUT', '/api/drawings/no-such-design', META)).status).toBe(404);
    expect((await call('GET', '/api/drawings/..%2F..%2Fetc')).status).toBe(400);
  });

  it('stores and removes a photo', async () => {
    const png = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
    expect((await call('PUT', `/api/drawings/${REAL.id}/photo`, { photo: png })).body).toEqual({ photo: png });
    expect((await call('PUT', `/api/drawings/${REAL.id}/photo`, { photo: null })).body).toEqual({});
    expect((await call('PUT', `/api/drawings/${REAL.id}/photo`, { photo: 'data:image/gif;base64,AAAA' })).status).toBe(422);
  });

  it('follows the design through a rename and goes with it on delete', async () => {
    await call('PUT', `/api/drawings/${REAL.id}`, META);
    expect((await call('POST', `/api/designs/${REAL.id}/rename`, { newId: 'de9-renamed', newLabel: 'DE-9' })).status).toBe(200);
    expect((await call('GET', '/api/drawings/de9-renamed')).body.meta).toEqual(META);
    expect((await call('DELETE', '/api/designs/de9-renamed', { confirm: 'de9-renamed' })).status).toBe(200);
    expect(drawings.files.size).toBe(0);
  });

  it('says so in words when the host keeps no sidecars', async () => {
    delete deps.drawings;
    expect((await call('GET', `/api/drawings/${REAL.id}`)).status).toBe(501);
  });
});

describe('readDrawingMeta / readPhoto', () => {
  it('drops blank text rather than storing empty strings', async () => {
    expect(readDrawingMeta({ title: '  ', revision: '2', remarks: ['', 'keep'] })).toEqual({ ok: true, meta: { revision: '2', remarks: ['keep'] } });
  });

  it('keeps the illustration choice only when it differs from the default', async () => {
    expect(readDrawingMeta({ cutaway: 'drawn' })).toEqual({ ok: true, meta: { cutaway: 'drawn' } });
    expect(readDrawingMeta({ cutaway: 'art' })).toEqual({ ok: true, meta: {} });
    expect(readDrawingMeta({ cutaway: 'crayon' }).ok).toBe(false);
  });

  it('keeps sheet options, dropping empty ones, refusing unknown ones', async () => {
    expect(readDrawingMeta({ sheet: { paper: 'letter', number: ' CBL-00101-3X ', revision: '', status: 'DRAFT', stampDate: true } })).toEqual({
      ok: true,
      meta: { sheet: { paper: 'letter', number: 'CBL-00101-3X', status: 'DRAFT', stampDate: true } },
    });
    expect(readDrawingMeta({ sheet: { stampDate: false, number: ' ' } })).toEqual({ ok: true, meta: {} });
    expect(readDrawingMeta({ sheet: { paper: 'A3' } }).ok).toBe(false);
    expect(readDrawingMeta({ sheet: { colour: 'red' } }).ok).toBe(false);
  });

  it('checks every length', async () => {
    const result = readDrawingMeta({ lengths: [{ suffix: '-36', mm: -1 }] });
    expect(result.ok).toBe(false);
  });

  it('requires an explicit photo or null', async () => {
    expect(readPhoto({})).toMatchObject({ ok: false });
    expect(readPhoto({ photo: null })).toEqual({ ok: true, photo: undefined });
  });
});
