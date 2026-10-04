/**
 * The LockStore contract (`specs/postgres-backend.md` §10): the lease table's
 * behaviour — acquire and refuse, lapse and sweep, forced take-over with the
 * displaced holder told it lost, release, request and Keep — run on the
 * in-memory store and on Postgres (`test/pg/locks.server.test.ts`).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { LockHolder, LockStore } from '../../server/locks/lock-store.ts';
import { LEASE_MS } from '../../src/locks/records.ts';

const ALEX: LockHolder = { name: 'Alex', clientId: 'client-alex-1', tabId: 'tab-alex-1' };
const WILL: LockHolder = { name: 'Sam', clientId: 'client-sam-1', tabId: 'tab-sam-1' };

/** uuid-shaped tokens, so a database store can keep them */
export const tokenN = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function tokens(): () => string {
  let n = 0;
  return () => tokenN(++n);
}

export function describeLockContract(name: string, make: (newToken: () => string) => Promise<LockStore> | LockStore, wrap: typeof describe = describe): void {
 wrap(`LockStore (${name})`, () => {
  let store: LockStore;
  beforeEach(async () => {
    store = await make(tokens());
  });

  it('acquires a free record and refuses a second holder — another tab of the same browser included', async () => {
    const first = await store.acquire('design:x', ALEX, 1000);
    expect(first).toMatchObject({ ok: true, lock: { token: tokenN(1), holder: { name: 'Alex' } } });
    expect(await store.acquire('design:x', WILL, 2000)).toMatchObject({ ok: false, lock: { holder: { name: 'Alex' } } });
    expect((await store.acquire('design:x', { ...ALEX, tabId: 'tab-alex-2' }, 2000)).ok).toBe(false);
    // other records are independent
    expect((await store.acquire('design:y', WILL, 2000)).ok).toBe(true);
  });

  it('lets a lease lapse LEASE_MS after the last heartbeat, and sweeps it', async () => {
    const { lock } = (await store.acquire('design:x', ALEX, 0)) as { lock: { token: string } };
    expect((await store.heartbeat('design:x', lock.token, ALEX, LEASE_MS - 1)).ok).toBe(true);
    // renewed at LEASE_MS-1: still live just before 2×LEASE_MS-1
    expect(await store.get('design:x', 2 * LEASE_MS - 2)).toBeDefined();
    expect(await store.get('design:x', 2 * LEASE_MS)).toBeUndefined();
    expect(await store.list(2 * LEASE_MS)).toEqual([]);
    expect((await store.acquire('design:x', WILL, 2 * LEASE_MS)).ok).toBe(true);
  });

  it('refuses a live takeover without force; a forced one displaces the holder, whose heartbeat is told it lost', async () => {
    const alex = await store.acquire('design:x', ALEX, 0);
    expect(await store.takeOver('design:x', WILL, 1000, false)).toMatchObject({ ok: false, reason: 'live' });
    const will = await store.takeOver('design:x', WILL, 1000, true);
    expect(will).toMatchObject({ ok: true, lock: { holder: { name: 'Sam' } }, displaced: { name: 'Alex' } });
    const beat = await store.heartbeat('design:x', alex.lock.token, ALEX, 2000);
    expect(beat).toMatchObject({ ok: false, lost: true, takenOverAt: 1000, lock: { holder: { name: 'Sam' } } });
    // …even after Sam let go: Alex is not quietly handed it back
    await store.release('design:x', (will as { lock: { token: string } }).lock.token, 3000);
    expect(await store.heartbeat('design:x', alex.lock.token, ALEX, 4000)).toMatchObject({ ok: false, lost: true });
  });

  it('a takeover of a free (or lapsed) record needs no force', async () => {
    await store.acquire('design:x', ALEX, 0);
    expect((await store.takeOver('design:x', WILL, LEASE_MS + 1, false)).ok).toBe(true);
  });

  it('releases only with the holding token', async () => {
    const { lock } = await store.acquire('design:x', ALEX, 0);
    expect(await store.release('design:x', 'nope', 1)).toBe(false);
    expect(await store.get('design:x', 1)).toBeDefined();
    expect(await store.release('design:x', lock.token, 1)).toBe(true);
    expect(await store.get('design:x', 1)).toBeUndefined();
  });

  it('carries a request to the holder, and Keep answers it', async () => {
    const { lock } = await store.acquire('design:x', ALEX, 0);
    expect(await store.request('design:free', WILL, 5)).toBeUndefined();
    expect(await store.request('design:x', WILL, 5)).toMatchObject({ request: { name: 'Sam', tabId: 'tab-sam-1' } });
    const beat = await store.heartbeat('design:x', lock.token, ALEX, 6);
    expect(beat).toMatchObject({ ok: true, lock: { request: { name: 'Sam' } } });
    const kept = await store.decline('design:x', lock.token, 7);
    expect(kept?.request).toBeUndefined();
    expect(kept?.declined).toMatchObject({ name: 'Sam', tabId: 'tab-sam-1' });
  });
});
}
