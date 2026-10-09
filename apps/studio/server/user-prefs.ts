/**
 * Per-user UI preferences: slot pins, theme, table column choices. The hub keeps them
 * per person so they follow the account across browsers (the browser's localStorage stays
 * as the offline fallback, `src/prefs.browser.ts`).
 *
 * Not catalog data: no change set, history entry, export or git mirror ever sees them, and
 * every role (viewers included) reads and writes only its own. `GET /api/me/prefs` answers
 * the person's preferences; `PUT /api/me/prefs` merges a patch (`null` clears a key).
 *
 * A value is any JSON; keys are short dotted words. Limits keep one person from filling the disk.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.ts';
import type { StudioUser } from './me.ts';

export type PrefValue = string | number | boolean | null | PrefValue[] | { [key: string]: PrefValue };
export type Prefs = Record<string, PrefValue>;

export const PREFS_ROUTES = ['GET    /api/me/prefs', 'PUT    /api/me/prefs'] as const;
export const PREF_KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const MAX_PREF_KEYS = 64;
export const MAX_PREF_BYTES = 16 * 1024;

export interface UserPrefsStore {
  get(userKey: string): Promise<Prefs>;
  /** merge `patch` over the stored preferences (a `null` value removes its key); answers the result */
  merge(userKey: string, patch: Prefs): Promise<Prefs>;
}

/** Who the preferences belong to: the signed-in email, else the local user's name. */
export function prefsUserKey(user: StudioUser): string {
  return user.source === 'session' && user.email !== undefined ? `email:${user.email.toLowerCase()}` : `local:${user.name}`;
}

/** The patch as a typed object, or why it is refused. */
export function parsePrefsPatch(body: unknown, current: Prefs): { ok: true; patch: Prefs; next: Prefs } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Send an object of preferences.' };
  const raw = (body as { prefs?: unknown }).prefs ?? body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'Send an object of preferences.' };
  const patch: Prefs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PREF_KEY.test(key) || key.length > 64) return { ok: false, error: `"${key}" is not a preference name (lower-case words, dots or hyphens).` };
    if (value !== null && JSON.stringify(value).length > MAX_PREF_BYTES) return { ok: false, error: `The value of "${key}" is too large.` };
    patch[key] = value as PrefValue;
  }
  const next = applyPatch(current, patch);
  if (Object.keys(next).length > MAX_PREF_KEYS) return { ok: false, error: `At most ${MAX_PREF_KEYS} preferences are kept.` };
  return { ok: true, patch, next };
}

export function applyPatch(current: Prefs, patch: Prefs): Prefs {
  const next: Prefs = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function memoryPrefsStore(): UserPrefsStore {
  const all = new Map<string, Prefs>();
  return {
    get: async (userKey) => ({ ...(all.get(userKey) ?? {}) }),
    merge: async (userKey, patch) => {
      const next = applyPatch(all.get(userKey) ?? {}, patch);
      all.set(userKey, next);
      return { ...next };
    },
  };
}

/** One JSON file per person under `dir` (named by a hash of the key, so no account name ever reaches a path). */
export function filePrefsStore(dir: string): UserPrefsStore {
  const path = (userKey: string): string => join(dir, `${createHash('sha256').update(userKey).digest('hex').slice(0, 32)}.json`);
  const read = (userKey: string): Prefs => {
    try {
      const file = path(userKey);
      if (!existsSync(file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Prefs) : {};
    } catch {
      return {};
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get: async (userKey) => read(userKey),
    merge: (userKey, patch) => {
      const run = queue.then(() => {
        const next = applyPatch(read(userKey), patch);
        mkdirSync(dir, { recursive: true });
        writeFileAtomic(path(userKey), `${JSON.stringify(next)}\n`);
        return next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
