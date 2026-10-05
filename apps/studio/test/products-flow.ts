/**
 * Products, the lineup and routes over the API, one flow for both backends (`products.server.test.ts`,
 * `pg/products.server.test.ts`): families of starter designs with option axes and variant numbers,
 * a refused list, a product page, the scheme's next variant number, merge and split, the lineup as
 * JSON and CSV with a released revision and a route, and `product.changed` for every change.
 */

import { validateDesign, type CableDesign, type Db } from '@wirehub/model';
import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';

export const OWNER: StudioUser = { name: 'Olive Owner', source: 'session', role: 'owner' };

export interface ProductsFlowHooks {
  call: (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array; events?: { type: string; subject: { id: string } }[] }>;
  /** the events the hub raised so far, by type and subject id */
  events: () => string[];
}

const SRC = 'synthetic example';
const DC_LEADS = {
  id: 'dc-leads',
  label: 'DC leads',
  partNumber: 'CBL-00090-XX',
  options: [{ id: 'colour', label: 'Colour', values: [{ id: 'black', label: 'Black' }, { id: 'red', label: 'Red' }] }],
  variants: [
    { id: 'led', label: 'LED lead', design: 'dc-led-lead', partNumber: 'CBL-00090-01', options: { colour: 'black' } },
    { id: 'pigtail', label: 'Pigtail lead', design: 'dc-pigtail-lead', partNumber: 'CBL-00090-02', lengthMm: 300, options: { colour: 'red' } },
  ],
  src: SRC,
};
const Y_LEADS = { id: 'y-leads', label: 'Y leads', aliases: ['Splitter'], variants: [{ id: 'y', design: 'dc-y-splitter' }], src: SRC };

export async function runProductsFlow({ call, events }: ProductsFlowHooks): Promise<void> {
  const empty = await call('GET', '/api/products', undefined, OWNER);
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  expect(empty.body.products).toEqual([]);
  const tag = empty.headers?.ETag ?? '';

  // a variant naming a design that does not exist is refused, nothing saved
  const bad = await call('PUT', '/api/products', { products: [{ ...DC_LEADS, variants: [{ id: 'x', design: 'no-such-design' }] }] }, OWNER, { 'if-match': tag });
  expect(bad.status).toBe(422);
  expect((await call('PUT', '/api/products', { products: [DC_LEADS] }, OWNER)).status).toBe(428);

  const saved = await call('PUT', '/api/products', { products: [DC_LEADS, Y_LEADS] }, OWNER, { 'if-match': tag });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.products.map((p: any) => [p.id, p.origin])).toEqual([
    ['dc-leads', 'local'],
    ['y-leads', 'local'],
  ]);
  // nothing is released yet: every sold variant says so
  expect(saved.body.issues.filter((i: any) => i.code === 'product-variant-unreleased').length).toBe(3);
  expect(events().filter((e) => e.startsWith('product.changed')).sort()).toEqual(['product.changed:dc-leads', 'product.changed:y-leads']);

  // the product page: each variant with its design, length and options
  const page = await call('GET', '/api/products/dc-leads', undefined, OWNER);
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  expect(page.body.rows.map((r: any) => [r.variant, r.partNumber, r.options.colour])).toEqual([
    ['led', 'CBL-00090-01', 'Black'],
    ['pigtail', 'CBL-00090-02', 'Red'],
  ]);
  expect(page.body.rows[1].lengthMm).toBe(300);
  expect((await call('GET', '/api/products/no-such', undefined, OWNER)).status).toBe(404);
  const next = await call('GET', '/api/products/dc-leads/next-number', undefined, OWNER);
  expect(next.status, JSON.stringify(next.body)).toBe(200);

  // a released revision and a route show in the lineup
  const version = await call('POST', '/api/designs/dc-led-lead/versions', { note: 'first release' }, OWNER);
  expect(version.status, JSON.stringify(version.body)).toBeLessThan(300);
  const lead = await call('GET', '/api/designs/dc-led-lead', undefined, OWNER);
  const bought: CableDesign = { ...(lead.body as CableDesign), route: 'contract' };
  const put = await call('PUT', '/api/designs/dc-led-lead', bought, OWNER, { 'if-match': lead.headers?.ETag ?? '' });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const db = (await call('GET', '/api/db', undefined, OWNER)).body as Db;
  expect(validateDesign(bought, db).map((i) => i.code)).toContain('route-contract-no-maker');
  const lineup = await call('GET', '/api/lineup', undefined, OWNER);
  expect(lineup.status).toBe(200);
  const ledRow = lineup.body.rows.find((r: any) => r.variant === 'led');
  expect(ledRow).toMatchObject({ product: 'dc-leads', design: 'dc-led-lead', route: 'contract' });
  expect(typeof ledRow.releasedRev).toBe('number');
  expect(lineup.body.rows.find((r: any) => r.variant === 'pigtail').releasedRev).toBeUndefined();
  const csv = await call('GET', '/api/lineup.csv', undefined, OWNER);
  expect(csv.status).toBe(200);
  const text = new TextDecoder().decode(csv.bytes);
  expect(text.split('\r\n')[0]).toMatch(/^product,product_label,product_part_number,variant,/);
  expect(text).toContain('option_colour');
  expect(text).toContain('CBL-00090-01');

  // merge: the Y leads become variants of the DC leads, their name an alias
  const merged = await call('POST', '/api/products/dc-leads/merge', { from: ['y-leads'] }, OWNER);
  expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  const dc = merged.body.products.find((p: any) => p.id === 'dc-leads');
  expect(dc.variants.map((v: any) => v.id)).toEqual(['led', 'pigtail', 'y']);
  expect(dc.aliases).toEqual(expect.arrayContaining(['y-leads', 'Y leads', 'Splitter']));
  expect(merged.body.products.some((p: any) => p.id === 'y-leads')).toBe(false);
  expect((await call('POST', '/api/products/dc-leads/merge', { from: ['dc-leads'] }, OWNER)).status).toBe(422);

  // split: the Y variant goes off on its own again
  const split = await call('POST', '/api/products/dc-leads/split', { variants: ['y'], id: 'splitters', label: 'Splitters' }, OWNER);
  expect(split.status, JSON.stringify(split.body)).toBe(200);
  expect(split.body.products.map((p: any) => [p.id, p.variants.length])).toEqual([
    ['dc-leads', 2],
    ['splitters', 1],
  ]);
  expect(events().filter((e) => e === 'product.changed:splitters')).toHaveLength(1);
}
