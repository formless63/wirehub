/**
 * The 3D model endpoints — request in, response out.
 *
 *   GET    /api/models                     every link + every stored model (the "pick imported" list)
 *   GET    /api/models/:kind/:id           this record's link (or null), with its ETag
 *   PUT    /api/models/:kind/:id           { asset, sourceKind?, src? } — link a stored model
 *   POST   /api/models/:kind/:id/upload    { name, data (base64), sourceKind? } — convert, store, link;
 *                                           a board's `.kicad_pcb` is kept as its model source and built by the model-cache job
 *   DELETE /api/models/:kind/:id           unlink (the stored model stays; others may use it)
 *
 * Writes are Library edits like any other: the edit-lock gate maps every one
 * to `definition:<kind>:<id>` (`src/locks/records.ts`), and each needs the
 * link's current version as `If-Match` (`*` for "whatever is there"). The
 * bytes never leave the asset store's seam — the viewer reads them from
 * `GET /api/assets/:id` and nowhere else.
 *
 * Its own module (like `depictions.ts`) because an upload is bytes, bigger
 * than the JSON pipe's 4 MB.
 */

import type { Db } from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from '../api.ts';
import type { StudioUser } from '../me.ts';
import { isModelAsset, type AssetStore } from '../assets.ts';
import { DEFINITION_KINDS, isDefinitionKind, type DefinitionKind } from '../definition-store.ts';
import { checkIfMatch, contentETag } from '../etag.ts';
import type { Awaitable } from '../storage/change-set.ts';
import { withWriteLock } from '../storage/write-lock.ts';
import type { DepictionStore } from '../depictions.ts';
import { boardLibraryRefs } from './assembly.ts';
import { boardArtFiles } from './board-art.ts';
import { sha256Hex, sourceKey, type ModelBuild, type ModelCache, type SourceFile } from './cache.ts';
import { MAX_MODEL_TRIANGLES } from './finish.ts';
import { parseKicadPcb } from './kicad-pcb.ts';
import { KICAD_LIBRARY } from './kicad-library.ts';
import type { DocStore } from '../storage/doc-store.ts';
import { convertModel, ModelRefusal, type ConvertedModel } from './convert.ts';
import { isModelSourceKind, MODEL_SOURCES_DIR, type ModelLink, type ModelLinkStore, type ModelSourceKind } from './links.ts';

export const MODEL_ROUTES = [
  'GET    /api/models',
  'GET    /api/models/:kind/:id',
  'PUT    /api/models/:kind/:id',
  'POST   /api/models/:kind/:id/upload',
  'DELETE /api/models/:kind/:id',
] as const;

/** A base64 upload of a `MAX_MODEL_BYTES` file, plus the JSON around it. */
export const MAX_MODEL_REQUEST_BYTES = 34 * 1024 * 1024;

export interface ModelDeps {
  links?: ModelLinkStore;
  assets?: AssetStore;
  /** the generated cache of imported models (gitignored; `cache.ts`) */
  cache?: ModelCache;
  /** catalog documents: where an uploaded board file is kept as a model source (`MODEL_SOURCES_DIR`) */
  docs?: DocStore;
  /** artwork: a board's gerber-tier art is painted on its model (`board-art.ts`) */
  depictions?: DepictionStore;
  loadDb: () => Awaitable<Db>;
  /** injectable for tests; the real one forks the STEP child */
  convert?: (bytes: Uint8Array, name: string) => Promise<ConvertedModel>;
  /** who is uploading, for the link's `src` */
  who?: string;
  /** today, YYYY-MM-DD */
  today?: () => string;
  /**
   * Run a write in one unit of work (`api.ts`): the link and any uploaded
   * bytes are staged, then committed as one change set (the file backend's
   * files, or one database transaction). Absent: the write goes straight to
   * the stores under the write lock (tests, read-only hosts).
   */
  transact?: (write: (deps: ModelDeps) => Promise<ApiResponse>) => Promise<ApiResponse>;
}

export interface ModelRequest {
  method: string;
  path: string;
  body?: unknown;
  ifMatch?: string;
}

export function isModelPath(path: string): boolean {
  const head = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return head === '/api/models' || head.startsWith('/api/models/');
}

/** The model handler's deps, from the workbench's. */
export function modelDepsOf(deps: WorkbenchDeps, user?: StudioUser): ModelDeps {
  const who = user?.name ?? deps.localUser?.name;
  return {
    ...(deps.modelLinks === undefined ? {} : { links: deps.modelLinks }),
    ...(deps.assets === undefined ? {} : { assets: deps.assets }),
    ...(deps.modelCache === undefined ? {} : { cache: deps.modelCache }),
    ...(deps.docs === undefined ? {} : { docs: deps.docs }),
    ...(deps.depictions === undefined ? {} : { depictions: deps.depictions }),
    loadDb: deps.loadDb,
    ...(deps.convertModel === undefined ? {} : { convert: deps.convertModel }),
    ...(who === undefined ? {} : { who }),
    ...(deps.today === undefined ? {} : { today: deps.today }),
  };
}

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): ApiResponse {
  return { status, body, ...(headers === undefined ? {} : { headers }) };
}

const RECORD_ID = /^[a-z0-9]+(?:-[a-z0-9]+|(?<=\d)\.\d[a-z0-9]*)*$/;
const ASSET_ID = /^[0-9a-f]{64}$/;

function recordExists(db: Db, kind: DefinitionKind, id: string): boolean {
  const list = (db as unknown as Record<string, { id: string }[] | undefined>)[kind] ?? [];
  return list.some((record) => record.id === id);
}

export function linkETag(link: ModelLink | undefined): string {
  return contentETag(link ?? null);
}

/** The words for an imported model whose cache entry is not built on this box. */
export const NOT_BUILT = {
  error: 'This 3D model has not been built on this studio yet.',
  hint: 'The model-cache job builds it from its source files (an uploaded board file, or a mounted model-sources folder); reload once it has run.',
  state: 'not-built',
} as const;

/** Is `asset` available as bytes — in the asset store, or built in the cache? */
async function isBuilt(deps: ModelDeps, link: ModelLink): Promise<boolean> {
  if (link.files !== undefined) return (await deps.cache?.has(link.asset)) ?? false;
  return (await deps.assets?.get(link.asset)) !== undefined;
}

/**
 * `GET /api/assets/:id` for a model the asset store does not hold: the
 * cached GLB of an imported model, or — when a link names it but the cache
 * has not been built — the not-built state (404 with `state: 'not-built'`).
 * `undefined` when `id` is no model at all (the caller's ordinary 404).
 */
export async function cachedModelFile(deps: ModelDeps, id: string): Promise<ApiResponse | undefined> {
  const bytes = await deps.cache?.get(id);
  if (bytes !== undefined) return { status: 200, body: null, bytes: new Uint8Array(bytes), contentType: 'model/gltf-binary' };
  const linked = (await deps.links?.list())?.some((l) => l.asset === id && l.files !== undefined);
  return linked === true ? { status: 404, body: NOT_BUILT } : undefined;
}

/** Everything under `/api/models`. */
export async function handleModelRequest(request: ModelRequest, deps: ModelDeps): Promise<ApiResponse> {
  if (deps.links === undefined || deps.assets === undefined) {
    return fail(501, 'This studio does not keep 3D models.', 'The rest of the Library works as before.');
  }
  const links = deps.links;
  const assets = deps.assets;
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '');
  const [, , kind, id, action, extra] = parts;

  if (kind === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const all = await links.list();
    const models: { id: string; mime: string; originalName: string; src: string; bytes: number; built: boolean }[] = (await assets.list())
      .filter(isModelAsset)
      .map((m) => ({ ...m, built: true }));
    // imported models, once each (board variants share one)
    for (const link of all) {
      if (link.files === undefined || models.some((m) => m.id === link.asset)) continue;
      const bytes = await deps.cache?.get(link.asset);
      models.push({ id: link.asset, mime: 'model/gltf-binary', originalName: `${link.name ?? link.record}.glb`, src: link.src, bytes: bytes?.byteLength ?? 0, built: bytes !== undefined });
    }
    return ok({ links: all, models });
  }
  if (!isDefinitionKind(kind)) return fail(400, `'${kind}' is not a Library kind.`, `One of: ${DEFINITION_KINDS.join(', ')}.`);
  if (id === undefined || !RECORD_ID.test(id) || id.length > 100) return fail(400, `${JSON.stringify(id ?? '')} is not a record id.`, 'Ids are lowercase words joined by hyphens.');
  if (extra !== undefined || (action !== undefined && action !== 'upload')) return fail(404, 'There is nothing at that address.', MODEL_ROUTES.join('; '));
  const record = `${kind}/${id}`;

  if (method === 'GET' && action === undefined) {
    const link = await links.get(record);
    return ok({ link: link ?? null, ...(link === undefined ? {} : { built: await isBuilt(deps, link) }) }, 200, { ETag: linkETag(link) });
  }

  const db = await deps.loadDb();
  if (!recordExists(db, kind, id)) return fail(404, `There is no ${kind} record '${id}'.`, 'Reload the Library; it may have been renamed or deleted.');

  const guarded = async (write: (current: ModelLink | undefined, stores: { links: ModelLinkStore; assets: AssetStore; docs?: DocStore }) => Promise<ApiResponse>): Promise<ApiResponse> => {
    const run = async (d: ModelDeps): Promise<ApiResponse> => {
      const docs = d.docs ?? deps.docs;
      const stores = { links: d.links ?? links, assets: d.assets ?? assets, ...(docs === undefined ? {} : { docs }) };
      const current = await stores.links.get(record);
      const refused = checkIfMatch(request.ifMatch, linkETag(current), '3D model link', record);
      if (refused !== undefined) return refused;
      return write(current, stores);
    };
    return deps.transact !== undefined ? deps.transact(run) : withWriteLock(() => run(deps));
  };

  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const sourceKind = (fallback: ModelSourceKind): ModelSourceKind | ApiResponse => {
    const value = body['sourceKind'];
    if (value === undefined) return fallback;
    return isModelSourceKind(value) ? value : fail(400, `'${String(value)}' is not a model source.`, 'One of: kicad-board, resin-print, vendor, uploaded.');
  };
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();

  if (method === 'DELETE' && action === undefined) {
    return guarded(async (current, stores) => {
      if (current === undefined) return fail(404, `${record} has no 3D model to detach.`);
      await stores.links.remove(record);
      return ok({ detached: current }, 200, { ETag: linkETag(undefined) });
    });
  }

  if (method === 'PUT' && action === undefined) {
    const asset = body['asset'];
    if (typeof asset !== 'string' || !ASSET_ID.test(asset)) return fail(400, 'Say which stored model to attach (its 64-hex asset id).');
    const kindOf = sourceKind('uploaded');
    if (typeof kindOf !== 'string') return kindOf;
    // reusing a model another record already cites keeps that citation
    const cited = (await links.list()).find((l) => l.asset === asset);
    const found = await assets.get(asset);
    const stored = found !== undefined && isModelAsset(found.record);
    // an imported model is known by its link (its bytes may not be built on this box yet)
    if (!stored && cited?.files === undefined) return fail(404, `No stored 3D model ${asset}.`, 'Pick one from the imported models, or upload the file.');
    return guarded(async (_current, stores) => {
      const src =
        typeof body['src'] === 'string' && body['src'].trim() !== ''
          ? body['src'].trim()
          : cited !== undefined
            ? `${cited.src} (reused from ${cited.record}, ${today})`
            : `${found!.record.src} (attached in the Library, ${today})`;
      const link: ModelLink = {
        record,
        asset,
        sourceKind: cited?.sourceKind ?? kindOf,
        src,
        ...(cited?.files === undefined ? {} : { files: cited.files }),
        ...(cited?.name === undefined ? {} : { name: cited.name }),
        ...(cited?.revision === undefined ? {} : { revision: cited.revision }),
        ...(cited?.triangles === undefined ? {} : { triangles: cited.triangles }),
      };
      await stores.links.put(link);
      return ok({ link }, 200, { ETag: linkETag(link) });
    });
  }

  if (method === 'POST' && action === 'upload') {
    const name = body['name'];
    const data = body['data'];
    if (typeof name !== 'string' || name.trim() === '' || name.length > 200 || /[\\/\u0000]/.test(name)) {
      return fail(400, 'The upload needs the file name (no folders).');
    }
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(data)) return fail(400, 'The upload needs the file, base64-encoded, as `data`.');
    const kindOf = sourceKind('uploaded');
    if (typeof kindOf !== 'string') return kindOf;
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (name.trim().toLowerCase().endsWith('.kicad_pcb')) return uploadBoardFile(request, deps, { kind, id, record, name: name.trim(), bytes, today, guarded });
    // the If-Match check first — a stale page must not cost a 20 s conversion
    const current = await links.get(record);
    const early = checkIfMatch(request.ifMatch, linkETag(current), '3D model link', record);
    if (early !== undefined) return early;
    let converted: ConvertedModel;
    try {
      converted = await (deps.convert ?? convertModel)(bytes, name.trim());
    } catch (error) {
      if (error instanceof ModelRefusal) return fail(422, error.message, `Nothing was saved. ${error.hint}`);
      throw error;
    }
    return guarded(async (_current, stores) => {
      const who = deps.who ?? 'the Library';
      const src = `${name.trim()} (${converted.format.toUpperCase()}${converted.format === 'glb' ? '' : ', converted to GLB'}), uploaded by ${who} on ${today}`;
      const stored = await stores.assets.put(Buffer.from(converted.glb), 'model/gltf-binary', name.trim(), src);
      const link: ModelLink = {
        record,
        asset: stored.id,
        sourceKind: kindOf,
        src,
        ...(converted.stats.triangles > 0 ? { triangles: converted.stats.triangles } : {}),
      };
      await stores.links.put(link);
      return ok({ link, stats: converted.stats }, 200, { ETag: linkETag(link) });
    });
  }

  return fail(405, `${method} is not something this address accepts.`, MODEL_ROUTES.join('; '));
}

/**
 * A `.kicad_pcb` uploaded as a board's model source (cs-5k1.12): not
 * converted in the request. The file is kept as a catalog document
 * (`MODEL_SOURCES_DIR`, named by its sha256) and the board is linked to the
 * model it makes — an assembly of its Edge.Cuts outline and the KiCad library
 * models its footprints name, fetched at the pinned kicad-packages3D commit —
 * which the `model-cache` job builds once the link is committed. Until then
 * the viewer says the model is not built yet.
 */
async function uploadBoardFile(
  request: ModelRequest,
  deps: ModelDeps,
  upload: {
    kind: DefinitionKind;
    id: string;
    record: string;
    name: string;
    bytes: Uint8Array;
    today: string;
    guarded: (write: (current: ModelLink | undefined, stores: { links: ModelLinkStore; assets: AssetStore; docs?: DocStore }) => Promise<ApiResponse>) => Promise<ApiResponse>;
  },
): Promise<ApiResponse> {
  if (upload.kind !== 'pcbas') return fail(400, 'A KiCad board file is the model of a board.', 'Upload it on a board (pcbas) record, or upload a STEP, STL or GLB here.');
  if ((deps.docs ?? undefined) === undefined) return fail(501, 'This studio does not keep catalog documents, so it cannot keep a board file.', 'Upload a STEP, STL or GLB instead.');
  const text = new TextDecoder().decode(upload.bytes);
  let board: ReturnType<typeof parseKicadPcb>;
  try {
    board = parseKicadPcb(text);
  } catch (error) {
    return fail(422, `${upload.name} is not a KiCad board file this studio can read.`, `Nothing was saved. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (board.outlines[0] === undefined) return fail(422, `${upload.name} has no closed board outline (Edge.Cuts).`, 'Nothing was saved. Close the outline in KiCad and upload it again.');
  // the bytes the reader will hand back: the text as stored
  const stored = new TextEncoder().encode(text);
  const sha = sha256Hex(stored);
  const path = `${MODEL_SOURCES_DIR}/${sha}.kicad_pcb.txt`;
  const files: SourceFile[] = [{ path, sha256: sha }, ...(await boardArtFiles(deps.depictions, upload.id))];
  const build: ModelBuild = { kind: 'assembly', library: KICAD_LIBRARY.commit };
  const refs = boardLibraryRefs(board);
  const current = await deps.links!.get(upload.record);
  const early = checkIfMatch(request.ifMatch, linkETag(current), '3D model link', upload.record);
  if (early !== undefined) return early;
  return upload.guarded(async (_current, stores) => {
    if (stores.docs === undefined) return fail(501, 'This studio does not keep catalog documents, so it cannot keep a board file.');
    if ((await stores.docs.read(path)) === undefined) await stores.docs.write(path, text);
    const who = deps.who ?? 'the Library';
    const link: ModelLink = {
      record: upload.record,
      asset: sourceKey(files, MAX_MODEL_TRIANGLES, build),
      files,
      build,
      name: upload.name.replace(/\.kicad_pcb$/i, ''),
      sourceKind: 'kicad-board',
      src: `${upload.name} (KiCad board, ${board.footprints.length} footprints), uploaded by ${who} on ${upload.today}; footprint models from ${KICAD_LIBRARY.name} ${KICAD_LIBRARY.tag} (${KICAD_LIBRARY.licence}), fetched when the model is built, never committed`,
    };
    await stores.links.put(link);
    return ok(
      { link, board: { footprints: board.footprints.length, libraryModels: refs.length, embeddedModels: board.embeddedNames.length }, state: 'not-built', hint: 'The model is built by the model-cache job; reload the viewer when it has run.' },
      200,
      { ETag: linkETag(link) },
    );
  });
}
