/**
 * Personal API tokens (`specs/postgres-backend.md` §3.16, §4.5; task B12).
 *
 * A script or an agent calls the API with a token of the person who runs it;
 * the change is that person's. The token is shown once, at creation:
 * `cst_<env>_<id12>_<secret>` — `<env>` is `dev` or `prod` (`WIREHUB_ENV`),
 * `<id12>` the first 12 hex of the row id, `<secret>` 32 random bytes in
 * base32. Only `sha256(token)` is stored; the secret's 256 bits make a slow
 * hash pointless.
 *
 * Scopes narrow what the person may do, never widen it: `read` always;
 * `catalog:write` for every write route of the GUI and `POST /api/batch`;
 * `imports` for `PUT /api/docs/*`. The person's current role still applies.
 */

import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'kysely';

import { inOrg, orgOf, type Db, type OrgRef } from '../pg/db.ts';
import type { Person, Role } from './people.ts';

export const TOKEN_SCOPES = ['read', 'catalog:write', 'imports'] as const;
export const TOKEN_DAYS = [1, 7, 30, 90] as const;
export type TokenEnv = 'dev' | 'prod';

export interface ApiToken {
  id: string;
  personId: string;
  name: string;
  env: TokenEnv;
  /** the token's first 12 characters after `cst_<env>_`, for recognising it in a list */
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** What a presented token resolves to, before the caller checks scope and role. */
export interface TokenHolder {
  token: ApiToken;
  person: Person;
}

const TOKEN = /^cst_(dev|prod)_([0-9a-f]{12})_([a-z2-7]{52})$/;

export function tokenEnvOf(env: Readonly<Record<string, string | undefined>>): TokenEnv {
  return (env.WIREHUB_ENV ?? '').trim() === 'prod' ? 'prod' : 'dev';
}

/** The environment a presented string claims, or undefined when it is not shaped like a token at all. */
export function parseToken(value: string): { env: TokenEnv; id12: string } | undefined {
  const match = TOKEN.exec(value);
  return match === null ? undefined : { env: match[1] as TokenEnv, id12: match[2] as string };
}

const sha = (token: string): string => createHash('sha256').update(token).digest('hex');

/** RFC 4648 base32, lowercase, no padding. */
function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

interface Row {
  id: string;
  person_id: string;
  name: string;
  env: TokenEnv;
  scopes: string[];
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const tokenOf = (r: Row): ApiToken => ({
  id: r.id,
  personId: r.person_id,
  name: r.name,
  env: r.env,
  prefix: r.id.replace(/-/g, '').slice(0, 12),
  scopes: r.scopes,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  lastUsedAt: iso(r.last_used_at),
  revokedAt: iso(r.revoked_at),
});
const COLUMNS = sql`id::text AS id, person_id::text AS person_id, name, env, scopes, created_at, expires_at, last_used_at, revoked_at`;

export interface TokenStore {
  create(input: { person: Person; name: string; scopes: string[]; days: number; env: TokenEnv }): Promise<{ token: ApiToken; secret: string }>;
  list(personId?: string): Promise<ApiToken[]>;
  revoke(id: string, by: Person): Promise<boolean>;
  /** a live token (unrevoked, unexpired) for this exact string, with its person */
  resolve(value: string): Promise<TokenHolder | undefined>;
  /** at most once a minute per token */
  touch(id: string): Promise<void>;
}

export function pgTokens(db: Db, orgRef: OrgRef, options: { now?: () => Date } = {}): TokenStore {
  // the org may not exist yet (first-run setup creates it): resolved per call
  const org = (): string => orgOf(orgRef);
  const now = options.now ?? (() => new Date());
  const touched = new Map<string, number>();
  return {
    create: ({ person, name, scopes, days, env }) =>
      inOrg(db, org(), async (tx) => {
        const created = now();
        const expires = new Date(created.getTime() + days * 86_400_000);
        const id = (await sql<{ id: string }>`SELECT uuidv7()::text AS id`.execute(tx)).rows[0]!.id;
        const secret = `cst_${env}_${id.replace(/-/g, '').slice(0, 12)}_${base32(randomBytes(32))}`;
        const row = (
          await sql<Row>`
            INSERT INTO auth.api_token (id, org_id, person_id, name, env, token_sha256, scopes, created_at, expires_at, created_by)
            VALUES (${id}::uuid, ${org()}::uuid, ${person.id}::uuid, ${name}, ${env}, ${sha(secret)}, ${[...new Set(['read', ...scopes])]}::text[],
                    ${created.toISOString()}::timestamptz, ${expires.toISOString()}::timestamptz, ${person.id}::uuid)
            RETURNING ${COLUMNS}`.execute(tx)
        ).rows[0] as Row;
        return { token: tokenOf(row), secret };
      }),

    list: (personId) =>
      inOrg(db, org(), async (tx) =>
        (personId === undefined
          ? await sql<Row>`SELECT ${COLUMNS} FROM auth.api_token ORDER BY created_at DESC`.execute(tx)
          : await sql<Row>`SELECT ${COLUMNS} FROM auth.api_token WHERE person_id = ${personId}::uuid ORDER BY created_at DESC`.execute(tx)
        ).rows.map(tokenOf),
      ),

    revoke: (id, by) =>
      inOrg(db, org(), async (tx) => {
        // a person revokes their own; an owner anyone's
        const result = await sql`
          UPDATE auth.api_token SET revoked_at = ${now().toISOString()}::timestamptz, revoked_by = ${by.id}::uuid
           WHERE id = ${id}::uuid AND revoked_at IS NULL AND (person_id = ${by.id}::uuid OR ${by.role === 'owner'})`.execute(tx);
        return Number(result.numAffectedRows ?? 0) > 0;
      }),

    resolve: (value) =>
      inOrg(db, org(), async (tx) => {
        const row = (
          await sql<Row & { email: string; pname: string; role: Role | 'service' }>`
            SELECT t.id::text AS id, t.person_id::text AS person_id, t.name, t.env, t.scopes, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
                   p.email, p.name AS pname, p.role
              FROM auth.api_token t JOIN studio.person p ON p.id = t.person_id
             WHERE t.token_sha256 = ${sha(value)} AND t.revoked_at IS NULL AND t.expires_at > ${now().toISOString()}::timestamptz`.execute(tx)
        ).rows[0];
        if (row === undefined) return undefined;
        return { token: tokenOf(row), person: { id: row.person_id, email: row.email, name: row.pname, role: row.role } };
      }),

    async touch(id) {
      const at = now().getTime();
      if ((touched.get(id) ?? 0) > at - 60_000) return;
      touched.set(id, at);
      await inOrg(db, org(), async (tx) => void (await sql`UPDATE auth.api_token SET last_used_at = ${new Date(at).toISOString()}::timestamptz WHERE id = ${id}::uuid`.execute(tx)));
    },
  };
}

/** The scope a request needs (§4.5), or `undefined` for a route no token may use. */
export function scopeFor(method: string, path: string): string | undefined {
  const m = method.toUpperCase();
  const p = path.split('?')[0] ?? '';
  // never through a token: tokens themselves, invitations, take-overs, first-run setup
  if (p.startsWith('/api/account') || p.startsWith('/api/invitations') || p === '/api/locks/takeover' || p.startsWith('/api/setup') || p.startsWith('/api/auth')) return undefined;
  if (m === 'GET' || m === 'HEAD') return 'read';
  if (p.startsWith('/api/docs/')) return 'imports';
  return 'catalog:write';
}

/** Per-token and per-address request budgets (§4.5), in this process; `clock` injectable for tests. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly blocked = new Map<string, number>();
  private readonly clock: () => number;
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Count a hit; the seconds to wait when over a limit, else 0. */
  take(key: string, limits: readonly { count: number; ms: number }[]): number {
    const now = this.clock();
    const longest = Math.max(...limits.map((l) => l.ms));
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - longest);
    for (const limit of limits) {
      const inWindow = list.filter((t) => t > now - limit.ms);
      if (inWindow.length >= limit.count) {
        this.hits.set(key, list);
        return Math.max(1, Math.ceil(((inWindow[0] as number) + limit.ms - now) / 1000));
      }
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  /** Failed token attempts per address: 10 a minute, then 15 minutes of refusals. */
  failure(address: string): void {
    if (this.take(`fail:${address}`, [{ count: 10, ms: 60_000 }]) > 0) this.blocked.set(address, this.clock() + 15 * 60_000);
  }

  blockedFor(address: string): number {
    const until = this.blocked.get(address) ?? 0;
    const now = this.clock();
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }
}

export const READ_LIMITS = [{ count: 600, ms: 60_000 }] as const;
export const WRITE_LIMITS = [
  { count: 60, ms: 60_000 },
  { count: 1000, ms: 86_400_000 },
] as const;
