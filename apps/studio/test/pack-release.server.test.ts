/**
 * Release to this hub on the file backend (the layered install): the layer is merged into the
 * catalog's own files and removed, and the records behave as the hub's own. The flow is
 * `pack-release-flow.ts`; Postgres runs it in `pg/pack-release.server.test.ts`.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PACK, runReleaseFlow } from './pack-release-flow.ts';

const STARTER = fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'wirehub-release-'));
const data = join(root, 'data');
const packs = join(root, 'packs');
beforeAll(() => {
  cpSync(STARTER, data, { recursive: true });
  mkdirSync(packs, { recursive: true });
  process.env.WIREHUB_CATALOG_DIR = data;
  process.env.WIREHUB_PACKS_DIR = packs;
});
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('release a pack to the hub (files)', () => {
  it('previews, releases, and then the records are the hub\'s own; a re-install is refused', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const deps = defaultWorkbenchDeps();
    // the release raises pack.installed for the webhooks, like the other pack operations
    const events: { type: string; subject: { id: string }; summary?: Record<string, unknown> }[] = [];
    deps.webhooks = { emit: async (list) => void events.push(...list), jobFinished: async () => {}, catalogChanged: async () => {}, test: async () => undefined, redeliver: async () => undefined };
    await runReleaseFlow({
      call: async (method, path, body, extra) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(extra?.user === undefined ? {} : { user: extra.user }), ...(extra?.headers === undefined ? {} : { headers: extra.headers }) }, deps)) as { status: number; body: any; headers?: Record<string, string> },
      layerGone: () => !existsSync(join(packs, PACK)),
    });
    expect(events.filter((e) => e.type === 'pack.installed').map((e) => [e.subject.id, e.summary?.['action']])).toEqual([[PACK, 'installed'], [PACK, 'released']]);
    // the release is recorded, with what it handed over, in the catalog's own packs.json
    const { readReleasedPacks } = await import('@wirehub/catalog');
    expect(readReleasedPacks(data)).toEqual([expect.objectContaining({ id: PACK, version: '1.0.0', releasedBy: 'owner-a', records: expect.objectContaining({ 'components.json': ['rel-r'], 'designs/rel-lead.json': [] }) })]);
  });
});
