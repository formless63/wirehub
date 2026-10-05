/**
 * Jobs as the browser sees them (`/api/jobs`, `server/jobs/api.ts`): start an
 * import, follow it, read its plan, publish it, list recent jobs. Answers keep
 * the server's sentence when it refuses.
 */

export interface JobStepView {
  at: string;
  text: string;
}

/** What an importer proposed (`module-io.ts` `proposalOf`). */
export interface ImportProposal {
  definitions: Record<string, { id: string; label: string }[]>;
  existing: string[];
  designs: { id: string; label: string }[];
  existingDesigns: string[];
  /** board revisions whose placed parts are proposed, `<board>@<revision>` */
  boardParts?: string[];
  /** definitions whose board art is proposed */
  depictions?: string[];
  notes: string[];
}

export interface JobView {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  request: { module?: string; importer?: string; fileName?: string; reason?: string; [key: string]: unknown };
  steps: JobStepView[];
  result?: { importer?: string; fileName?: string; notes?: string[]; proposed?: number; proposal?: ImportProposal; changes?: number; [key: string]: unknown };
  error?: string;
  requestedBy?: { name: string; email?: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  publishedVersion?: string;
}

export interface PlanFileView {
  path: string;
  status: 'new' | 'changed' | 'unchanged';
}

export interface WorkerView {
  worker: string;
  version: string;
  startedAt: string;
  beatAt: string;
  queues: string[];
}

export type JobAnswer<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: string; hint?: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<JobAnswer<T>> {
  try {
    const raw = body instanceof Uint8Array;
    const response = await fetch(path, {
      method,
      ...(body === undefined ? {} : raw ? { headers: { 'content-type': 'application/octet-stream' }, body: body as unknown as BodyInit } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status >= 400) {
      return { ok: false, status: response.status, error: typeof parsed['error'] === 'string' ? parsed['error'] : `That failed (HTTP ${response.status}).`, ...(typeof parsed['hint'] === 'string' && parsed['hint'] !== '' ? { hint: parsed['hint'] } : {}) };
    }
    return { ok: true, status: response.status, value: parsed as T };
  } catch {
    return { ok: false, status: 0, error: 'The studio could not be reached.' };
  }
}

/**
 * Queue an import from a file's raw bytes (`PUT …?fileName=`, no base64, no JSON size limit).
 * 415 or 405: this host takes only the JSON form (the development server) — `startImportJob`.
 */
export function uploadImportJob(module: string, importer: string, fileName: string, bytes: Uint8Array): Promise<JobAnswer<{ job: JobView }>> {
  return call('PUT', `/api/modules/${encodeURIComponent(module)}/_import/${encodeURIComponent(importer)}?fileName=${encodeURIComponent(fileName)}`, bytes);
}

/** Queue an import: the file is kept for the job and the importer runs there (202). 501: this studio runs no import jobs. */
export function startImportJob(module: string, importer: string, fileName: string, base64: string, options?: Record<string, string>): Promise<JobAnswer<{ job: JobView }>> {
  return call('POST', `/api/modules/${encodeURIComponent(module)}/_import/${encodeURIComponent(importer)}`, { fileName, base64, job: true, ...(options === undefined || Object.keys(options).length === 0 ? {} : { options }) });
}

export function fetchJob(id: string): Promise<JobAnswer<{ job: JobView; files?: PlanFileView[] }>> {
  return call('GET', `/api/jobs/${encodeURIComponent(id)}`);
}

export function fetchJobs(kind?: string): Promise<JobAnswer<{ runner: string; kinds: string[]; jobs: JobView[]; worker?: WorkerView | null }>> {
  return call('GET', `/api/jobs${kind === undefined ? '' : `?kind=${encodeURIComponent(kind)}`}`);
}

/** Commit an import's plan as one change set. */
export function publishJob(id: string): Promise<JobAnswer<{ job: JobView; committed: boolean; applied?: number; version?: string; hint?: string }>> {
  return call('POST', `/api/jobs/${encodeURIComponent(id)}/publish`, {});
}

export const jobsKey = ['studio', 'jobs'] as const;
export const jobKey = (id: string): readonly [string, string, string] => ['studio', 'job', id];

export const isFinished = (job: JobView): boolean => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
