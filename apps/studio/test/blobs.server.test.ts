/**
 * Blob stores (`server/blobs.ts`) and the asset store on top of one.
 *
 * The S3 client is checked three ways: its signer against the worked example
 * in the AWS documentation, its requests against an in-memory fake, and — when
 * `WIREHUB_TEST_S3_URL` names a real store (`http://<key>:<secret>@host:port/<bucket>?region=<r>`)
 * — against that store. Without it, the live case is skipped.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envVar } from '../server/env.ts';
import { blobStoreFromEnv, fsBlobStore, isBlobKey, s3BlobStore, signV4 } from '../server/blobs.ts';

let dataDir = '';
vi.mock('@wirehub/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/catalog')>();
  return { ...actual, dataPath: (relative: string) => join(dataDir, relative) };
});
const { fileAssetStore, assetBlobKey } = await import('../server/assets.ts');

describe('signV4', () => {
  it('reproduces the AWS documentation example (GET Object with a Range header)', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const authorization = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', // privacy-check: allow (the documented example key)
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' + // privacy-check: allow
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('blob keys', () => {
  it('accepts content addresses and refuses anything that could escape', () => {
    expect(isBlobKey('assets/abc123.png')).toBe(true);
    expect(isBlobKey('../etc/passwd')).toBe(false);
    expect(isBlobKey('/abs')).toBe(false);
    expect(isBlobKey('a//b')).toBe(false);
    expect(isBlobKey('A/B')).toBe(false);
  });
});

describe('fsBlobStore', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wirehub-blobs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('puts, reads, checks and deletes', async () => {
    const store = fsBlobStore(dir);
    expect(await store.get('assets/x.png')).toBeUndefined();
    await store.put('assets/x.png', Buffer.from('png'), 'image/png');
    expect(await store.has('assets/x.png')).toBe(true);
    expect((await store.get('assets/x.png'))?.toString()).toBe('png');
    await store.delete('assets/x.png');
    expect(await store.has('assets/x.png')).toBe(false);
  });

  it('refuses a key that is not a content address', async () => {
    await expect(fsBlobStore(dir).put('../x', Buffer.from('x'), 'text/plain')).rejects.toThrow(/Not a blob key/);
  });
});

/** An S3 endpoint in memory: path-style objects in one bucket, signature header required. */
function fakeS3(): { fetch: typeof fetch; objects: Map<string, Buffer>; buckets: Set<string> } {
  const objects = new Map<string, Buffer>();
  const buckets = new Set<string>();
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (!/^AWS4-HMAC-SHA256 Credential=/.test(headers.get('authorization') ?? '')) return new Response('', { status: 403 });
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = rest.join('/');
    const method = init?.method ?? 'GET';
    if (key === '') {
      if (method === 'HEAD') return new Response(null, { status: buckets.has(bucket) ? 200 : 404 });
      if (method === 'PUT') buckets.add(bucket);
      return new Response('', { status: 200 });
    }
    if (!buckets.has(bucket)) return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    const id = `${bucket}/${key}`;
    if (method === 'PUT') {
      objects.set(id, Buffer.from(init?.body as Uint8Array));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') {
      objects.delete(id);
      return new Response(null, { status: 204 });
    }
    const found = objects.get(id);
    if (found === undefined) return new Response(method === 'HEAD' ? null : '<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response(method === 'HEAD' ? null : new Uint8Array(found), { status: 200 });
  };
  return { fetch: impl as typeof fetch, objects, buckets };
}

describe('s3BlobStore (in-memory endpoint)', () => {
  const config = { endpoint: 'http://s3.test:3900', region: 'garage', bucket: 'wirehub', accessKeyId: 'k', secretAccessKey: 's' };

  it('creates its bucket, then round-trips an object', async () => {
    const fake = fakeS3();
    const store = s3BlobStore(config, { fetch: fake.fetch, now: () => new Date('2026-10-04T00:00:00Z') });
    await store.ensureBucket();
    expect(fake.buckets.has('wirehub')).toBe(true);
    await store.put('assets/a.png', Buffer.from('bytes'), 'image/png');
    expect(fake.objects.get('wirehub/assets/a.png')?.toString()).toBe('bytes');
    expect(await store.has('assets/a.png')).toBe(true);
    expect((await store.get('assets/a.png'))?.toString()).toBe('bytes');
    expect(await store.get('assets/missing.png')).toBeUndefined();
    await store.delete('assets/a.png');
    expect(await store.has('assets/a.png')).toBe(false);
  });

  it('names the S3 error code when a request fails', async () => {
    const fake = fakeS3();
    const store = s3BlobStore(config, { fetch: fake.fetch });
    await expect(store.put('assets/a.png', Buffer.from('x'), 'image/png')).rejects.toThrow(/404 NoSuchBucket/);
  });
});

describe('blobStoreFromEnv', () => {
  it('is off when unset, and says what an s3 store is missing', () => {
    expect(blobStoreFromEnv({})).toBeUndefined();
    expect(() => blobStoreFromEnv({ WIREHUB_BLOBS: 's3', S3_ENDPOINT: 'http://x' })).toThrow(
      'WIREHUB_BLOBS=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.',
    );
    expect(blobStoreFromEnv({ WIREHUB_BLOBS: 'fs:/tmp/x' })?.describe).toMatch(/^fs /);
    expect(() => blobStoreFromEnv({ WIREHUB_BLOBS: 'ftp' })).toThrow(/must be 's3'/);
  });
});

describe('the asset store over a blob store', () => {
  let blobDir = '';
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wirehub-catalog-'));
    blobDir = mkdtempSync(join(tmpdir(), 'wirehub-blobs-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('keeps the index in the catalog and the bytes in the store', async () => {
    const blobs = fsBlobStore(blobDir);
    const assets = fileAssetStore(blobs);
    const record = await assets.put(Buffer.from('a photo'), 'image/png', 'photo.png', 'test');
    expect(existsSync(join(dataDir, 'assets/index.json'))).toBe(true);
    expect(existsSync(join(dataDir, `assets/${record.id}.png`))).toBe(false);
    expect((await blobs.get(assetBlobKey(record.id, 'image/png')))?.toString()).toBe('a photo');
    expect((await assets.get(record.id))?.bytes.toString()).toBe('a photo');
    // same bytes again: the same record, nothing new
    expect(await assets.put(Buffer.from('a photo'), 'image/png', 'other.png', 'test')).toEqual(record);
  });

  it('moves bytes committed beside the catalog into the store on first read', async () => {
    const record = await fileAssetStore().put(Buffer.from('old'), 'image/png', 'old.png', 'test');
    const blobs = fsBlobStore(blobDir);
    expect(await blobs.has(assetBlobKey(record.id, 'image/png'))).toBe(false);
    expect((await fileAssetStore(blobs).get(record.id))?.bytes.toString()).toBe('old');
    expect(await blobs.has(assetBlobKey(record.id, 'image/png'))).toBe(true);
  });
});

const live = envVar('TEST_S3_URL');
describe.skipIf(live === undefined)('s3BlobStore against WIREHUB_TEST_S3_URL', () => {
  it('round-trips an object', async () => {
    const url = new URL(live ?? 'http://x');
    const store = s3BlobStore({
      endpoint: `${url.protocol}//${url.host}`,
      region: url.searchParams.get('region') ?? 'us-east-1',
      bucket: url.pathname.replace(/^\//, ''),
      accessKeyId: decodeURIComponent(url.username),
      secretAccessKey: decodeURIComponent(url.password),
    });
    await store.ensureBucket();
    const key = 'test/round-trip.bin';
    await store.put(key, Buffer.from([1, 2, 3]), 'application/octet-stream');
    expect([...((await store.get(key)) ?? [])]).toEqual([1, 2, 3]);
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
  });
});
