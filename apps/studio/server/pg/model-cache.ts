/**
 * The converted-model cache as derived blobs (`specs/postgres-backend.md`
 * §3.11, §5.5; task B10). The key is the builder's own cache key, unchanged
 * from the file cache (`models/cache.ts`), so the two compare directly.
 *
 * A cache is not catalog state: writing one bumps no catalog version and
 * writes no change set. A missing entry is never an error in a request — the
 * model answers "not built yet" (`NOT_BUILT`).
 */

import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { BlobStore } from '../blobs.ts';
import { CONVERTER_VERSION, type ModelCache } from '../models/cache.ts';
import { inOrg, type Db } from './db.ts';
import { derivedObjectKey } from './keys.ts';

const KEY = /^[0-9a-f]{64}$/;

export function pgModelCache(db: Db, orgId: string, blobs: BlobStore | undefined, options: { builderVersion?: string } = {}): ModelCache {
  const builder = options.builderVersion ?? CONVERTER_VERSION;
  const row = async (key: string): Promise<{ sha256: string; object_key: string } | undefined> =>
    inOrg(db, orgId, async (tx) =>
      (
        await sql<{ sha256: string; object_key: string }>`
          SELECT d.sha256, b.object_key FROM studio.derived_blob d JOIN studio.blob b ON b.org_id = d.org_id AND b.sha256 = d.sha256
           WHERE d.cache = 'model' AND d.key = ${key} AND d.part = '' AND d.builder_version = ${builder}`.execute(tx)
      ).rows[0],
    );
  return {
    async has(key) {
      return KEY.test(key) && (await row(key)) !== undefined;
    },
    async get(key) {
      if (!KEY.test(key) || blobs === undefined) return undefined;
      const found = await row(key);
      return found === undefined ? undefined : blobs.get(found.object_key);
    },
    put: (key, glb) => putDerivedModel(db, orgId, blobs, key, glb, { builderVersion: builder }),
    async keys() {
      return inOrg(db, orgId, async (tx) =>
        (await sql<{ key: string }>`SELECT key FROM studio.derived_blob WHERE cache = 'model' AND part = '' AND builder_version = ${builder} ORDER BY key`.execute(tx)).rows.map((r) => r.key),
      );
    },
    async remove(key) {
      await inOrg(db, orgId, async (tx) => void (await sql`DELETE FROM studio.derived_blob WHERE cache = 'model' AND key = ${key}`.execute(tx)));
    },
  };
}

/** What a build records with its derived blob (§3.11): what it was built from, its triangles, the job. */
export interface DerivedModelMeta {
  builderVersion?: string;
  inputs?: unknown;
  triangles?: number;
  jobId?: string;
}

/** Store a built model under its cache key: the bytes as a derived blob, then its `derived_blob` row. */
export async function putDerivedModel(db: Db, orgId: string, blobs: BlobStore | undefined, key: string, glb: Uint8Array, meta: DerivedModelMeta = {}): Promise<void> {
  if (!KEY.test(key)) throw new Error(`'${key}' is not a model cache key`);
  if (blobs === undefined) throw new Error('the model cache needs a blob store (WIREHUB_BLOBS)');
  const builder = meta.builderVersion ?? CONVERTER_VERSION;
  const sha = createHash('sha256').update(glb).digest('hex');
  await inOrg(db, orgId, async (tx) => {
    const existing = (await sql<{ object_key: string }>`SELECT object_key FROM studio.blob WHERE sha256 = ${sha}`.execute(tx)).rows[0];
    const objectKey = existing?.object_key ?? derivedObjectKey(orgId, sha);
    if (!(await blobs.has(objectKey))) await blobs.put(objectKey, Buffer.from(glb), 'model/gltf-binary');
    await sql`
      INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state)
      VALUES (${orgId}::uuid, ${sha}, ${glb.byteLength}, 'model/gltf-binary', 'derived', ${objectKey}, 'stored')
      ON CONFLICT (org_id, sha256) DO NOTHING`.execute(tx);
    await sql`
      INSERT INTO studio.derived_blob (org_id, cache, key, part, sha256, builder_version, inputs, triangles, job_id)
      VALUES (${orgId}::uuid, 'model', ${key}, '', ${sha}, ${builder}, ${JSON.stringify(meta.inputs ?? [])}::jsonb, ${meta.triangles ?? null}, ${meta.jobId ?? null}::uuid)
      ON CONFLICT (org_id, cache, key, part) DO UPDATE
        SET sha256 = EXCLUDED.sha256, builder_version = EXCLUDED.builder_version, inputs = EXCLUDED.inputs,
            triangles = EXCLUDED.triangles, job_id = EXCLUDED.job_id, built_at = now()`.execute(tx);
  });
}
