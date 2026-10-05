/**
 * Module importers and exporters on the server (`docs/modules.md`).
 *
 *   POST /api/modules/<module>/_import/<importer>
 *        { fileName, base64, accept? }
 *        Runs the importer over the file. Without `accept` it only answers the
 *        proposal (what it would add, what is already there, the notes); with
 *        `accept: true` the same proposal is written — new definitions and
 *        designs, in one change set (the batch machinery), never overwriting a
 *        record that exists. The file is read again on accept, so what is
 *        written is what the importer says now, not what a client claims.
 *   GET  /api/modules/<module>/_export/<exporter>?design=<id>[&…options]
 *        Renders one stored design with the exporter; the answer is the file.
 *
 * Sub-paths starting with `_` are reserved for the host (an integration route
 * may not use one — `manifestProblems`).
 */

import { parseDepictionMeta, stripUnsafeSvg, validateDepiction } from '@wirehub/catalog/src/depictions/index.ts';
import type { BoardPartsEntry, CableDesign, Db } from '@wirehub/model';
import type { ContinuityData, ImportedDepiction, ImportResult, ModuleRegistry } from '@wirehub/modules';

import type { ApiResponse } from './api.ts';
import type { BatchRequestItem } from './batch.ts';
import type { DepictionStore } from './depictions.ts';
import type { DocStore } from './storage/doc-store.ts';

export interface ModuleIoPath {
  kind: 'import' | 'export';
  module: string;
  id: string;
}

/** `/api/modules/<module>/_import/<id>` or `…/_export/<id>`, else undefined. */
export function parseModuleIoPath(path: string): ModuleIoPath | undefined {
  const parts = (path.split('?')[0] ?? '').split('/').filter((p) => p !== '');
  if (parts[0] !== 'api' || parts[1] !== 'modules' || parts[2] === undefined || parts.length !== 5) return undefined;
  const marker = parts[3];
  if (marker !== '_import' && marker !== '_export') return undefined;
  try {
    return { kind: marker === '_import' ? 'import' : 'export', module: decodeURIComponent(parts[2]), id: decodeURIComponent(parts[4] as string) };
  } catch {
    return undefined;
  }
}

const refuse = (status: number, error: string, hint: string): ApiResponse => ({ status, body: { error, hint } });

const KINDS = ['connectors', 'wires', 'components', 'pcbas', 'mechanicals'] as const;

export interface Proposal {
  /** definitions the importer proposes that the library does not have yet, by kind */
  definitions: Record<string, { id: string; label: string }[]>;
  /** ids the library already has (skipped, never overwritten), `<kind>/<id>`; `board-parts/<board>@<rev>` and `depictions/<id>` too */
  existing: string[];
  designs: { id: string; label: string }[];
  existingDesigns: string[];
  /** board revisions whose placed parts are proposed, `<board>@<revision>` (present only when the importer proposed some) */
  boardParts?: string[];
  /** definitions whose board art is proposed (present only when the importer proposed some) */
  depictions?: string[];
  notes: string[];
}

/** What a proposal stages besides routed requests: placed parts and artwork (`stageImportExtras`). */
export interface ImportExtras {
  boardParts: BoardPartsEntry[];
  depictions: ImportedDepiction[];
}

/** The importer's result as a proposal against `db` and the stored design ids. */
export function proposalOf(result: ImportResult, db: Db, designIds: ReadonlySet<string>): { proposal: Proposal; requests: BatchRequestItem[]; extras: ImportExtras } {
  const taken = new Set<string>();
  for (const kind of KINDS) for (const record of (db[kind] ?? []) as { id: string }[]) taken.add(record.id);
  for (const kind of ['bodies', 'interfaces', 'kits'] as const) for (const record of ((db as unknown as Record<string, { id: string }[] | undefined>)[kind] ?? [])) taken.add(record.id);
  const proposal: Proposal = { definitions: {}, existing: [], designs: [], existingDesigns: [], notes: [...result.notes] };
  const requests: BatchRequestItem[] = [];
  for (const kind of KINDS) {
    for (const record of (result.definitions?.[kind] ?? []) as { id: string; label: string }[]) {
      if (taken.has(record.id)) {
        proposal.existing.push(`${kind}/${record.id}`);
        continue;
      }
      taken.add(record.id);
      (proposal.definitions[kind] ??= []).push({ id: record.id, label: record.label });
      requests.push({ method: 'POST', path: `/api/definitions/${kind}`, body: record });
    }
  }
  for (const design of result.designs ?? []) {
    if (designIds.has(design.id)) {
      proposal.existingDesigns.push(design.id);
      continue;
    }
    proposal.designs.push({ id: design.id, label: design.label });
    requests.push({ method: 'POST', path: '/api/designs', body: design });
  }
  const extras: ImportExtras = { boardParts: [], depictions: [] };
  const listed = new Set((db.boardParts ?? []).map((e) => `${e.board}@${e.revision}`));
  for (const entry of result.boardParts ?? []) {
    const key = `${entry.board}@${entry.revision}`;
    if (listed.has(key)) {
      proposal.existing.push(`board-parts/${key}`);
      continue;
    }
    listed.add(key);
    (proposal.boardParts ??= []).push(key);
    extras.boardParts.push(entry);
  }
  for (const depiction of result.depictions ?? []) {
    if (extras.depictions.some((d) => d.defId === depiction.defId)) continue;
    (proposal.depictions ??= []).push(depiction.defId);
    extras.depictions.push(depiction);
  }
  return { proposal, requests, extras };
}

/** A refusal while staging an import's extras: the whole import writes nothing. */
export class ImportExtrasRefused extends Error {}

const ART_FILE = /^[a-z0-9][a-z0-9._-]*\.svg$/;
const BOARD_PARTS = 'data/board-parts.json';

function viewKinds(meta: unknown): string[] {
  const views = (meta as { views?: Record<string, { sourceKind?: unknown }> } | undefined)?.views;
  return views === undefined || typeof views !== 'object' ? [] : Object.values(views).map((v) => String(v?.sourceKind ?? ''));
}

/**
 * Stage an import's placed parts and artwork into a unit of work's stores,
 * after its records (so anchors are checked against the boards it adds).
 * Placed parts are appended to `data/board-parts.json`; a depiction is
 * written only where none exists, or where every view of the existing one is
 * of a tier the importer says it replaces. Every SVG goes through the
 * artwork sanitiser and every manifest through the depiction validator;
 * any refusal throws `ImportExtrasRefused` and nothing is written. Answers
 * the depictions it skipped (kept as they were).
 */
export async function stageImportExtras(
  stores: { docs?: DocStore; depictions?: DepictionStore; loadDb: () => Db | Promise<Db> },
  extras: ImportExtras,
): Promise<{ keptDepictions: string[] }> {
  if (extras.boardParts.length > 0) {
    if (stores.docs === undefined) throw new ImportExtrasRefused('This studio does not keep catalog documents, so placed parts cannot be imported.');
    const current = ((await stores.docs.read(BOARD_PARTS)) ?? {}) as { src?: string; boards?: BoardPartsEntry[] };
    const boards = [...(current.boards ?? [])];
    for (const entry of extras.boardParts) {
      if (boards.some((b) => b.board === entry.board && b.revision === entry.revision)) continue;
      const { builds: _builds, ...stored } = entry;
      boards.push(stored);
    }
    await stores.docs.write(BOARD_PARTS, { src: current.src ?? 'The parts placed on each board revision, linked to component records; written by board imports and by hand.', boards });
  }
  const kept: string[] = [];
  if (extras.depictions.length === 0) return { keptDepictions: kept };
  const store = stores.depictions;
  if (store === undefined) throw new ImportExtrasRefused('This studio does not keep artwork, so board art cannot be imported.');
  const db = await stores.loadDb();
  for (const depiction of extras.depictions) {
    const existing = await store.readMeta(depiction.defId);
    if (existing !== undefined) {
      const kinds = viewKinds(existing);
      const replaceable = depiction.replaces !== undefined && kinds.length > 0 && kinds.every((k) => depiction.replaces!.includes(k));
      if (!replaceable) {
        kept.push(depiction.defId);
        continue;
      }
    }
    const parsed = parseDepictionMeta(depiction.meta, `depictions/${depiction.defId}`);
    if (parsed.meta === undefined || parsed.meta.defId !== depiction.defId) {
      throw new ImportExtrasRefused(`The art proposed for ${depiction.defId} is not a valid depiction: ${parsed.issues.map((i) => i.message).join('; ') || 'its defId does not match'}.`);
    }
    const problems = validateDepiction(parsed.meta, { db }).filter((i) => i.severity === 'error');
    if (problems.length > 0) throw new ImportExtrasRefused(`The art proposed for ${depiction.defId} does not fit the board: ${problems.map((i) => i.message).join('; ')}.`);
    for (const [name, text] of Object.entries(depiction.files)) {
      if (!ART_FILE.test(name)) throw new ImportExtrasRefused(`${depiction.defId}: '${name}' is not an SVG file name.`);
      const clean = stripUnsafeSvg(text);
      if (clean.svg === undefined) throw new ImportExtrasRefused(`${depiction.defId}/${name} is refused: ${clean.error ?? 'not an SVG'}.`);
      await store.writeAsset(depiction.defId, name, clean.svg);
    }
    await store.writeMeta(depiction.defId, depiction.meta);
  }
  return { keptDepictions: kept };
}

const OPTION_NAME = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;

/**
 * An import's review-step options (`ImportInput.options`): an object of
 * text values, at most 32 of them and 64 kB in all. `undefined` when absent;
 * a sentence when malformed.
 */
export function readImportOptions(value: unknown): Record<string, string> | undefined | string {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'The import options must be an object of text values.';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) return 'An import takes at most 32 options.';
  let size = 0;
  const out: Record<string, string> = {};
  for (const [name, v] of entries) {
    if (!OPTION_NAME.test(name)) return `'${name}' is not an option name.`;
    if (typeof v !== 'string') return `Option '${name}' must be text.`;
    size += name.length + v.length;
    out[name] = v;
  }
  if (size > 65_536) return 'The import options are too long (64 kB at most).';
  return entries.length === 0 ? undefined : out;
}

/** The `option.<name>` query parameters of a raw upload, as import options. */
export function importOptionsOfQuery(query: URLSearchParams): Record<string, string> | undefined | string {
  const out: Record<string, string> = {};
  let any = false;
  for (const [key, value] of query) {
    if (!key.startsWith('option.')) continue;
    out[key.slice('option.'.length)] = value;
    any = true;
  }
  return any ? readImportOptions(out) : undefined;
}

/** The importer's result for the request's file, or the refusal. */
export async function runImporter(
  registry: ModuleRegistry | undefined,
  io: ModuleIoPath,
  body: unknown,
  db: Db,
): Promise<{ ok: true; result: ImportResult; accept: boolean } | { ok: false; response: ApiResponse }> {
  const importer = registry?.importer(io.module, io.id);
  if (importer === undefined) return { ok: false, response: refuse(404, `${io.module} has no importer ${io.id}.`, "Check the deployment's modules.config.ts.") };
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { fileName?: unknown; base64?: unknown; accept?: unknown; options?: unknown }) : {};
  const options = readImportOptions(b.options);
  if (typeof options === 'string') return { ok: false, response: refuse(400, options, 'Options are names and text values: { "options": { "board": "…" } }.') };
  if (typeof b.fileName !== 'string' || b.fileName.trim() === '' || typeof b.base64 !== 'string') {
    return { ok: false, response: refuse(400, 'Send { "fileName": …, "base64": … }.', 'The file goes in as base64 text.') };
  }
  const lower = b.fileName.toLowerCase();
  if (!importer.accepts.some((ext) => lower.endsWith(ext))) {
    return { ok: false, response: refuse(400, `${importer.label} takes ${importer.accepts.join(' or ')} files, not ${b.fileName}.`, 'Pick another file.') };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b.base64, 'base64'));
  } catch {
    return { ok: false, response: refuse(400, 'The file is not valid base64.', 'Nothing was read.') };
  }
  try {
    return { ok: true, result: await importer.import({ fileName: b.fileName, bytes, ...(options === undefined ? {} : { options }) }, db), accept: b.accept === true };
  } catch (error) {
    return { ok: false, response: refuse(422, `${importer.label} could not read ${b.fileName}.`, error instanceof Error ? error.message : String(error)) };
  }
}

/** One stored design rendered by an exporter. */
export async function runExporter(
  registry: ModuleRegistry | undefined,
  io: ModuleIoPath,
  query: URLSearchParams,
  load: (id: string) => Promise<CableDesign | undefined>,
  db: Db,
  /** the design's continuity data, for an exporter with `source: 'continuity'` */
  continuity?: (design: CableDesign, db: Db) => Promise<ContinuityData> | ContinuityData,
): Promise<ApiResponse> {
  const exporter = registry?.exporter(io.module, io.id);
  if (exporter === undefined) return refuse(404, `${io.module} has no exporter ${io.id}.`, "Check the deployment's modules.config.ts.");
  const id = query.get('design');
  if (id === null || id === '') return refuse(400, 'Say which design: ?design=<id>.', 'The exporter renders one stored design.');
  const design = await load(id);
  if (design === undefined) return refuse(404, `There is no design '${id}'.`, 'Check the id.');
  const options: Record<string, unknown> = {};
  for (const [key, value] of query) if (key !== 'design') options[key] = value;
  if (exporter.source === 'continuity' && continuity !== undefined) options['continuity'] = await continuity(design, db);
  let out;
  try {
    out = await exporter.render(design, db, options);
  } catch (error) {
    return refuse(422, `${exporter.label} could not render ${id}.`, error instanceof Error ? error.message : String(error));
  }
  const bytes = typeof out.body === 'string' ? new TextEncoder().encode(out.body) : out.body;
  return {
    status: 200,
    body: null,
    bytes,
    contentType: out.mimeType,
    headers: { 'Content-Disposition': `attachment; filename="${out.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"` },
  };
}
