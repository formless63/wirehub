/**
 * Edit locks — the lease table.
 *
 * One lease per record (`src/locks/records.ts` names them). A holder takes it
 * with `acquire`, keeps it with a `heartbeat` at least every `LEASE_MS`, and
 * gives it back with `release`; a lease nobody renews lapses on its own and
 * is swept the next time anything reads the table. Every mutating write to a
 * leased record must quote the lease's token (`holds`) — the API gate
 * (`lock-api.ts`) answers 423 otherwise. Reads are never gated.
 *
 * **Storage-agnostic on purpose.** Every method is async and takes `now`
 * (epoch ms) from the caller, so a Postgres-backed store (a `locks` table,
 * `SELECT … FOR UPDATE` per record) can replace `memoryLockStore` without the
 * gate or the endpoints changing. The in-memory table is enough for today's
 * single-process server; a restart empties it, and a holder's next heartbeat
 * simply takes the lease again (`heartbeat` re-acquires a free record).
 */

import { randomUUID } from 'node:crypto';

import { LEASE_MS, type LockHolderView, type LockView } from '../../src/locks/records.ts';

/** A holder as the store keeps it; `email` only with the login on. */
export interface LockHolder extends LockHolderView {
  email?: string;
}

/** A lease, token and all — never sent to anyone but its holder. */
export interface EditLock {
  record: string;
  token: string;
  holder: LockHolder;
  since: number;
  seenAt: number;
  request?: { name: string; clientId: string; tabId: string; at: number };
  declined?: { name: string; tabId: string; at: number };
}

export type AcquireResult = { ok: true; lock: EditLock } | { ok: false; lock: EditLock };

/**
 * A heartbeat either renews (possibly re-acquiring a record a restart or an
 * expiry freed — `token` may be new), or says the lease is gone to someone
 * else (`lost`, with who has it now and, when they took it over, when).
 */
export type HeartbeatResult =
  | { ok: true; lock: EditLock }
  | { ok: false; lost: true; lock: EditLock | undefined; takenOverAt?: number };

export type TakeOverResult =
  | { ok: true; lock: EditLock; displaced?: LockHolder }
  | { ok: false; reason: 'live'; lock: EditLock };

export interface LockStore {
  /** Take a free (or lapsed) record. A record held by anyone else — this holder's other tab included — is refused with who has it. */
  acquire(record: string, holder: LockHolder, now: number): Promise<AcquireResult>;
  /** Renew `token`'s lease; a free record is taken afresh (after a restart), one taken over is `lost`. */
  heartbeat(record: string, token: string, holder: LockHolder, now: number): Promise<HeartbeatResult>;
  /** Give it back; `false` when `token` does not hold it (already gone — nothing to do). */
  release(record: string, token: string, now: number): Promise<boolean>;
  /** "Request edit": note who is asking, for the holder's next heartbeat. `undefined` when the record is free. */
  request(record: string, requester: LockHolder, now: number): Promise<EditLock | undefined>;
  /** The holder answered a request with Keep. */
  decline(record: string, token: string, now: number): Promise<EditLock | undefined>;
  /** Take a record: free → like `acquire`; held and live → only with `force`. */
  takeOver(record: string, holder: LockHolder, now: number, force: boolean): Promise<TakeOverResult>;
  /** The live lease on a record, if any. */
  get(record: string, now: number): Promise<EditLock | undefined>;
  /** Every live lease. */
  list(now: number): Promise<EditLock[]>;
}

export interface MemoryLockStoreOptions {
  leaseMs?: number;
  /** token source, injectable so tests read stable tokens */
  newToken?: () => string;
}

export function memoryLockStore(options: MemoryLockStoreOptions = {}): LockStore {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const newToken = options.newToken ?? randomUUID;
  const table = new Map<string, EditLock>();
  /**
   * Tokens that were taken over, until their lease would have lapsed anyway:
   * the displaced holder's next heartbeat is told `lost` rather than quietly
   * re-acquiring a record that has since been released. Forgotten on restart,
   * like everything else here.
   */
  const displaced = new Map<string, { record: string; at: number; until: number }>();

  const sweep = (now: number): void => {
    for (const [record, lock] of table) if (lock.seenAt + leaseMs <= now) table.delete(record);
    for (const [token, gone] of displaced) if (gone.until <= now) displaced.delete(token);
  };
  const live = (record: string, now: number): EditLock | undefined => {
    sweep(now);
    return table.get(record);
  };
  const fresh = (record: string, holder: LockHolder, now: number): EditLock => {
    const lock: EditLock = { record, token: newToken(), holder: { ...holder }, since: now, seenAt: now };
    table.set(record, lock);
    return lock;
  };

  return {
    async acquire(record, holder, now) {
      const current = live(record, now);
      if (current !== undefined) return { ok: false, lock: current };
      return { ok: true, lock: fresh(record, holder, now) };
    },

    async heartbeat(record, token, holder, now) {
      const current = live(record, now);
      if (current !== undefined && current.token === token) {
        current.seenAt = now;
        return { ok: true, lock: current };
      }
      const gone = displaced.get(token);
      if (gone !== undefined && gone.record === record) {
        return { ok: false, lost: true, lock: current, takenOverAt: gone.at };
      }
      if (current !== undefined) return { ok: false, lost: true, lock: current };
      // free: the server restarted, or the lease lapsed while the tab slept —
      // take it again with a new token
      return { ok: true, lock: fresh(record, holder, now) };
    },

    async release(record, token, now) {
      const current = live(record, now);
      if (current === undefined || current.token !== token) return false;
      table.delete(record);
      return true;
    },

    async request(record, requester, now) {
      const current = live(record, now);
      if (current === undefined) return undefined;
      current.request = { name: requester.name, clientId: requester.clientId, tabId: requester.tabId, at: now };
      delete current.declined;
      return current;
    },

    async decline(record, token, now) {
      const current = live(record, now);
      if (current === undefined || current.token !== token || current.request === undefined) return current;
      current.declined = { name: current.request.name, tabId: current.request.tabId, at: now };
      delete current.request;
      return current;
    },

    async takeOver(record, holder, now, force) {
      const current = live(record, now);
      if (current === undefined) return { ok: true, lock: fresh(record, holder, now) };
      if (!force) return { ok: false, reason: 'live', lock: current };
      displaced.set(current.token, { record, at: now, until: now + leaseMs });
      const lock = fresh(record, holder, now);
      return { ok: true, lock, displaced: current.holder };
    },

    async get(record, now) {
      return live(record, now);
    },

    async list(now) {
      sweep(now);
      return [...table.values()];
    },
  };
}

/** A lease as anyone may see it: no token, times as ISO strings. */
export function lockView(lock: EditLock, leaseMs = LEASE_MS): LockView {
  const iso = (ms: number): string => new Date(ms).toISOString();
  return {
    record: lock.record,
    holder: { name: lock.holder.name, clientId: lock.holder.clientId, tabId: lock.holder.tabId },
    since: iso(lock.since),
    seenAt: iso(lock.seenAt),
    expiresAt: iso(lock.seenAt + leaseMs),
    ...(lock.request === undefined ? {} : { request: { ...lock.request, at: iso(lock.request.at) } }),
    ...(lock.declined === undefined ? {} : { declined: { ...lock.declined, at: iso(lock.declined.at) } }),
  };
}

/** Whether a write quoting `tokens` may touch `record` given its lease (or none). */
export function holds(lock: EditLock | undefined, tokens: readonly string[]): boolean {
  return lock === undefined || tokens.includes(lock.token);
}
