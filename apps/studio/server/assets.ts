/**
 * Shared, content-addressed image assets.
 *
 * Owner: "Can we make things like photos reusable? I believe I currently
 * need to upload the image for connector if using one every time. Since
 * many drawings might use the same one it would be ideal to probably select
 * from existing assets."
 *
 * `drawings.ts`'s product photo was the concrete case: each design kept its
 * own copy (`drawings/<id>.photo.png`), so ten drawings sharing one physical
 * photo meant ten identical files (`pnpm --filter studio test -- assets`
 * proves this against the real catalog data, and it was true before this
 * change — see the migration script this file's history references).
 *
 * The fix is content addressing, not a new kind of record: an asset's id
 * *is* the sha256 of its bytes, so saving the same photo twice — from two
 * different drawings, or the same drawing twice — is a no-op the second
 * time. Kept as committed, deterministic catalog data, same as every other
 * `packages/catalog/data/` file:
 *
 *   packages/catalog/data/assets/index.json      one entry per unique file
 *   packages/catalog/data/assets/<sha256>.<ext>  the bytes, named by hash
 *
 * "Recently used" is deliberately *not* here — it depends on which browser
 * and in what order, which is not a fact about the asset. The picker keeps
 * it client-side (`apps/studio/src/assets.browser.ts`), the same way
 * `layout.browser.ts` keeps pane sizes out of the committed data.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { writeFileAtomic } from './atomic-write.ts';
import type { Awaitable } from './storage/change-set.ts';

/**
 * What the store holds: images (drawing photos, 50a.36) and, since
 * a manufacturer's PDF datasheets — a wire stock's
 * vendor documents, copied in so they open in-app. Since * 3D models too: a GLB (every STEP and STL is converted to one on the way in,
 * `models/convert.ts`) or, should one be stored as sent, an STL.
 */
export const ASSET_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'model/gltf-binary': 'glb',
  'model/stl': 'stl',
} as const;
export type AssetMime = keyof typeof ASSET_MIME_EXT;

/** What the picker (and everything else) gets to know about a shared asset. */
export interface AssetSummary {
  /** the sha256 of the bytes, hex — this *is* the identity */
  id: string;
  mime: AssetMime;
  /** the filename it first arrived under — search matches this */
  originalName: string;
  /** provenance, per the catalog convention every record carries one */
  src: string;
  /** byte size, for the picker's list — not the content */
  bytes: number;
}

export interface AssetStore {
  list(): Awaitable<AssetSummary[]>;
  /** the record and its bytes, or `undefined` when the id names nothing */
  get(id: string): Awaitable<{ record: AssetSummary; bytes: Buffer } | undefined>;
  /**
   * Dedups by content: identical bytes, from any caller, return the existing
   * record untouched (same id, nothing written) rather than a second copy.
   */
  put(bytes: Buffer, mime: AssetMime, originalName: string, src: string): Awaitable<AssetSummary>;
}

function indexPath(): string {
  return dataPath('assets/index.json');
}

function assetPath(id: string, mime: AssetMime): string {
  return dataPath(`assets/${id}.${ASSET_MIME_EXT[mime]}`);
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readIndex(): AssetSummary[] {
  const path = indexPath();
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as AssetSummary[]) : [];
}

function writeIndex(records: AssetSummary[]): void {
  const path = indexPath();
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const next = `${JSON.stringify(sorted, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === next) return;
  writeFileAtomic(path, next, 'utf8');
}

/** The committed catalog tree as the store. */
export function fileAssetStore(): AssetStore {
  return {
    list: () => readIndex(),
    get(id) {
      const record = readIndex().find((r) => r.id === id);
      if (record === undefined) return undefined;
      const path = assetPath(id, record.mime);
      if (!existsSync(path)) return undefined;
      return { record, bytes: readFileSync(path) };
    },
    put(bytes, mime, originalName, src) {
      const id = sha256Of(bytes);
      const records = readIndex();
      const existing = records.find((r) => r.id === id);
      if (existing !== undefined) return existing;
      const record: AssetSummary = { id, mime, originalName, src, bytes: bytes.length };
      const path = assetPath(id, mime);
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, bytes);
      writeIndex([...records, record]);
      return record;
    },
  };
}

/** In memory, for tests — same dedup-by-content behaviour. */
export function memoryAssetStore(): AssetStore & { files: Map<string, Buffer> } {
  const records: AssetSummary[] = [];
  const files = new Map<string, Buffer>();
  return {
    files,
    list: () => [...records],
    get(id) {
      const record = records.find((r) => r.id === id);
      const bytes = record === undefined ? undefined : files.get(id);
      return record === undefined || bytes === undefined ? undefined : { record, bytes };
    },
    put(bytes, mime, originalName, src) {
      const id = sha256Of(bytes);
      const existing = records.find((r) => r.id === id);
      if (existing !== undefined) return existing;
      const record: AssetSummary = { id, mime, originalName, src, bytes: bytes.length };
      records.push(record);
      files.set(id, bytes);
      return record;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Image bytes <-> data URI — shared with `drawings.ts`'s photo field so
 * there is one place that knows what an acceptable image upload looks like.
 * ------------------------------------------------------------------ */

const IMAGE_DATA_URI = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/;

export function decodeImageDataUri(value: string): { mime: 'image/png' | 'image/jpeg'; bytes: Buffer } | undefined {
  const match = IMAGE_DATA_URI.exec(value);
  if (match === null) return undefined;
  return { mime: match[1] as 'image/png' | 'image/jpeg', bytes: Buffer.from(match[2] ?? '', 'base64') };
}

/** A 3D model (the Library's 3D view, 50a.55) — never a photo, never a vendor document. */
export function isModelAsset(summary: Pick<AssetSummary, 'mime'>): boolean {
  return summary.mime.startsWith('model/');
}

/** An image the photo picker can show (a PDF is a document, not a photo). */
export function isImageAsset(summary: Pick<AssetSummary, 'mime'>): boolean {
  return summary.mime.startsWith('image/');
}

export function assetDataUri(mime: AssetMime, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export async function assetSummaryWithDataUri(store: AssetStore, id: string): Promise<(AssetSummary & { dataUri: string }) | undefined> {
  const found = await store.get(id);
  if (found === undefined) return undefined;
  return { ...found.record, dataUri: assetDataUri(found.record.mime, found.bytes) };
}
