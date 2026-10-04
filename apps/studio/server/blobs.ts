/**
 * Blob stores — where uploaded file bytes live.
 *
 * The record of an asset (its id, type, name and `src`) stays catalog data
 * (`assets/index.json`, `assets.ts`); only the **bytes** move. Keys are
 * content addresses (`assets/<sha256>.<ext>`), so an object is never
 * overwritten with different content and a retried upload is harmless.
 *
 * Two implementations, chosen by `STUDIO_BLOBS` (`blobStoreFromEnv`):
 *
 * - `s3` — any S3-compatible service (Garage by default in `compose.yaml`;
 *   also AWS S3, MinIO, RustFS, Ceph RGW, Backblaze B2, Cloudflare R2). The
 *   client below speaks the lowest common denominator — path-style `PUT`,
 *   `GET`, `HEAD`, `DELETE` and bucket `PUT` — signed with AWS Signature
 *   Version 4, on `fetch` and `node:crypto`, so the app needs no SDK;
 * - `fs:<dir>` — a directory (a volume): the documented fallback for an
 *   install without object storage.
 *
 * Unset, there is no blob store and bytes stay beside the catalog
 * (`packages/catalog/data/assets/`), as in development.
 *
 * Plan: `specs/postgres-backend.md` §5 (the database backend keeps this
 * interface and adds the `blob` table and GC).
 */

import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { writeFileAtomic } from './atomic-write.ts';

export interface BlobStore {
  /** a short description for logs: `s3 http://garage:3900/wirehub`, `fs /data/blobs` */
  readonly describe: string;
  get(key: string): Promise<Buffer | undefined>;
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Keys are relative, slash-separated, without `..` — they are content addresses. */
export function isBlobKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(key) && !key.includes('..');
}

function checkKey(key: string): void {
  if (!isBlobKey(key)) throw new Error(`Not a blob key: '${key}'.`);
}

/* ------------------------------------------------------------------ *
 * Filesystem
 * ------------------------------------------------------------------ */

export function fsBlobStore(dir: string): BlobStore {
  const root = resolve(dir);
  const pathOf = (key: string): string => {
    checkKey(key);
    const path = resolve(join(root, key));
    if (!path.startsWith(root + sep)) throw new Error(`Blob key escapes the store: '${key}'.`);
    return path;
  };
  return {
    describe: `fs ${root}`,
    async get(key) {
      const path = pathOf(key);
      return existsSync(path) ? readFileSync(path) : undefined;
    },
    async has(key) {
      return existsSync(pathOf(key));
    },
    async put(key, bytes) {
      const path = pathOf(key);
      if (existsSync(path)) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, bytes);
    },
    async delete(key) {
      rmSync(pathOf(key), { force: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * S3 (Signature Version 4, path-style)
 * ------------------------------------------------------------------ */

export interface S3Config {
  /** `http://garage:3900` — scheme, host and port; no bucket */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  /** the full URL of the request */
  url: URL;
  headers: Record<string, string>;
  /** hex sha256 of the body, or `UNSIGNED-PAYLOAD` */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ` */
  amzDate: string;
}

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding, as SigV4 wants it. */
function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The `Authorization` header value for a request (AWS SigV4). Pure: the
 * clock comes in as `amzDate`. Every header in `headers` is signed; `host`
 * must be among them.
 */
export function signV4(input: SignInput): string {
  const canonicalUri = input.url.pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/');
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headers = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headers.map(([k]) => k).join(';');
  const canonicalRequest = [input.method, canonicalUri, query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function amzDateOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function s3BlobStore(
  config: S3Config,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): BlobStore & { ensureBucket(): Promise<void> } {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const base = config.endpoint.replace(/\/+$/, '');

  async function request(method: string, key: string | undefined, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    if (key !== undefined) checkKey(key);
    const url = new URL(`${base}/${encodeRfc3986(config.bucket)}${key === undefined ? '' : `/${key.split('/').map(encodeRfc3986).join('/')}`}`);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const amzDate = amzDateOf(now());
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extra,
    };
    const authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      region: config.region,
      service: 's3',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      amzDate,
    });
    const { host: _host, ...sent } = headers;
    return doFetch(url, {
      method,
      headers: { ...sent, authorization },
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    });
  }

  async function fail(what: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`S3 ${what} failed: ${response.status}${code === undefined ? '' : ` ${code}`}`);
  }

  async function get(key: string): Promise<Buffer | undefined> {
    const response = await request('GET', key);
    if (response.status === 404) {
      await response.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    if (!response.ok) return fail(`GET ${key}`, response);
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    describe: `s3 ${base}/${config.bucket}`,
    get,
    async has(key) {
      const response = await request('HEAD', key);
      if (response.status === 404) return false;
      if (!response.ok) return fail(`HEAD ${key}`, response);
      return true;
    },
    async put(key, bytes, contentType) {
      const response = await request('PUT', key, bytes, { 'content-type': contentType });
      if (!response.ok) return fail(`PUT ${key}`, response);
      await response.arrayBuffer().catch(() => undefined);
      // re-read and compare: the store keeps only bytes whose name is their hash
      const back = await get(key);
      if (back === undefined || !back.equals(bytes)) throw new Error(`S3 PUT ${key}: the stored object does not match what was sent.`);
    },
    async delete(key) {
      const response = await request('DELETE', key);
      if (!response.ok && response.status !== 404) return fail(`DELETE ${key}`, response);
      await response.arrayBuffer().catch(() => undefined);
    },
    /** Create the bucket when it is missing (a no-op when it exists and is ours). */
    async ensureBucket() {
      const head = await request('HEAD', undefined);
      if (head.ok) return;
      const response = await request('PUT', undefined, Buffer.alloc(0));
      if (!response.ok && response.status !== 409) return fail(`create bucket ${config.bucket}`, response);
      await response.arrayBuffer().catch(() => undefined);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * The blob store the environment asks for, or `undefined` (bytes stay in the
 * catalog directory). Throws, with one sentence per problem, when
 * `STUDIO_BLOBS` names a store whose settings are incomplete — a hub that
 * silently fell back to local files would lose uploads on the next deploy.
 */
export function blobStoreFromEnv(env: Record<string, string | undefined>): BlobStore | undefined {
  const mode = env.STUDIO_BLOBS?.trim() ?? '';
  if (mode === '' || mode === 'catalog') return undefined;
  if (mode.startsWith('fs:')) {
    const dir = mode.slice(3);
    if (dir === '') throw new Error('STUDIO_BLOBS=fs:<dir> needs a directory.');
    return fsBlobStore(dir);
  }
  if (mode === 's3') {
    const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((name) => (env[name] ?? '') === '');
    if (missing.length > 0) throw new Error(`STUDIO_BLOBS=s3 needs ${missing.join(', ')}.`);
    return s3BlobStore({
      endpoint: env.S3_ENDPOINT ?? '',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    });
  }
  throw new Error(`STUDIO_BLOBS must be 's3', 'fs:<dir>' or unset; got '${mode}'.`);
}
