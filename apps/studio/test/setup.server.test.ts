/**
 * First-run setup (`server/setup.ts`): the domain modules the build offers,
 * unticked unless the deployment suggests them, the one-time setup code, the
 * selection stored in `setup.json`, and their packs installed as layers in a
 * packs directory beside a temporary copy of the starter catalog — never into
 * the catalog itself.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath } from '@wirehub/catalog';
import { automotive } from '@wirehub/module-automotive';
import { avVideo } from '@wirehub/module-av-video';
import { createRegistry } from '@wirehub/modules';

import { modules as manifest } from '../modules.config.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { generateSetupCode, normalizeSetupCode, parseSuggestedModules, readSetup, SETUP_CODE_ALPHABET, setupBanner } from '../server/setup.ts';

let root = '';
let dir = '';
let packs = '';
let deps: WorkbenchDeps;
const registry = createRegistry([avVideo, automotive]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirehub-setup-'));
  dir = join(root, 'catalog');
  packs = join(root, 'packs');
  cpSync(dataPath(''), dir, { recursive: true });
  const catalog = createCatalog(catalogWithPacksSource(dir, packs));
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => catalog.loadDb(),
    modules: registry,
    setup: { dataDir: dir, packsDir: packs, prompt: true, now: () => '2026-10-04T12:00:00.000Z' },
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The catalog as the hub reads it: the copy with the installed packs under it. */
const hub = (): ReturnType<typeof createCatalog> => createCatalog(catalogWithPacksSource(dir, packs));
const starterText = (file: string): string => readFileSync(join(dataPath(''), file), 'utf8');

const call = async (method: string, body?: unknown): Promise<{ status: number; body: any }> =>
  (await handleWorkbenchRequest({ method, path: '/api/setup', ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };

describe('first-run setup', () => {
  it('offers the bundled domain modules, nothing enabled, and asks to run', async () => {
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(response.body.needed).toBe(true);
    expect(response.body.domains.map((d: { id: string }) => d.id)).toEqual(['av-video', 'automotive']);
    expect(response.body.domains.every((d: { enabled: boolean }) => !d.enabled)).toBe(true);
    // only domains with no module yet are suggestions
    expect(response.body.suggestions.map((s: { label: string }) => s.label)).toEqual(['Fieldbus']);
  });

  it('offers every bundled module unticked: serial, networking and audio are no longer pre-ticked', async () => {
    deps = { ...deps, modules: createRegistry(manifest) };
    const domains = (await call('GET')).body.domains as { id: string; suggested: boolean; packs: { license: string }[] }[];
    expect(domains.map((d) => d.id)).toEqual(['pc-serial', 'networking', 'pro-audio', 'av-video', 'automotive']);
    expect(domains.filter((d) => d.suggested)).toEqual([]);
    expect(domains.every((d) => d.packs.every((p) => p.license === 'CC0-1.0'))).toBe(true);
  });

  it('pre-ticks what the deployment suggests (WIREHUB_SUGGESTED_MODULES), nothing else', async () => {
    deps = { ...deps, modules: createRegistry(manifest), setup: { ...deps.setup!, suggested: parseSuggestedModules('pc-serial, networking')! } };
    const domains = (await call('GET')).body.domains as { id: string; suggested: boolean }[];
    expect(domains.filter((d) => d.suggested).map((d) => d.id)).toEqual(['pc-serial', 'networking']);
  });

  it('installs every bundled module together, without one clash', async () => {
    deps = { ...deps, modules: createRegistry(manifest) };
    const response = await call('POST', { modules: ['pc-serial', 'networking', 'pro-audio', 'av-video', 'automotive'] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const catalog = hub();
    for (const id of ['db9-null-modem', 'rs485-de9-terminal-board', 'usb-a-led-lead', 'rj45-patch-t568b', 'rj45-crossover-t568a-b', 'xlr-mic-cable', 'trs-to-2rca-y', 'vga-monitor-cable']) {
      expect(catalog.listDesignIds(), id).toContain(id);
    }
  });

  it('installs the chosen modules\' packs and stores the selection', async () => {
    const response = await call('POST', { modules: ['av-video'] });
    expect(response.status).toBe(200);
    expect(response.body.needed).toBe(false);
    expect(response.body.installed).toEqual([{ module: 'av-video', pack: 'av-video', added: expect.any(Number), alreadyInstalled: false }]);
    expect(readSetup(packs)).toMatchObject({ completed: true, completedAt: '2026-10-04T12:00:00.000Z', modules: ['av-video'] });
    const db = hub().loadDb();
    expect(db.connectors.some((c) => c.id === 'hd15-male-vga')).toBe(true);
    expect(db.connectors.some((c) => c.id === 'obd2-male')).toBe(false);
    expect(hub().listDesignIds()).toContain('vga-monitor-cable');
    // the pack is a layer in the packs directory; the catalog's own files are untouched
    expect(existsSync(join(packs, 'av-video', 'designs/vga-monitor-cable.json'))).toBe(true);
    expect(existsSync(join(dir, 'designs/vga-monitor-cable.json'))).toBe(false);
    for (const file of ['connectors.json', 'bodies.json', 'interfaces.json', 'wires.json', 'vocab/signals.json']) {
      expect(readFileSync(join(dir, file), 'utf8'), file).toBe(starterText(file));
    }
    expect(existsSync(join(dir, 'setup.json'))).toBe(false);
    expect(existsSync(join(dir, 'packs.json'))).toBe(false);
    // adding another later keeps the first
    expect((await call('POST', { modules: ['automotive'] })).status).toBe(200);
    expect(readSetup(packs)?.modules).toEqual(['av-video', 'automotive']);
    const again = await call('GET');
    expect(again.body.domains.map((d: { enabled: boolean }) => d.enabled)).toEqual([true, true]);
  });

  it('takes an empty choice: setup is done, nothing installed', async () => {
    const response = await call('POST', { modules: [] });
    expect(response.status).toBe(200);
    expect(readSetup(packs)).toMatchObject({ completed: true, modules: [] });
    expect(existsSync(join(packs, 'packs.json'))).toBe(false);
  });

  it('refuses a module the build does not offer, and writes nothing', async () => {
    const response = await call('POST', { modules: ['flux-capacitor'] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('flux-capacitor');
    expect(readSetup(packs)).toBeUndefined();
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
    expect(readSetup(packs)).toBeUndefined();
    expect(existsSync(join(packs, 'automotive'))).toBe(false);
  });

  it('runs the host\'s after-install step (tag tables) only when a pack was installed', async () => {
    let runs = 0;
    deps = { ...deps, setup: { ...deps.setup!, afterInstall: () => (runs += 1) } };
    await call('POST', { modules: [] });
    expect(runs).toBe(0);
    await call('POST', { modules: ['automotive'] });
    expect(runs).toBe(1);
    await call('POST', { modules: ['automotive'] });
    expect(runs).toBe(1);
  });

  it('reads the selection a hub from before the packs directory left in its catalog', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'setup.json'), JSON.stringify({ src: 'x', completed: true, modules: [] }));
    expect((await call('GET')).body.needed).toBe(false);
  });

  it('asks for the setup code while setup has to run, and only then', async () => {
    deps = { ...deps, setup: { ...deps.setup!, code: 'ABCD-EFGH-JKMN' } };
    expect((await call('GET')).body.codeRequired).toBe(true);
    const missing = await call('POST', { modules: [] });
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('Enter the setup code.');
    expect(missing.body.hint).toContain('docker compose logs wirehub');
    const wrong = await call('POST', { modules: [], code: 'ABCD-EFGH-JKMP' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('That is not the setup code.');
    expect(readSetup(packs)).toBeUndefined();
    // case, spaces and dashes do not matter
    expect((await call('POST', { modules: ['automotive'], code: ' abcd efgh jkmn ' })).status).toBe(200);
    // once setup is done, adding modules later needs no code
    const after = await call('GET');
    expect(after.body.codeRequired).toBe(false);
    expect((await call('POST', { modules: ['av-video'] })).status).toBe(200);
  });

  it('makes readable setup codes and a banner that names the address', () => {
    const code = generateSetupCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect([...normalizeSetupCode(code)].every((c) => SETUP_CODE_ALPHABET.includes(c))).toBe(true);
    expect(generateSetupCode()).not.toBe(code);
    const banner = setupBanner('https://hub.example.com', code);
    expect(banner).toContain('https://hub.example.com/setup');
    expect(banner).toContain(`    ${code}`);
  });

  it('parses WIREHUB_SUGGESTED_MODULES', () => {
    expect(parseSuggestedModules(undefined)).toBeUndefined();
    expect(parseSuggestedModules(' ')).toBeUndefined();
    expect(parseSuggestedModules('pc-serial,networking pro-audio')).toEqual(['pc-serial', 'networking', 'pro-audio']);
  });

  it('does not ask on a host that did not ask for the prompt', async () => {
    deps = { ...deps, setup: { ...deps.setup!, prompt: false } };
    expect((await call('GET')).body.needed).toBe(false);
  });
});
