/**
 * Change history on Postgres (cs-5k1.4): the scripted session of
 * `history-scenario.ts` against a pg studio holding the starter catalog —
 * the same answers the git catalog gives — plus what only the database
 * keeps: each change's earlier state (`change.before_body`, 0017), the
 * import's change set at the start of the list, and row-level security (one
 * org never sees another's history).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { fsBlobStore, type BlobStore } from '../../server/blobs.ts';
import { pgHistorySource } from '../../server/history/pg.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { DESIGN, historyScenario } from '../history-scenario.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

describePg('change history on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let blobs: BlobStore;
  let work: string;
  let orgId: string;
  let otherOrg: string;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-history-'));
    blobs = fsBlobStore(join(work, 'blobs'));
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    otherOrg = (await importCatalog(pgh.db, { org: { slug: 'other', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('lists, diffs, filters and restores through the change sets', async () => {
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId), db: pgh.db, blobs });
    expect((await deps.history!.capabilities()).backend).toBe('database');
    await historyScenario({ deps });

    // the oldest entry is the import, and nothing was rewritten: one change set per save, in order
    const all = await deps.history!.list({ limit: 200 });
    expect(all.entries[all.entries.length - 1]?.source).toBe('import');
    expect(all.entries.map((e) => Number(e.version))).toEqual([...all.entries.map((e) => Number(e.version))].sort((a, b) => b - a));
    expect(all.entries[0]?.by).toEqual({ name: 'Carol Example', email: 'carol@example.com' });

    await inOrg(pgh.db, orgId, async (tx) => {
      // every design save recorded the design as it was before it
      const rows = (await sql<{ before: string | null; message: string }>`
        SELECT c.before_body::text AS before, s.message FROM studio.change c JOIN studio.change_set s ON s.id = c.change_set_id
         WHERE c.kind = 'design' AND c.key = ${DESIGN} ORDER BY s.id`.execute(tx)).rows;
      expect(rows.length).toBe(4);
      expect(rows.every((r) => r.before !== null && r.before !== 'null')).toBe(true);
      // a restore is a change set like any other: attributed, with its message
      expect(rows[2]?.message).toMatch(/^studio: restore design dc-led-lead to change \d+\n/);
    });
  }, 120_000);

  it('a new record records JSON null as its earlier state', async () => {
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId), db: pgh.db, blobs });
    const { handleWorkbenchRequest } = await import('../../server/api.ts');
    const design = (await handleWorkbenchRequest({ method: 'GET', path: `/api/designs/${DESIGN}` }, deps)).body as { id: string; label: string };
    const created = await handleWorkbenchRequest({ method: 'POST', path: '/api/designs', body: { ...design, id: 'history-new-design', label: 'A new one' } }, deps);
    expect(created.status).toBe(201);
    await inOrg(pgh.db, orgId, async (tx) => {
      const row = (await sql<{ before: string | null }>`SELECT before_body::text AS before FROM studio.change WHERE kind = 'design' AND key = 'history-new-design'`.execute(tx)).rows[0];
      expect(row?.before).toBe('null');
    });
    const page = await deps.history!.record({ type: 'design', id: 'history-new-design' }, { limit: 10 });
    expect(page.entries.length).toBe(1);
    const detail = await deps.history!.detail(page.entries[0]!.id, { type: 'design', id: 'history-new-design' });
    expect(detail?.records.find((r) => r.part === 'design')?.op).toBe('added');
    // to before it existed is not a restore: delete it instead
    const refused = await handleWorkbenchRequest({ method: 'POST', path: `/api/history/records/design%3Ahistory-new-design/restore`, body: { entry: String(BigInt(page.entries[0]!.id) - 1n), current: {} } }, deps);
    expect(refused.status).toBe(409);
  });

  it('row-level security: an org sees its own history only', async () => {
    const mine = await pgHistorySource(pgh.db, orgId).list({ limit: 500 });
    const theirs = await pgHistorySource(pgh.db, otherOrg).list({ limit: 500 });
    expect(theirs.entries.map((e) => e.source)).toEqual(['import']);
    expect(mine.entries.some((e) => e.id === theirs.entries[0]?.id)).toBe(false);
    // another org's change set is not found, not leaked
    expect(await pgHistorySource(pgh.db, otherOrg).detail(mine.entries[0]!.id)).toBeUndefined();
    expect(await pgHistorySource(pgh.db, otherOrg).stateAt({ type: 'design', id: DESIGN }, mine.entries[0]!.id)).toBeUndefined();
  });
});
