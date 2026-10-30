/**
 * Released document renders, kept by render key (`docs/document-manifest.md`).
 *
 * A saved revision's documents and exports, rendered with default options, are
 * stored the first time they are made and served from here afterwards, so the
 * bytes a download returns (and their SHA-256) never move under a released
 * revision: a later save, a live library edit or a newer hub leaves them alone.
 * The key (`renderKey`, `document-manifest.ts`) names everything the render is
 * allowed to depend on; first render wins.
 *
 * - files: `packages/catalog/data/.document-cache/<aa>/<key>.json` (meta) and
 *   `<key>.bin` (bytes), gitignored, like `.model-cache`;
 * - Postgres: a derived blob (`pg/document-cache.ts`: `derived_blob`, cache
 *   `document`, key = the render key), kept until `DOCUMENT_CACHE_VERSION` changes;
 * - memory: tests.
 *
 * Derived data: never in `GET /api/export`, never backed up. Bump
 * `DOCUMENT_CACHE_VERSION` on purpose to render every revision again.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';

import { writeFileAtomic } from './atomic-write.ts';
import type { Awaitable } from './storage/change-set.ts';

/** Part of every render key: bump it to render every saved revision again (pg: the old rows expire). */
export const DOCUMENT_CACHE_VERSION = 'document-cache-1';

/** One stored render. */
export interface CachedDocument {
  bytes: Uint8Array;
  /** hex SHA-256 of `bytes` */
  sha256: string;
  mediaType: string;
  fileName: string;
  /** how a PDF was made (`X-WireHub-PDF-Renderer`) */
  renderer?: string;
  /** why the browser engine was not used (`X-WireHub-PDF-Fallback`) */
  fallback?: string;
  /** ISO time it was rendered */
  renderedAt: string;
}

/** What a stored render was made from: the design revision (pg: `derived_blob.inputs`). */
export interface DocumentRef {
  design: string;
  rev: number;
}

export interface DocumentCache {
  get(key: string): Awaitable<CachedDocument | undefined>;
  /** Store `doc` under `key` unless something is stored there already; returns what is stored (a racing first writer wins). */
  putIfAbsent(key: string, doc: CachedDocument, ref: DocumentRef): Awaitable<CachedDocument>;
}

const KEY = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface StoredMeta {
  sha256: string;
  mediaType: string;
  fileName: string;
  renderer?: string;
  fallback?: string;
  renderedAt: string;
  design: string;
  rev: number;
  cache: string;
}

/** The file backend's cache: `<dir>/<aa>/<key>.json` + `.bin`. Synchronous reads and writes, so one process never interleaves two writers of a key. */
export function fileDocumentCache(dir = dataPath('.document-cache')): DocumentCache {
  const paths = (key: string): { json: string; bin: string; folder: string } => {
    if (!KEY.test(key)) throw new Error(`'${key}' is not a render key`);
    const folder = join(dir, key.slice(0, 2));
    return { json: join(folder, `${key}.json`), bin: join(folder, `${key}.bin`), folder };
  };
  const read = (key: string): CachedDocument | undefined => {
    if (!KEY.test(key)) return undefined;
    const { json, bin } = paths(key);
    if (!existsSync(json) || !existsSync(bin)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(json, 'utf8')) as StoredMeta;
      const bytes = new Uint8Array(readFileSync(bin));
      // a torn or foreign pair is a miss: it is rendered again and replaced
      if (meta.cache !== DOCUMENT_CACHE_VERSION || sha256Hex(bytes) !== meta.sha256) return undefined;
      return {
        bytes,
        sha256: meta.sha256,
        mediaType: meta.mediaType,
        fileName: meta.fileName,
        ...(meta.renderer === undefined ? {} : { renderer: meta.renderer }),
        ...(meta.fallback === undefined ? {} : { fallback: meta.fallback }),
        renderedAt: meta.renderedAt,
      };
    } catch {
      return undefined;
    }
  };
  return {
    get: read,
    putIfAbsent(key, doc, ref) {
      const stored = read(key);
      if (stored !== undefined) return stored;
      const { json, bin, folder } = paths(key);
      mkdirSync(folder, { recursive: true });
      // bytes first, then the meta naming their hash: a reader never sees meta without its bytes
      writeFileAtomic(bin, doc.bytes);
      const meta: StoredMeta = {
        sha256: doc.sha256,
        mediaType: doc.mediaType,
        fileName: doc.fileName,
        ...(doc.renderer === undefined ? {} : { renderer: doc.renderer }),
        ...(doc.fallback === undefined ? {} : { fallback: doc.fallback }),
        renderedAt: doc.renderedAt,
        design: ref.design,
        rev: ref.rev,
        cache: DOCUMENT_CACHE_VERSION,
      };
      writeFileAtomic(json, `${JSON.stringify(meta, null, 2)}\n`);
      return doc;
    },
  };
}

/** In memory (tests): `puts` counts the renders that were stored. */
export function memoryDocumentCache(): DocumentCache & { docs: Map<string, CachedDocument>; puts: number } {
  const docs = new Map<string, CachedDocument>();
  const cache = {
    docs,
    puts: 0,
    get: (key: string) => docs.get(key),
    putIfAbsent(key: string, doc: CachedDocument) {
      const stored = docs.get(key);
      if (stored !== undefined) return stored;
      docs.set(key, doc);
      cache.puts += 1;
      return doc;
    },
  };
  return cache;
}
