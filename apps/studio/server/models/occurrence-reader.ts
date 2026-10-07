/** Optional pinned reader: verified local code/WASM, never an environment-selected cache recipe. */
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compileFunction } from 'node:vm';
import supported from '../../occt/supported-manifest.json' with { type: 'json' };

Object.freeze(supported.files);
Object.freeze(supported);
export const OCCURRENCE_ARTIFACT = supported;
// Include the exact supported code and WASM hashes, not the contents of a local directory.
export const OCCURRENCE_VERSION = `occt-occurrence-1:${createHash('sha256').update(JSON.stringify(supported)).digest('hex')}:board-coating-1`;
const require = createRequire(import.meta.url);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const REFUSAL = 'The optional occurrence-style importer is unavailable or does not match its pinned manifest. Rebuild and mount the supported artifact.';

/** Verify before executing; execute those verified bytes and pass verified WASM in memory. */
export function occurrenceFactory(dir: string): () => Promise<unknown> {
  try {
    const root = resolve(dir);
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error(REFUSAL);
    const read = (name: string, max: number): Uint8Array => {
      const file = join(root, name);
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > max || lstatSync(file).isSymbolicLink()) throw new Error(REFUSAL);
        const bytes = new Uint8Array(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const got = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (got === 0) throw new Error(REFUSAL);
          offset += got;
        }
        return bytes;
      } finally { closeSync(fd); }
    };
    const manifest: unknown = JSON.parse(new TextDecoder().decode(read('manifest.json', 16 * 1024)));
    if (!isDeepStrictEqual(manifest, supported)) throw new Error(REFUSAL);
    const code = read('occt-import-js.cjs', 1024 * 1024);
    const wasmBinary = read('occt-import-js.wasm', 24 * 1024 * 1024);
    if (hash(code) !== supported.files['occt-import-js.cjs'] || hash(wasmBinary) !== supported.files['occt-import-js.wasm']) throw new Error(REFUSAL);
    const module = { exports: undefined as unknown };
    const builtin = (id: string): unknown => {
      if (!['fs', 'path', 'crypto'].includes(id)) throw new Error(REFUSAL);
      return require(id);
    };
    compileFunction(new TextDecoder().decode(code), ['module', 'exports', 'require', '__dirname', '__filename'])(module, {}, builtin, root, join(root, 'occt-import-js.cjs'));
    if (typeof module.exports !== 'function') throw new Error(REFUSAL);
    const factory = module.exports as (options: { wasmBinary: Uint8Array }) => Promise<unknown>;
    return async () => {
      try { return await factory({ wasmBinary }); }
      catch { throw new Error(REFUSAL); }
    };
  } catch {
    throw new Error(REFUSAL);
  }
}
