/**
 * The Postgres connection (`specs/postgres-backend.md` §4): one `pg` Pool per
 * process, wrapped in Kysely for transactions and the migrator. Queries are
 * written as SQL (`sql` templates): the schema is the plan's DDL, and the
 * pipeline is "snapshot → pure model → one transaction", not an ORM.
 *
 * Every read or write of org-scoped rows runs inside `inOrg`, which sets
 * `studio.org_id` for the transaction — RLS lets nothing through without it.
 */

import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';

/** No typed tables: every query is a `sql` template over the plan's schema. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Schema = {};
export type Db = Kysely<Schema>;
export type Tx = Transaction<Schema>;

export interface PgHandle {
  readonly pool: pg.Pool;
  readonly db: Db;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** pool size; the studio needs few — requests share one snapshot */
  max?: number;
  applicationName?: string;
}

export function openPg(url: string, options: OpenOptions = {}): PgHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 8,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? 'wirehub',
  });
  // an idle client that loses its server (a restart) must not crash the process
  pool.on('error', (error) => console.warn(`[pg] idle connection error: ${error.message}`));
  const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
  return {
    pool,
    db,
    // Kysely's destroy ends the pool it was given
    close: () => db.destroy(),
  };
}

export interface InOrgOptions {
  /** a read-only REPEATABLE READ transaction: one consistent view for a snapshot load */
  snapshot?: boolean;
  /** statement_timeout for the transaction, ms (default 15 s) */
  statementTimeoutMs?: number;
}

/** Run `fn` in one transaction that acts for `orgId` (RLS). */
export async function inOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>, options: InOrgOptions = {}): Promise<T> {
  let builder = db.transaction();
  if (options.snapshot === true) builder = builder.setIsolationLevel('repeatable read').setAccessMode('read only');
  return builder.execute(async (tx) => {
    await sql`SELECT set_config('studio.org_id', ${orgId}, true), set_config('statement_timeout', ${String(options.statementTimeoutMs ?? 15_000)}, true)`.execute(tx);
    return fn(tx);
  });
}

/** The org id this process acts for: by slug, or the deployment's only org. Uses the SECURITY DEFINER lookups (`org` is under RLS). */
export async function resolveOrgId(db: Db, slug?: string): Promise<string | undefined> {
  const result =
    slug === undefined
      ? await sql<{ id: string | null }>`SELECT studio.sole_org_id() AS id`.execute(db)
      : await sql<{ id: string | null }>`SELECT studio.org_id_for(${slug}) AS id`.execute(db);
  return result.rows[0]?.id ?? undefined;
}

/** `catalog_head.version` of an org, as text (`'0'` before the first import), or undefined when the org has no head row. One round trip. */
export async function catalogHeadVersion(db: Db, orgId: string): Promise<string | undefined> {
  const result = await sql<{ version: string | null }>`SELECT studio.head_version(${orgId}::uuid)::text AS version`.execute(db);
  return result.rows[0]?.version ?? undefined;
}

/** An org id, or where to find it once it exists (a hub in first-run setup has none yet). */
export type OrgRef = string | (() => string | undefined);

export function orgOf(ref: OrgRef): string {
  const id = typeof ref === 'string' ? ref : ref();
  if (id === undefined) throw new Error('this hub has no organisation yet: finish first-run setup');
  return id;
}

/** How many orgs the database holds (a SECURITY DEFINER count: zero means first-run setup). */
export async function orgCount(db: Db): Promise<number> {
  return (await sql<{ n: number }>`SELECT studio.org_count() AS n`.execute(db)).rows[0]?.n ?? 0;
}
