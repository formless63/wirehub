/**
 * Who is using the studio (`GET /api/me`). Nothing here throws: an
 * unreachable API answers the local user.
 */

import { request } from './definitions.browser.ts';

/** who is using the studio (`GET /api/me`) */
export interface StudioUser {
  name: string;
  email?: string;
  source: 'session' | 'local';
}

export const meKey = ['me'] as const;

/** The signed-in (or local) user; `local` when the API cannot be reached. */
export async function loadMe(base = '/api'): Promise<StudioUser> {
  const out = await request<{ user: StudioUser }>(`${base}/me`);
  return out.ok ? out.value.user : { name: 'local', source: 'local' };
}

/** Up to two initials for the avatar: "Ada Lovelace" → "AL", "ada" → "A". */
export function initialsOf(name: string): string {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words.map((w) => [...w].find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? '');
  const out = (letters.length > 1 ? [letters[0], letters[letters.length - 1]] : letters).join('');
  return out === '' ? '?' : out.toUpperCase();
}
