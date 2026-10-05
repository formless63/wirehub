/**
 * Webhook deliveries through the worker (pg-boss): the studio queues a delivery, the worker
 * signs and sends it, a failing receiver is retried after the backoff by the queue, and a job
 * the worker finishes is announced. The receiver is a real HTTP server on a spare local port.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { fsBlobStore } from '../../server/blobs.ts';
import { openPg } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { bossJobRunner, pgJobStore, startBoss } from '../../server/pg/jobs.ts';
import { pgSecretStore } from '../../server/pg/settings-secrets.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { createJobService } from '../../server/jobs/service.ts';
import { createRuntimeSettings } from '../../server/runtime-settings.ts';
import { settingsCipher } from '../../server/settings-secrets.ts';
import { UnitOfWork } from '../../server/storage/unit-of-work.ts';
import { startWorker } from '../../server/worker-run.ts';
import { createWebhookEmitter } from '../../server/webhooks/emitter.ts';
import { verifySignature } from '../../server/webhooks/signature.ts';
import { putSecret, WEBHOOKS_PATH, WEBHOOKS_SRC } from '../../server/webhooks/subscriptions.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const catalogPackage = fileURLToPath(new URL('../../../../packages/catalog', import.meta.url));
const KEY = 'w'.repeat(43);
/** a spare local port of this run's range (127.0.0.1:5580-5589) */
const PORT = Number(process.env.WIREHUB_TEST_WEBHOOK_PORT ?? 5581);

describePg('webhook deliveries through the worker', () => {
  let database: TestDatabase;
  let work: string;
  let receiver: Server;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let status = 200;

  beforeAll(async () => {
    database = await freshDatabase();
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-webhook-worker-'));
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((done) => receiver.listen(PORT, '127.0.0.1', done));
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((done) => (receiver === undefined ? done() : receiver.close(() => done())));
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('sends signed, retries after the backoff, and announces a finished job', async () => {
    const handle = openPg(database.appUrl, { max: 4 });
    const { orgId } = await importCatalog(handle.db, { org: { slug: 'worker-hooks', create: true }, files: readCatalogTree(catalogPackage), blobs: testBlobs() });
    const blobs = fsBlobStore(join(work, 'blobs'));
    mkdirSync(join(work, 'beat-dir'), { recursive: true });
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(handle.db, orgId, { reuseMs: 0 }), db: handle.db, blobs });
    // the studio side: the subscription (a catalog document), its secret (encrypted), and a queue to the worker
    const settings = createRuntimeSettings({ env: {}, docs: () => deps.docs, secrets: () => pgSecretStore(handle.db, orgId), org: () => orgId, cipher: settingsCipher(KEY), log: () => {} });
    const uow = new UnitOfWork(deps);
    await uow.deps.docs!.write(WEBHOOKS_PATH, { subscriptions: [{ id: 'wh-0a0b0c0d', url: `http://127.0.0.1:${PORT}/hook`, events: ['job.finished', 'design.saved'], enabled: true }], src: WEBHOOKS_SRC });
    await uow.commit({ method: 'PUT', path: '/api/settings/webhooks' });
    await putSecret(settings, 'wh-0a0b0c0d', 'a-signing-secret-of-enough-length');
    const boss = await startBoss(database.appUrl, 'studio');
    const jobs = createJobService({ store: pgJobStore(handle.db, orgId), runner: bossJobRunner(async () => boss, () => orgId), kinds: ['webhook', 'derive'] });
    const emitter = createWebhookEmitter({ docs: () => deps.docs, jobs: () => jobs, env: () => ({}) });

    const logs: string[] = [];
    const worker = await startWorker({ env: { DATABASE_URL: database.appUrl, WIREHUB_SETTINGS_KEY: KEY, WIREHUB_WEBHOOK_BACKOFF: '1,1,1,1,1', WIREHUB_WORKER_BEAT_FILE: join(work, 'beat'), TZ: 'UTC' }, blobs, log: (l) => logs.push(l), attempts: 2 });
    try {
      expect(worker).toBeDefined();
      expect(worker!.kinds).toContain('webhook');
      // the boot sweep's own jobs finish and are announced; start from a quiet log
      const quiet = async (): Promise<void> => {
        let last = -1;
        while (last !== received.length) {
          last = received.length;
          await new Promise((done) => setTimeout(done, 1500));
        }
      };
      await quiet();
      received.length = 0;

      // a delivery the receiver refuses once: retried after the backoff, then delivered, one delivery id
      status = 503;
      const id = await emitter.emit([{ type: 'design.saved', subject: { kind: 'design', id: 'de9-crossover', label: 'x' }, summary: { action: 'updated' } }], {});
      void id;
      const deadline = Date.now() + 40_000;
      while (received.filter((r) => r.headers['x-wirehub-event'] === 'design.saved').length < 1 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
      status = 200;
      while (received.filter((r) => r.headers['x-wirehub-event'] === 'design.saved').length < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
      const saved = received.filter((r) => r.headers['x-wirehub-event'] === 'design.saved');
      expect(saved.length, logs.join('\n')).toBe(2);
      expect(new Set(saved.map((r) => r.headers['x-wirehub-delivery'])).size).toBe(1);
      for (const r of saved) expect(verifySignature('a-signing-secret-of-enough-length', r.body, r.headers['x-wirehub-signature'] as string, Math.floor(Date.now() / 1000))).toBe(true);

      // a job the worker runs is announced by the worker
      received.length = 0;
      await jobs.enqueue('derive', { reason: 'test' });
      const until = Date.now() + 40_000;
      const ofDerive = (r: { headers: IncomingMessage['headers']; body: string }): boolean => r.headers['x-wirehub-event'] === 'job.finished' && (JSON.parse(r.body) as { subject: { label: string } }).subject.label === 'derive';
      while (!received.some(ofDerive) && Date.now() < until) await new Promise((done) => setTimeout(done, 250));
      const finished = received.find(ofDerive);
      expect(finished, logs.join('\n')).toBeDefined();
      expect(JSON.parse(finished!.body)).toMatchObject({ type: 'job.finished', subject: { kind: 'job', label: 'derive' }, summary: { job: 'derive' } });

      // the log: every attempt is a job_run row of kind webhook
      const attempts = await pgJobStore(handle.db, orgId).list({ kind: 'webhook', limit: 50 });
      expect(attempts.some((a) => a.result?.['state'] === 'retrying')).toBe(true);
      expect(attempts.some((a) => a.result?.['state'] === 'delivered')).toBe(true);
    } finally {
      await worker?.stop();
      await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
      await handle.close();
    }
  }, 180_000);
});
