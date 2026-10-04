/**
 * The last copy of each API answer this browser fetched — the studio's only
 * offline fallback. The bundle no longer carries catalog
 * data: every read goes to the workbench API, and each successful answer is
 * remembered here so that, when the API cannot be reached, a screen can still
 * show *something* read-only under the "offline copy — read only" banner.
 *
 * - IndexedDB when the browser has it (the db and the design list are a few
 *   MB — too big for localStorage), an in-memory map otherwise (tests, private
 *   windows that refuse IndexedDB). Every call is wrapped: a cache that cannot
 *   be written or read is simply empty, never an error.
 * - A cached value is never a save baseline: every caller flags what it
 *   returns from here as offline, exactly as the build-time copy was.
 */

const DB_NAME = 'cable-studio-offline';
const STORE = 'answers';

export interface CachedAnswer<T> {
  value: T;
  /** when this copy was fetched, ISO */
  savedAt: string;
}

const memory = new Map<string, CachedAnswer<unknown>>();

let opening: Promise<IDBDatabase | undefined> | undefined;
function database(): Promise<IDBDatabase | undefined> {
  opening ??= new Promise((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (idb === undefined) {
        resolve(undefined);
        return;
      }
      const request = idb.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return opening;
}

/** Remember an answer (fire and forget — a failed write only means no offline copy). */
export async function remember<T>(key: string, value: T, now = new Date()): Promise<void> {
  const entry: CachedAnswer<T> = { value, savedAt: now.toISOString() };
  memory.set(key, entry);
  try {
    const db = await database();
    if (db === undefined) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // no offline copy, then
  }
}

let lastRecalled: string | undefined;

/** The last answer remembered under `key`, or `undefined`. */
export async function recall<T>(key: string): Promise<CachedAnswer<T> | undefined> {
  let found = memory.get(key) as CachedAnswer<T> | undefined;
  if (found === undefined) {
    try {
      const db = await database();
      if (db !== undefined) {
        found = await new Promise<CachedAnswer<T> | undefined>((resolve) => {
          const tx = db.transaction(STORE, 'readonly');
          const request = tx.objectStore(STORE).get(key);
          request.onsuccess = () => resolve(request.result as CachedAnswer<T> | undefined);
          request.onerror = () => resolve(undefined);
        });
      }
    } catch {
      found = undefined;
    }
  }
  if (found !== undefined) lastRecalled = found.savedAt;
  return found;
}

/**
 * When the offline copy on screen was fetched, for the banner ("offline copy
 * from 2026-09-26 14:05 — read only"): the newest copy recalled so far.
 */
export function offlineCopyFrom(): string {
  return lastRecalled === undefined ? 'an earlier visit' : lastRecalled.slice(0, 16).replace('T', ' ');
}

/** Forget everything — tests. */
export function clearOfflineCache(): void {
  memory.clear();
  lastRecalled = undefined;
}
