// @vitest-environment jsdom
/** The products pages: the family list, a family's variants, adding a variant, the lineup tab. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProductFamily } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

const LEADS: ProductFamily = {
  id: 'dc-leads',
  label: 'DC leads',
  partNumber: 'CBL-00090-XX',
  aliases: ['Power leads', 'CBL-00012'],
  options: [{ id: 'colour', label: 'Colour', values: [{ id: 'black', label: 'Black' }, { id: 'red', label: 'Red' }] }],
  variants: [{ id: 'led', label: 'Indicator lead', design: 'dc-led-lead', partNumber: 'CBL-00090-01', options: { colour: 'black' } }],
  src: 'synthetic example',
};

async function serve(): Promise<void> {
  deps = { ...memoryWriteBackend(undefined, join(DATA, '..')).deps, loadPartNumberFiles: () => ({}) };
  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) }, deps);
  const first = await call('GET', '/api/products');
  expect((await call('PUT', '/api/products', { products: [LEADS] }, { 'if-match': first.headers?.ETag ?? '' })).status).toBe(200);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest(
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}), headers: Object.fromEntries(new Headers(init?.headers).entries()) },
      deps,
    );
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = (at: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [at] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe('products', () => {
  it('keeps New product prominent from either section and exposes keyboard tab state', async () => {
    await serve(); mount('/products');
    await screen.findByTestId('product-list');
    const families=screen.getByRole('tab',{name:'Families'}), lineup=screen.getByRole('tab',{name:'Lineup'});
    families.focus();fireEvent.keyDown(families,{key:'ArrowRight'});
    expect(lineup.getAttribute('aria-selected')).toBe('true');expect(document.activeElement).toBe(lineup);
    const panel=screen.getByRole('tabpanel');expect(panel.getAttribute('aria-labelledby')).toBe(lineup.id);
    const create=screen.getByRole('button',{name:'New product…'});
    expect(create.classList.contains('cs-route-action-primary')).toBe(true);
    fireEvent.click(create);
    expect(families.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('textbox',{name:'Product record'})).toBeTruthy();
  });

  it('lists the families and shows the lineup', async () => {
    await serve();
    mount('/products');
    const list = await screen.findByTestId('product-list');
    expect(list.textContent).toContain('DC leads');
    expect(list.textContent).toContain('CBL-00090-XX');
    fireEvent.click(screen.getByRole('tab', { name: 'Lineup' }));
    const lineup = await screen.findByTestId('lineup');
    expect(within(lineup).getByText('CBL-00090-01')).toBeTruthy();
  });

  it('shows membership in the list and header and searches aliases in Quick open', async () => {
    await serve();
    mount('/cables');
    await screen.findByText('DC leads · Indicator lead');
    expect(screen.getByText('PRODUCT')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter cables' }), { target: { value: 'Power leads' } });
    await vi.waitFor(() => {
      const cables = document.querySelectorAll('a[href^="/cables/"]');
      expect([...cables].map((a) => a.getAttribute('href'))).toEqual(['/cables/dc-led-lead']);
    });
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Quick open' });
    const search = within(dialog).getByPlaceholderText('Search…');
    for (const alias of ['Power leads', 'Indicator lead', 'CBL-00012', 'CBL-00090-01']) {
      fireEvent.change(search, { target: { value: alias } });
      await vi.waitFor(() => {
        const results = dialog.querySelectorAll('[cmdk-item][data-value^="cable:"]');
        expect([...results].map((r) => r.getAttribute('data-value'))).toEqual(['cable:dc-led-lead']);
      });
    }
    fireEvent.click(dialog.querySelector('[data-value="cable:dc-led-lead"]')!);
    const membership = await screen.findByLabelText('Product membership');
    const family = within(membership).getByRole('link', { name: 'DC leads · Indicator lead' });
    expect(family.getAttribute('href')).toBe('/products/dc-leads');
    fireEvent.click(family);
    expect((await screen.findByTestId('product-page')).textContent).toContain('CBL-00090-01');
  });

  it('adds a variant on the family page', async () => {
    await serve();
    mount('/products/dc-leads');
    const page = await screen.findByTestId('product-page');
    expect(page.textContent).toContain('CBL-00090-01');
    fireEvent.click(screen.getByRole('button', { name: 'Add a variant…' }));
    await vi.waitFor(() => expect(within(screen.getByLabelText('Variant design')).getAllByRole('option').length).toBeGreaterThan(2));
    fireEvent.change(screen.getByLabelText('Variant design'), { target: { value: 'dc-pigtail-lead' } });
    fireEvent.change(screen.getByLabelText('Variant number'), { target: { value: 'CBL-00090-02' } });
    fireEvent.change(screen.getByLabelText('Variant Colour'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(async () => {
      const stored = (await handleWorkbenchRequest({ method: 'GET', path: '/api/products/dc-leads' }, deps)).body as { product: ProductFamily };
      expect(stored.product.variants.map((v) => [v.id, v.partNumber, v.options?.['colour']])).toEqual([
        ['led', 'CBL-00090-01', 'black'],
        ['dc-pigtail-lead', 'CBL-00090-02', 'red'],
      ]);
    });
    // The palette was mounted before this edit; it must see the updated memberships.
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Quick open' });
    fireEvent.change(within(dialog).getByPlaceholderText('Search…'), { target: { value: 'Power leads' } });
    await vi.waitFor(() => {
      const results = dialog.querySelectorAll('[cmdk-item][data-value^="cable:"]');
      expect([...results].map((r) => r.getAttribute('data-value')).sort()).toEqual(['cable:dc-led-lead', 'cable:dc-pigtail-lead']);
    });
  });
});
