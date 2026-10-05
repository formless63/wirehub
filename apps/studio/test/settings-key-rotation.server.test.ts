/**
 * Rotating WIREHUB_SETTINGS_KEY (cs-za5): the cipher reads with a key ring and writes with the
 * current key; `rotateSecrets` moves every stored secret to the current key without a gap in
 * reads; the owner-only "Rotate key" action and the CLI do it on the file backend. (Postgres:
 * `test/pg/settings-key-rotation.server.test.ts`; the bootstrap's key generation: `stack.server.test.ts`.)
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryEventHub } from '../server/events.ts';
import type { StudioUser } from '../server/me.ts';
import { createRuntimeSettings } from '../server/runtime-settings.ts';
import { runSettingsKeyCommand } from '../server/settings-key-cli.ts';
import { fileSecretStore, generateSettingsKey, memorySecretStore, previousSettingsKeys, rotateSecrets, settingsCipher, settingsCipherFromEnv, type SecretStore } from '../server/settings-secrets.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const OLD = 'o'.repeat(43);
const NEW = 'n'.repeat(43);
const OWNER: StudioUser = { name: 'Olive Owner', email: 'olive@example.com', source: 'session', role: 'owner' };
const EDITOR: StudioUser = { name: 'Ed Editor', email: 'ed@example.com', source: 'session', role: 'editor' };
const TOKEN = { ...OWNER, apiTokenId: 'tok-1', apiTokenScopes: ['read', 'catalog:write'] } as StudioUser;

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirehub-key-rotation-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the key ring', () => {
  it('reads with a previous key, writes with the current one', () => {
    const before = settingsCipher(OLD).encrypt('org', 'smtp.pass', 'hunter2');
    const ring = settingsCipher(NEW, [OLD]);
    expect(ring.previousKeys).toBe(1);
    expect(ring.decrypt('org', 'smtp.pass', before)).toBe('hunter2');
    expect(ring.isCurrent('org', 'smtp.pass', before)).toBe(false);
    const after = ring.encrypt('org', 'smtp.pass', 'hunter2');
    expect(settingsCipher(NEW).decrypt('org', 'smtp.pass', after)).toBe('hunter2');
    expect(settingsCipher(OLD).decrypt('org', 'smtp.pass', after)).toBeUndefined();
    expect(ring.isCurrent('org', 'smtp.pass', after)).toBe(true);
    // bound to org and name whichever key opens it
    expect(ring.decrypt('other', 'smtp.pass', before)).toBeUndefined();
    expect(settingsCipher(NEW, ['z'.repeat(43)]).decrypt('org', 'smtp.pass', before)).toBeUndefined();
  });

  it('takes previous keys from the variable and the volume file, newest first, without the current one or duplicates', () => {
    const env = { WIREHUB_SECRETS_DIR: dir, WIREHUB_SETTINGS_KEY: NEW, WIREHUB_SETTINGS_KEY_PREVIOUS: `${OLD}, ${NEW}` };
    expect(previousSettingsKeys(env, NEW)).toEqual([OLD]);
    writeFileSync(join(dir, 'settings_key_previous'), `${'a'.repeat(40)}\n${OLD}\n`);
    expect(previousSettingsKeys(env, NEW)).toEqual([OLD, 'a'.repeat(40)]);
    expect(settingsCipherFromEnv(env)?.previousKeys).toBe(2);
    expect(() => previousSettingsKeys({ ...env, WIREHUB_SETTINGS_KEY_PREVIOUS: 'short' }, NEW)).toThrow(/at least 32/);
    const lines: string[] = [];
    expect(settingsCipherFromEnv({ ...env, WIREHUB_SETTINGS_KEY_PREVIOUS: 'short' }, (l) => lines.push(l))).toBeUndefined();
    expect(lines[0]).toMatch(/previous settings key/);
  });

  it('generates keys the server accepts', () => {
    const key = generateSettingsKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(settingsCipherFromEnv({ WIREHUB_SETTINGS_KEY: key })).toBeDefined();
    expect(generateSettingsKey()).not.toBe(key);
  });
});

describe.each([
  ['memory', () => memorySecretStore()],
  ['file', () => fileSecretStore(join(dir, 'settings-secrets.json'))],
] as [string, () => SecretStore][])('rotateSecrets on the %s store', (_name, make) => {
  it('moves every secret to the current key, leaves what no key opens, and a second run does nothing', async () => {
    const store = make();
    const old = settingsCipher(OLD);
    await store.put('smtp.pass', old.encrypt('files', 'smtp.pass', 'one'));
    await store.put('notify.url', old.encrypt('files', 'notify.url', 'two'));
    await store.put('mirror.token', settingsCipher('x'.repeat(43)).encrypt('files', 'mirror.token', 'lost'));
    const ring = settingsCipher(NEW, [OLD]);
    const damaged = (await store.all())['mirror.token'];
    const report = await rotateSecrets(store, ring, 'files');
    expect(report).toEqual({ total: 3, rotated: ['notify.url', 'smtp.pass'], current: 0, skipped: [], unreadable: ['mirror.token'] });
    const rows = await store.all();
    // new key alone now reads the two; the lost one is as it was
    expect(settingsCipher(NEW).decrypt('files', 'smtp.pass', rows['smtp.pass']!)).toBe('one');
    expect(settingsCipher(NEW).decrypt('files', 'notify.url', rows['notify.url']!)).toBe('two');
    expect(rows['mirror.token']).toBe(damaged);
    expect(await rotateSecrets(store, ring, 'files')).toMatchObject({ rotated: [], current: 2, unreadable: ['mirror.token'] });
  });

  it('keeps a secret saved while rotating (the swap only replaces what it read)', async () => {
    const store = make();
    await store.put('smtp.pass', settingsCipher(OLD).encrypt('files', 'smtp.pass', 'one'));
    const ring = settingsCipher(NEW, [OLD]);
    // a save lands between the read and the swap
    const racing: SecretStore = {
      ...store,
      swap: async (name, expected, next) => {
        await store.put(name, ring.encrypt('files', name, 'saved meanwhile'));
        return store.swap(name, expected, next);
      },
    };
    const report = await rotateSecrets(racing, ring, 'files');
    expect(report.skipped).toEqual(['smtp.pass']);
    expect(ring.decrypt('files', 'smtp.pass', (await store.all())['smtp.pass']!)).toBe('saved meanwhile');
  });
});

describe('the Rotate key action', () => {
  function hub(options: { keyless?: boolean } = {}) {
    const backend = memoryWriteBackend();
    const deps: WorkbenchDeps = { ...backend.deps, events: memoryEventHub() };
    const secrets = memorySecretStore();
    const settings = createRuntimeSettings({ env: {}, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', ...(options.keyless === true ? {} : { cipher: settingsCipher(NEW, [OLD]) }), log: () => {} });
    deps.runtimeSettings = settings;
    const call = async (method: string, path: string, user: StudioUser = OWNER) => (await handleWorkbenchRequest({ method, path, user, headers: {}, body: {} }, deps)) as { status: number; body: any };
    return { secrets, settings, call };
  }

  it('re-encrypts under the current key, and the page shows how the ring stands', async () => {
    const { secrets, settings, call } = hub();
    await secrets.put('smtp.pass', settingsCipher(OLD).encrypt('files', 'smtp.pass', 'one'));
    await settings.refresh();
    // still readable through the ring, so the setting applies before any rotation
    expect(settings.env().AUTH_SMTP_PASS).toBe('one');
    expect((await call('GET', '/api/settings/runtime')).body.secrets).toEqual({ available: true, keyRing: { previousKeys: 1, total: 1, stale: 1, unreadable: 0 } });
    const done = await call('POST', '/api/settings/rotate-key');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ total: 1, rotated: ['smtp.pass'], unreadable: [], previousKeys: 1 });
    expect(JSON.stringify(done.body)).not.toContain('one');
    expect(settingsCipher(NEW).decrypt('files', 'smtp.pass', (await secrets.all())['smtp.pass']!)).toBe('one');
    expect(settings.env().AUTH_SMTP_PASS).toBe('one');
    expect((await call('GET', '/api/settings/runtime')).body.secrets.keyRing).toMatchObject({ stale: 0 });
  });

  it('is for an owner in a signed-in session only, and needs a key', async () => {
    const { call } = hub();
    expect((await call('POST', '/api/settings/rotate-key', EDITOR)).status).toBe(403);
    expect((await call('POST', '/api/settings/rotate-key', TOKEN)).status).toBe(403);
    expect((await call('GET', '/api/settings/rotate-key')).status).toBe(405);
    // an editor and a token never see the ring
    expect((await call('GET', '/api/settings/runtime', EDITOR)).body.secrets).toEqual({ available: true });
    expect((await call('GET', '/api/settings/runtime', TOKEN)).body.secrets).toEqual({ available: true });
    expect((await hub({ keyless: true }).call('POST', '/api/settings/rotate-key')).status).toBe(409);
  });
});

describe('the CLI on the file backend', () => {
  it('reports and rotates the secrets file the server reads, with the ring from the environment', async () => {
    const auth = join(dir, 'auth');
    mkdirSync(auth);
    const store = fileSecretStore(join(auth, 'settings-secrets.json'));
    await store.put('smtp.pass', settingsCipher(OLD).encrypt('files', 'smtp.pass', 'one'));
    const env = { AUTH_DATA_DIR: auth, WIREHUB_SECRETS_DIR: dir, WIREHUB_SETTINGS_KEY: NEW, WIREHUB_SETTINGS_KEY_PREVIOUS: OLD };
    expect((await runSettingsKeyCommand('status', env))[0]).toMatch(/1 stored secret: 0 under the current key, 1 under a previous key, 0 that no key reads/);
    expect((await runSettingsKeyCommand('rotate', env)).join(' ')).toMatch(/1 re-encrypted.*previous key can now be removed/);
    expect(readFileSync(join(auth, 'settings-secrets.json'), 'utf8')).not.toContain('one');
    expect(settingsCipher(NEW).decrypt('files', 'smtp.pass', (await store.all())['smtp.pass']!)).toBe('one');
    expect((await runSettingsKeyCommand('rotate', env))[0]).toMatch(/0 re-encrypted under the current key, 1 already/);
    await expect(runSettingsKeyCommand('status', { AUTH_DATA_DIR: auth })).rejects.toThrow(/no settings key/);
  });
});
