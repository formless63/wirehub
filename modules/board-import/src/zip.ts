/**
 * A small ZIP reader for fabrication bundles (a Gerber set as a board house
 * takes it). Stored and deflated entries only — what every PCB tool writes;
 * deflate is undone with the platform's `DecompressionStream('deflate-raw')`
 * (browsers and Node), so the module needs no dependency. Encrypted entries,
 * zip64 archives and anything bigger than the limits are refused with a
 * sentence.
 */

export interface ZipEntry {
  /** the entry's path inside the archive, `/`-separated */
  path: string;
  /** the last path segment */
  name: string;
  bytes: Uint8Array;
}

export const MAX_ENTRIES = 512;
export const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.byteLength !== expected) throw new Error(`an entry inflated to ${out.byteLength} bytes, not the ${expected} its header says`);
  return out;
}

/** Every file in the archive (folders skipped), in archive order. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  // the end-of-central-directory record: the last PK\x05\x06 within the trailing comment's reach
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('this is not a ZIP archive (no central directory)');
  const count = u16(bytes, eocd + 10);
  const dirOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('ZIP64 archives are not read; re-zip the files without ZIP64');
  if (count > MAX_ENTRIES) throw new Error(`the archive has ${count} entries; at most ${MAX_ENTRIES} are read`);
  const entries: ZipEntry[] = [];
  let total = 0;
  let at = dirOffset;
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error('the archive\'s central directory is damaged');
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/')) continue;
    if ((flags & 1) !== 0) throw new Error(`${path} is encrypted`);
    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error(`the archive unpacks to more than ${MAX_UNCOMPRESSED_BYTES / 1048576} MB`);
    if (u32(bytes, local) !== 0x04034b50) throw new Error(`${path}: the local header is damaged`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + compressed);
    let content: Uint8Array;
    if (method === 0) content = data.slice();
    else if (method === 8) content = await inflateRaw(data, size);
    else throw new Error(`${path} uses compression method ${method}; only stored and deflated entries are read`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name.startsWith('.') || path.startsWith('__MACOSX/')) continue;
    entries.push({ path, name, bytes: content });
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Writing (stored entries): for tests and for bundling files in the browser
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored (uncompressed) entries. */
export function writeZip(files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.bytes.length, true);
    view.setUint32(22, file.bytes.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, file.bytes.length, true);
    d.setUint32(24, file.bytes.length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    dir.set(name, 46);
    parts.push(local, file.bytes);
    central.push(dir);
    offset += local.length + file.bytes.length;
  }
  const dirSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, dirSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
