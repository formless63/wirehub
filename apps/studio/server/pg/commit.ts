/**
 * The Postgres commit (`specs/postgres-backend.md` §4.2; tasks B1–B4): one
 * change set, one READ COMMITTED transaction, serialised across processes by
 * the org's head row.
 *
 * 1. Before BEGIN: every byte payload of the set is put in the blob store
 *    under its content address (HEAD, else PUT and re-read; §5.2).
 * 2. BEGIN; `studio.org_id`; `SELECT … FROM catalog_head FOR UPDATE` — the
 *    writers' mutex. The snapshot at that head version (the cached one, or
 *    read in this transaction when another process moved the head).
 * 3. The set is applied to that catalog as files (`tree.ts`) by
 *    `commitChangeSet` itself: preconditions (`StaleRecordError` → 409,
 *    nothing written), every change in order, the derived tag tables — the
 *    file backend's semantics, by construction.
 * 4. The resulting tree is exploded through the codec and diffed against the
 *    rows the transaction started from; only what changed is written
 *    (entities renamed in place keep their uuid, §4.3; no no-op UPDATEs).
 *    Reference edges are rebuilt for every written record.
 * 5. One `change_set` (written first, so the audit trigger names it), its
 *    `change` rows, `catalog_head.version + 1`, `NOTIFY studio_catalog`.
 * 6. COMMIT: deferred FKs are checked here — a deleted entity something
 *    still references refuses the whole set (409).
 */

import { contentETag } from '../etag.ts';
import { commitMessage } from '../backup/commit-message.ts';
import { derivedModuleOf, entitiesOf, explode, sha256Hex, type CatalogRows, type EntityKind } from '@wirehub/catalog/src/codec/index.ts';
import { sql } from 'kysely';

import type { ModuleRegistry } from '@wirehub/modules';

import type { BlobStore } from '../blobs.ts';
import { CommitRefusedError, type ChangeSet, type CommitResult, type DerivedKind } from '../storage/change-set.ts';
import { commitChangeSet, currentValue } from '../storage/unit-of-work.ts';
import { inOrg, type Db, type Tx } from './db.ts';
import { blobObjectKey } from './keys.ts';
import { referencesOf } from './refs.ts';
import { readRows } from './rows.ts';
import { snapshotOf, type SnapshotCache } from './snapshot.ts';
import { CatalogTree, treeWorkbenchDeps } from './tree.ts';

export interface PgCommitOptions {
  db: Db;
  cache: SnapshotCache;
  blobs?: BlobStore;
  /** re-read every blob after its PUT (§5.2; `WIREHUB_BLOB_VERIFY=off` turns it off) */
  verify?: boolean;
  /** the deployment's modules: their derived records are recomputed in the commit (`module-derived.ts`) */
  modules?: ModuleRegistry;
  /** `change_set.source` */
  source?: 'studio' | 'worker' | 'script' | 'migration';
}

/** The person a change set is attributed to: a `studio.person` row, made on first sight by email. */
async function actorOf(tx: Tx, orgId: string, set: ChangeSet): Promise<{ id: string | null; label: string }> {
  const user = set.context.user;
  const label = user?.name ?? 'WireHub (local)';
  const email = user?.email?.toLowerCase();
  if (email === undefined || !email.includes('@')) return { id: null, label };
  const found = (
    await sql<{ id: string }>`
      INSERT INTO studio.person (org_id, email, name) VALUES (${orgId}::uuid, ${email}, ${label})
      ON CONFLICT (org_id, email) DO UPDATE SET name = studio.person.name
      RETURNING id::text AS id`.execute(tx)
  ).rows[0];
  return { id: found?.id ?? null, label };
}

/** Put every byte payload of the set in the blob store, before the transaction (§5.2). */
export async function uploadChangeBlobs(set: ChangeSet, orgId: string, blobs: BlobStore | undefined, verify: boolean): Promise<void> {
  const seen = new Set<string>();
  for (const change of set.changes) {
    if (change.bytes === undefined) continue;
    const sha = sha256Hex(change.bytes);
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (blobs === undefined) throw new CommitRefusedError(503, 'This studio has no blob store for uploaded files.', 'Set WIREHUB_BLOBS (s3 or fs:<dir>) and restart.');
    const key = blobObjectKey(orgId, sha);
    if (await blobs.has(key)) continue;
    await blobs.put(key, Buffer.from(change.bytes), 'application/octet-stream');
    if (verify) {
      const back = await blobs.get(key);
      if (back === undefined || sha256Hex(back) !== sha) {
        await blobs.delete(key);
        throw new CommitRefusedError(503, 'The blob store did not keep the uploaded file intact.', 'Nothing was saved. Try again; if it persists, check the blob store.');
      }
    }
  }
}

export function pgCommit(options: PgCommitOptions): (set: ChangeSet, derive: ReadonlySet<DerivedKind>) => Promise<CommitResult> {
  return async (set, derive) => {
    const { db, cache } = options;
    const orgId = cache.orgId;
    await uploadChangeBlobs(set, orgId, options.blobs, options.verify !== false);
    let committed: { version: string; rows: CatalogRows } | undefined;
    let result: CommitResult;
    try {
      result = await inOrg(
        db,
        orgId,
        async (tx) => {
          await sql`SELECT set_config('lock_timeout', '5000', true)`.execute(tx);
          const head = (await sql<{ version: string }>`SELECT version::text AS version FROM studio.catalog_head FOR UPDATE`.execute(tx)).rows[0];
          if (head === undefined) throw new Error(`org ${orgId} has no catalog head row`);
          const cached = cache.peek();
          const base = cached?.version === head.version ? cached : snapshotOf(head.version, await readRows(tx));
          const tree = CatalogTree.fromSnapshot(base);
          const deps = treeWorkbenchDeps(tree, { orgId, ...(options.blobs === undefined ? {} : { blobs: options.blobs }), ...(options.modules === undefined ? {} : { modules: options.modules }) });
          // each record's state before the set, for the history (0017): read before anything is applied
          const befores = await beforeBodies(deps, set);
          const applied = await commitChangeSet(deps, set, derive);

          const { rows, errors } = explode(tree.contents());
          if (errors.length > 0) throw new Error(`the commit produced a catalog the codec cannot read: ${errors.slice(0, 5).join('; ')}`);
          const version = String(BigInt(head.version) + 1n);
          const actor = await actorOf(tx, orgId, set);
          const changeSet = (
            await sql<{ id: string }>`
              INSERT INTO studio.change_set (org_id, catalog_version, actor_id, actor_label, source, api_token_id, method, path, message)
              VALUES (${orgId}::uuid, ${version}::bigint, ${actor.id}::uuid, ${actor.label}, ${set.context.source ?? options.source ?? 'studio'},
                      ${set.context.apiTokenId ?? null}::uuid, ${set.context.method}, ${set.context.path},
                      ${messageOf(set)})
              RETURNING id::text AS id`.execute(tx)
          ).rows[0]!.id;
          await sql`SELECT set_config('studio.change_set_id', ${changeSet}, true)`.execute(tx);

          const renames = designRenames(set);
          const touched = await writeDiff(tx, orgId, base.rows, rows, renames, actor.id, version);
          // the derived docs are computed over this version's inputs, changed or not (§4.4)
          if (applied.derived.includes('tags')) await sql`UPDATE studio.derived_doc SET inputs_version = ${version}::bigint WHERE derived_kind = 'tags'`.execute(tx);
          if (applied.derived.includes('module')) await sql`UPDATE studio.derived_doc SET inputs_version = ${version}::bigint WHERE derived_kind = 'module'`.execute(tx);
          await insertChanges(tx, changeSet, set, touched.derivedPaths, befores);
          await sql`UPDATE studio.catalog_head SET version = ${version}::bigint, updated_at = now()`.execute(tx);
          await sql`SELECT pg_notify('studio_catalog', ${JSON.stringify({ org: orgId, version, changeSet })})`.execute(tx);
          committed = { version, rows };
          return applied;
        },
        { statementTimeoutMs: 15_000 },
      );
    } catch (error) {
      throw refusal(error) ?? error;
    }
    // the next request reads the committed version without reloading it
    if (committed !== undefined) cache.prime(snapshotOf(committed.version, committed.rows));
    return result;
  };
}

/** `change_set.message`: a batch's own message, else the git export's commit message (unchanged, plan §7.6). */
function messageOf(set: ChangeSet): string {
  const body = set.context.body as { message?: unknown } | undefined;
  if (set.context.path === '/api/batch' && typeof body?.message === 'string') return body.message;
  return commitMessage({ method: set.context.method, path: set.context.path, ...(set.context.body === undefined ? {} : { body: set.context.body }) });
}

/** A database refusal, in the words a person reads (§4.2, "409s"); undefined when it is not one. */
function refusal(error: unknown): CommitRefusedError | undefined {
  const code = (error as { code?: string } | undefined)?.code;
  const detail = (error as { detail?: string } | undefined)?.detail ?? '';
  if (code === '23503') {
    return new CommitRefusedError(409, 'That record is still used by others, so it cannot be removed.', `Nothing was written. Remove the references first. (${detail})`);
  }
  if (code === '23000' || code === '23514') {
    const message = error instanceof Error ? error.message : String(error);
    if (/locked/.test(message)) return new CommitRefusedError(409, 'That saved version is locked.', `Nothing was written. Unlock it first. (${message})`);
  }
  if (code === '55P03' || code === '40001') {
    return new CommitRefusedError(503, 'Another save is in progress.', 'Nothing was written. Try again in a moment.');
  }
  return undefined;
}

/** Design renames in the set: `from → to` (the `design-versions` and `drawing` moves carry them). */
function designRenames(set: ChangeSet): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of set.changes) if (c.op === 'move' && c.to !== undefined && (c.kind === 'design-versions' || c.kind === 'drawing')) out.set(c.key, c.to);
  return out;
}

const key = (...parts: (string | number)[]): string => parts.join('\u0000');

/** The rows of `before` with every renamed design's slug replaced. */
function renamed(rows: CatalogRows, renames: ReadonlyMap<string, string>): CatalogRows {
  if (renames.size === 0) return rows;
  const d = (slug: string): string => renames.get(slug) ?? slug;
  return {
    ...rows,
    records: rows.records.map((r) => (r.kind === 'design' ? { ...r, slug: d(r.slug) } : r)),
    revisions: rows.revisions.map((r) => ({ ...r, design: d(r.design) })),
    working: rows.working.map((r) => ({ ...r, design: d(r.design) })),
    drafts: rows.drafts.map((r) => ({ ...r, design: d(r.design) })),
    artwork: rows.artwork.map((r) => ({ ...r, design: d(r.design) })),
    drawingPhotos: rows.drawingPhotos.map((r) => ({ ...r, design: d(r.design) })),
  };
}

function diffBy<T>(before: readonly T[], after: readonly T[], keyOf: (row: T) => string, same: (a: T, b: T) => boolean): { added: T[]; changed: T[]; removed: T[] } {
  const old = new Map(before.map((r) => [keyOf(r), r] as const));
  const now = new Map(after.map((r) => [keyOf(r), r] as const));
  const added: T[] = [];
  const changed: T[] = [];
  const removed: T[] = [];
  for (const [k, r] of now) {
    const was = old.get(k);
    if (was === undefined) added.push(r);
    else if (!same(was, r)) changed.push(r);
  }
  for (const [k, r] of old) if (!now.has(k)) removed.push(r);
  return { added, changed, removed };
}

const MODEL_KIND: Readonly<Record<string, EntityKind>> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire',
  pcbas: 'pcba',
  bodies: 'body',
  interfaces: 'interface',
  mechanicals: 'mechanical',
  kits: 'kit',
};

/** Write the difference between two row sets of one org. Returns the derived paths it wrote. */
async function writeDiff(
  tx: Tx,
  orgId: string,
  rawBefore: CatalogRows,
  after: CatalogRows,
  renames: ReadonlyMap<string, string>,
  actorId: string | null,
  version: string,
): Promise<{ derivedPaths: string[] }> {
  const org = orgId;
  // renames first: the entity keeps its uuid, so revisions, edges and history follow it (§4.3)
  const afterEntities = new Set(entitiesOf(after).map((e) => key(e.kind, e.slug)));
  const effective = new Map<string, string>();
  for (const [from, to] of renames) {
    const exists = rawBefore.records.some((r) => r.kind === 'design' && r.slug === to) || rawBefore.revisions.some((r) => r.design === to);
    if (exists || !afterEntities.has(key('design', to))) continue;
    await sql`UPDATE studio.entity SET slug = ${to} WHERE kind = 'design' AND slug = ${from}`.execute(tx);
    effective.set(from, to);
  }
  const before = renamed(rawBefore, effective);

  // entities
  const ids = new Map<string, string>();
  for (const row of (await sql<{ id: string; kind: string; slug: string }>`SELECT id::text AS id, kind, slug FROM studio.entity`.execute(tx)).rows) ids.set(key(row.kind, row.slug), row.id);
  const entities = diffBy(entitiesOf(before), entitiesOf(after), (e) => key(e.kind, e.slug), () => true);
  const newEntityIds: string[] = [];
  if (entities.added.length > 0) {
    const inserted = await sql<{ id: string; kind: string; slug: string }>`
      INSERT INTO studio.entity (org_id, kind, slug)
      SELECT ${org}::uuid, k, s FROM unnest(${entities.added.map((e) => e.kind)}::text[], ${entities.added.map((e) => e.slug)}::text[]) AS t(k, s)
      RETURNING id::text AS id, kind, slug`.execute(tx);
    for (const row of inserted.rows) {
      ids.set(key(row.kind, row.slug), row.id);
      newEntityIds.push(row.id);
    }
  }
  const idOf = (kind: string, slug: string): string => {
    const id = ids.get(key(kind, slug));
    if (id === undefined) throw new Error(`no entity ${kind} '${slug}'`);
    return id;
  };

  // side rows that hang off what may be deleted go first
  const photos = diffBy(before.drawingPhotos, after.drawingPhotos, (r) => r.design, (a, b) => a.sha256 === b.sha256);
  for (const r of [...photos.removed, ...photos.changed]) await sql`DELETE FROM studio.drawing_photo WHERE design_id = ${idOf('design', r.design)}::uuid`.execute(tx);
  const depictionFiles = diffBy(before.depictionFiles, after.depictionFiles, (r) => key(r.def, r.name), (a, b) => a.sha256 === b.sha256);
  for (const r of depictionFiles.removed) await sql`DELETE FROM studio.depiction_file WHERE depiction_id = ${idOf('depiction', r.def)}::uuid AND name = ${r.name}`.execute(tx);
  const artwork = diffBy(before.artwork, after.artwork, (r) => key(r.design, r.name), (a, b) => a.sha256 === b.sha256);
  for (const r of artwork.removed) await sql`DELETE FROM studio.design_artwork WHERE design_id = ${idOf('design', r.design)}::uuid AND blob_name = ${r.name}`.execute(tx);
  const files = diffBy(before.files, after.files, (r) => r.path, (a, b) => a.sha256 === b.sha256);
  for (const r of files.removed) await sql`DELETE FROM studio.catalog_file WHERE path = ${r.path}`.execute(tx);
  const links = diffBy(before.modelLinks, after.modelLinks, (r) => r.recordKey, (a, b) => a.body === b.body);
  for (const r of links.removed) await sql`DELETE FROM studio.model_link WHERE record_key = ${r.recordKey}`.execute(tx);
  const drafts = diffBy(before.drafts, after.drafts, (r) => key(r.design, r.n), (a, b) => a.body === b.body);
  for (const r of drafts.removed) await sql`DELETE FROM studio.design_draft WHERE design_id = ${idOf('design', r.design)}::uuid AND n = ${r.n}`.execute(tx);
  const working = diffBy(before.working, after.working, (r) => r.design, (a, b) => a.body === b.body);
  for (const r of working.removed) await sql`DELETE FROM studio.design_working WHERE design_id = ${idOf('design', r.design)}::uuid`.execute(tx);
  const revisions = diffBy(before.revisions, after.revisions, (r) => key(r.design, r.rev), (a, b) => a.body === b.body);
  for (const r of revisions.removed) await sql`DELETE FROM studio.design_revision WHERE design_id = ${idOf('design', r.design)}::uuid AND rev = ${r.rev}`.execute(tx);
  const records = diffBy(before.records, after.records, (r) => key(r.kind, r.slug, r.collection), (a, b) => a.body === b.body && a.ord === b.ord);
  for (const r of records.removed) {
    await sql`DELETE FROM studio.record WHERE entity_id = ${idOf(r.kind, r.slug)}::uuid AND collection = ${r.collection}`.execute(tx);
  }
  const docs = diffBy(before.docs, after.docs, (r) => r.path, (a, b) => a.body === b.body && a.mediaType === b.mediaType && JSON.stringify(a.list ?? null) === JSON.stringify(b.list ?? null));
  for (const r of docs.removed) await sql`DELETE FROM studio.catalog_doc WHERE path = ${r.path}`.execute(tx);
  const derived = diffBy(before.derived, after.derived, (r) => r.path, (a, b) => a.body === b.body && a.mediaType === b.mediaType);
  for (const r of derived.removed) await sql`DELETE FROM studio.derived_doc WHERE path = ${r.path}`.execute(tx);
  const assets = diffBy(before.assets, after.assets, (r) => r.sha256, (a, b) => a.mime === b.mime && a.originalName === b.originalName && a.src === b.src);
  for (const r of assets.removed) await sql`DELETE FROM studio.asset WHERE sha256 = ${r.sha256}`.execute(tx);

  // bytes: every blob the new rows name and the old did not (already uploaded before BEGIN)
  const knownBlobs = new Set(before.blobs.map((b) => b.sha256));
  for (const b of after.blobs) {
    if (knownBlobs.has(b.sha256)) continue;
    await sql`
      INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state)
      VALUES (${org}::uuid, ${b.sha256}, ${b.size}, ${b.mediaType}, 'record', ${blobObjectKey(org, b.sha256)}, 'stored')
      ON CONFLICT (org_id, sha256) DO UPDATE SET state = 'stored', orphaned_at = NULL`.execute(tx);
  }

  // records, and their reference edges
  const written: { id: string; kind: EntityKind; collection: string; body: string }[] = [];
  for (const r of records.added) {
    const id = (
      await sql<{ id: string }>`
        INSERT INTO studio.record (org_id, entity_id, collection, ord, body, created_by, updated_by)
        VALUES (${org}::uuid, ${idOf(r.kind, r.slug)}::uuid, ${r.collection}, ${r.ord}, ${r.body}::json, ${actorId}::uuid, ${actorId}::uuid)
        RETURNING id::text AS id`.execute(tx)
    ).rows[0]!.id;
    written.push({ id, kind: r.kind, collection: r.collection, body: r.body });
  }
  for (const r of records.changed) {
    const id = (
      await sql<{ id: string }>`
        UPDATE studio.record SET body = ${r.body}::json, ord = ${r.ord}, updated_by = ${actorId}::uuid
         WHERE entity_id = ${idOf(r.kind, r.slug)}::uuid AND collection = ${r.collection}
           AND (body::text IS DISTINCT FROM ${r.body} OR ord IS DISTINCT FROM ${r.ord})
        RETURNING id::text AS id`.execute(tx)
    ).rows[0]?.id;
    if (id !== undefined) written.push({ id, kind: r.kind, collection: r.collection, body: r.body });
  }
  for (const w of written) {
    await sql`DELETE FROM studio.ref_edge WHERE from_record = ${w.id}::uuid`.execute(tx);
    await sql`DELETE FROM studio.ref_dangling WHERE from_record = ${w.id}::uuid`.execute(tx);
    for (const ref of referencesOf(w.kind, w.collection, JSON.parse(w.body))) {
      const to = ids.get(key(ref.toKind, ref.toSlug));
      if (to === undefined) {
        await sql`INSERT INTO studio.ref_dangling (org_id, from_record, to_kind, to_slug, role) VALUES (${org}::uuid, ${w.id}::uuid, ${ref.toKind}, ${ref.toSlug}, ${ref.role}) ON CONFLICT DO NOTHING`.execute(tx);
      } else {
        await sql`INSERT INTO studio.ref_edge (org_id, from_record, to_entity, role) VALUES (${org}::uuid, ${w.id}::uuid, ${to}::uuid, ${ref.role}) ON CONFLICT DO NOTHING`.execute(tx);
      }
    }
  }
  // a dangling reference whose target now exists becomes an edge
  if (newEntityIds.length > 0) {
    await sql`
      INSERT INTO studio.ref_edge (org_id, from_record, to_entity, role)
      SELECT d.org_id, d.from_record, e.id, d.role FROM studio.ref_dangling d JOIN studio.entity e ON e.kind = d.to_kind AND e.slug = d.to_slug
       WHERE e.id = ANY(${newEntityIds}::uuid[]) ON CONFLICT DO NOTHING`.execute(tx);
    await sql`
      DELETE FROM studio.ref_dangling d USING studio.entity e
       WHERE e.kind = d.to_kind AND e.slug = d.to_slug AND e.id = ANY(${newEntityIds}::uuid[])`.execute(tx);
  }

  // documents
  for (const r of [...docs.added, ...docs.changed]) {
    await sql`
      INSERT INTO studio.catalog_doc (org_id, path, media_type, body, list_kind, list_collection, list_member, updated_by)
      VALUES (${org}::uuid, ${r.path}, ${r.mediaType}, ${r.body}, ${r.list?.kind ?? null}, ${r.list?.collection ?? null}, ${r.list?.member ?? null}, ${actorId}::uuid)
      ON CONFLICT (org_id, path) DO UPDATE SET media_type = EXCLUDED.media_type, body = EXCLUDED.body, list_kind = EXCLUDED.list_kind,
        list_collection = EXCLUDED.list_collection, list_member = EXCLUDED.list_member, updated_by = EXCLUDED.updated_by`.execute(tx);
  }
  const derivedPaths = [...derived.added, ...derived.changed, ...derived.removed].map((r) => r.path);
  for (const r of [...derived.added, ...derived.changed]) {
    await sql`
      INSERT INTO studio.derived_doc (org_id, path, derived_kind, module_id, media_type, body, inputs_version)
      VALUES (${org}::uuid, ${r.path}, ${r.derivedKind}, ${derivedModuleOf(r.path) ?? null}, ${r.mediaType}, ${r.body}, ${version}::bigint)
      ON CONFLICT (org_id, path) DO UPDATE SET media_type = EXCLUDED.media_type, body = EXCLUDED.body,
        inputs_version = EXCLUDED.inputs_version, computed_at = now()`.execute(tx);
  }

  // versions
  for (const r of revisions.added) {
    await sql`INSERT INTO studio.design_revision (org_id, design_id, rev, body, created_by, updated_by)
              VALUES (${org}::uuid, ${idOf('design', r.design)}::uuid, ${r.rev}, ${r.body}::json, ${actorId}::uuid, ${actorId}::uuid)`.execute(tx);
  }
  for (const r of revisions.changed) {
    await sql`UPDATE studio.design_revision SET body = ${r.body}::json, updated_by = ${actorId}::uuid
               WHERE design_id = ${idOf('design', r.design)}::uuid AND rev = ${r.rev} AND body::text IS DISTINCT FROM ${r.body}`.execute(tx);
  }
  for (const r of [...working.added, ...working.changed]) {
    await sql`INSERT INTO studio.design_working (org_id, design_id, body) VALUES (${org}::uuid, ${idOf('design', r.design)}::uuid, ${r.body}::json)
              ON CONFLICT (design_id) DO UPDATE SET body = EXCLUDED.body WHERE studio.design_working.body::text IS DISTINCT FROM EXCLUDED.body::text`.execute(tx);
  }
  for (const r of drafts.added) {
    await sql`INSERT INTO studio.design_draft (org_id, design_id, n, body) VALUES (${org}::uuid, ${idOf('design', r.design)}::uuid, ${r.n}, ${r.body}::json)`.execute(tx);
  }
  for (const r of drafts.changed) {
    await sql`UPDATE studio.design_draft SET body = ${r.body}::json WHERE design_id = ${idOf('design', r.design)}::uuid AND n = ${r.n}`.execute(tx);
  }

  // binary side rows
  for (const r of assets.added) {
    await sql`INSERT INTO studio.asset (org_id, sha256, mime, original_name, src, created_by) VALUES (${org}::uuid, ${r.sha256}, ${r.mime}, ${r.originalName}, ${r.src}, ${actorId}::uuid)`.execute(tx);
  }
  for (const r of assets.changed) {
    await sql`UPDATE studio.asset SET mime = ${r.mime}, original_name = ${r.originalName}, src = ${r.src} WHERE sha256 = ${r.sha256}`.execute(tx);
  }
  for (const r of [...photos.added, ...photos.changed]) {
    await sql`INSERT INTO studio.drawing_photo (org_id, design_id, asset_sha256) VALUES (${org}::uuid, ${idOf('design', r.design)}::uuid, ${r.sha256})`.execute(tx);
  }
  for (const r of [...depictionFiles.added, ...depictionFiles.changed]) {
    await sql`INSERT INTO studio.depiction_file (org_id, depiction_id, name, sha256) VALUES (${org}::uuid, ${idOf('depiction', r.def)}::uuid, ${r.name}, ${r.sha256})
              ON CONFLICT (depiction_id, name) DO UPDATE SET sha256 = EXCLUDED.sha256`.execute(tx);
  }
  for (const r of [...artwork.added, ...artwork.changed]) {
    await sql`INSERT INTO studio.design_artwork (org_id, design_id, blob_name, sha256) VALUES (${org}::uuid, ${idOf('design', r.design)}::uuid, ${r.name}, ${r.sha256})
              ON CONFLICT (design_id, blob_name) DO NOTHING`.execute(tx);
  }
  for (const r of [...files.added, ...files.changed]) {
    await sql`INSERT INTO studio.catalog_file (org_id, path, sha256) VALUES (${org}::uuid, ${r.path}, ${r.sha256})
              ON CONFLICT (org_id, path) DO UPDATE SET sha256 = EXCLUDED.sha256, updated_at = now()`.execute(tx);
  }
  for (const r of [...links.added, ...links.changed]) {
    const [plural, ...rest] = r.recordKey.split('/');
    const entity = ids.get(key(MODEL_KIND[plural ?? ''] ?? '', rest.join('/'))) ?? null;
    await sql`INSERT INTO studio.model_link (org_id, record_key, body, entity_id, updated_by) VALUES (${org}::uuid, ${r.recordKey}, ${r.body}::json, ${entity}::uuid, ${actorId}::uuid)
              ON CONFLICT (org_id, record_key) DO UPDATE SET body = EXCLUDED.body, entity_id = EXCLUDED.entity_id, updated_by = EXCLUDED.updated_by
              WHERE studio.model_link.body::text IS DISTINCT FROM EXCLUDED.body::text OR studio.model_link.entity_id IS DISTINCT FROM EXCLUDED.entity_id`.execute(tx);
  }
  // a link whose Library record appeared now points at it
  if (newEntityIds.length > 0) {
    await sql`
      UPDATE studio.model_link l SET entity_id = e.id FROM studio.entity e
       WHERE l.entity_id IS NULL AND e.id = ANY(${newEntityIds}::uuid[])
         AND l.record_key = (CASE e.kind WHEN 'body' THEN 'bodies' ELSE e.kind || 's' END) || '/' || e.slug`.execute(tx);
  }

  // entities nothing names any more — last; a reference to one fails at COMMIT (deferred FK → 409)
  for (const e of entities.removed) {
    // a model link to a removed Library record keeps its row, unlinked
    await sql`UPDATE studio.model_link SET entity_id = NULL WHERE entity_id = ${idOf(e.kind, e.slug)}::uuid`.execute(tx);
    await sql`DELETE FROM studio.entity WHERE id = ${idOf(e.kind, e.slug)}::uuid`.execute(tx);
  }
  return { derivedPaths };
}

/** Record kinds whose changes carry bytes: their "before" is not kept (the blob store has the bytes). */
const BINARY_KINDS = new Set(['drawing-photo', 'version-artwork', 'depiction-asset', 'asset', 'catalog-file']);

/**
 * `change.before_body` (0017): the state of each record the set changes, as
 * the commit read it before applying anything — JSON `null` when there was no
 * such record. Only the first change of a record in the set carries it; binary
 * records and moves carry none.
 */
async function beforeBodies(deps: Parameters<typeof currentValue>[0], set: ChangeSet): Promise<(string | null)[]> {
  const seen = new Set<string>();
  const out: (string | null)[] = [];
  for (const change of set.changes) {
    const k = `${change.kind}\u0000${change.key}`;
    if (seen.has(k) || change.op === 'move' || BINARY_KINDS.has(change.kind) || change.kind === 'design-versions') {
      out.push(null);
      continue;
    }
    seen.add(k);
    const value = await currentValue(deps, change);
    out.push(JSON.stringify(value ?? null));
  }
  return out;
}

/** One `change` row per change of the set, then one per derived file that moved. */
async function insertChanges(tx: Tx, changeSet: string, set: ChangeSet, derivedPaths: readonly string[], befores: readonly (string | null)[] = []): Promise<void> {
  const rows = set.changes.map((c, seq) => ({
    seq,
    kind: c.kind as string,
    key: c.key,
    op: c.op,
    to: c.to ?? null,
    before: c.expect ?? null,
    after: c.op !== 'put' ? null : c.bytes !== undefined ? `"sha256:${sha256Hex(c.bytes)}"` : contentETag(c.value ?? null),
    // a binary record's metadata (an asset's mime and name; the bytes are the blob after_etag names)
    body: c.op === 'put' && c.value !== undefined ? JSON.stringify(c.value) : null,
    beforeBody: befores[seq] ?? null,
  }));
  derivedPaths.forEach((path, i) => rows.push({ seq: set.changes.length + i, kind: 'derived', key: path, op: 'put', to: null, before: null, after: null, body: null, beforeBody: null }));
  if (rows.length === 0) return;
  await sql`
    INSERT INTO studio.change (change_set_id, seq, kind, key, op, to_key, before_etag, after_etag, after_body, before_body)
    SELECT ${changeSet}::bigint, s, k, y, o, t, b, a, j::json, bb::json
      FROM unnest(${rows.map((r) => r.seq)}::int[], ${rows.map((r) => r.kind)}::text[], ${rows.map((r) => r.key)}::text[], ${rows.map((r) => r.op)}::text[],
                  ${rows.map((r) => r.to)}::text[], ${rows.map((r) => r.before)}::text[], ${rows.map((r) => r.after)}::text[], ${rows.map((r) => r.body)}::text[],
                  ${rows.map((r) => r.beforeBody)}::text[]) AS x(s, k, y, o, t, b, a, j, bb)`.execute(tx);
}
