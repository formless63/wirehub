// @vitest-environment jsdom
/**
 * Settings → Module settings (cs-nws, module API 1.5): each installed module that declares
 * settings gets a section; a secret is set, replaced and cleared without ever being shown back;
 * its status says configured, set by the server (locked) or missing; a list setting saves at
 * once. Through the real API router.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryEventHub } from '../server/events.ts';
import { moduleSettingsFor } from '../server/module-settings.ts';
import { createRuntimeSettings, type RuntimeSettings } from '../server/runtime-settings.ts';
import { memorySecretStore, settingsCipher } from '../server/settings-secrets.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { KEY, SERVER_ENV, scenarioRegistry } from './module-settings-scenario.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry: browserRegistry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;
let settings: RuntimeSettings;
let secrets: ReturnType<typeof memorySecretStore>;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  const { registry } = scenarioRegistry();
  deps = { ...memoryWriteBackend(registry, join(DATA, '..')).deps, events: memoryEventHub() };
  secrets = memorySecretStore();
  settings = createRuntimeSettings({ env: SERVER_ENV, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', cipher: settingsCipher(KEY), log: () => {} });
  settings.follow(deps.events);
  deps.runtimeSettings = settings;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), headers, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const mount = () =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/settings?section=module-settings'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={browserRegistry} />);

const read = (module: string, key: string) => moduleSettingsFor(module, () => deps.modules, () => settings).get(key);

describe('Module settings', () => {
  it('sets, replaces and clears a module secret write-only, shows the locked and missing ones, and saves a list', async () => {
    mount();
    const probe = await screen.findByTestId('module-settings-keyed-probe');
    const suppliersSection = screen.getByTestId('module-settings-suppliers');
    // locked by the server's variable; required and missing
    expect(within(screen.getByTestId('module-secret-suppliers-lcscKey')).getByText('set by the server, locked')).toBeTruthy();
    expect(within(screen.getByTestId('module-secret-suppliers-lcscKey')).queryByLabelText('LCSC API key')).toBeNull();
    const key = within(probe).getByTestId('module-secret-keyed-probe-apiKey');
    expect(within(key).getByText('missing: required for lookups')).toBeTruthy();

    fireEvent.change(within(key).getByLabelText('API key'), { target: { value: 'typed-but-hidden-key' } });
    fireEvent.click(within(key).getByRole('button', { name: 'Set' }));
    await waitFor(async () => expect(await read('keyed-probe', 'apiKey')).toBe('typed-but-hidden-key'));
    await waitFor(() => expect(within(screen.getByTestId('module-secret-keyed-probe-apiKey')).getByText(/^configured \(\d{4}-/)).toBeTruthy());
    expect((within(screen.getByTestId('module-secret-keyed-probe-apiKey')).getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain('typed-but-hidden-key');

    // replace, then clear
    const again = screen.getByTestId('module-secret-keyed-probe-apiKey');
    fireEvent.change(within(again).getByLabelText('API key'), { target: { value: 'the-replacement-key' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Replace' }));
    await waitFor(async () => expect(await read('keyed-probe', 'apiKey')).toBe('the-replacement-key'));
    await waitFor(() => expect(within(screen.getByTestId('module-secret-keyed-probe-apiKey')).getByRole('button', { name: 'Clear' })).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('module-secret-keyed-probe-apiKey')).getByRole('button', { name: 'Clear' }));
    await waitFor(async () => expect(await read('keyed-probe', 'apiKey')).toBeUndefined());
    await waitFor(() => expect(within(screen.getByTestId('module-secret-keyed-probe-apiKey')).getByText('missing: required for lookups')).toBeTruthy());

    // enabling a provider: a list setting, saved at once
    fireEvent.click(within(within(suppliersSection).getByRole('group', { name: 'Enabled providers' })).getByLabelText('mouser'));
    fireEvent.click(within(suppliersSection).getByRole('button', { name: 'Save Suppliers settings' }));
    await waitFor(async () => expect(await read('suppliers', 'providers')).toBe('mouser'));
  }, 30_000);
});
