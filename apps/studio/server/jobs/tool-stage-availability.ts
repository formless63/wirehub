/**
 * The native tool-stage kinds and whether one can run on this hub right now (moved from
 * `tool-stages.ts`): a stage's own runner asks this without importing the registry
 * that imports it.
 */

import type { WorkbenchDeps } from '../api.ts';
import { packOfTarget } from '../firmware/targets.ts';
import type { JobKind } from './types.ts';

export const TOOL_STAGE_KINDS = ['board-outputs', 'firmware-compile', 'enclosure-generate', 'print-prepare', 'device-export'] as const satisfies readonly JobKind[];
export type ToolStageKind = (typeof TOOL_STAGE_KINDS)[number];

const PACK_OF: Record<ToolStageKind, string> = { 'board-outputs': 'kicad', 'firmware-compile': 'firmware-platformio', 'enclosure-generate': 'enclosure', 'print-prepare': 'slicer-prusaslicer', 'device-export': 'enclosure' };

/**
 * Whether a stage can run: a worker's heartbeat lists its queue, or (no worker) this process has a
 * runner. The words say what an operator does about it.
 */
export async function toolStageAvailability(deps: WorkbenchDeps, kind: ToolStageKind, env: Readonly<Record<string, string | undefined>> = process.env, target?: string): Promise<{ ok: boolean; reason?: string }> {
  const pack = kind === 'firmware-compile' && target !== undefined ? packOfTarget(target) : PACK_OF[kind];
  if (deps.jobs === undefined || !deps.jobs.kinds.includes(kind)) {
    return { ok: false, reason: `This hub runs no ${pack} tool pack: set WIREHUB_TOOL_RUNNER=docker where jobs run and build the image (tools/${pack}/README.md).` };
  }
  if (deps.jobs.worker !== undefined) {
    const beat = await deps.jobs.worker();
    if (beat === undefined) return { ok: false, reason: 'No background worker has reported in yet.' };
    if (!beat.queues.includes(kind)) return { ok: false, reason: `The worker has no tool runner. Enable the tools profile (WIREHUB_TOOL_RUNNER=docker) and build the ${pack} pack image.` };
    return { ok: true };
  }
  return (env.WIREHUB_TOOL_RUNNER ?? '').trim() === 'docker' ? { ok: true } : { ok: false, reason: 'No tool runner is configured (WIREHUB_TOOL_RUNNER=docker).' };
}
