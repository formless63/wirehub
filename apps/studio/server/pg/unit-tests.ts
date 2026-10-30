/**
 * Unit test results on Postgres (migration 0034, `server/units/store.ts`): insert and read only,
 * under the org's row-level security. A write NOTIFYs `studio_inventory` at commit, so open
 * inventory pages refetch like they do for any other inventory change.
 */

import { sql } from 'kysely';

import type { UnitCoverage, UnitTest, UnitTestKind, UnitTestResult } from '../../src/units.ts';
import type { UnitTestStore } from '../units/store.ts';
import { inOrg, type Db } from './db.ts';

interface Row {
  id: string; unit_id: string; design_id: string; kind: UnitTestKind; result: UnitTestResult; note: string | null; coverage: UnitCoverage | null; at: Date; actor: string;
}

const testOf = (r: Row): UnitTest => ({
  id: r.id,
  unit: r.unit_id,
  design: r.design_id,
  kind: r.kind,
  result: r.result,
  ...(r.note === null ? {} : { note: r.note }),
  ...(r.coverage === null ? {} : { coverage: r.coverage }),
  at: r.at.toISOString(),
  by: r.actor,
});

export function pgUnitTestStore(db: Db, orgId: string): UnitTestStore {
  return {
    list: (f) => inOrg(db, orgId, async (tx) => {
      const parts = [sql`true`];
      if (f.unit !== undefined) parts.push(sql`unit_id = ${f.unit}`);
      if (f.design !== undefined) parts.push(sql`design_id = ${f.design}`);
      return (await sql<Row>`SELECT * FROM studio.inv_unit_test WHERE ${sql.join(parts, sql` AND `)} ORDER BY at DESC, id DESC`.execute(tx)).rows.map(testOf);
    }, { snapshot: true }),
    add: (t) => inOrg(db, orgId, async (tx) => {
      await sql`INSERT INTO studio.inv_unit_test (org_id, id, unit_id, design_id, kind, result, note, coverage, at, actor)
        VALUES (${orgId}::uuid, ${t.id}, ${t.unit}, ${t.design}, ${t.kind}, ${t.result}, ${t.note ?? null}, ${t.coverage === undefined ? null : JSON.stringify(t.coverage)}::jsonb, ${t.at}::timestamptz, ${t.by})`.execute(tx);
      await sql`SELECT pg_notify('studio_inventory', ${JSON.stringify({ org: orgId })})`.execute(tx);
    }),
  };
}
