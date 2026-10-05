// @vitest-environment jsdom
/**
 * The runtime settings on the Settings page (cs-gm8): a value saved in a group applies at
 * once, a value the server's environment sets is read-only ("set by the server"), and a
 * secret is set without ever being shown back. Through the real API router.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryEventHub } from '../server/events.ts';
import { createRuntimeSettings, type RuntimeSettings } from '../server/runtime-settings.ts';
import { memorySecretStore, settingsCipher } from '../server/settings-secrets.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;
let settings: RuntimeSettings;
let secrets: ReturnType<typeof memorySecretStore>;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  deps = { ...memoryWriteBackend(undefined, join(DATA, '..')).deps, events: memoryEventHub() };
  secrets = memorySecretStore();
  settings = createRuntimeSettings({ env: { WIREHUB_IMPORT_MAX_MB: '25' }, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', cipher: settingsCipher('d'.repeat(43)), log: () => {} });
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
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/settings'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

describe('Runtime settings', () => {
  it('saves a group live, shows the server’s values read-only, and sets a secret write-only', async () => {
    mount();
    const jobs = await screen.findByTestId('runtime-jobs');
    // the server's value: shown, read-only, with the variable named
    const max = within(jobs).getByLabelText('Largest import file (MB)') as HTMLInputElement;
    expect(max.value).toBe('25');
    expect(max.disabled).toBe(true);
    expect(within(jobs).getByText('set by the server (WIREHUB_IMPORT_MAX_MB)')).toBeTruthy();

    fireEvent.change(within(jobs).getByLabelText('Model build window'), { target: { value: '02:00-04:00' } });
    fireEvent.click(within(jobs).getByRole('button', { name: 'Save jobs & limits' }));
    await waitFor(() => expect(settings.env().WIREHUB_CONVERT_WINDOW).toBe('02:00-04:00'));

    const notifications = screen.getByTestId('runtime-notifications');
    const url = within(notifications).getByTestId('secret-notify.url');
    expect(within(url).getByText('Not set.')).toBeTruthy();
    fireEvent.change(within(url).getByLabelText('Webhook URL'), { target: { value: 'https://ntfy.example.com/hidden-topic' } });
    fireEvent.click(within(url).getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(settings.env().WIREHUB_NOTIFY_URL).toBe('https://ntfy.example.com/hidden-topic'));
    await waitFor(() => expect(within(screen.getByTestId('secret-notify.url')).getByText(/^Set \(\d{4}-/)).toBeTruthy());
    expect(document.body.textContent).not.toContain('hidden-topic');
    expect((within(screen.getByTestId('secret-notify.url')).getByLabelText('Webhook URL') as HTMLInputElement).value).toBe('');
  }, 30_000);

  it('offers to adopt the server’s values, and copies them into Settings with one click', async () => {
    mount();
    const banner = await screen.findByTestId('adopt-server-values');
    expect(within(banner).getByText(/Largest import file \(MB\)/)).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Adopt the server’s values' }));
    await waitFor(() => expect(screen.queryByTestId('adopt-server-values')).toBeNull());
    expect(await deps.docs!.read('data/settings/jobs.json')).toMatchObject({ values: { 'jobs.importMaxMb': 25 } });
    // the variable still wins while it is set
    expect(settings.env().WIREHUB_IMPORT_MAX_MB).toBe('25');
  }, 30_000);

  it('shows a test parameter the server sets as set by the server, read-only', async () => {
    deps.testDefaults = { isolationVolts: 100 };
    mount();
    const form = await screen.findByTestId('engineering-settings');
    expect(within(form).getAllByText('set by the server (WIREHUB_TEST_DEFAULTS)')).toHaveLength(1);
    const locked = within(form).getAllByRole('textbox').filter((el) => (el as HTMLInputElement).disabled);
    expect(locked).toHaveLength(1);
    expect((locked[0] as HTMLInputElement).value).toBe('100');
  }, 30_000);
});
