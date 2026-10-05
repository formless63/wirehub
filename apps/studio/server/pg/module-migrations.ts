/**
 * Module migrations (`specs/postgres-backend.md` §3.13, §6): a module's own
 * tables, in the schema `mod_<module id>` (`-` written `_`), applied after the
 * base's by `migrateModules`, as `studio_owner`.
 *
 * Files are `NNNN_<module_id>_<name>.sql` in the module's `migrations.dir`,
 * forward-only, numbered from 0001 without gaps. A module's pending files run
 * in one transaction under an advisory lock; the bookkeeping row (name and
 * sha256) is in `wirehub_migrations.module_migration`, and an applied file
 * that has since changed is refused. Each file runs with
 * `search_path = mod_<id>, studio, public`, so `studio.entity` may be
 * referenced and the module's own tables need no prefix.
 *
 * After the files: every table of the schema that has an `org_id` column must
 * have RLS forced and an `org_isolation` policy (the transaction rolls back
 * otherwise), and `studio_app` / `studio_ro` get their usual grants (§3.12).
 * Removing a module leaves its schema; dropping it is an admin's decision.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import type { WireHubModule } from '@wirehub/modules';

import type { Db } from './db.ts';
import { MIGRATION_SCHEMA } from './migrate.ts';

export interface ModuleMigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

/** The schema of a module: `pc-serial` → `mod_pc_serial`. */
export function moduleSchema(moduleId: string): string {
  return `mod_${moduleId.replace(/-/g, '_')}`;
}

/** The module's files, in order. Throws one sentence for a misnamed file or a numbering gap. */
export function moduleMigrationFiles(moduleId: string, dir: string | URL): ModuleMigrationFile[] {
  const path = typeof dir === 'string' ? (dir.startsWith('file:') ? fileURLToPath(dir) : dir) : fileURLToPath(dir);
  const prefix = moduleId.replace(/-/g, '_');
  const names = readdirSync(path).filter((n) => n.endsWith('.sql')).sort();
  const files = names.map((file) => {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (match === null || !(match[2] as string).startsWith(`${prefix}_`)) {
      throw new Error(`Module '${moduleId}': migration '${file}' must be named NNNN_${prefix}_<name>.sql.`);
    }
    const text = readFileSync(`${path}/${file}`, 'utf8');
    return { name: file.slice(0, -'.sql'.length), sql: text, sha256: createHash('sha256').update(text).digest('hex') };
  });
  files.forEach((f, i) => {
    if (Number(f.name.slice(0, 4)) !== i + 1) throw new Error(`Module '${moduleId}': migration numbers must run 0001, 0002, … without gaps (found '${f.name}' at position ${i + 1}).`);
  });
  return files;
}

interface Applied {
  name: string;
  sha256: string;
}

async function appliedFor(db: Db, moduleId: string): Promise<Applied[]> {
  const result = await sql<Applied>`SELECT name, sha256 FROM wirehub_migrations.module_migration WHERE module = ${moduleId} ORDER BY name`.execute(db);
  return result.rows;
}

function migrating(modules: readonly Pick<WireHubModule, 'id' | 'migrations'>[]): { id: string; dir: string | URL }[] {
  return modules.flatMap((m) => (m.migrations === undefined ? [] : [{ id: m.id, dir: m.migrations.dir }]));
}

/** Apply every module's pending migrations. Returns the names applied (`<module>: <file>`). The base must be migrated first. */
export async function migrateModules(db: Db, modules: readonly Pick<WireHubModule, 'id' | 'migrations'>[]): Promise<string[]> {
  const out: string[] = [];
  for (const { id, dir } of migrating(modules)) {
    const files = moduleMigrationFiles(id, dir);
    const schema = moduleSchema(id);
    await db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wirehub-module-migrations:${id}`}, 0))`.execute(tx);
      await sql`CREATE TABLE IF NOT EXISTS wirehub_migrations.module_migration (
        module text NOT NULL, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (module, name))`.execute(tx);
      await sql`GRANT SELECT ON wirehub_migrations.module_migration TO studio_app, studio_ro`.execute(tx);
      const done = new Map((await appliedFor(tx, id)).map((a) => [a.name, a.sha256]));
      for (const [name, sha] of done) {
        const file = files.find((f) => f.name === name);
        if (file === undefined) throw new Error(`Module '${id}': migration ${name} was applied but its file is gone; migrations are never removed.`);
        if (file.sha256 !== sha) throw new Error(`Module '${id}': migration ${name} changed after it was applied; a change is a new migration.`);
      }
      const pending = files.filter((f) => !done.has(f.name));
      if (pending.length === 0) return;
      await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`).execute(tx);
      for (const file of pending) {
        // reset at the end of the transaction; the file may create tables unqualified
        await sql`SELECT set_config('search_path', ${`${schema}, studio, public`}, true)`.execute(tx);
        try {
          await sql.raw(file.sql).execute(tx);
        } catch (error) {
          throw new Error(`Module '${id}': migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sql`INSERT INTO wirehub_migrations.module_migration (module, name, sha256) VALUES (${id}, ${file.name}, ${file.sha256})`.execute(tx);
        out.push(`${id}: ${file.name}`);
      }
      await sql`SELECT set_config('search_path', '"$user", public', true)`.execute(tx);
      await requireIsolation(tx, id, schema);
      await grantModuleSchema(tx, schema);
    });
  }
  return out;
}

/** Every org-scoped table of the schema: RLS enabled and forced, with an `org_isolation` policy. */
async function requireIsolation(tx: Db, moduleId: string, schema: string): Promise<void> {
  const rows = await sql<{ relname: string; forced: boolean; policy: boolean }>`
    SELECT c.relname, c.relforcerowsecurity AS forced,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'org_isolation') AS policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`.execute(tx);
  const bad = rows.rows.filter((r) => !r.forced || !r.policy).map((r) => r.relname);
  if (bad.length > 0) {
    throw new Error(`Module '${moduleId}': org-scoped table(s) ${bad.map((t) => `${schema}.${t}`).join(', ')} need FORCE ROW LEVEL SECURITY and an org_isolation policy (plan §3.13).`);
  }
}

async function grantModuleSchema(tx: Db, schema: string): Promise<void> {
  for (const statement of [
    `GRANT USAGE ON SCHEMA ${schema} TO studio_app, studio_ro`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO studio_app`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO studio_ro`,
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO studio_app`,
  ]) {
    await sql.raw(statement).execute(tx);
  }
}

/** `<module>: <file>` for every module migration not yet applied (all of them when the bookkeeping table is missing). */
export async function pendingModuleMigrations(db: Db, modules: readonly Pick<WireHubModule, 'id' | 'migrations'>[]): Promise<string[]> {
  const todo = migrating(modules);
  if (todo.length === 0) return [];
  const exists = await sql<{ t: string | null }>`SELECT to_regclass(${`${MIGRATION_SCHEMA}.module_migration`})::text AS t`.execute(db);
  const out: string[] = [];
  for (const { id, dir } of todo) {
    const done = exists.rows[0]?.t == null ? new Set<string>() : new Set((await appliedFor(db, id)).map((a) => a.name));
    for (const file of moduleMigrationFiles(id, dir)) if (!done.has(file.name)) out.push(`${id}: ${file.name}`);
  }
  return out;
}
