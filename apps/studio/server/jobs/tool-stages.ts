/**
 * The native tool stages (`docs/jobs-and-tool-packs.md`): every job that runs a tool pack goes
 * through the one runner (`tools/runner.ts`) — board outputs (`kicad`), firmware compiles
 * (`firmware-platformio`), enclosure generation (`enclosure`) and print preparation
 * (`slicer-prusaslicer`). This file wires their handlers
 * and answers whether a stage can run on this hub right now.
 *
 * Who runs them: the worker on the database backend (`WIREHUB_TOOL_RUNNER=docker` on the worker);
 * on the file backend, or a database deployment with `WIREHUB_WORKER=off`, this process runs them
 * with the same runner when `WIREHUB_TOOL_RUNNER=docker` is set here (the web process then talks
 * to Docker: a single-host choice the operator makes knowingly).
 */

import type { WorkbenchDeps } from '../api.ts';
import type { BlobStore } from '../blobs.ts';
import { runDeviceExportJob } from '../devices/export-job.ts';
import { runEnclosureJob } from '../enclosures/job.ts';
import { runFirmwareJob } from '../firmware/job.ts';
import { runPrintPrepareJob } from '../print/job.ts';
import { toolRunnerFromEnv, type ToolRunner } from '../tools/runner.ts';
import { pinnedRunner } from '../repro/pin.ts';
import { runBoardOutputsJob } from './board-outputs.ts';
import type { JobHandlers } from './types.ts';

// the stage kinds and `toolStageAvailability` live in their own file, so a stage's runner can ask
// without importing this registry of runners
export { TOOL_STAGE_KINDS, toolStageAvailability, type ToolStageKind } from './tool-stage-availability.ts';
import { TOOL_STAGE_KINDS, type ToolStageKind } from './tool-stage-availability.ts';

/** Stages that register their runs in `studio.tool_run` (the database backend): they need `deps.toolOutputs`. */
const NEEDS_TOOL_OUTPUTS: readonly ToolStageKind[] = ['board-outputs', 'print-prepare', 'device-export'];

export interface ToolStageOptions {
  deps: WorkbenchDeps;
  blobs?: BlobStore;
  env?: Readonly<Record<string, string | undefined>>;
  /** a runner of the caller's (tests); default `toolRunnerFromEnv` */
  runner?: ToolRunner;
}

/** The tool-stage handlers, only where a runner is configured: the worker's heartbeat then lists exactly the stages it runs. */
export function toolStageHandlers(options: ToolStageOptions): JobHandlers {
  const runner = options.runner ?? toolRunnerFromEnv(options.env ?? process.env);
  if (runner === undefined) return {};
  const { deps } = options;
  // a re-run (repro/api.ts) runs the exact image its recorded run used
  const runnerFor = (context: { job: { request: Record<string, unknown> } }): ToolRunner => pinnedRunner(runner, context.job.request);
  const handlers: JobHandlers = {
    'firmware-compile': (context) => runFirmwareJob(context, { deps, runner: runnerFor(context) }),
    'enclosure-generate': (context) => runEnclosureJob(context, { deps, runner: runnerFor(context) }),
  };
  // board outputs and print preparation register their runs in `studio.tool_run` (the database backend)
  const outputs = deps.toolOutputs;
  if (outputs !== undefined) {
    handlers['board-outputs'] = (context) => runBoardOutputsJob(context, { deps, runner: runnerFor(context), outputs, ...(options.blobs === undefined ? {} : { blobs: options.blobs }) });
    handlers['print-prepare'] = (context) => runPrintPrepareJob(context, { deps, runner: runnerFor(context), outputs });
    handlers['device-export'] = (context) => runDeviceExportJob(context, { deps, runner: runnerFor(context), outputs });
  }
  return handlers;
}

/** The stage kinds this process runs itself (file backend, `WIREHUB_WORKER=off`): those with a runner here. */
export function inlineToolStageKinds(env: Readonly<Record<string, string | undefined>> = process.env, hasToolOutputs = false): ToolStageKind[] {
  if ((env.WIREHUB_TOOL_RUNNER ?? '').trim() !== 'docker') return [];
  return TOOL_STAGE_KINDS.filter((k) => !NEEDS_TOOL_OUTPUTS.includes(k) || hasToolOutputs);
}


// moved to its own file so the job runners need not import this registry of them
export { cancelSignal } from './cancel-signal.ts';
