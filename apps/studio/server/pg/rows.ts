/**
 * Codec rows ↔ the `studio` tables (`specs/postgres-backend.md` §3).
 *
 * `insertRows` writes a whole catalog's rows into an empty org (the import,
 * §7.2) inside the caller's transaction; `readRows` reads every row of the
 * org back — what the snapshot renders into the catalog's file map (§2).
 * Bodies are read as `body::text`: the `json` type keeps the exact text, so
 * key order (and so every ETag) survives the round trip.
 */

import { sql } from 'kysely';

import { emptyRows, entitiesOf, type CatalogRows, type EntityKind } from '@wirehub/catalog/src/codec/index.ts';

import type { Tx } from './db.ts';
import { blobObjectKey } from './keys.ts';
import { referencesOf } from './refs.ts';

const BATCH = 2000;

function chunks<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const entityKey = (kind: string, slug: string): string => `${kind}\u0000${slug}`;


export interface InsertCounts {
  entities: number;
  records: number;
  docs: number;
  derived: number;
  revisions: number;
  blobs: number;
  refEdges: number;
  refDangling: number;
  modelLinks: number;
}

/**
 * Insert every row of `rows` for `orgId`. The org must hold no catalog rows
 * yet. Blob rows are inserted as `stored`: the caller has uploaded (and
 * verified) the bytes before the transaction (§5.2).
 */
export async function insertRows(tx: Tx, orgId: string, rows: CatalogRows, actorId: string | null): Promise<InsertCounts> {
  // entities
  const entities = entitiesOf(rows);
  const ids = new Map<string, string>();
  for (const batch of chunks(entities)) {
    const result = await sql<{ id: string; kind: string; slug: string }>`
      INSERT INTO studio.entity (org_id, kind, slug)
      SELECT ${orgId}::uuid, k, s FROM unnest(${batch.map((e) => e.kind)}::text[], ${batch.map((e) => e.slug)}::text[]) AS t(k, s)
      RETURNING id, kind, slug`.execute(tx);
    for (const row of result.rows) ids.set(entityKey(row.kind, row.slug), row.id);
  }
  const idOf = (kind: EntityKind, slug: string): string => {
    const id = ids.get(entityKey(kind, slug));
    if (id === undefined) throw new Error(`no entity ${kind} '${slug}'`);
    return id;
  };

  // records, and their reference edges
  const recordIds: { id: string; kind: EntityKind; collection: string; body: string }[] = [];
  for (const batch of chunks(rows.records)) {
    const entityIds = batch.map((r) => idOf(r.kind, r.slug));
    const result = await sql<{ id: string; entity_id: string; collection: string }>`
      INSERT INTO studio.record (org_id, entity_id, collection, ord, body, created_by, updated_by)
      SELECT ${orgId}::uuid, e, c, o, b::json, ${actorId}::uuid, ${actorId}::uuid
        FROM unnest(${entityIds}::uuid[], ${batch.map((r) => r.collection)}::text[], ${batch.map((r) => r.ord)}::int[], ${batch.map((r) => r.body)}::text[]) AS t(e, c, o, b)
      RETURNING id, entity_id, collection`.execute(tx);
    // (entity, collection) is unique: match the returned ids by it, never by position
    const byKey = new Map(result.rows.map((row) => [`${row.entity_id}\u0000${row.collection}`, row.id] as const));
    batch.forEach((r, i) => {
      const id = byKey.get(`${entityIds[i]}\u0000${r.collection}`);
      if (id === undefined) throw new Error(`record ${r.kind} '${r.slug}' (${r.collection}) was not inserted`);
      recordIds.push({ id, kind: r.kind, collection: r.collection, body: r.body });
    });
  }
  const edges: { from: string; to: string; role: string }[] = [];
  const dangling: { from: string; toKind: string; toSlug: string; role: string }[] = [];
  for (const r of recordIds) {
    for (const ref of referencesOf(r.kind, r.collection, JSON.parse(r.body))) {
      const to = ids.get(entityKey(ref.toKind, ref.toSlug));
      if (to === undefined) dangling.push({ from: r.id, toKind: ref.toKind, toSlug: ref.toSlug, role: ref.role });
      else edges.push({ from: r.id, to, role: ref.role });
    }
  }
  for (const batch of chunks(edges)) {
    await sql`
      INSERT INTO studio.ref_edge (org_id, from_record, to_entity, role)
      SELECT ${orgId}::uuid, f, t, r FROM unnest(${batch.map((e) => e.from)}::uuid[], ${batch.map((e) => e.to)}::uuid[], ${batch.map((e) => e.role)}::text[]) AS x(f, t, r)`.execute(tx);
  }
  for (const batch of chunks(dangling)) {
    await sql`
      INSERT INTO studio.ref_dangling (org_id, from_record, to_kind, to_slug, role)
      SELECT ${orgId}::uuid, f, k, s, r FROM unnest(${batch.map((e) => e.from)}::uuid[], ${batch.map((e) => e.toKind)}::text[],
                                                   ${batch.map((e) => e.toSlug)}::text[], ${batch.map((e) => e.role)}::text[]) AS x(f, k, s, r)`.execute(tx);
  }

  // documents
  for (const batch of chunks(rows.docs)) {
    await sql`
      INSERT INTO studio.catalog_doc (org_id, path, media_type, body, list_kind, list_collection, list_member, updated_by)
      SELECT ${orgId}::uuid, p, m, b, lk, lc, lm, ${actorId}::uuid
        FROM unnest(${batch.map((d) => d.path)}::text[], ${batch.map((d) => d.mediaType)}::text[], ${batch.map((d) => d.body)}::text[],
                    ${batch.map((d) => d.list?.kind ?? null)}::text[], ${batch.map((d) => d.list?.collection ?? null)}::text[],
                    ${batch.map((d) => d.list?.member ?? null)}::text[]) AS t(p, m, b, lk, lc, lm)`.execute(tx);
  }
  for (const batch of chunks(rows.derived)) {
    await sql`
      INSERT INTO studio.derived_doc (org_id, path, derived_kind, media_type, body, inputs_version)
      SELECT ${orgId}::uuid, p, k, m, b, 0
        FROM unnest(${batch.map((d) => d.path)}::text[], ${batch.map((d) => d.derivedKind)}::text[], ${batch.map((d) => d.mediaType)}::text[],
                    ${batch.map((d) => d.body)}::text[]) AS t(p, k, m, b)`.execute(tx);
  }

  // saved revisions, working state, drafts
  for (const batch of chunks(rows.revisions)) {
    await sql`
      INSERT INTO studio.design_revision (org_id, design_id, rev, body, created_by, updated_by)
      SELECT ${orgId}::uuid, d, r, b::json, ${actorId}::uuid, ${actorId}::uuid
        FROM unnest(${batch.map((r) => idOf('design', r.design))}::uuid[], ${batch.map((r) => r.rev)}::int[], ${batch.map((r) => r.body)}::text[]) AS t(d, r, b)`.execute(tx);
  }
  for (const batch of chunks(rows.working)) {
    await sql`
      INSERT INTO studio.design_working (org_id, design_id, body)
      SELECT ${orgId}::uuid, d, b::json FROM unnest(${batch.map((r) => idOf('design', r.design))}::uuid[], ${batch.map((r) => r.body)}::text[]) AS t(d, b)`.execute(tx);
  }
  for (const batch of chunks(rows.drafts)) {
    await sql`
      INSERT INTO studio.design_draft (org_id, design_id, n, body)
      SELECT ${orgId}::uuid, d, n, b::json
        FROM unnest(${batch.map((r) => idOf('design', r.design))}::uuid[], ${batch.map((r) => r.n)}::int[], ${batch.map((r) => r.body)}::text[]) AS t(d, n, b)`.execute(tx);
  }

  // blobs and the rows that name them
  for (const batch of chunks(rows.blobs)) {
    await sql`
      INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state)
      SELECT ${orgId}::uuid, s, z, m, 'record', k, 'stored'
        FROM unnest(${batch.map((b) => b.sha256)}::text[], ${batch.map((b) => b.size)}::bigint[], ${batch.map((b) => b.mediaType)}::text[],
                    ${batch.map((b) => blobObjectKey(orgId, b.sha256))}::text[]) AS t(s, z, m, k)
      ON CONFLICT (org_id, sha256) DO NOTHING`.execute(tx);
  }
  for (const batch of chunks(rows.assets)) {
    await sql`
      INSERT INTO studio.asset (org_id, sha256, mime, original_name, src, created_by)
      SELECT ${orgId}::uuid, s, m, n, r, ${actorId}::uuid
        FROM unnest(${batch.map((a) => a.sha256)}::text[], ${batch.map((a) => a.mime)}::text[], ${batch.map((a) => a.originalName)}::text[],
                    ${batch.map((a) => a.src)}::text[]) AS t(s, m, n, r)`.execute(tx);
  }
  for (const batch of chunks(rows.drawingPhotos)) {
    await sql`
      INSERT INTO studio.drawing_photo (org_id, design_id, asset_sha256)
      SELECT ${orgId}::uuid, d, s FROM unnest(${batch.map((p) => idOf('design', p.design))}::uuid[], ${batch.map((p) => p.sha256)}::text[]) AS t(d, s)`.execute(tx);
  }
  for (const batch of chunks(rows.depictionFiles)) {
    await sql`
      INSERT INTO studio.depiction_file (org_id, depiction_id, name, sha256)
      SELECT ${orgId}::uuid, d, n, s
        FROM unnest(${batch.map((f) => idOf('depiction', f.def))}::uuid[], ${batch.map((f) => f.name)}::text[], ${batch.map((f) => f.sha256)}::text[]) AS t(d, n, s)`.execute(tx);
  }
  for (const batch of chunks(rows.artwork)) {
    await sql`
      INSERT INTO studio.design_artwork (org_id, design_id, blob_name, sha256)
      SELECT ${orgId}::uuid, d, n, s
        FROM unnest(${batch.map((a) => idOf('design', a.design))}::uuid[], ${batch.map((a) => a.name)}::text[], ${batch.map((a) => a.sha256)}::text[]) AS t(d, n, s)`.execute(tx);
  }
  for (const batch of chunks(rows.files)) {
    await sql`
      INSERT INTO studio.catalog_file (org_id, path, sha256)
      SELECT ${orgId}::uuid, p, s FROM unnest(${batch.map((f) => f.path)}::text[], ${batch.map((f) => f.sha256)}::text[]) AS t(p, s)`.execute(tx);
  }

  // model links, pointing at their Library record when the catalog has it
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
  for (const batch of chunks(rows.modelLinks)) {
    const entityIds = batch.map((l) => {
      const [plural, ...rest] = l.recordKey.split('/');
      return ids.get(entityKey(MODEL_KIND[plural ?? ''] ?? '', rest.join('/'))) ?? null;
    });
    await sql`
      INSERT INTO studio.model_link (org_id, record_key, body, entity_id, updated_by)
      SELECT ${orgId}::uuid, k, b::json, e, ${actorId}::uuid
        FROM unnest(${batch.map((l) => l.recordKey)}::text[], ${batch.map((l) => l.body)}::text[], ${entityIds}::uuid[]) AS t(k, b, e)`.execute(tx);
  }

  return {
    entities: entities.length,
    records: rows.records.length,
    docs: rows.docs.length,
    derived: rows.derived.length,
    revisions: rows.revisions.length,
    blobs: rows.blobs.length,
    refEdges: edges.length,
    refDangling: dangling.length,
    modelLinks: rows.modelLinks.length,
  };
}

/**
 * Every catalog row of the org, as codec rows (blob rows without bytes). Run
 * it in one REPEATABLE READ READ ONLY transaction (`inOrg(…, { snapshot: true })`)
 * so the rows are one consistent version.
 */
export async function readRows(tx: Tx): Promise<CatalogRows> {
  const rows = emptyRows();
  const records = await sql<{ kind: EntityKind; slug: string; collection: string; ord: number; body: string }>`
    SELECT e.kind, e.slug, r.collection, r.ord, r.body::text AS body
      FROM studio.record r JOIN studio.entity e ON e.id = r.entity_id`.execute(tx);
  rows.records = records.rows;
  const docs = await sql<{ path: string; media_type: string; body: string; list_kind: string | null; list_collection: string | null; list_member: string | null }>`
    SELECT path, media_type, body, list_kind, list_collection, list_member FROM studio.catalog_doc`.execute(tx);
  rows.docs = docs.rows.map((d) => ({
    path: d.path,
    mediaType: d.media_type as CatalogRows['docs'][number]['mediaType'],
    body: d.body,
    ...(d.list_kind === null ? {} : { list: { kind: d.list_kind as EntityKind, collection: d.list_collection ?? '', member: d.list_member ?? '' } }),
  }));
  const derived = await sql<{ path: string; media_type: string; body: string }>`
    SELECT path, media_type, body FROM studio.derived_doc WHERE derived_kind = 'tags'`.execute(tx);
  rows.derived = derived.rows.map((d) => ({ path: d.path, derivedKind: 'tags', mediaType: d.media_type as CatalogRows['derived'][number]['mediaType'], body: d.body }));
  rows.revisions = (
    await sql<{ design: string; rev: number; body: string }>`
      SELECT e.slug AS design, v.rev, v.body::text AS body FROM studio.design_revision v JOIN studio.entity e ON e.id = v.design_id`.execute(tx)
  ).rows;
  rows.working = (
    await sql<{ design: string; body: string }>`
      SELECT e.slug AS design, w.body::text AS body FROM studio.design_working w JOIN studio.entity e ON e.id = w.design_id`.execute(tx)
  ).rows;
  rows.drafts = (
    await sql<{ design: string; n: number; body: string }>`
      SELECT e.slug AS design, d.n, d.body::text AS body FROM studio.design_draft d JOIN studio.entity e ON e.id = d.design_id`.execute(tx)
  ).rows;
  rows.artwork = (
    await sql<{ design: string; name: string; sha256: string }>`
      SELECT e.slug AS design, a.blob_name AS name, a.sha256 FROM studio.design_artwork a JOIN studio.entity e ON e.id = a.design_id`.execute(tx)
  ).rows;
  rows.assets = (
    await sql<{ sha256: string; mime: string; originalName: string; src: string }>`
      SELECT sha256, mime, original_name AS "originalName", src FROM studio.asset`.execute(tx)
  ).rows;
  rows.drawingPhotos = (
    await sql<{ design: string; sha256: string }>`
      SELECT e.slug AS design, p.asset_sha256 AS sha256 FROM studio.drawing_photo p JOIN studio.entity e ON e.id = p.design_id`.execute(tx)
  ).rows;
  rows.depictionFiles = (
    await sql<{ def: string; name: string; sha256: string }>`
      SELECT e.slug AS def, f.name, f.sha256 FROM studio.depiction_file f JOIN studio.entity e ON e.id = f.depiction_id`.execute(tx)
  ).rows;
  rows.modelLinks = (await sql<{ recordKey: string; body: string }>`SELECT record_key AS "recordKey", body::text AS body FROM studio.model_link`.execute(tx)).rows;
  rows.files = (await sql<{ path: string; sha256: string }>`SELECT path, sha256 FROM studio.catalog_file`.execute(tx)).rows;
  rows.blobs = (
    await sql<{ sha256: string; size: string; mediaType: string }>`
      SELECT sha256, size::text AS size, media_type AS "mediaType" FROM studio.blob WHERE class = 'record'`.execute(tx)
  ).rows.map((b) => ({ sha256: b.sha256, size: Number(b.size), mediaType: b.mediaType }));
  return rows;
}
