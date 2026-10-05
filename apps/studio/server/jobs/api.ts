/**
 * The job endpoints (`specs/postgres-backend.md` §2, §7.5):
 *
 *   POST /api/modules/:module/importers/:importer   { fileName, data (base64) } — start an import (202, the job)
 *   GET  /api/jobs                                   recent jobs (`?kind=`), and the worker's heartbeat
 *   POST /api/jobs                                   { kind: model-cache | derive } — run one now (202)
 *   GET  /api/jobs/:id                               one job, with an import's plan files
 *   POST /api/jobs/:id/publish                       commit an import's plan as one change set
 *
 * An import runs as a job (the worker on Postgres, this process on files);
 * its publish is a request, so a stale record answers 409 to the person who
 * pressed it.
 */

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { staleWriteResponse } from '../etag.ts';
import { CommitRefusedError, ReadOnlyBackendError, StaleRecordError } from '../storage/change-set.ts';
import { withWriteLock } from '../storage/write-lock.ts';
import { commitPlan, MAX_IMPORT_BYTES, planChanges, readImportRequest } from './import.ts';
import { isJobKind, type JobKind, type JobRun } from './types.ts';

export const JOB_ROUTES = [
  'POST   /api/modules/:module/importers/:importer',
  'GET    /api/jobs',
  'POST   /api/jobs',
  'GET    /api/jobs/:id',
  'POST   /api/jobs/:id/publish',
] as const;

/** Kinds a person may start by hand (`POST /api/jobs`); the rest have their own triggers. */
const ON_DEMAND: readonly JobKind[] = ['model-cache', 'derive'];

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

function partsOf(path: string): string[] {
  return (path.split('?')[0] ?? '')
    .split('/')
    .filter((p) => p !== '')
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
}

/** `POST /api/modules/:module/importers/:importer`: a base64 file, as big as a model upload. */
export function isImportPath(path: string): boolean {
  const parts = partsOf(path);
  return parts[0] === 'api' && parts[1] === 'modules' && parts[3] === 'importers' && parts.length === 5;
}

export function isJobPath(path: string): boolean {
  const parts = partsOf(path);
  if (parts[0] !== 'api') return false;
  if (parts[1] === 'jobs') return true;
  return parts[1] === 'modules' && parts[3] === 'importers' && parts.length === 5;
}

/** A job as the API shows it: an import's staged changes are counted, not sent. */
export function jobView(job: JobRun): Record<string, unknown> {
  const { result, ...rest } = job;
  if (result === undefined) return rest;
  const { plan: _plan, ...summary } = result;
  return { ...rest, result: summary };
}

export async function handleJobRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = partsOf(request.path);
  const jobs = deps.jobs;
  if (jobs === undefined) return fail(501, 'This studio does not run jobs.', 'Imports and model builds need the job runner (docs/self-hosting.md).');

  // POST /api/modules/:module/importers/:importer
  if (parts[1] === 'modules') {
    const [, , moduleId, , importerId] = parts;
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    const importer = deps.modules?.importers().find((i) => i.module === moduleId && i.id === importerId);
    if (importer === undefined) return fail(404, `No module importer ${moduleId}:${importerId} in this deployment.`, 'Check the deployment\'s modules.config.ts.');
    if (!jobs.kinds.includes('import')) return fail(501, 'This studio does not run imports.');
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
    const fileName = body['fileName'];
    const data = body['data'];
    if (typeof fileName !== 'string' || fileName.trim() === '' || fileName.length > 200 || /[\\/\u0000]/.test(fileName)) return fail(400, 'The import needs the file name (no folders) as `fileName`.');
    if (!importer.accepts.some((ext) => fileName.toLowerCase().endsWith(ext))) {
      return fail(400, `${importer.label} reads ${importer.accepts.join(', ')} files, not ${fileName}.`);
    }
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(data)) return fail(400, 'The import needs the file, base64-encoded, as `data`.');
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (bytes.byteLength === 0) return fail(400, 'That file is empty.');
    if (bytes.byteLength > MAX_IMPORT_BYTES) return fail(413, `That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB; an import takes up to ${MAX_IMPORT_BYTES / 1048576} MB.`);
    const input = await jobs.stageInput(bytes);
    const job = await jobs.enqueue('import', { module: moduleId, importer: importerId, fileName: fileName.trim(), input }, request.user);
    return { status: 202, body: { job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
  }

  const [, , id, action, ...rest] = parts;
  if (rest.length > 0) return fail(404, 'There is nothing at that address.', JOB_ROUTES.join('; '));

  if (id === undefined) {
    if (method === 'GET') {
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const kind = query.get('kind') ?? undefined;
      if (kind !== undefined && !isJobKind(kind)) return fail(400, `'${kind}' is not a job kind.`);
      const limit = Math.min(Math.max(Number(query.get('limit') ?? 50) || 50, 1), 200);
      const list = await jobs.list({ ...(kind === undefined ? {} : { kind: kind as JobKind }), limit });
      const worker = await jobs.worker?.();
      return { status: 200, body: { runner: jobs.describe, kinds: jobs.kinds, jobs: list.map(jobView), ...(jobs.worker === undefined ? {} : { worker: worker ?? null }) } };
    }
    if (method === 'POST') {
      const kind = (request.body as { kind?: unknown } | undefined)?.kind;
      if (!isJobKind(kind) || !ON_DEMAND.includes(kind)) return fail(400, `Say which job to run: one of ${ON_DEMAND.join(', ')}.`);
      if (!jobs.kinds.includes(kind)) return fail(501, `This studio does not run '${kind}' jobs.`);
      const job = await jobs.enqueue(kind, { reason: 'requested' }, request.user);
      return { status: 202, body: { job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
    }
    return fail(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
  }
  if (!JOB_ID.test(id)) return fail(400, `${JSON.stringify(id)} is not a job id.`);
  const job = await jobs.get(id);
  if (job === undefined) return fail(404, `There is no job ${id}.`, 'Jobs are kept for a while, then forgotten.');

  if (action === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return { status: 200, body: { job: jobView(job), ...(job.kind === 'import' ? { files: await jobs.files(id) } : {}) } };
  }
  if (action !== 'publish') return fail(404, 'There is nothing at that address.', JOB_ROUTES.join('; '));
  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
  if (job.kind !== 'import') return fail(400, `Job ${id} is ${job.kind === 'model-cache' ? 'a model build' : `a ${job.kind} job`}; only an import is published.`);
  if (job.status !== 'done') return fail(409, `Import ${id} is ${job.status}, so there is no plan to publish.`, job.status === 'failed' ? (job.error ?? '') : 'Wait for it to finish.');
  if (job.publishedVersion !== undefined) return fail(409, `Import ${id} was published already (catalog version ${job.publishedVersion}).`);
  const changes = planChanges(job.result);
  if (changes === undefined) return fail(409, `Import ${id} has no plan.`);
  const request_ = readImportRequest(job.request);

  return withWriteLock(async () => {
    // a second press while the first waited for the lock
    const again = await jobs.get(id);
    if (again?.publishedVersion !== undefined) return fail(409, `Import ${id} was published already (catalog version ${again.publishedVersion}).`);
    if (changes.length === 0) return { status: 200, body: { job: jobView(job), committed: false, applied: 0, hint: 'Nothing to change: the catalog already says what the import proposed.' } };
    try {
      const committed = await commitPlan(deps, changes, {
        path: `/api/jobs/${id}/publish`,
        message: `Import ${request_.fileName} (${request_.module}:${request_.importer})`,
        ...(request.user === undefined ? {} : { user: request.user }),
      });
      const version = String((await deps.catalogVersion?.()) ?? '');
      await jobs.published(id, version);
      if (deps.events !== undefined) deps.events.publish({ type: 'catalog', version });
      return { status: 200, body: { job: jobView((await jobs.get(id)) ?? job), committed: true, applied: committed.applied, derived: committed.derived, version } };
    } catch (error) {
      if (error instanceof StaleRecordError) {
        const stale = staleWriteResponse(error.kind, error.key);
        return { ...stale, body: { ...(stale.body as object), error: `${error.kind} '${error.key}' changed since the import ran, so nothing was written.`, hint: 'Run the import again: it plans against the catalog as it is now.' } };
      }
      if (error instanceof CommitRefusedError) return fail(error.status, error.message, error.hint);
      if (error instanceof ReadOnlyBackendError) return fail(503, error.message, 'Nothing was written.');
      throw error;
    }
  });
}
