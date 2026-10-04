/**
 * Read latency, S3 (`specs/postgres-backend.md` §1): p95 of GET routes on
 * the file backend and on Postgres over the starter catalog, and of
 * `catalogVersion()`. Printed for the phase report; asserted only loosely
 * here (a shared CI box is noisy), the targets are the plan's.
 */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { defaultWorkbenchDeps } from '../../server/default-deps.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const ROUTES = [
  '/api/designs',
  '/api/designs/de9-crossover',
  '/api/definitions/connectors',
  '/api/definitions/connectors/de9-female/usage',
  '/api/db',
  '/api/vocab/signals',
  '/api/drawings/dc-led-lead',
  '/api/designs/de9-crossover/versions',
];
const N = 60;

function p(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] as number;
}

async function timeRoute(deps: WorkbenchDeps, path: string): Promise<{ p50: number; p95: number }> {
  for (let i = 0; i < 5; i += 1) await handleWorkbenchRequest({ method: 'GET', path }, deps);
  const times: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const started = performance.now();
    const response = await handleWorkbenchRequest({ method: 'GET', path }, deps);
    times.push(performance.now() - started);
    expect(response.status).toBe(200);
  }
  times.sort((a, b) => a - b);
  return { p50: p(times, 0.5), p95: p(times, 0.95) };
}

describePg('read latency (S3)', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let cache: SnapshotCache;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    const report = await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')) });
    cache = new SnapshotCache(pgh.db, report.orgId);
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
  }, 60_000);

  it('GET routes: files vs pg, and catalogVersion()', async () => {
    const files = defaultWorkbenchDeps();
    const pg = pgWorkbenchDeps({ cache });
    const lines: string[] = [];
    let worst = 0;
    for (const path of ROUTES) {
      const a = await timeRoute(files, path);
      const b = await timeRoute(pg, path);
      const budget = Math.max(a.p95 * 1.2, a.p95 + 10);
      worst = Math.max(worst, b.p95 - budget);
      lines.push(`${path.padEnd(48)} files p50 ${a.p50.toFixed(2)} p95 ${a.p95.toFixed(2)} | pg p50 ${b.p50.toFixed(2)} p95 ${b.p95.toFixed(2)} ms ${b.p95 <= budget ? 'within' : 'OVER'} max(+20 %, +10 ms)`);
    }
    // catalogVersion() without the reuse window: one round trip each
    const raw = new SnapshotCache(pgh.db, cache.orgId, { reuseMs: 0 });
    const times: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await raw.version();
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    lines.push(`catalogVersion() p50 ${p(times, 0.5).toFixed(2)} p95 ${p(times, 0.95).toFixed(2)} ms (target ≤ 2 ms p95)`);
    console.log(`[S3]\n${lines.join('\n')}`);
    // loose: a loaded shared box must not fail the suite; the report carries the numbers
    expect(worst).toBeLessThan(50);
  }, 120_000);
});
