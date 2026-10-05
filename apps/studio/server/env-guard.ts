/**
 * The environment guard (`specs/postgres-backend.md` §8.7; task S5): a
 * production and a development instance kept apart by `WIREHUB_ENV`. At boot
 * the studio refuses to start when the environment and its configuration
 * disagree:
 *
 * - `WIREHUB_ENV` is something other than `dev` or `prod` (unset = neither:
 *   development from source and tests);
 * - a `prod` process on the file backend, unless `WIREHUB_ALLOW_FILES_IN_PROD=1`
 *   (a small single-user install that chose files on purpose);
 * - a `dev` process whose database or bucket matches a production marker
 *   (`WIREHUB_PROD_MARKERS`: comma-separated substrings of production's
 *   database host or name and bucket — a dev copy pointed at prod by mistake).
 *
 * A token of the other environment is refused per request (`auth/tokens.ts`).
 */

import type { Env } from './env.ts';

export type WireHubEnv = 'dev' | 'prod' | undefined;

export function wirehubEnv(env: Env): WireHubEnv {
  const value = (env['WIREHUB_ENV'] ?? '').trim();
  return value === 'dev' || value === 'prod' ? value : undefined;
}

const yes = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? '').trim());

/** Why this process must not start, or `undefined` when its configuration fits its environment. */
export function environmentRefusal(env: Env): string | undefined {
  const raw = (env['WIREHUB_ENV'] ?? '').trim();
  if (raw !== '' && raw !== 'dev' && raw !== 'prod') return `WIREHUB_ENV must be 'dev' or 'prod'; got '${raw}'.`;
  const backend = (env['WIREHUB_BACKEND'] ?? '').trim() || 'files';
  if (raw === 'prod' && backend === 'files' && !yes(env['WIREHUB_ALLOW_FILES_IN_PROD'])) {
    return 'WIREHUB_ENV=prod runs on the database backend (WIREHUB_BACKEND=pg). A production hub that keeps its catalog in files on purpose sets WIREHUB_ALLOW_FILES_IN_PROD=1.';
  }
  if (raw === 'dev') {
    const markers = (env['WIREHUB_PROD_MARKERS'] ?? '')
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter((m) => m !== '');
    const places: [string, string][] = [];
    const db = (env['DATABASE_URL'] ?? '').trim();
    if (db !== '') {
      try {
        const url = new URL(db);
        places.push(['the database', `${url.hostname}${url.pathname}`.toLowerCase()]);
      } catch {
        places.push(['the database', db.toLowerCase()]);
      }
    }
    const bucket = (env['S3_BUCKET'] ?? '').trim();
    if (bucket !== '') places.push(['the bucket', `${(env['S3_ENDPOINT'] ?? '').toLowerCase()}/${bucket.toLowerCase()}`]);
    for (const marker of markers) {
      for (const [what, where] of places) {
        if (where.includes(marker)) return `This is a development instance (WIREHUB_ENV=dev), but ${what} matches the production marker '${marker}' (WIREHUB_PROD_MARKERS). Point it at the development copy.`;
      }
    }
  }
  return undefined;
}
