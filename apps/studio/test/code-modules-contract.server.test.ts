/**
 * The example module installed at runtime answers the module contract
 * (`storage-contract/modules.ts`) exactly as the built-in example does: the
 * session on the file backend, the example installed as a signed bundle by
 * upload, compared step by step with the in-memory commit tree running the
 * built-in (which `modules-files.server.test.ts` holds equal to the file
 * backend). Its own file: the file stores bind the catalog directory when first
 * imported.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveRegistry, createRegistry } from '@wirehub/modules';
import { afterAll, describe, expect, it } from 'vitest';

// the live catalog is bound when @wirehub/catalog is first loaded: everything that loads it is imported after this
const work = mkdtempSync(join(tmpdir(), 'wirehub-code-contract-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
process.env.WIREHUB_PACKS_DIR = join(work, 'packs');
const { OWNER, buildExampleBundle } = await import('./code-modules-scenario.ts');
const { createTestStore } = await import('./store-fixture.ts');
const store = createTestStore();
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  store.close();
  rmSync(work, { recursive: true, force: true });
});

describe('the example installed at runtime', () => {
  it('answers every step of the module contract as the built-in example does', async () => {
    const fixture = await buildExampleBundle(store);
    try {
      const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
      const { handleWorkbenchRequest } = await import('../server/api.ts');
      const { attachCodeModules } = await import('../server/code-modules/index.ts');
      const { memoryWriteBackend } = await import('./storage-contract/writes.ts');
      const { exampleRegistry, moduleScenario } = await import('./storage-contract/modules.ts');
      const builtIn = await moduleScenario(memoryWriteBackend(exampleRegistry).deps);

      const live = createLiveRegistry(createRegistry([]));
      const deps = defaultWorkbenchDeps({ modules: live });
      const { host } = attachCodeModules(deps, { builtins: [], live, files: { dataDir: join(work, 'data'), packsDir: join(work, 'packs') }, pollMs: 0, cacheDir: join(work, 'cache'), log: () => {} });
      await host.sync();
      const installed = await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body: { zip: Buffer.from(fixture.zip).toString('base64'), trustKey: store.publisherPublicKey, apply: true, consent: { code: 'example@0.1.0' } }, user: OWNER }, deps);
      expect(installed.status, JSON.stringify(installed.body)).toBe(200);
      expect(live.module('example')?.version).toBe('0.1.0');
      const runtime = await moduleScenario(deps, undefined, { ownModules: true });
      expect(runtime).toEqual(builtIn);
    } finally {
      fixture.close();
    }
  }, 120_000);
});
