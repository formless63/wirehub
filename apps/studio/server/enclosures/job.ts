/**
 * The `enclosure-generate` job: run the `enclosure` tool pack through the shared runner on the
 * request the studio built from the shell's parameters (`request.ts`, read when the person pressed
 * Generate), then commit the outputs as one change set: assets (STEP, STL, GLB, PNG), the GLB as
 * the shell's 3D model (`sourceKind: 'generated'`), and the run record at `data/enclosures/<id>.json`.
 * A cancelled or crashed run writes nothing; an honest `failed` run is recorded with its findings.
 */

import type { EnclosureSpec } from '@wirehub/model';

import { toolOperationName } from '../tools/packs.ts';
import type { WorkbenchDeps } from '../api.ts';
import { publishCatalog } from '../catalog-commit.ts';
import type { AssetMime } from '../assets.ts';
import { cancelSignal } from '../jobs/cancel-signal.ts';
import type { JobContext, JobOutcome } from '../jobs/types.ts';
import type { ModelLink } from '../models/links.ts';
import { StaleRecordError } from '../storage/change-set.ts';
import { UnitOfWork } from '../storage/unit-of-work.ts';
import { withWriteLock } from '../storage/write-lock.ts';
import type { ToolRunner } from '../tools/runner.ts';
import type { PackFinding } from './request.ts';
import { ENCLOSURE_OP, ENCLOSURE_PACK, enclosureRunPath, type EnclosureOutput, type EnclosureRun } from './run.ts';

export { ENCLOSURE_OP, ENCLOSURE_PACK, enclosureRunPath, type EnclosureOutput, type EnclosureRun } from './run.ts';

export interface EnclosureJobRequest {
  enclosure: string;
  label: string;
  params: Record<string, unknown>;
  spec: EnclosureSpec;
  sources: { pcba: string; path: string; sha256: string }[];
  /** what the request builder found (missing outlines, unknown heights) */
  findings: PackFinding[];
  by?: string;
  design?: string | { id: string; rev?: number };
  /** board 3D exports queued with it (no export yet): waited for, then the request is built again with their heights */
  board3d?: { pcba: string; job: string }[];
}

/** how long a generation waits for the board 3D exports queued with it */
const BOARD_3D_WAIT_MS = 15 * 60_000;

/** Wait for the queued board exports, then build the request again from the same parameters (their heights now read). */
async function afterBoard3d(context: JobContext, request: EnclosureJobRequest, deps: WorkbenchDeps): Promise<EnclosureJobRequest> {
  const queued = request.board3d ?? [];
  if (queued.length === 0 || deps.jobs === undefined) return request;
  const failed: string[] = [];
  for (const q of queued) {
    await context.step('Waiting for a board 3D export');
    try {
      const done = await deps.jobs.wait(q.job, BOARD_3D_WAIT_MS);
      if (done.status !== 'done') failed.push(q.pcba);
    } catch {
      failed.push(q.pcba);
    }
    if (await context.cancelled?.()) throw new Error('cancelled');
  }
  // dynamic: api.ts imports this file
  const { nativeLookupOf } = await import('./api.ts');
  const { buildEnclosureRequest } = await import('./request.ts');
  const built = await buildEnclosureRequest(request.spec, (await deps.loadDb()).pcbas, nativeLookupOf(deps));
  const findings = [...built.findings, ...failed.map((p) => ({ level: 'info' as const, message: `${p}: its 3D export did not finish; part heights read from footprint names.` }))];
  await context.step(`board 3D export${queued.length === 1 ? '' : 's'} ${failed.length === 0 ? 'done' : `done, ${failed.length} failed`}; request built again`);
  return { ...request, params: built.params, sources: built.sources, findings };
}

const MIME: Record<string, AssetMime | undefined> = {
  'model/step': 'model/step', 'model/stl': 'model/stl', 'model/gltf-binary': 'model/gltf-binary', 'image/png': 'image/png',
};

export async function runEnclosureJob(context: JobContext, options: { deps: WorkbenchDeps; runner: ToolRunner }): Promise<JobOutcome> {
  const asked = context.job.request as unknown as EnclosureJobRequest;
  if (typeof asked.enclosure !== 'string' || typeof asked.params !== 'object' || asked.params === null) throw new Error('the enclosure-generate job has no enclosure or parameters');
  const { deps } = options;
  const request = await afterBoard3d(context, asked, deps);
  const id = request.enclosure;
  await context.step(`${request.sources.length} native board source(s) pinned · ${toolOperationName(ENCLOSURE_PACK, ENCLOSURE_OP)}: running`);
  const cancel = cancelSignal(context);
  let run;
  try {
    run = await options.runner.run({ pack: ENCLOSURE_PACK, op: ENCLOSURE_OP, params: request.params, inputs: [], signal: cancel.signal, jobId: context.job.id });
  } finally {
    cancel.done();
  }
  const m = run.manifest;
  await context.step(`${toolOperationName(ENCLOSURE_PACK, ENCLOSURE_OP)}: ${m.status}, ${m.outputs.length} output(s) in ${Math.round(run.durationMs / 100) / 10} s (${m.tool.name} ${m.tool.version})`);
  if (await context.cancelled?.()) throw new Error('cancelled');
  const resultOut = m.outputs.find((o) => o.role === 'result');
  const result = resultOut === undefined ? null : (JSON.parse(new TextDecoder().decode(run.read(resultOut.path))) as unknown);
  const generatedAt = new Date().toISOString();
  const provenance = `Generated ${generatedAt.slice(0, 10)} by ${run.image.ref} (${m.tool.name} ${m.tool.version}) from ${request.label}'s enclosure parameters; request sha256 ${run.requestSha256.slice(0, 12)}`;
  const base: Omit<EnclosureRun, 'outputs'> = {
    enclosure: id, generatedAt, ...(request.by === undefined ? {} : { by: request.by }), status: m.status, pack: m.pack, packVersion: m.packVersion,
    image: run.image.ref, imageId: run.image.id, job: context.job.id, tool: m.tool as unknown as Record<string, string>, requestSha256: run.requestSha256,
    inputs: { spec: request.spec, sources: request.sources }, findings: [...request.findings, ...m.findings], result, log: run.log.slice(-4000),
  };
  let doc: EnclosureRun | undefined;
  for (let attempt = 1; doc === undefined; attempt += 1) {
    try {
      doc = await withWriteLock(async () => {
        const uow = new UnitOfWork(deps);
        const d = uow.deps;
        const outputs: EnclosureOutput[] = [];
        let glb: string | undefined;
        if (m.status === 'ok') {
          for (const o of m.outputs) {
            const bytes = run.read(o.path);
            const mime = MIME[o.mediaType];
            const out: EnclosureOutput = { role: o.role, path: o.path, mediaType: o.mediaType, sha256: o.sha256, bytes: bytes.length };
            if (mime !== undefined && d.assets !== undefined) {
              const stored = await d.assets.put(Buffer.from(bytes), mime, `${id}-${o.path.replace(/^enclosure-/, '')}`, `${provenance}; ${o.role}`);
              out.asset = stored.id;
              if (o.role === 'preview-model') glb = stored.id;
            }
            outputs.push(out);
          }
          if (glb !== undefined && d.modelLinks !== undefined) {
            const link: ModelLink = { record: `mechanicals/${id}`, asset: glb, sourceKind: 'generated', name: `${request.label} (generated)`, src: provenance };
            await d.modelLinks.put(link);
          }
        }
        const next: EnclosureRun = { ...base, outputs };
        await d.docs!.write(enclosureRunPath(id), next);
        await uow.commit({ method: 'POST', path: `/api/enclosures/${id}/generate`, ...(context.job.requestedBy === undefined ? {} : { user: { ...context.job.requestedBy, source: 'session' } }) });
        return next;
      });
    } catch (error) {
      if (!(error instanceof StaleRecordError) || attempt >= 4) throw error;
    }
  }
  await publishCatalog(deps);
  await context.step(`Saved ${doc.outputs.length} generated file(s) and the run history`);
  if (m.status !== 'ok') throw new Error(m.findings.filter((f) => f.level === 'error').map((f) => f.message).join('; ') || 'the generator could not make this enclosure');
  return { result: { enclosure: id, status: m.status, outputs: doc.outputs.length, image: run.image.ref, requestSha256: run.requestSha256 } };
}
