/**
 * `studio-api` against a pg studio with a real personal token: pull, push as one
 * change set attributed to the token's person, push with leases (the holder is the
 * API client, and a lease held by someone else refuses the push), a viewer's token
 * refused, and a stale record refused.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople } from '../../server/auth/people.ts';
import { createStudioAuth } from '../../server/auth/studio-auth.ts';
import { pgTokens } from '../../server/auth/tokens.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import type { DepictionStore } from '../../server/depictions.ts';
import { deliveredEventHub } from '../../server/events.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgLockStore } from '../../server/pg/locks.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { ApiClient, pull, push, type FetchLike } from '../../scripts/studio-api-lib.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const BASE = 'http://studio.test';

describePg('studio-api against pg with a personal token', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let closeAuth: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-studio-api-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
  }, 60_000);
  afterAll(async () => {
    await closeAuth?.();
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('pulls, pushes one change set as the person, leases, and refuses what it should', async () => {
    const orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')) })).orgId;
    const people = pgPeople(pgh.db, orgId);
    const ed = await people.ensurePerson('ed@example.test', 'Ed Editor', 'editor');
    const viewer = await people.ensurePerson('vi@example.test', 'Vi Viewer', 'viewer');
    const ed2 = await people.ensurePerson('ed2@example.test', 'Second Editor', 'editor');
    const tokens = pgTokens(pgh.db, orgId);
    const ed2Token = await tokens.create({ person: ed2, name: 'other script', scopes: ['catalog:write'], days: 1, env: 'dev' });
    const edToken = await tokens.create({ person: ed, name: 'script', scopes: ['catalog:write'], days: 1, env: 'dev' });
    const viewerToken = await tokens.create({ person: viewer, name: 'viewer script', scopes: ['catalog:write'], days: 1, env: 'dev' });
    const config = readAuthConfig({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789', BETTER_AUTH_URL: BASE, WIREHUB_BACKEND: 'pg' }) as AuthConfigEnabled;
    const auth = await createStudioAuth(config, { pg: { url: database.appUrl, people, tokens, tokenEnv: 'dev' } });
    closeAuth = auth.close;
    const cache = new SnapshotCache(pgh.db, orgId);
    const events = deliveredEventHub();
    const base = pgWorkbenchDeps({ cache, db: pgh.db, events, blobs: fsBlobStore(join(work, 'blobs')) });
    const deps = { ...base, locks: pgLockStore(pgh.db, orgId) };
    const depictionDeps = { store: deps.depictions as DepictionStore, loadDb: deps.loadDb, loadDesigns: async () => (await cache.get()).catalog.loadDesigns() };
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps, depictionDeps, auth });
    const fetchVia: FetchLike = async (url, init) => {
      const res = await app.request(url, { method: init.method, headers: { ...init.headers, origin: BASE }, ...(init.body === undefined ? {} : { body: init.body }) });
      return { status: res.status, headers: res.headers, text: () => res.text() };
    };
    const as = (secret: string): ApiClient => new ApiClient({ url: BASE, token: secret }, fetchVia, async () => undefined);
    const edit = (dir: string, path: string, change: (v: any) => void): void => {
      const v = JSON.parse(readFileSync(join(dir, path), 'utf8'));
      change(v);
      writeFileSync(join(dir, path), `${JSON.stringify(v, null, 2)}\n`);
    };

    const dir = mkdtempSync(join(work, 'pull-'));
    const pulled = await pull(as(edToken.secret), dir);
    expect(pulled.files).toBeGreaterThan(10);
    edit(dir, 'data/wires.json', (list) => (list[0].label = 'Relabelled by script'));
    edit(dir, 'data/connectors.json', (list) => (list[0].label = 'Relabelled connector'));

    // a viewer's token cannot write, so its dry run is refused too
    const viewerDir = mkdtempSync(join(work, 'viewer-'));
    await pull(as(edToken.secret), viewerDir);
    edit(viewerDir, 'data/wires.json', (list) => (list[0].label = 'viewer edit'));
    const refused = await push(as(viewerToken.secret), viewerDir, { dryRun: false, message: 'nope' });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(403);

    // another person holds a lease on a record this push changes
    const lease = await app.request(`${BASE}/api/locks/acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, authorization: `Bearer ${ed2Token.secret}` },
      body: JSON.stringify({ record: `definition:wires:${JSON.parse(readFileSync(join(dir, 'data/wires.json'), 'utf8'))[0].id}`, holder: { name: 'Someone', clientId: 'someone-client', tabId: 'someone-tab' } }),
    });
    expect(lease.status).toBe(200);
    await expect(push(as(edToken.secret), dir, { dryRun: false, message: 'locked out', lock: true })).rejects.toThrow(/is held by/);
    // without --lock the write itself is refused (423) and nothing is written
    const blocked = await push(as(edToken.secret), dir, { dryRun: false, message: 'blocked' });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(423);
    const { token: leaseToken } = (await lease.json()) as { token: string };
    await app.request(`${BASE}/api/locks/release`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, authorization: `Bearer ${ed2Token.secret}` }, body: JSON.stringify({ record: `definition:wires:${JSON.parse(readFileSync(join(dir, 'data/wires.json'), 'utf8'))[0].id}`, token: leaseToken }) });

    const before = await inOrg(pgh.db, orgId, async (tx) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.change_set`.execute(tx)).rows[0]!.n));
    const result = await push(as(edToken.secret), dir, { dryRun: false, message: 'Relabel two records', lock: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const sets = await inOrg(pgh.db, orgId, async (tx) =>
      (await sql<{ actor_id: string; api_token_id: string; source: string; message: string }>`SELECT actor_id::text AS actor_id, api_token_id::text AS api_token_id, source, message FROM studio.change_set ORDER BY id DESC LIMIT 5`.execute(tx)).rows,
    );
    const mine = sets.filter((s) => s.message === 'Relabel two records');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actor_id: ed.id, api_token_id: edToken.token.id, source: 'studio' });
    expect(await inOrg(pgh.db, orgId, async (tx) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.change_set`.execute(tx)).rows[0]!.n))).toBe(before + 1);
    // the leases are released: a second push from a fresh pull works
    const again = mkdtempSync(join(work, 'again-'));
    await pull(as(edToken.secret), again);
    expect(JSON.parse(readFileSync(join(again, 'data/wires.json'), 'utf8'))[0].label).toBe('Relabelled by script');
    edit(again, 'data/wires.json', (list) => (list[0].label = 'Second relabel'));
    expect((await push(as(edToken.secret), again, { dryRun: false, message: 'Second', lock: true })).ok).toBe(true);
    // the first directory is now stale: its If-Match fails and nothing is written
    edit(dir, 'data/wires.json', (list) => (list[0].label = 'Stale edit'));
    const stale = await push(as(edToken.secret), dir, { dryRun: false, message: 'Stale' });
    expect(stale.ok).toBe(false);
    expect(stale.failed?.status).toBe(409);
  }, 120_000);
});
