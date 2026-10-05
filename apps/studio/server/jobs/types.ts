/**
 * Jobs (`specs/postgres-backend.md` §2, "The worker process"; Phase C): work
 * that takes longer than a request should, or that runs on a schedule.
 *
 * One shape on every backend. A job is a `JobRun` record (who asked for what,
 * its steps, its result) kept by a `JobStore`, and is executed by a
 * `JobRunner`:
 *
 * - the file backend (and a database deployment with `WIREHUB_WORKER=off`)
 *   runs jobs **in this process**, one at a time (`inline.ts`), and keeps the
 *   records in memory (files) or in `studio.job_run` (pg);
 * - the database backend hands them to the **worker process** through
 *   pg-boss (`pg/jobs.ts`, `worker.ts`), which records them in `job_run`.
 *
 * Handlers (`handlers.ts`) are the same code either way: they get the
 * workbench deps, read through the stores and stage writes in a unit of work
 * like any request.
 */

import type { StudioUser } from '../me.ts';
import type { Awaitable, RecordChange } from '../storage/change-set.ts';

/** The base's queues (§2). A module's queue is `<module>:<queue>`. */
export const JOB_KINDS = ['import', 'convert', 'model-cache', 'derive', 'blob-gc', 'backup', 'git-mirror', 'webhook'] as const;
export type BaseJobKind = (typeof JOB_KINDS)[number];
/** A queue a module registered (`@wirehub/modules` `JobQueueContribution`): `<module id>:<queue id>`. */
export type ModuleJobKind = `${string}:${string}`;
export type JobKind = BaseJobKind | ModuleJobKind;

export function isBaseJobKind(value: unknown): value is BaseJobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

const MODULE_KIND = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isModuleJobKind(value: unknown): value is ModuleJobKind {
  return typeof value === 'string' && MODULE_KIND.test(value);
}

export function isJobKind(value: unknown): value is JobKind {
  return isBaseJobKind(value) || isModuleJobKind(value);
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobStep {
  at: string;
  text: string;
}

/** Who asked, as the change set would name them. */
export interface JobRequester {
  name: string;
  email?: string;
}

export interface JobRun {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** what was asked for (an import's file, a sweep's reason) */
  request: Record<string, unknown>;
  steps: JobStep[];
  /** a summary; an import's plan files are `JobStore.files` */
  result?: Record<string, unknown>;
  error?: string;
  requestedBy?: JobRequester;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** an import that was published: the catalog version its change set made */
  publishedVersion?: string;
}

/** One file of an import's plan (`job_file`, §3.12): its new text and what it replaces. */
export interface PlanFile {
  path: string;
  status: 'new' | 'changed' | 'unchanged';
  /** sha256 of the text it replaces */
  beforeEtag?: string;
  content?: string;
  sha256?: string;
}

/** What a handler hands back. */
export interface JobOutcome {
  result: Record<string, unknown>;
  /** a scheduled run that found nothing to do: its record is dropped rather than crowding the Jobs list (cs-5k1.26) */
  quiet?: boolean;
  /** an import's plan */
  files?: PlanFile[];
}

export interface JobStore {
  create(kind: JobKind, request: Record<string, unknown>, by?: JobRequester): Promise<JobRun>;
  get(id: string): Promise<JobRun | undefined>;
  /** newest first */
  list(options?: { kind?: JobKind; limit?: number }): Promise<JobRun[]>;
  /** queued → running; `undefined` when the job is not queued (already run, cancelled, unknown) */
  start(id: string): Promise<JobRun | undefined>;
  step(id: string, text: string): Promise<void>;
  finish(id: string, outcome: JobOutcome): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  files(id: string): Promise<PlanFile[]>;
  /** an import's plan, committed: record the catalog version (and the change set) it made */
  published(id: string, version: string): Promise<void>;
  /** forget a job (a quiet scheduled run); optional so a store may keep everything */
  discard?(id: string): Promise<void>;
  /** the time a job of `kind` last finished `done`, ISO; undefined when none has */
  lastDone(kind: JobKind): Promise<string | undefined>;
}

/** Hands a recorded job to whatever runs it. */
export interface JobRunner {
  readonly describe: string;
  /** `delayMs`: do not start before this long from now (a webhook's retry backoff) */
  submit(job: JobRun, options?: { delayMs?: number }): Promise<void>;
}

/** Options of `JobService.enqueue`. */
export interface EnqueueOptions {
  /** do not start before this long from now */
  delayMs?: number;
}

export interface JobContext {
  job: JobRun;
  /** report progress (`job_run.steps`) */
  step(text: string): Promise<void>;
}

export type JobHandler = (context: JobContext) => Promise<JobOutcome>;
export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

/** The workbench's view of the jobs: enqueue, read, wait. */
export interface JobService {
  readonly describe: string;
  /** the kinds this deployment can run */
  readonly kinds: readonly JobKind[];
  enqueue(kind: JobKind, request: Record<string, unknown>, by?: StudioUser, options?: EnqueueOptions): Promise<JobRun>;
  get(id: string): Promise<JobRun | undefined>;
  list(options?: { kind?: JobKind; limit?: number }): Promise<JobRun[]>;
  files(id: string): Promise<PlanFile[]>;
  published(id: string, version: string): Promise<void>;
  /** poll until the job is done, failed or cancelled; throws after `timeoutMs` */
  wait(id: string, timeoutMs: number): Promise<JobRun>;
  /** keep an uploaded file for a job (an import's input): in the blob store when there is one */
  stageInput(bytes: Uint8Array): Promise<Record<string, unknown>>;
  /** the worker's last heartbeat (pg), for `GET /api/jobs` */
  worker?: () => Awaitable<WorkerBeat | undefined>;
}

export interface WorkerBeat {
  worker: string;
  version: string;
  startedAt: string;
  beatAt: string;
  queues: string[];
}

/** The plan an import job stages: the record changes its publish commits. */
export interface ImportPlan {
  changes: RecordChange[];
}

export class JobTimeoutError extends Error {
  constructor(id: string, ms: number) {
    super(`job ${id} did not finish within ${Math.round(ms / 1000)} s`);
    this.name = 'JobTimeoutError';
  }
}
