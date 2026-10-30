/**
 * The `firmware-compile` job: one compile of a firmware project through the shared tool-pack runner
 * (`tools/runner.ts`, pack `firmware-platformio`). The request carries everything the compile is
 * given (target, defines, the source files' hashes), so the worker never reads the project record
 * that may have changed since; the build record (`data/firmware/builds/<id>.json`) follows the job:
 * queued → running → ok | failed | error | cancelled.
 */

import { createHash } from 'node:crypto';

import type { ConfigParams, FirmwareBuild, FirmwareSourceFile } from '../../src/firmware.ts';
import { toolOperationName } from '../tools/packs.ts';
import type { WorkbenchDeps } from '../api.ts';
import { cancelSignal } from '../jobs/cancel-signal.ts';
import type { JobContext, JobOutcome } from '../jobs/types.ts';
import { StaleRecordError } from '../storage/change-set.ts';
import { UnitOfWork } from '../storage/unit-of-work.ts';
import { withWriteLock } from '../storage/write-lock.ts';
import { ToolRunError, type ToolRunner } from '../tools/runner.ts';
import { packOfTarget } from './targets.ts';
import { firmwareBytes } from './store.ts';

export const FIRMWARE_PACK = 'firmware-platformio';
export const buildsDoc = (id: string): string => `data/firmware/builds/${id}.json`;
/** Builds kept per project; older ones drop off the list (their bytes stay content-addressed). */
const KEEP_BUILDS = 30;

export interface FirmwareJobRequest {
  project: string;
  build: string;
  target: string;
  environment?: string;
  defines: ConfigParams;
  source: FirmwareSourceFile[];
  network: boolean;
  occurrence?: { design: string; instance: string };
  /** the occurrence's design: the job records its effective inputs */
  design?: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function readBuilds(deps: WorkbenchDeps, id: string): Promise<FirmwareBuild[]> {
  const value = await deps.docs?.read(buildsDoc(id));
  return Array.isArray(value) ? (value as FirmwareBuild[]) : [];
}

/** One writer at a time per document in this process. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/**
 * A build-history write in its own unit of work, under the write lock. The studio (a new build) and
 * the worker (its progress) both write the document: a write that lost the race reads again and
 * repeats (a few times).
 */
export async function updateBuilds(base: WorkbenchDeps, id: string, change: (builds: FirmwareBuild[]) => FirmwareBuild[]): Promise<void> {
  await serial(buildsDoc(id), async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await withWriteLock(async () => {
          const uow = new UnitOfWork(base);
          const next = change(await readBuilds(uow.deps, id)).slice(0, KEEP_BUILDS);
          await uow.deps.docs?.write(buildsDoc(id), next);
          await uow.commit({ method: 'POST', path: `/api/firmware/${id}/compile` });
        });
        return;
      } catch (error) {
        if (!(error instanceof StaleRecordError) || attempt >= 4) throw error;
      }
    }
  });
}

export async function runFirmwareJob(context: JobContext, options: { deps: WorkbenchDeps; runner: ToolRunner }): Promise<JobOutcome> {
  const request = context.job.request as unknown as FirmwareJobRequest;
  if (typeof request.project !== 'string' || typeof request.build !== 'string' || !Array.isArray(request.source)) throw new Error('the firmware-compile job has no project, build or source');
  const { deps } = options;
  const at = (): string => new Date().toISOString();
  const patch = (fields: Partial<FirmwareBuild>): Promise<void> =>
    updateBuilds(deps, request.project, (all) => {
      const found = all.some((b) => b.id === request.build);
      const base: FirmwareBuild = {
        id: request.build, project: request.project, startedAt: context.job.createdAt, status: 'queued',
        ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
        effective: { target: request.target, ...(request.environment === undefined ? {} : { environment: request.environment }), defines: request.defines, source: request.source },
        outputs: [], findings: [],
      };
      return found ? all.map((b) => (b.id === request.build ? { ...b, ...fields } : b)) : [{ ...base, ...fields }, ...all];
    });

  await patch({ status: 'running', job: context.job.id, network: request.network });
  const store = firmwareBytes();
  const inputs = [];
  for (const f of request.source) {
    const bytes = await store.get(f.sha256);
    if (bytes === undefined) {
      await patch({ status: 'error', message: `The stored bytes of ${f.path} are missing.`, finishedAt: at() });
      throw new Error(`the stored bytes of ${f.path} are missing`);
    }
    inputs.push({ path: `project/${f.path}`, bytes: new Uint8Array(bytes) });
  }
  await context.step(`${inputs.length} source file(s) verified${request.network ? ' · network allowed' : ''}`);
  const params = { target: request.target, ...(request.environment === undefined ? {} : { environment: request.environment }), defines: request.defines, networkAllowed: request.network };
  const cancel = cancelSignal(context);
  await context.step(`${toolOperationName(packOfTarget(request.target), 'compile')}: running`);
  try {
    const run = await options.runner.run({ pack: packOfTarget(request.target), op: 'compile', params, inputs, signal: cancel.signal, jobId: context.job.id, network: request.network });
    const m = run.manifest;
    const outputs = [];
    for (const o of m.outputs) {
      const bytes = run.read(o.path);
      await store.put(o.sha256, bytes);
      outputs.push({ path: o.path, sha256: o.sha256, role: o.role, mediaType: o.mediaType, bytes: bytes.length });
    }
    const log = new TextEncoder().encode(run.log);
    const logSha = sha256(log);
    await store.put(logSha, log);
    const toolchain = m['toolchain'] as FirmwareBuild['toolchain'];
    await patch({
      status: m.status === 'ok' ? 'ok' : 'failed', pack: m.pack, packVersion: m.packVersion, image: run.image.ref, imageId: run.image.id, tool: m.tool,
      ...(toolchain === undefined ? {} : { toolchain }), outputs, log: logSha, findings: m.findings, durationMs: run.durationMs, finishedAt: at(),
    });
    await context.step(`${toolOperationName(packOfTarget(request.target), 'compile')}: ${m.status}, ${outputs.length} output(s) in ${Math.round(run.durationMs / 100) / 10} s (${m.tool.name} ${m.tool.version})`);
    if (m.status !== 'ok') throw new Error(m.findings.filter((f) => f.level === 'error').map((f) => f.message).join('; ') || 'the compile failed');
    return { result: { project: request.project, build: request.build, status: m.status, outputs: outputs.length, image: run.image.ref } };
  } catch (error) {
    if (error instanceof ToolRunError) {
      const cancelled = error.code === 'cancelled';
      const logSha = error.log === undefined || error.log === '' ? undefined : sha256(new TextEncoder().encode(error.log));
      if (logSha !== undefined) await store.put(logSha, new TextEncoder().encode(error.log!));
      await patch({ status: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Cancelled; the compile was stopped.' : error.message, ...(logSha === undefined ? {} : { log: logSha }), finishedAt: at() });
    }
    throw error;
  } finally {
    cancel.done();
  }
}
