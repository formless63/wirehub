/**
 * Who is using the studio — `GET /api/me`.
 *
 * With the login on (`AUTH_ENABLED=true`, standalone server) the person is the
 * Better Auth session's user, handed to the router on the request by the host
 * adapter. With it off, there is no session: the studio names a configurable
 * local user — `WIREHUB_LOCAL_USER`, else the machine's `git config user.name`,
 * else `local`. Records that say who (declined proposals) take the name from
 * here, and the rail's avatar shows its initials.
 */

import { execFileSync } from 'node:child_process';

import { envVar } from './env.ts';

export interface StudioUser {
  name: string;
  email?: string;
  /** what the person may do here: owners and editors write, viewers read (`GET /api/me`); absent when this host keeps no roles (then everyone who is signed in may write) */
  role?: 'owner' | 'editor' | 'viewer';
  /** `session` — signed in through the studio's login; `local` — auth is off */
  source: 'session' | 'local';
  /** the personal API token this request came with (its id, for the change set's audit only) */
  apiTokenId?: string;
  /** that token's scopes (a batch checks `imports` for doc writes) */
  apiTokenScopes?: readonly string[];
}

export const ME_ROUTES = ['GET    /api/me'] as const;

/** `git config user.name`, or `undefined` when git or the setting is missing. */
export function gitUserName(): string | undefined {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/** The user a studio without a login names. `gitName` is injected so tests never shell out. */
export function localStudioUser(env: Readonly<Record<string, string | undefined>>, gitName: () => string | undefined = gitUserName): StudioUser {
  const configured = envVar('LOCAL_USER', env)?.trim();
  return { name: configured !== undefined && configured !== '' ? configured : (gitName() ?? 'local'), source: 'local', role: 'owner' };
}

/** A Better Auth session user as a studio user — the name, or the email when the IdP sent none. */
export function sessionStudioUser(user: { name?: string | null; email: string }): StudioUser {
  const name = user.name?.trim();
  return { name: name !== undefined && name !== '' ? name : user.email, email: user.email, source: 'session' };
}

export const LOCAL_FALLBACK: StudioUser = { name: 'local', source: 'local', role: 'owner' };
