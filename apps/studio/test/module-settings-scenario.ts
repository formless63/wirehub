/**
 * Module settings (cs-nws, module API 1.5; `server/module-settings.ts`): one scripted session
 * run on every backend (`module-settings.server.test.ts` on files, `pg/module-settings.server.test.ts`
 * on Postgres). A synthetic module and the suppliers module declare settings; an owner enters
 * them in Settings; they are encrypted at rest, never answered back, locked when the server's
 * environment sets them, refused to everyone but an owner in a signed-in session, and read by
 * the module's route and job through the module API — a change seen by the next lookup.
 * Suppliers reads a key entered in Settings against a stubbed provider (no network).
 */

import { createRegistry, defineModule, type ModuleRegistry } from '@wirehub/modules';
import { expect } from 'vitest';

import { suppliers } from '../../../modules/suppliers/src/index.ts';
import { createSupplierIntegration } from '../../../modules/suppliers/src/server.ts';
import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { moduleJobHandlers } from '../server/jobs/module-queues.ts';
import type { JobKind, JobRun } from '../server/jobs/types.ts';
import type { StudioUser } from '../server/me.ts';
import type { RuntimeSettings } from '../server/runtime-settings.ts';
import { settingsCipher } from '../server/settings-secrets.ts';

export const KEY = 'module-settings-test-only-key-0123456789abcdef';
export const OWNER: StudioUser = { name: 'Olive Owner', email: 'olive@example.com', source: 'session', role: 'owner' };
export const EDITOR: StudioUser = { name: 'Ed Editor', email: 'ed@example.com', source: 'session', role: 'editor' };
export const VIEWER: StudioUser = { name: 'Vi Viewer', email: 'vi@example.com', source: 'session', role: 'viewer' };
export const TOKEN: StudioUser = { ...OWNER, apiTokenId: 'tok-1', apiTokenScopes: ['read', 'catalog:write'] };

/** The server environment of the scenario: one supplier credential pinned by the deployment. */
export const SERVER_ENV = { WIREHUB_SUPPLIERS_LCSC_KEY: 'env-lcsc-key-from-the-deployment' };

/** A synthetic module whose route and job hand back what its settings say. */
export const keyed = defineModule({
  id: 'keyed-probe',
  label: 'Keyed probe',
  version: '1.0.0',
  settings: [
    { key: 'apiKey', label: 'API key', help: 'The probe’s account key.', required: true, gates: 'lookups', env: 'KEYED_PROBE_API_KEY' },
    { key: 'region', label: 'Region', kind: 'text' },
    { key: 'verbose', label: 'Verbose', kind: 'bool' },
  ],
  integrations: [
    {
      id: 'probe',
      label: 'Probe',
      routes: [
        { method: 'GET', path: 'probe', handle: async (request) => ({ status: 200, body: { apiKey: (await request.settings?.get('apiKey')) ?? null, region: (await request.settings?.get('region')) ?? null, verbose: (await request.settings?.get('verbose')) ?? null, undeclared: (await request.settings?.get('other')) ?? null } }) },
      ],
      queues: [{ id: 'use', label: 'Use the key', run: async (context) => ({ apiKey: (await context.settings?.get('apiKey')) ?? null }) }],
    },
  ],
});

const PART = { MouserPartNumber: 'SKU-1', ManufacturerPartNumber: 'SYN-1/A', Manufacturer: 'Synthetic', Description: 'Synthetic component', AvailabilityInStock: '12', PriceBreaks: [{ Quantity: 1, Price: '$1.25', Currency: 'USD' }] };

/** Suppliers as built, with its provider HTTP answered by a stub that records what it was asked. */
export function stubbedSuppliers(): { module: typeof suppliers; asked: string[] } {
  const asked: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return Response.json({ SearchResults: { Parts: [PART] }, Errors: [] });
  }) as typeof globalThis.fetch;
  const integration = createSupplierIntegration({ fetch, now: () => new Date('2026-01-02T03:04:05Z') });
  return { module: defineModule({ ...suppliers, integrations: [integration] }), asked };
}

export function scenarioRegistry(): { registry: ModuleRegistry; asked: string[] } {
  const stub = stubbedSuppliers();
  return { registry: createRegistry([keyed, stub.module]), asked: stub.asked };
}

export interface ScenarioHub {
  deps: WorkbenchDeps;
  settings: RuntimeSettings;
  /** what the organisation is bound to in the ciphertext's additional data */
  org: string;
  /** the secret store's rows: name → ciphertext */
  rows(): Promise<Record<string, string>>;
  /** every catalog document, change and history text of the hub, to search for a leaked value */
  everywhere(): Promise<string>;
  /** the stubbed provider's requests */
  asked: string[];
  /** another process over the same data, when the backend has one (Postgres): its settings follow the notification */
  other?: { deps: WorkbenchDeps; settings: RuntimeSettings };
}

type Answer = { status: number; body: any; headers?: Record<string, string> };

export async function runModuleSettingsScenario(hub: ScenarioHub, until: (check: () => boolean | Promise<boolean>) => Promise<void>): Promise<void> {
  const { deps } = hub;
  const call = async (method: string, path: string, body?: unknown, user: StudioUser = OWNER, headers: Record<string, string> = {}, on: WorkbenchDeps = deps): Promise<Answer> =>
    (await handleWorkbenchRequest({ method, path, user, headers, ...(body === undefined ? {} : { body }) }, on)) as Answer;
  const sections = async (user: StudioUser = OWNER): Promise<any[]> => {
    const got = await call('GET', '/api/settings/runtime', undefined, user);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return got.body.modules;
  };
  const field = async (module: string, key: string, user: StudioUser = OWNER) => (await sections(user)).find((s) => s.module === module).fields.find((f: any) => f.key === key);
  const probe = async (on: WorkbenchDeps = deps) => (await call('GET', '/api/modules/keyed-probe/probe', undefined, OWNER, {}, on)).body;
  const runJob = async (kind: string, request: Record<string, unknown>, on: WorkbenchDeps = deps) => {
    const handler = moduleJobHandlers(on.modules, on)[kind as JobKind];
    expect(handler, kind).toBeDefined();
    const job = { id: `job-${kind}`, kind, status: 'running', request, steps: [] } as unknown as JobRun;
    return (await handler!({ job, step: async () => {} })).result as Record<string, unknown>;
  };
  const putSecret = (module: string, key: string, value: string, user: StudioUser = OWNER) => call('PUT', `/api/settings/modules/${module}/secrets/${key}`, { value }, user);
  const etag = async () => (await sections()).find((s) => s.module === 'keyed-probe').etag as string;

  // ---- declaration: every module with settings has a section; the env-pinned one is locked
  const listed = await sections();
  expect(listed.map((s) => s.module)).toEqual(['keyed-probe', 'suppliers']);
  expect(await field('keyed-probe', 'apiKey')).toMatchObject({ label: 'API key', kind: 'secret', secret: true, required: true, gates: 'lookups', env: 'KEYED_PROBE_API_KEY', source: 'default', status: 'missing', set: false });
  expect(await field('keyed-probe', 'region')).toMatchObject({ kind: 'text', status: 'unset' });
  expect(await field('suppliers', 'providers')).toMatchObject({ kind: 'list', options: ['mouser', 'digikey', 'lcsc'], env: 'WIREHUB_SUPPLIERS_PROVIDERS', status: 'unset' });
  expect(await field('suppliers', 'lcscKey')).toMatchObject({ source: 'server', status: 'server', set: true, env: 'WIREHUB_SUPPLIERS_LCSC_KEY' });
  expect(JSON.stringify(listed)).not.toContain(SERVER_ENV.WIREHUB_SUPPLIERS_LCSC_KEY);
  expect(await probe()).toEqual({ apiKey: null, region: null, verbose: null, undeclared: null });

  // ---- permissions: owners in a signed-in session only; others see the declaration, not its state
  const restricted = (await sections(EDITOR)).find((s) => s.module === 'keyed-probe');
  expect(restricted).toMatchObject({ restricted: true, editable: false });
  expect(restricted.fields[0]).not.toHaveProperty('status');
  expect(restricted.fields[0]).not.toHaveProperty('set');
  for (const user of [EDITOR, VIEWER, TOKEN]) {
    expect((await putSecret('keyed-probe', 'apiKey', 'nope-not-saved', user)).status, user.name).toBe(403);
    expect((await call('DELETE', '/api/settings/modules/keyed-probe/secrets/apiKey', undefined, user)).status).toBe(403);
    expect((await call('PUT', '/api/settings/modules/keyed-probe', { values: { region: 'x' } }, user, { 'if-match': await etag() })).status).toBe(403);
  }
  expect((await hub.rows())['module.keyed-probe.apiKey']).toBeUndefined();

  // ---- the routes refuse what is not a declared secret, and never read one back
  expect((await putSecret('nobody', 'apiKey', 'x')).status).toBe(404);
  expect((await putSecret('keyed-probe', 'nope', 'x')).status).toBe(404);
  expect((await putSecret('keyed-probe', 'region', 'x')).status).toBe(404);
  expect((await call('GET', '/api/settings/modules/keyed-probe/secrets/apiKey')).status).toBe(405);
  expect((await putSecret('keyed-probe', 'apiKey', 'line\u0007bell')).status).toBe(400);

  // ---- an owner sets it: encrypted at rest, bound to the organisation and the name
  const first = 'probe-key-first-0f-two';
  const set = await putSecret('keyed-probe', 'apiKey', first);
  expect(set, JSON.stringify(set.body)).toMatchObject({ status: 200, body: { module: 'keyed-probe', key: 'apiKey', set: true } });
  const rows = await hub.rows();
  const sealed = rows['module.keyed-probe.apiKey'] as string;
  expect(sealed).toMatch(/^v1\./);
  expect(sealed).not.toContain(first);
  expect(settingsCipher(KEY).decrypt(hub.org, 'module.keyed-probe.apiKey', sealed)).toBe(first);
  expect(settingsCipher(KEY).decrypt(hub.org, 'module.keyed-probe.region', sealed)).toBeUndefined();
  expect(settingsCipher(KEY).decrypt(`${hub.org}-other`, 'module.keyed-probe.apiKey', sealed)).toBeUndefined();

  // ---- never back to a client: the section says configured, and when
  const shown = await field('keyed-probe', 'apiKey');
  expect(shown).toMatchObject({ source: 'settings', status: 'configured', set: true, setAt: expect.any(String) });
  expect(shown).not.toHaveProperty('value');
  expect(JSON.stringify((await call('GET', '/api/settings/runtime')).body)).not.toContain(first);
  expect(JSON.stringify((await call('GET', '/api/settings/runtime', undefined, EDITOR)).body)).not.toContain(first);

  // ---- the module reads it through the module API: its route, and its job
  expect(await probe()).toMatchObject({ apiKey: first, undeclared: null });
  expect(await runJob('keyed-probe:use', {})).toEqual({ apiKey: first });

  // ---- a change applies without a restart: the next lookup sees the new key (in another process too)
  const second = 'probe-key-second-0f-two';
  expect((await putSecret('keyed-probe', 'apiKey', second)).status).toBe(200);
  expect(await probe()).toMatchObject({ apiKey: second });
  if (hub.other !== undefined) {
    const other = hub.other;
    await until(async () => (await probe(other.deps)).apiKey === second);
    expect(await runJob('keyed-probe:use', {}, other.deps)).toEqual({ apiKey: second });
  }

  // ---- non-secret values: If-Match, checked against the declaration, applied at once
  expect((await call('PUT', '/api/settings/modules/keyed-probe', { values: { region: 'eu' } })).status).toBe(428);
  expect((await call('PUT', '/api/settings/modules/keyed-probe', { values: { apiKey: 'x' } }, OWNER, { 'if-match': await etag() })).status).toBe(400);
  expect((await call('PUT', '/api/settings/modules/keyed-probe', { values: { verbose: 'yes' } }, OWNER, { 'if-match': await etag() })).status).toBe(400);
  const saved = await call('PUT', '/api/settings/modules/keyed-probe', { values: { region: 'eu-west', verbose: true } }, OWNER, { 'if-match': await etag() });
  expect(saved, JSON.stringify(saved.body)).toMatchObject({ status: 200, body: { values: { region: 'eu-west', verbose: true } } });
  expect(await probe()).toMatchObject({ region: 'eu-west', verbose: 'true' });
  expect(await field('keyed-probe', 'region')).toMatchObject({ source: 'settings', value: 'eu-west', status: 'configured' });

  // ---- the environment wins and is locked
  expect((await putSecret('suppliers', 'lcscKey', 'try-to-replace')).status).toBe(409);
  expect((await call('DELETE', '/api/settings/modules/suppliers/secrets/lcscKey')).status).toBe(409);

  // ---- suppliers: providers enabled and the Mouser key entered here; the lookup uses that key
  const supplierKey = 'mouser-key-entered-in-settings';
  expect((await call('PUT', '/api/settings/modules/suppliers', { values: { providers: ['mouser', 'nobody'] } }, OWNER, { 'if-match': await etag() })).status).toBe(400);
  expect((await call('PUT', '/api/settings/modules/suppliers', { values: { providers: ['mouser'] } }, OWNER, { 'if-match': await etag() })).status).toBe(200);
  // the other module's values are kept
  expect(await field('keyed-probe', 'region')).toMatchObject({ value: 'eu-west' });
  const config = async () => (await call('GET', '/api/modules/suppliers/config')).body.providers as { id: string; enabled: boolean; configured: boolean }[];
  expect((await config())[0]).toMatchObject({ id: 'mouser', enabled: true, configured: false });
  expect((await config())[2]).toMatchObject({ id: 'lcsc', enabled: false, configured: false });
  expect((await putSecret('suppliers', 'mouserKey', supplierKey)).status).toBe(200);
  expect((await config())[0]).toMatchObject({ id: 'mouser', enabled: true, configured: true });
  const lookup = { provider: 'mouser', query: 'SYN-1/A', match: 'mpn', quantity: 10, currency: 'USD', country: 'US' };
  const result = await runJob('suppliers:lookup', lookup);
  expect(result).toMatchObject({ offers: [{ provider: 'mouser', supplierNumber: 'SKU-1', breaks: [{ minQty: 1, unitPrice: 1.25 }] }] });
  expect(hub.asked).toHaveLength(1);
  expect(new URL(hub.asked[0] as string).searchParams.get('apiKey')).toBe(supplierKey);
  expect(JSON.stringify(result)).not.toContain(supplierKey);

  // ---- clear: gone from the store, the module sees nothing, the section says missing again
  expect((await call('DELETE', '/api/settings/modules/keyed-probe/secrets/apiKey')).body).toEqual({ module: 'keyed-probe', key: 'apiKey', set: false });
  expect((await hub.rows())['module.keyed-probe.apiKey']).toBeUndefined();
  expect(await probe()).toMatchObject({ apiKey: null });
  expect(await field('keyed-probe', 'apiKey')).toMatchObject({ status: 'missing', set: false });

  // ---- recorded, never revealed: the document and the history say when, never what
  const text = await hub.everywhere();
  expect(text).toContain('keyed-probe.apiKey');
  for (const secret of [first, second, supplierKey, SERVER_ENV.WIREHUB_SUPPLIERS_LCSC_KEY]) expect(text).not.toContain(secret);
  for (const ciphertext of Object.values(rows)) expect(text).not.toContain(ciphertext);
}
