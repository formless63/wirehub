/**
 * Photo thumbnails as derived blobs (`thumbnails.ts`): `derived_blob` rows with cache
 * `thumbnail`, key = the photo's sha256, part = the size, builder = `THUMBNAIL_VERSION`.
 * Like the model cache, writing one is not catalog state: no change set, no catalog version.
 * The blob GC expires a row whose photo is no longer an asset or whose version is old (`gc.ts`).
 */

import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { BlobStore } from '../blobs.ts';
import { THUMBNAIL_VERSION, type ThumbnailCache } from '../thumbnails.ts';
import { inOrg, type Db } from './db.ts';
import { derivedObjectKey } from './keys.ts';

const SHA = /^[0-9a-f]{64}$/;

export function pgThumbnailCache(db: Db, orgId: string, blobs: BlobStore | undefined): ThumbnailCache {
  return {
    async get(asset, size) {
      if (!SHA.test(asset) || blobs === undefined) return undefined;
      const found = await inOrg(db, orgId, async (tx) => (await sql<{ object_key: string }>`
        SELECT b.object_key FROM studio.derived_blob d JOIN studio.blob b ON b.org_id = d.org_id AND b.sha256 = d.sha256
         WHERE d.cache = 'thumbnail' AND d.key = ${asset} AND d.part = ${String(size)} AND d.builder_version = ${THUMBNAIL_VERSION}`.execute(tx)).rows[0]);
      return found === undefined ? undefined : blobs.get(found.object_key);
    },
    async put(asset, size, png) {
      // no blob store: nothing to keep it in; the route draws it again next time
      if (!SHA.test(asset) || blobs === undefined) return;
      const sha = createHash('sha256').update(png).digest('hex');
      await inOrg(db, orgId, async (tx) => {
        const existing = (await sql<{ object_key: string }>`SELECT object_key FROM studio.blob WHERE sha256 = ${sha}`.execute(tx)).rows[0];
        const objectKey = existing?.object_key ?? derivedObjectKey(orgId, sha);
        if (!(await blobs.has(objectKey))) await blobs.put(objectKey, Buffer.from(png), 'image/png');
        await sql`
          INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state)
          VALUES (${orgId}::uuid, ${sha}, ${png.byteLength}, 'image/png', 'derived', ${objectKey}, 'stored')
          ON CONFLICT (org_id, sha256) DO NOTHING`.execute(tx);
        await sql`
          INSERT INTO studio.derived_blob (org_id, cache, key, part, sha256, builder_version, inputs)
          VALUES (${orgId}::uuid, 'thumbnail', ${asset}, ${String(size)}, ${sha}, ${THUMBNAIL_VERSION}, ${JSON.stringify([{ kind: 'asset', sha256: asset }])}::jsonb)
          ON CONFLICT (org_id, cache, key, part) DO UPDATE
            SET sha256 = EXCLUDED.sha256, builder_version = EXCLUDED.builder_version, inputs = EXCLUDED.inputs, built_at = now()`.execute(tx);
      });
    },
  };
}
