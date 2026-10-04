/**
 * TanStack Query keys and query functions for the studio's server state: the
 * design list, one design as stored, and the definitions db.
 *
 * The workbench API is the only source of truth for anything editable. When
 * it cannot be reached, these fall back to the last answer this browser
 * fetched (`offline-cache.browser.ts`; the bundle carries no catalog data,
 *), and say so (`offline` / `live: false` / `offlineCopy`),
 * so the screens can show that copy **read-only** under a banner — never as
 * the baseline of a save (review fix, 2026-09-26: a stale bundled design saved
 * over newer server data). Every function is a query function that never
 * throws rather than a `useState`/`useEffect` pair. Nothing
 * here is a hook: `studio-context.tsx` is the only place that calls
 * `useQuery`/`useMutation`, so these stay easy to call from a test without a
 * component tree.
 */

import type { CableDesign, Db } from '@cable-studio/model';
import type { DesignSummary, PersistenceAdapter } from '@cable-studio/editor-react';

import { EMPTY_DB } from './catalog.browser.ts';
import type { CableListEntry } from './cable-list.ts';
import { fetchDb } from './definitions.browser.ts';
import { recall, remember } from './offline-cache.browser.ts';
import { fetchCableList } from './persistence.browser.ts';

/** every design the workbench knows about, for the cables list and pickers */
export const designsKey = ['studio', 'designs'] as const;
/** `/cables`' rows — source/destination/wire/boards/parts/joints, per design */
export const cableListKey = ['studio', 'cableList'] as const;
/** the parts library, assembled from every definition kind */
export const dbKey = ['studio', 'db'] as const;
/** one design's stored document */
export function designKey(id: string): readonly [string, string, string] {
  return ['studio', 'design', id] as const;
}

export interface DesignsQueryData {
  designs: DesignSummary[];
  /** the workbench could not be reached — `designs` is this browser's last copy (or empty) */
  offline: boolean;
}

export async function loadDesigns(persistence: PersistenceAdapter): Promise<DesignsQueryData> {
  const result = await persistence.list();
  if (result.ok) {
    void remember('designs', result.value);
    return { designs: result.value, offline: false };
  }
  return { designs: (await recall<DesignSummary[]>('designs'))?.value ?? [], offline: true };
}

export interface CableListQueryData {
  entries: CableListEntry[];
  /** the workbench could not be reached — `entries` is this browser's last copy (or empty) */
  offline: boolean;
}

export async function loadCableList(): Promise<CableListQueryData> {
  const result = await fetchCableList();
  if (result.ok) {
    void remember('cable-list', result.value);
    return { entries: result.value, offline: false };
  }
  return { entries: (await recall<CableListEntry[]>('cable-list'))?.value ?? [], offline: true };
}

export interface DesignQueryData {
  /**
   * The design as the workbench has it now — the only copy an editor may
   * start from. `undefined` with no `loadError`: the workbench says there is
   * no such design.
   */
  design: CableDesign | undefined;
  /** the workbench could not answer (unreachable, 5xx): `design` is undefined */
  loadError?: string;
  /**
   * With `loadError`: the last copy of this design this browser fetched —
   * shown read-only under a banner, never saved.
   */
  offlineCopy?: CableDesign;
}

export async function loadDesign(persistence: PersistenceAdapter, id: string): Promise<DesignQueryData> {
  const result = await persistence.load(id);
  if (result.ok) {
    void remember(`design:${id}`, result.value);
    return { design: result.value };
  }
  if (result.status === 404) return { design: undefined };
  const offlineCopy = (await recall<CableDesign>(`design:${id}`))?.value;
  return { design: undefined, loadError: result.message, ...(offlineCopy === undefined ? {} : { offlineCopy }) };
}

export interface DbQueryData {
  db: Db;
  /** false: the workbench could not be reached and `db` is this browser's last copy (or empty) */
  live: boolean;
}

export async function loadDb(): Promise<DbQueryData> {
  const fresh = await fetchDb();
  if (fresh !== undefined) {
    void remember('db', fresh);
    return { db: fresh, live: true };
  }
  return { db: (await recall<Db>('db'))?.value ?? EMPTY_DB, live: false };
}
