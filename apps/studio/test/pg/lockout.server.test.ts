/**
 * A hub nobody can sign in to (cs-26a, an upgrade whose sign-in settings stayed in the old
 * environment): the sign-in page says so instead of showing a password form no account can
 * use, and `cli.ts owner-password` — run from the server's shell — sets an owner's email +
 * password login, which the sign-in page then takes. Real Better Auth over Postgres.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { verifyPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople } from '../../server/auth/people.ts';
import { createStudioAuth } from '../../server/auth/studio-auth.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { OwnerPasswordError, setOwnerPassword } from '../../server/pg/owner-password.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const BASE = 'http://studio.test';
const STUDIO_DIR = fileURLToPath(new URL('../..', import.meta.url));

describePg('a hub nobody can sign in to', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let orgId: string;
  let closeAuth: (() => Promise<void>) | undefined;
  let call: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-lockout-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    // an owner who used to sign in through the identity provider: a person, and no password
    await pgPeople(pgh.db, orgId).ensurePerson('olive@example.test', 'Olive Owner', 'owner');
    // the upgraded server: sign-in on, email + password accounts (the default), nothing else
    const config = readAuthConfig({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789', BETTER_AUTH_URL: BASE, WIREHUB_BACKEND: 'pg' }) as AuthConfigEnabled;
    const people = pgPeople(pgh.db, orgId);
    const auth = await createStudioAuth(config, { pg: { url: database.appUrl, people } });
    closeAuth = auth.close;
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId), db: pgh.db, blobs: fsBlobStore(join(work, 'blobs')) });
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps, auth });
    call = async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.method !== undefined && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', BASE);
      return app.request(`${BASE}${path}`, { ...init, headers });
    };
  }, 60_000);
  afterAll(async () => {
    await closeAuth?.();
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const signIn = (password: string) => call('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'olive@example.test', password }) });

  it('the sign-in page says there is no way in, and how to get back', async () => {
    const page = await (await call('/sign-in')).text();
    expect(page).toContain('There is no way to sign in to this hub right now');
    expect(page).toContain('compose.override.yaml');
    expect(page).toContain('owner-password');
    expect(page).not.toContain('id="password"');
  });

  it('owner-password makes the login; the page is a sign-in again, and the password works', async () => {
    const done = await setOwnerPassword(pgh.db, orgId, { password: 'a long enough password' });
    expect(done).toMatchObject({ email: 'olive@example.test', name: 'Olive Owner', action: 'created' });
    expect(await pgPeople(pgh.db, orgId).hasPasswordLogin()).toBe(true);
    const hash = (await sql<{ password: string }>`SELECT a.password FROM auth.account a JOIN auth."user" u ON u.id = a."userId" WHERE u.email = 'olive@example.test' AND a."providerId" = 'credential'`.execute(pgh.db)).rows[0]!.password;
    expect(hash).not.toContain('a long enough password');
    expect(await verifyPassword({ hash, password: 'a long enough password' })).toBe(true);
    const page = await (await call('/sign-in')).text();
    expect(page).toContain('id="password"');
    expect(page).not.toContain('There is no way to sign in');
    const ok = await signIn('a long enough password');
    expect(ok.status).toBe(200);
    expect((await signIn('not the password')).status).not.toBe(200);
  });

  it('replaces the password of an existing login, and refuses what it should', async () => {
    const again = await setOwnerPassword(pgh.db, orgId, { email: 'OLIVE@example.test', password: 'another long password' });
    expect(again.action).toBe('replaced');
    expect((await signIn('a long enough password')).status).not.toBe(200);
    expect((await signIn('another long password')).status).toBe(200);
    await expect(setOwnerPassword(pgh.db, orgId, { password: 'short' })).rejects.toThrow(/at least 12/);
    await expect(setOwnerPassword(pgh.db, orgId, { email: 'nobody@example.test', password: 'a long enough password' })).rejects.toThrow(OwnerPasswordError);
    // a person who is not an owner is not who this is for
    await pgPeople(pgh.db, orgId).ensurePerson('ed@example.test', 'Ed Editor', 'editor');
    await expect(setOwnerPassword(pgh.db, orgId, { email: 'ed@example.test', password: 'a long enough password' })).rejects.toThrow(/not an owner/);
  });

  it('the command takes the password on stdin, from the server’s shell', () => {
    const run = (input: string, ...args: string[]) =>
      spawnSync('node', ['--experimental-strip-types', '--no-warnings', '--import', './server/boot-env.ts', 'server/pg/cli.ts', 'owner-password', ...args], {
        cwd: STUDIO_DIR,
        env: { ...process.env, DATABASE_URL: database.appUrl },
        input,
        encoding: 'utf8',
      });
    const done = run('a third long password\n', '--email', 'olive@example.test');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toMatch(/replaced the password of Olive Owner <olive@example.test>/);
    expect(done.stdout).not.toContain('a third long password');
    const refused = run('short\n');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/at least 12/);
  }, 60_000);

  it('the new password signs in', async () => {
    expect((await signIn('a third long password')).status).toBe(200);
  });
});
