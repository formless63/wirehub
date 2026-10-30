/**
 * The worker's side of print preparation: the `print-prepare` job. It reads each chosen part (STL,
 * or one 3MF plate) from the asset store, checks it against the hash the request pinned, runs the slicer
 * pack's `slice` op through the shared runner and registers the verified outputs (G-code,
 * summary, effective and requested profile) against the record, the part hashes and the
 * profile hash. Nothing here talks to a printer.
 */

import { createHash } from 'node:crypto';

import { toolOperationName } from '../tools/packs.ts';
import type { WorkbenchDeps } from '../api.ts';
import type { JobContext, JobOutcome } from '../jobs/types.ts';
import type { ToolOutputStore } from '../tools/outputs.ts';
import { runToolPackWith, ToolRunError, type ToolInput, type ToolRunner } from '../tools/runner.ts';
import type { PrintPrepareRequest } from './api.ts';
import { ORCA_PACK, ORCA_PROFILES_OP, ORCA_PROFILES_RECORD, orcaVendors } from './orca.ts';

// here, not in api.ts: the job is wired from jobs/tool-stages.ts, and importing api.ts at runtime
// from this side would close an import cycle through enclosures/api.ts and jobs/board-outputs.ts
export const PRINT_PACK = 'slicer-prusaslicer';
export const PRINT_OP = 'slice';
export const PRINT_JOB = 'print-prepare';

export interface PrintJobOptions {
  deps: WorkbenchDeps;
  runner: ToolRunner;
  outputs: ToolOutputStore;
  pollMs?: number;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function runPrintPrepareJob(context: JobContext, options: PrintJobOptions): Promise<JobOutcome> {
  if ((context.job.request as { task?: unknown }).task === 'profiles') return runOrcaProfilesJob(context, options);
  const request = context.job.request as unknown as PrintPrepareRequest;
  if (typeof request.mechanical !== 'string' || !Array.isArray(request.parts) || request.parts.length === 0 || request.profile?.config === undefined) {
    throw new Error('the print-prepare job has no record, parts or profile');
  }
  const assets = options.deps.assets;
  if (assets === undefined) throw new Error('this hub keeps no assets; the parts cannot be read');
  const inputs: ToolInput[] = [];
  for (const [i, part] of request.parts.entries()) {
    const found = await assets.get(part.asset);
    if (found === undefined) throw new Error(`the part ${part.path} is not stored any more; ${part.origin === undefined || part.origin === 'enclosure' ? 'generate the enclosure again' : 'attach or upload it again'}`);
    const bytes = new Uint8Array(found.bytes);
    if (sha256(bytes) !== part.sha256) throw new Error(`the part ${part.path} does not match its recorded sha256 ${part.sha256.slice(0, 12)}…; nothing was sliced`);
    inputs.push({ path: `parts/${i + 1}-${part.path.replace(/[^A-Za-z0-9._-]+/g, '-')}`, bytes });
  }
  await context.step(`${inputs.length} part(s) verified · printer, material and process settings verified${request.profile.adjustments === undefined ? '' : ` · supports ${request.profile.adjustments.supports ?? 'as profile'}, brim ${request.profile.adjustments.brimMm === undefined ? 'as profile' : `${request.profile.adjustments.brimMm} mm`}`} · ${request.orientation}`);
  if (await context.cancelled?.()) throw new Error('cancelled');

  const controller = new AbortController();
  const poll = setInterval(() => {
    void context.cancelled?.().then((yes) => {
      if (yes) controller.abort();
    }).catch(() => undefined);
  }, options.pollMs ?? 1000);
  const parts = inputs.map((input) => ({ path: input.path, copies: 1 }));
  // OrcaSlicer slices with its own presets by name, the adjustments as settings over them
  const params = request.pack === ORCA_PACK && request.profile.presets !== undefined
    ? { presets: request.profile.presets, overrides: request.profile.config, orientation: request.orientation, name: request.mechanical, parts, vendors: [request.profile.vendor] }
    : { config: request.profile.config, orientation: request.orientation, name: request.mechanical, parts };
  try {
    await context.step(`${toolOperationName(request.pack, PRINT_OP)}: running`);
    const result = await runToolPackWith(options.runner)(request.pack, PRINT_OP, params, inputs, { signal: controller.signal, jobId: context.job.id });
    const m = result.manifest;
    const run = await options.outputs.register(
      {
        jobId: context.job.id,
        record: request.record,
        identity: {},
        sources: [
          ...request.parts.map((p) => ({ role: p.format ?? 'stl', path: p.path, sha256: p.sha256 })),
          { role: 'print-profile', path: `${request.profile.parts.printer.id}+${request.profile.parts.material.id}+${request.profile.parts.process.id}`, sha256: request.profile.sha256 },
        ],
        pack: m.pack,
        packVersion: m.packVersion,
        image: result.image.ref,
        imageId: result.image.id,
        tool: m.tool,
        op: PRINT_OP,
        params: {
          orientation: request.orientation,
          profile: { sha256: request.profile.sha256, parts: request.profile.parts, ...(request.profile.adjustments === undefined ? {} : { adjustments: request.profile.adjustments }), ...(request.profile.tweaks === undefined ? {} : { tweaks: request.profile.tweaks }) },
          ...(request.source === undefined ? {} : { source: request.source }),
          origins: request.parts.map((p) => ({ path: p.path, origin: p.origin ?? 'enclosure' })),
        },
        status: m.status,
        findings: m.findings,
        outputs: m.outputs.map((o) => ({ path: o.path, role: o.role, mediaType: o.mediaType, size: result.files.get(o.path)!.byteLength, sha256: o.sha256 })),
        durationMs: result.durationMs,
        log: result.log,
      },
      result.files,
    );
    const notes = m.findings.map((f) => `${f.level}: ${f.message}`);
    await context.step(`${toolOperationName(request.pack, PRINT_OP)}: ${m.status} in ${Math.round(result.durationMs / 100) / 10} s (${m.tool.name} ${m.tool.version})${notes.length === 0 ? '' : ` — ${notes.join('; ')}`}`);
    if (m.status === 'failed') throw new Error(m.findings.filter((f) => f.level === 'error').map((f) => f.message).join('; ') || 'the slicer failed');
    return { result: { mechanical: request.mechanical, runId: run.id, profile: request.profile.sha256, pack: m.pack, packVersion: m.packVersion } };
  } catch (error) {
    if (error instanceof ToolRunError) await context.step(`${toolOperationName(request.pack, PRINT_OP)}: ${error.message}`);
    throw error;
  } finally {
    clearInterval(poll);
  }
}

/**
 * `task: 'profiles'`: list the OrcaSlicer pack's printer, filament and process presets and register
 * the list (`profiles.json`) against `tools/slicer-orcaslicer`, where the print API reads it.
 */
async function runOrcaProfilesJob(context: JobContext, options: PrintJobOptions): Promise<JobOutcome> {
  const request = context.job.request as { vendors?: unknown };
  const vendors = Array.isArray(request.vendors) && request.vendors.every((v) => typeof v === 'string') ? (request.vendors as string[]) : orcaVendors();
  await context.step(`${toolOperationName(ORCA_PACK, ORCA_PROFILES_OP)}: ${vendors.join(', ')}`);
  try {
    const result = await runToolPackWith(options.runner)(ORCA_PACK, ORCA_PROFILES_OP, { vendors }, [], { jobId: context.job.id });
    const m = result.manifest;
    const run = await options.outputs.register(
      {
        jobId: context.job.id, record: ORCA_PROFILES_RECORD, identity: {}, sources: [],
        pack: m.pack, packVersion: m.packVersion, image: result.image.ref, imageId: result.image.id, tool: m.tool, op: ORCA_PROFILES_OP,
        params: { vendors }, status: m.status, findings: m.findings,
        outputs: m.outputs.map((o) => ({ path: o.path, role: o.role, mediaType: o.mediaType, size: result.files.get(o.path)!.byteLength, sha256: o.sha256 })),
        durationMs: result.durationMs, log: result.log,
      },
      result.files,
    );
    await context.step(`${toolOperationName(ORCA_PACK, ORCA_PROFILES_OP)}: ${m.status} — ${m.findings.map((f) => f.message).join('; ')}`);
    if (m.status === 'failed') throw new Error(m.findings.filter((f) => f.level === 'error').map((f) => f.message).join('; ') || 'the preset list failed');
    return { result: { task: 'profiles', runId: run.id, pack: m.pack, packVersion: m.packVersion } };
  } catch (error) {
    if (error instanceof ToolRunError) await context.step(`${toolOperationName(ORCA_PACK, ORCA_PROFILES_OP)}: ${error.message}`);
    throw error;
  }
}
