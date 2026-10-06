/**
 * The import and the S1 gate on Postgres (tasks A4, A5, A6, A7, A9): every
 * catalog imported into an org of its own and compared with its files —
 * the starter (also against the real file stores), the frozen fixture
 * catalog, the starter with every bundled pack installed, and a synthetic
 * catalog at the S4 size with every file kind the codec maps.
 *
 * Also: a pg studio is read-only until Phase B (writes answer 503 and leave
 * the database untouched), the snapshot follows the head version, and the
 * export round-trips.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath, fixtureCatalogRoot } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { fsBlobStore, type BlobStore } from '../../server/blobs.ts';
import { defaultWorkbenchDeps } from '../../server/default-deps.ts';
import { checkDatabase, openPgBackend, pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { exportSnapshot } from '../../server/pg/export.ts';
import { formatGateReport, runGate } from '../../server/pg/gate.ts';
import { ImportError, importCatalog } from '../../server/pg/import.ts';
import { loadSnapshot, SnapshotCache } from '../../server/pg/snapshot.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';
import { starterWithPacks, syntheticCatalog } from './synthetic.ts';

describePg('import and the S1 gate', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let blobs: BlobStore;
  let work: string;
  const orgs = new Map<string, string>();

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-gate-'));
    blobs = fsBlobStore(join(work, 'blobs'));
  });
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  async function importAndGate(slug: string, root: string, filesDeps?: ReturnType<typeof defaultWorkbenchDeps>): Promise<void> {
    const tree = readCatalogTree(root);
    const report = await importCatalog(pgh.db, { org: { slug, create: true }, files: tree, blobs });
    orgs.set(slug, report.orgId);
    expect(report.version).toBe('1');
    const gate = await runGate({ tree, root, pg: { db: pgh.db, cache: new SnapshotCache(pgh.db, report.orgId), blobs }, ...(filesDeps === undefined ? {} : { filesDeps }) });
    // the report is the evidence the phase review reads
    console.log(`[gate ${slug}] ${tree.size} files\n${formatGateReport(gate)}`);
    expect(gate.checks.filter((c) => c.diffs.length > 0)).toEqual([]);
    expect(gate.ok).toBe(true);
  }

  it('the starter catalog — against the real file stores too', async () => {
    await importAndGate('starter', dataPath('..'), defaultWorkbenchDeps());
  }, 120_000);

  it('the fixture catalog', async () => {
    await importAndGate('fixture', fixtureCatalogRoot());
  }, 120_000);

  it('the starter with every bundled module pack installed', async () => {
    await importAndGate('packs', starterWithPacks(join(work, 'packs')));
  }, 120_000);

  it('a synthetic catalog of 100 designs and 1,000 definitions with every file kind', async () => {
    const root = syntheticCatalog(join(work, 'synthetic'));
    await importAndGate('synthetic', root);
    const orgId = orgs.get('synthetic') as string;
    // S4: measure every rebuild in CI; enforce the 150 ms p95 budget only on an
    // isolated performance run (WIREHUB_TEST_S4=1), where competing suites cannot
    // turn CPU/DB scheduling delays into a snapshot performance regression.
    const times: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const started = performance.now();
      const snapshot = await loadSnapshot(pgh.db, orgId);
      const db = snapshot.catalog.loadDb();
      times.push(performance.now() - started);
      expect(snapshot.catalog.loadDesigns()).toHaveLength(100);
      expect([db.connectors, db.components, db.wires, db.pcbas, db.bodies, db.interfaces, db.mechanicals, db.kits]
        .reduce((n, definitions) => n + (definitions?.length ?? 0), 0)).toBe(1000);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] as number;
    console.log(`[S4] snapshot rebuild + loadDb, 100 designs / 1,000 definitions: p50 ${times[7]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    if (process.env['WIREHUB_TEST_S4'] === '1') expect(p95, 'S4 snapshot rebuild p95 budget (isolated run)').toBeLessThanOrEqual(150);
  }, 300_000);

  it('refuses a catalog the codec cannot map, and a second import into the same org', async () => {
    const files = new Map<string, string | Uint8Array>([['data/connectors.json', '[{"id":"x"}]']]);
    await expect(importCatalog(pgh.db, { org: { slug: 'bad', create: true }, files })).rejects.toThrow(ImportError);
    await expect(importCatalog(pgh.db, { org: { slug: 'starter' }, files: readCatalogTree(dataPath('..')), blobs })).rejects.toThrow(/already holds a catalog/);
  });

  it('records the import as one change set, with reference edges', async () => {
    const orgId = orgs.get('packs') as string;
    await inOrg(pgh.db, orgId, async (tx) => {
      const sets = (await sql<{ source: string; catalog_version: string; changes: string }>`
        SELECT s.source, s.catalog_version::text AS catalog_version, (SELECT count(*)::text FROM studio.change c WHERE c.change_set_id = s.id) AS changes
          FROM studio.change_set s`.execute(tx)).rows;
      expect(sets.length).toBe(1);
      expect(sets[0]?.source).toBe('import');
      expect(Number(sets[0]?.changes)).toBeGreaterThan(30);
      const edges = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.ref_edge`.execute(tx)).rows[0]?.n;
      expect(Number(edges)).toBeGreaterThan(30);
      // nothing written outside the change set
      const unattributed = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.audit_log WHERE change_set_id IS NULL AND org_id = ${orgId}::uuid`.execute(tx)).rows[0]?.n;
      expect(unattributed).toBe('0');
    });
  });

  it('serves read-only: a write answers 503 and the database is untouched', async () => {
    const orgId = orgs.get('starter') as string;
    const cache = new SnapshotCache(pgh.db, orgId);
    const deps = pgWorkbenchDeps({ cache, blobs });
    const before = await cache.version();
    const got = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/de9-crossover' }, deps);
    expect(got.status).toBe(200);
    const design = got.body as { label: string };
    const put = await handleWorkbenchRequest(
      { method: 'PUT', path: '/api/designs/de9-crossover', body: { ...design, label: `${design.label} (edited)` }, headers: { 'if-match': got.headers?.ETag ?? '' } },
      deps,
    );
    expect(put.status).toBe(503);
    expect(await cache.version()).toBe(before);
  });

  it('exports the snapshot byte for byte, and follows the head version', async () => {
    const orgId = orgs.get('starter') as string;
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const exported = exportSnapshot(await cache.get());
    const tree = readCatalogTree(dataPath('..'));
    // the export's `files` are the text files; the binary ones (depiction art) are in its `blobs`
    const text = [...tree].filter(([, content]) => typeof content === 'string');
    expect(Object.keys(exported.files).length).toBe(text.length);
    expect(Object.keys(exported.blobs).length).toBe(tree.size - text.length);
    for (const [path, text] of Object.entries(exported.files)) expect(text, path).toBe(tree.get(path));
    const viaApi = await handleWorkbenchRequest({ method: 'GET', path: '/api/export' }, pgWorkbenchDeps({ cache, blobs }));
    expect((viaApi.body as { files: Record<string, string> }).files).toEqual(exported.files);
    // a version bump (a commit elsewhere) reloads the snapshot
    const first = await cache.get();
    const owner = openPg(database.ownerUrl, { max: 1 });
    try {
      // the owner bumps the head (as a commit would); RLS needs the org set even for the owner
      await inOrg(owner.db, orgId, async (tx) => void (await sql`UPDATE studio.catalog_head SET version = version + 1`.execute(tx)));
    } finally {
      await owner.close();
    }
    const second = await cache.get();
    expect(second).not.toBe(first);
    expect(BigInt(second.version)).toBe(BigInt(first.version) + 1n);
  });

  it('opens from the environment and refuses an unmigrated database', async () => {
    const backend = await openPgBackend({ DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter' }, { blobs, listen: true });
    try {
      const response = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs' }, backend.deps);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).toContain('de9-crossover');
      await checkDatabase(backend.handle.db, backend.cache.orgId);
    } finally {
      await backend.close();
    }
    await expect(openPgBackend({ DATABASE_URL: database.appUrl })).rejects.toThrow(/more than one org/);
  });
});
