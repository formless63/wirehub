/**
 * First-run setup on an empty database (task S3, plan §9.1–9.2): setup mode
 * answers 503 everywhere but /api/setup; /setup refuses without the code,
 * then creates the organisation, its catalog, the admin and the chosen
 * modules' packs; the hub leaves setup mode without a restart and the admin
 * signs in.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople } from '../../server/auth/people.ts';
import { createStudioAuth, type StudioAuth } from '../../server/auth/studio-auth.ts';
import { pgTokens } from '../../server/auth/tokens.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { openPgBackend, type PgBackend } from '../../server/pg/deps.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const BASE = 'http://studio.test';
const CODE = 'ABCD-EFGH-JKMN';

describePg('setup mode', () => {
  let database: TestDatabase;
  let backend: PgBackend;
  let auth: StudioAuth;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    work = mkdtempSync(join(tmpdir(), 'wirehub-setup-mode-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
    backend = await openPgBackend({ DATABASE_URL: database.appUrl, WIREHUB_SETUP_PROMPT: '1' }, { blobs: fsBlobStore(join(work, 'blobs')), setupCode: CODE });
    const config = readAuthConfig({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789', BETTER_AUTH_URL: BASE, WIREHUB_BACKEND: 'pg' }) as AuthConfigEnabled;
    auth = await createStudioAuth(config, { pg: { url: database.appUrl, people: pgPeople(backend.handle.db, backend.orgId), tokens: pgTokens(backend.handle.db, backend.orgId), setupMode: backend.setupMode } });
    backend.attachAuth(auth);
  }, 60_000);
  afterAll(async () => {
    await auth?.close?.();
    await backend?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('creates the org, the starter catalog, the admin and the modules; then the admin signs in', async () => {
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps: backend.deps, depictionDeps: backend.depictionDeps, auth });
    const call = async (path: string, init: RequestInit = {}, cookie?: string) => {
      const headers = new Headers(init.headers);
      if (cookie !== undefined) headers.set('cookie', cookie);
      if (init.method !== undefined && init.method !== 'GET') headers.set('origin', BASE);
      return app.request(`${BASE}${path}`, { ...init, headers });
    };
    const post = (path: string, body: unknown, cookie?: string) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, cookie);

    expect(backend.setupMode()).toBe(true);
    // everything but /api/setup waits for setup, and the setup page needs no session
    expect((await call('/api/designs')).status).toBe(503);
    expect((await call('/setup')).status).toBe(200);
    const view = (await (await call('/api/setup')).json()) as { needed: boolean; codeRequired: boolean; create: { catalogs: string[]; admin: string } };
    expect(view).toMatchObject({ needed: true, codeRequired: true, create: { catalogs: ['starter', 'empty'], admin: 'password' } });

    const form = { org: { name: 'Example Shop', slug: 'example-shop' }, catalog: 'starter', modules: ['pc-serial'], admin: { name: 'Ada Admin', email: 'Ada@Example.com', password: 'a long admin password' } };
    expect((await post('/api/setup', form)).status).toBe(403);
    expect((await post('/api/setup', { ...form, code: CODE, admin: { ...form.admin, password: 'short' } })).status).toBe(400);
    expect(backend.setupMode()).toBe(true);
    const done = await post('/api/setup', { ...form, code: CODE.toLowerCase() });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(((await done.json()) as { created: { org: string } }).created.org).toBe('example-shop');
    expect(backend.setupMode()).toBe(false);

    // signed out: the gate is back
    expect((await call('/api/designs')).status).toBe(401);
    const signIn = await post('/api/auth/sign-in/email', { email: 'ada@example.com', password: 'a long admin password' });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const designs = await call('/api/designs', {}, cookie);
    expect(designs.status).toBe(200);
    const ids = JSON.stringify(await designs.json());
    expect(ids).toContain('de9-crossover');
    expect(ids).toContain('db9-null-modem');
    expect((await pgPeople(backend.handle.db, backend.orgId).personByEmail('ada@example.com'))?.role).toBe('owner');
    // setup is done: it no longer asks, and a second POST cannot recreate anything
    const after = (await (await call('/api/setup', {}, cookie)).json()) as { needed: boolean; completed: boolean };
    expect(after).toMatchObject({ needed: false, completed: true });
    // a save lands, as the admin
    const read = await call('/api/designs/de9-crossover', {}, cookie);
    const saved = await call('/api/designs/de9-crossover', { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': read.headers.get('etag') ?? '' }, body: JSON.stringify({ ...((await read.json()) as object), label: 'Saved by the admin' }) }, cookie);
    expect(saved.status).toBe(200);
    // the indicator: the database is the history (plan §7.6, D6)
    const backup = (await (await call('/api/backup', {}, cookie)).json()) as { state: string; lastChangeSet: { by: string } };
    expect(backup.state).toBe('database');
    expect(backup.lastChangeSet.by).toBe('Ada Admin');
    expect((await post('/api/backup/retry', {}, cookie)).status).toBe(404);
  }, 120_000);
});
