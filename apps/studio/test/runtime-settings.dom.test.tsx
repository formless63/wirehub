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

const mount = (section = 'runtime') =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [`/settings?section=${section}`] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

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

  it.each([['github', 'GitHub'], ['google', 'Google']] as const)('requires an explicit %s switch and keeps its saved secret out of the form', async (provider, label) => {
    mount('authentication');
    const signIn = await screen.findByTestId('runtime-sign-in');
    const enabled = within(signIn).getByLabelText(`${label} sign-in`) as HTMLSelectElement;
    expect(enabled.value).toBe('');
    expect(enabled.options[0]?.textContent).toBe('Default (off)');
    expect(within(signIn).getByText(new RegExp(`PUBLIC_URL followed by /api/auth/callback/${provider}`))).toBeTruthy();
    fireEvent.change(within(signIn).getByLabelText(`${label} client id`), { target: { value: 'synthetic-client' } });
    fireEvent.click(within(signIn).getByRole('button', { name: 'Save sign-in & accounts' }));
    await waitFor(() => expect(settings.env()[`AUTH_${provider.toUpperCase()}_CLIENT_ID`]).toBe('synthetic-client'));
    expect(settings.env()[`AUTH_${provider.toUpperCase()}_ENABLED`]).toBeUndefined();
    const secret = screen.getByTestId(`secret-${provider}.clientSecret`);
    const input = within(secret).getByLabelText(`${label} client secret`) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'synthetic-browser-secret' } });
    fireEvent.click(within(secret).getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.body.textContent).not.toContain('synthetic-browser-secret');
    await waitFor(() => expect(within(screen.getByTestId(`secret-${provider}.clientSecret`)).getByText(/^Set \(\d{4}-/)).toBeTruthy());
    fireEvent.change(within(screen.getByTestId('runtime-sign-in')).getByLabelText(`${label} sign-in`), { target: { value: 'on' } });
    fireEvent.click(within(screen.getByTestId('runtime-sign-in')).getByRole('button', { name: 'Save sign-in & accounts' }));
    await waitFor(() => expect(settings.env()[`AUTH_${provider.toUpperCase()}_ENABLED`]).toBe('true'));
  }, 30_000);

  it('retains unsaved sign-in, secret and runtime drafts when switching sections', async () => {
    mount('authentication');
    const auth = await screen.findByTestId('runtime-sign-in');
    const clientId = within(auth).getByLabelText('GitHub client id') as HTMLInputElement;
    const secret = within(auth).getByLabelText('GitHub client secret') as HTMLInputElement;
    fireEvent.change(clientId, { target: { value: 'unsaved-synthetic-client' } });
    fireEvent.change(secret, { target: { value: 'unsaved-synthetic-secret' } });
    fireEvent.click(screen.getByRole('link', { name: 'System' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'System' }).getAttribute('aria-current')).toBe('page'));
    const window = within(screen.getByTestId('runtime-jobs')).getByLabelText('Model build window') as HTMLInputElement;
    fireEvent.change(window, { target: { value: '03:00-04:00' } });
    fireEvent.click(screen.getByRole('link', { name: 'Sign-in & accounts' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign-in & accounts' }).getAttribute('aria-current')).toBe('page'));
    expect(clientId.value).toBe('unsaved-synthetic-client');
    expect(secret.value).toBe('unsaved-synthetic-secret');
    fireEvent.click(screen.getByRole('link', { name: 'System' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'System' }).getAttribute('aria-current')).toBe('page'));
    expect(window.value).toBe('03:00-04:00');
    expect(settings.env().AUTH_GITHUB_CLIENT_ID).toBeUndefined();
    expect(settings.env().AUTH_GITHUB_CLIENT_SECRET).toBeUndefined();
    expect(settings.env().WIREHUB_CONVERT_WINDOW).toBeUndefined();
  });

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
    mount('engineering');
    const form = await screen.findByTestId('engineering-settings');
    expect(within(form).getAllByText('set by the server')).toHaveLength(1);
    const locked = within(form).getAllByRole('textbox').filter((el) => (el as HTMLInputElement).disabled);
    expect(locked).toHaveLength(1);
    expect((locked[0] as HTMLInputElement).value).toBe('100');
  }, 30_000);
});
