/**
 * Runtime code modules on the file backend (`specs/runtime-modules.md`): the
 * shared session (`code-modules-scenario.ts`) over the real file stores on a
 * temporary copy of the starter catalog, the example installed at runtime
 * answering the module contract exactly as the built-in does, and Restart
 * WireHub's drain and exit code (simulated: the exit is a test function).
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveRegistry, createRegistry, type LiveModuleRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiRequest, WorkbenchDeps } from '../server/api.ts';
import type { CodeModuleHost } from '../server/code-modules/host.ts';
import { RESTART_EXIT_CODE, createSystemControl, inFlightCounter } from '../server/system.ts';
import type { CodeBackend, CodeModuleFixture } from './code-modules-scenario.ts';
import type { TestStore } from './store-fixture.ts';

// the live catalog is bound when @wirehub/catalog is first loaded: everything that loads it is imported below, after this
const starter = fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'wirehub-code-modules-'));
cpSync(starter, join(root, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(root, 'data');
process.env.WIREHUB_PACKS_DIR = join(root, 'packs');
const dirs = { data: join(root, 'data'), packs: join(root, 'packs') };
const roots: string[] = [root];
const scenario = await import('./code-modules-scenario.ts');
const { EDITOR, OWNER } = scenario;
const { STORE_URL, createTestStore } = await import('./store-fixture.ts');

async function fileBackend(store: TestStore, fixture: CodeModuleFixture): Promise<CodeBackend> {
  const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
  const { handleWorkbenchRequest } = await import('../server/api.ts');
  const { attachCodeModules } = await import('../server/code-modules/index.ts');
  const live: LiveModuleRegistry = createLiveRegistry(createRegistry([]));
  const deps: WorkbenchDeps = defaultWorkbenchDeps({ modules: live });
  deps.store = { indexes: [{ url: STORE_URL, publicKey: store.publicKey }], fetch: store.fetch };
  const cacheDir = join(dirs.data, '..', 'module-cache');
  const attach = (): { host: CodeModuleHost; stop: () => void } => attachCodeModules(deps, { builtins: [], live, files: { dataDir: dirs.data, packsDir: dirs.packs }, pollMs: 0, cacheDir, log: () => {} });
  let attached = attach();
  await attached.host.sync();
  attached.host.markBooted();
  return {
    deps,
    live,
    get host() {
      return attached.host;
    },
    restartedHost() {
      // a new process: the built-ins only, a new host over the same catalog
      attached.stop();
      live.replace(createRegistry([]));
      attached = attach();
      return attached.host;
    },
    store,
    fixture,
    send: (request: ApiRequest) => handleWorkbenchRequest(request, deps),
  };
}

describe('runtime code modules (files)', { timeout: 120_000 }, () => {
  let store: TestStore;
  let fixture: CodeModuleFixture;
  beforeAll(async () => {
    store = createTestStore();
    fixture = await scenario.buildExampleBundle(store);
  });
  afterAll(() => {
    fixture?.close();
    store?.close();
    delete process.env.WIREHUB_CATALOG_DIR;
    delete process.env.WIREHUB_PACKS_DIR;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('refuses a store pack with code whose publisher the index does not name', async () => {
    const own = createTestStore();
    try {
      const backend = await fileBackend(own, await scenario.buildExampleBundle(own));
      await scenario.unlistedPublisherRefused(backend);
      expect(backend.live.module('example')).toBeUndefined();
    } finally {
      own.close();
    }
  });

  it('refuses what it must, installs by upload and from a store, and runs the module without a restart', async () => {
    const backend = await fileBackend(store, fixture);
    await scenario.codeModuleScenario(backend);
    // the code lives in the pack's layer, in the packs volume
    expect(existsSync(join(dirs.packs, 'example', 'code', 'example', 'server.mjs'))).toBe(true);
  });
});

describe('Restart WireHub', () => {
  it('drains in order and exits with the restart code', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    let exitCode: number | undefined;
    const inFlight = inFlightCounter();
    const leave = inFlight.enter();
    const control = createSystemControl({
      bootId: 'boot-1',
      supervised: true,
      log: (line) => lines.push(line),
      exit: (code) => {
        exitCode = code;
      },
      steps: () => [
        { name: 'stop accepting', run: async () => seen.push('stop') },
        { name: 'finish in-flight', run: async () => inFlight.idle().then(() => seen.push('idle')) },
        { name: 'a step that fails', run: async () => Promise.reject(new Error('pool already closed')) },
        { name: 'close pools', run: async () => seen.push('pools') },
      ],
    });
    const draining = control.drain('Ow');
    expect(control.restarting()).toBe(true);
    await new Promise((done) => setTimeout(done, 20));
    // a request still in flight holds the drain back
    expect(seen).toEqual(['stop']);
    leave();
    await draining;
    expect(seen).toEqual(['stop', 'idle', 'pools']);
    expect(exitCode).toBe(RESTART_EXIT_CODE);
    expect(RESTART_EXIT_CODE).toBe(75);
    expect(lines.at(-1)).toBe('[restart] requested by Ow: exiting with code 75 (restart requested, not a crash)');
    expect(lines).toContain('[restart] a step that fails: pool already closed');
  });

  it('is an owner\'s action, answered before the drain, and the app refuses new work while it drains', async () => {
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { createStandaloneApp } = await import('../server/standalone-app.ts');
    let exitCode: number | undefined;
    const control = createSystemControl({ bootId: 'boot-2', supervised: true, delayMs: 5, log: () => {}, exit: (code) => (exitCode = code), steps: () => [] });
    const deps: WorkbenchDeps = { designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined }, loadDb: () => ({ connectors: [], wires: [], components: [], pcbas: [] }), system: control };
    expect(await handleWorkbenchRequest({ method: 'GET', path: '/api/system/boot', user: EDITOR }, deps)).toMatchObject({ status: 200, body: { bootId: 'boot-2', restarting: false, supervised: true } });
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/system/restart', user: EDITOR }, deps)).status).toBe(403);
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/system/restart', user: { ...OWNER, apiTokenId: 't1' } }, deps)).status).toBe(403);
    const answer = await handleWorkbenchRequest({ method: 'POST', path: '/api/system/restart', user: OWNER }, deps);
    expect(answer).toMatchObject({ status: 202, body: { restarting: true, bootId: 'boot-2', poll: '/api/system/boot' } });
    expect(exitCode).toBeUndefined();
    const dist = mkdtempSync(join(tmpdir(), 'wirehub-dist-'));
    roots.push(dist);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    const app = createStandaloneApp({ distDir: dist, deps, restarting: () => control.restarting() });
    const refused = await app.request('/api/designs');
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { state: string }).state).toBe('restarting');
    expect((await app.request('/api/system/boot')).status).toBe(200);
    await new Promise((done) => setTimeout(done, 30));
    expect(exitCode).toBe(RESTART_EXIT_CODE);
  });
});
