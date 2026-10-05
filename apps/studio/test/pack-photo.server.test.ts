/**
 * A pack that ships a drawing's product photo (cs-8re): the image as `assets/<sha>.png` with its entry in the pack's
 * `assets/index.json`, the photo pointer naming it. File backend half (the layered install): the drawing shows the
 * photo and the asset is served, an update replaces it, a disable removes it. Postgres: `test/pg/pack-photo.server.test.ts`.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isPackFilePath } from '../server/pack-archive.ts';
import { photoBundle } from './pack-photo-fixture.ts';

const STARTER = fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'wirehub-photo-'));
const data = join(root, 'data');
const packs = join(root, 'packs');
beforeAll(() => {
  cpSync(STARTER, data, { recursive: true });
  mkdirSync(packs, { recursive: true });
  process.env.WIREHUB_CATALOG_DIR = data;
  process.env.WIREHUB_PACKS_DIR = packs;
});
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('a pack that ships a drawing photo (files)', () => {
  it('names an image of the asset library only by the hash of its bytes', async () => {
    const one = photoBundle('1.0.0', 1);
    expect(isPackFilePath(`assets/${one.sha}.png`)).toBe(true);
    expect(isPackFilePath(`assets/${one.sha}.jpg`)).toBe(true);
    expect(isPackFilePath('assets/photo.png')).toBe(false);
    expect(isPackFilePath(`assets/sub/${one.sha}.png`)).toBe(false);
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const deps = defaultWorkbenchDeps();
    const wrong = { ...one.bundle, files: { ...one.bundle.files, [`assets/${'0'.repeat(64)}.png`]: one.bundle.files[`assets/${one.sha}.png`] } };
    const refused = (await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body: { bundle: wrong } }, deps)) as { status: number };
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it('installs as a layer, replaces the photo on update, removes it on disable', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const deps = defaultWorkbenchDeps();
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };

    const one = photoBundle('1.0.0', 1);
    const preview = await call('POST', '/api/packs/install', { bundle: one.bundle });
    expect(preview.body, JSON.stringify(preview.body)).toMatchObject({ applicable: true, problems: [] });
    expect((await call('POST', '/api/packs/install', { bundle: one.bundle, apply: true })).status).toBe(200);
    expect((await call('GET', `/api/drawings/${one.design}`)).body.photo).toMatch(/^data:image\/png;base64,/);
    expect((await call('GET', `/api/assets/${one.sha}`)).status).toBe(200);
    // the shared library's own directory is untouched: the pack owns the image in its layer
    expect(existsSync(join(data, 'assets', `${one.sha}.png`))).toBe(false);

    const two = photoBundle('1.1.0', 2);
    expect((await call('POST', '/api/packs/install', { bundle: two.bundle, apply: true })).status).toBe(200);
    expect((await call('GET', `/api/drawings/${one.design}`)).body.photo).toMatch(/^data:image\/png;base64,/);
    expect((await call('GET', `/api/assets/${two.sha}`)).status).toBe(200);
    expect((await call('GET', `/api/assets/${one.sha}`)).status).toBe(404);

    expect((await call('DELETE', `/api/packs/${one.packId}`)).status).toBe(200);
    expect((await call('GET', `/api/drawings/${one.design}`)).body.photo).toBeUndefined();
    expect((await call('GET', `/api/assets/${two.sha}`)).status).toBe(404);
  });
});
