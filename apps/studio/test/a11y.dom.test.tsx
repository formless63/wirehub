// @vitest-environment jsdom
/**
 * Every route: a title that names the page, exactly one h1, a skip link to `#main`, one main landmark
 * and a named navigation, and an axe-core run with no serious or critical issue. jsdom has no layout, so
 * `color-contrast` is not run here (the token contrast is `packages/editor-react/test/contrast.test.ts`).
 */

import axe from 'axe-core';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { mount, realFetch, serve } from './copy-support.tsx';

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  document.title = '';
});

/** path, and the title the tab shows */
const ROUTES: readonly [path: string, title: RegExp][] = [
  ['/cables', /^Designs · WireHub$/],
  ['/cables/de9-crossover', /DE-9/],
  ['/library/connectors', /^Library · WireHub$/],
  ['/library/connectors/de9-male', /^Library · WireHub$/],
  ['/extensions', /^Extensions · WireHub$/],
  ['/extensions?tab=installed', /^Extensions · WireHub$/],
  ['/extensions?tab=sources', /^Extensions · WireHub$/],
  ['/resolver', /^Find a design · WireHub$/],
  ['/products', /^Products · WireHub$/],
  ['/history', /^History · WireHub$/],
  ['/jobs', /^Jobs · WireHub$/],
  ['/part-numbers', /^Part numbers · WireHub$/],
  ['/settings?section=documents', /^Settings · WireHub$/],
  ['/settings?section=engineering', /^Settings · WireHub$/],
  ['/settings?section=numbering', /^Settings · WireHub$/],
  ['/settings?section=rules', /^Settings · WireHub$/],
  ['/settings?section=webhooks', /^Settings · WireHub$/],
  ['/settings?section=module-settings', /^Settings · WireHub$/],
  ['/settings?section=runtime', /^Settings · WireHub$/],
  ['/settings?section=authentication', /^Settings · WireHub$/],
  ['/sign-in', /^My account · WireHub$/],
  ['/no-such-page', /WireHub$/],
];

describe('accessibility of every route', () => {
  it.each(ROUTES)('%s', async (path, title) => {
    serve();
    mount(path);
    await screen.findAllByRole('heading', { level: 1 });
    // let the page's queries land
    await new Promise((r) => setTimeout(r, 400));
    await waitFor(() => expect(document.title).toMatch(title));
    expect(document.querySelectorAll('h1'), `${path}: one h1`).toHaveLength(1);
    expect(document.querySelectorAll('main'), `${path}: one main`).toHaveLength(1);
    expect(document.querySelector('main')?.id).toBe('main');
    const skip = document.querySelector<HTMLAnchorElement>('a.cs-ui-skip');
    expect(skip?.getAttribute('href')).toBe('#main');
    expect(screen.getByRole('navigation', { name: 'sections' })).toBeTruthy();
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ')})`), `${path}: axe`).toEqual([]);
  }, 30_000);
});
