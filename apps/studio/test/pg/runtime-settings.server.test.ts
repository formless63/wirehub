/**
 * Runtime settings on Postgres (cs-gm8, `specs/runtime-settings.md`): two studio processes
 * and a worker over one database. A save in one process applies in the others through the
 * catalog's NOTIFY; a secret is a row of ciphertext in `studio.settings_secret` (migration
 * 0019, org-scoped) and never in a catalog document, a change, the export or the history;
 * the worker moves its schedules when Settings change them. (Files: `../runtime-settings.server.test.ts`.)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { workbenchDepsFromEnv } from '../../server/default-deps.ts';
import type { StudioUser } from '../../server/me.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { settingsCipher } from '../../server/settings-secrets.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const KEY = 'pg-test-only-settings-key-0123456789abcdef';
const OWNER: StudioUser = { name: 'Olive Owner', email: 'olive@example.com', source: 'session', role: 'owner' };
const EDITOR: StudioUser = { name: 'Ed Editor', email: 'ed@example.com', source: 'session', role: 'editor' };

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, 100));
  }
};

describePg('runtime settings on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let orgId: string;
  let otherOrg: string;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    otherOrg = (await importCatalog(pgh.db, { org: { slug: 'other', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-settings-'));
  }, 120_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const studio = async (extra: Record<string, string> = {}) => {
    const opened = await workbenchDepsFromEnv({ WIREHUB_BACKEND: 'pg', DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter', WIREHUB_SETTINGS_KEY: KEY, ...extra }, { blobs: testBlobs() });
    const call = async (method: string, path: string, body?: unknown, user: StudioUser = OWNER, headers: Record<string, string> = {}) =>
      (await handleWorkbenchRequest({ method, path, user, headers, ...(body === undefined ? {} : { body }) }, opened.deps)) as { status: number; body: any };
    const etag = async (group: string): Promise<string> => ((await call('GET', '/api/settings/runtime')).body.groups as { id: string; etag: string }[]).find((g) => g.id === group)!.etag;
    const save = async (group: string, values: Record<string, unknown>, user: StudioUser = OWNER) => call('PUT', `/api/settings/runtime/${group}`, { values }, user, { 'if-match': await etag(group) });
    return { ...opened, call, save };
  };

  it('applies a save in every process, keeps secrets as ciphertext only, and records when, not what', async () => {
    const a = await studio();
    const b = await studio({ WIREHUB_NOTIFY_FORMAT: 'slack' });
    try {
      // a non-secret setting, saved in A: B follows through the NOTIFY
      const saved = await a.save('jobs', { 'jobs.convertWindow': '01:00-05:00', 'jobs.backupMaxAgeHours': 40 }, EDITOR);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(a.settings.env().WIREHUB_CONVERT_WINDOW).toBe('01:00-05:00');
      await until(() => b.settings.env().WIREHUB_CONVERT_WINDOW === '01:00-05:00');
      expect(b.settings.env().WIREHUB_BACKUP_MAX_AGE_HOURS).toBe('40');

      // the environment still wins in B
      expect((await a.save('notifications', { 'notify.format': 'ntfy' })).status).toBe(200);
      await until(() => a.settings.env().WIREHUB_NOTIFY_FORMAT === 'ntfy');
      await new Promise((done) => setTimeout(done, 300));
      expect(b.settings.env().WIREHUB_NOTIFY_FORMAT).toBe('slack');
      expect(((await b.call('GET', '/api/settings/runtime')).body.groups[0].fields as { key: string; source: string; saved?: string }[]).find((f) => f.key === 'notify.format')).toMatchObject({ source: 'server', saved: 'ntfy' });

      // a secret: set in A, applied in B, stored as ciphertext bound to the org
      const secret = 'smtp-pa55-0f-the-hub';
      expect((await a.call('PUT', '/api/settings/secrets/smtp.pass', { value: secret })).status).toBe(200);
      await until(() => b.settings.env().AUTH_SMTP_PASS === secret);
      const row = await inOrg(pgh.db, orgId, async (tx) => (await sql<{ name: string; ciphertext: string }>`SELECT name, ciphertext FROM studio.settings_secret`.execute(tx)).rows);
      expect(row.map((r) => r.name)).toEqual(['smtp.pass']);
      expect(row[0]!.ciphertext).not.toContain(secret);
      expect(settingsCipher(KEY).decrypt(orgId, 'smtp.pass', row[0]!.ciphertext)).toBe(secret);
      expect(settingsCipher(KEY).decrypt(otherOrg, 'smtp.pass', row[0]!.ciphertext)).toBeUndefined();
      // row-level security: another org sees none of it
      expect(await inOrg(pgh.db, otherOrg, async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM studio.settings_secret`.execute(tx)).rows[0]!.n)).toBe(0);

      // nowhere in the catalog: not a document, a change, the export or the history
      const everywhere = await inOrg(pgh.db, orgId, async (tx) => {
        const docs = (await sql<{ body: unknown }>`SELECT body FROM studio.catalog_doc`.execute(tx)).rows;
        const changes = (await sql<{ after: unknown; before: unknown }>`SELECT c.after_body AS after, c.before_body AS before FROM studio.change c`.execute(tx)).rows;
        const sets = (await sql<{ message: string }>`SELECT message FROM studio.change_set`.execute(tx)).rows;
        return JSON.stringify([docs, changes, sets]);
      });
      expect(everywhere).toContain('smtp.pass');
      expect(everywhere).not.toContain(secret);
      expect(everywhere).not.toContain(row[0]!.ciphertext);
      const exported = JSON.stringify((await a.call('GET', '/api/export')).body);
      expect(exported).toContain('data/settings/sign-in.json');
      expect(exported).not.toContain(secret);
      const history = await a.call('GET', '/api/history?limit=10');
      expect(history.status, JSON.stringify(history.body)).toBe(200);
      const text = JSON.stringify(history.body);
      expect(text).toMatch(/settings/);
      expect(text).not.toContain(secret);
      // write-only: shown as set
      const view = await a.call('GET', '/api/settings/runtime');
      expect(JSON.stringify(view.body)).not.toContain(secret);
      expect((view.body.groups[1].fields as { key: string; set?: boolean }[]).find((f) => f.key === 'smtp.pass')).toMatchObject({ set: true, source: 'settings' });

      // cleared: gone from the store and from B
      expect((await a.call('DELETE', '/api/settings/secrets/smtp.pass')).body).toEqual({ key: 'smtp.pass', set: false });
      await until(() => b.settings.env().AUTH_SMTP_PASS === undefined);
      expect(await inOrg(pgh.db, orgId, async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM studio.settings_secret`.execute(tx)).rows[0]!.n)).toBe(0);

      // roles hold on pg too
      expect((await a.call('PUT', '/api/settings/secrets/smtp.pass', { value: 'x' }, EDITOR)).status).toBe(403);
    } finally {
      await a.close();
      await b.close();
    }
  }, 120_000);

  it('the worker moves its schedules when Settings change them', async () => {
    const { startWorker } = await import('../../server/worker-run.ts');
    const a = await studio();
    const logs: string[] = [];
    const worker = await startWorker({ env: { DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter', WIREHUB_WORKER_BEAT_FILE: join(work, 'beat'), TZ: 'UTC' }, blobs: testBlobs(), log: (line) => logs.push(line), attempts: 2 });
    try {
      expect(worker).toBeDefined();
      // the window saved in the test above is in force from the start
      expect(worker!.schedules()['model-cache']).toBe('0 1 * * *');
      expect(worker!.schedules()['git-mirror']).toBeUndefined();
      expect((await a.save('integrations', { 'mirror.url': 'https://git.example.com/workshop/catalog.git', 'mirror.cron': '*/15 * * * *' })).status).toBe(200);
      expect((await a.save('jobs', {}, EDITOR)).status).toBe(200);
      await until(() => worker!.schedules()['git-mirror'] === '*/15 * * * *' && worker!.schedules()['model-cache'] === undefined);
      expect(logs.join('\n')).toMatch(/git mirror to https:\/\/git\.example\.com/);
      // and back off
      expect((await a.save('integrations', {})).status).toBe(200);
      await until(() => worker!.schedules()['git-mirror'] === undefined);
    } finally {
      await worker?.stop();
      await a.close();
    }
  }, 120_000);

  it('adopts the server’s values, and keeps owner-only documents out of the export, the history and the git mirror for everyone else', async () => {
    const { runGitMirrorJob } = await import('../../server/history/mirror.ts');
    const { SnapshotCache } = await import('../../server/pg/snapshot.ts');
    const { execFileSync } = await import('node:child_process');
    const { existsSync, readFileSync } = await import('node:fs');
    const secret = 'oidc-pa55-from-the-env';
    const server = { AUTH_OIDC_ISSUER: 'https://id.example.com', AUTH_OIDC_CLIENT_ID: 'wirehub-pg', AUTH_OIDC_CLIENT_SECRET: secret, AUTH_ALLOWED_EMAILS: 'boss@example.com', AUTH_ENABLED: 'false' };
    const a = await studio(server);
    try {
      expect((await a.call('POST', '/api/settings/adopt', {}, EDITOR)).status).toBe(403);
      const view = (await a.call('GET', '/api/settings/runtime')).body;
      expect(view.adoptable.map((x: { env: string }) => x.env).sort()).toEqual(['AUTH_ALLOWED_EMAILS', 'AUTH_OIDC_CLIENT_ID', 'AUTH_OIDC_CLIENT_SECRET', 'AUTH_OIDC_ISSUER']);
      const done = await a.call('POST', '/api/settings/adopt', {});
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.adopted).toEqual(['auth.allowedEmails', 'oidc.clientId', 'oidc.clientSecret', 'oidc.issuer']);
      expect(JSON.stringify(done.body)).not.toContain(secret);

      // Settings now holds them: another process without the variables reads the same values
      const b = await studio();
      try {
        expect(b.settings.env()).toMatchObject({ AUTH_OIDC_ISSUER: 'https://id.example.com', AUTH_OIDC_CLIENT_ID: 'wirehub-pg', AUTH_OIDC_CLIENT_SECRET: secret, AUTH_ALLOWED_EMAILS: 'boss@example.com' });
        expect((await b.call('GET', '/api/settings/runtime')).body.adoptable).toEqual([]);
      } finally {
        await b.close();
      }
      // the secret is ciphertext in its own table, and in no catalog row, change or message
      const rows = await inOrg(pgh.db, orgId, async (tx) => (await sql<{ name: string; ciphertext: string }>`SELECT name, ciphertext FROM studio.settings_secret WHERE name = 'oidc.clientSecret'`.execute(tx)).rows);
      expect(settingsCipher(KEY).decrypt(orgId, 'oidc.clientSecret', rows[0]!.ciphertext)).toBe(secret);
      const everywhere = await inOrg(pgh.db, orgId, async (tx) => JSON.stringify([(await sql`SELECT body FROM studio.catalog_doc`.execute(tx)).rows, (await sql`SELECT after_body, before_body FROM studio.change`.execute(tx)).rows, (await sql`SELECT message, path FROM studio.change_set`.execute(tx)).rows]));
      expect(everywhere).not.toContain(secret);

      // the export: the owner's has the owner-only documents, marked; nobody else's has them
      const SIGN_IN = 'data/settings/sign-in.json';
      const owner = (await a.call('GET', '/api/export')).body;
      expect(owner.files[SIGN_IN]).toContain('boss@example.com');
      expect(owner.owner_only).toContain(SIGN_IN);
      const editor = (await a.call('GET', '/api/export', undefined, EDITOR)).body;
      expect(Object.keys(editor.files).some((p) => p.startsWith('data/settings/') && p !== 'data/settings/jobs.json' && p !== 'data/settings/engineering.json')).toBe(false);
      expect(JSON.stringify(editor)).not.toContain('boss@example.com');

      // the history: an editor sees that the document changed, never what it held
      const list = (await a.call('GET', '/api/history?limit=5', undefined, EDITOR)).body;
      const entry = list.entries.find((e: { touches: { label: string }[] }) => e.touches.some((t) => t.label.includes('settings/sign-in.json')));
      expect(entry, JSON.stringify(list.entries.map((e: { message: string }) => e.message))).toBeDefined();
      const asOwner = (await a.call('GET', `/api/history/entries/${entry.id}`)).body;
      expect(JSON.stringify(asOwner.records)).toContain('boss@example.com');
      const asEditor = (await a.call('GET', `/api/history/entries/${entry.id}`, undefined, EDITOR)).body;
      expect(JSON.stringify(asEditor)).not.toContain('boss@example.com');
      expect(asEditor.records.find((r: { label: string }) => r.label.includes('sign-in.json'))).toMatchObject({ before: { known: false }, after: { known: false }, restorable: false });

      // the git mirror: a first run and a replayed change leave them out
      const { fsBlobStore } = await import('../../server/blobs.ts');
      const dir = join(work, 'mirror');
      const blobs = fsBlobStore(join(work, 'mirror-blobs'));
      const cache = new SnapshotCache(pgh.db, orgId);
      const config = { target: { path: dir }, dir, branch: 'main', user: 'wirehub', cron: '* * * * *' };
      const ctx = () => ({ job: { id: 't', kind: 'git-mirror', status: 'running', request: {}, steps: [], createdAt: new Date().toISOString() }, step: async () => undefined }) as never;
      const first = await runGitMirrorJob(ctx(), { db: pgh.db, orgId, cache, blobs, config });
      expect(first.result).toMatchObject({ resynced: 'first run' });
      expect(existsSync(join(dir, SIGN_IN))).toBe(false);
      expect(existsSync(join(dir, 'data/designs/dc-led-lead.json'))).toBe(true);
      expect((await a.save('integrations', { 'pdf.url': 'http://pdf-mirror-secret:3000' })).status).toBe(200);
      expect((await a.save('jobs', { 'jobs.importMaxMb': 33 }, EDITOR)).status).toBe(200);
      const second = await runGitMirrorJob(ctx(), { db: pgh.db, orgId, cache, blobs, config });
      expect(second.result['resynced'], JSON.stringify(second.result)).toBeUndefined();
      expect(existsSync(join(dir, 'data/settings/integrations.json'))).toBe(false);
      expect(readFileSync(join(dir, 'data/settings/jobs.json'), 'utf8')).toContain('33');
      const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
      expect(tracked).not.toMatch(/settings\/(sign-in|notifications|integrations)\.json/);
      expect(execFileSync('git', ['log', '-p', '--all'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 })).not.toContain('pdf-mirror-secret');
    } finally {
      await a.close();
    }
  }, 120_000);

  it('WIREHUB_TEST_DEFAULTS wins parameter by parameter, shows as set by the server, and can be adopted', async () => {
    const a = await studio({ WIREHUB_TEST_DEFAULTS: '{"isolationVolts":100}' });
    try {
      const get = async () => (await a.call('GET', '/api/settings/engineering')).body;
      const put = async (body: unknown) => a.call('PUT', '/api/settings/engineering', body, OWNER, { 'if-match': ((await a.call('GET', '/api/settings/engineering')) as { headers?: Record<string, string> }).headers?.ETag ?? '' });
      expect((await get()).env.testDefaults).toEqual({ isolationVolts: 100 });
      expect((await put({ testDefaults: { isolationVolts: 250, hipotVolts: 1200 } })).status).toBe(409);
      expect((await put({ testDefaults: { hipotVolts: 1200 } })).status).toBe(200);
      expect((await a.call('GET', '/api/settings/runtime')).body.adoptable).toEqual([{ key: 'testDefaults', env: 'WIREHUB_TEST_DEFAULTS', label: 'Continuity test defaults' }]);
      expect((await a.call('POST', '/api/settings/adopt', {})).body.adopted).toContain('testDefaults');
      expect((await get()).testDefaults).toEqual({ hipotVolts: 1200, isolationVolts: 100 });
    } finally {
      await a.close();
    }
  }, 60_000);
});
