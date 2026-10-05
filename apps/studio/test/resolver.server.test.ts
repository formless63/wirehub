/** The device resolver over the API on the real file backend (a temporary copy of the starter catalog, packs layered). */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-resolver-files-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
mkdirSync(join(work, 'packs'));
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
process.env.WIREHUB_PACKS_DIR = join(work, 'packs');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  rmSync(work, { recursive: true, force: true });
});

describe('the device resolver on files', () => {
  it('runs the resolver flow', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { runResolverFlow } = await import('./resolver-flow.ts');
    const deps = defaultWorkbenchDeps();
    await runResolverFlow({
      call: async (method, path, body, user, headers) =>
        (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as never,
    });
  }, 60_000);
});
