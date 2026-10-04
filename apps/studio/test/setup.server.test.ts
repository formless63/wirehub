/**
 * First-run setup (`server/setup.ts`): the domain modules the build offers,
 * the selection stored in `setup.json`, and their packs installed into a
 * temporary copy of the starter catalog.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import { automotive } from '@wirehub/module-automotive';
import { avVideo } from '@wirehub/module-av-video';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { readSetup } from '../server/setup.ts';

let dir = '';
let deps: WorkbenchDeps;
const registry = createRegistry([avVideo, automotive]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirehub-setup-'));
  cpSync(dataPath(''), dir, { recursive: true });
  const catalog = createCatalog(fsCatalogSource(dir));
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => catalog.loadDb(),
    modules: registry,
    setup: { dataDir: dir, prompt: true, now: () => '2026-10-04T12:00:00.000Z' },
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = async (method: string, body?: unknown): Promise<{ status: number; body: any }> =>
  (await handleWorkbenchRequest({ method, path: '/api/setup', ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };

describe('first-run setup', () => {
  it('offers the bundled domain modules, nothing enabled, and asks to run', async () => {
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(response.body.needed).toBe(true);
    expect(response.body.domains.map((d: { id: string }) => d.id)).toEqual(['av-video', 'automotive']);
    expect(response.body.domains.every((d: { enabled: boolean }) => !d.enabled)).toBe(true);
    expect(response.body.suggestions.map((s: { label: string }) => s.label)).toContain('Pro audio');
  });

  it('installs the chosen modules\' packs and stores the selection', async () => {
    const response = await call('POST', { modules: ['av-video'] });
    expect(response.status).toBe(200);
    expect(response.body.needed).toBe(false);
    expect(response.body.installed).toEqual([{ module: 'av-video', pack: 'av-video', added: expect.any(Number), alreadyInstalled: false }]);
    expect(readSetup(dir)).toMatchObject({ completed: true, completedAt: '2026-10-04T12:00:00.000Z', modules: ['av-video'] });
    const db = createCatalog(fsCatalogSource(dir)).loadDb();
    expect(db.connectors.some((c) => c.id === 'hd15-male-vga')).toBe(true);
    expect(db.connectors.some((c) => c.id === 'obd2-male')).toBe(false);
    expect(existsSync(join(dir, 'designs/vga-monitor-cable.json'))).toBe(true);
    // adding another later keeps the first
    expect((await call('POST', { modules: ['automotive'] })).status).toBe(200);
    expect(readSetup(dir)?.modules).toEqual(['av-video', 'automotive']);
    const again = await call('GET');
    expect(again.body.domains.map((d: { enabled: boolean }) => d.enabled)).toEqual([true, true]);
  });

  it('takes an empty choice: setup is done, nothing installed', async () => {
    const response = await call('POST', { modules: [] });
    expect(response.status).toBe(200);
    expect(readSetup(dir)).toMatchObject({ completed: true, modules: [] });
    expect(existsSync(join(dir, 'packs.json'))).toBe(false);
  });

  it('refuses a module the build does not offer, and writes nothing', async () => {
    const response = await call('POST', { modules: ['flux-capacitor'] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('flux-capacitor');
    expect(readSetup(dir)).toBeUndefined();
  });

  it('refuses a pack whose records clash with the catalog, and says which', async () => {
    const connectors = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8')) as unknown[];
    cpSync(join(dir, 'connectors.json'), join(dir, 'connectors.bak'));
    const clash = [...connectors, { id: 'obd2-male', label: 'mine', family: 'x', pins: [], src: 'x' }];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'connectors.json'), `${JSON.stringify(clash, null, 2)}\n`);
    const response = await call('POST', { modules: ['automotive'] });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("'obd2-male' already exists");
    expect(readSetup(dir)).toBeUndefined();
  });

  it('does not ask on a host that did not ask for the prompt', async () => {
    deps = { ...deps, setup: { ...deps.setup!, prompt: false } };
    expect((await call('GET')).body.needed).toBe(false);
  });
});
