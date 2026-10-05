/**
 * First-run setup on Postgres: picking domain modules installs their packs
 * into the database catalog as one change set — the same catalog, byte for
 * byte, as the file backend's setup makes in a directory.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { registry } from '../../server/modules.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { exportSnapshot } from '../../server/pg/export.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { handleSetupRequest } from '../../server/setup.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

describePg('first-run setup on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-setup-'));
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('installs the chosen packs in one change set, as the file backend does', async () => {
    const now = () => '2026-10-05T09:00:00.000Z';
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')) });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps = pgWorkbenchDeps({ cache, db: pgh.db });
    deps.setup = pgSetupDeps(deps, cache, { prompt: true, now });
    deps.modules = registry;
    const before = await cache.version();
    const view = await handleWorkbenchRequest({ method: 'GET', path: '/api/setup' }, deps);
    expect((view.body as { needed: boolean }).needed).toBe(true);
    const done = await handleWorkbenchRequest({ method: 'POST', path: '/api/setup', body: { modules: ['pc-serial', 'networking'] } }, deps);
    expect(done.status).toBe(200);
    expect(BigInt(await cache.version())).toBe(BigInt(before) + 1n);
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/db9-null-modem' }, deps)).status).toBe(200);
    expect(((await handleWorkbenchRequest({ method: 'GET', path: '/api/setup' }, deps)).body as { completed: boolean }).completed).toBe(true);
    // the file backend's setup on a copy of the starter, same choice, same clock
    const copy = join(work, 'data');
    cpSync(dataPath(''), copy, { recursive: true });
    expect((await handleSetupRequest({ method: 'POST', body: { modules: ['pc-serial', 'networking'] } }, { dataDir: copy, prompt: true, now }, registry)).status).toBe(200);
    const files = readCatalogTree(work);
    const pg = exportSnapshot(await cache.get()).files;
    expect(Object.keys(pg).sort()).toEqual([...files.keys()].filter((p) => typeof files.get(p) === 'string').sort());
    for (const [path, text] of Object.entries(pg)) expect(text, path).toBe(files.get(path));
  }, 120_000);
});
