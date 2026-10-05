/**
 * The database backend's store of secrets entered in Settings
 * (`studio.settings_secret`, migration 0019; `server/settings-secrets.ts`):
 * ciphertext only, one row per secret, under the org's row-level security. Not
 * a catalog table: no change set, export or git mirror reads it.
 */

import { sql } from 'kysely';

import type { SecretStore } from '../settings-secrets.ts';
import { inOrg, type Db } from './db.ts';

export function pgSecretStore(db: Db, orgId: string): SecretStore {
  return {
    async all() {
      const rows = await inOrg(db, orgId, async (tx) => (await sql<{ name: string; ciphertext: string }>`SELECT name, ciphertext FROM studio.settings_secret ORDER BY name`.execute(tx)).rows);
      return Object.fromEntries(rows.map((r) => [r.name, r.ciphertext]));
    },
    async put(name, ciphertext) {
      await inOrg(db, orgId, async (tx) => {
        await sql`INSERT INTO studio.settings_secret (org_id, name, ciphertext) VALUES (${orgId}::uuid, ${name}, ${ciphertext})
                  ON CONFLICT (org_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`.execute(tx);
      });
    },
    async swap(name, expected, next) {
      return inOrg(db, orgId, async (tx) => {
        const done = await sql`UPDATE studio.settings_secret SET ciphertext = ${next}, updated_at = now() WHERE name = ${name} AND ciphertext = ${expected}`.execute(tx);
        return Number(done.numAffectedRows ?? 0) > 0;
      });
    },
    async remove(name) {
      await inOrg(db, orgId, async (tx) => {
        await sql`DELETE FROM studio.settings_secret WHERE name = ${name}`.execute(tx);
      });
    },
  };
}
