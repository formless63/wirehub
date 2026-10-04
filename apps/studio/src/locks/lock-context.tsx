/**
 * Edit locks — the page's `LockClient`, handed to
 * every scope, banner and list marker through context. No provider (the
 * shell tests, a host without locks) → `undefined`, and every lock component
 * renders as if locks did not exist.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

import type { LockClient, LockSnapshot } from './lock-client.ts';
import type { LockView } from './records.ts';

export const LockClientContext = createContext<LockClient | undefined>(undefined);

export function useLockClient(): LockClient | undefined {
  return useContext(LockClientContext);
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const NO_SNAPSHOT = (): undefined => undefined;

/** The client's current snapshot, re-rendering on every change; `undefined` without a client. */
export function useLockSnapshot(): LockSnapshot | undefined {
  const client = useLockClient();
  return useSyncExternalStore(
    client === undefined ? NO_SUBSCRIBE : client.subscribe,
    client === undefined ? NO_SNAPSHOT : client.snapshot,
  );
}

/** The lease on `record` held by anyone but this tab, if there is one. */
export function otherHolder(snapshot: LockSnapshot | undefined, record: string): LockView | undefined {
  if (snapshot === undefined) return undefined;
  const lock = snapshot.locks.get(record);
  if (lock === undefined || snapshot.held.has(record) || lock.holder.tabId === snapshot.me.tabId) return undefined;
  return lock;
}

/** `14:02` — a lease time in this viewer's clock. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
