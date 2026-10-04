/**
 * The Postgres backend's environment (`specs/postgres-backend.md` §8.2).
 *
 * | Variable | Default | |
 * | --- | --- | --- |
 * | `WIREHUB_BACKEND` | `files` | `files` / `pg`: which stores `default-deps.ts` builds |
 * | `DATABASE_URL` | — | the app's connection, as `studio_app` (pg only) |
 * | `DATABASE_OWNER_URL` | — | `db:migrate` only, as `studio_owner` |
 * | `DATABASE_ADMIN_URL` | — | `db:bootstrap` only: a superuser, to create the roles and the database |
 * | `WIREHUB_ORG` | the only org | the org slug this process acts for (v1 runs one org per deployment) |
 * | `WIREHUB_OWNER_PASSWORD`, `WIREHUB_APP_PASSWORD`, `WIREHUB_RO_PASSWORD` | — | `db:bootstrap`: the role passwords |
 *
 * Nothing here opens a connection; `db.ts` does.
 */

import type { Env } from '../env.ts';

export type Backend = 'files' | 'pg';

export class PgConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgConfigError';
  }
}

/** `WIREHUB_BACKEND`: `files` (the default) or `pg`. */
export function backendFromEnv(env: Env = process.env): Backend {
  const value = (env.WIREHUB_BACKEND ?? '').trim();
  if (value === '' || value === 'files') return 'files';
  if (value === 'pg') return 'pg';
  throw new PgConfigError(`WIREHUB_BACKEND must be 'files' or 'pg'; got '${value}'.`);
}

export interface PgAppConfig {
  /** `DATABASE_URL` */
  url: string;
  /** `WIREHUB_ORG`; absent → the deployment's only org */
  org?: string;
}

export function pgAppConfigFromEnv(env: Env = process.env): PgAppConfig {
  const url = (env.DATABASE_URL ?? '').trim();
  if (url === '') throw new PgConfigError('WIREHUB_BACKEND=pg needs DATABASE_URL (the studio_app connection; see .env.example).');
  const org = (env.WIREHUB_ORG ?? '').trim();
  return { url, ...(org === '' ? {} : { org }) };
}

/** A variable a command cannot run without, or a sentence naming it. */
export function requireEnv(env: Env, name: string, what: string): string {
  const value = (env[name] ?? '').trim();
  if (value === '') throw new PgConfigError(`${what} needs ${name}.`);
  return value;
}

/** A connection URL with its password masked, for logs. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable URL)';
  }
}
