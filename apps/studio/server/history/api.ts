/**
 * The history routes (cs-5k1.4) — request in, response out, no IO of their
 * own: the source (`deps.history`) reads the change sets or the git log, and
 * a restore goes through the very routes an edit takes.
 *
 *   GET  /api/history                          the hub's entries (?person=&from=&to=&kind=&before=&limit=)
 *   GET  /api/history/records/:subject         one record's entries (?before=&limit=)
 *   GET  /api/history/entries/:id              one entry, what it changed (?subject=)
 *   POST /api/history/records/:subject/restore { entry, current } — the subject back to its state after `entry`
 *   GET  /api/history/checkpoints               agent checkpoints: each API token's change sets, grouped
 *   GET  /api/history/checkpoints/:token        one checkpoint (?from=): its change sets, the records it changed
 *   POST /api/history/checkpoints/:token/restore { from?, current } — undo them together (`checkpoints.ts`)
 *
 * A restore never rewrites history: it is a new save — on the database a new
 * change set, attributed to the person who asked and restorable in its turn;
 * on files a new write (a new commit with the git export on). It goes
 * through the design and definition routes, so it is validated like any
 * edit, the edit lock on the subject is checked in front of it
 * (`recordsOfWrite`), and `current` — each restorable part's version as the
 * person saw it (`GET …/entries/:id?subject=`) — must still hold, or nothing
 * is written (409).
 */

import { createHash } from 'node:crypto';

import { composeConnector, type ConnectorRecord } from '@wirehub/model';

import {
  isHistoryKind,
  parseSubject,
  restorableParts,
  subjectKey,
  subjectLabel,
  type HistoryEntryDetail,
  type HistoryPage,
  type Known,
  type RecordDiff,
  type RestoreAnswer,
  type Subject,
  UNKNOWN,
} from '../../src/history/types.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { decodeImageDataUri } from '../assets.ts';
import type { StudioUser } from '../me.ts';
import { namesOwnerOnlySettings } from '../runtime-settings.ts';
import { contentETag, ifMatchSatisfied, staleWriteResponse } from '../etag.ts';
import type { DefinitionKind } from '../definition-store.ts';
import { restoreKnowledgeDoc } from '../knowledge.ts';
import type { DomainEvent } from '../webhooks/events.ts';
import { handleCheckpointRequest } from './checkpoints.ts';
import { restoreList } from './list-restore.ts';
import { currentParts, etagOf, fail, methodNotAllowed, ok, quotedParts, recorded, restorePhotoTo, type Route } from './shared.ts';
import type { HistoryQuery, HistorySource } from './source.ts';

export const HISTORY_ROUTES = [
  'GET    /api/history',
  'GET    /api/history/records/:subject',
  'GET    /api/history/entries/:id',
  'POST   /api/history/records/:subject/restore',
  'GET    /api/history/checkpoints',
  'GET    /api/history/checkpoints/:token',
  'POST   /api/history/checkpoints/:token/restore',
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function limitOf(query: URLSearchParams, fallback: number): number {
  const n = Number(query.get('limit') ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : fallback;
}

function badSubject(text: string): ApiResponse {
  return fail(400, `${JSON.stringify(text)} is not a record whose history can be shown.`, 'Name it as design:<id> or definition:<kind>:<id> (also vocab:<list>, build:<name>, note:<id>, project:<id>).');
}

/**
 * Handles `/api/history…`; `undefined` for any other path. `request.path`
 * keeps its query string here.
 */
export async function handleHistoryRequest(request: ApiRequest, deps: WorkbenchDeps, route: Route): Promise<ApiResponse | undefined> {
  const [pathPart = '', queryText = ''] = request.path.split('?');
  const parts = pathPart.split('/').filter((p) => p !== '').map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts[0] !== 'api' || parts[1] !== 'history') return undefined;
  const method = request.method.toUpperCase();
  const query = new URLSearchParams(queryText);
  const source: HistorySource | undefined = deps.history;
  if (source === undefined) return fail(501, 'This hub keeps no change history.', 'The database backend records every save; the file backend reads the git log of its catalog.');
  const capabilities = await source.capabilities();
  const [, , section, id, action, ...rest] = parts;
  if (rest.length > 0) return fail(404, `${pathPart} is not part of the history API.`, `Try one of: ${HISTORY_ROUTES.join('; ')}.`);

  // the hub-wide list
  if (section === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    const from = query.get('from') ?? undefined;
    const to = query.get('to') ?? undefined;
    const kind = query.get('kind') ?? undefined;
    if ((from !== undefined && !DATE.test(from)) || (to !== undefined && !DATE.test(to))) return fail(400, 'Dates are written YYYY-MM-DD.', 'For example ?from=2026-10-01&to=2026-10-05.');
    if (kind !== undefined && !isHistoryKind(kind)) return fail(400, `${JSON.stringify(kind)} is not a kind of change.`, 'Use design, library, vocab, builds or other.');
    const q: HistoryQuery = {
      limit: limitOf(query, 50),
      ...(query.get('person') === null ? {} : { person: query.get('person') as string }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(kind === undefined ? {} : { kind: kind as HistoryQuery['kind'] & string }),
      ...(query.get('before') === null ? {} : { before: query.get('before') as string }),
      ...(query.get('token') === null || query.get('token') === '' ? {} : { token: query.get('token') as string }),
    };
    if (q.token !== undefined && !/^[0-9a-f-]{36}$/i.test(q.token)) return fail(400, `${JSON.stringify(q.token)} is not an API token id.`, 'Pick an agent checkpoint from the History page.');
    const page: HistoryPage = { capabilities, ...(await source.list(q)) };
    return ok(page);
  }

  if (section === 'checkpoints') return handleCheckpointRequest({ method, token: id, action, query, request, deps, source, capabilities, route });

  if (section === 'records' && id !== undefined) {
    const subject = parseSubject(id);
    if (subject === undefined) return badSubject(id);
    if (action === undefined) {
      if (method !== 'GET') return methodNotAllowed(method, ['GET']);
      const before = query.get('before') ?? undefined;
      const page: HistoryPage = { capabilities, ...(await source.record(subject, { limit: limitOf(query, 30), ...(before === undefined ? {} : { before }) })) };
      return ok(page);
    }
    if (action === 'restore') {
      if (method !== 'POST') return methodNotAllowed(method, ['POST']);
      return restore(subject, request, deps, source, capabilities.restore, route);
    }
  }

  if (section === 'entries' && id !== undefined && action === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    const subjectText = query.get('subject');
    const subject = subjectText === null ? undefined : parseSubject(subjectText);
    if (subjectText !== null && subject === undefined) return badSubject(subjectText);
    const found = await source.detail(id, subject);
    if (found === undefined) return fail(404, `There is no change ${JSON.stringify(id)} in this hub's history.`, 'Pick one from the History list.');
    const detail: HistoryEntryDetail = { capabilities, ...found, records: hideOwnerOnly(found.records, request.user) };
    if (subject !== undefined && capabilities.restore) {
      const current = await currentParts(subject, deps);
      detail.current = Object.fromEntries(quotedParts(subject).map((part) => [part, etagOf(current[part])]));
    }
    return ok(detail);
  }

  return fail(404, `${pathPart} is not part of the history API.`, `Try one of: ${HISTORY_ROUTES.join('; ')}.`);
}

/**
 * The sign-in, notifications and integrations settings documents are owner-only: for anyone else
 * the history says that they changed (the record is named) but not what they held, before or after.
 */
function hideOwnerOnly(records: RecordDiff[], user: StudioUser | undefined): RecordDiff[] {
  if (user === undefined || user.role === undefined || user.role === 'owner') return records;
  return records.map((r) => (namesOwnerOnlySettings(r.subject) || namesOwnerOnlySettings(r.label) ? { ...r, op: 'unknown' as const, before: UNKNOWN, after: UNKNOWN, restorable: false } : r));
}


async function restore(subject: Subject, request: ApiRequest, deps: WorkbenchDeps, source: HistorySource, supported: boolean, route: Route): Promise<ApiResponse> {
  const key = subjectKey(subject);
  const label = subjectLabel(subject);
  if (!supported) return fail(501, 'This hub keeps no history to restore from.', 'The database backend records every save; on files, put the catalog in git with the git export on.');
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as { entry?: unknown; current?: unknown };
  if (typeof body.entry !== 'string' || body.entry === '') return fail(400, 'Say which change to restore to.', 'Send { "entry": "<change id>", "current": { … } } — the entry id and the versions from GET /api/history/entries/:id?subject=….');
  const entry = body.entry;
  const quoted = (typeof body.current === 'object' && body.current !== null ? body.current : undefined) as Record<string, unknown> | undefined;
  const ifMatch = request.headers?.['if-match'];
  if (quoted === undefined && ifMatch === undefined) {
    return fail(428, `Restoring ${label} needs the version you were looking at, and none was sent.`, 'Nothing was written. Open the change again (its versions come with it) and restore from there.');
  }

  const found = await source.stateAt(subject, entry);
  if (found === undefined) return fail(404, `There is no change ${JSON.stringify(entry)} in this hub's history.`, 'Pick one from the History list.');
  const current = await currentParts(subject, deps);
  const parts = restorableParts(subject);
  const main = parts[0] as string;
  // nothing moved since the person looked: every quoted part still has the version they saw
  for (const part of quotedParts(subject)) {
    const now = etagOf(current[part]);
    const saw = quoted?.[part];
    if (quoted !== undefined && saw !== undefined && saw !== now) return staleWriteResponse(subject.type === 'design' ? 'design' : 'record', key);
  }
  if (quoted === undefined && ifMatch !== undefined && !ifMatchSatisfied(ifMatch, etagOf(current[main]) ?? '""')) return staleWriteResponse(subject.type === 'design' ? 'design' : 'record', key);

  const target = recorded(found.parts[main], current[main]);
  if (!target.ok) {
    return fail(409, `The state of ${label} after that change was not recorded, so it cannot be restored.`, 'Changes saved before this hub kept earlier states can be shown but not always restored. Pick a later change.');
  }
  if (target.value === undefined) {
    return fail(409, `${label[0]?.toUpperCase() ?? ''}${label.slice(1)} did not exist after that change.`, current[main] === undefined ? 'It does not exist now either.' : 'To go back to before it existed, delete it instead.');
  }
  const restored: string[] = [];

  if (subject.type === 'design') {
    // a design renamed since keeps its history under its new id: the old state is put back under the current one
    const design = typeof target.value === 'object' && target.value !== null ? { ...(target.value as object), id: subject.id } : target.value;
    const now = current['design'];
    if (JSON.stringify(now) !== JSON.stringify(design)) {
      const answer =
        now === undefined
          ? await route({ method: 'POST', path: '/api/designs', body: design, ...(request.user === undefined ? {} : { user: request.user }) }, deps)
          : await route({ method: 'PUT', path: `/api/designs/${encodeURIComponent(subject.id)}`, body: design, headers: { 'if-match': contentETag(now) }, ...(request.user === undefined ? {} : { user: request.user }) }, deps);
      if (answer.status >= 400) return answer;
      restored.push('design');
    }
    // the drawing details, when that state was recorded and differs
    const drawing = recorded(found.parts['drawing'], current['drawing']);
    if (drawing.ok && drawing.value !== undefined && deps.drawings !== undefined && JSON.stringify(drawing.value) !== JSON.stringify(current['drawing'])) {
      await deps.drawings.writeMeta(subject.id, drawing.value as Parameters<NonNullable<WorkbenchDeps['drawings']>['writeMeta']>[1]);
      restored.push('drawing');
    }
    // the drawing photo, by the hash of its bytes
    const photo = await restorePhoto(subject.id, entry, subject, deps, source);
    if (photo.restored) restored.push('photo');
    const value = await deps.designs.read(subject.id);
    const answer: RestoreAnswer = {
      restored: { subject: key, entry, parts: restored },
      ...(photo.skipped === undefined ? {} : { skipped: [photo.skipped] }),
      ...(value === undefined ? {} : { value, etag: contentETag(value) }),
    };
    return ok(answer, value === undefined ? undefined : { ETag: contentETag(value) });
  }

  if (subject.type === 'note' || subject.type === 'project') {
    // through the knowledge store: the document and the index together
    const now = current['record'];
    let events: DomainEvent[] = [];
    if (JSON.stringify(now) !== JSON.stringify(target.value)) {
      events = (await restoreKnowledgeDoc(deps, subject.type, subject.id, target.value, (request.user ?? deps.localUser)?.name)).events;
      restored.push('record');
    }
    const value = (await currentParts(subject, deps))['record'];
    const answer: RestoreAnswer = { restored: { subject: key, entry, parts: restored }, ...(value === undefined ? {} : { value, etag: contentETag(value) }) };
    return { ...ok(answer, value === undefined ? undefined : { ETag: contentETag(value) }), ...(events.length === 0 ? {} : { events }) };
  }

  if (subject.type === 'vocab' || subject.type === 'build') return restoreList(subject, target.value, current['record'], { key, entry, request, deps, route });

  // a library record
  let record = target.value;
  if (found.stored === true && subject.kind === 'connectors') {
    const db = await deps.loadDb();
    record = composeConnector(record as ConnectorRecord, { bodies: db.bodies ?? [], interfaces: db.interfaces ?? [], ...(db.vocab === undefined ? {} : { vocab: db.vocab }) });
  }
  const now = current['record'];
  if (JSON.stringify(now) !== JSON.stringify(record)) {
    const answer =
      now === undefined
        ? await route({ method: 'POST', path: `/api/definitions/${subject.kind}`, body: record, ...(request.user === undefined ? {} : { user: request.user }) }, deps)
        : await route({ method: 'PUT', path: `/api/definitions/${subject.kind}/${encodeURIComponent(subject.id)}`, body: record, headers: { 'if-match': contentETag(now) }, ...(request.user === undefined ? {} : { user: request.user }) }, deps);
    if (answer.status >= 400) return answer;
    restored.push('record');
  }
  const value = (await deps.definitions?.list(subject.kind as DefinitionKind))?.find((r) => r.id === subject.id);
  const answer: RestoreAnswer = { restored: { subject: key, entry, parts: restored }, ...(value === undefined ? {} : { value, etag: contentETag(value) }) };
  return ok(answer, value === undefined ? undefined : { ETag: contentETag(value) });
}


/**
 * The drawing photo as it was right after `entry`: read the bytes by their
 * hash, then write them as the drawing's photo (what `PUT
 * /api/drawings/:id/photo` stores). A photo that cannot be brought back (its
 * bytes are gone, a legacy file) is skipped and says so; it never blocks
 * the rest of the restore.
 */
async function restorePhoto(id: string, entry: string, subject: Subject, deps: WorkbenchDeps, source: HistorySource): Promise<{ restored: boolean; skipped?: string }> {
  if (deps.drawings === undefined || source.photoAt === undefined) return { restored: false };
  return restorePhotoTo(id, await source.photoAt(subject, entry), deps);
}


