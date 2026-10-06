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
  it('edits segments as a form, checks and saves without dropping advanced fields', async () => {
    mount();
    const box = await screen.findByLabelText('Scheme definition');
    const scheme = {
      type: 'declarative', id: 'form-example', template: '{family}-{seq}-{variant}', note: 'retained metadata',
      segments: [
        { id: 'family', type: 'choice', values: [{ value: 'A', kinds: ['connector'], note: 'retained choice' }, { value: 'B', kinds: ['wire'] }] },
        { id: 'seq', type: 'counter', width: 2, exclude: [15], ranges: [{ from: 10, to: 99, match: { family: ['B'] }, exclude: [13], note: 'retained range' }] },
        { id: 'variant', type: 'variant', width: 2, style: 'numeric', first: '00', max: '09', kinds: ['connector'] },
      ], src: 'synthetic example',
    };
    fireEvent.change(box, { target: { value: JSON.stringify(scheme) } });
    fireEvent.change(screen.getByLabelText('Segment 1 value 1'), { target: { value: 'C' } });
    fireEvent.change(screen.getByLabelText('Segment 2 range 1 from'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Segment 3 maximum'), { target: { value: '19' } });
    fireEvent.change(screen.getByLabelText('Sample numbers'), { target: { value: 'C-20-00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect((await screen.findByTestId('pn-check')).textContent).toContain('C-20-00: ok');
    fireEvent.click(screen.getByRole('button', { name: 'Save scheme' }));
    await waitFor(async () => {
      const saved = (await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/part-numbers' }, deps)).body as { config: typeof scheme };
      expect(saved.config).toEqual({ ...scheme, segments: [
        { ...scheme.segments[0], values: [{ value: 'C', kinds: ['connector'], note: 'retained choice' }, { value: 'B', kinds: ['wire'] }] },
        { ...scheme.segments[1], ranges: [{ ...scheme.segments[1]!.ranges![0], from: 20 }] },
        { ...scheme.segments[2], max: '19' },
      ] });
    });
  });

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
  it('edits nested condition and count selectors, tests and saves the rule losslessly', async () => {
    mount();
    const section = await screen.findByTestId('rules-settings');
    fireEvent.change(await within(section).findByLabelText('New rule from an example'), { target: { value: '4' } });
    const editor = await screen.findByTestId('rule-editor');
    const rule = {
      id: 'form-rule', each: 'cable-end', severity: 'warning', message: 'original', src: 'synthetic example', note: 'retained metadata',
      where: { any: [{ exists: { path: 'id' } }, { not: { eq: [{ path: 'end' }, 'a'] } }] },
      require: { gte: [{ count: { in: 'connectors', where: { eq: [{ path: 'family' }, 'd-sub'] } } }, 1] },
    };
    fireEvent.change(within(editor).getByLabelText('Rule definition'), { target: { value: JSON.stringify(rule) } });
    fireEvent.change(within(editor).getByLabelText('Rule message'), { target: { value: '{id} needs a board' } });
    fireEvent.change(within(editor).getByLabelText('Require left list field'), { target: { value: 'boards' } });
    fireEvent.change(within(editor).getByLabelText('Require left item filter left field'), { target: { value: 'id' } });
    fireEvent.change(within(editor).getByLabelText('Applies when condition 2 negated right value'), { target: { value: 'b' } });
    const draft = JSON.parse((within(editor).getByLabelText('Rule definition') as HTMLTextAreaElement).value) as typeof rule;
    expect(draft.note).toBe(rule.note);
    expect(draft.require.gte[0]).toEqual({ count: { in: 'boards', where: { eq: [{ path: 'id' }, 'd-sub'] } } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Test on my designs' }));
    expect((await screen.findByTestId('rule-test')).textContent).toContain('warning(s)');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(section.querySelector('[data-rule="form-rule"]')).not.toBeNull());
    const saved = (await handleWorkbenchRequest({ method: 'GET', path: '/api/rules' }, deps)).body as { local: unknown[] };
    expect(saved.local).toEqual([draft]);
  });

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

  it('refuses to save while a nested JSON operand is incomplete', async () => {
    mount();
    const section = await screen.findByTestId('rules-settings');
    fireEvent.change(await within(section).findByLabelText('New rule from an example'), { target: { value: '0' } });
    const editor = await screen.findByTestId('rule-editor');
    fireEvent.change(within(editor).getByLabelText('Require right type'), { target: { value: 'list' } });
    fireEvent.change(within(editor).getByLabelText('Require right list'), { target: { value: '[' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText('Correct the invalid JSON field before testing or saving.')).toBeTruthy();
    expect(section.querySelector('[data-rule="example-pin-joined"]')).toBeNull();
    fireEvent.change(within(editor).getByLabelText('Require right list'), { target: { value: '["9"]' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(section.querySelector('[data-rule="example-pin-joined"]')).not.toBeNull());
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
