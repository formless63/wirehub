// @vitest-environment jsdom
/**
 * Rendered copy (cs-af2.15): no documentation path, environment variable, migration number or
 * job-engine id in what a person reads. An explanation lives in a `(?)` tooltip or behind a
 * "Learn more" link (`help.ts`); only Settings > System may name an environment variable, because
 * the operator who reads it needs the name.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryEventHub } from '../server/events.ts';
import { createRuntimeSettings } from '../server/runtime-settings.ts';
import { memorySecretStore, settingsCipher } from '../server/settings-secrets.ts';
import { KEY, scenarioRegistry } from './module-settings-scenario.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { DATABASE_HISTORY } from '../server/history/pg.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;

function serve(): void {
  const deps: WorkbenchDeps = { ...memoryWriteBackend(scenarioRegistry().registry, join(DATA, '..')).deps, loadPartNumberFiles: () => ({}), events: memoryEventHub() };
  const secrets = memorySecretStore();
  const settings = createRuntimeSettings({ env: { WIREHUB_IMPORT_MAX_MB: '25', WIREHUB_SUPPLIERS_LCSC_KEY: 'synthetic' }, docs: () => deps.docs, secrets: () => secrets, org: () => 'files', cipher: settingsCipher(KEY), log: () => {} });
  settings.follow(deps.events);
  deps.runtimeSettings = settings;
  const store = memoryJobStore();
  deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'], pollMs: 20 });
  deps.history = { capabilities: async () => DATABASE_HISTORY, list: async () => ({ entries: [] }), record: async () => ({ entries: [] }), detail: async () => undefined, stateAt: async () => undefined } as never;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

/** Everything a person can read: text, plus the words in tooltips, labels and placeholders. */
export function readableCopy(root: ParentNode, skip: string[] = []): string[] {
  const out: string[] = [];
  const clone = (root as Element).cloneNode(true) as Element;
  for (const selector of skip) clone.querySelectorAll(selector).forEach((el) => el.remove());
  clone.querySelectorAll('script, style').forEach((el) => el.remove());
  out.push(clone.textContent ?? '');
  clone.querySelectorAll('[title], [aria-label], [placeholder], [alt]').forEach((el) => {
    for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
      const v = el.getAttribute(attr);
      if (v !== null) out.push(v);
    }
  });
  return out;
}

const FORBIDDEN: readonly [name: string, pattern: RegExp][] = [
  ['a docs path', /\bdocs\/[\w./-]+/],
  ['a Markdown file name', /\b[\w-]+\.md\b/],
  ['an environment variable', /\bWIREHUB_[A-Z0-9_]+/],
  ['a migration number', /\bmigrations? \d{3,4}\b/i],
  ['the job engine', /pg-boss/i],
  ['"the studio"', /\bthe studio\b/i],
  ['"Workbench"', /\bworkbench\b/i],
  ['a doubled word', /\b(port) \1\b/i],
];

/** Settings sections that are the operator's: they may name an environment variable. */
const SYSTEM_SECTIONS = ['runtime', 'authentication'];

const ROUTES: readonly [path: string, ready: () => Promise<unknown>][] = [
  ['/cables', () => screen.findByLabelText(/Filter cables/)],
  ['/library', () => screen.findByText('Connectors')],
  ['/resolver', () => screen.findByTestId('resolver')],
  ['/products', () => screen.findByTestId('products')],
  ['/history', () => screen.findByTestId('history')],
  ['/jobs', () => screen.findByTestId('jobs')],
  ['/part-numbers', () => screen.findByTestId('part-numbers')],
  ['/modules', () => screen.findByText('Modules')],
  ['/library/store', () => new Promise((r) => setTimeout(r, 400))],
  ['/settings?section=documents', () => screen.findByTestId('settings')],
  ['/settings?section=engineering', () => screen.findByTestId('engineering-settings')],
  ['/settings?section=numbering', () => screen.findByTestId('settings')],
  ['/settings?section=rules', () => screen.findByTestId('settings')],
  ['/settings?section=webhooks', () => screen.findByTestId('webhook-settings')],
  ['/settings?section=stores', () => screen.findByTestId('store-sources')],
  ['/settings?section=module-settings', () => screen.findByTestId('module-settings')],
  ['/settings?section=modules', () => screen.findByTestId('settings')],
  ['/settings?section=runtime', () => screen.findByTestId('runtime-jobs')],
  ['/settings?section=authentication', () => screen.findByTestId('runtime-sign-in')],
];

describe('rendered copy', () => {
  it.each(ROUTES)('%s names no docs path, variable or internal id', async (path, ready) => {
    serve();
    const view = mount(path);
    await ready();
    await new Promise((r) => setTimeout(r, 120));
    const skip = SYSTEM_SECTIONS.map((id) => `[data-settings-section="${id}"]`);
    const copy = readableCopy(view.container, skip).join('\n');
    for (const [name, pattern] of FORBIDDEN) expect(copy.match(pattern)?.[0], `${path}: ${name}`).toBeUndefined();
  });

  it('Settings > System may still name the variables an operator needs', async () => {
    serve();
    const view = mount('/settings?section=runtime');
    await screen.findByTestId('runtime-jobs');
    await new Promise((r) => setTimeout(r, 120));
    const system = readableCopy(view.container.querySelector('[data-settings-section="runtime"]')!).join('\n');
    expect(system).toMatch(/WIREHUB_/);
    // ... but still no documentation path
    expect(system.match(/\bdocs\/[\w./-]+/)?.[0]).toBeUndefined();
  });
});
