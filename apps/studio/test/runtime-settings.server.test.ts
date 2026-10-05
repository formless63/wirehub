/**
 * Runtime settings (cs-gm8, `specs/runtime-settings.md`): what used to need a redeploy is
 * saved in Settings and applied live. The environment wins and shows as "set by the
 * server"; secrets are write-only, encrypted, and never in a catalog document, the export
 * or the change history; owner-only groups refuse editors, viewers and API tokens.
 * (The same against Postgres: `test/pg/runtime-settings.server.test.ts`.)
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { liveStudioAuth } from '../server/auth/studio-auth.ts';
import { memoryEventHub } from '../server/events.ts';
import { liveNotifier } from '../server/notify.ts';
import { livePdfEngine } from '../server/render/browser-pdf.ts';
import { createRuntimeSettings, overlayEnv, SETTING_GROUPS, type RuntimeSettings } from '../server/runtime-settings.ts';
import { fileSecretStore, memorySecretStore, settingsCipher, type SecretStore } from '../server/settings-secrets.ts';
import type { StudioUser } from '../server/me.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const KEY = 'k'.repeat(43);
const OWNER: StudioUser = { name: 'Olive Owner', email: 'olive@example.com', source: 'session', role: 'owner' };
const EDITOR: StudioUser = { name: 'Ed Editor', email: 'ed@example.com', source: 'session', role: 'editor' };
const VIEWER: StudioUser = { name: 'Vi Viewer', email: 'vi@example.com', source: 'session', role: 'viewer' };

function hub(env: Record<string, string> = {}, options: { key?: string | null; secrets?: SecretStore } = {}) {
  const backend = memoryWriteBackend();
  const deps: WorkbenchDeps = { ...backend.deps, events: memoryEventHub() };
  const secrets = options.secrets ?? memorySecretStore();
  const key = options.key === undefined ? KEY : options.key;
  const settings = createRuntimeSettings({ env, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', ...(key === null ? {} : { cipher: settingsCipher(key) }), log: () => {} });
  settings.follow(deps.events);
  deps.runtimeSettings = settings;
  const call = async (method: string, path: string, body?: unknown, user: StudioUser = OWNER, headers: Record<string, string> = {}) =>
    (await handleWorkbenchRequest({ method, path, user, headers, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string> };
  const group = async (id: string, user: StudioUser = OWNER) => ((await call('GET', '/api/settings/runtime', undefined, user)).body.groups as any[]).find((g) => g.id === id);
  const field = async (key: string, user: StudioUser = OWNER) => (await group(key.startsWith('notify') ? 'notifications' : key.startsWith('jobs') ? 'jobs' : ['store', 'pdf', 'mirror'].includes(key.split('.')[0]!) ? 'integrations' : 'sign-in', user)).fields.find((f: any) => f.key === key);
  const save = async (id: string, values: Record<string, unknown>, user: StudioUser = OWNER) => call('PUT', `/api/settings/runtime/${id}`, { values }, user, { 'if-match': (await group(id, OWNER)).etag });
  return { deps, settings, secrets, call, group, field, save };
}

describe('the settings model', () => {
  it('lays saved values under the environment, which wins when it is set (blank counts as unset)', () => {
    const env = overlayEnv(
      { WIREHUB_NOTIFY_FORMAT: 'ntfy', WIREHUB_CONVERT_WINDOW: '  ', OTHER: 'x' },
      { notifications: { values: { 'notify.format': 'slack' }, src: '' }, jobs: { values: { 'jobs.convertWindow': '01:00-06:00', 'jobs.importMaxMb': 12 }, src: '' }, 'sign-in': { values: { 'auth.allowedEmails': ['a@x.org', 'b@x.org'], 'smtp.secure': false }, src: '' } },
      { 'notify.url': 'https://hooks.example/abc' },
    );
    expect(env).toMatchObject({ WIREHUB_NOTIFY_FORMAT: 'ntfy', WIREHUB_CONVERT_WINDOW: '01:00-06:00', WIREHUB_IMPORT_MAX_MB: '12', AUTH_ALLOWED_EMAILS: 'a@x.org,b@x.org', AUTH_SMTP_SECURE: 'false', WIREHUB_NOTIFY_URL: 'https://hooks.example/abc', OTHER: 'x' });
  });

  it('names an environment variable for every setting, once, and marks the credentials secret', () => {
    const fields = SETTING_GROUPS.flatMap((g) => g.fields);
    expect(new Set(fields.map((f) => f.env)).size).toBe(fields.length);
    expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length);
    expect(fields.filter((f) => f.secret === true).map((f) => f.key).sort()).toEqual(['mirror.sshKey', 'mirror.token', 'notify.token', 'notify.url', 'oidc.clientSecret', 'smtp.pass']);
    expect(SETTING_GROUPS.map((g) => [g.id, g.role])).toEqual([['notifications', 'owner'], ['sign-in', 'owner'], ['integrations', 'owner'], ['jobs', 'editor']]);
  });

  it('encrypts with the install key, bound to the organisation and the name', () => {
    const cipher = settingsCipher(KEY);
    const sealed = cipher.encrypt('org-a', 'smtp.pass', 'hunter2');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('hunter2');
    expect(cipher.encrypt('org-a', 'smtp.pass', 'hunter2')).not.toBe(sealed);
    expect(cipher.decrypt('org-a', 'smtp.pass', sealed)).toBe('hunter2');
    expect(cipher.decrypt('org-b', 'smtp.pass', sealed)).toBeUndefined();
    expect(cipher.decrypt('org-a', 'notify.url', sealed)).toBeUndefined();
    expect(settingsCipher('z'.repeat(43)).decrypt('org-a', 'smtp.pass', sealed)).toBeUndefined();
  });
});

describe('runtime settings in the API', () => {
  it('shows each value with where it comes from, and the environment as "set by the server"', async () => {
    const { field, save, settings } = hub({ WIREHUB_NOTIFY_FORMAT: 'slack', WIREHUB_IMPORT_MAX_MB: '7' });
    expect(await field('notify.format')).toMatchObject({ source: 'server', value: 'slack', env: 'WIREHUB_NOTIFY_FORMAT' });
    expect(await field('jobs.importMaxMb')).toMatchObject({ source: 'server', value: 7 });
    expect(await field('jobs.convertWindow')).toMatchObject({ source: 'default', defaultText: 'any time' });
    expect((await field('jobs.convertWindow')).value).toBeUndefined();

    // a locked value cannot be changed here; the rest saves, and applies before the answer
    const refused = await save('jobs', { 'jobs.importMaxMb': 9, 'jobs.convertWindow': '01:00-06:00' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/set by the server \(WIREHUB_IMPORT_MAX_MB\)/);
    const saved = await save('jobs', { 'jobs.convertWindow': '01:00-06:00' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(settings.env().WIREHUB_CONVERT_WINDOW).toBe('01:00-06:00');
    expect(settings.env().WIREHUB_IMPORT_MAX_MB).toBe('7');
    expect(await field('jobs.convertWindow')).toMatchObject({ source: 'settings', value: '01:00-06:00' });
  });

  it('refuses what the server would refuse, in the field’s words, and needs If-Match', async () => {
    const { call, save, group } = hub({ AUTH_ENABLED: 'true', WIREHUB_BACKEND: 'files', AUTH_ALLOWED_EMAILS: 'olive@example.com' });
    expect((await call('PUT', '/api/settings/runtime/jobs', { values: {} })).status).toBe(428);
    expect((await save('jobs', { 'jobs.convertWindow': '25:00-06:00' })).body.error).toMatch(/Model build window: is a window/);
    expect((await save('jobs', { 'jobs.importMaxMb': 0 })).body.error).toMatch(/from 1 to 2048/);
    expect((await save('integrations', { 'mirror.cron': 'every five minutes' })).body.error).toMatch(/five fields/);
    expect((await save('integrations', { 'pdf.url': 'ftp://pdf' })).body.error).toMatch(/PDF engine URL: is an http\(s\) URL/);
    expect((await save('integrations', { 'mirror.url': 'https://me:pw@git.example.com/x.git' })).body.error).toMatch(/“Git mirror remote” carries a password/);
    const oidc = await save('sign-in', { 'oidc.issuer': 'https://id.example.com' });
    expect(oidc.status).toBe(400);
    expect(oidc.body.error).toMatch(/“OIDC client id” is not set/);
    expect((await save('notifications', { 'notify.url': 'x' })).body.error).toMatch(/is a secret/);
    expect((await save('notifications', { 'nope.x': 1 })).status).toBe(400);
    // a refusal saves nothing
    expect((await group('integrations')).fields.every((f: any) => f.source === 'default')).toBe(true);
  });

  it('keeps secrets write-only and encrypted, out of the documents, the export and the history', async () => {
    const { call, field, settings, secrets, deps } = hub();
    const sets: unknown[] = [];
    deps.afterCommit = (set) => void sets.push(set);
    const url = 'https://ntfy.example.com/wirehub-s3cr3t-topic';
    const set = await call('PUT', '/api/settings/secrets/notify.url', { value: url });
    // one change set: the document's marker, with no request body (the secret) in its context
    expect(sets).toHaveLength(1);
    expect(JSON.stringify(sets[0])).not.toContain('s3cr3t');
    expect((sets[0] as { context: { body?: unknown; path: string } }).context).toMatchObject({ path: '/api/settings/secrets/notify.url' });
    expect((sets[0] as { context: { body?: unknown } }).context.body).toBeUndefined();
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ key: 'notify.url', set: true });
    // applied
    expect(settings.env().WIREHUB_NOTIFY_URL).toBe(url);
    // shown as set, never as its value
    const view = await call('GET', '/api/settings/runtime');
    expect(JSON.stringify(view.body)).not.toContain('s3cr3t');
    expect(await field('notify.url')).toMatchObject({ secret: true, set: true, source: 'settings' });
    // the store holds ciphertext; the document only when it was set
    const stored = (await (secrets as ReturnType<typeof memorySecretStore>).all())['notify.url']!;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('s3cr3t');
    const doc = (await deps.docs!.read('data/settings/notifications.json')) as { secrets: Record<string, string> };
    expect(Object.keys(doc.secrets)).toEqual(['notify.url']);
    expect(JSON.stringify(doc)).not.toContain('s3cr3t');
    const exported = JSON.stringify(await deps.exportCatalog!());
    expect(exported).toContain('data/settings/notifications.json');
    expect(exported).not.toContain('s3cr3t');
    expect(exported).not.toContain(stored);
    // no route reads it back
    expect((await call('GET', '/api/settings/secrets/notify.url')).status).toBe(405);
    expect((await call('GET', '/api/docs/data/settings/notifications.json')).body).toEqual(doc);

    // cleared
    expect((await call('DELETE', '/api/settings/secrets/notify.url')).body).toEqual({ key: 'notify.url', set: false });
    expect(settings.env().WIREHUB_NOTIFY_URL).toBeUndefined();
    expect(await (secrets as ReturnType<typeof memorySecretStore>).all()).toEqual({});
    expect(await deps.docs!.read('data/settings/notifications.json')).toBeUndefined();
  });

  it('refuses a secret the server sets, a bad one, and any secret without an install key', async () => {
    const locked = hub({ AUTH_SMTP_PASS: 'from-env' });
    expect((await locked.call('PUT', '/api/settings/secrets/smtp.pass', { value: 'x' })).status).toBe(409);
    expect(await locked.field('smtp.pass')).toMatchObject({ source: 'server', set: true });
    expect((await locked.call('PUT', '/api/settings/secrets/notify.url', { value: 'not a url' })).body.error).toMatch(/Webhook URL: is an http\(s\) URL/);
    expect((await locked.call('PUT', '/api/settings/secrets/mirror.sshKey', { value: 'ssh-ed25519 AAAA… public' })).status).toBe(400);
    expect((await locked.call('PUT', '/api/settings/secrets/nope.x', { value: 'x' })).status).toBe(404);

    const keyless = hub({}, { key: null });
    const refused = await keyless.call('PUT', '/api/settings/secrets/notify.token', { value: 'abc' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/no settings key/);
    expect((await keyless.call('GET', '/api/settings/runtime')).body.secrets.available).toBe(false);
  });

  it('says so when a stored secret no longer decrypts (the key changed), and ignores it', async () => {
    const secrets = memorySecretStore({ 'smtp.pass': settingsCipher('o'.repeat(43)).encrypt('files', 'smtp.pass', 'old') });
    const { settings, field, call } = hub({}, { secrets });
    await settings.refresh();
    expect(settings.env().AUTH_SMTP_PASS).toBeUndefined();
    expect(await field('smtp.pass')).toMatchObject({ set: true, unreadable: true });
    expect((await call('GET', '/api/settings/runtime')).body.problems.join(' ')).toMatch(/SMTP password .* does not decrypt/);
  });

  it('lets editors change Jobs & limits only, shows them no owner values, and refuses viewers and tokens', async () => {
    const { save, group, call, field } = hub();
    expect((await call('PUT', '/api/settings/secrets/notify.url', { value: 'https://ntfy.example.com/t' })).status).toBe(200);
    expect((await save('integrations', { 'pdf.url': 'http://pdf:3000' })).status).toBe(200);

    const forEditor = await group('integrations', EDITOR);
    expect(forEditor).toMatchObject({ restricted: true, editable: false });
    expect(forEditor.fields.find((f: any) => f.key === 'pdf.url').value).toBeUndefined();
    expect(forEditor.fields.every((f: any) => f.value === undefined && f.set === undefined)).toBe(true);
    expect((await field('notify.url', EDITOR)).set).toBeUndefined();
    expect((await save('integrations', { 'pdf.url': 'http://evil:3000' }, EDITOR)).status).toBe(403);
    expect((await call('PUT', '/api/settings/secrets/notify.url', { value: 'https://evil.example/x' }, EDITOR)).status).toBe(403);
    expect((await call('GET', '/api/settings/runtime/integrations', undefined, EDITOR)).status).toBe(403);
    expect((await call('GET', '/api/docs/data/settings/integrations.json', undefined, EDITOR)).status).toBe(403);
    expect((await call('GET', '/api/docs/data/settings/integrations.json', undefined, OWNER)).status).toBe(200);
    expect((await save('jobs', { 'jobs.importMaxMb': 50 }, EDITOR)).status).toBe(200);

    expect((await group('jobs', VIEWER)).editable).toBe(false);
    expect((await save('jobs', { 'jobs.importMaxMb': 60 }, VIEWER)).status).toBe(403);
    // an owner's API token: not for the security-sensitive groups
    const token: StudioUser = { ...OWNER, apiTokenId: 'tok-1', apiTokenScopes: ['read', 'catalog:write'] };
    expect((await save('notifications', { 'notify.format': 'ntfy' }, token)).status).toBe(403);
    expect((await call('DELETE', '/api/settings/secrets/notify.url', undefined, token)).status).toBe(403);
    expect((await save('jobs', { 'jobs.importMaxMb': 70 }, token)).status).toBe(200);
  });
});

describe('live apply', () => {
  it('the webhook, its format and token follow Settings without a restart', async () => {
    const { call, save, settings } = hub();
    const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
    const notifier = liveNotifier(() => settings.env(), {
      log: () => {},
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response('ok');
      }) as unknown as typeof fetch,
    });
    expect(notifier.enabled).toBe(false);
    await notifier.notify({ event: 'test', severity: 'default', title: 'T', message: 'one' });
    expect(posts).toHaveLength(0);

    await call('PUT', '/api/settings/secrets/notify.url', { value: 'https://ntfy.example.com/hub' });
    await call('PUT', '/api/settings/secrets/notify.token', { value: 'tk_123' });
    await save('notifications', { 'notify.format': 'ntfy' });
    expect(notifier.enabled).toBe(true);
    await notifier.notify({ event: 'test', severity: 'high', title: 'T', message: 'two' });
    expect(posts).toEqual([{ url: 'https://ntfy.example.com/hub', headers: expect.objectContaining({ authorization: 'Bearer tk_123', priority: '4' }), body: 'two' }]);
  });

  it('the PDF engine, the import limit and the store options follow Settings', async () => {
    const { deps, save, settings, call } = hub();
    expect(livePdfEngine(settings)).toBeUndefined();
    await save('integrations', { 'pdf.url': 'http://pdf:3000', 'pdf.timeoutMs': 5000, 'store.allowUserSources': false });
    expect(livePdfEngine(settings)).toBeDefined();
    expect((await call('GET', '/api/settings/stores')).body.allowUserSources).toBe(false);
    await save('jobs', { 'jobs.importMaxMb': 3 });
    const { importUploadLimit } = await import('../server/jobs/api.ts');
    expect(importUploadLimit(deps.runtimeSettings!.env())).toBe(3 * 1024 * 1024);
  });

  it('a change made in another process arrives with the catalog notification', async () => {
    const a = hub();
    // a second process over the same documents and secrets, listening to the same events
    const b = createRuntimeSettings({ env: {}, docs: () => a.deps.docs, secrets: () => a.secrets, org: () => 'files', cipher: settingsCipher(KEY), log: () => {} });
    b.follow(a.deps.events);
    let changes = 0;
    b.onChange(() => (changes += 1));
    await a.save('jobs', { 'jobs.backupMaxAgeHours': 48 });
    await vi_waitFor(() => b.env().WIREHUB_BACKUP_MAX_AGE_HOURS === '48');
    expect(changes).toBe(1);
  });

  it('the sign-in rebuilds in-process when its methods change, and keeps the server’s secret and address', async () => {
    const env = { AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 's'.repeat(40), BETTER_AUTH_URL: 'https://hub.example.com', WIREHUB_BACKEND: 'files', AUTH_ALLOWED_EMAILS: 'olive@example.com', AUTH_SMTP_HOST: 'smtp.example.com', AUTH_SMTP_FROM: 'hub@example.com' };
    const { save, call, settings } = hub(env);
    const lines: string[] = [];
    const auth = (await liveStudioAuth(settings, { database: new DatabaseSync(':memory:') }, (line) => lines.push(line)))!;
    expect(auth.config.oidc).toBeUndefined();
    expect(auth.config.smtp?.host).toBe('smtp.example.com');
    expect(await auth.isAllowed('new@example.com')).toBe(false);
    // the allow-list is the server's (env wins); the OIDC client comes from Settings
    const saved = await save('sign-in', { 'oidc.issuer': 'https://id.example.com', 'oidc.clientId': 'wirehub', 'oidc.name': 'Company SSO' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await call('PUT', '/api/settings/secrets/oidc.clientSecret', { value: 'client-secret-1' })).status).toBe(200);
    await auth.settled();
    expect(auth.config.oidc).toMatchObject({ issuer: 'https://id.example.com', clientId: 'wirehub', name: 'Company SSO', clientSecret: 'client-secret-1' });
    expect(auth.config.baseURL).toBe('https://hub.example.com');
    expect(auth.config.secret).toBe(env.BETTER_AUTH_SECRET);
    expect(lines.join('\n')).toMatch(/sign-in reloaded from the settings: Company SSO/);
    expect(auth.problem()).toBeUndefined();
    // the token budgets too
    await save('sign-in', { 'oidc.issuer': 'https://id.example.com', 'oidc.clientId': 'wirehub', 'limits.tokenWritesPerMinute': 5 });
    expect(auth.limits!().write[0]).toEqual({ count: 5, ms: 60_000 });
    await auth.close?.();
  });
});

describe('the file backend', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keeps the secrets in one private file beside the sign-in data, as ciphertext', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wh-secrets-'));
    const path = join(dir, 'auth', 'settings-secrets.json');
    const { call, settings } = hub({}, { secrets: fileSecretStore(path) });
    expect((await call('PUT', '/api/settings/secrets/mirror.token', { value: 'glpat-123456' })).status).toBe(200);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('glpat-123456');
    expect(JSON.parse(text).secrets['mirror.token']).toMatch(/^v1\./);
    expect(settings.env().WIREHUB_GIT_MIRROR_TOKEN).toBe('glpat-123456');
    const { statSync } = await import('node:fs');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

async function vi_waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}

export type { RuntimeSettings };
