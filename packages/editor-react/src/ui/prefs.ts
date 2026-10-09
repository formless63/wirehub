/**
 * Per-person UI preferences, behind one seam. The editor package never talks to a server: a host
 * installs a backend (`setPrefsBackend`, the studio's one syncs with the account), and until it does
 * the default backend keeps each choice in this browser's `localStorage` (the offline fallback).
 * Keys are short dotted words (`cols.designs`, `slot-pins`, `theme`); values are JSON.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';

export interface PrefsBackend {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  /** called when values change from outside (a server hydrate); returns the unsubscribe */
  subscribe(listener: () => void): () => void;
}

const PREFIX = 'wirehub:pref:';

/** localStorage only; legacy `cols.<key>` choices were stored as `wirehub:cols:<key>` */
export function localPrefsBackend(): PrefsBackend {
  const listeners = new Set<() => void>();
  const storage = (): Storage | undefined => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    get(key) {
      try {
        const s = storage();
        const raw = s?.getItem(`${PREFIX}${key}`) ?? (key.startsWith('cols.') ? s?.getItem(`wirehub:cols:${key.slice(5)}`) : null) ?? null;
        return raw === null ? undefined : (JSON.parse(raw) as unknown);
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        storage()?.setItem(`${PREFIX}${key}`, JSON.stringify(value));
      } catch {
        // a private window or blocked storage: the choice lasts this page only
      }
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

let backend: PrefsBackend = localPrefsBackend();
const swaps = new Set<() => void>();

export function setPrefsBackend(next: PrefsBackend): void {
  backend = next;
  for (const l of swaps) l();
}

export const readPref = (key: string): unknown => backend.get(key);
export const writePref = (key: string, value: unknown): void => backend.set(key, value);

/** A preference as state: the stored value (or `fallback`), and a setter that stores it. */
export function usePref<T>(key: string | undefined, fallback: T, valid: (v: unknown) => v is T): [T, (next: T) => void] {
  const subscribe = useCallback((l: () => void) => {
    const off = backend.subscribe(l);
    swaps.add(l);
    return () => {
      off();
      swaps.delete(l);
    };
  }, []);
  // the snapshot is the raw stored text of the value, so an unchanged value is referentially stable
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (key === undefined ? '' : JSON.stringify(backend.get(key) ?? null)),
    () => '',
  );
  const stored = snapshot === '' || snapshot === 'null' ? undefined : (JSON.parse(snapshot) as unknown);
  // with no key there is nothing to remember: plain state
  const [local, setLocal] = useState<T | undefined>(undefined);
  const value = key === undefined ? (local ?? fallback) : stored !== undefined && valid(stored) ? stored : fallback;
  const set = useCallback((next: T) => {
    if (key === undefined) setLocal(next);
    else backend.set(key, next);
  }, [key]);
  return [value, set];
}
