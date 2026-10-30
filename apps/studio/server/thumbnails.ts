/**
 * Server thumbnails of stored photos (`specs/knowledge.md`): a note's gallery shows a small PNG
 * instead of the full photo. Derived data, keyed by the photo's sha256, the size and
 * `THUMBNAIL_VERSION`, so it can always be rebuilt from the stored photo:
 *
 * - files: `packages/catalog/data/.thumb-cache/<sha>-<size>.png` (gitignored, like `.model-cache`);
 * - Postgres: a derived blob (`derived_blob`, cache `thumbnail`, key = the photo's sha256,
 *   part = the size), expired by the blob GC when its photo is no longer an asset (`pg/gc.ts`).
 *
 * Drawn by the rasteriser the hub already ships (`@resvg/resvg-js`): the photo is placed in an
 * SVG `<image>` turned by its EXIF orientation, so a thumbnail stands the way the photo does.
 * The PNG it writes carries no metadata at all.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';

import { writeFileAtomic } from './atomic-write.ts';
import { jpegOrientation } from './image-metadata.ts';
import type { Awaitable } from './storage/change-set.ts';

/** Bump when the drawing changes: every cached thumbnail is rebuilt (pg: the old rows expire). */
export const THUMBNAIL_VERSION = 'thumb-png-1';
/** The longest side of a gallery thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 320;
/** Decoding more than this many pixels for a thumbnail is refused (a decompression bomb). */
export const MAX_THUMBNAIL_SOURCE_PIXELS = 80_000_000;

export interface ThumbnailCache {
  get(asset: string, size: number): Awaitable<Buffer | undefined>;
  put(asset: string, size: number, png: Uint8Array): Awaitable<void>;
}

const SHA = /^[0-9a-f]{64}$/;

export function fileThumbnailCache(dir = dataPath('.thumb-cache')): ThumbnailCache {
  const path = (asset: string, size: number): string => {
    if (!SHA.test(asset) || !Number.isInteger(size)) throw new Error(`not a thumbnail key: ${asset}`);
    return join(dir, `${asset}-${size}-${THUMBNAIL_VERSION}.png`);
  };
  return {
    get: (asset, size) => (SHA.test(asset) && existsSync(path(asset, size)) ? readFileSync(path(asset, size)) : undefined),
    put(asset, size, png) {
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(path(asset, size), png);
    },
  };
}

export function memoryThumbnailCache(): ThumbnailCache & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    get: (asset, size) => files.get(`${asset}-${size}`),
    put: (asset, size, png) => void files.set(`${asset}-${size}`, Buffer.from(png)),
  };
}

/** Width and height of a PNG or JPEG from its header, or undefined. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') return data.length >= 24 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : undefined;
  if (mime !== 'image/jpeg') return undefined;
  let at = 2;
  while (at + 9 < data.length && data[at] === 0xff) {
    const marker = data[at + 1] as number;
    const length = data.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    if (marker === 0xda) return undefined;
    at += 2 + length;
  }
  return undefined;
}

/** The SVG transform that stands a w×h picture with EXIF orientation `o` the right way up. */
function orient(o: number, w: number, h: number): string {
  switch (o) {
    case 2: return `matrix(-1 0 0 1 ${w} 0)`;
    case 3: return `matrix(-1 0 0 -1 ${w} ${h})`;
    case 4: return `matrix(1 0 0 -1 0 ${h})`;
    case 5: return 'matrix(0 1 1 0 0 0)';
    case 6: return `matrix(0 1 -1 0 ${h} 0)`;
    case 7: return `matrix(0 -1 -1 0 ${h} ${w})`;
    case 8: return `matrix(0 -1 1 0 0 ${w})`;
    default: return '';
  }
}

/** Draw a thumbnail (PNG, longest side `size`) of a stored photo. Throws when it cannot. */
export async function renderThumbnail(bytes: Uint8Array, mime: string, size = THUMBNAIL_SIZE): Promise<Uint8Array> {
  const dims = imageSize(bytes, mime);
  if (dims === undefined || dims.width < 1 || dims.height < 1) throw new Error('The photo has no readable size.');
  if (dims.width * dims.height > MAX_THUMBNAIL_SOURCE_PIXELS) throw new Error('The photo is too large to draw a thumbnail of.');
  const o = mime === 'image/jpeg' ? jpegOrientation(bytes) : 1;
  const [w, h] = [dims.width, dims.height];
  const [W, H] = o >= 5 ? [h, w] : [w, h];
  const transform = orient(o, w, h);
  const href = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<image width="${w}" height="${h}" preserveAspectRatio="none"${transform === '' ? '' : ` transform="${transform}"`} href="${href}"/></svg>`;
  const { Resvg } = await import('@resvg/resvg-js');
  const fit = W >= H ? { mode: 'width' as const, value: Math.min(size, W) } : { mode: 'height' as const, value: Math.min(size, H) };
  return new Uint8Array(new Resvg(svg, { fitTo: fit, font: { loadSystemFonts: false } }).render().asPng());
}

// Without a cache (a test host): the last few, per process.
const recent = new Map<string, Uint8Array>();

/** The cached thumbnail of `asset`, drawing and storing it on first ask. */
export async function thumbnailOf(asset: string, load: () => Promise<{ bytes: Uint8Array; mime: string } | undefined>, cache: ThumbnailCache | undefined, size = THUMBNAIL_SIZE): Promise<Uint8Array | undefined> {
  const hit = cache === undefined ? recent.get(`${asset}-${size}`) : await cache.get(asset, size);
  if (hit !== undefined) return new Uint8Array(hit);
  const source = await load();
  if (source === undefined) return undefined;
  const png = await renderThumbnail(source.bytes, source.mime, size);
  if (cache === undefined) {
    recent.set(`${asset}-${size}`, png);
    while (recent.size > 64) recent.delete(recent.keys().next().value!);
  } else {
    await cache.put(asset, size, png);
  }
  return png;
}
