/**
 * Rotating the settings key on Postgres (cs-za5): a hub started with the new key and the old one
 * as `WIREHUB_SETTINGS_KEY_PREVIOUS` reads every secret at once; "Rotate key" (and the CLI) moves
 * the rows of `studio.settings_secret` to the new key with a compare-and-swap, so a secret saved
 * meanwhile is kept. (Files: `../settings-key-rotation.server.test.ts`.)
 */

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { dataPath } from '@wirehub/catalog';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { workbenchDepsFromEnv } from '../../server/default-deps.ts';
import type { StudioUser } from '../../server/me.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSecretStore } from '../../server/pg/settings-secrets.ts';
import { runSettingsKeyCommand } from '../../server/settings-key-cli.ts';
import { settingsCipher } from '../../server/settings-secrets.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const OLD = 'pg-old-settings-key-0123456789abcdefghij';
const NEW = 'pg-new-settings-key-0123456789abcdefghij';
const OWNER: StudioUser = { name: 'Olive Owner', email: 'olive@example.com', source: 'session', role: 'owner' };
const EDITOR: StudioUser = { name: 'Ed Editor', email: 'ed@example.com', source: 'session', role: 'editor' };

describePg('settings key rotation on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let orgId: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
  }, 120_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
  }, 60_000);

  const studio = async (extra: Record<string, string>) => {
    const opened = await workbenchDepsFromEnv({ WIREHUB_BACKEND: 'pg', DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter', WIREHUB_SECRETS_DIR: '/nonexistent', ...extra }, { blobs: testBlobs() });
    const call = async (method: string, path: string, user: StudioUser = OWNER) => (await handleWorkbenchRequest({ method, path, user, headers: {}, body: {} }, opened.deps)) as { status: number; body: any };
    return { ...opened, call };
  };
  const rows = async (): Promise<Record<string, string>> => Object.fromEntries((await inOrg(pgh.db, orgId, async (tx) => (await sql<{ name: string; ciphertext: string }>`SELECT name, ciphertext FROM studio.settings_secret`.execute(tx)).rows)).map((r) => [r.name, r.ciphertext]));

  it('reads with the old key during the rotation, re-encrypts on request, and the old key then reads nothing', async () => {
    // a hub on the old key holds two secrets
    const before = await studio({ WIREHUB_SETTINGS_KEY: OLD });
    try {
      expect((await before.call('PUT', '/api/settings/secrets/smtp.pass')).status).toBe(400); // no value: proves the route is live
      for (const [key, value] of [['smtp.pass', 'pg-smtp-secret'], ['notify.token', 'pg-token-secret']] as const) {
        const done = await handleWorkbenchRequest({ method: 'PUT', path: `/api/settings/secrets/${key}`, user: OWNER, headers: {}, body: { value } }, before.deps);
        expect(done.status, JSON.stringify(done.body)).toBe(200);
      }
    } finally {
      await before.close();
    }
    expect(Object.keys(await rows()).sort()).toEqual(['notify.token', 'smtp.pass']);

    // restart with the new key and the old as previous: nothing is lost, nothing is rotated yet
    const env = { WIREHUB_SETTINGS_KEY: NEW, WIREHUB_SETTINGS_KEY_PREVIOUS: OLD };
    const during = await studio(env);
    try {
      expect(during.settings.env().AUTH_SMTP_PASS).toBe('pg-smtp-secret');
      expect(during.settings.problems()).toEqual([]);
      expect((await during.call('GET', '/api/settings/runtime')).body.secrets.keyRing).toEqual({ previousKeys: 1, total: 2, stale: 2, unreadable: 0 });
      // a save now is already under the new key
      const saved = await handleWorkbenchRequest({ method: 'PUT', path: '/api/settings/secrets/notify.token', user: OWNER, headers: {}, body: { value: 'pg-token-secret-2' } }, during.deps);
      expect(saved.status).toBe(200);
      expect((await during.call('POST', '/api/settings/rotate-key', EDITOR)).status).toBe(403);
      const done = await during.call('POST', '/api/settings/rotate-key');
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toMatchObject({ total: 2, rotated: ['smtp.pass'], current: 1, unreadable: [] });
      expect(during.settings.env()).toMatchObject({ AUTH_SMTP_PASS: 'pg-smtp-secret', WIREHUB_NOTIFY_TOKEN: 'pg-token-secret-2' });
    } finally {
      await during.close();
    }

    // every row is under the new key alone: the old key can go
    const stored = await rows();
    for (const [name, ciphertext] of Object.entries(stored)) {
      expect(settingsCipher(NEW).decrypt(orgId, name, ciphertext), name).toBeDefined();
      expect(settingsCipher(OLD).decrypt(orgId, name, ciphertext), name).toBeUndefined();
    }
    const after = await studio({ WIREHUB_SETTINGS_KEY: NEW });
    try {
      expect(after.settings.problems()).toEqual([]);
      expect(after.settings.env().AUTH_SMTP_PASS).toBe('pg-smtp-secret');
    } finally {
      await after.close();
    }
  }, 120_000);

  it('swaps a row only while it is still what was read, and the CLI rotates the same rows', async () => {
    const store = pgSecretStore(pgh.db, orgId);
    const cipher = settingsCipher(NEW);
    const one = cipher.encrypt(orgId, 'smtp.pass', 'swap-one');
    await store.put('smtp.pass', one);
    expect(await store.swap('smtp.pass', 'not-what-is-stored', 'x')).toBe(false);
    expect((await store.all())['smtp.pass']).toBe(one);
    const two = cipher.encrypt(orgId, 'smtp.pass', 'swap-two');
    expect(await store.swap('smtp.pass', one, two)).toBe(true);
    expect((await store.all())['smtp.pass']).toBe(two);

    // a row under the old key; the CLI, given both keys, moves it
    await store.put('oidc.clientSecret', settingsCipher(OLD).encrypt(orgId, 'oidc.clientSecret', 'cli-secret'));
    const env = { WIREHUB_BACKEND: 'pg', DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter', WIREHUB_SECRETS_DIR: '/nonexistent', WIREHUB_SETTINGS_KEY: NEW, WIREHUB_SETTINGS_KEY_PREVIOUS: OLD };
    expect((await runSettingsKeyCommand('status', env))[0]).toMatch(/under a previous key/);
    expect((await runSettingsKeyCommand('rotate', env))[0]).toMatch(/1 re-encrypted/);
    expect(cipher.decrypt(orgId, 'oidc.clientSecret', (await store.all())['oidc.clientSecret']!)).toBe('cli-secret');
  }, 60_000);
});
