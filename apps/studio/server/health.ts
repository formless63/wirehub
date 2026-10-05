/**
 * The deep health check (`specs/postgres-backend.md` §8.3): `GET /healthz?deep=1`.
 *
 * Plain `/healthz` is the container's liveness probe and is unchanged (compose
 * relies on `ok: true` and a 200). The deep form adds a `deep` object — the
 * database answers `SELECT 1`, every migration (base and modules) is applied,
 * the blob store holds its canary object, the last backup is recent — and
 * answers `503` when any check fails, so a monitor can poll it. Check results
 * carry a fixed word and the time taken, never an error message (the
 * endpoint is unauthenticated); the reason goes to the log.
 *
 * With the worker (Phase C), the `worker` check fails when its newest
 * heartbeat is older than five minutes, and the `jobs` check when more than two
 * pg-boss jobs failed in the last 24 hours (the jobs themselves: `GET /api/jobs`).
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sql } from 'kysely';
import type { WireHubModule } from '@wirehub/modules';

import type { BlobStore } from './blobs.ts';
import { throttled, type NotifyEvent, type Notifier } from './notify.ts';
import type { Db } from './pg/db.ts';
import { pendingMigrations } from './pg/migrate.ts';
import { pendingModuleMigrations } from './pg/module-migrations.ts';

export interface HealthCheck {
  name: 'database' | 'migrations' | 'blobs' | 'backup' | 'worker' | 'jobs';
  ok: boolean;
  /** a fixed word: `ok`, `unreachable`, `pending`, `missing`, `stale` … */
  detail: string;
  ms: number;
}

export interface DeepHealth {
  ok: boolean;
  checks: HealthCheck[];
  env: string | null;
  version: string | null;
}

export interface DeepHealthOptions {
  /** the database backend; absent on files (no database / migrations checks) */
  db?: Db;
  blobs?: BlobStore;
  modules?: readonly Pick<WireHubModule, 'id' | 'migrations'>[];
  /** the file the backup's post-snapshot hook touches (`WIREHUB_BACKUP_MARKER`); absent: not checked */
  backupMarker?: string;
  /** the worker's newest heartbeat (pg with the worker); absent: not checked; undefined answer: none yet */
  worker?: () => Promise<{ beatAt: string } | undefined>;
  /** pg-boss jobs that failed in the last 24 h; the check fails above `failedJobsMax` (default 2). Absent: not checked */
  failedJobs?: () => Promise<number>;
  failedJobsMax?: number;
  /** the oldest an acceptable heartbeat is, ms (default 5 min) */
  workerMaxAgeMs?: number;
  /** the oldest an acceptable backup is, ms (default 30 h); a function reads the live setting (`WIREHUB_BACKUP_MAX_AGE_HOURS`) */
  backupMaxAgeMs?: number | (() => number);
  env?: string;
  version?: string;
  /** per-check budget, ms (default 3000) */
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const CANARY_KEY = 'health/canary';

async function timed(
  name: HealthCheck['name'],
  budgetMs: number,
  log: (line: string) => void,
  run: () => Promise<string | undefined>,
): Promise<HealthCheck> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const failure = await Promise.race([
      run(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), budgetMs);
      }),
    ]);
    return { name, ok: failure === undefined, detail: failure ?? 'ok', ms: Math.round(performance.now() - start) };
  } catch (error) {
    log(`[health] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return { name, ok: false, detail: 'unreachable', ms: Math.round(performance.now() - start) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function deepHealthCheck(options: DeepHealthOptions): () => Promise<DeepHealth> {
  const budget = options.timeoutMs ?? 3000;
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? Date.now;
  return async () => {
    const checks: Promise<HealthCheck>[] = [];
    const { db, blobs } = options;
    if (db !== undefined) {
      checks.push(timed('database', budget, log, async () => void (await sql`SELECT 1`.execute(db)) as undefined));
      checks.push(
        timed('migrations', budget, log, async () => {
          const pending = [...(await pendingMigrations(db)), ...(await pendingModuleMigrations(db, options.modules ?? []))];
          if (pending.length > 0) log(`[health] migrations pending: ${pending.join(', ')}`);
          return pending.length === 0 ? undefined : 'pending';
        }),
      );
    }
    if (blobs !== undefined) {
      checks.push(
        timed('blobs', budget, log, async () => {
          // the canary is written the first time it is missing (a fresh bucket), then only looked at
          if (!(await blobs.has(CANARY_KEY))) {
            await blobs.put(CANARY_KEY, Buffer.from('wirehub health canary\n'), 'text/plain');
            if (!(await blobs.has(CANARY_KEY))) return 'missing';
          }
          return undefined;
        }),
      );
    }
    // the compose stack always names the marker, but only the backup profile's backup-init writes
    // `.configured` beside it: no marker and no `.configured` means backups are not on, so nothing to check
    if (options.backupMarker !== undefined && (existsSync(options.backupMarker) || existsSync(join(dirname(options.backupMarker), '.configured')))) {
      const marker = options.backupMarker;
      const maxAge = (typeof options.backupMaxAgeMs === 'function' ? options.backupMaxAgeMs() : options.backupMaxAgeMs) ?? 30 * 3_600_000;
      checks.push(
        timed('backup', budget, log, async () => {
          let at: number;
          try {
            at = statSync(marker).mtimeMs;
          } catch {
            // configured, no snapshot yet: fine for the first day
            try {
              return now() - statSync(join(dirname(marker), '.configured')).mtimeMs > maxAge ? 'missing' : undefined;
            } catch {
              return 'missing';
            }
          }
          return now() - at > maxAge ? 'stale' : undefined;
        }),
      );
    }
    if (options.worker !== undefined) {
      const worker = options.worker;
      checks.push(
        timed('worker', budget, log, async () => {
          const beat = await worker();
          if (beat === undefined) return 'missing';
          return now() - Date.parse(beat.beatAt) > (options.workerMaxAgeMs ?? 5 * 60_000) ? 'stale' : undefined;
        }),
      );
    }
    if (options.failedJobs !== undefined) {
      const failedJobs = options.failedJobs;
      checks.push(
        timed('jobs', budget, log, async () => {
          const failed = await failedJobs();
          if (failed > 0) log(`[health] ${failed} job(s) failed in the last 24 h (GET /api/jobs)`);
          return failed > (options.failedJobsMax ?? 2) ? 'failing' : undefined;
        }),
      );
    }
    const done = await Promise.all(checks);
    return { ok: done.every((c) => c.ok), checks: done, env: options.env ?? null, version: options.version ?? null };
  };
}


const EVENT_FOR: Record<HealthCheck['name'], Pick<NotifyEvent, 'event' | 'severity' | 'title'>> = {
  blobs: { event: 'blob-canary-failing', severity: 'high', title: 'Blob store check failing' },
  backup: { event: 'backup-stale', severity: 'default', title: 'Backup is stale' },
  database: { event: 'database-check-failing', severity: 'high', title: 'Database check failing' },
  migrations: { event: 'migrations-pending', severity: 'high', title: 'Migrations pending' },
  jobs: { event: 'jobs-failing', severity: 'default', title: 'Background jobs failing' },
  worker: { event: 'worker-stale', severity: 'high', title: 'Worker heartbeat stale' },
};

/**
 * Run the deep check every `intervalMs` and alert on a failing check (§8.6): the blob
 * canary (high), a stale backup (default), the database or pending migrations (high).
 * Each event repeats at most every `repeatMs` (default 6 h). Returns a stop function.
 */
export function startHealthMonitor(
  check: () => Promise<DeepHealth>,
  notifier: Notifier,
  options: { intervalMs?: number; repeatMs?: number } = {},
): () => void {
  const alerts = throttled(notifier, options.repeatMs ?? 6 * 3_600_000);
  const tick = async (): Promise<void> => {
    // the webhook may be set (or unset) in Settings at any time: no checks while there is none
    if (!notifier.enabled) return;
    const result = await check();
    for (const failed of result.checks.filter((c) => !c.ok)) {
      const spec = EVENT_FOR[failed.name];
      await alerts.notify({ ...spec, message: `The ${failed.name} check reports '${failed.detail}'.`, data: { check: failed.name, detail: failed.detail } });
    }
  };
  const timer = setInterval(() => void tick().catch((error: unknown) => console.warn(`[health] monitor: ${String(error)}`)), options.intervalMs ?? 300_000);
  timer.unref();
  return () => clearInterval(timer);
}
