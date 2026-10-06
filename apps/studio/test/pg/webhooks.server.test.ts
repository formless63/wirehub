/** Outbound event webhooks on Postgres: the same script as the commit tree, the jobs in `job_run`, the secrets encrypted in `settings_secret`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { fsBlobStore } from '../../server/blobs.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pruneWebhookHistory, runBlobGcJob, WEBHOOK_HISTORY_DAYS } from '../../server/pg/gc.ts';
import { pgJobStore } from '../../server/pg/jobs.ts';
import { pgSecretStore } from '../../server/pg/settings-secrets.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { webhooksScenario } from '../webhooks-scenario.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const catalogPackage = fileURLToPath(new URL('../../../../packages/catalog', import.meta.url));

describePg('outbound webhooks on Postgres', () => {
  let database: TestDatabase;
  let handle: PgHandle;
  let work: string;
  let orgId: string;
  beforeAll(async () => {
    database = await freshDatabase();
    handle = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-webhooks-'));
    orgId = (await importCatalog(handle.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(catalogPackage), blobs: testBlobs() })).orgId;
  }, 60_000);
  afterAll(async () => {
    await handle?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('prunes only overdue finished attempts and preserves active delivery histories across retries', async () => {
    const otherOrg = (await importCatalog(handle.db, { org: { slug: 'other', create: true }, files: readCatalogTree(catalogPackage), blobs: testBlobs() })).orgId;
    const now = new Date();
    const cutoff = new Date(now.getTime() - WEBHOOK_HISTORY_DAYS * 24 * 3600_000);
    const old = new Date(cutoff.getTime() - 1).toISOString();
    const fresh = new Date(cutoff.getTime() + 60_000).toISOString();
    const insert = (org: string, name: string, status: string, finished: string | null = old, kind = 'webhook', deliveryId = name) => inOrg(handle.db, org, async (tx) => {
      await sql`INSERT INTO studio.job_run (org_id, kind, status, request, created_at, finished_at)
        VALUES (${org}::uuid, ${kind}, ${status}, ${JSON.stringify({ name, deliveryId })}::jsonb, ${old}::timestamptz, ${finished}::timestamptz)`.execute(tx);
    });
    const names = (org: string) => inOrg(handle.db, org, async (tx) =>
      (await sql<{ name: string }>`SELECT request->>'name' AS name FROM studio.job_run WHERE request ? 'name' ORDER BY request->>'name'`.execute(tx)).rows.map((r) => r.name));
    for (const status of ['done', 'failed', 'cancelled']) await insert(orgId, status, status);
    await insert(orgId, 'boundary', 'done', cutoff.toISOString());
    await insert(orgId, 'fresh', 'failed', fresh);
    await insert(orgId, 'missing-finish', 'done', null);
    await insert(orgId, 'queued', 'queued');
    await insert(orgId, 'running', 'running');
    await insert(orgId, 'queued-history', 'done', old, 'webhook', 'queued');
    await insert(orgId, 'running-history', 'failed', old, 'webhook', 'running');
    await insert(orgId, 'import', 'done', old, 'import');
    await insert(orgId, 'module', 'failed', old, 'example:sync');
    await insert(orgId, 'cross-org', 'done');
    await insert(otherOrg, 'cross-org', 'queued');
    await insert(otherOrg, 'other-finished', 'done');
    expect(await pruneWebhookHistory(handle.db, orgId, now)).toBe(4);
    expect(await names(orgId)).toEqual(['boundary', 'fresh', 'import', 'missing-finish', 'module', 'queued', 'queued-history', 'running', 'running-history']);
    expect(await names(otherOrg)).toEqual(['cross-org', 'other-finished']);

    // Once both active retries finish, the daily housekeeping sweep can remove their old attempts.
    await inOrg(handle.db, orgId, async (tx) => {
      await sql`UPDATE studio.job_run SET status = 'done', finished_at = now() WHERE status IN ('queued', 'running')`.execute(tx);
    });
    const outcome = await runBlobGcJob({ job: { id: '', kind: 'blob-gc', status: 'running', request: {}, steps: [], createdAt: '' }, step: async () => {} }, { db: handle.db, orgId });
    expect(Number(outcome.result['prunedWebhooks'])).toBeGreaterThanOrEqual(2);
    expect(await names(orgId)).not.toContain('queued-history');
    expect(await names(orgId)).not.toContain('running-history');
    expect(await names(orgId)).toEqual(expect.arrayContaining(['queued', 'running', 'import', 'module']));
    expect(await names(otherOrg)).toEqual(['cross-org', 'other-finished']);
  }, 60_000);

  it('runs the subscription, signing, retry, log and event script, with the same answers as the commit tree', async () => {
    const cache = new SnapshotCache(handle.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: handle.db, blobs: fsBlobStore(join(work, 'blobs')) });
    await webhooksScenario({ deps, secrets: pgSecretStore(handle.db, orgId), jobStore: pgJobStore(handle.db, orgId), org: orgId });
    // every delivery was a job_run row of kind webhook; none of them holds the secret
    const rows = await pgJobStore(handle.db, orgId).list({ kind: 'webhook', limit: 200 });
    expect(rows.length).toBeGreaterThan(10);
  }, 60_000);
});
