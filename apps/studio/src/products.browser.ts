/** Products and the lineup over the workbench API (`server/products.ts`). */

import type { Outcome } from '@wirehub/editor-react';
import type { Issue, LineupRow, PnSuggestion, ProductFamily } from '@wirehub/model';

import { request } from './definitions.browser.ts';

export const productsKey = ['products'] as const;
export const productKey = (id: string) => ['products', id] as const;
export const lineupKey = ['products', 'lineup'] as const;

export type ProductView = ProductFamily & { origin: 'local' | 'pack'; pack?: string };

export interface ProductsView {
  products: ProductView[];
  local: ProductFamily[];
  issues: Issue[];
  etag: string;
}

export interface ProductPage {
  product: ProductFamily;
  rows: LineupRow[];
  issues: Issue[];
}

export const fetchProducts = (base = '/api'): Promise<Outcome<ProductsView>> => request<ProductsView>(`${base}/products`);
export const saveProducts = (products: unknown[], etag: string, base = '/api'): Promise<Outcome<ProductsView>> =>
  request<ProductsView>(`${base}/products`, { method: 'PUT', body: { products }, headers: { 'if-match': etag } });
export const fetchProductPage = (id: string, base = '/api'): Promise<Outcome<ProductPage>> => request<ProductPage>(`${base}/products/${encodeURIComponent(id)}`);
export const mergeProducts = (into: string, from: string[], base = '/api'): Promise<Outcome<ProductsView>> =>
  request<ProductsView>(`${base}/products/${encodeURIComponent(into)}/merge`, { method: 'POST', body: { from } });
export const splitProduct = (from: string, variants: string[], next: { id: string; label: string; partNumber?: string }, base = '/api'): Promise<Outcome<ProductsView>> =>
  request<ProductsView>(`${base}/products/${encodeURIComponent(from)}/split`, { method: 'POST', body: { variants, ...next } });
export const nextVariantNumber = (id: string, base = '/api'): Promise<Outcome<{ scheme: string; suggestion: PnSuggestion | null }>> =>
  request<{ scheme: string; suggestion: PnSuggestion | null }>(`${base}/products/${encodeURIComponent(id)}/next-number`);
export const fetchLineup = (retired: boolean, base = '/api'): Promise<Outcome<{ rows: LineupRow[] }>> => request<{ rows: LineupRow[] }>(`${base}/lineup${retired ? '?retired=1' : ''}`);

export const unwrap = async <T,>(out: Promise<Outcome<T>>): Promise<T> => {
  const r = await out;
  if (!r.ok) throw new Error(`${r.message}${r.hint === undefined ? '' : ` ${r.hint}`}`);
  return r.value;
};
