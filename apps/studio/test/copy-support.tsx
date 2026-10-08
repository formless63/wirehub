/** Shared by the rendered-copy tests: the app over the real API router, and what a person can read of it. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';

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
export const realFetch = globalThis.fetch;

export function serve(): void {
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

export const mount = (path: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);


/** Everything a person can read: text, plus the words in tooltips, labels and placeholders. */
export function readableCopy(root: ParentNode, skip: string[] = []): string[] {
  const out: string[] = [];
  const clone = (root as Element).cloneNode(true) as Element;
  for (const selector of skip) clone.querySelectorAll(selector).forEach((el) => el.remove());
  clone.querySelectorAll('script, style').forEach((el) => el.remove());
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text !== '') out.push(text);
  }
  clone.querySelectorAll('[title], [aria-label], [placeholder], [alt]').forEach((el) => {
    for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
      const v = el.getAttribute(attr);
      if (v !== null) out.push(v);
    }
  });
  return out;
}

