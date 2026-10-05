/**
 * Preview, the file backend and Postgres agree about a pack (cs-s97, cs-7ee, cs-e7d, cs-lx8):
 * a pack that previews as applicable applies on Postgres, what the API installed is what
 * `adopt` takes, and the S1 gate's `api-parity-file-stores` passes for a hub whose pack
 * supplies builds, drawing sidecars, saved versions, revision model links and art.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree, readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { defaultWorkbenchDeps } from '../../server/default-deps.ts';
import { adoptFileCatalog } from '../../server/pg/adopt.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { formatGateReport, runGate } from '../../server/pg/gate.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { parityHub } from '../pack-parity-fixture.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const SRC = 'synthetic example: parity';

describePg('pack parity on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-parity-'));
  }, 60_000);
  afterAll(async () => {
    delete process.env.WIREHUB_CATALOG_DIR;
    delete process.env.WIREHUB_PACKS_DIR;
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('S1: a hub whose pack supplies builds, drawing sidecars, versions, revision links and art passes every check, the file stores included', async () => {
    const hub = parityHub();
    process.env.WIREHUB_CATALOG_DIR = hub.data;
    process.env.WIREHUB_PACKS_DIR = hub.packs;
    try {
      const blobs = fsBlobStore(join(work, 'blobs'));
      const tree = readFlattenedCatalog(hub.root, hub.packs);
      const report = await importCatalog(pgh.db, { org: { slug: 'parity', create: true }, files: tree, blobs });
      const gate = await runGate({ tree, root: hub.root, pg: { db: pgh.db, cache: new SnapshotCache(pgh.db, report.orgId), blobs }, filesDeps: defaultWorkbenchDeps() });
      console.log(`[gate parity]\n${formatGateReport(gate)}`);
      expect(gate.checks.map((c) => c.name)).toContain('api-parity-file-stores');
      expect(gate.checks.filter((c) => c.diffs.length > 0)).toEqual([]);
      expect(gate.routes).toEqual(expect.arrayContaining(['/api/builds/parity-board-rev1', `/api/drawings/${hub.designId}`, '/api/models/revisions/parity-board/rev1']));
      // the revision links are rows, with no Library record behind them
      await inOrg(pgh.db, report.orgId, async (tx) => {
        const rows = (await tx.selectFrom('studio.model_link' as never).select(['record_key', 'entity_id'] as never).execute()) as unknown as { record_key: string; entity_id: string | null }[];
        expect(rows.map((r) => r.record_key).sort()).toEqual(['revisions/ABC-123456-00/Rev1', 'revisions/parity-board/rev1', 'revisions/parity-board/rev2']);
        expect(rows.every((r) => r.entity_id === null)).toBe(true);
      });
    } finally {
      delete process.env.WIREHUB_CATALOG_DIR;
      delete process.env.WIREHUB_PACKS_DIR;
      rmSync(hub.root, { recursive: true, force: true });
    }
  }, 180_000);

  it('adopt takes the hub the file backend ran, packs flattened', async () => {
    const hub = parityHub();
    // adoption is for a database with no organisation yet
    const empty = await freshDatabase();
    const handle = openPg(empty.appUrl, { max: 2 });
    try {
      const outcome = await adoptFileCatalog(handle.db, { root: hub.root, packs: hub.packs, starter: dataPath(''), org: 'adopted', blobs: testBlobs() });
      expect(outcome.kind, outcome.message).toBe('adopted');
    } finally {
      await handle.close();
      await empty.drop();
      rmSync(hub.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('a pack that previews as applicable applies, a pack the codec would refuse previews as not', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'apply', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    const post = async (body: unknown) => (await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body }, deps)) as { status: number; body: any };
    const get = async (path: string) => (await handleWorkbenchRequest({ method: 'GET', path }, deps)) as { status: number; body: any };
    const manifest = { format: 1, id: 'revisions', name: 'Revisions', version: '1.0.0', license: 'CC0-1.0' };
    const links = (...records: string[]) => ({ src: SRC, links: records.map((record) => ({ record, asset: 'e'.repeat(64), sourceKind: 'vendor', src: SRC, status: 'wip' })) });

    const bad = { format: 1, manifest, files: { 'models.json': links('revisions/one-segment') } };
    const refused = await post({ bundle: bad });
    expect(refused.body.applicable).toBe(false);
    expect(refused.body.problems.join('\n')).toMatch(/models\.json/);
    expect((await post({ bundle: bad, apply: true })).status).toBe(422);

    // links out of order, compact JSON, a build file: all of it applies
    const good = {
      format: 1,
      manifest,
      files: {
        'models.json': links('revisions/some-board/rev2', 'revisions/some-board/rev1'),
        'builds/some-board-rev1.json': { board: 'PCA-00003', revision: 'Rev1', label: 'Some board', end: 'source', builds: [{ key: 'bare', build: 'bare', src: SRC }] },
      },
    };
    const preview = await post({ bundle: good });
    expect(preview.body, JSON.stringify(preview.body)).toMatchObject({ applicable: true, problems: [] });
    const applied = await post({ bundle: good, apply: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect((await get('/api/models/revisions/some-board/rev1')).body.link.record).toBe('revisions/some-board/rev1');
    expect((await get('/api/builds/some-board-rev1')).status).toBe(200);
    expect((await get('/api/models')).body.links.map((l: { record: string }) => l.record)).toEqual(['revisions/some-board/rev1', 'revisions/some-board/rev2']);
  }, 180_000);
});
