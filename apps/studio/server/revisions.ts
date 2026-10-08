/**
 * Revisions of library records over the API (`@wirehub/model` `record-revisions.ts`,
 * `docs/revisions.md`):
 *
 *   GET  /api/revisions/:kind/:id               the record's revisions (summaries), the one it equals now,
 *                                               where each is used, and the revisions modules supply
 *   GET  /api/revisions/:kind/:id/:rev          one revision in full (snapshot, art, model)
 *   POST /api/revisions/:kind/:id               { note, label?, art?, model?, renumber? } — save the record as
 *                                               the next revision; `renumber` first gives the record the
 *                                               scheme's next variant of its number (one change set)
 *   PUT  /api/revisions/:kind/:id               { kind, id, revisions } — replace the history (If-Match): an
 *                                               import from another system
 *   GET  /api/revisions/:kind/:id/next-number   the scheme's next variant of the record's number (a proposal)
 *
 * The history is the catalog document `data/revisions/<kind>/<id>.json`, written through the unit
 * of work on both backends. A module's `revisionSources` add read-only revisions from outside.
 */

import {
  definitionUsage,
  findLibraryRecord,
  isRevisionKind,
  knownPartNumbers,
  recordRevisionProblems,
  revisionFilePath,
  revisionOfRecord,
  revisionsWhereUsed,
  saveRecordRevision,
  type CableDesign,
  type DesignVersionFile,
  type ExternalRevision,
  type PnKind,
  type RecordRevisionFile,
  type RevisionArt,
} from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { handleDefinitionRequest } from './definitions.ts';
import { readAllDesigns } from './designs.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { LOCAL_FALLBACK, type StudioUser } from './me.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';
import { releasedOf } from './products.ts';

export const REVISION_ROUTES = [
  'GET    /api/revisions/:kind/:id',
  'POST   /api/revisions/:kind/:id',
  'PUT    /api/revisions/:kind/:id',
  'GET    /api/revisions/:kind/:id/:rev',
  'GET    /api/revisions/:kind/:id/next-number',
] as const;

export const isRevisionsPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'revisions';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

async function readFile(deps: WorkbenchDeps, kind: string, id: string): Promise<RecordRevisionFile | undefined> {
  const stored = await deps.docs?.read(revisionFilePath(kind, id));
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as RecordRevisionFile) : undefined;
}

/** The number kind a record of `kind` is numbered as (`undefined`: the scheme does not number it). */
function pnKindOf(kind: string, record: Record<string, unknown>): PnKind | undefined {
  switch (kind) {
    case 'connectors':
    case 'bodies':
      return 'connector';
    case 'components':
      return 'component';
    case 'wires':
      return 'wire';
    case 'pcbas':
      return 'pcba';
    case 'kits':
      return 'kit';
    case 'mechanicals':
      return record['kind'] === 'shell' ? 'shell' : record['kind'] === 'fastener' ? 'fastener' : 'mechanical-other';
    default:
      return undefined;
  }
}

async function versionFiles(deps: WorkbenchDeps, designs: readonly CableDesign[]): Promise<DesignVersionFile[]> {
  const out: DesignVersionFile[] = [];
  if (deps.versions === undefined) return out;
  for (const d of designs) {
    for (const rev of await deps.versions.revisions(d.id)) {
      const file = await deps.versions.read(d.id, rev);
      if (file !== undefined) out.push(file);
    }
  }
  return out;
}

/** The revisions every module source knows for the record (a source that throws is reported, not fatal). */
async function external(deps: WorkbenchDeps, kind: string, id: string, record: Record<string, unknown> | undefined): Promise<{ module: string; source: string; label: string; revisions: readonly ExternalRevision[]; error?: string }[]> {
  const out: { module: string; source: string; label: string; revisions: readonly ExternalRevision[]; error?: string }[] = [];
  const db = await deps.loadDb();
  for (const source of deps.modules?.revisionSources(kind) ?? []) {
    try {
      const revisions = await source.list({ kind, id, ...(record === undefined ? {} : { record }) }, db);
      out.push({ module: source.module, source: source.id, label: source.label, revisions });
    } catch (error) {
      out.push({ module: source.module, source: source.id, label: source.label, revisions: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

async function view(deps: WorkbenchDeps, kind: string, id: string, file?: RecordRevisionFile): Promise<ApiResponse> {
  const db = await deps.loadDb();
  const record = findLibraryRecord(db, kind, id);
  const history = file ?? (await readFile(deps, kind, id));
  if (record === undefined && history === undefined) return fail(404, `There is no ${kind} record '${id}'.`);
  const designs = await readAllDesigns(deps.designs);
  const users = definitionUsage(db, designs, kind as never, id).designs;
  const versions = await versionFiles(deps, designs);
  const released = await releasedOf(deps, designs.filter((d) => versions.some((v) => v.designId === d.id)));
  const matching = record === undefined ? undefined : revisionOfRecord(history, record);
  const latest = history?.revisions.at(-1);
  return {
    status: 200,
    body: {
      kind,
      id,
      label: typeof record?.['label'] === 'string' ? record['label'] : id,
      current: {
        ...(record === undefined ? { gone: true } : { record }),
        ...(typeof record?.['partNumber'] === 'string' ? { partNumber: record['partNumber'] } : {}),
        ...(matching === undefined ? {} : { rev: matching.rev }),
        ...(matching === undefined && latest !== undefined ? { changedSince: latest.rev } : {}),
      },
      revisions: (history?.revisions ?? []).map(({ record: _r, art, model, ...summary }) => ({ ...summary, hasArt: art !== undefined, ...(model === undefined ? {} : { model }) })),
      external: await external(deps, kind, id, record),
      whereUsed: revisionsWhereUsed(history, kind, id, record, users, versions, released),
      etag: contentETag(history ?? null),
    },
    headers: { ETag: contentETag(history ?? null) },
  };
}

function readArt(value: unknown): RevisionArt | undefined | 'bad' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || typeof (value as RevisionArt).view !== 'string' || typeof (value as RevisionArt).svg !== 'string') return 'bad';
  const art = value as RevisionArt;
  return /<svg[\s>/]/i.test(art.svg) && art.svg.length <= 512 * 1024 ? { view: art.view, svg: art.svg } : 'bad';
}

async function nextNumber(deps: WorkbenchDeps, kind: string, id: string): Promise<{ pn?: string; explanation?: string; reason?: string }> {
  const db = await deps.loadDb();
  const record = findLibraryRecord(db, kind, id);
  if (record === undefined) return { reason: `there is no ${kind} record '${id}'` };
  const current = typeof record['partNumber'] === 'string' ? record['partNumber'] : typeof record['sku'] === 'string' ? record['sku'] : undefined;
  const pnKind = pnKindOf(kind, record);
  if (pnKind === undefined) return { reason: `the numbering scheme does not number ${kind}` };
  const scheme = await partNumberSchemeOf(deps);
  const suggestion = scheme.suggest({ kind: pnKind, label: String(record['label'] ?? id), id, ...(current === undefined ? {} : { variantOf: current }) }, knownPartNumbers(db, await readAllDesigns(deps.designs)));
  if (suggestion === undefined) return { reason: 'the numbering scheme proposes no number' };
  return { pn: suggestion.pn, explanation: suggestion.explanation };
}

export async function handleRevisionsRequest(method: string, parts: string[], body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined, user: StudioUser | undefined): Promise<ApiResponse> {
  const [, , kind, id, rest] = parts;
  if (kind === undefined || id === undefined || parts.length > 5) return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${REVISION_ROUTES.join('; ')}.`);
  if (!isRevisionKind(kind)) return fail(400, `'${kind}' keeps no revisions.`, 'Connectors, components, wires, boards, mechanicals, kits, bodies and pinouts do.');
  if (deps.docs === undefined) return fail(501, 'This hub does not keep catalog documents by path.', 'Revisions are stored with the catalog.');

  if (rest === 'next-number') {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const next = await nextNumber(deps, kind, id);
    return next.pn === undefined ? fail(422, `No number to propose: ${next.reason ?? ''}.`) : { status: 200, body: { suggestion: { pn: next.pn, explanation: next.explanation } } };
  }
  if (rest !== undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const file = await readFile(deps, kind, id);
    const found = file?.revisions.find((r) => String(r.rev) === rest);
    return found === undefined ? fail(404, `${kind}/${id} has no revision ${rest}.`) : { status: 200, body: found };
  }

  if (method === 'GET') return view(deps, kind, id);

  if (method === 'PUT') {
    const current = await readFile(deps, kind, id);
    const guard = checkIfMatch(ifMatch, contentETag(current ?? null), 'revisions', `${kind}/${id}`);
    if (guard !== undefined) return guard;
    const problems = recordRevisionProblems(body, kind, id);
    if (problems.length > 0) return fail(422, `That history cannot be used: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}.`, 'Nothing was saved.', { problems });
    const file = body as RecordRevisionFile;
    const next: RecordRevisionFile = { kind, id, revisions: [...file.revisions].sort((a, b) => a.rev - b.rev) };
    await deps.docs.write(revisionFilePath(kind, id), next);
    return view(deps, kind, id, next);
  }

  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers GET, POST and PUT.');
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const note = typeof request['note'] === 'string' ? request['note'] : '';
  const art = readArt(request['art']);
  if (art === 'bad') return fail(400, 'art must be { view, svg } with SVG text of at most 512 KB.');
  const modelAsset = typeof request['model'] === 'object' && request['model'] !== null ? (request['model'] as { asset?: unknown; mime?: unknown }) : undefined;
  if (modelAsset !== undefined && !/^[0-9a-f]{64}$/.test(String(modelAsset.asset))) return fail(400, 'model.asset must be the model\'s content address (sha256).');
  const db = await deps.loadDb();
  let record = findLibraryRecord(db, kind, id);
  if (record === undefined) return fail(404, `There is no ${kind} record '${id}'.`);
  const history = await readFile(deps, kind, id);

  // a new variant number first: the record is saved with it, through the definitions' own checks
  let renumbered: string | undefined;
  if (request['renumber'] === true) {
    const next = await nextNumber(deps, kind, id);
    if (next.pn === undefined) return fail(422, `No new number: ${next.reason ?? ''}.`, 'Nothing was saved.');
    const got = await handleDefinitionRequest('GET', ['api', 'definitions', kind, id], undefined, deps);
    if (got === undefined || got.status !== 200) return fail(409, `${kind}/${id} cannot be renumbered here.`, 'Nothing was saved.');
    const field = kind === 'kits' ? 'sku' : 'partNumber';
    const put = await handleDefinitionRequest('PUT', ['api', 'definitions', kind, id], { ...(got.body as object), [field]: next.pn }, deps, got.headers?.['ETag']);
    if (put === undefined || put.status >= 300) return put ?? fail(409, 'The record could not be renumbered.');
    renumbered = next.pn;
    record = { ...record, [field]: next.pn };
  } else if (revisionOfRecord(history, record) !== undefined && request['force'] !== true) {
    return fail(409, `${kind}/${id} has not changed since revision ${revisionOfRecord(history, record)!.rev}.`, 'Change the record first, or send force: true to save the same state again.');
  }

  const who = user ?? deps.localUser ?? LOCAL_FALLBACK;
  const next = saveRecordRevision(history, kind, id, record, {
    note,
    at: deps.now?.() ?? new Date().toISOString(),
    by: who.name,
    ...(typeof request['label'] === 'string' ? { label: request['label'] } : {}),
    ...(art === undefined ? {} : { art }),
    ...(modelAsset === undefined ? {} : { model: { asset: String(modelAsset.asset), ...(typeof modelAsset.mime === 'string' ? { mime: modelAsset.mime } : {}) } }),
  });
  await deps.docs.write(revisionFilePath(kind, id), next);
  const answer = await view(deps, kind, id, next);
  // the record the library loads still has its old number until the change set commits: say what it is now
  if (renumbered !== undefined && answer.status === 200) (answer.body as { current: Record<string, unknown> }).current = { record, partNumber: renumbered, rev: next.revisions.at(-1)!.rev };
  return { ...answer, status: 201 };
}
