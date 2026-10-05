/**
 * The job service (`types.ts`): a store that records jobs, a runner that
 * executes them, and `executeJob` — the one place a recorded job is run,
 * whether this process or the worker runs it.
 */

import { randomUUID } from 'node:crypto';

import type { StudioUser } from '../me.ts';
import { stageImportInput } from './import.ts';
import {
  JobTimeoutError,
  type JobHandlers,
  type JobKind,
  type JobOutcome,
  type JobRequester,
  type JobRun,
  type JobRunner,
  type JobService,
  type JobStore,
  type PlanFile,
} from './types.ts';

export function requesterOf(user: StudioUser | undefined): JobRequester | undefined {
  if (user === undefined) return undefined;
  return { name: user.name, ...(user.email === undefined ? {} : { email: user.email }) };
}

export interface JobServiceOptions {
  store: JobStore;
  runner: JobRunner;
  /** the kinds it runs; a function where they follow a live module registry (runtime code modules' queues) */
  kinds: readonly JobKind[] | (() => readonly JobKind[]);
  worker?: JobService['worker'];
  /** where an uploaded input goes (`import.ts` `stageImportInput`); default inline */
  stageInput?: JobService['stageInput'];
  /** poll interval for `wait`, ms */
  pollMs?: number;
}

export function createJobService(options: JobServiceOptions): JobService {
  const { store, runner } = options;
  const pollMs = options.pollMs ?? 250;
  const kindsNow = (): readonly JobKind[] => (typeof options.kinds === 'function' ? options.kinds() : options.kinds);
  return {
    describe: runner.describe,
    get kinds() {
      return kindsNow();
    },
    async enqueue(kind, request, by, enqueueOptions) {
      if (!kindsNow().includes(kind)) throw new Error(`this studio does not run '${kind}' jobs`);
      const job = await store.create(kind, request, requesterOf(by));
      await runner.submit(job, enqueueOptions);
      return job;
    },
    get: (id) => store.get(id),
    list: (o) => store.list(o),
    files: (id) => store.files(id),
    published: (id, version) => store.published(id, version),
    async wait(id, timeoutMs) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const job = await store.get(id);
        if (job === undefined) throw new Error(`there is no job ${id}`);
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
        if (Date.now() > until) throw new JobTimeoutError(id, timeoutMs);
        await new Promise((done) => setTimeout(done, pollMs));
      }
    },
    stageInput: options.stageInput ?? (async (bytes) => ({ ...(await stageImportInput(bytes, undefined, undefined)) })),
    ...(options.worker === undefined ? {} : { worker: options.worker }),
  };
}

/**
 * Run the recorded job `id` with `handlers`: queued → running → done or
 * failed. A job that is not queued (run already, cancelled) is left alone.
 * Never throws: a handler's failure is the job's `error`.
 */
export async function executeJob(
  store: JobStore,
  handlers: JobHandlers,
  id: string,
  log: (line: string) => void = console.log,
  /** called with the finished job (done or failed), never failing it: the webhook event `job.finished` */
  onFinished?: (job: JobRun) => void | Promise<void>,
): Promise<JobRun | undefined> {
  const job = await store.start(id);
  if (job === undefined) return undefined;
  const handler = handlers[job.kind];
  const started = Date.now();
  if (handler === undefined) {
    await store.fail(id, `This process does not run '${job.kind}' jobs.`);
    return store.get(id);
  }
  try {
    const outcome: JobOutcome = await handler({ job, step: (text) => store.step(id, text) });
    await store.finish(id, outcome);
    if (outcome.quiet === true && job.request['reason'] === 'schedule' && store.discard !== undefined) {
      // a scheduled run that had nothing to do leaves no row (every five minutes would crowd the Jobs list)
      await store.discard(id);
      return undefined;
    }
    log(`[jobs] ${job.kind} ${id} done in ${Date.now() - started} ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.fail(id, message);
    log(`[jobs] ${job.kind} ${id} failed after ${Date.now() - started} ms: ${message}`);
  }
  const finished = await store.get(id);
  if (finished !== undefined && onFinished !== undefined) {
    try {
      await onFinished(finished);
    } catch (error) {
      log(`[jobs] ${job.kind} ${id}: the finished-job hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return finished;
}

/* ------------------------------------------------------------------ *
 * In memory (the file backend)
 * ------------------------------------------------------------------ */

/** Jobs kept in this process: the file backend's store. The newest `keep` are remembered. */
export function memoryJobStore(options: { keep?: number; now?: () => Date } = {}): JobStore {
  const keep = options.keep ?? 200;
  const now = (): string => (options.now ?? (() => new Date()))().toISOString();
  const jobs = new Map<string, JobRun>();
  const plans = new Map<string, PlanFile[]>();
  const clone = <T>(value: T): T => structuredClone(value);
  const trim = (): void => {
    while (jobs.size > keep) {
      const oldest = jobs.keys().next().value as string;
      jobs.delete(oldest);
      plans.delete(oldest);
    }
  };
  const patch = (id: string, fn: (job: JobRun) => void): void => {
    const job = jobs.get(id);
    if (job !== undefined) fn(job);
  };
  return {
    async create(kind, request, by) {
      const job: JobRun = { id: randomUUID(), kind, status: 'queued', request: clone(request), steps: [], createdAt: now(), ...(by === undefined ? {} : { requestedBy: by }) };
      jobs.set(job.id, job);
      trim();
      return clone(job);
    },
    async get(id) {
      const job = jobs.get(id);
      return job === undefined ? undefined : clone(job);
    },
    async list(o = {}) {
      return [...jobs.values()]
        .filter((j) => o.kind === undefined || j.kind === o.kind)
        .reverse()
        .slice(0, o.limit ?? 50)
        .map(clone);
    },
    async start(id) {
      const job = jobs.get(id);
      if (job === undefined || job.status !== 'queued') return undefined;
      job.status = 'running';
      job.startedAt = now();
      return clone(job);
    },
    async step(id, text) {
      patch(id, (j) => j.steps.push({ at: now(), text }));
    },
    async finish(id, outcome) {
      patch(id, (j) => {
        j.status = 'done';
        j.result = clone(outcome.result);
        j.finishedAt = now();
      });
      if (outcome.files !== undefined) plans.set(id, clone(outcome.files));
    },
    async fail(id, error) {
      patch(id, (j) => {
        j.status = 'failed';
        j.error = error;
        j.finishedAt = now();
      });
    },
    async files(id) {
      return clone(plans.get(id) ?? []);
    },
    async published(id, version) {
      patch(id, (j) => {
        j.publishedVersion = version;
      });
    },
    async discard(id) {
      jobs.delete(id);
      plans.delete(id);
    },
    async lastDone(kind) {
      let last: string | undefined;
      for (const j of jobs.values()) if (j.kind === kind && j.status === 'done' && j.finishedAt !== undefined && (last === undefined || j.finishedAt > last)) last = j.finishedAt;
      return last;
    },
  };
}

/**
 * Run jobs in this process, one at a time, in the order they were submitted
 * (the file backend; a database deployment with `WIREHUB_WORKER=off`).
 * `handlers` is a function so the deps it closes over can be filled later.
 */
export function inlineJobRunner(
  store: JobStore,
  handlers: () => JobHandlers,
  log?: (line: string) => void,
  onFinished?: (job: JobRun) => void | Promise<void>,
): JobRunner & { idle(): Promise<void> } {
  let queue: Promise<unknown> = Promise.resolve();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const run = (job: JobRun): void => {
    queue = queue.then(() => executeJob(store, handlers(), job.id, log, onFinished)).catch(() => undefined);
  };
  return {
    describe: 'in this process',
    async submit(job, options) {
      if (options?.delayMs === undefined || options.delayMs <= 0) return run(job);
      // a delayed job (a webhook's retry) waits on a timer that does not keep the process alive
      const timer = setTimeout(() => {
        timers.delete(timer);
        run(job);
      }, options.delayMs);
      timer.unref?.();
      timers.add(timer);
    },
    idle: async () => {
      // a job may queue another (a webhook's retry): wait until nothing is waiting or queued behind
      for (;;) {
        const seen = queue;
        await seen;
        if (seen === queue && timers.size === 0) return;
        if (timers.size > 0) await new Promise((done) => setTimeout(done, 5));
      }
    },
  };
}
