/**
 * Shared, reusable image assets: the picker's own
 * types and pure logic.
 *
 * Owner: "Can we make things like photos reusable? I believe I currently
 * need to upload the image for connector if using one every time. Since
 * many drawings might use the same one it would be ideal to probably select
 * from existing assets."
 *
 * The host (the studio) keeps the actual store — content-addressed by
 * sha256, so identical uploads dedupe automatically the moment they are
 * saved (`apps/studio/server/assets.ts`). This package only needs to list
 * what exists and let the person filter it; it never learns a URL, exactly
 * like every other adapter here.
 *
 * "Recently used" is not part of the adapter on purpose: it is a fact about
 * *this browser*, not about the asset, so it is kept client-side
 * (`recentAssetIds`/`rememberAssetUsed`, backed by whatever storage the host
 * hands in — `localStorage` in the studio, a `Map` in tests) rather than
 * asked of the host at all.
 */

import type { Outcome } from './persistence.ts';

/** One image in the shared library, as the picker needs it. */
export interface SharedAsset {
  /** the sha256 of its bytes — content addressing is the whole dedup story */
  id: string;
  mime: 'image/png' | 'image/jpeg';
  /** the filename it first arrived under — what search matches */
  originalName: string;
  /** provenance, per the catalog convention every record carries one */
  src: string;
  /** byte size, for the picker's list */
  bytes: number;
  /** `data:image/…;base64,…` — the picker draws thumbnails from this directly */
  dataUri: string;
}

/**
 * How a host lets the picker see the shared library. Read-only on purpose:
 * new assets arrive by *using* them — saving a drawing photo already adds it
 * (and dedups it) — never through a picker-specific upload call.
 *
 * `recentIds`/`noteUsed` are optional and deliberately not about the asset
 * store itself: "recently used" is a fact about this browser, in this
 * session or two, not a thing worth writing into committed catalog data. A
 * host with nowhere to keep that (or a test) can leave them out; the picker
 * just shows every asset alphabetically instead of recent-first.
 */
export interface AssetsAdapter {
  list(): Promise<Outcome<SharedAsset[]>>;
  /** ids most recently picked in this browser, most-recent-first */
  recentIds?(): string[];
  noteUsed?(id: string): void;
}

export function matchesAssetQuery(asset: SharedAsset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return `${asset.originalName} ${asset.src}`.toLowerCase().includes(needle);
}

/** Bytes, human-sized: `68717` -> `"67 KB"`. */
export function formatAssetSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * "Recently used" ordering — a browser-only convenience; see
 * `AssetsAdapter.recentIds`/`noteUsed`. `RECENT_LIMIT` is exported so a
 * host's own storage (`apps/studio/src/assets.browser.ts`'s localStorage
 * list) caps itself the same way the picker orders things.
 * ------------------------------------------------------------------ */

export const RECENT_ASSETS_LIMIT = 12;

/** Most-recently-used first, capped, de-duplicated — the list a host's
 * `noteUsed` should store, given what it already had. */
export function withAssetUsed(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((existing) => existing !== id)].slice(0, RECENT_ASSETS_LIMIT);
}

/** Recently-used assets first (most recent first), then everything else, alphabetically. */
export function orderAssets(assets: readonly SharedAsset[], recentIds: readonly string[]): SharedAsset[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const recent = recentIds.map((id) => byId.get(id)).filter((asset): asset is SharedAsset => asset !== undefined);
  const recentSet = new Set(recent.map((asset) => asset.id));
  const rest = assets.filter((asset) => !recentSet.has(asset.id)).sort((a, b) => a.originalName.localeCompare(b.originalName));
  return [...recent, ...rest];
}
