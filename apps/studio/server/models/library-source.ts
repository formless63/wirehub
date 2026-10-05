/**
 * KiCad's 3D library as a model source, fetched on demand (cs-5k1.12).
 *
 * A `.kicad_pcb` uploaded in the Library (`POST /api/models/pcbas/:id/upload`)
 * names its footprints' models as `${KICAD9_3DMODEL_DIR}/<lib>.3dshapes/<file>`.
 * Those files are kicad-packages3D's (CC-BY-SA 4.0 with the KiCad libraries
 * exception): they are never committed and never shipped. When the
 * `model-cache` job builds such a board, this reader returns each file from a
 * local copy, fetching it first from the **pinned commit**
 * (`KICAD_LIBRARY.commit`, `kicadModelUrl`) over https when the copy does not
 * have it. A file at a commit never changes, so the commit is the identity the
 * cache key records (`ModelBuild.library`).
 *
 *   <model cache>/kicad-packages3D/<commit>/<lib>.3dshapes/<file>.step
 *
 * `WIREHUB_KICAD_LIBRARY_DIR` moves the copy (a shared folder, or one filled
 * by hand on a box with no internet); `WIREHUB_KICAD_LIBRARY_FETCH=0` turns
 * fetching off, and a missing model is then left off the board (the job says
 * which). Only the job (server, never a request) reaches the network.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { writeFileAtomic } from '../atomic-write.ts';
import type { SourceReader } from './build.ts';
import { modelCacheDir } from './cache.ts';
import { KICAD_LIBRARY, KICAD_ROOT, kicadModelUrl, libraryModelPath } from './kicad-library.ts';

/** The largest library file fetched (a few connector models run to tens of MB). */
export const MAX_LIBRARY_FILE_BYTES = 64 * 1024 * 1024;

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; bytes(): Promise<Uint8Array> }>;

const realFetch: Fetcher = async (url) => {
  const response = await fetch(url, { redirect: 'follow' });
  return { ok: response.ok, status: response.status, bytes: async () => new Uint8Array(await response.arrayBuffer()) };
};

export interface LibrarySourceOptions {
  /** where fetched files are kept; default `<model cache>/kicad-packages3D` */
  dir?: string;
  /** the commit to read at; default the pinned one */
  commit?: string;
  /** false: read the local copy only */
  fetch?: boolean;
  fetcher?: Fetcher;
  /** what was fetched, and what could not be (for the job's result) */
  log?: (line: string) => void;
}

export function libraryDirFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const dir = (env['WIREHUB_KICAD_LIBRARY_DIR'] ?? '').trim();
  return dir === '' ? join(modelCacheDir(), KICAD_ROOT) : dir;
}

export function libraryFetchFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env['WIREHUB_KICAD_LIBRARY_FETCH'] ?? '').trim() !== '0';
}

/**
 * A reader for `kicad-packages3D/<lib>.3dshapes/<file>` paths: the local copy,
 * else a fetch at the commit (kept for next time). `undefined` for any other
 * path, or a file that cannot be had.
 */
export function kicadLibrarySource(options: LibrarySourceOptions = {}): SourceReader {
  const commit = options.commit ?? KICAD_LIBRARY.commit;
  const root = resolve(options.dir ?? libraryDirFromEnv(), commit);
  const fetching = options.fetch ?? libraryFetchFromEnv();
  const fetcher = options.fetcher ?? realFetch;
  return async (path) => {
    if (!path.startsWith(`${KICAD_ROOT}/`)) return undefined;
    const ref = libraryModelPath(path.slice(KICAD_ROOT.length + 1));
    if (ref === undefined) return undefined;
    const local = resolve(join(root, ref));
    if (!local.startsWith(root + sep)) return undefined;
    if (existsSync(local)) return new Uint8Array(readFileSync(local));
    if (!fetching) {
      options.log?.(`${ref}: not in the local library copy, and fetching is off`);
      return undefined;
    }
    try {
      const response = await fetcher(kicadModelUrl(ref, commit));
      if (!response.ok) {
        options.log?.(`${ref}: the library answered ${response.status}`);
        return undefined;
      }
      const bytes = await response.bytes();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_LIBRARY_FILE_BYTES) {
        options.log?.(`${ref}: ${bytes.byteLength} bytes, not kept`);
        return undefined;
      }
      mkdirSync(dirname(local), { recursive: true });
      writeFileAtomic(local, bytes);
      options.log?.(`${ref}: fetched (${bytes.byteLength} bytes)`);
      return bytes;
    } catch (error) {
      options.log?.(`${ref}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}
