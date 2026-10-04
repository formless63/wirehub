/**
 * The shared asset store: saving a drawing photo
 * dedups by content, `GET /api/assets` lists what is shared, and a design
 * that stops using a photo does not take the shared asset down with it.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryAssetStore } from '../server/assets.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore } from '../server/drawings.ts';
import { withLoadedVersion } from './loaded-version.ts';

const db = loadDb();
const A = loadDesign('rj45-patch-t568b');
const B = loadDesign('db9-null-modem');

function designs(): DesignStore {
  const files = new Map([
    [A.id, formatDesignJson(A)],
    [B.id, formatDesignJson(B)],
  ]);
  return {
    list: () => [...files.keys()].map((id) => ({ id, label: id })),
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? JSON.parse(files.get(id) as string) : undefined),
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

let assets: ReturnType<typeof memoryAssetStore>;
let drawings: ReturnType<typeof memoryDrawingStore>;
let deps: WorkbenchDeps;

beforeEach(async () => {
  assets = memoryAssetStore();
  drawings = memoryDrawingStore(assets);
  deps = { designs: designs(), drawings, assets, loadDb: () => db };
});

const call = async (method: string, path: string, body?: unknown) =>
  await handleWorkbenchRequest(await withLoadedVersion({ method, path, ...(body === undefined ? {} : { body }) }, deps), deps) as { status: number; body: any };

const PHOTO = `data:image/jpeg;base64,${Buffer.from('the same photo, byte for byte').toString('base64')}`;
const OTHER_PHOTO = `data:image/jpeg;base64,${Buffer.from('a different photo entirely').toString('base64')}`;

describe('GET /api/assets', () => {
  it('starts empty, and says so in words with no store at all', async () => {
    expect((await call('GET', '/api/assets')).body).toEqual({ assets: [] });
    delete deps.assets;
    expect((await call('GET', '/api/assets')).status).toBe(501);
  });

  it('lists an asset created by saving a drawing photo', async () => {
    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: PHOTO });
    const list = (await call('GET', '/api/assets')).body.assets;
    expect(list).toHaveLength(1);
    expect(list[0].mime).toBe('image/jpeg');
    expect(list[0].originalName).toContain(A.id);
  });
});

describe('saving the same photo on two drawings', () => {
  it('dedups: one shared asset, not two copies', async () => {
    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: PHOTO });
    await call('PUT', `/api/drawings/${B.id}/photo`, { photo: PHOTO });

    expect((await call('GET', '/api/assets')).body.assets).toHaveLength(1);
    expect(assets.files.size).toBe(1);

    // both drawings resolve the same photo back
    expect((await call('GET', `/api/drawings/${A.id}`)).body.photo).toBe(PHOTO);
    expect((await call('GET', `/api/drawings/${B.id}`)).body.photo).toBe(PHOTO);
  });

  it('a different photo becomes a second asset', async () => {
    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: PHOTO });
    await call('PUT', `/api/drawings/${B.id}/photo`, { photo: OTHER_PHOTO });
    expect((await call('GET', '/api/assets')).body.assets).toHaveLength(2);
  });

  it('removing one drawing’s photo leaves the shared asset for the other', async () => {
    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: PHOTO });
    await call('PUT', `/api/drawings/${B.id}/photo`, { photo: PHOTO });

    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: null });
    expect((await call('GET', `/api/drawings/${A.id}`)).body.photo).toBeUndefined();
    // B still has it, and the asset itself is still listed
    expect((await call('GET', `/api/drawings/${B.id}`)).body.photo).toBe(PHOTO);
    expect((await call('GET', '/api/assets')).body.assets).toHaveLength(1);
  });

  it('picking an existing asset (sending the same bytes again) reuses it rather than duplicating', async () => {
    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: PHOTO });
    const before = (await call('GET', '/api/assets')).body.assets;
    // this is what the picker does: it already has the asset's own data URI
    // from the list, and "picking" it is just handing that same string back
    await call('PUT', `/api/drawings/${B.id}/photo`, { photo: before[0].dataUri ?? PHOTO });
    expect((await call('GET', '/api/assets')).body.assets).toHaveLength(1);
  });
});

describe('vendor documents: GET /api/assets/index and /api/assets/:id', () => {
  const PDF = Buffer.from('%PDF-1.4 a vendor datasheet');

  it('lists every stored file (PDFs too) without bytes, while the photo picker still sees images only', async () => {
    await call('PUT', `/api/drawings/${A.id}/photo`, { photo: PHOTO });
    const pdf = await assets.put(PDF, 'application/pdf', 'Vendor C146.pdf', 'test');
    const index = await call('GET', '/api/assets/index');
    expect(index.status).toBe(200);
    expect(index.body.assets.map((a: { mime: string }) => a.mime).sort()).toEqual(['application/pdf', 'image/jpeg']);
    expect(index.body.assets.every((a: object) => !('dataUri' in a))).toBe(true);
    const photos = (await call('GET', '/api/assets')).body.assets;
    expect(photos.map((a: { id: string }) => a.id)).not.toContain(pdf.id);
  });

  it('serves one file as its own type, so a PDF opens in the browser', async () => {
    const pdf = await assets.put(PDF, 'application/pdf', 'Vendor C146.pdf', 'test');
    const response = await handleWorkbenchRequest({ method: 'GET', path: `/api/assets/${pdf.id}` }, deps);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/pdf');
    expect(Buffer.from(response.bytes!).equals(PDF)).toBe(true);
  });

  it('refuses a malformed id before touching the store, and 404s an unknown one', async () => {
    expect((await call('GET', '/api/assets/..%2f..%2fwires.json')).status).toBe(400);
    expect((await call('GET', `/api/assets/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await call('POST', `/api/assets/${'0'.repeat(64)}`)).status).toBe(405);
  });
});
