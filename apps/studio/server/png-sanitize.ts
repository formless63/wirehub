/**
 * Make an uploaded PNG safe to keep and to embed in a document: parse the chunk
 * stream, check every CRC, keep only the chunks that draw the picture (IHDR,
 * PLTE, tRNS, IDAT, IEND) and drop the rest — text, EXIF, embedded profiles,
 * private chunks, anything after IEND. The result is a PNG that cannot carry
 * metadata or a payload past its pixels. Pure; no dependencies.
 */

import { Buffer } from 'node:buffer';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
/** a title-block logo is small; refuse anything that could be a decompression bomb */
export const MAX_LOGO_BYTES = 512 * 1024;
export const MAX_LOGO_PIXELS = 4096;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type PngResult = { ok: true; bytes: Buffer; width: number; height: number } | { ok: false; reason: string };

export function sanitizePng(input: Uint8Array): PngResult {
  const data = Buffer.from(input);
  if (data.length > MAX_LOGO_BYTES) return { ok: false, reason: `The logo is larger than ${MAX_LOGO_BYTES / 1024} KiB.` };
  if (data.length < 8 + 25 || !data.subarray(0, 8).equals(SIGNATURE)) return { ok: false, reason: 'The logo is not a PNG file.' };
  const out: Buffer[] = [SIGNATURE];
  let at = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let sawEnd = false;
  let first = true;
  while (at + 12 <= data.length && !sawEnd) {
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 8 + length + 4;
    if (end > data.length) return { ok: false, reason: 'The PNG is truncated.' };
    const body = data.subarray(at + 8, at + 8 + length);
    if (crc32(data.subarray(at + 4, at + 8 + length)) !== data.readUInt32BE(at + 8 + length)) return { ok: false, reason: `The PNG's ${type} chunk is damaged.` };
    if (first && type !== 'IHDR') return { ok: false, reason: 'The PNG does not start with its header.' };
    if (type === 'IHDR') {
      if (!first || length !== 13) return { ok: false, reason: 'The PNG header is malformed.' };
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (width < 1 || height < 1 || width > MAX_LOGO_PIXELS || height > MAX_LOGO_PIXELS) return { ok: false, reason: `The logo must be between 1 and ${MAX_LOGO_PIXELS} pixels each way.` };
    }
    first = false;
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') sawEnd = true;
    if (KEEP.has(type)) out.push(data.subarray(at, end));
    at = end;
  }
  if (!sawIdat || !sawEnd) return { ok: false, reason: 'The PNG has no picture data or no end.' };
  return { ok: true, bytes: Buffer.concat(out), width, height };
}
