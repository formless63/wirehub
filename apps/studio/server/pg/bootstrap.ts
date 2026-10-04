/**
 * Roles and the database (`specs/postgres-backend.md` §3.1), idempotently,
 * as a superuser: what `db:bootstrap` runs before `db:migrate`, on a fresh
 * volume and on one provisioned before the backend existed alike (the
 * image's init scripts run only on a fresh volume, so this does not rely on
 * them).
 *
 * - `studio_owner` (LOGIN) owns the schemas and runs the migrations;
 * - `studio_app` (LOGIN, NOBYPASSRLS) is the studio and the worker;
 * - `studio_ro` (LOGIN, BYPASSRLS, read-only grants) is parity, ad-hoc reads
 *   and `pg_dump` — which refuses to dump a table RLS would filter, so the
 *   read-only role bypasses RLS and is granted nothing but SELECT.
 *
 * Passwords are set on every run, so `.env` stays the authority.
 */

import pg from 'pg';

export interface BootstrapOptions {
  /** the database to create (or adopt): default `wirehub` */
  database: string;
  passwords: { owner: string; app: string; ro: string };
  log?: (line: string) => void;
}

const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`'${name}' is not a plain lowercase SQL identifier.`);
  return `"${name}"`;
};
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const ROLES = [
  { name: 'studio_owner', attrs: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', password: 'owner' },
  { name: 'studio_app', attrs: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', password: 'app' },
  { name: 'studio_ro', attrs: 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS', password: 'ro' },
] as const;

/** Create or update the roles and the database, connected to `adminUrl` as a superuser. */
export async function bootstrapDatabase(adminUrl: string, options: BootstrapOptions): Promise<{ createdDatabase: boolean }> {
  const log = options.log ?? (() => {});
  const admin = new pg.Client({ connectionString: adminUrl, application_name: 'wirehub-bootstrap' });
  await admin.connect();
  let createdDatabase = false;
  try {
    for (const role of ROLES) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.name])).rowCount === 1;
      const password = options.passwords[role.password];
      await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${ident(role.name)} ${role.attrs} PASSWORD ${literal(password)}`);
      log(`${exists ? 'updated' : 'created'} role ${role.name}`);
    }
    const db = options.database;
    const found = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount === 1;
    if (!found) {
      // the builtin C locale: code-point collation everywhere (§3.1)
      await admin.query(`CREATE DATABASE ${ident(db)} OWNER studio_owner LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' TEMPLATE template0`);
      createdDatabase = true;
      log(`created database ${db}`);
    } else log(`database ${db} exists`);
    await admin.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${ident(db)} TO studio_owner`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO studio_app, studio_ro`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${ident(db)} FROM PUBLIC`);
  } finally {
    await admin.end();
  }
  // inside the database: the owner may create extensions it is trusted for (pg_trgm)
  const url = new URL(adminUrl);
  url.pathname = `/${options.database}`;
  const inside = new pg.Client({ connectionString: url.toString(), application_name: 'wirehub-bootstrap' });
  await inside.connect();
  try {
    // the schemas the migrations create are the owner's; nothing in public is used
    await inside.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  } finally {
    await inside.end();
  }
  return { createdDatabase };
}
