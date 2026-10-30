/**
 * Re-run and compare, and portable packages (Specmate idea: reproducibility + offline verify).
 *
 *   GET  /api/repro/runs/:runId                    the run's newest re-run (its job, its run, the compare), or what it re-ran
 *   POST /api/repro/runs/:runId/rerun              run the same op again from the recorded request, in the recorded image (202, the job)
 *   GET  /api/repro/runs/:runId/package            zip: the run's outputs, the exact inputs it read, manifest, verify.py
 *   GET  /api/repro/designs/:id/:rev/package       zip: a saved version, its effective inputs, documents and its tool runs
 *
 * A re-run is a new job of the same kind whose request is the recorded one (inputs pinned by
 * sha256, effective inputs kept as captured) plus `rerunOf` and `pinImages`: the stage runs the
 * exact image id the recorded run used (`pin.ts`). Nothing is approved or frozen to get here.
 */

import { isDesignId } from '@wirehub/catalog';
import { baseExport } from '@wirehub/docs';

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { handleDocumentRequest } from '../documents.ts';
import { versionInputs } from '../effective-inputs.ts';
import { jobView } from '../jobs/api.ts';
import type { JobKind, JobRun } from '../jobs/types.ts';
import type { ToolRunRecord } from '../tools/outputs.ts';
import { boardRunsAsSaved, frozenBoards } from './frozen-boards.ts';
import { deviceAsSaved } from './frozen-device.ts';
import { compareRuns, isTextual, TEXT_DIFF_MAX, type RunCompare } from './compare.ts';
import { compareInside, isContainer, type InsideCompare } from './inside.ts';
import { PackageBuilder, zipResponse } from './package.ts';

export const REPRO_ROUTES = [
  'GET    /api/repro/runs/:runId',
  'POST   /api/repro/runs/:runId/rerun',
  'GET    /api/repro/runs/:runId/compare?with=:otherRunId',
  'GET    /api/repro/runs/:runId/package',
  'GET    /api/repro/designs/:id/:rev/package',
] as const;

/** The stages whose runs are recorded in the tool-output store, so a re-run can be found and compared. */
const RERUNNABLE: readonly JobKind[] = ['board-outputs', 'device-export', 'print-prepare'];
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** document exports put in a design-version package: plain text, deterministic (an id this build does not offer is skipped) */
const PACKAGE_EXPORTS = ['bom.csv', 'wire-list.csv', 'cut-list.csv', 'continuity.json', 'mass.json', 'processes.json'];

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });

export function isReproPath(path: string): boolean {
  return /^\/api\/repro(\/|$)/.test(path.split('?')[0] ?? '');
}

const slug = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'run';

async function jobOf(deps: WorkbenchDeps, run: ToolRunRecord): Promise<JobRun | undefined> {
  return run.jobId === undefined ? undefined : deps.jobs?.get(run.jobId);
}

/** The run made by job `jobId` for the same record and op (a re-run's result). */
async function runOfJob(deps: WorkbenchDeps, record: string, op: string, jobId: string): Promise<ToolRunRecord | undefined> {
  return (await deps.toolOutputs?.runs(record, { limit: 60 }))?.find((r) => r.jobId === jobId && r.op === op);
}

async function compareOf(deps: WorkbenchDeps, a: ToolRunRecord, b: ToolRunRecord): Promise<RunCompare> {
  // text outputs that differ are read for a line count (each side once, within a size limit);
  // zips and GLBs that differ are compared member by member
  const texts = new Map<string, string>();
  const insides = new Map<string, InsideCompare>();
  const ab = new Map(a.outputs.map((o) => [o.path, o]));
  for (const o of b.outputs) {
    const x = ab.get(o.path);
    if (x === undefined || x.sha256 === o.sha256 || x.size > TEXT_DIFF_MAX * 2 || o.size > TEXT_DIFF_MAX * 2) continue;
    if (isContainer(o.mediaType, o.path)) {
      const [fa, fb] = [await deps.toolOutputs?.file(x.sha256), await deps.toolOutputs?.file(o.sha256)];
      const found = fa === undefined || fb === undefined ? undefined : compareInside(fa.bytes, fb.bytes, o.mediaType, o.path);
      if (found !== undefined) insides.set(`${x.sha256}:${o.sha256}`, found);
      continue;
    }
    if (!isTextual(o.mediaType, o.path) || x.size > TEXT_DIFF_MAX || o.size > TEXT_DIFF_MAX) continue;
    for (const sha of [x.sha256, o.sha256]) {
      const found = await deps.toolOutputs?.file(sha);
      if (found !== undefined && !found.bytes.subarray(0, 8192).includes(0)) texts.set(sha, new TextDecoder('utf-8', { fatal: false }).decode(found.bytes));
    }
  }
  return compareRuns(a, b, (sha) => texts.get(sha), (x, y) => insides.get(`${x}:${y}`));
}

/** Why a run cannot be re-run here, or undefined when it can. */
async function rerunRefusal(deps: WorkbenchDeps, run: ToolRunRecord, job: JobRun | undefined): Promise<string | undefined> {
  if (deps.jobs === undefined) return 'This hub does not run jobs.';
  if (job === undefined) return 'The job that made this run is no longer kept, so its exact request is unknown.';
  if (!RERUNNABLE.includes(job.kind)) return `A ${job.kind} run is not re-run from here.`;
  if (!deps.jobs.kinds.includes(job.kind)) return `This hub does not run ${job.kind} jobs right now.`;
  if (!/^sha256:[0-9a-f]{64}$/.test(run.imageId)) return 'The run recorded no image id.';
  return undefined;
}

const summary = (run: ToolRunRecord): Record<string, unknown> => ({ id: run.id, op: run.op, status: run.status, createdAt: run.createdAt, image: run.image, imageId: run.imageId, tool: run.tool, identity: run.identity });

export async function handleReproRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [, , section, ...rest] = parts;
  if (section === 'designs') return designPackage(method, rest, deps);
  if (section !== 'runs') return fail(404, 'There is nothing at that address.', REPRO_ROUTES.join('; '));
  const [id, action, ...more] = rest;
  if (id === undefined || !RUN_ID.test(id) || more.length > 0) return fail(404, 'There is nothing at that address.', REPRO_ROUTES.join('; '));
  if (deps.toolOutputs?.run === undefined) return fail(501, 'Tool runs are kept on the database backend only.', 'WIREHUB_BACKEND=pg with a blob store.');
  const run = await deps.toolOutputs.run(id);
  if (run === undefined) return fail(404, 'There is no such tool run.', 'Only the newest few runs of each output are kept.');
  const job = await jobOf(deps, run);

  if (action === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const refusal = await rerunRefusal(deps, run, job);
    // what this run re-ran, when it is a re-run
    const of = typeof job?.request['rerunOf'] === 'string' ? await deps.toolOutputs.run(job.request['rerunOf']) : undefined;
    // its newest re-run
    const reruns = job === undefined || deps.jobs === undefined ? [] : (await deps.jobs.list({ kind: job.kind, limit: 100 })).filter((j) => j.request['rerunOf'] === id);
    const latest = reruns[0];
    const again = latest === undefined || latest.status !== 'done' ? undefined : await runOfJob(deps, run.record, run.op, latest.id);
    return {
      status: 200,
      body: {
        run: summary(run),
        comparisons: (await deps.toolOutputs.runs(run.record, { limit: 60 })).filter((candidate) => candidate.id !== run.id && candidate.op === run.op).map(summary),
        canRerun: refusal === undefined ? { ok: true } : { ok: false, reason: refusal },
        rerun: latest === undefined ? null : { job: jobView(latest), run: again === undefined ? null : summary(again), compare: again === undefined ? null : await compareOf(deps, run, again) },
        of: of === undefined ? null : { run: summary(of), compare: await compareOf(deps, of, run) },
      },
    };
  }
  if (action === 'compare') {
    if (method !== 'GET') return fail(405, 'This comparison answers GET.');
    const otherId = new URLSearchParams(request.path.split('?')[1] ?? '').get('with');
    if (otherId === null || !RUN_ID.test(otherId)) return fail(400, 'Choose another run to compare.');
    const other = await deps.toolOutputs.run(otherId);
    if (other === undefined) return fail(404, 'The other run is no longer kept.');
    if (other.record !== run.record || other.op !== run.op) return fail(400, 'Choose the same operation on this item.');
    return { status: 200, body: { a: summary(other), b: summary(run), compare: await compareOf(deps, other, run) } };
  }
  if (action === 'rerun') {
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    if (request.user?.role === 'viewer') return fail(403, 'Viewers cannot start jobs.');
    const refusal = await rerunRefusal(deps, run, job);
    if (refusal !== undefined) return fail(409, refusal);
    const jobs = deps.jobs!;
    const busy = (await jobs.list({ kind: job!.kind, limit: 100 })).find((j) => j.request['rerunOf'] === id && (j.status === 'queued' || j.status === 'running'));
    if (busy !== undefined) return fail(409, 'This run is being re-run already.', 'Wait for it, or cancel it on the Jobs page.');
    const { retryOf: _retry, rerunOf: _rerun, pinImages: _pins, ...recorded } = job!.request;
    const again: Record<string, unknown> = {
      ...recorded,
      // a board run is one op of its job: run that op only
      ...(job!.kind === 'board-outputs' ? { ops: [run.op] } : {}),
      rerunOf: run.id,
      pinImages: { [run.pack]: run.imageId },
    };
    const started = await jobs.enqueue(job!.kind, again, request.user);
    return { status: 202, body: { job: jobView(started) }, headers: { Location: `/api/jobs/${started.id}` } };
  }
  if (action === 'package') {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const pkg = new PackageBuilder();
    const folder = slug(`${run.record.split('/').at(-1)}-${run.op}`);
    await pkg.addRun(deps, run, folder, job?.request);
    const top = slug(`${run.record.split('/').at(-1)}-${run.op}-${run.createdAt.slice(0, 10)}-${run.id.slice(0, 8)}`);
    const zip = pkg.zip(top, { kind: 'tool-run', record: run.record, op: run.op, run: run.id, identity: run.identity }, `${run.record} — ${run.op}, ${run.tool.name} ${run.tool.version}, ${run.createdAt}`, new Date().toISOString());
    return zipResponse(zip, `${top}.zip`);
  }
  return fail(404, 'There is nothing at that address.', REPRO_ROUTES.join('; '));
}

/** `GET /api/repro/designs/:id/:rev/package`: a saved version with what it used and what was made from it. */
async function designPackage(method: string, rest: string[], deps: WorkbenchDeps): Promise<ApiResponse> {
  const [id, revText, action, ...more] = rest;
  if (id === undefined || !isDesignId(id) || revText === undefined || !/^\d{1,6}$/.test(revText) || action !== 'package' || more.length > 0) return fail(404, 'There is nothing at that address.', REPRO_ROUTES.join('; '));
  if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
  const rev = Number(revText);
  const file = await deps.versions?.read(id, rev);
  if (file === undefined) return fail(404, `'${id}' has no saved Rev ${rev}.`);
  const pkg = new PackageBuilder();
  pkg.json('record/design-version.json', file);
  const inputs = await versionInputs(deps as Parameters<typeof versionInputs>[0], file);
  pkg.json('record/effective-inputs.json', inputs);

  // the documents a person would download for this revision (text exports, same functions as the toolbar)
  for (const name of PACKAGE_EXPORTS.filter((id) => baseExport(id) !== undefined)) {
    try {
      const answer = await handleDocumentRequest('GET', ['api', 'designs', id, 'exports', name], new URLSearchParams({ rev: String(rev) }), deps as unknown as Parameters<typeof handleDocumentRequest>[3]);
      const bytes = answer !== undefined && answer.status === 200 && 'bytes' in answer && answer.bytes !== undefined ? new Uint8Array(answer.bytes)
        : answer !== undefined && answer.status === 200 && typeof answer.body === 'string' ? new TextEncoder().encode(answer.body) : undefined;
      if (bytes !== undefined && bytes.byteLength > 0) pkg.add({ path: `documents/${name}`, bytes, kind: 'document' });
    } catch {
      // a design without wires has no wire list: nothing to add
    }
  }

  // the enclosure generations this revision pinned, and the device export made from it (never a newer one)
  const store = deps.toolOutputs;
  const device = await deviceAsSaved(
    file,
    async (asset) => {
      const found = await deps.assets?.get(asset);
      return found === undefined ? undefined : new Uint8Array(found.bytes);
    },
    store === undefined ? [] : await store.runs(`designs/${id}`, { limit: 30 }),
  );
  for (const f of device.files) pkg.add(f);
  pkg.missing.push(...device.missing);
  // tool runs: that device export, and each board's outputs as this revision froze it
  if (store !== undefined) {
    if (device.export !== undefined) await pkg.addRun(deps, device.export, slug(`device-${device.export.op}`), (await jobOf(deps, device.export))?.request);
    const ids = [...new Set(inputs.inputs.filter((i) => i.kind === 'pcbas').map((i) => i.id))].sort();
    const read = deps.versions?.readArtworkBlob?.bind(deps.versions);
    for (const board of await frozenBoards(file, ids, read === undefined ? undefined : async (d, b) => read(d, b))) {
      const found = boardRunsAsSaved(board, await store.runs(`pcbas/${board.id}`, { limit: 30 }));
      for (const run of found.runs) await pkg.addRun(deps, run, slug(`${board.id}-${run.op}`), (await jobOf(deps, run))?.request);
      pkg.missing.push(...found.missing);
    }
  }
  const top = slug(`${id}-rev${rev}`);
  const zip = pkg.zip(top, { kind: 'design-version', design: id, rev, label: file.design.label, savedAt: file.savedAt }, `${file.design.label ?? id} — Rev ${rev}, saved ${file.savedAt}`, new Date().toISOString());
  return zipResponse(zip, `${top}-package.zip`);
}
