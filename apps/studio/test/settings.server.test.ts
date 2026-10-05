/**
 * Hub branding settings (cs-5k1.2): stored as a catalog document with the logo
 * as a sanitised, content-addressed asset; refused on bad input; viewers are
 * kept out by the auth gate like every other write.
 */

import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryAssetStore } from '../server/assets.ts';
import { sanitizePng } from '../server/png-sanitize.ts';
import { BRANDING_PATH, ENGINEERING_PATH, effectiveTestDefaults } from '../server/settings.ts';
import { memoryDocStore } from '../server/storage/doc-store.ts';
import { makePng, pngDataUri } from './png-fixture.ts';

function deps() {
  const docs = memoryDocStore();
  const assets = memoryAssetStore();
  return { docs, assets, deps: { docs, assets } as unknown as WorkbenchDeps };
}
const get = (d: WorkbenchDeps) => handleWorkbenchRequest({ method: 'GET', path: '/api/settings/branding' }, d);
const put = (d: WorkbenchDeps, body: unknown, ifMatch: string) => handleWorkbenchRequest({ method: 'PUT', path: '/api/settings/branding', body, headers: { 'if-match': ifMatch } }, d);

describe('png sanitiser', () => {
  it('keeps the picture chunks, drops metadata, and refuses a damaged or oversized file', () => {
    const dirty = makePng(4, [{ type: 'tEXt', body: 'Comment\0secret' }, { type: 'eXIf', body: 'gps' }]);
    const clean = sanitizePng(dirty);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.bytes.includes(Buffer.from('tEXt'))).toBe(false);
    expect(clean.bytes.includes(Buffer.from('secret'))).toBe(false);
    expect(clean.bytes.length).toBeLessThan(dirty.length);
    expect(sanitizePng(clean.bytes).ok).toBe(true);
    const broken = Buffer.from(dirty);
    broken[40] = (broken[40] ?? 0) ^ 0xff;
    expect(sanitizePng(broken).ok).toBe(false);
    expect(sanitizePng(Buffer.from('<svg/>')).ok).toBe(false);
    expect(sanitizePng(makePng(4000, []).subarray(0, 100)).ok).toBe(false);
    expect(sanitizePng(Buffer.alloc(600 * 1024)).ok).toBe(false);
  });
});

describe('branding settings', () => {
  it('is empty by default and round-trips name, rights, designer and logo', async () => {
    const { deps: d, docs, assets } = deps();
    const first = await get(d);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ src: expect.any(String) });
    const saved = await put(d, { organisation: ' Acme Cable Co ', rights: 'Confidential', designer: 'J. Doe', logo: pngDataUri(makePng(4, [{ type: 'tEXt', body: 'x\0y' }])) }, first.headers!.ETag!);
    expect(saved.status).toBe(200);
    const body = saved.body as { organisation: string; logo: string; logoDataUri: string };
    expect(body.organisation).toBe('Acme Cable Co');
    expect(body.logoDataUri).toMatch(/^data:image\/png;base64,/);
    expect(docs.docs.has(BRANDING_PATH)).toBe(true);
    expect(assets.list()).toHaveLength(1);
    expect(assets.files.get(body.logo)!.includes(Buffer.from('tEXt'))).toBe(false);
    // omitted logo is kept; null removes it
    const again = await put(d, { organisation: 'Acme' }, saved.headers!.ETag!);
    expect((again.body as { logo?: string }).logo).toBe(body.logo);
    const removed = await put(d, { organisation: 'Acme', logo: null }, again.headers!.ETag!);
    expect((removed.body as { logo?: string }).logo).toBeUndefined();
    // clearing every field removes the document: back to the generic text
    const cleared = await put(d, {}, removed.headers!.ETag!);
    expect(cleared.body).toEqual({ src: expect.any(String) });
    expect(docs.docs.has(BRANDING_PATH)).toBe(false);
  });

  it('refuses a stale write, a missing precondition, a non-PNG logo and bad text', async () => {
    const { deps: d } = deps();
    const first = await get(d);
    const tag = first.headers!.ETag!;
    expect((await put(d, { organisation: 'A' }, tag)).status).toBe(200);
    expect((await put(d, { organisation: 'B' }, tag)).status).toBe(409);
    expect((await handleWorkbenchRequest({ method: 'PUT', path: '/api/settings/branding', body: {} }, d)).status).toBe(428);
    const now = (await get(d)).headers!.ETag!;
    expect((await put(d, { logo: 'data:image/jpeg;base64,AAAA' }, now)).status).toBe(400);
    expect((await put(d, { logo: pngDataUri(Buffer.from('not a png')) }, now)).status).toBe(400);
    expect((await put(d, { organisation: 'x'.repeat(200) }, now)).status).toBe(400);
    expect((await put(d, { rights: 'a\nb' }, now)).status).toBe(400);
    expect((await put(d, { notes: ['one', 'two'] }, now)).status).toBe(400);
  });
});

describe('engineering settings (testing defaults, electrical thresholds, approvals)', () => {
  const eng = (d: WorkbenchDeps, method: string, body?: unknown, ifMatch?: string) =>
    handleWorkbenchRequest({ method, path: '/api/settings/engineering', ...(body === undefined ? {} : { body }), ...(ifMatch === undefined ? {} : { headers: { 'if-match': ifMatch } }) }, d);

  it('round-trips the three sections, refuses bad values and a stale write, and clearing removes the document', async () => {
    const { deps: d, docs } = deps();
    const first = await eng(d, 'GET');
    expect(first.status).toBe(200);
    expect((first.body as { builtIn: { electrical: { maxDropV: number } } }).builtIn.electrical.maxDropV).toBe(0.5);
    const saved = await eng(d, 'PUT', { testDefaults: { isolationVolts: 250 }, electrical: { maxDropV: 0.3 }, approvals: { enabled: true, approverRoles: ['owner', 'editor'] } }, first.headers!.ETag!);
    expect(saved.status).toBe(200);
    expect(docs.docs.get(ENGINEERING_PATH)).toMatchObject({ testDefaults: { isolationVolts: 250 }, electrical: { maxDropV: 0.3 }, approvals: { enabled: true } });
    expect((await eng(d, 'PUT', {}, first.headers!.ETag!)).status).toBe(409);
    expect((await eng(d, 'PUT', { testDefaults: { isolationVolts: -1 } }, saved.headers!.ETag!)).status).toBe(400);
    expect((await eng(d, 'PUT', { electrical: { maxDropV: 0 } }, saved.headers!.ETag!)).status).toBe(400);
    expect((await eng(d, 'PUT', { approvals: { enabled: 'yes' } }, saved.headers!.ETag!)).status).toBe(400);
    const cleared = await eng(d, 'PUT', {}, saved.headers!.ETag!);
    expect(cleared.status).toBe(200);
    expect(docs.docs.has(ENGINEERING_PATH)).toBe(false);
  });

  it('keeps the organisation currency and labour rate, and refuses a bad code or rate', async () => {
    const { deps: d, docs } = deps();
    const first = await eng(d, 'GET');
    const saved = await eng(d, 'PUT', { costing: { currency: 'EUR', labourRatePerHour: 42.5 } }, first.headers!.ETag!);
    expect(saved.status).toBe(200);
    expect(docs.docs.get(ENGINEERING_PATH)).toMatchObject({ costing: { currency: 'EUR', labourRatePerHour: 42.5 } });
    expect((await eng(d, 'PUT', { costing: { currency: 'euro' } }, saved.headers!.ETag!)).status).toBe(400);
    expect((await eng(d, 'PUT', { costing: { labourRatePerHour: -2 } }, saved.headers!.ETag!)).status).toBe(400);
  });

  it('the settings override the environment fallback per parameter', async () => {
    const { docs } = deps();
    const env = { isolationVolts: 100, hipotVolts: 1500 };
    expect(await effectiveTestDefaults({ docs, testDefaults: env })).toEqual(env);
    await docs.write(ENGINEERING_PATH, { testDefaults: { isolationVolts: 250 }, src: 'x' });
    expect(await effectiveTestDefaults({ docs, testDefaults: env })).toEqual({ isolationVolts: 250, hipotVolts: 1500 });
    expect(await effectiveTestDefaults({ docs })).toEqual({ isolationVolts: 250 });
  });
});
