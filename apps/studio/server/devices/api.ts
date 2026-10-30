/**
 * Device exports (WF-ASM): the whole device — boards, enclosure base and lid, hardware, schematic
 * cable routes — as one assembly STEP and GLB, with an orthographic drawing sheet, made by the
 * enclosure pack's `device-assemble` op from the design's working copy or one saved version.
 *
 *   GET  /api/devices/:id/exports            the runs (newest first, each with its outputs), whether it can run, the current job
 *   POST /api/devices/:id/exports  { rev? }  queue a `device-export` job (202)
 *
 * The request is built here when the person asks (`export-request.ts`): the placement is the
 * model's `deviceScene`, the geometry pinned by sha256; the worker runs exactly that. Outputs
 * download through `GET /api/blobs/:sha`; each run's log through `/api/tool-outputs/runs/:id/log`.
 */

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { jobView } from '../jobs/api.ts';
import { toolStageAvailability } from '../jobs/tool-stages.ts';
import type { ToolRunRecord } from '../tools/outputs.ts';
import { buildDeviceExport, deviceDesign, type DeviceExportRequest } from './export-request.ts';

import { DEVICE_ROUTES } from './routes.ts';

const DESIGN_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const fail = (status: number, error: string, hint?: string, extra?: Record<string, unknown>): ApiResponse =>
  ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

function runView(run: ToolRunRecord): Record<string, unknown> {
  return { ...run, outputs: run.outputs.map((o) => ({ ...o, href: `/api/blobs/${o.sha256}` })), logHref: `/api/tool-outputs/runs/${run.id}/log` };
}

/** Whether exports can run here: a worker (or this process) with the enclosure pack, and somewhere to keep the outputs. */
export async function deviceExportAvailability(deps: WorkbenchDeps): Promise<{ ok: boolean; reason?: string }> {
  if (deps.toolOutputs === undefined) return { ok: false, reason: 'Device exports are kept with the other tool outputs, which need the database backend (WIREHUB_BACKEND=pg).' };
  return toolStageAvailability(deps, 'device-export');
}

export async function handleDeviceRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const [, , id, action, ...rest] = parts;
  if (id === undefined || !DESIGN_ID.test(id) || action !== 'exports' || rest.length > 0) return fail(404, 'There is nothing at that address.', DEVICE_ROUTES.join('; '));
  const record = `designs/${id}`;

  if (method === 'GET') {
    const available = await deviceExportAvailability(deps);
    const runs = deps.toolOutputs === undefined ? [] : await deps.toolOutputs.runs(record, { limit: 12 });
    const jobs = deps.jobs === undefined || !deps.jobs.kinds.includes('device-export') ? [] : await deps.jobs.list({ kind: 'device-export', limit: 50 });
    const job = jobs.find((j) => (j.request as Partial<DeviceExportRequest>).design?.id === id);
    return { status: 200, body: { record, available, runs: runs.filter((r) => r.op === 'device-assemble').map(runView), job: job === undefined ? null : jobView(job) } };
  }
  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
  if (request.user?.role === 'viewer') return fail(403, 'Viewers cannot start exports.', 'Ask an owner for the editor role.');
  const available = await deviceExportAvailability(deps);
  if (!available.ok) return fail(503, 'Devices cannot be exported on this hub right now.', available.reason);
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const rev = body['rev'];
  if (rev !== undefined && !(Number.isInteger(rev) && (rev as number) >= 0)) return fail(400, 'rev is a saved version number.');
  const jobs = deps.jobs!;
  const running = (await jobs.list({ kind: 'device-export', limit: 50 })).find((j) => (j.request as Partial<DeviceExportRequest>).design?.id === id && (j.status === 'queued' || j.status === 'running'));
  if (running !== undefined) return fail(409, 'This device is being exported already.', 'Wait for it, or cancel it first.', { job: jobView(running) });
  const found = await deviceDesign(deps, id, rev as number | undefined);
  if ('missing' in found) return fail(404, found.missing);
  const built = await buildDeviceExport(deps, found.design, found.db, rev as number | undefined, new Date().toISOString().slice(0, 10), found.pins);
  if ('problem' in built) return fail(422, built.problem);
  const by = request.user?.name ?? deps.localUser?.name;
  const job = await jobs.enqueue('device-export', { ...built, ...(by === undefined ? {} : { by }) }, request.user);
  return { status: 202, body: { id, job: jobView(job), findings: built.findings, parts: (built.params['parts'] as unknown[]).length }, headers: { Location: `/api/jobs/${job.id}` } };
}
