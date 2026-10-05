/**
 * The schema (Postgres plan tasks A2 and A8): migrations pinned by
 * CHECKSUMS and equal to the plan's DDL, RLS forced on every org table with
 * cross-org isolation, and the triggers — touch, audit, the frozen-revision
 * guard and the deferred reference FKs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationFiles, readChecksums } from '../../server/pg/migrate.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const planPath = fileURLToPath(new URL('../../../../specs/postgres-backend.md', import.meta.url));

describe('migration files', () => {
  it('are pinned by CHECKSUMS (a released migration is never edited)', () => {
    const sums = readChecksums();
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(Object.fromEntries(files.map((f) => [f.name, f.sha256]))).toEqual(Object.fromEntries(sums));
  });

  it('are numbered without gaps', () => {
    const numbers = migrationFiles().map((f) => Number(f.name.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i));
  });

  it("are the plan's DDL blocks, verbatim", () => {
    const plan = readFileSync(planPath, 'utf8');
    const blocks = new Map<string, string>();
    for (const match of plan.matchAll(/```sql ddl\n(.*?)```/gs)) {
      const body = match[1] as string;
      const number = /^-- (\d{4})/.exec(body)?.[1];
      if (number !== undefined) blocks.set(number, body);
    }
    for (const file of migrationFiles()) {
      const body = file.sql.split('\n').slice(2).join('\n');
      expect(blocks.get(file.name.slice(0, 4)), file.name).toBe(body);
    }
  });
});

describePg('the migrated schema', () => {
  let db: TestDatabase;
  let app: pg.Client;
  let owner: pg.Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = new pg.Client({ connectionString: db.appUrl });
    owner = new pg.Client({ connectionString: db.ownerUrl });
    await app.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await db?.drop();
  });

  /** run `fn` in a transaction acting for `org` (as studio_app), rolled back unless `commit` */
  async function asOrg<T>(org: string, fn: () => Promise<T>, commit = false): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('studio.org_id', $1, true)", [org]);
      const out = await fn();
      await app.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  async function newOrg(slug: string): Promise<string> {
    const id = (await app.query<{ id: string }>('SELECT uuidv7()::text AS id')).rows[0]!.id;
    await asOrg(
      id,
      async () => {
        await app.query('INSERT INTO studio.org (id, slug, name) VALUES ($1, $2, $2)', [id, slug]);
        await app.query('INSERT INTO studio.catalog_head (org_id, schema_version) VALUES ($1, 4)', [id]);
      },
      true,
    );
    return id;
  }

  it('forces RLS on every org-scoped table in studio', async () => {
    const tables = await owner.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'studio' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    expect(tables.rows.length).toBeGreaterThanOrEqual(25);
    // `org` and `audit_log` enable RLS without forcing it: the owner's SECURITY DEFINER functions read and write them
    const notForced = tables.rows.filter((t) => !t.forced).map((t) => t.relname);
    expect(notForced).toEqual(['audit_log', 'org']);
    expect(tables.rows.filter((t) => !t.rls)).toEqual([]);
    // the org-scoped tables of the auth schema too (0014)
    const auth = await owner.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth' AND c.relname IN ('api_token', 'invitation') ORDER BY c.relname`,
    );
    expect(auth.rows).toEqual([
      { relname: 'api_token', forced: true },
      { relname: 'invitation', forced: true },
    ]);
  });

  it('isolates orgs: a session sees and writes its own org only, and nothing without one', async () => {
    const a = await newOrg('org-a');
    const b = await newOrg('org-b');
    await asOrg(a, () => app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'vocab', 'colours')", [a]), true);
    await asOrg(b, () => app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'vocab', 'sizes')", [b]), true);
    expect(await asOrg(a, async () => (await app.query('SELECT slug FROM studio.entity')).rows.map((r) => r.slug))).toEqual(['colours']);
    expect(await asOrg(b, async () => (await app.query('SELECT slug FROM studio.org')).rows.map((r) => r.slug))).toEqual(['org-b']);
    // no org set: nothing at all
    expect((await app.query('SELECT count(*)::int AS n FROM studio.entity')).rows[0].n).toBe(0);
    // writing another org's row is refused
    await expect(asOrg(a, () => app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'vocab', 'x')", [b]))).rejects.toThrow(/row-level security/);
    // the SECURITY DEFINER lookups work without an org
    expect((await app.query("SELECT studio.org_id_for('org-a')::text AS id")).rows[0].id).toBe(a);
    expect((await app.query('SELECT studio.sole_org_id() AS id')).rows[0].id).toBeNull();
    expect((await app.query('SELECT studio.head_version($1)::text AS v', [a])).rows[0].v).toBe('0');
  });

  it('touches row_version on update, and audits every write with its change set', async () => {
    const org = await newOrg('org-touch');
    await asOrg(org, async () => {
      const cs = (await app.query("INSERT INTO studio.change_set (org_id, catalog_version, actor_label, source, message) VALUES ($1, 1, 'test', 'studio', 'm') RETURNING id", [org])).rows[0].id;
      await app.query("SELECT set_config('studio.change_set_id', $1, true)", [String(cs)]);
      const e = (await app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'design', 'd') RETURNING id", [org])).rows[0].id;
      await app.query("INSERT INTO studio.record (org_id, entity_id, body) VALUES ($1, $2, '{\"id\":\"d\",\"label\":\"D\"}')", [org, e]);
      await app.query("UPDATE studio.record SET body = '{\"id\":\"d\",\"label\":\"E\"}' WHERE entity_id = $1", [e]);
      const row = (await app.query('SELECT row_version, label, etag FROM studio.record WHERE entity_id = $1', [e])).rows[0];
      expect(row.row_version).toBe('2');
      expect(row.label).toBe('E');
      const audit = (await app.query("SELECT op, change_set_id::text AS cs FROM studio.audit_log WHERE table_name = 'record' ORDER BY id")).rows;
      expect(audit).toEqual([
        { op: 'INSERT', cs: String(cs) },
        { op: 'UPDATE', cs: String(cs) },
      ]);
    });
    // the app may not write the audit log or rewrite history
    await expect(asOrg(org, () => app.query("INSERT INTO studio.audit_log (table_name, row_key, op) VALUES ('x', 'y', 'INSERT')"))).rejects.toThrow(/permission denied/);
    await expect(asOrg(org, () => app.query("UPDATE studio.change_set SET message = 'm'"))).rejects.toThrow(/permission denied/);
  });

  it('freezes a locked revision: no edit, no delete; an unlock and a rename pass', async () => {
    const org = await newOrg('org-rev');
    await asOrg(org, async () => {
      const d = (await app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'design', 'd') RETURNING id", [org])).rows[0].id;
      const locked = { rev: 1, designId: 'd', note: 'n', design: { id: 'd', label: 'D' }, history: [{ action: 'save' }] };
      await app.query('INSERT INTO studio.design_revision (org_id, design_id, rev, body) VALUES ($1, $2, 1, $3)', [org, d, JSON.stringify(locked)]);
      expect((await app.query('SELECT locked FROM studio.design_revision')).rows[0].locked).toBe(true);
      await app.query('SAVEPOINT s');
      await expect(app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify({ ...locked, note: 'changed' })])).rejects.toThrow(/locked: unlock it first/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      await expect(app.query('DELETE FROM studio.design_revision')).rejects.toThrow(/cannot be deleted/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      // a rename changes only the design id fields
      await app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify({ ...locked, designId: 'e', design: { id: 'e', label: 'D' } })]);
      await app.query('SAVEPOINT s');
      // an approval step (0018): `approval` and one submit/approve/reject entry, nothing else
      const step = { ...locked, designId: 'e', design: { id: 'e', label: 'D' }, approval: { state: 'submitted', by: 'x', at: 't', comment: 'c' }, history: [...locked.history, { action: 'submit' }] };
      await expect(app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify({ ...step, note: 'sneaked in' })])).rejects.toThrow(/locked: unlock it first/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      await expect(app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify({ ...step, history: [...locked.history, { action: 'edit' }] })])).rejects.toThrow(/locked: unlock it first/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      await app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify(step)]);
      // an unlock adds `unlocked` and appends one 'unlock' history entry
      const renamed = step;
      await app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify({ ...renamed, unlocked: { by: 'x' }, history: [...renamed.history, { action: 'unlock' }] })]);
      expect((await app.query('SELECT locked FROM studio.design_revision')).rows[0].locked).toBe(false);
      // unlocked: anything goes
      await app.query('UPDATE studio.design_revision SET body = $1', [JSON.stringify({ ...renamed, note: 'edited', unlocked: { by: 'x' }, history: [{ action: 'save' }, { action: 'unlock' }] })]);
    });
  });

  it('defers reference FKs to commit: a referenced entity cannot be deleted; a model link holds its record', async () => {
    const org = await newOrg('org-fk');
    const ids = await asOrg(
      org,
      async () => {
        const connector = (await app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'connector', 'c') RETURNING id", [org])).rows[0].id;
        const design = (await app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'design', 'd') RETURNING id", [org])).rows[0].id;
        const record = (await app.query("INSERT INTO studio.record (org_id, entity_id, body) VALUES ($1, $2, '{}') RETURNING id", [org, design])).rows[0].id;
        await app.query("INSERT INTO studio.ref_edge (org_id, from_record, to_entity, role) VALUES ($1, $2, $3, 'connector')", [org, record, connector]);
        const kit = (await app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'kit', 'k') RETURNING id", [org])).rows[0].id;
        await app.query(
          "INSERT INTO studio.model_link (org_id, record_key, body, entity_id) VALUES ($1, 'kits/k', '{\"record\":\"kits/k\",\"asset\":\"a\",\"sourceKind\":\"vendor\",\"src\":\"s\"}', $2)",
          [org, kit],
        );
        return { connector, kit };
      },
      true,
    );
    // the delete itself passes; the commit refuses it
    await app.query('BEGIN');
    await app.query("SELECT set_config('studio.org_id', $1, true)", [org]);
    await app.query('DELETE FROM studio.entity WHERE id = $1', [ids.connector]);
    await expect(app.query('COMMIT')).rejects.toThrow(/foreign key/);
    await app.query('BEGIN');
    await app.query("SELECT set_config('studio.org_id', $1, true)", [org]);
    await app.query('DELETE FROM studio.entity WHERE id = $1', [ids.kit]);
    await expect(app.query('COMMIT')).rejects.toThrow(/foreign key/);
  });

  it('computes the generated etag exactly as contentETag does', async () => {
    const org = await newOrg('org-etag');
    const { contentETag } = await import('../../server/etag.ts');
    const value = { id: 'd', label: 'Ünïcödé — “quotes”', n: [1, 2.5, -0], nested: { b: 1, a: 2 } };
    await asOrg(org, async () => {
      const e = (await app.query("INSERT INTO studio.entity (org_id, kind, slug) VALUES ($1, 'design', 'd') RETURNING id", [org])).rows[0].id;
      await app.query('INSERT INTO studio.record (org_id, entity_id, body) VALUES ($1, $2, $3)', [org, e, JSON.stringify(value)]);
      const row = (await app.query('SELECT etag, body::text AS body FROM studio.record')).rows[0];
      expect(row.body).toBe(JSON.stringify(value));
      expect(row.etag).toBe(contentETag(value));
    });
  });
});
