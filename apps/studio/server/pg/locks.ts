/**
 * Edit locks on Postgres (`specs/postgres-backend.md` §3.10, §4.1; task B6):
 * the lease table as a table, not advisory locks — a lease lives for minutes
 * across many requests, processes and restarts, and is listed with its
 * holder. `memoryLockStore`'s semantics, to the letter, shared by every
 * studio process of the deployment.
 *
 * Each call is one short transaction that serialises on the record
 * (`pg_advisory_xact_lock` — the row may not exist yet), sweeps what lapsed,
 * then reads and writes the record's row. A change sends
 * `NOTIFY studio_locks, '<record>'` (the events stream, `events.ts`).
 */

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { LEASE_MS } from '../../src/locks/records.ts';
import type { AcquireResult, EditLock, HeartbeatResult, LockHolder, LockStore, TakeOverResult } from '../locks/lock-store.ts';
import { inOrg, type Db, type Tx } from './db.ts';

interface Row {
  record: string;
  token: string;
  holder: LockHolder;
  since_ms: string;
  seen_ms: string;
  request: EditLock['request'] | null;
  declined: EditLock['declined'] | null;
}

const lockOf = (row: Row): EditLock => ({
  record: row.record,
  token: row.token,
  holder: row.holder,
  since: Number(row.since_ms),
  seenAt: Number(row.seen_ms),
  ...(row.request === null ? {} : { request: row.request }),
  ...(row.declined === null ? {} : { declined: row.declined }),
});

export function pgLockStore(db: Db, orgId: string, options: { leaseMs?: number; newToken?: () => string } = {}): LockStore {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const newToken = options.newToken ?? randomUUID;

  /** One transaction on one record: serialised, swept, with its live row (if any). */
  const onRecord = <T>(record: string, now: number, fn: (tx: Tx, current: EditLock | undefined) => Promise<T>): Promise<T> =>
    inOrg(db, orgId, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`studio-lock:${orgId}:${record}`}, 0))`.execute(tx);
      await sql`DELETE FROM studio.edit_lock WHERE record = ${record} AND seen_ms + ${leaseMs} <= ${now}`.execute(tx);
      await sql`DELETE FROM studio.edit_lock_displaced WHERE until_ms <= ${now}`.execute(tx);
      const row = (await sql<Row>`SELECT record, token::text AS token, holder, since_ms::text AS since_ms, seen_ms::text AS seen_ms, request, declined FROM studio.edit_lock WHERE record = ${record}`.execute(tx)).rows[0];
      return fn(tx, row === undefined ? undefined : lockOf(row));
    });

  const notify = (tx: Tx, record: string) => sql`SELECT pg_notify('studio_locks', ${JSON.stringify({ org: orgId, record })})`.execute(tx);

  const fresh = async (tx: Tx, record: string, holder: LockHolder, now: number): Promise<EditLock> => {
    const lock: EditLock = { record, token: newToken(), holder: { ...holder }, since: now, seenAt: now };
    await sql`
      INSERT INTO studio.edit_lock (org_id, record, token, holder, since_ms, seen_ms)
      VALUES (${orgId}::uuid, ${record}, ${lock.token}::uuid, ${JSON.stringify(lock.holder)}::jsonb, ${now}, ${now})
      ON CONFLICT (org_id, record) DO UPDATE SET token = EXCLUDED.token, holder = EXCLUDED.holder, since_ms = EXCLUDED.since_ms,
        seen_ms = EXCLUDED.seen_ms, request = NULL, declined = NULL`.execute(tx);
    await notify(tx, record);
    return lock;
  };

  return {
    acquire: (record, holder, now): Promise<AcquireResult> =>
      onRecord(record, now, async (tx, current) => (current !== undefined ? { ok: false, lock: current } : { ok: true, lock: await fresh(tx, record, holder, now) })),

    heartbeat: (record, token, holder, now): Promise<HeartbeatResult> =>
      onRecord(record, now, async (tx, current) => {
        if (current !== undefined && current.token === token) {
          await sql`UPDATE studio.edit_lock SET seen_ms = ${now} WHERE record = ${record}`.execute(tx);
          return { ok: true, lock: { ...current, seenAt: now } };
        }
        const gone = /^[0-9a-f-]{36}$/.test(token)
          ? (await sql<{ record: string; at_ms: string }>`SELECT record, at_ms::text AS at_ms FROM studio.edit_lock_displaced WHERE token = ${token}::uuid`.execute(tx)).rows[0]
          : undefined;
        if (gone !== undefined && gone.record === record) return { ok: false, lost: true, lock: current, takenOverAt: Number(gone.at_ms) };
        if (current !== undefined) return { ok: false, lost: true, lock: current };
        // free: the lease lapsed while the tab slept — take it again with a new token
        return { ok: true, lock: await fresh(tx, record, holder, now) };
      }),

    release: (record, token, now) =>
      onRecord(record, now, async (tx, current) => {
        if (current === undefined || current.token !== token) return false;
        await sql`DELETE FROM studio.edit_lock WHERE record = ${record}`.execute(tx);
        await notify(tx, record);
        return true;
      }),

    request: (record, requester, now) =>
      onRecord(record, now, async (tx, current) => {
        if (current === undefined) return undefined;
        const request = { name: requester.name, clientId: requester.clientId, tabId: requester.tabId, at: now };
        await sql`UPDATE studio.edit_lock SET request = ${JSON.stringify(request)}::jsonb, declined = NULL WHERE record = ${record}`.execute(tx);
        await notify(tx, record);
        const { declined: _declined, ...rest } = current;
        return { ...rest, request };
      }),

    decline: (record, token, now) =>
      onRecord(record, now, async (tx, current) => {
        if (current === undefined || current.token !== token || current.request === undefined) return current;
        const declined = { name: current.request.name, tabId: current.request.tabId, at: now };
        await sql`UPDATE studio.edit_lock SET declined = ${JSON.stringify(declined)}::jsonb, request = NULL WHERE record = ${record}`.execute(tx);
        await notify(tx, record);
        const { request: _request, ...rest } = current;
        return { ...rest, declined };
      }),

    takeOver: (record, holder, now, force): Promise<TakeOverResult> =>
      onRecord(record, now, async (tx, current) => {
        if (current === undefined) return { ok: true, lock: await fresh(tx, record, holder, now) };
        if (!force) return { ok: false, reason: 'live', lock: current };
        await sql`
          INSERT INTO studio.edit_lock_displaced (org_id, token, record, at_ms, until_ms)
          VALUES (${orgId}::uuid, ${current.token}::uuid, ${record}, ${now}, ${now + leaseMs})
          ON CONFLICT (org_id, token) DO UPDATE SET at_ms = EXCLUDED.at_ms, until_ms = EXCLUDED.until_ms`.execute(tx);
        const lock = await fresh(tx, record, holder, now);
        return { ok: true, lock, displaced: current.holder };
      }),

    get: (record, now) => onRecord(record, now, async (_tx, current) => current),

    list: (now) =>
      inOrg(db, orgId, async (tx) => {
        await sql`DELETE FROM studio.edit_lock WHERE seen_ms + ${leaseMs} <= ${now}`.execute(tx);
        await sql`DELETE FROM studio.edit_lock_displaced WHERE until_ms <= ${now}`.execute(tx);
        const rows = (await sql<Row>`SELECT record, token::text AS token, holder, since_ms::text AS since_ms, seen_ms::text AS seen_ms, request, declined FROM studio.edit_lock ORDER BY record`.execute(tx)).rows;
        return rows.map(lockOf);
      }),
  };
}
