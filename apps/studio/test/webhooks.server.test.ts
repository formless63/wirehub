/** Outbound event webhooks on the commit tree (the Postgres commit's stores without a database); the same script runs on Postgres. */

import { describe, expect, it } from 'vitest';

import { memorySecretStore } from '../server/settings-secrets.ts';
import { memoryJobStore } from '../server/jobs/service.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';
import { webhooksScenario } from './webhooks-scenario.ts';

describe('outbound webhooks', () => {
  it('runs the subscription, signing, retry, log and event script', async () => {
    const backend = memoryWriteBackend();
    await webhooksScenario({ deps: { ...backend.deps }, secrets: memorySecretStore(), jobStore: memoryJobStore(), org: 'memory' });
  }, 30_000);
});
