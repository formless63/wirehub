/**
 * The example module is a dev tool: it is in the deployment's manifest only
 * when `WIREHUB_EXAMPLE_MODULE=1`, so it is never offered at /setup (or mounted
 * anywhere) on a hub that did not ask for it (`modules.config.ts`).
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';

const manifestWith = async (flag: string | undefined) => {
  vi.resetModules();
  if (flag === undefined) delete process.env.WIREHUB_EXAMPLE_MODULE;
  else process.env.WIREHUB_EXAMPLE_MODULE = flag;
  return (await import('../modules.config.ts')).modules;
};

afterEach(() => delete process.env.WIREHUB_EXAMPLE_MODULE);

describe('the example module flag', () => {
  it('keeps the example out of the manifest by default', async () => {
    for (const flag of [undefined, '', '0', 'true']) expect((await manifestWith(flag)).map((m) => m.id), String(flag)).not.toContain('example');
  });

  it('puts it last in the manifest, and the manifest stays valid, with WIREHUB_EXAMPLE_MODULE=1', async () => {
    const modules = await manifestWith('1');
    expect(modules.map((m) => m.id)).toEqual(['pc-serial', 'networking', 'pro-audio', 'av-video', 'automotive', 'board-import', 'wireviz', 'csv-library', 'catalog-assets', 'example']);
    expect(() => createRegistry(modules)).not.toThrow();
  });
});

describe('/setup', () => {
  let root = '';
  let build: (modules: Awaited<ReturnType<typeof manifestWith>>) => WorkbenchDeps;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-example-setup-'));
    const [dir, packs] = [join(root, 'catalog'), join(root, 'packs')];
    cpSync(dataPath(''), dir, { recursive: true });
    const catalog = createCatalog(catalogWithPacksSource(dir, packs));
    build = (modules) => ({
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => catalog.loadDb(),
      modules: createRegistry(modules),
      setup: { dataDir: dir, packsDir: packs, prompt: true, now: () => '2026-10-05T12:00:00.000Z' },
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const get = async (d: WorkbenchDeps) => (await handleWorkbenchRequest({ method: 'GET', path: '/api/setup' }, d)).body as { domains: { id: string; enabled: boolean; suggested: boolean; description: string }[] };

  it('does not offer it without the flag, and does with it — unticked, labelled as an example', async () => {
    expect((await get(build(await manifestWith(undefined)))).domains.map((d) => d.id)).not.toContain('example');
    const offered = (await get(build(await manifestWith('1')))).domains.find((d) => d.id === 'example');
    expect(offered).toMatchObject({ enabled: false, suggested: false });
    expect(offered?.description).toMatch(/^EXAMPLE ONLY/);
  });

  it('installs its pack as a layer only when it is chosen', async () => {
    const flagged = build(await manifestWith('1'));
    expect(JSON.stringify(await flagged.loadDb())).not.toContain('example-tick');
    const done = await handleWorkbenchRequest({ method: 'POST', path: '/api/setup', body: { modules: ['example'] } }, flagged);
    expect(done.status).toBe(200);
    expect(JSON.stringify(await flagged.loadDb())).toContain('example-tick');
  });
});
