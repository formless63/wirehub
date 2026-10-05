/**
 * Module job queues (`docs/modules.md`, "Job queues"; plan §3.13): a queue an
 * integration registers runs as a job of kind `<module>:<queue>`, in this
 * process on files, and is started and read through the module's own routes
 * (`request.jobs`) or `POST /api/jobs`. The same module on Postgres, through
 * the worker: `test/pg/module-queues.server.test.ts`.
 */

import { join } from 'node:path';

import { example } from '@wirehub/module-example';
import { createRegistry, defineModule } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { moduleJobHandlers, moduleJobKinds, moduleSchedules } from '../server/jobs/module-queues.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data', '..');

function withJobs(registry: ReturnType<typeof createRegistry>): { deps: WorkbenchDeps; jobs: ReturnType<typeof createJobService> } {
  const backend = memoryWriteBackend(registry, DATA);
  const deps = backend.deps;
  const store = memoryJobStore();
  const jobs = createJobService({
    store,
    runner: inlineJobRunner(store, () => ({ ...baseJobHandlers({ deps }), ...moduleJobHandlers(registry, deps) }), () => undefined),
    kinds: ['import', ...moduleJobKinds(registry)],
    pollMs: 20,
  });
  deps.jobs = jobs;
  return { deps, jobs };
}

const call = async (deps: WorkbenchDeps, method: string, path: string, body?: unknown) =>
  (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };

describe('module job queues on the file backend', () => {
  it('runs the example module queue: enqueued from its route, recorded as example:recount, steps and result kept', async () => {
    const { deps, jobs } = withJobs(createRegistry([example]));
    expect(jobs.kinds).toContain('example:recount');
    const started = await call(deps, 'POST', '/api/modules/example/recount', { only: 'connectors' });
    expect(started.status).toBe(202);
    const { id, kind } = started.body.job as { id: string; kind: string };
    expect(kind).toBe('example:recount');
    expect((await jobs.wait(id, 10_000)).status).toBe('done');
    const read = await call(deps, 'GET', `/api/modules/example/recount?id=${id}`);
    expect(read.status).toBe(200);
    expect(read.body.job).toMatchObject({ status: 'done', kind: 'example:recount', steps: [{ text: expect.stringMatching(/^connectors: \d+$/) }], result: { counts: { connectors: expect.any(Number) } } });
    expect(Object.keys(read.body.job.result.counts)).toEqual(['connectors']);
    // the job list shows it, by kind
    const listed = await call(deps, 'GET', '/api/jobs?kind=example:recount');
    expect(listed.status).toBe(200);
    expect(listed.body.jobs.map((j: { id: string }) => j.id)).toEqual([id]);
    expect(listed.body.kinds).toContain('example:recount');
  });

  it('starts a module queue by hand through POST /api/jobs, and refuses a queue nobody registered', async () => {
    const { deps, jobs } = withJobs(createRegistry([example]));
    const manual = await call(deps, 'POST', '/api/jobs', { kind: 'example:recount' });
    expect(manual.status).toBe(202);
    const done = await jobs.wait(manual.body.job.id, 10_000);
    expect(done).toMatchObject({ status: 'done', request: { reason: 'requested' } });
    expect(Object.keys((done.result as { counts: object }).counts)).toEqual(['connectors', 'wires', 'components', 'pcbas', 'mechanicals']);
    expect((await call(deps, 'POST', '/api/jobs', { kind: 'example:nope' })).status).toBe(501);
    expect((await call(deps, 'POST', '/api/jobs', { kind: 'not a kind' })).status).toBe(400);
  });

  it('fails a job whose run throws, with the message, and keeps a module out of other modules\' jobs', async () => {
    const boom = defineModule({
      id: 'boom',
      label: 'Boom',
      version: '1.0.0',
      integrations: [
        {
          id: 'b',
          label: 'B',
          queues: [{ id: 'explode', label: 'Explode', schedule: '30  2 * * *', run: async () => { throw new Error('the ERP said no'); } }],
          routes: [{ method: 'GET', path: 'peek', handle: async (request) => ({ status: 200, body: { job: (await request.jobs?.get(request.query.get('id') ?? '')) ?? null } }) }],
        },
      ],
    });
    const { deps, jobs } = withJobs(createRegistry([example, boom]));
    expect(moduleSchedules(createRegistry([boom]))).toEqual([{ kind: 'boom:explode', cron: '30 2 * * *' }]);
    const job = await jobs.enqueue('boom:explode', {});
    expect(await jobs.wait(job.id, 10_000)).toMatchObject({ status: 'failed', error: 'the ERP said no' });
    // boom's route reads boom's jobs; example's queue is not its to read
    expect((await call(deps, 'GET', `/api/modules/boom/peek?id=${job.id}`)).body.job).toMatchObject({ status: 'failed' });
    const other = await jobs.enqueue('example:recount', {});
    await jobs.wait(other.id, 10_000);
    expect((await call(deps, 'GET', `/api/modules/boom/peek?id=${other.id}`)).body.job).toBeNull();
  });

  it('enqueues nothing on a queue the module does not have', async () => {
    const registry = createRegistry([example]);
    const { moduleJobsFor } = await import('../server/jobs/module-queues.ts');
    const { jobs } = withJobs(registry);
    await expect(moduleJobsFor('example', jobs, registry, undefined)!.enqueue('nope')).rejects.toThrow(/no queue 'nope'/);
    expect(moduleJobsFor('example', undefined, registry, undefined)).toBeUndefined();
  });
});
