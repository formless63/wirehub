/**
 * Released document renders as derived blobs (`document-cache.ts`): `derived_blob` rows with
 * cache `document`, key = the render key, part `''`, builder = `DOCUMENT_CACHE_VERSION`, inputs
 * `[{kind:'design-revision', ref:'<id>@<rev>'}, {kind:'meta', mediaType, fileName, renderer?, fallback?, renderedAt}]`.
 * Writing one is not catalog state: no change set, no catalog version. The row is inserted only
 * when the key is free, so the first render stored wins a race; the blob GC keeps rows until
 * `DOCUMENT_CACHE_VERSION` changes (`gc.ts`). Derived blobs are not backed up.
 */

import { sql } from 'kysely';

import type { BlobStore } from '../blobs.ts';
import { DOCUMENT_CACHE_VERSION, sha256Hex, type CachedDocument, type DocumentCache } from '../document-cache.ts';
import { inOrg, type Db } from './db.ts';
import { derivedObjectKey } from './keys.ts';

/** media types the blob table's CHECK allows (migration 0031); others are stored as octet-stream */
const BLOB_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf', 'application/zip', 'model/gltf-binary', 'model/stl', 'model/step', 'model/3mf', 'font/ttf', 'font/otf', 'font/woff2', 'application/octet-stream']);

const KEY = /^[0-9a-f]{64}$/;

interface MetaInput {
  kind: 'meta';
  mediaType: string;
  fileName: string;
  renderer?: string;
  fallback?: string;
  renderedAt: string;
}

function metaOf(inputs: unknown): MetaInput | undefined {
  if (!Array.isArray(inputs)) return undefined;
  const found = inputs.find((i) => typeof i === 'object' && i !== null && (i as { kind?: unknown }).kind === 'meta') as MetaInput | undefined;
  return found !== undefined && typeof found.mediaType === 'string' && typeof found.fileName === 'string' ? found : undefined;
}

export function pgDocumentCache(db: Db, orgId: string, blobs: BlobStore): DocumentCache {
  async function read(key: string): Promise<CachedDocument | undefined> {
    if (!KEY.test(key)) return undefined;
    const row = await inOrg(db, orgId, async (tx) => (await sql<{ sha256: string; inputs: unknown; object_key: string }>`
      SELECT d.sha256, d.inputs, b.object_key FROM studio.derived_blob d JOIN studio.blob b ON b.org_id = d.org_id AND b.sha256 = d.sha256
       WHERE d.cache = 'document' AND d.key = ${key} AND d.part = '' AND d.builder_version = ${DOCUMENT_CACHE_VERSION}`.execute(tx)).rows[0]);
    if (row === undefined) return undefined;
    const meta = metaOf(row.inputs);
    const bytes = await blobs.get(row.object_key);
    if (meta === undefined || bytes === undefined) return undefined;
    const body = new Uint8Array(bytes);
    if (sha256Hex(body) !== row.sha256) return undefined;
    return {
      bytes: body,
      sha256: row.sha256,
      mediaType: meta.mediaType,
      fileName: meta.fileName,
      ...(meta.renderer === undefined ? {} : { renderer: meta.renderer }),
      ...(meta.fallback === undefined ? {} : { fallback: meta.fallback }),
      renderedAt: meta.renderedAt,
    };
  }
  return {
    get: read,
    async putIfAbsent(key, doc, ref) {
      if (!KEY.test(key)) throw new Error(`'${key}' is not a render key`);
      const stored = await read(key);
      if (stored !== undefined) return stored;
      const inputs = [
        { kind: 'design-revision', ref: `${ref.design}@${ref.rev}` },
        { kind: 'meta', mediaType: doc.mediaType, fileName: doc.fileName, ...(doc.renderer === undefined ? {} : { renderer: doc.renderer }), ...(doc.fallback === undefined ? {} : { fallback: doc.fallback }), renderedAt: doc.renderedAt },
      ];
      await inOrg(db, orgId, async (tx) => {
        const existing = (await sql<{ object_key: string }>`SELECT object_key FROM studio.blob WHERE sha256 = ${doc.sha256}`.execute(tx)).rows[0];
        const objectKey = existing?.object_key ?? derivedObjectKey(orgId, doc.sha256);
        const blobType = BLOB_MEDIA_TYPES.has(doc.mediaType) ? doc.mediaType : 'application/octet-stream'; // the real type is in the meta input
        if (!(await blobs.has(objectKey))) await blobs.put(objectKey, Buffer.from(doc.bytes), blobType);
        await sql`
          INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state)
          VALUES (${orgId}::uuid, ${doc.sha256}, ${doc.bytes.byteLength}, ${blobType}, 'derived', ${objectKey}, 'stored')
          ON CONFLICT (org_id, sha256) DO NOTHING`.execute(tx);
        // first render wins: a row already there (a racing writer, or an old version's) is left alone
        await sql`
          INSERT INTO studio.derived_blob (org_id, cache, key, part, sha256, builder_version, inputs)
          VALUES (${orgId}::uuid, 'document', ${key}, '', ${doc.sha256}, ${DOCUMENT_CACHE_VERSION}, ${JSON.stringify(inputs)}::jsonb)
          ON CONFLICT (org_id, cache, key, part) DO NOTHING`.execute(tx);
      });
      // what is stored now: this render, or the one that got there first
      return (await read(key)) ?? doc;
    },
  };
}
