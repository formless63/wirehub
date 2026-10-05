/**
 * The worker, as a function (`worker.ts` is the process around it): open the
 * database, wait for an organisation, work every queue, schedule the
 * housekeeping, beat the heartbeat, run the boot sweep. Tests start it in
 * process with their own modules.
 */

import { closeSync, openSync, utimesSync } from 'node:fs';
import { hostname } from 'node:os';

import { sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { ModuleRegistry } from '@wirehub/modules';

import { blobStoreFromEnv, type BlobStore } from './blobs.ts';
import { notifierFromEnv } from './notify.ts';
import { createJobService, executeJob } from './jobs/service.ts';
import { moduleJobKinds, moduleSchedules } from './jobs/module-queues.ts';
import type { JobKind, JobService } from './jobs/types.ts';
import { pgAppConfigFromEnv, redactUrl } from './pg/config.ts';
import { openPg, resolveOrgId, type PgHandle } from './pg/db.ts';
import { checkDatabase, pgWorkbenchDeps } from './pg/deps.ts';
import { beat, bossJobRunner, BOSS_SCHEMA, lastBeat, pgJobHandlers, pgJobStore, startBoss, type BossPayload } from './pg/jobs.ts';
import { SnapshotCache } from './pg/snapshot.ts';

export interface WorkerOptions {
  env?: Record<string, string | undefined>;
  /** the deployment's modules (default: `modules.config.ts`) */
  modules?: ModuleRegistry;
  blobs?: BlobStore;
  log?: (line: string) => void;
  /** retries while the database or the blob store is still starting (default 30, 2 s apart) */
  attempts?: number;
}

export interface RunningWorker {
  orgId: string;
  kinds: readonly JobKind[];
  jobs: JobService;
  handle: PgHandle;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Start the worker; resolves once it works its queues (after first-run setup, if the hub is in it). `undefined` when stopped while waiting. */
export async function startWorker(options: WorkerOptions = {}, stopping: () => boolean = () => false): Promise<RunningWorker | undefined> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(`[worker] ${line}`));
  const attempts = options.attempts ?? 30;
  const beatFile = env.WIREHUB_WORKER_BEAT_FILE ?? '/tmp/wirehub-worker.beat';
  const touchBeat = (): void => {
    try {
      const now = new Date();
      closeSync(openSync(beatFile, 'a'));
      utimesSync(beatFile, now, now);
    } catch {
      // a read-only /tmp only costs the container health check
    }
  };

  const blobs = options.blobs ?? blobStoreFromEnv(env);
  if (blobs !== undefined && 'ensureBucket' in blobs && typeof blobs.ensureBucket === 'function') {
    const ensure = blobs.ensureBucket as () => Promise<void>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ensure();
        break;
      } catch (error) {
        if (attempt >= attempts) throw new Error(`${blobs.describe}: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(2000);
      }
    }
  }

  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { max: 4, applicationName: 'wirehub-worker' });
  let boss: PgBoss | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;
  const stop = async (): Promise<void> => {
    if (beatTimer !== undefined) clearInterval(beatTimer);
    await boss?.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
    await handle.close().catch(() => undefined);
  };
  try {
    // the schema is current (migrate ran first), and there is an organisation to work for
    for (let attempt = 1; ; attempt += 1) {
      try {
        await checkDatabase(handle.db, undefined);
        break;
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(2000);
      }
    }
    let orgId = await resolveOrgId(handle.db, config.org);
    if (orgId === undefined) log(`${redactUrl(config.url)} has no organisation yet: waiting for first-run setup (/setup)`);
    while (orgId === undefined && !stopping()) {
      touchBeat();
      await sleep(5000);
      orgId = await resolveOrgId(handle.db, config.org);
    }
    if (orgId === undefined) {
      await stop();
      return undefined;
    }
    await checkDatabase(handle.db, orgId);
    const org = orgId;

    const cache = new SnapshotCache(handle.db, org);
    const deps = pgWorkbenchDeps({ cache, db: handle.db, ...(blobs === undefined ? {} : { blobs }), ...(options.modules === undefined ? {} : { modules: options.modules }) });
    const store = pgJobStore(handle.db, org);
    const notify = notifierFromEnv(env);
    const handlers = pgJobHandlers({ deps, db: handle.db, orgId: org, cache, ...(blobs === undefined ? {} : { blobs }), env, notify });
    const kinds = Object.keys(handlers) as JobKind[];

    // pg_dump runs as studio_ro: it must read the queue tables this role creates (0016)
    await sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${BOSS_SCHEMA} GRANT SELECT ON TABLES TO studio_ro`).execute(handle.db);
    await sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${BOSS_SCHEMA} GRANT SELECT ON SEQUENCES TO studio_ro`).execute(handle.db);
    boss = await startBoss(config.url, 'worker', log, moduleJobKinds(deps.modules));
    await sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA ${BOSS_SCHEMA} TO studio_ro`).execute(handle.db);
    await sql.raw(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${BOSS_SCHEMA} TO studio_ro`).execute(handle.db);
    const started = boss;
    const jobs = createJobService({ store, runner: bossJobRunner(async () => started, () => org), kinds, worker: () => lastBeat(handle.db, org) });

    const afterJob = (line: string): void => log(`${line} (worker rss ${Math.round(process.memoryUsage().rss / 1048576)} MiB)`);
    for (const kind of kinds) {
      await boss.work<BossPayload>(kind, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: kind === 'convert' || kind === 'import' ? 1 : 5 }, async ([job]) => {
        if (job === undefined) return;
        const payload = job.data;
        if (payload.org !== org) {
          log(`skipped a ${kind} job for another organisation (${payload.org})`);
          return;
        }
        // a scheduled run has no row yet
        const id = payload.id ?? (await store.create(kind, { reason: 'schedule' })).id;
        await executeJob(store, handlers, id, afterJob);
      });
    }

    // schedules (container time; TZ sets it)
    const tz = env.TZ ?? 'UTC';
    const scheduled: { kind: JobKind; cron: string }[] = [
      { kind: 'backup', cron: env.WIREHUB_BACKUP_WATCH_CRON ?? '15 * * * *' },
      { kind: 'derive', cron: env.WIREHUB_DERIVE_CRON ?? '0 4 * * *' },
      { kind: 'blob-gc', cron: env.WIREHUB_GC_CRON ?? '30 4 * * *' },
    ];
    const window = /^\s*(\d{1,2}):(\d{2})\s*-/.exec(env.WIREHUB_CONVERT_WINDOW ?? '');
    if (window !== null) scheduled.push({ kind: 'model-cache', cron: `${Number(window[2])} ${Number(window[1])} * * *` });
    // a module queue's own schedule
    scheduled.push(...moduleSchedules(deps.modules));
    for (const s of scheduled) {
      if (!kinds.includes(s.kind)) continue;
      const payload: BossPayload = { org, scheduled: true };
      await boss.schedule(s.kind, s.cron, payload as unknown as object, { tz });
    }

    // the heartbeat
    const me = { worker: hostname(), version: env.WIREHUB_VERSION ?? 'dev', startedAt: new Date().toISOString(), queues: kinds };
    const doBeat = async (): Promise<void> => {
      touchBeat();
      await beat(handle.db, org, me).catch((error: unknown) => log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    await doBeat();
    beatTimer = setInterval(() => void doBeat(), 60_000);
    beatTimer.unref?.();

    // the boot sweep: every live model key built, the derived records sound, the backups looked at
    for (const kind of ['model-cache', 'derive', 'backup'] as const) {
      if (kinds.includes(kind)) await jobs.enqueue(kind, { reason: 'boot' });
    }
    log(`working ${kinds.join(', ')} for org ${org}; blobs ${blobs?.describe ?? 'none'}; schedules ${scheduled.map((s) => `${s.kind} "${s.cron}"`).join(', ')} (${tz})`);
    return { orgId: org, kinds, jobs, handle, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
