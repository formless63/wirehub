/** Dated supplier offers over the workbench API (`server/sourcing/api.ts`). */

import type { Outcome } from '@wirehub/editor-react';

import type { Offer } from '../server/sourcing/offers.ts';
import type { CostPart, LineCost, SourcingLine, SourcingSummary, Waste } from '../server/sourcing/rollup.ts';
import type { ItemRef } from './inventory.browser.ts';
import { request } from './definitions.browser.ts';

export type { CostPart, LineCost, Offer, SourcingLine, SourcingSummary, Waste };

export const offersKey = (item: ItemRef) => ['inventory', 'offers', item.kind, item.id] as const;

const base = '/api/inventory/offers';

export const fetchOffers = (item: ItemRef): Promise<Outcome<{ offers: Offer[] }>> => request<{ offers: Offer[] }>(`${base}?item=${encodeURIComponent(`${item.kind}:${item.id}`)}`);
export const addOffer = (input: { item: ItemRef; supplier: string; offeredOn?: string; price?: number; currency?: string; unit: string; pack?: number; supplierRef?: string; note?: string }): Promise<Outcome<{ offer: Offer }>> =>
  request(base, { method: 'POST', body: input });
export const deleteOffer = (offer: Offer): Promise<Outcome<{ deleted: string }>> => request(`${base}/${encodeURIComponent(offer.id)}`, { method: 'DELETE' });

/** `12.40 USD`; no currency named → just the number. */
export function money(amount: number, currency?: string): string {
  const text = amount >= 100 ? amount.toFixed(0) : amount.toFixed(2);
  return currency === undefined || currency === '' ? text : `${text} ${currency}`;
}

/** Totals per currency, `12.40 USD + 3.00 EUR`. */
export function totalsText(totals: Readonly<Record<string, number>>): string {
  return Object.entries(totals).map(([c, a]) => money(a, c)).join(' + ');
}
