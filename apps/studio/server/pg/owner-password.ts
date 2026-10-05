/**
 * The escape hatch for a hub nobody can sign in to (`docs/self-hosting.md`, "Upgrades"): set the
 * email + password login of an owner straight in the database, from the server's own shell —
 *
 *   docker compose exec wirehub node --experimental-strip-types --no-warnings \
 *     --import ./server/boot-env.ts server/pg/cli.ts owner-password [--email you@example.com]
 *
 * The password is read from standard input (a pipe, or a hidden prompt), never from an argument.
 * It makes the owner's sign-in account when there is none, replaces the password when there is
 * one (ending that person's sessions), and is hashed the way Better Auth hashes it, so the
 * sign-in page's email + password form takes it. Email + password accounts must be on
 * (`AUTH_LOCAL_ACCOUNTS`, or Settings > Sign-in & accounts; on by default with the database).
 */

import { randomUUID } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';
import { sql } from 'kysely';

import { inOrg, type Db } from './db.ts';

export const MIN_PASSWORD_LENGTH = 12;

export class OwnerPasswordError extends Error {}

export interface OwnerPasswordResult {
  email: string;
  name: string;
  /** an account made, or the password of one replaced */
  action: 'created' | 'replaced';
}

export async function setOwnerPassword(db: Db, orgId: string, input: { email?: string; password: string }): Promise<OwnerPasswordResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new OwnerPasswordError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const hash = await hashPassword(input.password);
  return inOrg(db, orgId, async (tx) => {
    const owners = (
      await sql<{ id: string; email: string; name: string; role: string; auth_user_id: string | null; disabled_at: Date | null }>`
        SELECT id::text AS id, email, name, role, auth_user_id, disabled_at FROM studio.person WHERE role = 'owner' ORDER BY email`.execute(tx)
    ).rows;
    const wanted = input.email?.trim().toLowerCase();
    const owner = wanted === undefined || wanted === '' ? (owners.filter((o) => o.disabled_at === null).length === 1 ? owners.find((o) => o.disabled_at === null) : undefined) : owners.find((o) => o.email === wanted);
    if (owner === undefined) {
      if (wanted === undefined || wanted === '') throw new OwnerPasswordError(owners.length === 0 ? 'This hub has no owner yet: finish first-run setup.' : `There is more than one owner (${owners.map((o) => o.email).join(', ')}): name one with --email.`);
      throw new OwnerPasswordError(`${wanted} is not an owner of this hub.${owners.length === 0 ? '' : ` The owners: ${owners.map((o) => o.email).join(', ')}.`}`);
    }
    if (owner.disabled_at !== null) throw new OwnerPasswordError(`${owner.email}'s access was revoked; give it back (Settings > People) before setting a password.`);

    let userId = owner.auth_user_id;
    if (userId === null) userId = (await sql<{ id: string }>`SELECT id FROM auth."user" WHERE email = ${owner.email}`.execute(tx)).rows[0]?.id ?? null;
    if (userId === null) {
      userId = randomUUID();
      await sql`INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES (${userId}, ${owner.name}, ${owner.email}, true)`.execute(tx);
    }
    if (owner.auth_user_id !== userId) await sql`UPDATE studio.person SET auth_user_id = ${userId} WHERE id = ${owner.id}::uuid`.execute(tx);

    const account = (await sql<{ id: string }>`SELECT id FROM auth.account WHERE "userId" = ${userId} AND "providerId" = 'credential'`.execute(tx)).rows[0];
    if (account === undefined) {
      await sql`INSERT INTO auth.account (id, "accountId", "providerId", "userId", password, "updatedAt") VALUES (${randomUUID()}, ${userId}, 'credential', ${userId}, ${hash}, now())`.execute(tx);
    } else {
      await sql`UPDATE auth.account SET password = ${hash}, "updatedAt" = now() WHERE id = ${account.id}`.execute(tx);
      await sql`DELETE FROM auth.session WHERE "userId" = ${userId}`.execute(tx);
    }
    return { email: owner.email, name: owner.name, action: account === undefined ? ('created' as const) : ('replaced' as const) };
  });
}
