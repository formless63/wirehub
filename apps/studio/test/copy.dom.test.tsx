// @vitest-environment jsdom
/**
 * Rendered copy (cs-af2.15): no documentation path, environment variable, migration number or
 * job-engine id in what a person reads. An explanation lives in a `(?)` tooltip or behind a
 * "Learn more" link (`help.ts`); only Settings > System may name an environment variable, because
 * the operator who reads it needs the name.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { mount, readableCopy, realFetch, serve } from './copy-support.tsx';

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

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
  ['/cables', () => screen.findByLabelText(/Filter designs/)],
  ['/library', () => screen.findByText('Connectors')],
  ['/cables/de9-crossover', () => screen.findByTestId('editor').catch(() => new Promise((r) => setTimeout(r, 1500)))],
  ['/cables/de9-crossover?view=documents', () => new Promise((r) => setTimeout(r, 1500))],
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
