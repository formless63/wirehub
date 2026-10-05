/** A synthetic pack that ships a drawing's product photo: the image, its asset-index entry and the pointer (cs-8re). */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const SRC = 'synthetic example: photo pack';
const crc = (bytes: Uint8Array): number => {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** A 1x1 PNG whose pixel is `shade`, so each is a different file. */
export function pngOf(shade: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, shade, shade, shade]))), chunk('IEND', new Uint8Array())]);
}

/** A JSON bundle of one pack, version `version`, whose drawing photo is the PNG of `shade`. */
export function photoBundle(version: string, shade: number, design = 'de9-crossover', packId = 'photo-pack') {
  const bytes = pngOf(shade);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const bundle = {
    format: 1,
    manifest: { format: 1, id: packId, name: 'Photo pack', version, license: 'CC0-1.0' },
    files: {
      [`drawings/${design}.photo-ref.json`]: { assetId: sha },
      'assets/index.json': [{ id: sha, mime: 'image/png', originalName: 'photo.png', src: SRC, bytes: bytes.length }],
      [`assets/${sha}.png`]: Buffer.from(bytes).toString('base64'),
    },
  };
  return { bundle, sha, bytes, design, packId };
}
