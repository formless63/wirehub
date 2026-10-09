/** Google's WOFF2 decoder compiled to WASM by wawoff2 (MIT). */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new Map<string, Uint8Array>();

export function decompressWoff2(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length < 48 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16) > maxBytes) throw new Error('The WOFF2 font unpacks to more than this hub accepts.');
  const key = createHash('sha256').update(bytes).digest('hex');
  const cached = cache.get(key);
  if (cached !== undefined && cached.length <= maxBytes) return cached.slice();
  try {
    // Its async WASM runtime is isolated in a bounded child process; the font
    // inspector remains synchronous and no decoder hooks touch the server.
    const result = execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'woff2-decode.mjs')], { input: Buffer.from(bytes), maxBuffer: maxBytes, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.length > maxBytes) throw new Error('The decoded font is too large.');
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    const decoded = new Uint8Array(result);
    cache.set(key, decoded);
    return decoded.slice();
  } catch {
    throw new Error('The WOFF2 font could not be unpacked.');
  }
}
