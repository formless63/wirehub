// @vitest-environment jsdom
/**
 * `/dev/ui` is dev-only: the route is gated on `import.meta.env.DEV` (Vite folds it to false in a
 * production bundle, which drops the lazy chunk too) and nothing else may import the gallery.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { UiGallery } from '../src/routes/dev/UiGallery.tsx';

const SRC = join(process.cwd(), 'src');

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(e)) yield p;
  }
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});
afterEach(cleanup);

describe('the /dev/ui gallery', () => {
  it('is registered only under import.meta.env.DEV, and only the router imports it', () => {
    const router = readFileSync(join(SRC, 'router.tsx'), 'utf8');
    expect(router).toMatch(/import\.meta\.env\.DEV\s*\?\s*\[[\s\S]*?path: '\/dev\/ui'[\s\S]*?\]\s*:\s*\[\]/);
    expect(router).toContain("import('./routes/dev/UiGallery.tsx')");
    const importers = [...sources(SRC)].filter((f) => /UiGallery/.test(readFileSync(f, 'utf8')) && !f.endsWith('UiGallery.tsx'));
    expect(importers.map((f) => f.slice(SRC.length))).toEqual(['/router.tsx']);
  });

  it('shows the primitives in a light and a dark panel', () => {
    render(<UiGallery />);
    const light = screen.getByTestId('gallery-light');
    const dark = screen.getByTestId('gallery-dark');
    expect(light.getAttribute('data-theme')).toBe('light');
    expect(dark.getAttribute('data-theme')).toBe('dark');
    for (const panel of [light, dark]) {
      for (const name of ['Secondary', 'Danger', 'Filter', 'Actions', 'ConfirmDialog']) expect(within(panel).getByRole('button', { name })).toBeTruthy();
      expect(within(panel).getByRole('combobox', { name: 'Gauge' })).toBeTruthy();
      expect(within(panel).getByRole('switch', { name: 'Autosave' })).toBeTruthy();
      expect(within(panel).getAllByRole('tab').length).toBeGreaterThan(1);
      // page anatomy: header, filters, a data table with a selected row and its side panel, an empty state
      expect(within(panel).getByRole('heading', { level: 1, name: 'Designs' })).toBeTruthy();
      expect(within(panel).getByRole('button', { name: /Filters/ })).toBeTruthy();
      expect(within(panel).getByRole('table', { name: 'Demo designs' })).toBeTruthy();
      expect(within(panel).getByRole('region', { name: 'Design details' })).toBeTruthy();
      expect(within(panel).getAllByTestId('empty-state').length).toBeGreaterThan(0);
    }
  });
});
