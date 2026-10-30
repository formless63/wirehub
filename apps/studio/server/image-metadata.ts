/**
 * Strip what a photo says about where and by whom it was taken before it is stored
 * (`specs/knowledge.md`, attachments). Lossless: the picture's coded data is copied byte for
 * byte; only the metadata around it goes.
 *
 * - JPEG: walk the marker segments and keep only what draws the picture — frame and scan
 *   headers, tables, restart interval, the entropy-coded data, a JFIF header, an ICC colour
 *   profile and the Adobe colour-transform flag. Everything else goes: EXIF (GPS, camera,
 *   serial numbers, times, the EXIF thumbnail), XMP, IPTC/Photoshop, comments, multi-picture
 *   data, unknown application segments and anything after the end-of-image marker. The EXIF
 *   orientation is the one value kept: it is rewritten as a fresh, one-entry EXIF block so a
 *   phone photo still stands the right way up.
 * - PNG: the chunk walk of `png-sanitize.ts`, keeping the colour chunks (no text, no eXIf).
 *
 * Fails closed: a file the walk cannot follow is refused, never stored as it came, and the
 * result is walked again — stripping it a second time must change nothing.
 * Pure; no dependencies.
 */

import { Buffer } from 'node:buffer';

import { sanitizePng } from './png-sanitize.ts';

export type StripResult =
  | { ok: true; bytes: Buffer; width: number; height: number; orientation: number; removed: string[] }
  | { ok: false; reason: string };

/** Photos far beyond any camera's are refused rather than parsed (and never thumbnailed). */
export const MAX_PHOTO_SIDE = 30_000;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');

/** Frame headers (SOF0–SOF15 except DHT 0xC4, JPG 0xC8, DAC 0xCC). */
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function idOf(body: Buffer, length: number): string {
  return body.subarray(0, Math.min(length, body.length)).toString('latin1');
}

/** The EXIF orientation (1–8) of an APP1 Exif body, or 1 when it has none or cannot be read. */
export function exifOrientation(body: Buffer): number {
  if (body.length < 14 || !body.subarray(0, 6).equals(EXIF_ID)) return 1;
  const tiff = body.subarray(6);
  const le = tiff.toString('latin1', 0, 2) === 'II';
  if (!le && tiff.toString('latin1', 0, 2) !== 'MM') return 1;
  const u16 = (at: number): number => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > tiff.length) return 1;
    if (u16(at) === 0x0112 && u16(at + 2) === 3) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** A one-entry EXIF block (big-endian TIFF, IFD0 = Orientation): all that is kept of the original. */
function orientationSegment(orientation: number): Buffer {
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  EXIF_ID.copy(body, 0);
  body.write('MM', 6, 'latin1');
  body.writeUInt16BE(42, 8);
  body.writeUInt32BE(8, 10);
  body.writeUInt16BE(1, 14);
  body.writeUInt16BE(0x0112, 16);
  body.writeUInt16BE(3, 18);
  body.writeUInt32BE(1, 20);
  body.writeUInt16BE(orientation, 24);
  // next-IFD offset 0: no IFD1, so no EXIF thumbnail
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function walkJpeg(data: Buffer): StripResult {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== SOI) return { ok: false, reason: 'The photo is not a JPEG file.' };
  const head: Buffer[] = [data.subarray(0, 2)];
  const rest: Buffer[] = [];
  const removed = new Set<string>();
  let orientation = 1;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let at = 2;
  // APP0 JFIF (and the orientation block after it) must lead; the other kept segments follow in their order
  let jfif: Buffer | undefined;
  for (;;) {
    if (at >= data.length) return { ok: false, reason: 'The JPEG ends before its end-of-image marker.' };
    if (data[at] !== 0xff) return { ok: false, reason: 'The JPEG is damaged (a segment does not start with a marker).' };
    while (at < data.length && data[at] === 0xff) at += 1; // fill bytes
    if (at >= data.length) return { ok: false, reason: 'The JPEG is truncated.' };
    const marker = data[at] as number;
    at += 1;
    if (marker === EOI) {
      if (at < data.length) removed.add('data after the end of the image');
      rest.push(Buffer.from([0xff, EOI]));
      break;
    }
    if (marker === SOI || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      return { ok: false, reason: 'The JPEG is damaged (a marker is out of place).' };
    }
    if (at + 2 > data.length) return { ok: false, reason: 'The JPEG is truncated.' };
    const length = data.readUInt16BE(at);
    if (length < 2 || at + length > data.length) return { ok: false, reason: 'The JPEG is truncated.' };
    const segment = data.subarray(at - 2, at + length);
    const body = data.subarray(at + 2, at + length);
    at += length;
    if (marker === SOS) {
      if (width === 0) return { ok: false, reason: 'The JPEG has image data before its frame header.' };
      // the scan's coded data runs to the next marker that is not a stuffed 0xFF00 or a restart
      let end = at;
      for (;;) {
        if (end + 1 >= data.length) return { ok: false, reason: 'The JPEG ends inside its image data.' };
        if (data[end] === 0xff) {
          const next = data[end + 1] as number;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) { end += next === 0xff ? 1 : 2; continue; }
          break;
        }
        end += 1;
      }
      rest.push(segment, data.subarray(at, end));
      at = end;
      sawScan = true;
      continue;
    }
    if (isSof(marker)) {
      if (body.length < 6) return { ok: false, reason: 'The JPEG frame header is malformed.' };
      height = body.readUInt16BE(1);
      width = body.readUInt16BE(3);
      if (width < 1 || height < 1 || width > MAX_PHOTO_SIDE || height > MAX_PHOTO_SIDE) return { ok: false, reason: `The photo must be between 1 and ${MAX_PHOTO_SIDE} pixels each way.` };
      rest.push(segment);
      continue;
    }
    // tables, restart interval, number of lines, arithmetic conditioning, hierarchical progression
    if (marker === 0xc4 || marker === 0xcc || marker === 0xdb || marker === 0xdc || marker === 0xdd || marker === 0xde || marker === 0xdf) {
      rest.push(segment);
      continue;
    }
    if (marker === 0xe0 && idOf(body, 5) === 'JFIF\0' && jfif === undefined && rest.length === 0) { jfif = segment; continue; }
    if (marker === 0xe2 && idOf(body, 12) === 'ICC_PROFILE\0') { rest.push(segment); continue; }
    if (marker === 0xee && idOf(body, 5) === 'Adobe') { rest.push(segment); continue; }
    if (marker === 0xe1 && body.subarray(0, 6).equals(EXIF_ID)) {
      if (orientation === 1) orientation = exifOrientation(body);
      removed.add('EXIF');
      continue;
    }
    if (marker >= 0xe0 && marker <= 0xef) {
      const id = idOf(body, 40);
      removed.add(id.startsWith('http://ns.adobe.com/xap/') || id.startsWith('http://ns.adobe.com/xmp/') ? 'XMP' : marker === 0xed ? 'IPTC' : `APP${marker - 0xe0}`);
      continue;
    }
    if (marker === 0xfe) { removed.add('comment'); continue; }
    return { ok: false, reason: `The JPEG has a segment this hub does not know (0xFF${marker.toString(16).toUpperCase()}); nothing was stored.` };
  }
  if (!sawScan || width === 0) return { ok: false, reason: 'The JPEG has no image data.' };
  if (jfif !== undefined) head.push(jfif);
  if (orientation !== 1) head.push(orientationSegment(orientation));
  return { ok: true, bytes: Buffer.concat([...head, ...rest]), width, height, orientation, removed: [...removed].sort() };
}

/**
 * The JPEG with its metadata removed (see the header), or why it cannot be. The output is
 * walked again: a second strip must leave it unchanged and find nothing but the kept
 * orientation, or the upload is refused.
 */
export function stripJpegMetadata(input: Uint8Array): StripResult {
  const first = walkJpeg(Buffer.from(input));
  if (!first.ok) return first;
  const again = walkJpeg(first.bytes);
  if (!again.ok || !again.bytes.equals(first.bytes) || again.removed.some((r) => r !== 'EXIF') || (again.removed.length > 0 && first.orientation === 1)) {
    return { ok: false, reason: 'The photo\'s metadata could not be removed with certainty; nothing was stored.' };
  }
  return first;
}

/** A PNG photo: the chunk walk of `png-sanitize.ts` (no text, no eXIf, nothing past IEND). */
export function stripPngMetadata(input: Uint8Array, maxBytes: number): StripResult {
  const out = sanitizePng(input, { maxBytes, maxPixels: MAX_PHOTO_SIDE, noun: 'photo', keepColour: true });
  if (!out.ok) return out;
  const removed = out.bytes.length === input.length ? [] : ['ancillary chunks'];
  return { ok: true, bytes: out.bytes, width: out.width, height: out.height, orientation: 1, removed };
}

/** Strip a photo by its sniffed type (`image/jpeg`, `image/png`); any other type passes through untouched. */
export function stripPhotoMetadata(bytes: Uint8Array, mime: string, maxBytes: number): StripResult | undefined {
  if (mime === 'image/jpeg') return stripJpegMetadata(bytes);
  if (mime === 'image/png') return stripPngMetadata(bytes, maxBytes);
  return undefined;
}

/** The orientation the stripped JPEG still carries (its one-entry EXIF block), for the thumbnail. */
export function jpegOrientation(bytes: Uint8Array): number {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= data.length && data[at] === 0xff) {
    const marker = data[at + 1] as number;
    if (marker === SOS || marker === EOI) return 1;
    const length = data.readUInt16BE(at + 2);
    if (marker === 0xe1) return exifOrientation(data.subarray(at + 4, at + 2 + length));
    at += 2 + length;
  }
  return 1;
}
