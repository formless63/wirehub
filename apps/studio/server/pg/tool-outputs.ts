/** Tool-pack runs on Postgres (`tools/outputs.ts`; migration 0026): rows plus derived blobs. */

import { sql } from 'kysely';

import type { BlobStore } from '../blobs.ts';
import type { ToolOutputStore, ToolRunRecord } from '../tools/outputs.ts';
import { inOrg, type Db } from './db.ts';
import { derivedObjectKey } from './keys.ts';

/** The media types the blob table takes; anything else is stored as octet-stream (the run keeps the real one). */
const BLOB_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf', 'application/zip', 'model/gltf-binary', 'model/stl']);
/** runs kept per record and op */
const KEEP = 5;
const MAX_LOG = 200_000;

interface RunRow {
  id: string;
  job_id: string | null;
  record: string;
  identity: ToolRunRecord['identity'];
  sources: ToolRunRecord['sources'];
  pack: string;
  pack_version: string;
  image: string;
  image_id: string;
  tool: ToolRunRecord['tool'];
  op: string;
  params: Record<string, unknown>;
  status: 'ok' | 'failed';
  findings: ToolRunRecord['findings'];
  duration_ms: number | null;
  created_at: Date;
  outputs: ToolRunRecord['outputs'] | null;
}

const toRecord = (r: RunRow): ToolRunRecord => ({
  id: r.id,
  ...(r.job_id === null ? {} : { jobId: r.job_id }),
  record: r.record,
  identity: r.identity,
  sources: r.sources,
  pack: r.pack,
  packVersion: r.pack_version,
  image: r.image,
  imageId: r.image_id,
  tool: r.tool,
  op: r.op,
  params: r.params,
  status: r.status,
  findings: r.findings,
  outputs: r.outputs ?? [],
  ...(r.duration_ms === null ? {} : { durationMs: r.duration_ms }),
  createdAt: r.created_at.toISOString(),
});

const RUN_COLUMNS = sql`r.id::text AS id, r.job_id::text AS job_id, r.record, r.identity, r.sources, r.pack, r.pack_version, r.image, r.image_id, r.tool, r.op, r.params,
  r.status, r.findings, r.duration_ms, r.created_at,
  (SELECT jsonb_agg(jsonb_build_object('path', o.path, 'role', o.role, 'mediaType', o.media_type, 'size', o.size, 'sha256', o.sha256) ORDER BY o.path)
     FROM studio.tool_output o WHERE o.run_id = r.id) AS outputs`;

export function pgToolOutputStore(db: Db, orgId: string, blobs: BlobStore | undefined): ToolOutputStore {
  return {
    async register(run, bytes) {
      if (blobs === undefined) throw new Error('tool outputs need a blob store (WIREHUB_BLOBS)');
      // the bytes first (content-addressed, so a retry is harmless), then the rows in one transaction
      const keys = new Map<string, string>();
      for (const output of run.outputs) {
        const data = bytes.get(output.path);
        if (data === undefined) throw new Error(`no bytes for output ${output.path}`);
        const existing = await inOrg(db, orgId, async (tx) => (await sql<{ object_key: string }>`SELECT object_key FROM studio.blob WHERE sha256 = ${output.sha256}`.execute(tx)).rows[0]);
        const key = existing?.object_key ?? derivedObjectKey(orgId, output.sha256);
        if (!(await blobs.has(key))) await blobs.put(key, Buffer.from(data), output.mediaType);
        keys.set(output.sha256, key);
      }
      return inOrg(db, orgId, async (tx) => {
        for (const output of run.outputs) {
          await sql`
            INSERT INTO studio.blob (org_id, sha256, size, media_type, class, object_key, state)
            VALUES (${orgId}::uuid, ${output.sha256}, ${output.size}, ${BLOB_TYPES.has(output.mediaType) ? output.mediaType : 'application/octet-stream'}, 'derived', ${keys.get(output.sha256)!}, 'stored')
            ON CONFLICT (org_id, sha256) DO NOTHING`.execute(tx);
        }
        const row = (
          await sql<{ id: string }>`
            INSERT INTO studio.tool_run (org_id, job_id, record, identity, sources, pack, pack_version, image, image_id, tool, op, params, status, findings, log, duration_ms)
            VALUES (${orgId}::uuid, ${run.jobId ?? null}::uuid, ${run.record}, ${JSON.stringify(run.identity)}::jsonb, ${JSON.stringify(run.sources)}::jsonb, ${run.pack}, ${run.packVersion},
                    ${run.image}, ${run.imageId}, ${JSON.stringify(run.tool)}::jsonb, ${run.op}, ${JSON.stringify(run.params)}::jsonb, ${run.status}, ${JSON.stringify(run.findings)}::jsonb,
                    ${run.log.slice(-MAX_LOG)}, ${run.durationMs ?? null})
            RETURNING id::text AS id`.execute(tx)
        ).rows[0]!;
        for (const output of run.outputs) {
          await sql`
            INSERT INTO studio.tool_output (org_id, run_id, path, role, media_type, size, sha256)
            VALUES (${orgId}::uuid, ${row.id}::uuid, ${output.path}, ${output.role}, ${output.mediaType}, ${output.size}, ${output.sha256})`.execute(tx);
        }
        // keep the newest few runs of each op of a record; their blobs go with the next GC
        await sql`
          DELETE FROM studio.tool_run WHERE id IN (
            SELECT id FROM studio.tool_run WHERE record = ${run.record} AND op = ${run.op} AND pack = ${run.pack}
             ORDER BY created_at DESC, id DESC OFFSET ${KEEP})`.execute(tx);
        const saved = (await sql<RunRow>`SELECT ${RUN_COLUMNS} FROM studio.tool_run r WHERE r.id = ${row.id}::uuid`.execute(tx)).rows[0]!;
        return toRecord(saved);
      });
    },
    async runs(record, options = {}) {
      return inOrg(db, orgId, async (tx) =>
        (await sql<RunRow>`SELECT ${RUN_COLUMNS} FROM studio.tool_run r WHERE r.record = ${record} ORDER BY r.created_at DESC, r.id DESC LIMIT ${options.limit ?? 30}`.execute(tx)).rows.map(toRecord),
      );
    },
    async run(runId) {
      if (!/^[0-9a-f-]{36}$/.test(runId)) return undefined;
      return inOrg(db, orgId, async (tx) => {
        const row = (await sql<RunRow>`SELECT ${RUN_COLUMNS} FROM studio.tool_run r WHERE r.id = ${runId}::uuid`.execute(tx)).rows[0];
        return row === undefined ? undefined : toRecord(row);
      });
    },
    async log(runId) {
      if (!/^[0-9a-f-]{36}$/.test(runId)) return undefined;
      return inOrg(db, orgId, async (tx) => (await sql<{ log: string | null }>`SELECT log FROM studio.tool_run WHERE id = ${runId}::uuid`.execute(tx)).rows[0]?.log ?? undefined);
    },
    async file(sha) {
      if (blobs === undefined || !/^[0-9a-f]{64}$/.test(sha)) return undefined;
      const row = await inOrg(db, orgId, async (tx) =>
        (
          await sql<{ media_type: string; path: string; object_key: string }>`
            SELECT o.media_type, o.path, b.object_key FROM studio.tool_output o JOIN studio.blob b ON b.org_id = o.org_id AND b.sha256 = o.sha256
             WHERE o.sha256 = ${sha} ORDER BY o.run_id DESC LIMIT 1`.execute(tx)
        ).rows[0],
      );
      if (row === undefined) return undefined;
      const bytes = await blobs.get(row.object_key);
      return bytes === undefined ? undefined : { bytes: new Uint8Array(bytes), mediaType: row.media_type, filename: row.path.split('/').at(-1)! };
    },
  };
}
