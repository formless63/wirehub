/**
 * Jobs on Postgres (`specs/postgres-backend.md` §2, §3.12; task C1): every
 * job is a `studio.job_run` row (an import's plan is its `job_file` rows),
 * and pg-boss (schema `pgboss`, created by migration 0016) carries the job's
 * id from the studio to the worker. The studio only sends; the worker
 * (`worker.ts`) works the queues, records progress in `job_run` and beats
 * its heartbeat into `studio.worker_heartbeat` every minute.
 *
 * pg-boss runs as `studio_app`, without creating its schema (the app may not
 * create schemas); it creates its tables inside `pgboss` on first start.
 */

import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';

import type { WorkbenchDeps } from '../api.ts';
import type { BlobStore } from '../blobs.ts';
import { runDeriveJob } from '../jobs/derive.ts';
import { baseJobHandlers } from '../jobs/handlers.ts';
import { throttled, type Notifier } from '../notify.ts';
import { JOB_KINDS, type JobHandlers, type JobKind, type JobOutcome, type JobRequester, type JobRun, type JobRunner, type JobStatus, type JobStore, type PlanFile, type WorkerBeat } from '../jobs/types.ts';
import { inOrg, type Db } from './db.ts';
import { watchAudit } from './audit-watch.ts';
import { runBackupJob, runBlobGcJob } from './gc.ts';
import { putDerivedModel } from './model-cache.ts';
import type { SnapshotCache } from './snapshot.ts';

export const BOSS_SCHEMA = 'pgboss';

interface JobRow {
  id: string;
  kind: string;
  status: string;
  request: Record<string, unknown>;
  steps: { at: string; text: string }[];
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  published_version: string | null;
}

const COLUMNS = sql`j.id::text AS id, j.kind, j.status, j.request, j.steps, j.result, j.error, j.created_at, j.started_at, j.finished_at,
  (SELECT s.catalog_version::text FROM studio.change_set s WHERE s.id = j.change_set_id) AS published_version`;

function toRun(row: JobRow): JobRun {
  const { requestedBy, ...request } = row.request as Record<string, unknown> & { requestedBy?: JobRequester };
  const published = row.published_version ?? (row.result?.['publishedVersion'] as string | undefined) ?? null;
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    request,
    steps: row.steps,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
    createdAt: row.created_at.toISOString(),
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
    ...(published === null ? {} : { publishedVersion: published }),
  };
}

/** `job_run` / `job_file` as the job store (org-scoped through RLS). */
export function pgJobStore(db: Db, orgId: string): JobStore {
  const one = async (id: string): Promise<JobRun | undefined> =>
    inOrg(db, orgId, async (tx) => {
      const row = (await sql<JobRow>`SELECT ${COLUMNS} FROM studio.job_run j WHERE j.id = ${id}::uuid`.execute(tx)).rows[0];
      return row === undefined ? undefined : toRun(row);
    });
  return {
    async create(kind, request, by) {
      const body = { ...request, ...(by === undefined ? {} : { requestedBy: by }) };
      return inOrg(db, orgId, async (tx) => {
        const row = (
          await sql<JobRow>`
            INSERT INTO studio.job_run AS j (org_id, kind, status, request) VALUES (${orgId}::uuid, ${kind}, 'queued', ${JSON.stringify(body)}::jsonb)
            RETURNING ${COLUMNS}`.execute(tx)
        ).rows[0]!;
        return toRun(row);
      });
    },
    get: (id) => (/^[0-9a-f-]{36}$/.test(id) ? one(id) : Promise.resolve(undefined)),
    async list(options = {}) {
      return inOrg(db, orgId, async (tx) => {
        const rows = (
          await sql<JobRow>`
            SELECT ${COLUMNS} FROM studio.job_run j
             WHERE ${options.kind === undefined ? sql`true` : sql`j.kind = ${options.kind}`}
             ORDER BY j.created_at DESC, j.id DESC LIMIT ${options.limit ?? 50}`.execute(tx)
        ).rows;
        return rows.map(toRun);
      });
    },
    async start(id) {
      return inOrg(db, orgId, async (tx) => {
        const row = (
          await sql<JobRow>`
            UPDATE studio.job_run AS j SET status = 'running', started_at = now() WHERE j.id = ${id}::uuid AND j.status = 'queued'
            RETURNING ${COLUMNS}`.execute(tx)
        ).rows[0];
        return row === undefined ? undefined : toRun(row);
      });
    },
    async step(id, text) {
      await inOrg(db, orgId, async (tx) => {
        await sql`UPDATE studio.job_run SET steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'text', ${text}::text)) WHERE id = ${id}::uuid`.execute(tx);
      });
    },
    async finish(id, outcome: JobOutcome) {
      await inOrg(db, orgId, async (tx) => {
        await sql`UPDATE studio.job_run SET status = 'done', result = ${JSON.stringify(outcome.result)}::jsonb, finished_at = now() WHERE id = ${id}::uuid`.execute(tx);
        for (const f of outcome.files ?? []) {
          await sql`
            INSERT INTO studio.job_file (job_id, path, status, before_etag, content, sha256)
            VALUES (${id}::uuid, ${f.path}, ${f.status}, ${f.beforeEtag ?? null}, ${f.content ?? null}, ${f.sha256 ?? null})`.execute(tx);
        }
      });
    },
    async fail(id, error) {
      await inOrg(db, orgId, async (tx) => {
        await sql`UPDATE studio.job_run SET status = 'failed', error = ${error.slice(0, 4000)}, finished_at = now() WHERE id = ${id}::uuid`.execute(tx);
      });
    },
    async files(id) {
      return inOrg(db, orgId, async (tx) =>
        (
          await sql<{ path: string; status: PlanFile['status']; before_etag: string | null; content: string | null; sha256: string | null }>`
            SELECT path, status, before_etag, content, sha256 FROM studio.job_file WHERE job_id = ${id}::uuid ORDER BY path COLLATE "C"`.execute(tx)
        ).rows.map((r) => ({
          path: r.path,
          status: r.status,
          ...(r.before_etag === null ? {} : { beforeEtag: r.before_etag }),
          ...(r.content === null ? {} : { content: r.content }),
          ...(r.sha256 === null ? {} : { sha256: r.sha256 }),
        })),
      );
    },
    async published(id, version) {
      await inOrg(db, orgId, async (tx) => {
        await sql`
          UPDATE studio.job_run
             SET change_set_id = (SELECT s.id FROM studio.change_set s WHERE s.catalog_version = ${version}::bigint ORDER BY s.id DESC LIMIT 1),
                 result = coalesce(result, '{}'::jsonb) || jsonb_build_object('publishedVersion', ${version}::text)
           WHERE id = ${id}::uuid`.execute(tx);
      });
    },
    async lastDone(kind) {
      return inOrg(db, orgId, async (tx) => {
        const row = (await sql<{ at: Date | null }>`SELECT max(finished_at) AS at FROM studio.job_run WHERE kind = ${kind} AND status = 'done'`.execute(tx)).rows[0];
        return row?.at === null || row?.at === undefined ? undefined : row.at.toISOString();
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * pg-boss
 * ------------------------------------------------------------------ */

/** The payload pg-boss carries: which `job_run` row, of which org. */
export interface BossPayload {
  id?: string;
  org: string;
  /** a scheduled job has no row yet: the worker creates it */
  scheduled?: boolean;
}

/** A pg-boss instance as `studio_app`: the studio only sends; the worker also works and schedules. */
export async function startBoss(url: string, role: 'studio' | 'worker', log: (line: string) => void = console.log): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: url,
    schema: BOSS_SCHEMA,
    // the schema is migration 0016's; studio_app may create tables in it, not schemas
    createSchema: false,
    application_name: role === 'worker' ? 'wirehub-worker-boss' : 'wirehub-studio-boss',
    max: role === 'worker' ? 4 : 2,
    supervise: role === 'worker',
    schedule: role === 'worker',
  });
  boss.on('error', (error: Error) => log(`[jobs] pg-boss: ${error.message}`));
  await boss.start();
  for (const kind of JOB_KINDS) {
    if ((await boss.getQueue(kind)) === null) await boss.createQueue(kind, { retryLimit: 0, expireInSeconds: kind === 'model-cache' ? 6 * 3600 : 1800, deleteAfterSeconds: 7 * 24 * 3600 }).catch(() => undefined);
  }
  return boss;
}

/** The studio's runner on Postgres: the job's row is written; pg-boss tells the worker its id. */
export function bossJobRunner(boss: () => Promise<PgBoss>, orgId: () => string): JobRunner {
  return {
    describe: 'the worker (pg-boss)',
    async submit(job) {
      const payload: BossPayload = { id: job.id, org: orgId() };
      await (await boss()).send(job.kind, payload as unknown as object);
    },
  };
}

/** The worker's heartbeat row (§8.3): the studio's deep check fails when it is older than five minutes. */
export async function beat(db: Db, orgId: string, beat: Omit<WorkerBeat, 'beatAt'>): Promise<void> {
  await inOrg(db, orgId, async (tx) => {
    await sql`
      INSERT INTO studio.worker_heartbeat (org_id, worker, version, started_at, queues)
      VALUES (${orgId}::uuid, ${beat.worker}, ${beat.version}, ${beat.startedAt}::timestamptz, ${beat.queues}::text[])
      ON CONFLICT (org_id, worker) DO UPDATE SET version = EXCLUDED.version, started_at = EXCLUDED.started_at, queues = EXCLUDED.queues, beat_at = now()`.execute(tx);
  });
}

/** The newest heartbeat of any worker of the org. */
export async function lastBeat(db: Db, orgId: string): Promise<WorkerBeat | undefined> {
  return inOrg(db, orgId, async (tx) => {
    const row = (
      await sql<{ worker: string; version: string; started_at: Date; beat_at: Date; queues: string[] }>`
        SELECT worker, version, started_at, beat_at, queues FROM studio.worker_heartbeat ORDER BY beat_at DESC LIMIT 1`.execute(tx)
    ).rows[0];
    return row === undefined ? undefined : { worker: row.worker, version: row.version, startedAt: row.started_at.toISOString(), beatAt: row.beat_at.toISOString(), queues: row.queues };
  });
}

/* ------------------------------------------------------------------ *
 * Housekeeping (the database backend only)
 * ------------------------------------------------------------------ */

export interface HousekeepingOptions {
  deps: WorkbenchDeps;
  db: Db;
  orgId: string;
  blobs?: BlobStore;
  env?: Record<string, string | undefined>;
  notify?: Notifier;
  /** the snapshot cache the deps read through: the derive repair reloads it */
  cache?: SnapshotCache;
}

export function pgHousekeepingHandlers(options: HousekeepingOptions): JobHandlers {
  const env = options.env ?? process.env;
  const backupDir = (env.WIREHUB_BACKUP_DIR ?? '').trim() || undefined;
  const marker = (env.WIREHUB_BACKUP_MARKER ?? '').trim() || undefined;
  const { db, orgId } = options;
  // a standing failure repeats at most every six hours; an audit finding once a day
  const alerts = options.notify === undefined ? undefined : throttled(options.notify, 6 * 3_600_000);
  const auditAlerts = options.notify === undefined ? undefined : throttled(options.notify, 24 * 3_600_000);
  return {
    derive: (context) => runDeriveJob(context, options.deps, options.cache === undefined ? {} : { refresh: () => options.cache!.discard() }),
    'blob-gc': (context) =>
      runBlobGcJob(context, {
        db,
        orgId,
        ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
        ...(backupDir === undefined ? {} : { backupDir }),
        ...(marker === undefined ? {} : { backupMarker: marker }),
        ...(options.notify === undefined ? {} : { notify: options.notify }),
      }),
    // the hourly watch: the backups volume, and the audit log's unattributed writes
    backup: async (context) => {
      const outcome = await runBackupJob(context, { db, orgId, ...(backupDir === undefined ? {} : { dir: backupDir }), ...(marker === undefined ? {} : { marker }), ...(alerts === undefined ? {} : { notify: alerts }) });
      const { unattributed } = await watchAudit({ db, orgId, ...(auditAlerts === undefined ? {} : { notify: auditAlerts }) });
      await context.step(`${unattributed} unattributed audit write(s) in the last day`);
      return { ...outcome, result: { ...outcome.result, unattributed } };
    },
  };
}

/** Every handler a database deployment runs: the base's and the housekeeping. */
export function pgJobHandlers(options: HousekeepingOptions): JobHandlers {
  return {
    ...baseJobHandlers({
      deps: options.deps,
      orgId: options.orgId,
      ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.notify === undefined ? {} : { notify: options.notify }),
      putModel: (key, glb, meta) => putDerivedModel(options.db, options.orgId, options.blobs, key, glb, meta),
    }),
    ...pgHousekeepingHandlers(options),
  };
}

/** pg-boss jobs that failed in the last `hours` (the deep health check's `jobs`); 0 before pg-boss has made its tables. */
export async function failedJobCount(db: Db, hours = 24): Promise<number> {
  try {
    const row = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.id(BOSS_SCHEMA, 'job')} WHERE state = 'failed' AND completed_on > now() - make_interval(hours => ${hours})`.execute(db)).rows[0];
    return Number(row?.n ?? 0);
  } catch (error) {
    // 42P01: undefined_table — the worker has not started yet
    if ((error as { code?: string }).code === '42P01') return 0;
    throw error;
  }
}
