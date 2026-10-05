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
import { createRegistry, defineModule } from '@wirehub/modules';
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
