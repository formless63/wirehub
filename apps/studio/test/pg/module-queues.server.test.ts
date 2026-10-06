/**
 * A module's job queue on Postgres (plan §3.13): registered through an
 * integration, its pg-boss queue is made, the worker runs it, the job is a
 * `job_run` row of kind `<module>:<queue>`, and the studio's side (the
 * module's own route, `request.jobs`) enqueues and reads it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createLiveRegistry, createRegistry, defineModule } from '@wirehub/modules';
import { afterAll, expect, it } from 'vitest';

import { describePg, freshDatabase, testBlobs } from './harness.ts';

const work = mkdtempSync(join(tmpdir(), 'wirehub-pg-queues-'));
const catalogPackage = fileURLToPath(new URL('../../../../packages/catalog', import.meta.url));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const quiet = (): void => {};

const tally = defineModule({
  id: 'tally',
  label: 'Tally',
  version: '1.0.0',
  integrations: [
    {
      id: 't',
      label: 'T',
      queues: [
        {
          id: 'count',
          label: 'Count',
          schedule: '0 5 * * *',
          run: async (context) => {
            await context.step('counting');
            return { connectors: (await context.db()).connectors.length, asked: context.request['n'] ?? null };
          },
        },
      ],
    },
  ],
});

describePg('a module queue on Postgres', () => {
  it('adds, updates and drains removed module queues live while preserving core jobs', async () => {
    const own = await freshDatabase();
    const registry = createLiveRegistry(createRegistry([]));
    const { openPg } = await import('../../server/pg/db.ts');
    const { importCatalog } = await import('../../server/pg/import.ts');
    const { fsBlobStore } = await import('../../server/blobs.ts');
    const { lastBeat } = await import('../../server/pg/jobs.ts');
    const { startWorker } = await import('../../server/worker-run.ts');
    const handle = openPg(own.appUrl, { max: 4 });
    const blobs = fsBlobStore(join(work, 'live-blobs'));
    const { orgId } = await importCatalog(handle.db, { org: { slug: 'live-queues', create: true }, files: readCatalogTree(catalogPackage), blobs });
    const worker = await startWorker({ env: { DATABASE_URL: own.appUrl, WIREHUB_WORKER_BEAT_FILE: join(work, 'live-beat'), TZ: 'UTC' }, modules: registry, builtins: [], blobs, log: quiet, attempts: 2 });
    let release: (() => void) | undefined;
    try {
      const core = [...worker!.kinds];
      registry.replace(createRegistry([tally]));
      await expect.poll(() => worker!.schedules()['tally:count'], { timeout: 20_000 }).toBe('0 5 * * *');
      expect(worker!.kinds).toContain('tally:count');
      await expect.poll(async () => (await lastBeat(handle.db, orgId))?.queues, { timeout: 10_000 }).toContain('tally:count');
      const first = await worker!.jobs.enqueue('tally:count', { n: 7 });
      expect(await worker!.jobs.wait(first.id, 30_000)).toMatchObject({ status: 'done', result: { asked: 7 } });

      registry.replace(createRegistry([defineModule({ ...tally, version: '1.1.0', integrations: [{ id: 't', label: 'T', queues: [{ id: 'count', label: 'Count', schedule: '0 6 * * *', run: async () => ({ updated: true }) }] }] })]));
      await expect.poll(() => worker!.schedules()['tally:count'], { timeout: 20_000 }).toBe('0 6 * * *');
      const updated = await worker!.jobs.enqueue('tally:count', {});
      expect(await worker!.jobs.wait(updated.id, 30_000)).toMatchObject({ status: 'done', result: { updated: true } });

      // A running job finishes on disable; the delayed queued job must never call old code.
      const blocked = new Promise<void>((done) => { release = done; });
      let executions = 0;
      registry.replace(createRegistry([defineModule({ ...tally, version: '1.2.0', integrations: [{ id: 't', label: 'T', queues: [{ id: 'count', label: 'Count', run: async () => { executions += 1; await blocked; return { drained: true }; } }] }] })]));
      await expect.poll(() => worker!.schedules()['tally:count'], { timeout: 20_000 }).toBeUndefined();
      const active = await worker!.jobs.enqueue('tally:count', {});
      await expect.poll(() => executions, { timeout: 20_000 }).toBe(1);
      const pending = await worker!.jobs.enqueue('tally:count', {}, undefined, { delayMs: 60_000 });
      registry.replace(createRegistry([]));
      await expect(worker!.jobs.enqueue('tally:count', {})).rejects.toThrow(/does not run/);
      await expect.poll(async () => (await worker!.jobs.get(pending.id))?.status, { timeout: 20_000 }).toBe('cancelled');
      release!();
      expect(await worker!.jobs.wait(active.id, 30_000)).toMatchObject({ status: 'done', result: { drained: true } });
      await expect.poll(() => [...worker!.kinds], { timeout: 20_000 }).toEqual(core);
      await expect.poll(async () => (await lastBeat(handle.db, orgId))?.queues, { timeout: 10_000 }).toEqual(core);
      expect(executions).toBe(1);
      // Re-enable works without reviving the cancelled pending record.
      registry.replace(createRegistry([tally]));
      await expect.poll(() => worker!.schedules()['tally:count'], { timeout: 20_000 }).toBe('0 5 * * *');
      const restored = await worker!.jobs.enqueue('tally:count', { n: 8 });
      expect(await worker!.jobs.wait(restored.id, 30_000)).toMatchObject({ status: 'done', result: { asked: 8 } });
      expect((await worker!.jobs.get(pending.id))?.status).toBe('cancelled');
    } finally {
      release?.();
      await worker?.stop();
      await handle.close();
      await own.drop();
    }
  }, 180_000);

  it('is worked by the worker, enqueued from the studio side, and recorded as <module>:<queue>', async () => {
    const own = await freshDatabase();
    const registry = createRegistry([tally]);
    const { openPg } = await import('../../server/pg/db.ts');
    const { importCatalog } = await import('../../server/pg/import.ts');
    const { SnapshotCache } = await import('../../server/pg/snapshot.ts');
    const { pgWorkbenchDeps } = await import('../../server/pg/deps.ts');
    const { fsBlobStore } = await import('../../server/blobs.ts');
    const { createJobService } = await import('../../server/jobs/service.ts');
    const { moduleJobKinds } = await import('../../server/jobs/module-queues.ts');
    const { bossJobRunner, lastBeat, pgJobStore, startBoss } = await import('../../server/pg/jobs.ts');
    const { startWorker } = await import('../../server/worker-run.ts');
    const { handleWorkbenchRequest } = await import('../../server/api.ts');
    const handle = openPg(own.appUrl, { max: 4 });
    const { orgId } = await importCatalog(handle.db, { org: { slug: 'queues', create: true }, files: readCatalogTree(catalogPackage), blobs: testBlobs() });
    const blobs = fsBlobStore(join(work, 'blobs'));
    const cache = new SnapshotCache(handle.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: handle.db, blobs, modules: registry });
    const logs: string[] = [];
    const worker = await startWorker({ env: { DATABASE_URL: own.appUrl, WIREHUB_WORKER_BEAT_FILE: join(work, 'beat'), TZ: 'UTC' }, modules: registry, blobs, log: (l) => logs.push(l), attempts: 2 });
    let boss: Awaited<ReturnType<typeof startBoss>> | undefined;
    try {
      expect(worker!.kinds).toContain('tally:count');
      expect((await lastBeat(handle.db, orgId))?.queues).toContain('tally:count');
      expect(logs.join('\n')).toContain('tally:count "0 5 * * *"');
      boss = await startBoss(own.appUrl, 'studio', quiet, moduleJobKinds(registry));
      const started = boss;
      const store = pgJobStore(handle.db, orgId);
      deps.jobs = createJobService({ store, runner: bossJobRunner(async () => started, () => orgId), kinds: ['import', ...moduleJobKinds(registry)], pollMs: 100 });
      const answer = await handleWorkbenchRequest({ method: 'POST', path: '/api/jobs', body: { kind: 'tally:count' } }, deps);
      expect(answer.status).toBe(202);
      const id = (answer.body as { job: { id: string } }).job.id;
      const done = await deps.jobs.wait(id, 60_000);
      expect(done, logs.join('\n')).toMatchObject({ kind: 'tally:count', status: 'done', steps: [{ text: 'counting' }], result: { asked: null } });
      expect((done.result as { connectors: number }).connectors).toBeGreaterThan(0);
    } finally {
      await boss?.stop({ graceful: false }).catch(() => undefined);
      await worker?.stop();
      await handle.close();
      await own.drop();
    }
  }, 180_000);
});
