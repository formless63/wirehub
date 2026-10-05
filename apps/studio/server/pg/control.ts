/**
 * Process control over the database (`specs/runtime-modules.md` §4): the studio
 * tells the worker to restart through `NOTIFY studio_control`, which the
 * worker's `LISTEN` connection delivers as a `control` event (`snapshot.ts`).
 * No other interface is involved.
 */

import { sql } from 'kysely';

import type { Db } from './db.ts';

export type ControlAction = 'restart';

/** `NOTIFY studio_control` for the worker of `orgId` (nothing when there is no organisation yet). */
export async function notifyControl(db: Db, orgId: string | undefined, action: ControlAction): Promise<void> {
  if (orgId === undefined) return;
  await sql`SELECT pg_notify('studio_control', ${JSON.stringify({ org: orgId, action, target: 'worker' })})`.execute(db);
}
