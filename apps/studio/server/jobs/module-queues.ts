/**
 * Module job queues (`@wirehub/modules` `JobQueueContribution`; plan §2,
 * §3.13): the queues a module registers through an integration run as jobs of
 * kind `<module id>:<queue id>`, recorded and run exactly like the base's —
 * in the worker on Postgres, in this process on files — and offered to the
 * module's own routes as `request.jobs`.
 */

import type { ModuleJobs, ModuleRegistry } from '@wirehub/modules';

import type { StudioUser } from '../me.ts';
import { moduleSettingsFor } from '../module-settings.ts';
import type { WorkbenchDeps } from '../api.ts';
import type { JobHandlers, JobKind, JobRun, JobService } from './types.ts';

/** The job kinds of every queue the registry holds. */
export function moduleJobKinds(modules: ModuleRegistry | undefined): JobKind[] {
  return (modules?.queues() ?? []).map((q) => q.kind as JobKind);
}

/** The handlers of the registry's queues: `run` gets the request, a step reporter and the catalog as it is. */
export function moduleJobHandlers(modules: ModuleRegistry | undefined, deps: Pick<WorkbenchDeps, 'loadDb' | 'runtimeSettings'>): JobHandlers {
  const handlers: JobHandlers = {};
  for (const queue of modules?.queues() ?? []) {
    handlers[queue.kind as JobKind] = async (context) => {
      // Resolve after the job's asynchronous claim: an update uses its new handler, and a
      // disable during the claim must never call the module instance we captured earlier.
      const current = modules?.queues().find((q) => q.kind === queue.kind);
      if (current === undefined) throw new Error(`Module queue '${queue.kind}' is no longer enabled.`);
      // a module that declares settings reads them as they are now: a key saved a moment ago in
      // another process is seen even if its catalog notification has not arrived yet
      if ((modules?.module(current.module)?.settings ?? []).length > 0) await deps.runtimeSettings?.refresh();
      const result = await current.run({
        module: current.module,
        queue: current.id,
        request: context.job.request,
        step: context.step,
        db: async () => deps.loadDb(),
        settings: moduleSettingsFor(current.module, () => modules, () => deps.runtimeSettings),
      });
      return { result: result === undefined || result === null ? {} : (JSON.parse(JSON.stringify(result)) as Record<string, unknown>) };
    };
  }
  return handlers;
}

/** The scheduled queues, for the worker: kind and cron. */
export function moduleSchedules(modules: ModuleRegistry | undefined): { kind: JobKind; cron: string }[] {
  return (modules?.queues() ?? []).flatMap((q) => (q.schedule === undefined ? [] : [{ kind: q.kind as JobKind, cron: q.schedule.trim().split(/\s+/).join(' ') }]));
}

const view = (job: JobRun): ReturnType<ModuleJobs['get']> extends Promise<infer T> ? NonNullable<T> : never => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  steps: job.steps,
  ...(job.result === undefined ? {} : { result: job.result }),
  ...(job.error === undefined ? {} : { error: job.error }),
});

/** What a module's route may do with jobs: enqueue and read its own queues, nothing else. */
export function moduleJobsFor(moduleId: string, jobs: JobService | undefined, modules: ModuleRegistry | undefined, user: StudioUser | undefined): ModuleJobs | undefined {
  if (jobs === undefined) return undefined;
  const own = (modules?.queues() ?? []).filter((q) => q.module === moduleId);
  return {
    async enqueue(queue, request = {}) {
      const found = own.find((q) => q.id === queue);
      if (found === undefined) throw new Error(`module '${moduleId}' has no queue '${queue}'`);
      if (!jobs.kinds.includes(found.kind as JobKind)) throw new Error(`this studio does not run '${found.kind}' jobs`);
      const job = await jobs.enqueue(found.kind as JobKind, request, user);
      return { id: job.id, kind: job.kind, status: job.status };
    },
    async get(id) {
      const job = await jobs.get(id);
      return job !== undefined && own.some((q) => q.kind === job.kind) ? view(job) : undefined;
    },
  };
}
