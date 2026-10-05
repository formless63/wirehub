#!/usr/bin/env -S node --experimental-strip-types
/**
 * The worker process (`specs/postgres-backend.md` §2, "The worker process";
 * Phase C): the same image and code as the studio, running pg-boss and
 * nothing else. `pnpm --filter studio worker`, or the compose `worker`
 * service.
 *
 * It works every queue this deployment has (`jobs/handlers.ts`,
 * `pg/jobs.ts`): module imports, a person's STEP conversion, the
 * model-cache sweep (at boot too — after a restore the cache is empty), the
 * derive repair, blob GC and the backup watch (on schedules). One job per
 * queue at a time, and one STEP conversion at a time across all of them (the
 * memory-capped child, `models/convert.ts`): the worker's memory budget (1.5
 * GiB, S6) is one conversion plus the process itself.
 *
 * It waits while the hub is in first-run setup (no organisation yet), and
 * beats its heartbeat into `studio.worker_heartbeat` every minute (and
 * touches `WIREHUB_WORKER_BEAT_FILE`, the container's health check).
 */

// first: `*_FILE` variables resolved before any other module reads the environment
import './boot-env.ts';

import { environmentRefusal } from './env-guard.ts';
import { backendFromEnv } from './pg/config.ts';
import { startWorker, type RunningWorker } from './worker-run.ts';
import { RESTART_EXIT_CODE } from './system.ts';

const fatal = (line: string): never => {
  console.error(`[worker] ${line}`);
  process.exit(1);
};

const refusal = environmentRefusal(process.env);
if (refusal !== undefined) fatal(refusal);
try {
  if (backendFromEnv(process.env) !== 'pg') fatal('The worker runs with the database backend only (WIREHUB_BACKEND=pg); the file backend runs its jobs in the studio.');
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}

let stopping = false;
let running: RunningWorker | undefined;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}: stopping (a running job finishes first, up to 30 s)`);
  await running?.stop();
  if (code === RESTART_EXIT_CODE) console.log(`[worker] exiting with code ${RESTART_EXIT_CODE} (restart requested, not a crash)`);
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  // Settings, Restart WireHub: the studio drains, and tells this process through the database
  running = await startWorker({ onRestart: () => void shutdown('restart requested', RESTART_EXIT_CODE) }, () => stopping);
  if (running === undefined) process.exit(0);
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}
