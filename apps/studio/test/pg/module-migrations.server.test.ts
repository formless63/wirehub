/** Module migrations (plan §3.13): schema `mod_<id>`, after the base, RLS required, grants, checksums. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { migrateModules, moduleMigrationFiles, moduleSchema, pendingModuleMigrations } from '../../server/pg/module-migrations.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

function moduleDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wh-modmig-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const GOOD = `CREATE TABLE push_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES studio.org (id),
  note text NOT NULL
);
ALTER TABLE push_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_log FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON push_log USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
`;

describe('module migration files', () => {
  it('names the schema and checks file names and numbering', () => {
    expect(moduleSchema('erp-link')).toBe('mod_erp_link');
    const ok = moduleDir({ '0001_erp_link_push_log.sql': 'SELECT 1;', '0002_erp_link_more.sql': 'SELECT 1;' });
    expect(moduleMigrationFiles('erp-link', ok).map((f) => f.name)).toEqual(['0001_erp_link_push_log', '0002_erp_link_more']);
    expect(() => moduleMigrationFiles('erp-link', moduleDir({ '0001_push_log.sql': 'x' }))).toThrow(/must be named 0*N*NNN_erp_link_/);
    expect(() => moduleMigrationFiles('erp-link', moduleDir({ '0002_erp_link_a.sql': 'x' }))).toThrow(/without gaps/);
  });
});

describePg('migrateModules', () => {
  let db: TestDatabase;
  let owner: PgHandle;
  beforeAll(async () => {
    db = await freshDatabase();
    owner = openPg(db.ownerUrl, { max: 2 });
  });
  afterAll(async () => {
    await owner?.close();
    await db?.drop();
  });

  it('applies once, grants the app, and reports pending', async () => {
    const dir = moduleDir({ '0001_erp_link_push_log.sql': GOOD });
    const mod = { id: 'erp-link', migrations: { dir } };
    expect(await pendingModuleMigrations(owner.db, [mod])).toEqual(['erp-link: 0001_erp_link_push_log']);
    expect(await migrateModules(owner.db, [mod])).toEqual(['erp-link: 0001_erp_link_push_log']);
    expect(await migrateModules(owner.db, [mod])).toEqual([]);
    expect(await pendingModuleMigrations(owner.db, [mod])).toEqual([]);
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      expect((await app.query('SELECT count(*)::int AS n FROM mod_erp_link.push_log')).rows[0].n).toBe(0);
      expect((await app.query('SELECT module FROM wirehub_migrations.module_migration')).rows).toHaveLength(1);
      await expect(app.query(`INSERT INTO mod_erp_link.push_log (org_id, note) VALUES (gen_random_uuid(), 'x')`)).rejects.toThrow();
    } finally {
      await app.end();
    }
  });

  it('refuses an applied file that changed, and a table without RLS', async () => {
    const dir = moduleDir({ '0001_erp_link_push_log.sql': GOOD + '-- edited\n' });
    await expect(migrateModules(owner.db, [{ id: 'erp-link', migrations: { dir } }])).rejects.toThrow(/changed after it was applied/);
    const bare = moduleDir({ '0001_bare_t.sql': 'CREATE TABLE t (id int, org_id uuid);' });
    await expect(migrateModules(owner.db, [{ id: 'bare', migrations: { dir: bare } }])).rejects.toThrow(/FORCE ROW LEVEL SECURITY/);
    // rolled back: nothing of it remains
    expect((await pendingModuleMigrations(owner.db, [{ id: 'bare', migrations: { dir: bare } }]))).toEqual(['bare: 0001_bare_t']);
  });
});
