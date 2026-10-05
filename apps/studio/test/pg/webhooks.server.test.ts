/** Outbound event webhooks on Postgres: the same script as the commit tree, the jobs in `job_run`, the secrets encrypted in `settings_secret`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { fsBlobStore } from '../../server/blobs.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { importCatalog } from '../../server/pg/import.ts';
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

  it('runs the subscription, signing, retry, log and event script, with the same answers as the commit tree', async () => {
    const cache = new SnapshotCache(handle.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: handle.db, blobs: fsBlobStore(join(work, 'blobs')) });
    await webhooksScenario({ deps, secrets: pgSecretStore(handle.db, orgId), jobStore: pgJobStore(handle.db, orgId), org: orgId });
    // every delivery was a job_run row of kind webhook; none of them holds the secret
    const rows = await pgJobStore(handle.db, orgId).list({ kind: 'webhook', limit: 200 });
    expect(rows.length).toBeGreaterThan(10);
  }, 60_000);
});
