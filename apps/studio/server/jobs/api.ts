/**
 * The job endpoints (`specs/postgres-backend.md` §2, §7.5):
 *
 *   POST /api/modules/:module/_import/:importer      { fileName, base64, job: true, options? } — start an import (202, the job)
 *   PUT  /api/modules/:module/_import/:importer?fileName=…[&option.<name>=…]   the file's bytes (application/octet-stream), as a job (202):
 *                                                    no base64, and room for a file bigger than a JSON document
 *                                                    (`WIREHUB_IMPORT_MAX_MB`, default 100)
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
import { importOptionsOfQuery, parseModuleIoPath, readImportOptions, type ModuleIoPath } from '../module-io.ts';
import { commitPlan, MAX_IMPORT_BYTES, planChanges, readImportRequest } from './import.ts';
import { isJobKind, isModuleJobKind, type JobKind, type JobRun } from './types.ts';

export const JOB_ROUTES = [
  'GET    /api/jobs',
  'POST   /api/jobs',
  'GET    /api/jobs/:id',
  'POST   /api/jobs/:id/publish',
] as const;

/** Kinds a person may start by hand (`POST /api/jobs`), and every module queue; the rest have their own triggers. */
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

/** `POST /api/modules/:module/_import/:importer`: a base64 file, as big as a model upload. */
export function isImportPath(path: string): boolean {
  return parseModuleIoPath(path)?.kind === 'import';
}

export function isJobPath(path: string): boolean {
  const parts = partsOf(path);
  return parts[0] === 'api' && parts[1] === 'jobs';
}

/** The largest file the raw upload route takes: `WIREHUB_IMPORT_MAX_MB` (default 100 MB). */
export function importUploadLimit(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const mb = Number((env['WIREHUB_IMPORT_MAX_MB'] ?? '').trim());
  return (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
}

/** A job as the API shows it: an import's staged changes are counted, not sent. */
export function jobView(job: JobRun): Record<string, unknown> {
  const { result, ...rest } = job;
  if (result === undefined) return rest;
  const { plan: _plan, ...summary } = result;
  return { ...rest, result: summary };
}

/**
 * `POST /api/modules/:module/_import/:importer` with `job: true`: the file is
 * kept for the job and the importer runs there (202, the job); the job's plan
 * is what `POST /api/jobs/:id/publish` commits.
 */
export async function startImportJob(request: ApiRequest, io: ModuleIoPath, deps: WorkbenchDeps): Promise<ApiResponse> {
  const jobs = deps.jobs;
  if (jobs === undefined || !jobs.kinds.includes('import')) return fail(501, 'This studio does not run import jobs.', 'Send the import without `job` to preview and accept it in one request.');
  const importer = deps.modules?.importer(io.module, io.id);
  if (importer === undefined) return fail(404, `${io.module} has no importer ${io.id}.`, "Check the deployment's modules.config.ts.");
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const fileName = body['fileName'];
  const data = body['base64'];
  if (typeof fileName !== 'string' || fileName.trim() === '' || fileName.length > 200 || /[\\/\u0000]/.test(fileName)) return fail(400, 'Send { "fileName": …, "base64": … } (a file name, no folders).');
  if (!importer.accepts.some((ext) => fileName.toLowerCase().endsWith(ext))) return fail(400, `${importer.label} takes ${importer.accepts.join(' or ')} files, not ${fileName}.`, 'Pick another file.');
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(data)) return fail(400, 'The file is not valid base64.', 'Nothing was read.');
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  if (bytes.byteLength === 0) return fail(400, 'That file is empty.');
  if (bytes.byteLength > MAX_IMPORT_BYTES) return fail(413, `That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB; an import takes up to ${MAX_IMPORT_BYTES / 1048576} MB.`, 'A bigger file goes up as raw bytes: PUT the same address with ?fileName=… and application/octet-stream.');
  const options = readImportOptions(body['options']);
  if (typeof options === 'string') return fail(400, options, 'Options are names and text values: { "options": { "board": "…" } }.');
  const input = await jobs.stageInput(bytes);
  const job = await jobs.enqueue('import', { module: io.module, importer: io.id, fileName: fileName.trim(), input, ...(options === undefined ? {} : { options }) }, request.user);
  return { status: 202, body: { job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
}

/** The checks on an import's file name and importer shared by the two ways of sending one. */
export function importUploadRefusal(deps: WorkbenchDeps, io: ModuleIoPath, fileName: string | null): ApiResponse | undefined {
  if (deps.jobs === undefined || !deps.jobs.kinds.includes('import')) return fail(501, 'This studio does not run import jobs.', 'Send the import as JSON, without `job`, to preview and accept it in one request.');
  const importer = deps.modules?.importer(io.module, io.id);
  if (importer === undefined) return fail(404, `${io.module} has no importer ${io.id}.`, "Check the deployment's modules.config.ts.");
  if (fileName === null || fileName.trim() === '' || fileName.length > 200 || /[\\/\u0000]/.test(fileName)) return fail(400, 'Say the file name in the query: ?fileName=… (a name, no folders).');
  if (!importer.accepts.some((ext) => fileName.toLowerCase().endsWith(ext))) return fail(400, `${importer.label} takes ${importer.accepts.join(' or ')} files, not ${fileName}.`, 'Pick another file.');
  return undefined;
}

/**
 * `PUT /api/modules/:module/_import/:importer?fileName=…`: the raw bytes of a file
 * (read by the transport, up to `importUploadLimit`) kept for an import job. The
 * answer is `startImportJob`'s: 202 and the job.
 */
export async function startImportUpload(request: ApiRequest & { fileName: string | null; bytes: Uint8Array; query?: URLSearchParams }, io: ModuleIoPath, deps: WorkbenchDeps): Promise<ApiResponse> {
  const refused = importUploadRefusal(deps, io, request.fileName);
  if (refused !== undefined) return refused;
  if (request.bytes.byteLength === 0) return fail(400, 'That file is empty.');
  const options = importOptionsOfQuery(request.query ?? new URLSearchParams(request.path.split('?')[1] ?? ''));
  if (typeof options === 'string') return fail(400, options, 'Options go in the query as option.<name>=<text>.');
  const jobs = deps.jobs!;
  const input = await jobs.stageInput(request.bytes);
  const job = await jobs.enqueue('import', { module: io.module, importer: io.id, fileName: (request.fileName as string).trim(), input, ...(options === undefined ? {} : { options }) }, request.user);
  return { status: 202, body: { job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
}

export async function handleJobRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = partsOf(request.path);
  const jobs = deps.jobs;
  if (jobs === undefined) return fail(501, 'This studio does not run jobs.', 'Imports and model builds need the job runner (docs/self-hosting.md).');

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
      if (!isJobKind(kind) || !(ON_DEMAND.includes(kind) || isModuleJobKind(kind))) return fail(400, `Say which job to run: one of ${ON_DEMAND.join(', ')}, or a module's queue (<module>:<queue>).`);
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
