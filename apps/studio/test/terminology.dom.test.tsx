// @vitest-environment jsdom
/**
 * Terminology (cs-5ea.18, docs/design/terminology.md): "design" is the noun for what a person
 * builds, "cable" only where a physical cable is meant, "source end" / "destination end" name the
 * two ends, and the provenance field is "Reference". Read over the main routes' rendered copy,
 * with an allow-list for the places where a cable is a cable.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
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

/** The data a person typed or the catalog holds (a design's name, a part's name) is theirs, not our copy. */
const RECORDS = '[data-testid="cable-row"], [data-testid="design-row"], tbody, [role="grid"], [role="row"], [role="listbox"], [role="option"], [data-testid="cable-list"], pre, code, input, textarea, select';

/** Where "cable" is the right word: a physical cable. */
const CABLE_OK = [/\bAWG\b/, /cable (stock|side|pad|illustration|length|jacket)/i, /(finished|coaxial|mic|patch|microphone) cable/i, /along the cable/i, /\bcables? stocks?\b/i];

const ROUTES: readonly [path: string, ready: () => Promise<unknown>][] = [
  ['/cables', () => screen.findByLabelText(/Filter designs/)],
  ['/library', () => screen.findByText('Connectors')],
  ['/cables/de9-crossover', () => screen.findByTestId('editor').catch(() => new Promise((r) => setTimeout(r, 1500)))],
  ['/cables/de9-crossover?view=documents', () => new Promise((r) => setTimeout(r, 1500))],
  ['/library/wires', () => new Promise((r) => setTimeout(r, 500))],
  ['/resolver', () => screen.findByTestId('resolver')],
  ['/products', () => screen.findByTestId('products')],
  ['/history', () => screen.findByTestId('history')],
  ['/jobs', () => screen.findByTestId('jobs')],
  ['/part-numbers', () => screen.findByTestId('part-numbers')],
  ['/settings?section=rules', () => screen.findByTestId('settings')],
  ['/settings?section=documents', () => screen.findByTestId('settings')],
];

describe('terminology in rendered copy', () => {
  it.each(ROUTES)('%s says design, not cable', async (path, ready) => {
    serve();
    const view = mount(path);
    await ready();
    await new Promise((r) => setTimeout(r, 150));
    const copy = readableCopy(view.container, RECORDS.split(', ')).join('\n');
    const hits = [...copy.matchAll(/[^.\n]*\bcables?\b[^.\n]*/gi)].map((m) => m[0].trim()).filter((line) => !CABLE_OK.some((ok) => ok.test(line)));
    expect(hits, path).toEqual([]);
  });

  it('the rail and the palette say Designs and Find a design', async () => {
    serve();
    const view = mount('/cables');
    await screen.findByLabelText(/Filter designs/);
    const nav = readableCopy(view.container.querySelector('nav') ?? view.container).join('\n');
    expect(nav).toMatch(/Designs/);
    expect(nav).toMatch(/Find a design/);
    expect(nav).not.toMatch(/Which cable|Find cable/);
  });

  it('the wizard asks for a Reference, pre-filled with "own design"', async () => {
    serve();
    mount('/cables');
    fireEvent.click(await screen.findByRole('button', { name: 'New design' }));
    const field = (await screen.findByLabelText(/^Reference/)) as HTMLInputElement;
    expect(field.value).toBe('own design');
    expect(screen.queryByLabelText(/^Source$/)).toBeNull();
  });
});
