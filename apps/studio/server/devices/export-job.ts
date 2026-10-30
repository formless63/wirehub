/**
 * The worker's side of a device export: the `device-export` job. It reads each pinned input (the
 * enclosure's STEP solids from the asset store, boards' native STEPs from the tool-output store),
 * checks every one against the sha256 the request pinned, runs the enclosure pack's
 * `device-assemble` op through the shared runner and registers the verified outputs (assembly STEP,
 * GLB, preview, drawing sheet, result) against `designs/<id>` and the revision it was made from.
 *
 * Outputs are derived data (rebuildable from the design and the pinned pack), so they live in the
 * tool-output store like board outputs and print preparation, not in the catalog.
 * Type-only imports from the request builder: this file is wired from jobs/tool-stages.ts, and the
 * builder reaches api.ts at runtime.
 */

import { createHash } from 'node:crypto';

import { toolOperationName } from '../tools/packs.ts';
import type { WorkbenchDeps } from '../api.ts';
import type { JobContext, JobOutcome } from '../jobs/types.ts';
import type { ToolOutputStore } from '../tools/outputs.ts';
import type { ToolInput, ToolRunner } from '../tools/runner.ts';
import type { DeviceExportRequest } from './export-request.ts';

export const DEVICE_EXPORT_PACK = 'enclosure';
export const DEVICE_EXPORT_OP = 'device-assemble';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function runDeviceExportJob(context: JobContext, options: { deps: WorkbenchDeps; runner: ToolRunner; outputs: ToolOutputStore }): Promise<JobOutcome> {
  const request = context.job.request as unknown as DeviceExportRequest;
  if (typeof request.design?.id !== 'string' || !Array.isArray((request.params as { parts?: unknown }).parts)) throw new Error('the device-export job has no design or parts');
  const { deps, outputs } = options;
  const files: ToolInput[] = [];
  for (const input of request.inputs) {
    let bytes: Uint8Array | undefined;
    if (input.from.kind === 'asset') {
      const found = await deps.assets?.get(input.from.id);
      bytes = found === undefined ? undefined : new Uint8Array(found.bytes);
    } else {
      bytes = (await outputs.file(input.from.sha256))?.bytes;
    }
    if (bytes === undefined) throw new Error(`${input.record}'s ${input.role} is not stored any more; generate it again, then export`);
    if (sha256(bytes) !== input.sha256) throw new Error(`${input.record}'s ${input.role} does not match its pinned sha256 ${input.sha256.slice(0, 12)}…; nothing was run`);
    files.push({ path: input.path, bytes });
  }
  const parts = (request.params as { parts: unknown[] }).parts.length;
  await context.step(`${files.length} input file(s) verified · ${parts} part(s) · ${toolOperationName(DEVICE_EXPORT_PACK, DEVICE_EXPORT_OP)}: running`);
  if (await context.cancelled?.()) throw new Error('cancelled');
  // a cancellation kills the container (polled here, not imported from jobs/tool-stages.ts, which wires this job)
  const controller = new AbortController();
  const poll = setInterval(() => {
    void context.cancelled?.().then((yes) => { if (yes) controller.abort(); }).catch(() => undefined);
  }, 1000);
  poll.unref?.();
  let result;
  try {
    result = await options.runner.run({ pack: DEVICE_EXPORT_PACK, op: DEVICE_EXPORT_OP, params: request.params, inputs: files, signal: controller.signal, jobId: context.job.id });
  } finally {
    clearInterval(poll);
  }
  const m = result.manifest;
  await context.step(`${toolOperationName(DEVICE_EXPORT_PACK, DEVICE_EXPORT_OP)}: ${m.status}, ${m.outputs.length} output(s) in ${Math.round(result.durationMs / 100) / 10} s (${m.tool.name} ${m.tool.version})`);
  const rev = request.design.rev;
  const run = await outputs.register(
    {
      jobId: context.job.id,
      record: `designs/${request.design.id}`,
      identity: rev === undefined ? {} : { revision: `Rev ${rev}` },
      sources: request.inputs.map((i) => ({ role: i.role, path: `${i.record}:${i.path}`, sha256: i.sha256 })),
      pack: m.pack,
      packVersion: m.packVersion,
      image: result.image.ref,
      imageId: result.image.id,
      tool: m.tool,
      op: DEVICE_EXPORT_OP,
      // what it was made from, small: the full request is the job's (and its sha256 the runner's)
      params: { design: request.design, parts, requestSha256: result.requestSha256 },
      status: m.status,
      findings: [...request.findings, ...m.findings],
      outputs: m.outputs.map((o) => ({ path: o.path, role: o.role, mediaType: o.mediaType, size: result.files.get(o.path)!.byteLength, sha256: o.sha256 })),
      durationMs: result.durationMs,
      log: result.log,
    },
    result.files,
  );
  if (m.status !== 'ok') throw new Error(m.findings.filter((f) => f.level === 'error').map((f) => f.message).join('; ') || 'the device could not be assembled');
  return { result: { design: request.design, run: run.id, outputs: run.outputs.length, image: result.image.ref, requestSha256: result.requestSha256 } };
}
