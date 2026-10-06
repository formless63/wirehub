// @vitest-environment jsdom
/**
 * The owner's side of runtime code modules in the page: Install pack… shows
 * what a module may do and offers Install only after the owner's consent, then
 * the module runs (`PacksPanel`, over the real API on temporary directories);
 * Settings → Code modules lists it, turns it off, and Restart WireHub waits for
 * the server to come back and reloads the page (`CodeModulesSettings`).
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { catalogWithPacksSource, createCatalog, installedAcross } from '@wirehub/catalog';
import { createLiveRegistry, createRegistry, type LiveModuleRegistry } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { attachCodeModules } from '../server/code-modules/index.ts';
import { createSystemControl } from '../server/system.ts';
import { PacksPanel } from '../src/modules/PacksPanel.tsx';
import { TINY_MODULE, tinyBundle, tinyKeys } from './tiny-code-module.ts';

vi.mock('../src/studio-context.tsx', () => ({ useStudio: () => ({ me: { name: 'Ow', source: 'session', role: 'owner' } }) }));
const { CodeModulesSettings } = await import('../src/routes/CodeModulesSettings.tsx');

let root = '';
let deps: WorkbenchDeps;
let live: LiveModuleRegistry;
const keys = tinyKeys();
let restarts = 0;
let bootId = 'boot-1';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wirehub-code-ui-'));
  const dir = join(root, 'catalog');
  const packs = join(root, 'packs');
  cpSync(join(process.cwd(), '../../packages/catalog/data'), dir, { recursive: true });
  const hub = () => createCatalog(catalogWithPacksSource(dir, packs));
  live = createLiveRegistry(createRegistry([]));
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => hub().loadDb(),
    modules: live,
    installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
    setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
    localUser: { name: 'Ow', source: 'local', role: 'owner' },
    system: { ...createSystemControl({ bootId: 'boot-1', supervised: true, log: () => {}, exit: () => {}, steps: () => [] }), get bootId() { return bootId; }, restart: () => { restarts += 1; bootId = 'boot-2'; } },
  };
  attachCodeModules(deps, { builtins: [], live, files: { dataDir: dir, packsDir: packs }, pollMs: 0, cacheDir: join(root, 'cache'), log: () => {}, importModule: async () => ({ default: TINY_MODULE }) });
  await deps.codeModules?.sync();
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: input, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('installing a code module from a file', () => {
  it('shows what it may do and installs only after the owner consents; then it runs', async () => {
    render(<PacksPanel />);
    fireEvent.change(await screen.findByLabelText('Publisher key for a code module'), { target: { value: keys.publicKey } });
    const file = new File([tinyBundle(keys.pem) as BlobPart], 'tiny-1.0.0.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Pack file'), { target: { files: [file] } });
    const consent = await screen.findByTestId('code-consent');
    expect(consent.textContent).toContain('Tiny rule (tiny 1.0.0, module API 1.4)');
    expect(consent.textContent).toContain('runs code in your hub');
    expect(consent.textContent).toContain('May: server-code');
    const install = screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I trust this module to run code in this hub'));
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Its code runs now.'));
    expect(live.module('tiny')?.version).toBe('1.0.0');
  }, 30_000);
});

describe('Settings → Code modules', () => {
  const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CodeModulesSettings /></QueryClientProvider>);

  it('explains pending database changes with an administrator action', async () => {
    const installed = await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body: { zip: Buffer.from(tinyBundle(keys.pem)).toString('base64'), trustKey: keys.publicKey, apply: true, consent: { code: 'tiny@1.0.0' } } }, deps);
    expect(installed.status).toBe(200);
    vi.stubGlobal('fetch', async (input: string) => {
      const response = await handleWorkbenchRequest({ method: 'GET', path: input }, deps);
      if (input === '/api/code-modules') {
        const body = response.body as { modules: { state: string; error?: string }[] };
        body.modules[0]!.state = 'pending';
        body.modules[0]!.error = 'Database changes are waiting. An administrator must run the migration command with the publisher public key before this module can run.';
      }
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
    });
    mount();
    const row = (await screen.findByText('Tiny rule')).closest('li');
    expect(row?.textContent).toContain('waiting for database changes');
    expect(row?.textContent).toContain('An administrator must run the migration command');
  });

  it('lists the module, turns it off, and restarts WireHub, reloading the page when it is back', async () => {
    const installed = await handleWorkbenchRequest({ method: 'POST', path: '/api/packs/install', body: { zip: Buffer.from(tinyBundle(keys.pem)).toString('base64'), trustKey: keys.publicKey, apply: true, consent: { code: 'tiny@1.0.0' } } }, deps);
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    mount();
    const row = await screen.findByText('Tiny rule');
    expect(row.closest('li')?.textContent).toContain('running');
    expect(document.querySelector('[data-pinned-key]')?.textContent).toContain('Tiny publisher');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(document.querySelector('[data-code-module="tiny"] [data-state]')?.getAttribute('data-state')).toBe('disabled'));
    expect(live.module('tiny')).toBeUndefined();

    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Restart WireHub' }));
      await waitFor(() => expect(screen.getByTestId('restart-overlay').textContent).toContain('Restarting WireHub'));
      expect(restarts).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
