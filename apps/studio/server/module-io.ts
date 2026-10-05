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

import type { CableDesign, Db } from '@wirehub/model';
import type { ContinuityData, ImportResult, ModuleRegistry } from '@wirehub/modules';

import type { ApiResponse } from './api.ts';
import type { BatchRequestItem } from './batch.ts';

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
  /** ids the library already has (skipped, never overwritten), `<kind>/<id>` */
  existing: string[];
  designs: { id: string; label: string }[];
  existingDesigns: string[];
  notes: string[];
}

/** The importer's result as a proposal against `db` and the stored design ids. */
export function proposalOf(result: ImportResult, db: Db, designIds: ReadonlySet<string>): { proposal: Proposal; requests: BatchRequestItem[] } {
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
  return { proposal, requests };
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
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { fileName?: unknown; base64?: unknown; accept?: unknown }) : {};
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
    return { ok: true, result: await importer.import({ fileName: b.fileName, bytes }, db), accept: b.accept === true };
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
