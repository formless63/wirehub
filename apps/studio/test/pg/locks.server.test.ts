/** The LockStore contract on Postgres (task B6): one lease table for every studio process. */

import { afterAll } from 'vitest';

import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { ensureOrg } from '../../server/pg/import.ts';
import { pgLockStore } from '../../server/pg/locks.ts';
import { describeLockContract } from '../storage-contract/locks.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

let database: TestDatabase | undefined;
let pgh: PgHandle | undefined;
let n = 0;
afterAll(async () => {
  await pgh?.close();
  await database?.drop();
}, 60_000);

describeLockContract(
  'pg',
  async (newToken) => {
    database ??= await freshDatabase();
    pgh ??= openPg(database.appUrl, { max: 2 });
    // a fresh org per case: an empty lease table
    const orgId = await ensureOrg(pgh.db, `locks-${++n}`, 'locks', true);
    return pgLockStore(pgh.db, orgId, { newToken });
  },
  describePg,
);
