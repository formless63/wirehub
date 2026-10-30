/**
 * Where the database names an asset (`asset-remove.ts`): every text and JSON column of the
 * `studio` schema searched for the sha256, so a table added later is covered without a list.
 * `studio.change` rows are history; every other table is current. Left out: the asset's own
 * rows and bookkeeping (`asset`, `blob`, derived caches, the audit backstop, locks, sessions).
 */

import { sql } from 'kysely';

import type { AssetReferenceFinder, AssetReferences } from '../asset-remove.ts';
import { inOrg, type Db } from './db.ts';

/** tables whose mention of a sha is not a record naming the asset */
const NOT_REFERENCES = new Set(['asset', 'blob', 'derived_blob', 'derived_doc', 'audit_log', 'edit_lock', 'edit_lock_displaced', 'worker_heartbeat', 'settings_secret', 'parity_run']);
/** rows of a table that are the asset's own bookkeeping */
const BOOKKEEPING: Record<string, ReturnType<typeof sql>> = {
  catalog_doc: sql`path NOT LIKE 'data/assets/%'`,
  change: sql`kind NOT IN ('asset', 'blob') AND key NOT LIKE 'data/assets/%'`,
};
const HISTORY = new Set(['change']);

const ident = (name: string): ReturnType<typeof sql.raw> => sql.raw(`"${name.replace(/"/g, '""')}"`);

export function pgAssetReferences(db: Db, orgId: string): AssetReferenceFinder {
  return async (ids) => {
    const out = new Map<string, AssetReferences>(ids.map((id) => [id, { current: [], history: [] }]));
    if (ids.length === 0) return out;
    await inOrg(db, orgId, async (tx) => {
      const columns = (await sql<{ table_name: string; column_name: string }>`
        SELECT c.table_name, c.column_name FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
         WHERE c.table_schema = 'studio' AND c.data_type IN ('json', 'jsonb', 'text', 'character varying') AND c.is_generated = 'NEVER'
         ORDER BY c.table_name, c.column_name`.execute(tx)).rows;
      for (const { table_name: table, column_name: column } of columns) {
        if (NOT_REFERENCES.has(table)) continue;
        const extra = BOOKKEEPING[table];
        const hits = (await sql<{ id: string }>`
          SELECT s.id FROM unnest(${[...ids]}::text[]) AS s(id)
           WHERE EXISTS (SELECT 1 FROM studio.${ident(table)} r WHERE r.${ident(column)}::text LIKE '%' || s.id || '%' ${extra === undefined ? sql`` : sql`AND ${extra}`})`.execute(tx)).rows;
        for (const { id } of hits) out.get(id)?.[HISTORY.has(table) ? 'history' : 'current'].push(`${table}.${column}`);
      }
    });
    return out;
  };
}
