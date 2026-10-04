/**
 * Postgres in tests (`specs/postgres-backend.md` §10, task A8).
 *
 * Needs `WIREHUB_TEST_PG_URL`: a superuser URL of a throwaway Postgres 18
 * (`test/pg/compose.test.yaml`, or any `docker run postgres:18`). Unset, every
 * pg suite skips with one line, so `pnpm test` stays green without Docker.
 *
 * Once per run (under an advisory lock, so parallel files agree) the roles are
 * bootstrapped and a template database is migrated, named after the
 * migrations' checksums; each test file then gets a database of its own,
 * copied from the template, and drops it at the end.
 *
 * The role passwords below are for the throwaway test server only.
 */

import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';
import { describe } from 'vitest';

import { bootstrapDatabase } from '../../server/pg/bootstrap.ts';
import { openPg } from '../../server/pg/db.ts';
import { migrateToLatest, migrationFiles } from '../../server/pg/migrate.ts';

export const TEST_PG_URL = process.env.WIREHUB_TEST_PG_URL;

const PASSWORDS = { owner: 'test-only-owner', app: 'test-only-app', ro: 'test-only-ro' } as const;

/** `describe` when a test database is configured, else a skipped one that says why. */
export const describePg: typeof describe =
  TEST_PG_URL === undefined || TEST_PG_URL === ''
    ? (((name: string) => describe.skip(`${name} (skipped: set WIREHUB_TEST_PG_URL to a throwaway Postgres 18)`, () => {})) as unknown as typeof describe)
    : describe;

export interface TestDatabase {
  name: string;
  adminUrl: string;
  ownerUrl: string;
  appUrl: string;
  roUrl: string;
  drop(): Promise<void>;
}

function urlFor(base: string, database: string, user?: { name: string; password: string }): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_PG_URL, application_name: 'wirehub-test' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The migrated template database, built once per migration set. */
async function templateDatabase(): Promise<string> {
  const digest = createHash('sha256')
    .update(migrationFiles().map((m) => `${m.name}:${m.sha256}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
  const name = `wirehub_tpl_${digest}`;
  await withAdmin(async (admin) => {
    await admin.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['wirehub-test-template']);
    try {
      const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
      if (exists) return;
      await bootstrapDatabase(TEST_PG_URL as string, { database: name, passwords: PASSWORDS });
      const owner = openPg(urlFor(TEST_PG_URL as string, name, { name: 'studio_owner', password: PASSWORDS.owner }), { max: 1 });
      try {
        await migrateToLatest(owner.db);
      } finally {
        await owner.close();
      }
    } finally {
      await admin.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['wirehub-test-template']);
    }
  });
  return name;
}

/** A fresh, migrated database of this test file's own. */
export async function freshDatabase(): Promise<TestDatabase> {
  if (TEST_PG_URL === undefined || TEST_PG_URL === '') throw new Error('WIREHUB_TEST_PG_URL is not set');
  const template = await templateDatabase();
  const name = `wirehub_t_${randomBytes(6).toString('hex')}`;
  await withAdmin(async (admin) => {
    // CREATE DATABASE … TEMPLATE needs the template idle: retry while another file copies it
    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template} OWNER studio_owner`);
        break;
      } catch (error) {
        if (attempt > 50 || !String(error).includes('being accessed by other users')) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO studio_app, studio_ro`);
  });
  const base = TEST_PG_URL;
  return {
    name,
    adminUrl: urlFor(base, name),
    ownerUrl: urlFor(base, name, { name: 'studio_owner', password: PASSWORDS.owner }),
    appUrl: urlFor(base, name, { name: 'studio_app', password: PASSWORDS.app }),
    roUrl: urlFor(base, name, { name: 'studio_ro', password: PASSWORDS.ro }),
    drop: () => withAdmin(async (admin) => void (await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))),
  };
}
