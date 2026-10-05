/**
 * Install a pack from an upload or an https URL (`server/packs.ts`, `pack-archive.ts`):
 * verification, the diff, one change set, then update and disable on the result.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross, readInstalledPacks } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { PackArchiveError, fetchPack, isPrivateAddress, readPackBytes, readZip } from '../server/pack-archive.ts';

const src = 'synthetic example: uploaded pack';
const manifest = (version: string, extra: object = {}) => ({ format: 1, id: 'upload', name: 'Uploaded', version, license: 'CC-BY-4.0', ...extra });
const bundle = (version: string, r: string, extra = false) => ({
  format: 1,
  manifest: manifest(version),
  files: {
    'components.json': [
      { id: 'up-r', label: `${r} resistor`, kind: 'resistor', value: r, terminals: [{ id: 'a' }, { id: 'b' }], src },
      ...(extra ? [{ id: 'up-r2', label: '2 resistor', kind: 'resistor', terminals: [{ id: 'a' }, { id: 'b' }], src }] : []),
    ],
  },
});

/** A zip of `files` (name → text), entries deflated (`deflate`) or stored. */
function zip(files: Record<string, string>, deflate = true): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

const zipOf = (b: ReturnType<typeof bundle>, folder = ''): Uint8Array =>
  zip({ [`${folder}wirehub-pack.json`]: JSON.stringify(b.manifest), ...Object.fromEntries(Object.entries(b.files).map(([k, v]) => [`${folder}${k}`, JSON.stringify(v)])) });

describe('pack archives', () => {
  it('reads a zip (deflated or stored), stripping one wrapping folder, ignoring non-data entries', () => {
    const b = bundle('1.0.0', '10');
    for (const deflate of [true, false]) {
      const files = readZip(zip({ 'pack-1.0.0/wirehub-pack.json': JSON.stringify(b.manifest), 'pack-1.0.0/components.json': JSON.stringify(b.files['components.json']), 'pack-1.0.0/LICENSE': 'x' }, deflate));
      expect([...files.keys()].sort()).toEqual(['components.json', 'wirehub-pack.json']);
    }
    expect(readPackBytes(zipOf(b)).format).toBe('zip');
    expect(readPackBytes(new TextEncoder().encode(JSON.stringify(b))).format).toBe('bundle');
  });

  it('refuses unsafe zips and junk', () => {
    expect(() => readZip(zip({ '../evil.json': '{}' }))).toThrow(/unsafe/);
    expect(() => readPackBytes(new Uint8Array([1, 2, 3]))).toThrow(PackArchiveError);
    expect(() => readPackBytes(new TextEncoder().encode('{"manifest":1}'))).toThrow(/bundle/);
    expect(() => readPackBytes(new TextEncoder().encode(JSON.stringify({ manifest: {}, files: { '../x.json': [] } })))).toThrow(/path/);
  });

  it('classifies private addresses', () => {
    for (const a of [[127, 0, 0, 1], [10, 1, 2, 3], [192, 168, 0, 9], [172, 16, 0, 1], [169, 254, 1, 1]].map((p) => p.join('.')).concat(['::1', 'fd00::1', '::ffff:10.0.0.1'])) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '2606:4700::1']) expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('fetchPack', () => {
  const body = new TextEncoder().encode('hello');
  const pub = async () => ['93.184.216.34'];
  const ok = (bytes: Uint8Array = body, headers: Record<string, string> = {}): typeof fetch => (async () => new Response(bytes as BodyInit, { status: 200, headers })) as typeof fetch;

  it('fetches over https from a public address', async () => {
    expect(new TextDecoder().decode(await fetchPack('https://example.org/p.zip', { fetch: ok(), lookup: pub }))).toBe('hello');
  });
  it('refuses http, credentials, private hosts and private resolutions', async () => {
    await expect(fetchPack('http://example.org/p.zip', { fetch: ok(), lookup: pub })).rejects.toThrow(/https/);
    await expect(fetchPack('https://user:pw@example.org/p.zip', { fetch: ok(), lookup: pub })).rejects.toThrow(/user name/);
    await expect(fetchPack('https://127.0.0.1/p.zip', { fetch: ok(), lookup: pub })).rejects.toThrow(/private/);
    await expect(fetchPack('https://internal.example/p.zip', { fetch: ok(), lookup: async () => ['10.0.0.5'] })).rejects.toThrow(/private/);
    await expect(fetchPack('ftp://x', { fetch: ok(), lookup: pub })).rejects.toThrow(/https/);
  });
  it('follows redirects only to checked https addresses', async () => {
    let calls = 0;
    const redirecting = (async () => (++calls === 1 ? new Response(null, { status: 302, headers: { location: 'http://example.org/other' } }) : new Response(body as BodyInit))) as typeof fetch;
    await expect(fetchPack('https://example.org/p.zip', { fetch: redirecting, lookup: pub })).rejects.toThrow(/https/);
    calls = 1;
    expect((await fetchPack('https://example.org/p.zip', { fetch: (async () => (++calls === 2 ? new Response(null, { status: 301, headers: { location: '/q.zip' } }) : new Response(body as BodyInit))) as typeof fetch, lookup: pub })).length).toBe(5);
  });
  it('enforces the size limit, declared or streamed, and the timeout', async () => {
    await expect(fetchPack('https://example.org/p', { fetch: ok(body, { 'content-length': '999999' }), lookup: pub, maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
    await expect(fetchPack('https://example.org/p', { fetch: ok(new Uint8Array(500)), lookup: pub, maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
    const hang = ((_url: unknown, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(fetchPack('https://example.org/p', { fetch: hang, lookup: pub, timeoutMs: 30 })).rejects.toThrow(/too long/);
    await expect(fetchPack('https://example.org/p', { fetch: (async () => new Response('no', { status: 404 })) as typeof fetch, lookup: pub })).rejects.toThrow(/404/);
  });
});

describe('POST /api/packs/install', () => {
  let root = '';
  let dir = '';
  let packs = '';
  let afterInstalls = 0;
  let deps: WorkbenchDeps;
  const call = async (path: string, body?: unknown, method = 'POST'): Promise<{ status: number; body: any }> =>
    (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
  const hub = () => createCatalog(catalogWithPacksSource(dir, packs));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-install-'));
    dir = join(root, 'catalog');
    packs = join(root, 'packs');
    cpSync(dataPath(''), dir, { recursive: true });
    afterInstalls = 0;
    deps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => hub().loadDb(),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
      setup: {
        dataDir: dir,
        packsDir: packs,
        prompt: false,
        now: () => '2026-10-05T12:00:00.000Z',
        afterInstall: () => void (afterInstalls += 1),
        packFetch: { lookup: async () => ['93.184.216.34'], fetch: (async () => new Response(zipOf(bundle("1.0.0", "10")) as BodyInit)) as typeof fetch },
      },
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('previews a bundle with the diff and writes nothing, then installs it as a layer', async () => {
    const preview = await call('/api/packs/install', { bundle: bundle('1.0.0', '10') });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ kind: 'install', source: 'bundle', verified: true, applicable: true });
    expect(preview.body.plan.diff.added.map((r: { id: string }) => r.id)).toEqual(['up-r']);
    expect(preview.body.plan.pack).toMatchObject({ id: 'upload', version: '1.0.0', license: 'CC-BY-4.0' });
    expect(existsSync(packs)).toBe(false);
    expect(afterInstalls).toBe(0);

    const done = await call('/api/packs/install', { bundle: bundle('1.0.0', '10'), apply: true, sha256: preview.body.sha256 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ installed: true, id: 'upload', version: '1.0.0' });
    expect(afterInstalls).toBe(1);
    expect(hub().loadDb().components.some((c) => c.id === 'up-r')).toBe(true);
    expect(readInstalledPacks(packs).packs[0]).toMatchObject({ id: 'upload', version: '1.0.0', license: 'CC-BY-4.0' });
    expect((await call('/api/packs', undefined, 'GET')).body.packs[0]).toMatchObject({ id: 'upload', records: 1 });
  });

  it('takes a zip (base64) and a URL, and an updated version through the same door', async () => {
    const zipped = Buffer.from(zipOf(bundle('1.0.0', '10'), 'upload-1.0.0/')).toString('base64');
    expect((await call('/api/packs/install', { zip: zipped, apply: true })).body).toMatchObject({ installed: true, source: 'zip' });
    // the same version again, then an update with a diff
    expect((await call('/api/packs/install', { url: 'https://example.org/p.zip', apply: true })).body).toMatchObject({ installed: false, reason: 'already at this version' });
    const update = await call('/api/packs/install', { bundle: bundle('1.1.0', '11', true) });
    expect(update.body).toMatchObject({ kind: 'update' });
    expect(update.body.plan.diff.changed.map((r: { id: string }) => r.id)).toEqual(['up-r']);
    expect(update.body.plan.diff.added.map((r: { id: string }) => r.id)).toEqual(['up-r2']);
    expect((await call('/api/packs/install', { bundle: bundle('1.1.0', '11', true), apply: true })).body.installed).toBe(true);
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.1.0');
    // a changed pack is refused when the preview's digest no longer matches
    expect((await call('/api/packs/install', { bundle: bundle('1.2.0', '12'), apply: true, sha256: 'deadbeef' })).status).toBe(409);
    // disable works on what was uploaded
    const gone = await call('/api/packs/upload', undefined, 'DELETE');
    expect(gone.body).toMatchObject({ disabled: 'upload', removed: 2 });
    expect(hub().loadDb().components.some((c) => c.id === 'up-r')).toBe(false);
  });

  it('fetches a URL server-side and refuses what is not https', async () => {
    const preview = await call('/api/packs/install', { url: 'https://example.org/p.zip' });
    expect(preview.body).toMatchObject({ source: 'zip', verified: true });
    const http = await call('/api/packs/install', { url: 'http://example.org/p.zip' });
    expect(http.status).toBe(400);
    expect(http.body.error).toContain('https');
    expect((await call('/api/packs/install', { url: 'https://127.0.0.1/p.zip' })).status).toBe(400);
  });

  it('refuses a pack that fails verification, naming the problems', async () => {
    const bad = bundle('1.0.0', '10');
    delete (bad.files['components.json'][0] as { src?: string }).src;
    const refused = await call('/api/packs/install', { bundle: bad, apply: true });
    expect(refused.status).toBe(422);
    expect(refused.body.problems).toEqual(["components.json: record 'up-r' has no src"]);
    expect(existsSync(packs)).toBe(false);
    expect((await call('/api/packs/install', { bundle: { ...bundle('1.0.0', '1'), manifest: manifest('one') } })).status).toBe(422);
    expect((await call('/api/packs/install', {})).status).toBe(400);
    expect((await call('/api/packs/install', { bundle: 1, zip: 'x' })).status).toBe(400);
  });

  it('refuses clashes and library errors, and a major version without acceptance', async () => {
    const clash = bundle('1.0.0', '10');
    (clash.files['components.json'][0] as { id: string }).id = 'r-120';
    const refused = await call('/api/packs/install', { bundle: clash, apply: true });
    expect(refused.status).toBe(409);
    expect(refused.body.plan.conflicts[0]).toContain("'r-120' already exists");
    const broken = { ...bundle('1.0.0', '10'), files: { ...bundle('1.0.0', '10').files, 'interfaces.json': [{ id: 'bad-if', label: 'Bad', bodies: ['de9-male'], pins: { '1': { signal: 'no-such-signal' } }, src }] } };
    const refusedErrors = await call('/api/packs/install', { bundle: broken, apply: true });
    expect(refusedErrors.status).toBe(409);
    expect(refusedErrors.body.plan.issues.map((i: { code: string }) => i.code)).toContain('vocab-unknown');
    expect(existsSync(packs)).toBe(false);

    await call('/api/packs/install', { bundle: bundle('1.0.0', '10'), apply: true });
    const major = await call('/api/packs/install', { bundle: bundle('2.0.0', '20'), apply: true });
    expect(major.status).toBe(409);
    expect(major.body.error).toContain('major');
    expect((await call('/api/packs/install', { bundle: bundle('2.0.0', '20'), apply: true, acceptMajor: true })).body.installed).toBe(true);
  });

  it('is deployment administration: no API token may call it', async () => {
    const { scopeFor } = await import('../server/auth/tokens.ts');
    expect(scopeFor('POST', '/api/packs/install')).toBeUndefined();
  });
});

