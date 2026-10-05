/**
 * Better Auth on Postgres (task B8): its tables are migration 0012 (Better
 * Auth plans nothing more), local accounts, the person made on first
 * sign-in (the org's first one owns it), invitations with a role, a viewer
 * who cannot write, and a stranger who cannot sign up.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople } from '../../server/auth/people.ts';
import { createStudioAuth } from '../../server/auth/studio-auth.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const BASE = 'http://studio.test';
const OWNER = 'owner@example.test';

class Jar {
  private cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const value = pair!.slice(eq + 1).trim();
      const name = pair!.slice(0, eq).trim();
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

describePg('auth on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let orgId: string;
  let closeAuth: (() => Promise<void>) | undefined;
  let call: (path: string, init?: RequestInit, jar?: Jar) => Promise<Response>;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-auth-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')) })).orgId;
    const config = readAuthConfig({
      AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789',
      BETTER_AUTH_URL: BASE,
      WIREHUB_BACKEND: 'pg',
      AUTH_ALLOWED_EMAILS: OWNER,
    }) as AuthConfigEnabled;
    const auth = await createStudioAuth(config, { pg: { url: database.appUrl, people: pgPeople(pgh.db, orgId) } });
    closeAuth = auth.close;
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId), db: pgh.db, blobs: fsBlobStore(join(work, 'blobs')) });
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps, auth });
    call = async (path, init = {}, jar) => {
      const headers = new Headers(init.headers);
      if (jar !== undefined) headers.set('cookie', jar.header());
      if (init.method !== undefined && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', BASE);
      const host = headers.get('host');
      const res = await app.request(`${host === null ? BASE : `http://${host}`}${path}`, { ...init, headers });
      jar?.take(res);
      return res;
    };
  }, 60_000);
  afterAll(async () => {
    await closeAuth?.();
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const post = (path: string, body: unknown, jar?: Jar) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, jar);

  it('needs no schema changes beyond migration 0012', async () => {
    const pool = new pg.Pool({ connectionString: database.appUrl, options: '-c search_path=auth', max: 1 });
    try {
      const { toBeCreated, toBeAdded } = await getMigrations({ database: pool, emailAndPassword: { enabled: true } });
      expect(toBeCreated).toEqual([]);
      expect(toBeAdded).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('an allow-listed email signs up with a password and becomes the owner', async () => {
    const owner = new Jar();
    const up = await post('/api/auth/sign-up/email', { email: OWNER, password: 'correct horse battery', name: 'Olive Owner' }, owner);
    expect(up.status).toBe(200);
    expect((await call('/api/designs', {}, owner)).status).toBe(200);
    const person = await pgPeople(pgh.db, orgId).personByEmail(OWNER);
    expect(person?.role).toBe('owner');
    // a stranger cannot make an account
    expect((await post('/api/auth/sign-up/email', { email: 'stranger@example.test', password: 'correct horse battery', name: 'X' })).status).toBeGreaterThanOrEqual(400);
    // signing in again with the password works
    const again = new Jar();
    expect((await post('/api/auth/sign-in/email', { email: OWNER, password: 'correct horse battery' }, again)).status).toBe(200);
    expect((await call('/api/me', {}, again)).status).toBe(200);
  });

  it('an owner invites a viewer; the link makes the account; the viewer reads but cannot write; the link works once', async () => {
    const owner = new Jar();
    await post('/api/auth/sign-in/email', { email: OWNER, password: 'correct horse battery' }, owner);
    const invite = await post('/api/invitations', { email: 'Viv@Example.test', role: 'viewer' }, owner);
    expect(invite.status).toBe(201);
    const { link } = (await invite.json()) as { link: string };
    const token = new URL(link).searchParams.get('token') as string;
    expect((await call(`/invite?token=${encodeURIComponent(token)}`)).status).toBe(200);
    const viv = new Jar();
    const accepted = await post('/api/invitations/accept', { token, name: 'Viv Viewer', password: 'another long password' }, viv);
    expect(accepted.status).toBe(200);
    expect((await call('/api/designs/de9-crossover', {}, viv)).status).toBe(200);
    const write = await call('/api/vocab/families', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Nope', src: 'x' }) }, viv);
    expect(write.status).toBe(403);
    expect((await pgPeople(pgh.db, orgId).personByEmail('viv@example.test'))?.role).toBe('viewer');
    expect((await post('/api/invitations/accept', { token, name: 'Again', password: 'another long password' })).status).toBe(410);
    // only an owner invites
    expect((await post('/api/invitations', { email: 'x@example.test', role: 'editor' }, viv)).status).toBe(403);
    // only the token's hash is stored
    const stored = (await sql<{ token_sha256: string }>`SELECT token_sha256 FROM auth.invitation`.execute(pgh.db)).rows.map((r) => r.token_sha256);
    expect(stored.some((s) => s.includes(token))).toBe(false);
  });

  it('accepts a sign-in made to the address the hub was opened at; refuses another site', async () => {
    // browsers say where a request comes from (Sec-Fetch-Site) as well as Origin
    const at = (origin: string, host: string, site: string) =>
      call('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin, host, 'sec-fetch-site': site }, body: JSON.stringify({ email: OWNER, password: 'correct horse battery' }) });
    // the LAN address, not the configured public URL: same origin, fine
    const lan = await at('http://nas.local:5183', 'nas.local:5183', 'same-origin');
    expect(lan.status).toBe(200);
    const evil = await at('https://evil.example', 'nas.local:5183', 'cross-site');
    expect(evil.status).toBeGreaterThanOrEqual(400);
  });

  it('an owner manages people: roles, revoking access, never the last owner', async () => {
    const owner = new Jar();
    await post('/api/auth/sign-in/email', { email: OWNER, password: 'correct horse battery' }, owner);
    const viv = new Jar();
    expect((await post('/api/auth/sign-in/email', { email: 'viv@example.test', password: 'another long password' }, viv)).status).toBe(200);
    const list = (await (await call('/api/people', {}, owner)).json()) as { people: { id: string; email: string; role: string }[] };
    const vivId = list.people.find((p) => p.email === 'viv@example.test')?.id as string;
    const ownerId = list.people.find((p) => p.email === OWNER)?.id as string;
    expect((await call('/api/people', {}, viv)).status).toBe(403);
    const patch = (id: string, role: string) => call(`/api/people/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) }, owner);
    expect((await patch(vivId, 'editor')).status).toBe(200);
    expect((await patch(ownerId, 'viewer')).status).toBe(409);
    // a page posting from elsewhere cannot do it
    expect((await call(`/api/people/${vivId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ role: 'owner' }) }, owner)).status).toBe(403);
    expect((await post(`/api/people/${vivId}/disable`, {}, owner)).status).toBe(200);
    // signed out everywhere, and kept out
    expect((await call('/api/designs', {}, viv)).status).toBe(401);
    expect((await post('/api/auth/sign-in/email', { email: 'viv@example.test', password: 'another long password' })).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/api/people/${vivId}/enable`, {}, owner)).status).toBe(200);
    expect((await call('/settings/people', {}, owner)).status).toBe(200);
  });

  it("attributes a signed-in person's save to them", async () => {
    const owner = new Jar();
    await post('/api/auth/sign-in/email', { email: OWNER, password: 'correct horse battery' }, owner);
    expect((await post('/api/vocab/families', { label: 'Owner family', src: 'auth test' }, owner)).status).toBe(201);
    const last = await inOrg(pgh.db, orgId, async (tx) =>
      (await sql<{ actor_label: string; email: string | null }>`SELECT s.actor_label, p.email FROM studio.change_set s LEFT JOIN studio.person p ON p.id = s.actor_id ORDER BY s.id DESC LIMIT 1`.execute(tx)).rows[0],
    );
    expect(last).toEqual({ actor_label: 'Olive Owner', email: OWNER });
  });
});
