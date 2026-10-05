// @vitest-environment jsdom
/**
 * The three declarative settings in the Settings page, through the real API router: the part-number
 * scheme (check, save, a pack's offer confirmed by an owner), validation rules (example, test on the
 * designs, save, turn off) and outbound webhooks (add, make the secret, test, the delivery log).
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { createRuntimeSettings } from '../server/runtime-settings.ts';
import { memorySecretStore, settingsCipher } from '../server/settings-secrets.ts';
import { createWebhookEmitter } from '../server/webhooks/emitter.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;
let delivered: { url: string; headers: Record<string, string>; body: string }[];
let runner: ReturnType<typeof inlineJobRunner>;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  delivered = [];
  deps = memoryWriteBackend(undefined, join(DATA, '..')).deps;
  const jobStore = memoryJobStore();
  const secrets = memorySecretStore();
  const settings = createRuntimeSettings({ env: {}, docs: () => deps.docs, secrets: () => secrets, org: () => 'dom', cipher: settingsCipher('k'.repeat(43)), log: () => {} });
  deps.runtimeSettings = settings;
  deps.webhookFetch = (async (url: string, init: RequestInit) => {
    delivered.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  runner = inlineJobRunner(jobStore, () => baseJobHandlers({ deps, liveEnv: () => settings.env() }), () => {});
  deps.jobs = createJobService({ store: jobStore, runner, kinds: ['webhook'] });
  deps.webhooks = createWebhookEmitter({ docs: () => deps.docs, jobs: () => deps.jobs, env: () => settings.env() });
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

describe('Settings: part numbers', () => {
  it('checks a declarative scheme, saves it, and the proposals follow it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Insert the generic example' }));
    fireEvent.change(screen.getByLabelText('Sample numbers'), { target: { value: '1C-000001-00 CON-00001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const check = await screen.findByTestId('pn-check');
    expect(check.textContent).toMatch(/Reads as <level><type>-NNNNNN-VV/);
    expect(check.textContent).toMatch(/1C-000001-00: ok/);
    expect(check.textContent).toMatch(/CON-00001: not one of this scheme/);
    expect(check.textContent).toMatch(/A new connector would get 1C-000001-00/);
    fireEvent.click(screen.getByRole('button', { name: 'Save scheme' }));
    await waitFor(() => expect(screen.getByTestId('pn-in-force').textContent).toMatch(/Level and type, sequence, variant.*declarative.*existing numbers never change/));
    const stored = (await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/part-numbers' }, deps)).body as { config: { type: string } };
    expect(stored.config.type).toBe('declarative');
  });

  it('shows a definition problem in words and saves nothing', async () => {
    mount();
    const box = (await screen.findByLabelText('Scheme definition')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: JSON.stringify({ type: 'declarative', template: '{x}', segments: [{ id: 'y', type: 'counter', width: 3 }] }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/\{x\} is not a segment/);
  });

  it('offers a pack\'s scheme and switches only on an owner\'s confirmation', async () => {
    const scheme = { type: 'declarative', id: 'pack-scheme', label: 'Pack scheme', template: 'P{seq}', segments: [{ id: 'seq', type: 'counter', width: 4 }], src: 'synthetic example' };
    deps.installedPacks = () => ({ src: 'x', packs: [{ id: 'acme-pack', version: '1.0.0', license: 'CC0-1.0', added: {}, partNumberScheme: scheme }] });
    mount();
    const offer = await screen.findByTestId('pn-offers');
    expect(within(offer).getByText(/Installing a pack never switches the scheme/)).toBeTruthy();
    // nothing is switched yet
    expect(screen.getByTestId('pn-in-force').textContent).toMatch(/Prefix \+ sequence/);
    fireEvent.click(within(offer).getByRole('button', { name: 'Review…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm: switch the numbering scheme' }));
    await waitFor(() => expect(screen.getByTestId('pn-in-force').textContent).toMatch(/Pack scheme/));
  });
});

describe('Settings: validation rules', () => {
  it('starts from an example, tests it on the designs, saves it and turns it off', async () => {
    mount();
    const section = await screen.findByTestId('rules-settings');
    fireEvent.change(await within(section).findByLabelText('New rule from an example'), { target: { value: '1' } });
    const editor = await screen.findByTestId('rule-editor');
    expect((within(editor).getByLabelText('Rule definition') as HTMLTextAreaElement).value).toMatch(/example-power-area/);
    fireEvent.click(within(editor).getByRole('button', { name: 'Test on my designs' }));
    const result = await screen.findByTestId('rule-test');
    expect(result.textContent).toMatch(/6 error\(s\)/);
    expect(result.textContent).toMatch(/dc-led-lead/);
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(section.querySelector('[data-rule="example-power-area"]')).not.toBeNull());
    // it runs: the design now fails its save for the thin power lead
    const lead = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/dc-led-lead' }, deps);
    const refused = await handleWorkbenchRequest({ method: 'PUT', path: '/api/designs/dc-led-lead', body: lead.body, headers: { 'if-match': lead.headers?.ETag ?? '' } }, deps);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('rule:example-power-area');
    const row = section.querySelector('[data-rule="example-power-area"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(within(section.querySelector('[data-rule="example-power-area"]') as HTMLElement).getByRole('button', { name: 'Turn on' })).toBeTruthy());
  });

  it('shows what is wrong with a rule in words', async () => {
    mount();
    const section = await screen.findByTestId('rules-settings');
    fireEvent.change(await within(section).findByLabelText('New rule from an example'), { target: { value: '0' } });
    const editor = await screen.findByTestId('rule-editor');
    fireEvent.change(within(editor).getByLabelText('Rule definition'), { target: { value: JSON.stringify({ id: 'x', severity: 'error', each: 'connector', require: { run: 'code()' }, message: 'm', src: 's' }) } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Test on my designs' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/'run' is not a condition/);
  });
});

describe('Settings: webhooks', () => {
  it('adds a webhook, makes its secret (shown once), sends a test and lists the delivery', async () => {
    mount();
    const section = await screen.findByTestId('webhook-settings');
    fireEvent.click(await within(section).findByRole('button', { name: 'Add a webhook…' }));
    fireEvent.change(within(section).getByLabelText('Webhook URL'), { target: { value: 'https://erp.example.test/wirehub' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save webhook' }));
    const item = await waitFor(() => {
      const found = section.querySelector('[data-webhook]') as HTMLElement | null;
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(item.textContent).toMatch(/version\.released/);
    expect(item.textContent).toMatch(/secret not set/);
    fireEvent.click(within(item).getByRole('button', { name: 'Make a secret' }));
    const once = await screen.findByTestId('webhook-secret-once');
    const secret = /whsec_[\w-]+/.exec(once.textContent ?? '')?.[0];
    expect(secret).toBeDefined();
    fireEvent.click(within(once).getByRole('button', { name: 'I have copied it' }));
    await waitFor(() => expect(item.textContent).toMatch(/secret set/));
    // the secret is never shown again
    expect(document.body.textContent).not.toContain(secret);
    fireEvent.click(within(item).getByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]?.headers['x-wirehub-event']).toBe('webhook.test');
    const log = await screen.findByTestId('webhook-log');
    await waitFor(() => expect(log.textContent).toMatch(/webhook\.test · attempt 1 · delivered \(200\)/));
    fireEvent.click(within(log).getByRole('button', { name: 'Redeliver' }));
    await waitFor(() => expect(delivered).toHaveLength(2));
  });

  it('is for owners only', async () => {
    deps.localUser = { name: 'Ed', source: 'local', role: 'editor' };
    mount();
    await screen.findByTestId('rules-settings');
    expect(screen.queryByTestId('webhook-settings')).toBeNull();
  });
});
