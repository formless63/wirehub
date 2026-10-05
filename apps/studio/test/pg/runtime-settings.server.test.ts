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
});
