/**
 * Per-person UI preferences on Postgres (`studio.user_pref`, migration 0024;
 * `server/user-prefs.ts`): one JSON object per person under the org's row-level
 * security. Not a catalog table: no change set, export or git mirror reads it.
 */

import { sql } from 'kysely';

import { applyPatch, type Prefs, type UserPrefsStore } from '../user-prefs.ts';
import { inOrg, type Db } from './db.ts';

export function pgPrefsStore(db: Db, orgId: string): UserPrefsStore {
  return {
    async get(userKey) {
      const row = await inOrg(db, orgId, async (tx) => (await sql<{ prefs: Prefs }>`SELECT prefs FROM studio.user_pref WHERE user_key = ${userKey}`.execute(tx)).rows[0]);
      return row?.prefs ?? {};
    },
    async merge(userKey, patch) {
      return inOrg(db, orgId, async (tx) => {
        await sql`INSERT INTO studio.user_pref (org_id, user_key) VALUES (${orgId}::uuid, ${userKey}) ON CONFLICT (org_id, user_key) DO NOTHING`.execute(tx);
        const row = (await sql<{ prefs: Prefs }>`SELECT prefs FROM studio.user_pref WHERE user_key = ${userKey} FOR UPDATE`.execute(tx)).rows[0];
        const next = applyPatch(row?.prefs ?? {}, patch);
        await sql`UPDATE studio.user_pref SET prefs = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE user_key = ${userKey}`.execute(tx);
        return next;
      });
    },
  };
}
