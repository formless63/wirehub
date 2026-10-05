/**
 * People and invitations on the database backend (`specs/postgres-backend.md`
 * §3.15, §9.2; task B8). A `studio.person` is who a change is attributed to
 * and what role they hold; an `auth.invitation` lets an owner bring someone in
 * by email with a role. The invitation link carries a one-time token; only
 * its sha256 is stored.
 */

import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'kysely';

import { inOrg, orgOf, type Db, type OrgRef } from '../pg/db.ts';

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];

export interface Person {
  id: string;
  email: string;
  name: string;
  role: Role | 'service';
  /** `auth."user".id`, once linked */
  authUserId?: string | null;
  /** set when an owner revoked this person's access */
  disabledAt?: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface PeopleStore {
  personByEmail(email: string): Promise<Person | undefined>;
  /** the person for an account: matched by email, made when new (the org's first person is its owner) */
  ensurePerson(email: string, name: string, role?: Role): Promise<Person>;
  /** point the person at their sign-in account (after the account is committed) */
  linkAuthUser(email: string, authUserId: string): Promise<void>;
  createInvitation(input: { email: string; role: Role; invitedBy: string; days?: number }): Promise<{ invitation: Invitation; token: string }>;
  /** an open, unexpired invitation for this token */
  invitationByToken(token: string): Promise<Invitation | undefined>;
  markAccepted(id: string): Promise<void>;
  listInvitations(): Promise<Invitation[]>;
  /** everyone in the org, owners first */
  listPeople(): Promise<Person[]>;
  /** change a person's role; refuses to leave the org without an owner who can sign in */
  setRole(id: string, role: Role): Promise<'ok' | 'not-found' | 'last-owner'>;
  /** revoke (or give back) a person's access: sessions ended, tokens revoked; their changes stay theirs */
  setDisabled(id: string, disabled: boolean): Promise<'ok' | 'not-found' | 'last-owner'>;
  revokeInvitation(id: string): Promise<boolean>;
  /** whether anyone who still has access has an email + password login (the sign-in page says so when nobody can sign in) */
  hasPasswordLogin(): Promise<boolean>;
}

const sha = (token: string): string => createHash('sha256').update(token).digest('hex');
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}
const invitationOf = (r: InvitationRow): Invitation => ({
  id: r.id,
  email: r.email,
  role: r.role,
  expiresAt: iso(r.expires_at),
  acceptedAt: r.accepted_at === null ? null : iso(r.accepted_at),
  createdAt: iso(r.created_at),
});

export function pgPeople(db: Db, orgRef: OrgRef, options: { now?: () => Date } = {}): PeopleStore {
  // the org may not exist yet (first-run setup creates it): resolved per call
  const org = (): string => orgOf(orgRef);
  const now = options.now ?? (() => new Date());
  return {
    personByEmail: (email) =>
      // no org yet (first-run setup): nobody is a person of it
      typeof orgRef !== 'string' && orgRef() === undefined
        ? Promise.resolve(undefined)
        : inOrg(db, org(), async (tx) => (await sql<Person>`SELECT id::text AS id, email, name, role, auth_user_id AS "authUserId", disabled_at AS "disabledAt" FROM studio.person WHERE email = ${email.toLowerCase()}`.execute(tx)).rows[0]),

    linkAuthUser: (email, authUserId) =>
      inOrg(db, org(), async (tx) => {
        await sql`UPDATE studio.person SET auth_user_id = ${authUserId} WHERE email = ${email.toLowerCase()} AND auth_user_id IS DISTINCT FROM ${authUserId}`.execute(tx);
      }),

    ensurePerson: (email, name, role) =>
      inOrg(db, org(), async (tx) => {
        const lower = email.toLowerCase();
        const existing = (await sql<Person>`SELECT id::text AS id, email, name, role FROM studio.person WHERE email = ${lower}`.execute(tx)).rows[0];
        if (existing !== undefined) return existing;
        // the org's first person owns it (until first-run setup names the owner, plan §9.2)
        const first = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.person WHERE role <> 'service'`.execute(tx)).rows[0]?.n === '0';
        return (
          await sql<Person>`
            INSERT INTO studio.person (org_id, email, name, role)
            VALUES (${org()}::uuid, ${lower}, ${name || lower}, ${role ?? (first ? 'owner' : 'editor')})
            RETURNING id::text AS id, email, name, role`.execute(tx)
        ).rows[0] as Person;
      }),

    async createInvitation({ email, role, invitedBy, days }) {
      const token = randomBytes(32).toString('base64url');
      const expires = new Date(now().getTime() + (days ?? 7) * 86_400_000);
      const row = await inOrg(db, org(), async (tx) => (
        await sql<InvitationRow>`
          INSERT INTO auth.invitation (org_id, email, role, token_sha256, invited_by, expires_at)
          VALUES (${org()}::uuid, ${email.toLowerCase()}, ${role}, ${sha(token)}, ${invitedBy}::uuid, ${expires.toISOString()}::timestamptz)
          RETURNING id::text AS id, email, role, expires_at, accepted_at, created_at`.execute(tx)
      ).rows[0] as InvitationRow);
      return { invitation: invitationOf(row), token };
    },

    async invitationByToken(token) {
      const row = await inOrg(db, org(), async (tx) => (
        await sql<InvitationRow>`
          SELECT id::text AS id, email, role, expires_at, accepted_at, created_at FROM auth.invitation
           WHERE org_id = ${org()}::uuid AND token_sha256 = ${sha(token)} AND accepted_at IS NULL AND expires_at > ${now().toISOString()}::timestamptz`.execute(tx)
      ).rows[0]);
      return row === undefined ? undefined : invitationOf(row);
    },

    async markAccepted(id) {
      await inOrg(db, org(), async (tx) => void (await sql`UPDATE auth.invitation SET accepted_at = now() WHERE id = ${id}::uuid AND org_id = ${org()}::uuid`.execute(tx)));
    },

    async listInvitations() {
      return inOrg(db, org(), async (tx) => (
        await sql<InvitationRow>`
          SELECT id::text AS id, email, role, expires_at, accepted_at, created_at FROM auth.invitation
           WHERE org_id = ${org()}::uuid ORDER BY created_at DESC`.execute(tx)
      ).rows.map(invitationOf));
    },

    listPeople: () =>
      inOrg(db, org(), async (tx) =>
        (
          await sql<Person>`
            SELECT id::text AS id, email, name, role, auth_user_id AS "authUserId", disabled_at AS "disabledAt" FROM studio.person
             WHERE role <> 'service' ORDER BY (role = 'owner') DESC, lower(name), email`.execute(tx)
        ).rows,
      ),

    setRole: (id, role) =>
      inOrg(db, org(), async (tx) => {
        const target = (await sql<{ role: string }>`SELECT role FROM studio.person WHERE id = ${id}::uuid FOR UPDATE`.execute(tx)).rows[0];
        if (target === undefined) return 'not-found';
        if (target.role === 'owner' && role !== 'owner' && (await liveOwners(tx)) <= 1) return 'last-owner';
        await sql`UPDATE studio.person SET role = ${role} WHERE id = ${id}::uuid`.execute(tx);
        return 'ok';
      }),

    setDisabled: (id, disabled) =>
      inOrg(db, org(), async (tx) => {
        const target = (await sql<{ role: string; auth_user_id: string | null; disabled_at: Date | null }>`SELECT role, auth_user_id, disabled_at FROM studio.person WHERE id = ${id}::uuid FOR UPDATE`.execute(tx)).rows[0];
        if (target === undefined) return 'not-found';
        if (disabled && target.role === 'owner' && target.disabled_at === null && (await liveOwners(tx)) <= 1) return 'last-owner';
        await sql`UPDATE studio.person SET disabled_at = ${disabled ? sql`now()` : null} WHERE id = ${id}::uuid`.execute(tx);
        if (disabled) {
          // signed out everywhere, and no token of theirs works any more
          if (target.auth_user_id !== null) await sql`DELETE FROM auth.session WHERE "userId" = ${target.auth_user_id}`.execute(tx);
          await sql`UPDATE auth.api_token SET revoked_at = now() WHERE person_id = ${id}::uuid AND revoked_at IS NULL`.execute(tx);
        }
        return 'ok';
      }),

    hasPasswordLogin: () =>
      typeof orgRef !== 'string' && orgRef() === undefined
        ? Promise.resolve(false)
        : inOrg(db, org(), async (tx) =>
            Number(
              (
                await sql<{ n: string }>`
                  SELECT count(*)::text AS n FROM studio.person p JOIN auth.account a ON a."userId" = p.auth_user_id
                   WHERE p.disabled_at IS NULL AND p.role <> 'service' AND a.password IS NOT NULL`.execute(tx)
              ).rows[0]?.n ?? 0,
            ) > 0,
          ),

    async revokeInvitation(id) {
      const result = await inOrg(db, org(), (tx) => sql`DELETE FROM auth.invitation WHERE id = ${id}::uuid AND org_id = ${org()}::uuid AND accepted_at IS NULL`.execute(tx));
      return Number(result.numAffectedRows ?? 0) > 0;
    },
  };
}

async function liveOwners(tx: Parameters<Parameters<typeof inOrg>[2]>[0]): Promise<number> {
  return Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.person WHERE role = 'owner' AND disabled_at IS NULL`.execute(tx)).rows[0]?.n ?? 0);
}
