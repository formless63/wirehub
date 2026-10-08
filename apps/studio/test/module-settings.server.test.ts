/**
 * Module settings on the file backend (cs-nws, module API 1.5; `server/module-settings.ts`): the
 * scripted session of `module-settings-scenario.ts` over the file backend's secret store (a JSON
 * file of mode 0600 beside the sign-in data), and what only this backend shows directly — the
 * change sets the commit is handed. (Postgres: `test/pg/module-settings.server.test.ts`.)
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry, defineModule } from '@wirehub/modules';
import { afterEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryEventHub } from '../server/events.ts';
import { moduleSettingsFor } from '../server/module-settings.ts';
import { createRuntimeSettings, isOwnerOnlySettingsPath } from '../server/runtime-settings.ts';
import { fileSecretStore, rotateSecrets, settingsCipher, type SecretStore } from '../server/settings-secrets.ts';
import { EDITOR, KEY, OWNER, SERVER_ENV, keyed, runModuleSettingsScenario, scenarioRegistry } from './module-settings-scenario.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hub(env: Record<string, string> = SERVER_ENV, options: { key?: string | null; modules?: ReturnType<typeof createRegistry> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wirehub-module-settings-'));
  dirs.push(dir);
  const scenario = scenarioRegistry();
  const registry = options.modules ?? scenario.registry;
  const backend = memoryWriteBackend(registry);
  const deps: WorkbenchDeps = { ...backend.deps, events: memoryEventHub() };
  const path = join(dir, 'settings-secrets.json');
  const secrets: SecretStore = fileSecretStore(path);
  const key = options.key === undefined ? KEY : options.key;
  const settings = createRuntimeSettings({ env, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', ...(key === null ? {} : { cipher: settingsCipher(key) }), log: () => {} });
  settings.follow(deps.events);
  deps.runtimeSettings = settings;
  const sets: unknown[] = [];
  deps.afterCommit = (set) => void sets.push(set);
  return { deps, settings, secrets, path, sets, asked: scenario.asked };
}

const call = async (deps: WorkbenchDeps, method: string, path: string, body?: unknown, user = OWNER) =>
  (await handleWorkbenchRequest({ method, path, user, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };

describe('module settings on the file backend', () => {
  it('runs the module settings session', async () => {
    const h = hub();
    await h.settings.refresh();
    await runModuleSettingsScenario(
      {
        deps: h.deps,
        settings: h.settings,
        org: 'files',
        rows: () => h.secrets.all(),
        asked: h.asked,
        everywhere: async () => JSON.stringify([h.sets, await h.deps.exportCatalog!(), await h.deps.docs!.read('data/settings/modules.json')]),
      },
      async (check) => expect(await check()).toBe(true),
    );
    // the secrets file stays private to the server's user
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(h.path, 'utf8')).toContain('module.suppliers.mouserKey');
    expect(readFileSync(h.path, 'utf8')).not.toContain('mouser-key-entered-in-settings');
  });

  it('records each secret change as a change set of its own, with no request body', async () => {
    const h = hub();
    const set = await call(h.deps, 'PUT', '/api/settings/modules/keyed-probe/secrets/apiKey', { value: 'audit-me-not' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(h.sets).toHaveLength(1);
    const change = h.sets[0] as { context: { path: string; body?: unknown; user?: { name: string } } };
    expect(change.context).toMatchObject({ path: '/api/settings/modules/keyed-probe/secrets/apiKey', user: { name: OWNER.name } });
    expect(change.context.body).toBeUndefined();
    expect(JSON.stringify(h.sets)).not.toContain('audit-me-not');
    const doc = (await h.deps.docs!.read('data/settings/modules.json')) as { secrets: Record<string, string> };
    expect(Object.keys(doc.secrets)).toEqual(['keyed-probe.apiKey']);
    // an owner-only document: kept out of everyone else's export and the git mirror
    expect(isOwnerOnlySettingsPath('data/settings/modules.json')).toBe(true);
  });

  it('cannot keep a secret without a settings key, and the environment still sets it', async () => {
    const h = hub({ KEYED_PROBE_API_KEY: 'from-the-environment' }, { key: null });
    const refused = await call(h.deps, 'PUT', '/api/settings/modules/keyed-probe/secrets/region', { value: 'x' });
    expect(refused.status).toBe(404);
    // apiKey is pinned by the environment here; a module with an unpinned secret is refused for the missing key
    const solo = hub({}, { key: null, modules: createRegistry([keyed]) });
    const noKey = await call(solo.deps, 'PUT', '/api/settings/modules/keyed-probe/secrets/apiKey', { value: 'x' });
    expect(noKey.status).toBe(409);
    expect(noKey.body.error).toMatch(/no settings key/);
    expect((await call(h.deps, 'GET', '/api/modules/keyed-probe/probe')).body).toMatchObject({ apiKey: 'from-the-environment' });
    const shown = (await call(h.deps, 'GET', '/api/settings/runtime')).body.modules[0].fields[0];
    expect(shown).toMatchObject({ source: 'server', status: 'server', set: true });
    expect(JSON.stringify(shown)).not.toContain('from-the-environment');
  });

  it('rotates module secrets with every other secret', async () => {
    const h = hub();
    expect((await call(h.deps, 'PUT', '/api/settings/modules/keyed-probe/secrets/apiKey', { value: 'rotate-me' })).status).toBe(200);
    const next = 'n'.repeat(43);
    const report = await rotateSecrets(h.secrets, settingsCipher(next, [KEY]), 'files');
    expect(report.rotated).toEqual(['module.keyed-probe.apiKey']);
    expect(settingsCipher(next).decrypt('files', 'module.keyed-probe.apiKey', (await h.secrets.all())['module.keyed-probe.apiKey']!)).toBe('rotate-me');
  });

  it('answers only the asking module, only its declared keys, and an older module needs nothing', async () => {
    const legacy = defineModule({ id: 'legacy', label: 'Legacy', version: '1.0.0', integrations: [{ id: 'l', label: 'L', routes: [{ method: 'GET', path: 'ping', handle: async () => ({ status: 200, body: { ok: true } }) }] }] });
    const registry = createRegistry([keyed, legacy]);
    const h = hub({}, { modules: registry });
    expect((await call(h.deps, 'PUT', '/api/settings/modules/keyed-probe/secrets/apiKey', { value: 'only-mine' })).status).toBe(200);
    expect(await moduleSettingsFor('keyed-probe', () => registry, () => h.settings).get('apiKey')).toBe('only-mine');
    expect(await moduleSettingsFor('legacy', () => registry, () => h.settings).get('apiKey')).toBeUndefined();
    expect(await moduleSettingsFor('keyed-probe', () => registry, () => h.settings).get('module.keyed-probe.apiKey')).toBeUndefined();
    expect((await call(h.deps, 'GET', '/api/modules/legacy/ping')).body).toEqual({ ok: true });
    expect((await call(h.deps, 'GET', '/api/settings/runtime')).body.modules.map((m: { module: string }) => m.module)).toEqual(['keyed-probe']);
    expect((await call(h.deps, 'PUT', '/api/settings/modules/legacy', { values: {} })).status).toBe(404);
    // an editor reads the declaration only
    expect((await call(h.deps, 'GET', '/api/settings/runtime', undefined, EDITOR)).body.modules[0]).toMatchObject({ restricted: true });
  });
});
