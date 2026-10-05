/** Outbound event webhooks on the real file backend (a temporary copy of the starter catalog). */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-webhooks-files-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

describe('outbound webhooks on files', () => {
  it('runs the subscription, signing, retry, log and event script', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { memorySecretStore } = await import('../server/settings-secrets.ts');
    const { memoryJobStore } = await import('../server/jobs/service.ts');
    const { webhooksScenario } = await import('./webhooks-scenario.ts');
    await webhooksScenario({ deps: defaultWorkbenchDeps(), secrets: memorySecretStore(), jobStore: memoryJobStore(), org: 'files' });
  }, 30_000);
});
