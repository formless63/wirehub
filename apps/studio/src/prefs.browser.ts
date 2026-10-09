/**
 * The studio's per-person UI preferences: module slot pins, theme, table column choices
 * (`@wirehub/editor-react`'s `ui/prefs.ts` seam). They live on the hub, per account
 * (`GET`/`PUT /api/me/prefs`, `server/user-prefs.ts`), so they follow the person across browsers;
 * this browser's `localStorage` keeps a copy per user as the offline fallback.
 *
 * Reads are synchronous from the in-memory copy (seeded from localStorage at once, then from the
 * hub when `hydratePrefs` hears back). A change is stored locally first and sent to the hub a
 * moment later; one the hub could not take stays marked and goes up on the next hydrate. A key
 * the hub has not got yet but this browser has (a choice made before this existed, or offline)
 * is sent up when the hub answers, so nothing a person chose is lost.
 */

import { localPrefsBackend, setPrefsBackend, type PrefsBackend } from '@wirehub/editor-react';

import { request } from './definitions.browser.ts';

const MIRROR = 'wirehub:prefs:';
const FLUSH_MS = 400;

type Prefs = Record<string, unknown>;

interface PrefsClient extends PrefsBackend {
  /** adopt `user`'s local copy, then the hub's; resolves when the hub has answered (or could not) */
  hydrate(user: string): Promise<void>;
  /** send what is waiting now */
  flush(): Promise<void>;
}

export function createPrefsBackend(base = '/api', storage: () => Storage | undefined = () => globalThis.localStorage, debounceMs = FLUSH_MS): PrefsClient {
  const legacy = localPrefsBackend();
  const listeners = new Set<() => void>();
  let user = 'local';
  let cache: Prefs = {};
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const mirror = (): void => {
    try {
      storage()?.setItem(`${MIRROR}${user}`, JSON.stringify({ values: cache, dirty: [...dirty] }));
    } catch {
      // blocked storage: the hub copy (or this page) is all there is
    }
  };
  const readMirror = (): void => {
    try {
      const raw = storage()?.getItem(`${MIRROR}${user}`);
      const parsed = raw === null || raw === undefined ? undefined : (JSON.parse(raw) as { values?: Prefs; dirty?: string[] });
      cache = parsed?.values !== undefined && typeof parsed.values === 'object' ? parsed.values : {};
      dirty.clear();
      for (const k of parsed?.dirty ?? []) if (k in cache) dirty.add(k);
    } catch {
      cache = {};
    }
  };
  const emit = (): void => {
    for (const l of listeners) l();
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (dirty.size === 0) return;
    const keys = [...dirty];
    const patch = Object.fromEntries(keys.map((k) => [k, cache[k] ?? null]));
    const out = await request<{ prefs: Prefs }>(`${base}/me/prefs`, { method: 'PUT', body: { prefs: patch } });
    if (!out.ok) return; // stays marked: tried again at the next change or hydrate
    for (const k of keys) if (JSON.stringify(cache[k] ?? null) === JSON.stringify(patch[k])) dirty.delete(k);
    mirror();
  };
  const later = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };

  return {
    get: (key) => (key in cache ? cache[key] : legacy.get(key)),
    set(key, value) {
      cache = { ...cache, [key]: value };
      dirty.add(key);
      mirror();
      emit();
      later();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    flush,
    async hydrate(next) {
      user = next;
      readMirror();
      emit();
      const out = await request<{ prefs: Prefs }>(`${base}/me/prefs`);
      if (!out.ok || typeof out.value.prefs !== 'object' || out.value.prefs === null) return;
      const hub = out.value.prefs;
      // the hub wins, except for a change this browser made that has not gone up yet; a key only this browser has goes up
      const merged: Prefs = { ...hub };
      for (const k of Object.keys(cache)) {
        if (dirty.has(k) || !(k in hub)) {
          merged[k] = cache[k];
          dirty.add(k);
        }
      }
      cache = merged;
      mirror();
      emit();
      await flush();
    },
  };
}

/** the page's one client, installed as the editor's preference backend */
const client = createPrefsBackend();
setPrefsBackend(client);

export const hydratePrefs = (user: string): Promise<void> => client.hydrate(user);
