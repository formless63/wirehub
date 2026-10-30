/** A tiny valid PNG (a solid square) with optional extra chunks, for the logo tests. */

import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])));
  return Buffer.concat([head, Buffer.from(type, 'latin1'), body, crc]);
}

export function makePng(size = 4, extra: { type: string; body: string }[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map((e) => chunk(e.type, Buffer.from(e.body))),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const pngDataUri = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

/** A tiny JPEG with no metadata (frame header, one scan, a few coded bytes): stripping leaves it as it is. */
export function makeJpeg(width = 4, height = 2): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  const sos = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0xff, 0xd9])]);
}
