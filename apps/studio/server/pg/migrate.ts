/**
 * Migrations (`specs/postgres-backend.md` §6): forward-only SQL files in
 * `migrations/NNNN_name.sql`, run in order by Kysely's `Migrator` as
 * `studio_owner`, all pending ones in one transaction. `migrations/CHECKSUMS`
 * pins every released file (a test fails on an edit); a change is a new file.
 *
 * The migrator's own bookkeeping lives in schema `wirehub_migrations`, so the
 * `studio` schema holds only org-scoped, RLS-forced tables.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

import type { Db } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const MIGRATION_SCHEMA = 'wirehub_migrations';

export interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

/** Every `NNNN_name.sql`, in order. */
export function migrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((file) => {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      return { name: file.slice(0, -'.sql'.length), sql: text, sha256: createHash('sha256').update(text).digest('hex') };
    });
}

/** `CHECKSUMS`: `<sha256>  <file>` per line, as `sha256sum` writes it. */
export function readChecksums(dir = MIGRATIONS_DIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(`${dir}/CHECKSUMS`, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\S+)\.sql$/.exec(line.trim());
    if (match !== null) out.set(match[2] as string, match[1] as string);
  }
  return out;
}

const provider = (dir: string): MigrationProvider => ({
  async getMigrations() {
    const out: Record<string, Migration> = {};
    for (const file of migrationFiles(dir)) {
      out[file.name] = {
        // one simple-protocol query: the file may hold many statements
        up: async (db) => {
          await sql.raw(file.sql).execute(db);
        },
        down: async () => {
          throw new Error(`Migrations are forward-only (${file.name}); restore a backup to go back.`);
        },
      };
    }
    return out;
  },
});

function migrator(db: Db, dir: string): Migrator {
  return new Migrator({ db, provider: provider(dir), migrationTableSchema: MIGRATION_SCHEMA });
}

/** Run every pending migration (as the schemas' owner). Returns the names applied. */
export async function migrateToLatest(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const { error, results } = await migrator(db, dir).migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName;
    throw new Error(`Migration ${failed ?? '(unknown)'} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/** The migrations not yet applied — the studio refuses to serve while any is pending. */
export async function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const all = await migrator(db, dir).getMigrations();
  return all.filter((m) => m.executedAt === undefined).map((m) => m.name);
}
