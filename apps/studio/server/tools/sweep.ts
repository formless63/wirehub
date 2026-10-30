/**
 * Orphaned tool-pack containers: a worker killed mid-op leaves its container running to
 * its timeout, then stopped and never removed. The worker sweeps them on each heartbeat, after the job
 * reconciler has marked the dead worker's jobs interrupted.
 *
 * Only containers carrying this runner's owner label (`TOOL_OWNER_LABEL`, one value per stack) are
 * considered, never another stack's or anything else on the daemon. Of those it removes:
 *  - a container whose job is known and no longer running (interrupted, failed, cancelled, done);
 *  - a container with no job that has stopped.
 * A container of a running job (this worker's or another live worker's) and one whose job this org
 * does not know are left alone.
 */

import { dockerEngine, type DockerEngine } from './docker-engine.ts';
import { TOOL_OWNER_LABEL, toolOwner } from './runner.ts';

export interface SweepOptions {
  env?: Readonly<Record<string, string | undefined>>;
  engine?: DockerEngine;
  /** the job's status, or undefined when this org has no such job */
  jobStatus: (jobId: string) => Promise<string | undefined>;
}

/** Remove this runner's orphaned containers; answers the ids removed. A no-op unless `WIREHUB_TOOL_RUNNER=docker`. */
export async function sweepOrphanedToolContainers(options: SweepOptions): Promise<string[]> {
  const env = options.env ?? process.env;
  if ((env.WIREHUB_TOOL_RUNNER ?? '').trim() !== 'docker') return [];
  const engine = options.engine ?? dockerEngine(env.DOCKER_HOST?.trim() || undefined);
  if (engine.list === undefined) return [];
  const owner = toolOwner(env);
  const removed: string[] = [];
  for (const container of await engine.list({ [TOOL_OWNER_LABEL]: owner })) {
    // checked again here: never act on a container another runner labelled
    if (container.labels[TOOL_OWNER_LABEL] !== owner || container.labels['org.wirehub.tool-pack'] === undefined) continue;
    const job = container.labels['org.wirehub.job'];
    let orphaned: boolean;
    if (job === undefined) orphaned = container.state === 'exited' || container.state === 'dead';
    else {
      const status = await options.jobStatus(job);
      orphaned = status !== undefined && status !== 'running' && status !== 'queued';
    }
    if (!orphaned) continue;
    await engine.remove(container.id);
    removed.push(container.id);
  }
  return removed;
}
