/**
 * Personal API tokens (task B12, SA1): a script writes through the same API
 * with a token of the person who runs it — same statuses, same If-Match, the
 * change set the person's with the token's id; and every refusal of §4.5:
 * the other environment, expired, revoked, a viewer's token writing, a
 * missing scope, a token on a session-only route, rate limits, and no token
 * string in any log line or error body.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople, type Person } from '../../server/auth/people.ts';
import { createStudioAuth } from '../../server/auth/studio-auth.ts';
import { pgTokens, RateLimiter, type TokenStore } from '../../server/auth/tokens.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const BASE = 'http://studio.test';

describePg('personal API tokens', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let orgId: string;
  let tokens: TokenStore;
  let clock = Date.parse('2026-10-05T10:00:00Z');
  let editor: Person;
  let viewer: Person;
  let closeAuth: (() => Promise<void>) | undefined;
  let request: (path: string, init?: RequestInit) => Promise<Response>;
  const logged: string[] = [];

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-tokens-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    const people = pgPeople(pgh.db, orgId);
    editor = await people.ensurePerson('ed@example.test', 'Ed Editor', 'editor');
    viewer = await people.ensurePerson('vi@example.test', 'Vi Viewer', 'viewer');
    tokens = pgTokens(pgh.db, orgId, { now: () => new Date(clock) });
    const config = readAuthConfig({
      AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789',
      BETTER_AUTH_URL: BASE,
      WIREHUB_BACKEND: 'pg',
    }) as AuthConfigEnabled;
    const auth = await createStudioAuth(config, { pg: { url: database.appUrl, people, tokens, tokenEnv: 'dev', limiter: new RateLimiter(() => clock) } });
    closeAuth = auth.close;
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId), db: pgh.db, blobs: fsBlobStore(join(work, 'blobs')) });
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps, auth });
    request = async (path, init = {}) => app.request(`${BASE}${path}`, init);
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await closeAuth?.();
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const as = (secret: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${secret}` } });
  const put = (secret: string, path: string, body: unknown, ifMatch: string) =>
    request(path, as(secret, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': ifMatch }, body: JSON.stringify(body) }));

  it('writes as its person, through the same API and the same If-Match rules', async () => {
    const { token, secret } = await tokens.create({ person: editor, name: 'laptop scripts', scopes: ['catalog:write'], days: 7, env: 'dev' });
    expect(secret).toMatch(/^cst_dev_[0-9a-f]{12}_[a-z2-7]{52}$/);
    const read = await request('/api/designs/de9-crossover', as(secret));
    expect(read.status).toBe(200);
    const etag = read.headers.get('etag') ?? '';
    const design = (await read.json()) as Record<string, unknown>;
    expect((await put(secret, '/api/designs/de9-crossover', { ...design, label: 'Edited by a script' }, etag)).status).toBe(200);
    expect((await put(secret, '/api/designs/de9-crossover', { ...design, label: 'stale' }, etag)).status).toBe(409);
    const set = await inOrg(pgh.db, orgId, async (tx) =>
      (await sql<{ actor_label: string; actor_id: string; api_token_id: string }>`SELECT actor_label, actor_id::text AS actor_id, api_token_id::text AS api_token_id FROM studio.change_set ORDER BY id DESC LIMIT 1`.execute(tx)).rows[0],
    );
    expect(set).toEqual({ actor_label: 'Ed Editor', actor_id: editor.id, api_token_id: token.id });
  });

  it('refuses: another environment, garbage, revoked, expired', async () => {
    const { token, secret } = await tokens.create({ person: editor, name: 'short', scopes: [], days: 1, env: 'dev' });
    const prod = secret.replace('cst_dev_', 'cst_prod_');
    const altered = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
    for (const bad of [prod, 'cst_dev_nonsense', altered]) {
      const res = await request('/api/designs', as(bad));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(JSON.stringify(await res.json())).not.toContain('cst_');
    }
    expect((await request('/api/designs', as(secret))).status).toBe(200);
    clock += 2 * 86_400_000;
    expect((await request('/api/designs', as(secret))).status).toBe(401);
    clock -= 2 * 86_400_000;
    await tokens.revoke(token.id, editor);
    expect((await request('/api/designs', as(secret))).status).toBe(401);
  });

  it('narrows, never widens: scope, role, and session-only routes', async () => {
    const reader = await tokens.create({ person: editor, name: 'read only', scopes: [], days: 1, env: 'dev' });
    const write = await request('/api/vocab/families', as(reader.secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'X', src: 'y' }) }));
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: string }).error).toBe('The token lacks scope catalog:write.');
    const viewers = await tokens.create({ person: viewer, name: 'viewer', scopes: ['catalog:write'], days: 1, env: 'dev' });
    expect((await request('/api/vocab/families', as(viewers.secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'X', src: 'y' }) }))).status).toBe(403);
    const writer = await tokens.create({ person: editor, name: 'writer', scopes: ['catalog:write'], days: 1, env: 'dev' });
    expect((await request('/api/account/tokens', as(writer.secret))).status).toBe(403);
    expect((await request('/api/invitations', as(writer.secret))).status).toBe(403);
    expect((await request('/api/locks/takeover', as(writer.secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403);
  });

  it('rate-limits writes per token and failed attempts per address', async () => {
    const { secret } = await tokens.create({ person: editor, name: 'busy', scopes: ['catalog:write'], days: 1, env: 'dev' });
    let last = 0;
    for (let i = 0; i < 61; i += 1) {
      const res = await request('/api/vocab/families', as(secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: `Busy ${i}`, src: 'rate test' }) }));
      last = res.status;
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
        break;
      }
    }
    expect(last).toBe(429);
    clock += 61_000;
    for (let i = 0; i < 11; i += 1) await request('/api/designs', as('cst_dev_000000000000_aaaa'));
    expect((await request('/api/designs', as(secret))).status).toBe(429);
    clock += 16 * 60_000;
    expect((await request('/api/designs', as(secret))).status).toBe(200);
  });

  it('never logs a token', async () => {
    const created = await tokens.create({ person: editor, name: 'secret check', scopes: [], days: 1, env: 'dev' });
    await request('/api/designs', as(created.secret));
    expect(logged.filter((line) => /cst_(dev|prod)_[0-9a-f]{12}_[a-z2-7]/.test(line))).toEqual([]);
  });
});
