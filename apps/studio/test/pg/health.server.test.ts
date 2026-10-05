/** The deep check against a real database: reachable, migrations current, a pending module migration noticed. */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { deepHealthCheck } from '../../server/health.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

describePg('deep health on Postgres', () => {
  let database: TestDatabase;
  let app: PgHandle;
  beforeAll(async () => {
    database = await freshDatabase();
    app = openPg(database.appUrl, { max: 2 });
  });
  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  it('is ok on a migrated database, and fails on a pending module migration', async () => {
    const ok = await deepHealthCheck({ db: app.db })();
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.name)).toEqual(['database', 'migrations']);
    const dir = mkdtempSync(join(tmpdir(), 'wh-health-mod-'));
    writeFileSync(join(dir, '0001_late_mod_t.sql'), 'SELECT 1;');
    const behind = await deepHealthCheck({ db: app.db, modules: [{ id: 'late-mod', migrations: { dir } }], log: () => {} })();
    expect(behind.ok).toBe(false);
    expect(behind.checks.find((c) => c.name === 'migrations')?.detail).toBe('pending');
  });

  it('reports an unreachable database', async () => {
    const dead = openPg('postgres://studio_app:x@127.0.0.1:1/none', { max: 1 });
    const result = await deepHealthCheck({ db: dead.db, log: () => {}, timeoutMs: 1500 })();
    await dead.close();
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'database')?.ok).toBe(false);
  });
});
