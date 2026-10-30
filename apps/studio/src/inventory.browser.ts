/** Workshop inventory over the workbench API (`server/inventory/api.ts`, `docs/inventory.md`). */

import type { Outcome } from '@wirehub/editor-react';
import type { MassMissing, MassValue } from '@wirehub/model';

import type { ShortageLine } from '../server/inventory/requirements.ts';
import type { Allowance, Batch as StoredBatch, Dimension, ItemKind, ItemRef, Location, Lot, Measured, Movement, Reservation } from '../server/inventory/types.ts';
import type { SourcingSummary } from '../server/sourcing/rollup.ts';
import { request } from './definitions.browser.ts';

/** A batch as the API answers it: a measured unit mass carries the derived estimate beside it (`docs/mass.md`). */
export type Batch = StoredBatch & { massEstimate?: MassValue };

export type { Allowance, Dimension, ItemKind, ItemRef, Location, Lot, Measured, Movement, Reservation, ShortageLine };

export const inventoryKey = ['inventory'] as const;
export const itemStockKey = (item: ItemRef) => ['inventory', 'item', item.kind, item.id] as const;
export const buildKey = (design: string, qty: number, allowance: Allowance, explode = false) => ['inventory', 'build', design, qty, allowance.perCutMm, allowance.pct, explode] as const;

export interface InventoryView {
  backend: 'pg' | 'files' | 'memory';
  units: Record<Dimension, string[]>;
  locations: Location[];
  lots: Lot[];
  labels: Record<string, string>;
  reservations: Reservation[];
}

export interface ItemStock {
  item: ItemRef;
  lots: Lot[];
  locations: Location[];
  reservations: Reservation[];
  movements: Movement[];
  batches: Batch[];
}

export interface BuildView {
  design: string;
  label: string;
  buildQty: number;
  allowance: Allowance;
  lines: ShortageLine[];
  gaps: string[];
  reservations: Reservation[];
  locations: Location[];
  batches: Batch[];
  /** optional cost and cut-stock projection (`server/sourcing/rollup.ts`) */
  sourcing?: SourcingSummary;
  /** one unit's derived mass and what it is missing (`docs/mass.md`) */
  massEstimate?: MassValue & { missing: MassMissing[] };
}

const base = '/api/inventory';
const enc = encodeURIComponent;
const post = <T,>(path: string, body: unknown, etag?: string): Promise<Outcome<T>> =>
  request<T>(`${base}${path}`, { method: 'POST', body, ...(etag === undefined ? {} : { headers: { 'if-match': etag } }) });
const tag = (r: { id: string; version: number }): string => `"${r.id}.v${r.version}"`;

export const fetchInventory = (empty = false): Promise<Outcome<InventoryView>> => request<InventoryView>(`${base}${empty ? '?empty=1' : ''}`);
export const fetchItemStock = (item: ItemRef): Promise<Outcome<ItemStock>> => request<ItemStock>(`${base}/items/${enc(item.kind)}/${enc(item.id)}?empty=1`);
export const fetchMovements = (filter: { lot?: string; limit?: number } = {}): Promise<Outcome<{ movements: Movement[]; labels?: Record<string, string> }>> =>
  request<{ movements: Movement[]; labels?: Record<string, string> }>(`${base}/movements?limit=${filter.limit ?? 200}${filter.lot === undefined ? '' : `&lot=${enc(filter.lot)}`}`);
export const fetchBuild = (design: string, qty: number, allowance: Allowance, explode = false): Promise<Outcome<BuildView>> =>
  request<BuildView>(`${base}/builds/${enc(design)}?qty=${qty}&perCutMm=${allowance.perCutMm}&pct=${allowance.pct}${explode ? '&explode=1' : ''}`);

export const fetchBatches = (filter: { item?: ItemRef; limit?: number } = {}): Promise<Outcome<{ batches: Batch[]; labels?: Record<string, string> }>> =>
  request<{ batches: Batch[]; labels?: Record<string, string> }>(`${base}/batches?limit=${filter.limit ?? 200}${filter.item === undefined ? '' : `&item=${enc(`${filter.item.kind}:${filter.item.id}`)}`}`);
export const batchesKey = (item?: ItemRef) => (item === undefined ? (['inventory', 'batches'] as const) : (['inventory', 'batches', item.kind, item.id] as const));

export const createLocation = (name: string, parent?: string): Promise<Outcome<{ location: Location }>> => post('/locations', { name, ...(parent === undefined ? {} : { parent }) });
export const updateLocation = (location: Location, patch: { name?: string; parent?: string | null; note?: string | null }): Promise<Outcome<{ location: Location }>> =>
  request(`${base}/locations/${enc(location.id)}`, { method: 'PATCH', body: patch, headers: { 'if-match': tag(location) } });
export const deleteLocation = (location: Location): Promise<Outcome<{ deleted: string }>> =>
  request(`${base}/locations/${enc(location.id)}`, { method: 'DELETE', headers: { 'if-match': tag(location) } });
export const editLot = (lot: Lot, patch: { lotCode?: string | null; supplier?: string | null; supplierRef?: string | null; unitCost?: number | null; unit?: string; currency?: string | null; note?: string | null }): Promise<Outcome<{ lot: Lot }>> =>
  request(`${base}/lots/${enc(lot.id)}`, { method: 'PATCH', body: patch, headers: { 'if-match': tag(lot) } });

/** A batch's details as the forms send them. */
export interface BatchForm {
  units: number;
  failed?: number;
  batchCode?: string;
  serials?: string[];
  measured?: Measured;
  into?: string;
  note?: string;
}
export const completeUnits = (r: Reservation, input: BatchForm): Promise<Outcome<{ reservation: Reservation; batch: Batch }>> => post(`/reservations/${enc(r.id)}/complete`, input, tag(r));
export const recordBatch = (input: BatchForm & { item: ItemRef; variant?: string; consume: { lot: string; qty: number; unit: string }[] }): Promise<Outcome<{ batch: Batch }>> => post('/batches', input);

export const receiveStock = (input: { item: ItemRef; qty: number; unit: string; location: string; lotCode?: string; supplier?: string; supplierRef?: string; unitCost?: number; currency?: string; note?: string }): Promise<Outcome<{ lot: Lot }>> =>
  post('/receive', input);
export const moveLot = (lot: Lot, to: string, qty?: { qty: number; unit: string }): Promise<Outcome<{ lot: Lot; split?: Lot }>> => post(`/lots/${enc(lot.id)}/move`, { to, ...(qty ?? {}) }, tag(lot));
export const adjustLot = (lot: Lot, input: { count?: number; delta?: number; unit: string; reason?: string }): Promise<Outcome<{ lot: Lot }>> => post(`/lots/${enc(lot.id)}/adjust`, input, tag(lot));
export const reserveBuild = (design: string, qty: number, allowance: Allowance, explode = false, label?: string): Promise<Outcome<{ reservation: Reservation }>> =>
  post('/reservations', { design, qty, ...allowance, ...(explode ? { explode } : {}), ...(label === undefined ? {} : { label }) });
export const consumeUnits = (r: Reservation, units: number): Promise<Outcome<{ reservation: Reservation }>> => post(`/reservations/${enc(r.id)}/consume`, { units }, tag(r));
export const returnLeftover = (r: Reservation, lot: string, qty: number, unit: string): Promise<Outcome<{ reservation: Reservation }>> => post(`/reservations/${enc(r.id)}/return`, { lot, qty, unit });
export const releaseReservation = (r: Reservation): Promise<Outcome<{ reservation: Reservation }>> => post(`/reservations/${enc(r.id)}/release`, {}, tag(r));

/* ------------------------------------------------------------------ *
 * Quantities
 * ------------------------------------------------------------------ */

const trim = (n: number, places: number): string => String(Math.round(n * 10 ** places) / 10 ** places);

/** A base quantity as a person reads it: `12`, `5.36 m`, `750 g`. */
export function formatQty(value: number, dim: Dimension): string {
  if (dim === 'count') return trim(value, 3);
  if (dim === 'length') return Math.abs(value) >= 1000 ? `${trim(value / 1000, 3)} m` : `${trim(value, 1)} mm`;
  if (dim === 'volume') return Math.abs(value) >= 1000 ? `${trim(value / 1000, 3)} l` : `${trim(value, 1)} ml`;
  return Math.abs(value) >= 1000 ? `${trim(value / 1000, 3)} kg` : `${trim(value, 1)} g`;
}

/** Seconds as `3 h 05 min` / `12 min`. */
export function formatDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** The imperial reading of a length, for a tooltip. */
export function feetOf(mm: number): string {
  const inches = Math.round((mm / 25.4) * 10) / 10;
  const ft = Math.floor(inches / 12);
  return ft === 0 ? `${inches} in` : `${ft} ft ${Math.round((inches - ft * 12) * 10) / 10} in`;
}

export const DIM_UNITS: Readonly<Record<Dimension, readonly string[]>> = { count: ['ea'], length: ['m', 'mm', 'cm', 'ft', 'in'], mass: ['g', 'kg', 'oz', 'lb'], volume: ['ml', 'l'] };
export const UNIT_FACTOR: Readonly<Record<string, number>> = { ea: 1, mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, ml: 1, l: 1000 };

/** Locations as `Workshop › Shelf A › Bin 1`, for a picker. */
export function locationPaths(locations: readonly Location[]): Map<string, string> {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const out = new Map<string, string>();
  for (const l of locations) {
    const names: string[] = [];
    for (let at: Location | undefined = l, guard = 0; at !== undefined && guard < 32; at = at.parent === undefined ? undefined : byId.get(at.parent), guard++) names.unshift(at.name);
    out.set(l.id, names.join(' › '));
  }
  return out;
}

export const unwrap = async <T,>(out: Promise<Outcome<T>>): Promise<T> => {
  const r = await out;
  if (!r.ok) throw new Error(`${r.message}${r.hint === undefined ? '' : ` ${r.hint}`}`);
  return r.value;
};
