/**
 * Getting a pack's files onto the server's disk from what a person hands the
 * studio: an uploaded zip, a JSON bundle, or an https URL (`packs.ts`,
 * "Install pack…").
 *
 * Everything is bounded: sizes, file counts, paths, and the URL fetch (https
 * only, a size limit, a timeout, no private addresses, redirects followed one
 * by one with the same checks). Nothing is executed or evaluated; only `.json`
 * data files and the manifest are kept.
 *
 * Formats:
 * - **zip**: the pack directory zipped (`wirehub-pack.json` at the top, or inside one
 *   folder). Stored or deflated entries; no encryption, no zip64.
 * - **JSON bundle**: `{ "format": 1, "manifest": { …wirehub-pack.json… }, "files": { "connectors.json": [ … ], "vocab/signals.json": { … } } }`.
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';

export const MAX_PACK_BYTES = 8 * 1024 * 1024;
export const MAX_PACK_UNPACKED_BYTES = 24 * 1024 * 1024;
export const MAX_PACK_FILES = 300;
export const PACK_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class PackArchiveError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PackArchiveError';
    this.status = status;
  }
}

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const DATA_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.json$/;

/** A relative path a pack file may have: `.json`, no `..`, no dot-segments, not absolute. */
export function isPackFilePath(path: string): boolean {
  return DATA_PATH.test(path) && path.length <= 200 && !path.split('/').includes('..');
}

/** path → bytes, as read from an archive, before anything touches disk. */
export type PackFiles = Map<string, Uint8Array>;

/* ------------------------------------------------------------------ *
 * zip
 * ------------------------------------------------------------------ */

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

/** The data files of a zip: `.json` entries only, a single wrapping folder stripped. */
export function readZip(bytes: Uint8Array): PackFiles {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new PackArchiveError('That is not a zip file (no directory at its end).');
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new PackArchiveError('Zip64 archives are not supported.');
  if (count > MAX_PACK_FILES * 4) throw new PackArchiveError(`The zip has too many entries (${count}).`);
  const out: PackFiles = new Map();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw new PackArchiveError('The zip directory is damaged.');
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const skip = nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || !name.endsWith('.json')) continue;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some((s) => s === '..' || s.startsWith('.'))) {
      throw new PackArchiveError(`The zip holds an unsafe path: '${name}'.`);
    }
    if ((flags & 1) !== 0) throw new PackArchiveError('Encrypted zips are not supported.');
    if (compressed === 0xffffffff || size === 0xffffffff) throw new PackArchiveError('Zip64 archives are not supported.');
    total += size;
    if (size > MAX_PACK_BYTES || total > MAX_PACK_UNPACKED_BYTES) throw new PackArchiveError('The zip unpacks to more than a pack may be.', 413);
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new PackArchiveError('The zip is damaged (a file header is missing).');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new PackArchiveError(`'${name}' in the zip cannot be unpacked.`);
      }
    } else throw new PackArchiveError(`'${name}' in the zip uses a compression method this studio cannot read.`);
    if (data.length !== size) throw new PackArchiveError(`'${name}' in the zip does not match its recorded size.`);
    out.set(name, data);
  }
  return stripWrapper(out);
}

/** `pack-1.0.0/wirehub-pack.json` → `wirehub-pack.json` when every file sits in that one folder. */
function stripWrapper(files: PackFiles): PackFiles {
  if (files.has('wirehub-pack.json')) return files;
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]));
  const top = [...tops][0];
  if (tops.size !== 1 || top === undefined || !files.has(`${top}/wirehub-pack.json`)) return files;
  return new Map([...files].map(([p, b]) => [p.slice(top.length + 1), b] as const));
}

/* ------------------------------------------------------------------ *
 * JSON bundle
 * ------------------------------------------------------------------ */

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** The files of a `{ format, manifest, files }` bundle, each written canonically. */
export function readBundle(value: unknown): PackFiles {
  const bundle = value as { manifest?: unknown; files?: unknown } | null;
  if (typeof bundle !== 'object' || bundle === null || typeof bundle.manifest !== 'object' || bundle.manifest === null || typeof bundle.files !== 'object' || bundle.files === null || Array.isArray(bundle.files)) {
    throw new PackArchiveError('That is not a pack bundle.', 400);
  }
  const out: PackFiles = new Map([['wirehub-pack.json', encode(bundle.manifest)]]);
  const entries = Object.entries(bundle.files as Record<string, unknown>);
  if (entries.length > MAX_PACK_FILES) throw new PackArchiveError(`The bundle has too many files (${entries.length}).`);
  for (const [path, content] of entries) {
    if (!isPackFilePath(path) || path === 'wirehub-pack.json') throw new PackArchiveError(`'${path}' is not a path a pack file may have.`);
    out.set(path, encode(typeof content === 'string' ? (JSON.parse(content) as unknown) : content));
  }
  return out;
}

/** What a stranger handed us: zip bytes, or JSON text holding a bundle. */
export function readPackBytes(bytes: Uint8Array): { files: PackFiles; format: 'zip' | 'bundle' } {
  if (bytes.length > MAX_PACK_BYTES) throw new PackArchiveError('That pack is larger than this studio accepts.', 413);
  if (isZip(bytes)) return { files: readZip(bytes), format: 'zip' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PackArchiveError('That is neither a zip file nor a JSON pack bundle.');
  }
  return { files: readBundle(value), format: 'bundle' };
}

/** Write a pack's files under `dir` (a fresh temporary directory). */
export function writePackFiles(dir: string, files: PackFiles): void {
  for (const [path, bytes] of files) {
    if (!isPackFilePath(path)) throw new PackArchiveError(`'${path}' is not a path a pack file may have.`);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
}

/* ------------------------------------------------------------------ *
 * https fetch
 * ------------------------------------------------------------------ */

/** Private, loopback, link-local and other addresses a pack URL must never reach. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped?.[1] !== undefined && isPrivateAddress(mapped[1]);
  }
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
}

export interface FetchPackOptions {
  fetch?: typeof fetch;
  /** resolve a host to its addresses (tests inject one) */
  lookup?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
}

const defaultLookup = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((a) => a.address);

async function checkedUrl(raw: string, lookup: (host: string) => Promise<string[]>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PackArchiveError('That is not a URL.');
  }
  if (url.protocol !== 'https:') throw new PackArchiveError('Only https:// addresses are accepted.');
  if (url.username !== '' || url.password !== '') throw new PackArchiveError('A pack URL cannot carry a user name or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) !== 0 ? [host] : await lookup(host).catch(() => []);
  if (addresses.length === 0) throw new PackArchiveError(`Could not find ${host}.`, 502);
  if (addresses.some(isPrivateAddress)) throw new PackArchiveError('That address is on a private network; this studio only fetches public https addresses.');
  return url;
}

/** Download a pack from an https URL: bounded in size and time, redirects re-checked. */
export async function fetchPack(raw: string, options: FetchPackOptions = {}): Promise<Uint8Array> {
  const doFetch = options.fetch ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const max = options.maxBytes ?? MAX_PACK_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? PACK_FETCH_TIMEOUT_MS);
  let url = await checkedUrl(raw, lookup);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(url, { redirect: 'manual', signal, headers: { accept: 'application/zip, application/json' } });
    } catch (error) {
      const timedOut = signal.aborted;
      throw new PackArchiveError(timedOut ? 'The download took too long.' : `The download failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (next === null || hop >= MAX_REDIRECTS) throw new PackArchiveError('Too many redirects.', 502);
      url = await checkedUrl(new URL(next, url).href, lookup);
      continue;
    }
    if (!response.ok) throw new PackArchiveError(`The server answered ${response.status}.`, 502);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new PackArchiveError('That pack is larger than this studio accepts.', 413);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      if (reader === undefined) throw new PackArchiveError('The download had no content.', 502);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new PackArchiveError('That pack is larger than this studio accepts.', 413);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof PackArchiveError) throw error;
      throw new PackArchiveError(signal.aborted ? 'The download took too long.' : 'The download was interrupted.', 502);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}
