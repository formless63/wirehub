/**
 * The audit backstop's alarm (`specs/postgres-backend.md` §3, §8.6): every
 * row-level write to a catalog table lands in `studio.audit_log` with the
 * change set its writer declared. A row without one is a write that bypassed
 * `PgStore` (a hand-run SQL statement, a bug), and raises `unattributed-write`.
 * Runs inside the worker's hourly `backup` watch, over the last 26 hours;
 * the notifier is throttled so a standing finding alerts once a day. `blob` rows are
 * not looked at: an upload precedes its change set and the worker's clean-up
 * deletes them, both by design.
 */

import { sql } from 'kysely';

import type { Notifier } from '../notify.ts';
import { inOrg, type Db } from './db.ts';

export interface AuditWatchOptions {
  db: Db;
  orgId: string;
  notify?: Notifier;
  /** look back this many hours (default 26) */
  hours?: number;
}

export async function watchAudit(options: AuditWatchOptions): Promise<{ unattributed: number }> {
  const rows = await inOrg(options.db, options.orgId, async (tx) =>
    (
      await sql<{ n: string; tables: string[] }>`
        SELECT count(*)::text AS n, coalesce(array_agg(DISTINCT table_name), '{}') AS tables
          FROM studio.audit_log WHERE change_set_id IS NULL AND table_name <> 'blob' AND at > now() - make_interval(hours => ${options.hours ?? 26})`.execute(tx)
    ).rows,
  );
  const unattributed = Number(rows[0]?.n ?? 0);
  if (unattributed > 0) {
    await options.notify?.notify({
      event: 'unattributed-write',
      severity: 'high',
      title: 'Unattributed catalog write',
      message: `${unattributed} write(s) to the catalog in the last day carry no change set (tables: ${(rows[0]?.tables ?? []).join(', ')}): something bypassed the application.`,
      data: { count: unattributed, tables: rows[0]?.tables ?? [] },
    });
  }
  return { unattributed };
}
