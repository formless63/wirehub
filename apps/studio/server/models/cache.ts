/**
 * The generated model cache: GLBs an importer builds
 * from read-only board and housing files. Derived data, so it is
 * **not committed** — `data/models.json` (committed) records each imported
 * link's source paths and their sha256s, and the cache is keyed by
 * `sourceKey`, a hash of exactly those inputs plus the converter version.
 * Any box with the source folders mounted rebuilds the same keys.
 *
 *   packages/catalog/data/.model-cache/<key>.glb     gitignored
 *
 * Models a person uploads in the Library are user data and stay in the
 * committed asset store (`assets.ts`) instead. Both are served by
 * `GET /api/assets/:id`; this is only where the bytes of the derived ones
 * sit until the blob store (RustFS) takes over.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';

import { writeFileAtomic } from '../atomic-write.ts';
import { envVar } from '../env.ts';
import { OCCURRENCE_VERSION } from './occurrence-reader.ts';
import { APPEARANCE_VERSION } from './appearance-reader.ts';
import type { Awaitable } from '../storage/change-set.ts';

/**
 * Geometry/output format revision (mesh.ts, glb.ts, step.ts, the budget).
 * Board painting has its own explicitly inferred profile below. Bumping
 * this revision changes every key: every cached model is
 * then rebuilt, and every link re-keyed by the next dev-tree import.
 */
export const CONVERTER_VERSION = 'glb-q16-zup-4';

/** Texture output is versioned separately so geometry and existing pack keys stay usable. */
export type BoardTextureProfile = 'legacy' | 'exporter' | 'occurrence' | 'appearance';

export const BOARD_TEXTURE_VERSION = 'board-texture-2';

/** The same two source views that build.ts passes to the painter. */
export function hasBoardArtFiles(files: readonly SourceFile[]): boolean {
  return ['board-top.svg', 'board-bottom.svg'].every((suffix) => files.some((f) => isArtFile(f.path) && f.path.endsWith(suffix)));
}

export interface SourceFile {
  /**
   * `housings/…` or `boards/…`, relative to the mounted folder's parent;
   * `kicad-packages3D/…` for a KiCad library file; `data/model-sources/…` for a
   * board file uploaded in the Library (a catalog document)
   */
  path: string;
  sha256: string;
  /** where a downloaded file came from (the KiCad library's raw URL at the pinned commit) */
  url?: string;
}

/**
 * How a model is made from its files when it is not simply "convert the one
 * file" — committed with the link, so the `model-cache` job
 * rebuilds exactly what the import built:
 * - `assembly`: a board from its `.kicad_pcb` (outline + placed footprint models);
 *   with `library` (a kicad-packages3D commit), the footprints' library models are
 *   not among `files` but fetched at that pinned commit when the model is built
 *   (`library-source.ts`) — what a `.kicad_pcb` uploaded in the Library makes;
 * - `embedded`: the model file of that name KiCad embedded in the `.kicad_pcb`;
 * - `placed`: one library file moved by a footprint-style offset / rotation.
 */
export type ModelBuild =
  | { kind: 'assembly'; library?: string }
  | { kind: 'embedded'; name: string }
  | { kind: 'placed'; offset: [number, number, number]; rotate: [number, number, number] };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The version of the board assembly (`assembly.ts`); part of an assembled model's key. */
export const ASSEMBLY_VERSION = 'kicad-assembly-1';

/**
 * The cache key for a model built from `files` with `maxTriangles` — and,
 * for a model that is more than one file converted, how (`build`). A model
 * without a `build` keeps its geometry key. Paired board artwork adds the
 * painting revision; legacy reproduces the original key and detector.
 */
export function sourceKey(files: readonly SourceFile[], maxTriangles: number, build?: ModelBuild, boardTextureProfile: BoardTextureProfile = 'exporter'): string {
  if (!['legacy', 'exporter', 'occurrence', 'appearance'].includes(boardTextureProfile)) throw new Error('Unsupported model conversion profile.');
  const recipe = build === undefined ? '' : `\n${build.kind === 'assembly' ? `${ASSEMBLY_VERSION}${build.library === undefined ? '' : `\nkicad-packages3D@${build.library}`}` : JSON.stringify(build)}`;
  const texture = boardTextureProfile !== 'legacy' && hasBoardArtFiles(files) ? `\n${BOARD_TEXTURE_VERSION}` : '';
  const occurrence = boardTextureProfile === 'occurrence' ? `\n${OCCURRENCE_VERSION}` : '';
  const appearance = boardTextureProfile === 'appearance' ? `\n${APPEARANCE_VERSION}` : '';
  return sha256Hex(`${CONVERTER_VERSION}\n${maxTriangles}\n${files.map((f) => `${f.path}\n${f.sha256}`).join('\n')}${recipe}${texture}${occurrence}${appearance}`);
}

/** A depiction's board-top/board-bottom art: paint on an existing shape, not part of what makes a model its own. */
export function isArtFile(path: string): boolean {
  return path.startsWith('depictions/');
}

/**
 * The identity two links are compared by to decide they show the same
 * model — `sourceKey` over the geometry files alone, art dropped first.
 * A revision's own model files never carry a depiction's art (only a
 * Library record's link does, when the definition has one); comparing on
 * `sourceKey` directly would mean a released revision's board never
 * matches its Library link once that link's files gain art, and gets
 * rebuilt (and relinked) a second time under `revisions/<variant>/<rev>` —
 * a real board (`revisions.ts`/`revision-import.ts`'s `byAsset` dedup) —
 * so identity ignores art while `sourceKey` (the actual cache key) still
 * depends on it, and still rebuilds when the art changes.
 */
export function identityKey(files: readonly SourceFile[], maxTriangles: number, build?: ModelBuild): string {
  return sourceKey(
    files.filter((f) => !isArtFile(f.path)),
    maxTriangles,
    build,
  );
}

export interface ModelCache {
  has(key: string): Awaitable<boolean>;
  get(key: string): Awaitable<Buffer | undefined>;
  put(key: string, glb: Uint8Array): Awaitable<void>;
  keys(): Awaitable<string[]>;
  remove(key: string): Awaitable<void>;
  /** when `key` was built (file: its mtime; pg: `derived_blob.built_at`); absent when unknown — the sweep's grace period needs it */
  builtAt?(key: string): Awaitable<Date | undefined>;
}

const KEY = /^[0-9a-f]{64}$/;

export function modelCacheDir(): string {
  return envVar('MODEL_CACHE_DIR') ?? dataPath('.model-cache');
}

export function fileModelCache(dir = modelCacheDir()): ModelCache {
  const path = (key: string): string => {
    if (!KEY.test(key)) throw new Error(`not a model cache key: ${key}`);
    return join(dir, `${key}.glb`);
  };
  return {
    has: (key) => KEY.test(key) && existsSync(path(key)),
    get: (key) => (KEY.test(key) && existsSync(path(key)) ? readFileSync(path(key)) : undefined),
    put(key, glb) {
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(path(key), glb);
    },
    keys: () => (existsSync(dir) ? readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.glb$/.test(n)).map((n) => n.slice(0, 64)) : []),
    remove(key) {
      rmSync(path(key), { force: true });
    },
    builtAt: (key) => (KEY.test(key) && existsSync(path(key)) ? statSync(path(key)).mtime : undefined),
  };
}

export function memoryModelCache(): ModelCache & { files: Map<string, Buffer>; built: Map<string, Date> } {
  const files = new Map<string, Buffer>();
  const built = new Map<string, Date>();
  return {
    files,
    built,
    builtAt: (key) => built.get(key),
    has: (key) => files.has(key),
    get: (key) => files.get(key),
    put: (key, glb) => void (files.set(key, Buffer.from(glb)), built.set(key, new Date())),
    keys: () => [...files.keys()],
    remove: (key) => void (files.delete(key), built.delete(key)),
  };
}
