/**
 * Runtime code modules (`specs/runtime-modules.md`), one session for both
 * backends (`code-modules.server.test.ts`, `pg/code-modules.server.test.ts`):
 * the example module (`modules/example`) built by `wirehub-module build` into a
 * signed bundle, refused every way it should be (unsigned, untrusted, an editor,
 * an incompatible API, the kill switch, no consent, a module that throws), then
 * installed by upload with a pinned key and used without a restart (its route,
 * rule, exporter and panel), turned off and on, updated, removed, and installed
 * from a signed test store. Keys are generated per run (`store-fixture.ts`).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packDigests, signPackManifest } from '@wirehub/catalog';
import type { LiveModuleRegistry, PanelContribution } from '@wirehub/modules';
import { expect } from 'vitest';

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../server/api.ts';
import type { CodeModuleHost } from '../server/code-modules/host.ts';
import type { StudioUser } from '../server/me.ts';
import { isPackFilePath } from '../server/pack-archive.ts';
import { buildModule, type BuildResult } from '../scripts/wirehub-module.ts';
import { zipFiles } from './pack-bundle-flow.ts';
import { STORE_URL, type TestStore } from './store-fixture.ts';

export const OWNER: StudioUser = { name: 'Ow', email: 'ow@example.invalid', source: 'session', role: 'owner' };
export const EDITOR: StudioUser = { name: 'Ed', email: 'ed@example.invalid', source: 'session', role: 'editor' };

type Files = Map<string, Uint8Array>;

export interface CodeModuleFixture {
  built: BuildResult;
  /** the bundle as built (signed by the store's test publisher `tester`) */
  zip: Uint8Array;
  /** a copy of the built pack with `change` applied to its files and manifest, signed again unless `sign: false` */
  variant: (change: (files: Files, manifest: Record<string, any>) => void, options?: { sign?: boolean; key?: string }) => Uint8Array;
  close: () => void;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array | undefined): string => (bytes === undefined ? '' : new TextDecoder().decode(bytes));

function filesOf(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesOf(dir, path));
    else out.push(path);
  }
  return out.sort();
}

/** Build the example once, signed by the test store's publisher key. */
export async function buildExampleBundle(store: TestStore): Promise<CodeModuleFixture> {
  const out = mkdtempSync(join(tmpdir(), 'wirehub-code-module-'));
  const publisherPem = readFileSync(store.publisherKeyFile, 'utf8');
  const built = await buildModule({ moduleDir: join(process.cwd(), '../../modules/example'), out, keys: [publisherPem], publisher: { id: 'tester', name: 'Test publisher' }, log: () => {} });
  const read = (): { files: Files; manifest: Record<string, any> } => {
    const files: Files = new Map();
    for (const path of filesOf(built.dir)) if (path !== 'wirehub-pack.json' && path !== 'wirehub-pack.sig') files.set(path, new Uint8Array(readFileSync(join(built.dir, path))));
    return { files, manifest: JSON.parse(readFileSync(join(built.dir, 'wirehub-pack.json'), 'utf8')) };
  };
  const pack = (files: Files, manifest: Record<string, any>, signature: string | undefined): Uint8Array =>
    zipFiles({
      'wirehub-pack.json': `${JSON.stringify(manifest, null, 2)}\n`,
      ...Object.fromEntries(files),
      ...(signature === undefined ? {} : { 'wirehub-pack.sig': signature }),
    });
  const original = read();
  const zip = pack(original.files, original.manifest, readFileSync(join(built.dir, 'wirehub-pack.sig'), 'utf8'));
  return {
    built,
    zip,
    variant(change, options = {}) {
      const { files, manifest } = read();
      change(files, manifest);
      if (options.sign === false) {
        delete manifest.files;
        return pack(files, manifest, undefined);
      }
      const pinned = new Map([...files].filter(([path]) => isPackFilePath(path)));
      const signed = { ...manifest, files: packDigests(pinned) };
      return pack(files, signed, signPackManifest(signed, [options.key ?? publisherPem]));
    },
    close: () => rmSync(out, { recursive: true, force: true }),
  };
}

/** Rewrite the module's code (server and browser entries) and its versions. */
export function bump(files: Files, manifest: Record<string, any>, version: string, edit: (code: string) => string = (c) => c): void {
  manifest.version = version;
  manifest.module.version = version;
  for (const path of ['code/example/server.mjs', 'code/example/browser.mjs']) {
    const code = text(files.get(path)).replaceAll('version: "0.1.0"', `version: ${JSON.stringify(version)}`);
    files.set(path, new TextEncoder().encode(edit(code)));
  }
}

export interface CodeBackend {
  deps: WorkbenchDeps;
  live: LiveModuleRegistry;
  host: CodeModuleHost;
  /** a fresh host over the same deps and registry, as a restarted process would build it */
  restartedHost: () => CodeModuleHost;
  store: TestStore;
  fixture: CodeModuleFixture;
  send: (request: ApiRequest) => Promise<ApiResponse>;
}

/** The whole session; returns what it saw, for the backends to compare. */
export async function codeModuleScenario(backend: CodeBackend): Promise<string[]> {
  const log: string[] = [];
  const call = async (label: string, method: string, path: string, body?: unknown, user: StudioUser = OWNER): Promise<{ status: number; body: any; bytes?: Uint8Array; contentType?: string }> => {
    const answer = await backend.send({ method, path, ...(body === undefined ? {} : { body }), user });
    log.push(`${label}: ${answer.status}`);
    return answer as { status: number; body: any; bytes?: Uint8Array; contentType?: string };
  };
  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
  const { fixture, store, live } = backend;
  const trustKey = store.publisherPublicKey;
  const consent = { code: 'example@0.1.0' };

  expect((await call('nothing installed', 'GET', '/api/code-modules')).body).toMatchObject({ apiVersion: '1.2', allowed: { env: true, settings: true, effective: true }, modules: [] });

  // refused, nothing written: unsigned, untrusted, the wrong key, an editor, an API this hub does not run
  const unsigned = await call('unsigned', 'POST', '/api/packs/install', { zip: b64(fixture.variant(() => {}, { sign: false })), trustKey });
  expect(unsigned.status, JSON.stringify(unsigned.body)).toBe(422);
  expect(unsigned.body.error).toMatch(/not signed/);
  const untrusted = await call('untrusted', 'POST', '/api/packs/install', { zip: b64(fixture.zip) });
  expect(untrusted.status).toBe(422);
  expect(untrusted.body.error).toMatch(/trusts no publisher key/);
  const wrongKey = await call('wrong key', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey: store.otherPublicKey });
  expect(wrongKey.status).toBe(422);
  expect(wrongKey.body.error).toMatch(/not signed by a key this hub trusts/);
  const byEditor = await call('editor', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey }, EDITOR);
  expect(byEditor.status).toBe(403);
  expect(byEditor.body.error).toMatch(/Only an owner/);
  const future = await call('api 2.0', 'POST', '/api/packs/install', { zip: b64(fixture.variant((_f, m) => (m.module.apiVersion = '2.0'))), trustKey });
  expect(future.status).toBe(422);
  expect(future.body.error).toMatch(/module API 2\.0/);
  const newer = await call('api 1.9', 'POST', '/api/packs/install', { zip: b64(fixture.variant((_f, m) => (m.module.apiVersion = '1.9'))), trustKey });
  expect(newer.status).toBe(422);
  expect(newer.body.error).toMatch(/newer than this hub's 1\.2/);
  // a module that does more than it declared
  const sneaky = await call('undeclared point', 'POST', '/api/packs/install', { zip: b64(fixture.variant((_f, m) => (m.module.extensionPoints = m.module.extensionPoints.filter((p: string) => p !== 'routes')))), trustKey, apply: true, consent });
  expect(sneaky.status).toBe(409);
  expect(sneaky.body.error).toMatch(/does not load.*'routes', which its manifest does not declare/);

  // the preview: what the module may do, and the consent it needs
  const preview = await call('preview', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.code).toMatchObject({ module: { id: 'example', version: '0.1.0', apiVersion: '1.2' }, apply: 'restart', consent: 'example@0.1.0', trust: { via: 'pinned', keys: [{ key: trustKey }] } });
  expect(preview.body.code.permissions).toEqual(['server-code', 'browser-code', 'routes', 'writes', 'jobs', 'sign-in']);
  expect(preview.body.code.warning).toMatch(/runs code in your hub/);
  const noConsent = await call('no consent', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey, apply: true });
  expect(noConsent.status).toBe(409);
  expect(noConsent.body.error).toMatch(/needs your consent/);

  // the kill switch: in Settings, and in the server's environment
  expect((await call('switch off', 'PUT', '/api/code-modules/settings', { allow: false })).status).toBe(200);
  expect((await call('install while off', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey, apply: true, consent })).status).toBe(403);
  expect((await call('editor cannot switch', 'PUT', '/api/code-modules/settings', { allow: true }, EDITOR)).status).toBe(403);
  expect((await call('switch on', 'PUT', '/api/code-modules/settings', { allow: true })).status).toBe(200);
  process.env.WIREHUB_ALLOW_CODE_MODULES = 'false';
  try {
    const off = await call('install while the server forbids', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey, apply: true, consent });
    expect(off.status).toBe(403);
    expect(off.body.error).toMatch(/WIREHUB_ALLOW_CODE_MODULES=false/);
  } finally {
    delete process.env.WIREHUB_ALLOW_CODE_MODULES;
  }
  expect(live.module('example')).toBeUndefined();

  // installed by upload, with the owner's consent and the key pinned: it runs at once
  const installed = await call('install', 'POST', '/api/packs/install', { zip: b64(fixture.zip), trustKey, apply: true, consent });
  expect(installed.status, JSON.stringify(installed.body)).toBe(200);
  expect(installed.body).toMatchObject({ installed: true, id: 'example', moduleStatus: { id: 'example', state: 'loaded', enabled: true, trust: { via: 'pinned' } } });
  expect(live.module('example')?.version).toBe('0.1.0');
  const listed = (await call('listed', 'GET', '/api/code-modules')).body;
  expect(listed.keys.map((k: { key: string }) => k.key)).toEqual([trustKey]);
  expect(listed.modules[0]).toMatchObject({ id: 'example', state: 'loaded', apply: 'restart', restartPoints: ['queues'], pack: { id: 'example', version: '0.1.0' } });

  // its route, rule, exporter and panel, without a restart
  expect((await call('route', 'GET', '/api/modules/example/status')).body).toEqual({ module: 'example', ok: true });
  const design = await call('read design', 'GET', '/api/designs/de9-crossover');
  const etag = (design as { headers?: Record<string, string> }).headers?.['ETag'] ?? '';
  const refused = await backend.send({ method: 'PUT', path: '/api/designs/de9-crossover', body: { ...design.body, label: 'TODO name this' }, headers: { 'if-match': etag }, user: OWNER });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.body)).toContain('example/todo-label');
  const exported = await call('exporter', 'GET', '/api/modules/example/_export/joints-csv?design=de9-crossover');
  expect(exported.status).toBe(200);
  expect(text(exported.bytes)).toMatch(/^a,b,note\n/);
  expect(live.panels('cable-inspector').map((p: PanelContribution & { module: string }) => `${p.module}/${p.id}`)).toEqual(['example/inspector']);
  // …and its browser entry, content-addressed with its integrity
  const browser = (await call('browser list', 'GET', '/api/code-modules/browser')).body;
  expect(browser.modules).toHaveLength(1);
  const entry = browser.modules[0];
  expect(entry).toMatchObject({ id: 'example', version: '0.1.0', commitHook: true });
  const file = await call('browser file', 'GET', entry.js.url);
  expect(file.status).toBe(200);
  expect(file.contentType).toMatch(/javascript/);
  expect(`sha256-${createHash('sha256').update(file.bytes as Uint8Array).digest('base64')}`).toBe(entry.js.integrity);
  expect((await call('unknown file', 'GET', `/api/code-modules/files/${'0'.repeat(64)}.mjs`)).status).toBe(404);

  // off and on again (owners only), live
  expect((await call('editor cannot disable', 'POST', '/api/code-modules/example/disable', undefined, EDITOR)).status).toBe(403);
  const disabled = await call('disable', 'POST', '/api/code-modules/example/disable');
  expect(disabled.body).toMatchObject({ changed: true, module: { state: 'disabled', enabled: false } });
  expect((await call('route gone', 'GET', '/api/modules/example/status')).status).toBe(404);
  expect(live.module('example')).toBeUndefined();
  expect((await call('enable', 'POST', '/api/code-modules/example/enable')).body).toMatchObject({ module: { state: 'loaded' } });
  expect((await call('route back', 'GET', '/api/modules/example/status')).status).toBe(200);

  // a module that throws at load: never enabled by a click, and quarantined at the next start without taking the hub down
  (globalThis as { __wirehubExampleBoom?: boolean }).__wirehubExampleBoom = false;
  const fragile = fixture.variant((files, manifest) => bump(files, manifest, '0.1.1', (code) => `if (globalThis.__wirehubExampleBoom === true) throw new Error('boom at load');\n${code}`));
  const updated = await call('update', 'POST', '/api/packs/install', { zip: b64(fragile), apply: true, consent: { code: 'example@0.1.1' } });
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  expect(updated.body).toMatchObject({ kind: 'update', moduleStatus: { version: '0.1.1', state: 'loaded' } });
  expect(live.module('example')?.version).toBe('0.1.1');
  (globalThis as { __wirehubExampleBoom?: boolean }).__wirehubExampleBoom = true;
  try {
    await call('disable fragile', 'POST', '/api/code-modules/example/disable');
    const again = await call('enable a module that throws', 'POST', '/api/code-modules/example/enable');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/boom at load/);
    expect(live.module('example')).toBeUndefined();
    // enabled in the settings (as after an earlier start), it fails at the next start: quarantined, the hub answers
    (globalThis as { __wirehubExampleBoom?: boolean }).__wirehubExampleBoom = false;
    expect((await call('enable fragile', 'POST', '/api/code-modules/example/enable')).status).toBe(200);
    (globalThis as { __wirehubExampleBoom?: boolean }).__wirehubExampleBoom = true;
    const restarted = backend.restartedHost();
    await restarted.sync();
    const failed = restarted.status().find((s) => s.id === 'example');
    expect(failed).toMatchObject({ state: 'failed', enabled: true });
    expect(failed?.error).toMatch(/threw while loading: boom at load/);
    expect(live.module('example')).toBeUndefined();
    expect((await call('the hub still answers', 'GET', '/api/designs/de9-crossover')).status).toBe(200);
    expect((await call('its route is gone', 'GET', '/api/modules/example/status')).status).toBe(404);
  } finally {
    (globalThis as { __wirehubExampleBoom?: boolean }).__wirehubExampleBoom = false;
  }
  // a fixed version, installed over it, loads again
  const fixed = fixture.variant((files, manifest) => bump(files, manifest, '0.1.2'));
  const repaired = await call('update to a fixed version', 'POST', '/api/packs/install', { zip: b64(fixed), apply: true, consent: { code: 'example@0.1.2' } });
  expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
  expect(live.module('example')?.version).toBe('0.1.2');
  expect((await call('route after the fix', 'GET', '/api/modules/example/status')).status).toBe(200);

  // removed with its pack (owners only): its code goes with it
  expect((await call('editor cannot remove', 'DELETE', '/api/packs/example', undefined, EDITOR)).status).toBe(403);
  const removed = await call('remove', 'DELETE', '/api/packs/example');
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(removed.body.module).toEqual({ id: 'example', removed: true });
  expect(live.module('example')).toBeUndefined();
  expect((await call('nothing listed', 'GET', '/api/code-modules')).body.modules).toEqual([]);

  // from a signed store: the index lists the publisher, whose key signed it
  store.cli('bundle', fixture.built.dir, '--out', store.site);
  store.meta('publisher', '--id', 'tester', '--name', 'Test publisher', '--pubkey', store.publisherPublicKey);
  const fromStore = await call('store install', 'POST', '/api/packs/store/install', { index: STORE_URL, id: 'example', apply: true, consent });
  expect(fromStore.status, JSON.stringify(fromStore.body)).toBe(200);
  expect(fromStore.body).toMatchObject({ installed: true, moduleStatus: { state: 'loaded', trust: { via: 'store', keys: [store.publisherPublicKey] } } });
  expect((await call('route from the store', 'GET', '/api/modules/example/status')).status).toBe(200);
  const record = (await backend.deps.installedPacks!()).packs.find((p) => p.id === 'example');
  expect(record?.module?.files.server).toBe(sha(new Uint8Array(readFileSync(join(fixture.built.dir, 'code/example/server.mjs')))));
  expect(record?.origin).toMatchObject({ index: STORE_URL, publisher: 'tester' });
  return log;
}

/** A store that does not name the publisher of a pack with code: refused, whatever its index signature. */
export async function unlistedPublisherRefused(backend: CodeBackend): Promise<void> {
  backend.store.cli('bundle', backend.fixture.built.dir, '--out', backend.store.site);
  backend.store.meta('review', 'example@0.1.0', '--status', 'unreviewed');
  const answer = await backend.send({ method: 'POST', path: '/api/packs/store/install', body: { index: STORE_URL, id: 'example', apply: true, consent: { code: 'example@0.1.0' } }, user: OWNER });
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect((answer.body as { error: string }).error).toMatch(/the store does not name its publisher's key/);
}
