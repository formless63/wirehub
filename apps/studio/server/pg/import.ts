/**
 * The importer (`specs/postgres-backend.md` §7.2): a file catalog into an
 * empty org, in one transaction, as one change set (`source='import'`).
 *
 * 1. Explode the tree (the codec); any uncovered, malformed or non-canonical
 *    file refuses the whole import, naming every one.
 * 2. Upload the record blobs to the blob store, outside the transaction:
 *    HEAD, else PUT and re-read (§5.2). Keys are content addresses, so a
 *    retried import re-uploads nothing.
 * 3. One transaction: the head row locked, every row, the reference edges,
 *    the change set and its change rows, `catalog_head.version` = 1.
 *
 * Derived caches (converted models) are not imported; the worker builds them.
 */

import { CURRENT_SCHEMA_VERSION } from '@wirehub/model';
import { sql } from 'kysely';

import { explode, type BlobRow, type CatalogFiles, type CatalogRows } from '@wirehub/catalog/src/codec/index.ts';
import { sha256Hex } from '@wirehub/catalog/src/codec/index.ts';

import type { BlobStore } from '../blobs.ts';
import { inOrg, resolveOrgId, type Db } from './db.ts';
import { blobObjectKey } from './keys.ts';
import { insertRows, type InsertCounts } from './rows.ts';

export class ImportError extends Error {
  readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(errors.length === 0 ? message : `${message}\n  - ${errors.join('\n  - ')}`);
    this.name = 'ImportError';
    this.errors = errors;
  }
}

export interface ImportOptions {
  /** the org to import into; created when `create` and absent */
  org: { slug: string; name?: string; create?: boolean };
  files: CatalogFiles;
  /** where record blobs go; required when the catalog has any */
  blobs?: BlobStore;
  /** bytes the tree names but does not hold (an asset the file backend kept in its blob store) */
  fetchMissing?: (blob: BlobRow) => Promise<Uint8Array | undefined>;
  /** re-read every uploaded blob and compare its hash (default on; §5.2) */
  verify?: boolean;
  /** for the change set */
  actorLabel?: string;
  message?: string;
  /** explode and check only: nothing uploaded, nothing written */
  dryRun?: boolean;
  /** words for each problem the codec reports, e.g. which pack a file came from (`annotateErrors`) */
  annotate?: (errors: string[]) => string[];
}

export interface ImportReport {
  orgId: string;
  version: string;
  changeSetId: string | undefined;
  counts: InsertCounts | undefined;
  uploaded: number;
  rows: CatalogRows;
}

/** Create the org (and its head row) unless it exists. Returns its id. */
export async function ensureOrg(db: Db, slug: string, name: string, create: boolean): Promise<string> {
  const existing = await resolveOrgId(db, slug);
  if (existing !== undefined) return existing;
  if (!create) throw new ImportError(`There is no org '${slug}'. Pass --create-org to create it.`);
  const id = (await sql<{ id: string }>`SELECT uuidv7()::text AS id`.execute(db)).rows[0]!.id;
  await inOrg(db, id, async (tx) => {
    await sql`INSERT INTO studio.org (id, slug, name) VALUES (${id}::uuid, ${slug}, ${name})`.execute(tx);
    await sql`INSERT INTO studio.catalog_head (org_id, version, schema_version) VALUES (${id}::uuid, 0, ${CURRENT_SCHEMA_VERSION})`.execute(tx);
  });
  return id;
}

async function uploadBlobs(store: BlobStore, orgId: string, rows: CatalogRows, options: ImportOptions): Promise<number> {
  let uploaded = 0;
  for (const blob of rows.blobs) {
    const key = blobObjectKey(orgId, blob.sha256);
    let bytes = blob.bytes;
    if (await store.has(key)) {
      if (options.verify === false) continue;
      const stored = await store.get(key);
      if (stored !== undefined && sha256Hex(stored) === blob.sha256) continue;
      await store.delete(key);
    }
    bytes ??= await options.fetchMissing?.(blob);
    if (bytes === undefined) throw new ImportError(`Blob ${blob.sha256} is named by the catalog but its bytes are neither in the tree nor in the blob store.`);
    if (sha256Hex(bytes) !== blob.sha256) throw new ImportError(`Blob ${blob.sha256}: the bytes found do not hash to their name.`);
    await store.put(key, Buffer.from(bytes), blob.mediaType);
    if (options.verify !== false) {
      const back = await store.get(key);
      if (back === undefined || sha256Hex(back) !== blob.sha256) {
        await store.delete(key);
        throw new ImportError(`Blob ${blob.sha256}: the blob store did not return the bytes it was given.`);
      }
    }
    uploaded += 1;
  }
  return uploaded;
}

export async function importCatalog(db: Db, options: ImportOptions): Promise<ImportReport> {
  const { rows, errors } = explode(options.files);
  if (errors.length > 0) throw new ImportError(`The catalog cannot be imported as it is (${errors.length} problem${errors.length === 1 ? '' : 's'}):`, options.annotate?.(errors) ?? errors);
  if (options.dryRun === true) return { orgId: '', version: '0', changeSetId: undefined, counts: undefined, uploaded: 0, rows };

  const orgId = await ensureOrg(db, options.org.slug, options.org.name ?? options.org.slug, options.org.create === true);
  let uploaded = 0;
  if (rows.blobs.length > 0) {
    if (options.blobs === undefined) throw new ImportError(`The catalog holds ${rows.blobs.length} binary file(s); set WIREHUB_BLOBS so they have somewhere to go.`);
    uploaded = await uploadBlobs(options.blobs, orgId, rows, options);
  }

  return inOrg(
    db,
    orgId,
    async (tx) => {
      // the writers' mutex (§4.2): every commit takes the head row first
      const head = (await sql<{ version: string }>`SELECT version::text AS version FROM studio.catalog_head FOR UPDATE`.execute(tx)).rows[0];
      if (head === undefined) throw new ImportError(`Org '${options.org.slug}' has no catalog head row.`);
      const used = (await sql<{ n: string }>`SELECT (SELECT count(*) FROM studio.entity) + (SELECT count(*) FROM studio.catalog_doc) AS n`.execute(tx)).rows[0]!.n;
      if (head.version !== '0' || used !== '0') {
        throw new ImportError(`Org '${options.org.slug}' already holds a catalog (version ${head.version}); the importer loads an empty org only.`);
      }
      const version = 1;
      const changeSet = (
        await sql<{ id: string }>`
          INSERT INTO studio.change_set (org_id, catalog_version, actor_label, source, message)
          VALUES (${orgId}::uuid, ${version}, ${options.actorLabel ?? 'WireHub (import)'}, 'import', ${options.message ?? `Import the catalog (${options.files.size} files)`})
          RETURNING id::text AS id`.execute(tx)
      ).rows[0]!.id;
      await sql`SELECT set_config('studio.change_set_id', ${changeSet}, true)`.execute(tx);
      const counts = await insertRows(tx, orgId, rows, null);
      // one change row per imported file: what the import brought, without repeating the bodies
      const paths = [...options.files.keys()].filter((p) => !p.split('/').some((s) => s.startsWith('.'))).sort();
      for (let i = 0; i < paths.length; i += 2000) {
        const batch = paths.slice(i, i + 2000);
        await sql`
          INSERT INTO studio.change (change_set_id, seq, kind, key, op)
          SELECT ${changeSet}::bigint, ${i} + n::int - 1, 'doc', p, 'put' FROM unnest(${batch}::text[]) WITH ORDINALITY AS t(p, n)`.execute(tx);
      }
      await sql`UPDATE studio.catalog_head SET version = ${version}, updated_at = now()`.execute(tx);
      await sql`SELECT pg_notify('studio_catalog', ${JSON.stringify({ org: orgId, version: String(version), changeSet })})`.execute(tx);
      return { orgId, version: String(version), changeSetId: changeSet, counts, uploaded, rows };
    },
    { statementTimeoutMs: 300_000 },
  );
}
