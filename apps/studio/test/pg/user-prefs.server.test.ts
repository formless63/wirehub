/** Per-person UI preferences on Postgres (migration 0024): merged under a row lock, kept apart per person and per org. */

import { afterAll, beforeAll, expect, it } from 'vitest';

import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { ensureOrg } from '../../server/pg/import.ts';
import { pgPrefsStore } from '../../server/pg/user-prefs.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

let database: TestDatabase | undefined;
let pgh: PgHandle | undefined;
beforeAll(async () => {
  database = await freshDatabase();
  pgh = openPg(database.appUrl, { max: 2 });
}, 60_000);
afterAll(async () => {
  await pgh?.close();
  await database?.drop();
}, 60_000);

describePg('pgPrefsStore', () => {
  it('merges patches, clears with null, keeps people and orgs apart', async () => {
    const a = pgPrefsStore(pgh!.db, await ensureOrg(pgh!.db, 'prefs-a', 'a', true));
    const b = pgPrefsStore(pgh!.db, await ensureOrg(pgh!.db, 'prefs-b', 'b', true));
    expect(await a.get('email:ada@example.com')).toEqual({});
    expect(await a.merge('email:ada@example.com', { theme: 'dark', 'slot-pins': ['x/y'] })).toEqual({ theme: 'dark', 'slot-pins': ['x/y'] });
    expect(await a.merge('email:ada@example.com', { theme: null, 'cols.designs': ['updated'] })).toEqual({ 'slot-pins': ['x/y'], 'cols.designs': ['updated'] });
    expect(await a.get('email:ada@example.com')).toEqual({ 'slot-pins': ['x/y'], 'cols.designs': ['updated'] });
    expect(await a.get('email:bob@example.com')).toEqual({});
    expect(await b.get('email:ada@example.com')).toEqual({});
  });

  it('serialises concurrent merges of different keys', async () => {
    const s = pgPrefsStore(pgh!.db, await ensureOrg(pgh!.db, 'prefs-c', 'c', true));
    await Promise.all(Array.from({ length: 6 }, (_, i) => s.merge('local:me', { [`k${i}`]: i })));
    expect(Object.keys(await s.get('local:me')).sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  });
});
