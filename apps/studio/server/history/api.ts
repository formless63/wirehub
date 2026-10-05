/**
 * The history routes (cs-5k1.4) — request in, response out, no IO of their
 * own: the source (`deps.history`) reads the change sets or the git log, and
 * a restore goes through the very routes an edit takes.
 *
 *   GET  /api/history                          the hub's entries (?person=&from=&to=&kind=&before=&limit=)
 *   GET  /api/history/records/:subject         one record's entries (?before=&limit=)
 *   GET  /api/history/entries/:id              one entry, what it changed (?subject=)
 *   POST /api/history/records/:subject/restore { entry, current } — the subject back to its state after `entry`
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
  type RestoreAnswer,
  type Subject,
} from '../../src/history/types.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { contentETag, ifMatchSatisfied, staleWriteResponse } from '../etag.ts';
import type { DefinitionKind } from '../definition-store.ts';
import type { HistoryQuery, HistorySource } from './source.ts';

export const HISTORY_ROUTES = [
  'GET    /api/history',
  'GET    /api/history/records/:subject',
  'GET    /api/history/entries/:id',
  'POST   /api/history/records/:subject/restore',
] as const;

type Route = (request: ApiRequest, deps: WorkbenchDeps) => Promise<ApiResponse>;

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

const ok = (body: unknown, headers?: Record<string, string>): ApiResponse => ({ status: 200, body, ...(headers === undefined ? {} : { headers }) });

function methodNotAllowed(method: string, allowed: string[]): ApiResponse {
  return fail(405, `${method} is not something this address accepts.`, `It answers ${allowed.join(' and ')}.`);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function limitOf(query: URLSearchParams, fallback: number): number {
  const n = Number(query.get('limit') ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : fallback;
}

function badSubject(text: string): ApiResponse {
  return fail(400, `${JSON.stringify(text)} is not a record whose history can be shown.`, 'Name it as design:<id> or definition:<kind>:<id> (also vocab:<list>, build:<name>).');
}

/** The current value of each restorable part, from the (staged) stores. */
async function currentParts(subject: Subject, deps: WorkbenchDeps): Promise<Record<string, unknown>> {
  if (subject.type === 'design') {
    const design = await deps.designs.read(subject.id);
    const drawing = deps.drawings === undefined || design === undefined ? undefined : (await deps.drawings.read(subject.id)).meta;
    return { design, drawing };
  }
  if (subject.type === 'definition') {
    const record = (await deps.definitions?.list(subject.kind as DefinitionKind))?.find((r) => r.id === subject.id);
    return { record };
  }
  if (subject.type === 'vocab') return { record: await deps.vocab?.read(subject.list) };
  return { record: await deps.builds?.read(subject.name) };
}

const etagOf = (value: unknown): string | null => (value === undefined ? null : contentETag(value));

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
  if (source === undefined) return fail(501, 'This studio keeps no change history.', 'The database backend records every save; the file backend reads the git log of its catalog.');
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
    };
    const page: HistoryPage = { capabilities, ...(await source.list(q)) };
    return ok(page);
  }

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
    const detail: HistoryEntryDetail = { capabilities, ...found };
    if (subject !== undefined && capabilities.restore) {
      const current = await currentParts(subject, deps);
      detail.current = Object.fromEntries(restorableParts(subject).map((part) => [part, etagOf(current[part])]));
    }
    return ok(detail);
  }

  return fail(404, `${pathPart} is not part of the history API.`, `Try one of: ${HISTORY_ROUTES.join('; ')}.`);
}

/** The value a known state holds, or the refusal that it was not recorded. */
function recorded(state: Known | 'current' | undefined, current: unknown): { ok: true; value: unknown } | { ok: false } {
  if (state === undefined || state === 'current') return { ok: true, value: current };
  return state.known ? { ok: true, value: state.value } : { ok: false };
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
  for (const part of parts) {
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
    const value = await deps.designs.read(subject.id);
    const answer: RestoreAnswer = { restored: { subject: key, entry, parts: restored }, ...(value === undefined ? {} : { value, etag: contentETag(value) }) };
    return ok(answer, value === undefined ? undefined : { ETag: contentETag(value) });
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

interface ListRestore {
  key: string;
  entry: string;
  request: ApiRequest;
  deps: WorkbenchDeps;
  route: Route;
}

/**
 * A controlled list or a board build file back to an earlier state, through
 * its own routes. A build file is one PUT. A vocabulary list only grows, so
 * its restore is the entry edits the vocab route allows: each entry's label,
 * aliases and note go back (the label now in use stays an alias); entries
 * added since stay, and say so in `kept`.
 */
async function restoreList(subject: Subject, target: unknown, now: unknown, ctx: ListRestore): Promise<ApiResponse> {
  const { key, entry, request, deps, route } = ctx;
  const as = request.user === undefined ? {} : { user: request.user };
  const restored: string[] = [];
  if (subject.type === 'build') {
    if (now === undefined) return fail(409, `${subjectLabel(subject)[0]?.toUpperCase() ?? ''}${subjectLabel(subject).slice(1)} does not exist now.`, 'Create the build file from its board page first.');
    if (JSON.stringify(now) !== JSON.stringify(target)) {
      const answer = await route({ method: 'PUT', path: `/api/builds/${encodeURIComponent(subject.name)}`, body: { file: target }, headers: { 'if-match': contentETag(now) }, ...as }, deps);
      if (answer.status >= 400) return answer;
      restored.push('record');
    }
    const value = await deps.builds?.read(subject.name);
    const answer: RestoreAnswer = { restored: { subject: key, entry, parts: restored }, ...(value === undefined ? {} : { value, etag: contentETag(value) }) };
    return ok(answer, value === undefined ? undefined : { ETag: contentETag(value) });
  }
  if (subject.type !== 'vocab') return fail(400, 'That cannot be restored.');
  type Entry = { id: string; label: string; aliases?: string[]; note?: string };
  const entriesOf = (list: unknown): Entry[] => ((list as { entries?: Entry[] } | undefined)?.entries ?? []);
  if (now === undefined) return fail(409, `${subjectLabel(subject)[0]?.toUpperCase() ?? ''}${subjectLabel(subject).slice(1)} does not exist now.`);
  const wanted = new Map(entriesOf(target).map((e) => [e.id, e] as const));
  let list: {} = now as {};
  for (const old of entriesOf(now)) {
    const was = wanted.get(old.id);
    if (was === undefined) continue; // added since: a list never loses an entry
    const patch: Record<string, unknown> = {};
    if (was.label !== old.label) patch['label'] = was.label;
    const aliases = (was.aliases ?? []).filter((a) => !(old.aliases ?? []).includes(a));
    if (aliases.length > 0) patch['aliases'] = aliases;
    if (was.note !== undefined && was.note !== old.note) patch['note'] = was.note;
    if (Object.keys(patch).length === 0) continue;
    const answer = await route({ method: 'PATCH', path: `/api/vocab/${encodeURIComponent(subject.list)}/${encodeURIComponent(old.id)}`, body: patch, headers: { 'if-match': contentETag(list) }, ...as }, deps);
    if (answer.status >= 400) return answer;
    list = (answer.body as { list: {} }).list;
    if (!restored.includes('record')) restored.push('record');
  }
  const kept = entriesOf(now).filter((e) => !wanted.has(e.id)).map((e) => e.id);
  const value = await deps.vocab?.read(subject.list);
  const answer: RestoreAnswer & { kept?: string[] } = { restored: { subject: key, entry, parts: restored }, ...(value === undefined ? {} : { value, etag: contentETag(value) }), ...(kept.length === 0 ? {} : { kept }) };
  return ok(answer, value === undefined ? undefined : { ETag: contentETag(value) });
}
