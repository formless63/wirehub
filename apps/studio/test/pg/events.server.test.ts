/**
 * Two studio processes on one database (task B6): a commit and a lease change
 * in one reach the other's event stream (LISTEN), its snapshot, and its lock
 * table — and concurrent writers serialise on the head row.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiResponse } from '../../server/api.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import type { StudioEvent } from '../../server/events.ts';
import { editLockLayer } from '../../server/locks/lock-api.ts';
import { openPg } from '../../server/pg/db.ts';
import { openPgBackend, type PgBackend } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('two processes, one database', () => {
  let database: TestDatabase;
  let a: PgBackend;
  let b: PgBackend;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    const setup = openPg(database.appUrl, { max: 1 });
    await importCatalog(setup.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    await setup.close();
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-events-'));
    const blobs = fsBlobStore(join(work, 'blobs'));
    a = await openPgBackend({ DATABASE_URL: database.appUrl }, { blobs });
    b = await openPgBackend({ DATABASE_URL: database.appUrl }, { blobs });
  }, 60_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const until = async (check: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('a commit in one process reaches the other: its events, then its reads', async () => {
    const seen: StudioEvent[] = [];
    const off = b.deps.events!.subscribe((e) => seen.push(e));
    const read = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/de9-crossover' }, a.deps);
    const put = await handleWorkbenchRequest({ method: 'PUT', path: '/api/designs/de9-crossover', body: { ...(read.body as object), label: 'Saved by process A' }, headers: { 'if-match': read.headers?.ETag ?? '' } }, a.deps);
    expect(put.status).toBe(200);
    await until(() => seen.some((e) => e.type === 'catalog'));
    const there = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/de9-crossover' }, b.deps);
    expect((there.body as { label: string }).label).toBe('Saved by process A');
    off();
  });

  it('a lease taken in one process is held in the other, and announced', async () => {
    const seen: StudioEvent[] = [];
    const off = b.deps.events!.subscribe((e) => seen.push(e));
    const holder = { name: 'Alex', clientId: 'client-aaaaaaaa', tabId: 'tab-aaaaaaaa' };
    const taken = (await editLockLayer({ method: 'POST', path: '/api/locks/acquire', body: { record: 'design:de9-terminal-board', holder } }, { locks: a.deps.locks!, events: a.deps.events! })) as ApiResponse;
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    const other = (await editLockLayer({ method: 'POST', path: '/api/locks/acquire', body: { record: 'design:de9-terminal-board', holder: { name: 'Sam', clientId: 'client-bbbbbbbb', tabId: 'tab-bbbbbbbb' } } }, { locks: b.deps.locks! })) as ApiResponse;
    expect(other.status).toBeGreaterThanOrEqual(400);
    await until(() => seen.some((e) => e.type === 'locks' && e.record === 'design:de9-terminal-board'));
    off();
  });

  it('concurrent saves from both processes serialise: different records both land, the same record once', async () => {
    const read = async (deps: PgBackend['deps'], id: string) => handleWorkbenchRequest({ method: 'GET', path: `/api/designs/${id}` }, deps);
    const put = (deps: PgBackend['deps'], id: string, r: ApiResponse, label: string) =>
      handleWorkbenchRequest({ method: 'PUT', path: `/api/designs/${id}`, body: { ...(r.body as object), label }, headers: { 'if-match': r.headers?.ETag ?? '' } }, deps);
    const [x, y] = [await read(a.deps, 'dc-y-splitter'), await read(b.deps, 'dc-led-lead')];
    const before = BigInt(await a.cache.version());
    const both = await Promise.all([put(a.deps, 'dc-y-splitter', x, 'A was here'), put(b.deps, 'dc-led-lead', y, 'B was here')]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    a.cache.invalidate();
    expect(BigInt(await a.cache.version())).toBe(before + 2n);
    const [p, q] = [await read(a.deps, 'dc-y-splitter'), await read(b.deps, 'dc-y-splitter')];
    const race = await Promise.all([put(a.deps, 'dc-y-splitter', p, 'first'), put(b.deps, 'dc-y-splitter', q, 'second')]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});
