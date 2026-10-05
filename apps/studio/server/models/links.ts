/**
 * Which 3D model a Library record shows.
 *
 * A side table rather than a field on each record, on purpose: the model is
 * a *view* of a part, not a fact the validator, the schematic or a build
 * sheet reads, and keeping it out of `connectors.json`/`pcbas*.json`/
 * `mechanicals.json` means an import run or a hand edit of a record never
 * collides with a model link, and vice versa. The bytes live in the shared,
 * content-addressed asset store (`assets.ts`) — the seam that moves to
 * RustFS with the Postgres backend (`specs/postgres-backend.md` §5) — or,
 * for a model an importer derived from board or housing files, in the gitignored model
 * cache (`cache.ts`), keyed by the hash of its sources. Either way a link is
 * only an id and its provenance:
 *
 *   packages/catalog/data/models.json   { src, links: ModelLink[] } sorted by record
 */

import { existsSync, readFileSync } from 'node:fs';

import { dataPath } from '@wirehub/catalog';

import { writeFileAtomic } from '../atomic-write.ts';
import type { Awaitable } from '../storage/change-set.ts';
import type { ModelBuild, SourceFile } from './cache.ts';

/** Where a model came from: a board file, a printed housing, a vendor download, an upload, or KiCad's standard 3D library. */
export const MODEL_SOURCE_KINDS = ['kicad-board', 'resin-print', 'vendor', 'uploaded', 'kicad-library'] as const;
export type ModelSourceKind = (typeof MODEL_SOURCE_KINDS)[number];

export function isModelSourceKind(value: unknown): value is ModelSourceKind {
  return typeof value === 'string' && (MODEL_SOURCE_KINDS as readonly string[]).includes(value);
}

export interface ModelLink {
  /** `<definition kind>/<id>`, e.g. `mechanicals/shell-hd15-coax` */
  record: string;
  /**
   * The model's id — `GET /api/assets/:asset`. An upload: the sha256 of the
   * stored GLB (asset store). An import: `sourceKey(files)`, the model
   * cache's key, rebuilt from `files` on any box that mounts them.
   */
  asset: string;
  /** an imported model's sources, each with the sha256 it was built from */
  files?: SourceFile[];
  /** how the model is made from `files`, when it is not "convert the one file" */
  build?: ModelBuild;
  /** a short name for pickers (`SHL-00103-00 Rev1`) */
  name?: string;
  sourceKind: ModelSourceKind;
  /** provenance: the exact source path(s) and revision, or who uploaded what */
  src: string;
  /** the source revision the model is of, when it has one (`Rev1`) */
  revision?: string;
  /**
   * a `revisions/<variant>/<rev>` link's README status — the model
   * of a revision no Library record shows: a WIP or superseded one
   */
  status?: 'released' | 'wip' | 'superseded';
  /** triangles in the stored model — the viewer's "how heavy" hint */
  triangles?: number;
}

export interface ModelLinkStore {
  list(): Awaitable<ModelLink[]>;
  get(record: string): Awaitable<ModelLink | undefined>;
  put(link: ModelLink): Awaitable<void>;
  remove(record: string): Awaitable<boolean>;
}

export const MODELS_FILE_SRC =
  'Library 3D model links. Written by the Library\'s Attach/Detach and upload, and by a model importer module. Each link\'s own `src` cites its source file(s). An imported model lists its `files` with their sha256 and is built into the gitignored data/.model-cache/ under `asset` (a hash of those sources); an uploaded model is stored in data/assets/ under the sha256 of its bytes.';

interface ModelsFile {
  src: string;
  links: ModelLink[];
}

function modelsPath(): string {
  return dataPath('models.json');
}

/** Code-point order of the record key — never `localeCompare`, whose answer depends on the machine's ICU data (B0). */
export function sortLinks(links: readonly ModelLink[]): ModelLink[] {
  return [...links].sort((a, b) => (a.record < b.record ? -1 : a.record > b.record ? 1 : 0));
}

export function readModelsFile(path = modelsPath()): ModelsFile {
  if (!existsSync(path)) return { src: MODELS_FILE_SRC, links: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ModelsFile>;
  return { src: parsed.src ?? MODELS_FILE_SRC, links: Array.isArray(parsed.links) ? parsed.links : [] };
}

export function writeModelsFile(file: ModelsFile, path = modelsPath()): void {
  const next = `${JSON.stringify({ src: file.src, links: sortLinks(file.links) }, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === next) return;
  writeFileAtomic(path, next, 'utf8');
}

/** `packages/catalog/data/models.json` as the store. */
export function fileModelLinkStore(path = modelsPath()): ModelLinkStore {
  return {
    list: () => readModelsFile(path).links,
    get: (record) => readModelsFile(path).links.find((link) => link.record === record),
    put(link) {
      const file = readModelsFile(path);
      writeModelsFile({ ...file, links: [...file.links.filter((l) => l.record !== link.record), link] }, path);
    },
    remove(record) {
      const file = readModelsFile(path);
      const kept = file.links.filter((l) => l.record !== record);
      if (kept.length === file.links.length) return false;
      writeModelsFile({ ...file, links: kept }, path);
      return true;
    },
  };
}

/** In memory, for tests. */
export function memoryModelLinkStore(initial: ModelLink[] = []): ModelLinkStore & { links: ModelLink[] } {
  const state = { links: [...initial] };
  return {
    get links() {
      return sortLinks(state.links);
    },
    list: () => sortLinks(state.links),
    get: (record) => state.links.find((l) => l.record === record),
    put(link) {
      state.links = [...state.links.filter((l) => l.record !== link.record), link];
    },
    remove(record) {
      const before = state.links.length;
      state.links = state.links.filter((l) => l.record !== record);
      return state.links.length !== before;
    },
  };
}
