/**
 * Agent checkpoints: every change set one personal API token
 * made — an agent's grant, over MCP or plain HTTP — grouped, so a person
 * reviews the agent's work as one piece and undoes it together.
 *
 *   GET  /api/history/checkpoints                   the tokens that made changes, newest first
 *   GET  /api/history/checkpoints/:token?from=      one checkpoint: its change sets, the records it
 *                                                   changed, what undoing each would do, its versions now
 *   POST /api/history/checkpoints/:token/restore    { from?, current: { <subject>: { <part>: etag } } }
 *
 * The undo is one new change set, attributed to the person who asked — history
 * is never rewritten. Each record goes back to its state right before the
 * checkpoint began (one it created is deleted) through the ordinary design
 * and definition routes, so it is validated, permission-checked and refused
 * under someone else's edit lock like any edit; it all commits, or nothing
 * does. Nothing moves if any record cannot be undone cleanly: someone else
 * changed it after the agent began (their work would be lost too), its earlier
 * state was not recorded, or a version quoted in `current` is no longer the
 * one stored (409). A draft-work grant cannot undo anything (it is not a draft
 * write), so an agent never reverses a person's review.
 */

import { contentETag, staleWriteResponse } from '../etag.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import type { DefinitionKind } from '../definition-store.ts';
import {
  subjectKey,
  subjectLabel,
  type CheckpointDetail,
  type CheckpointRestoreAnswer,
  type CheckpointSubject,
  type HistoryCapabilities,
  type Subject,
} from '../../src/history/types.ts';
import { historyTouchLabel } from '../../src/history/labels.ts';
import { currentParts, etagOf, fail, methodNotAllowed, ok, quotedParts, recorded, restorePhotoTo, type Route } from './shared.ts';
import { restoreList } from './list-restore.ts';
import type { CheckpointDoc, CheckpointRecord, HistorySource } from './source.ts';

interface Ctx {
  method: string;
  token: string | undefined;
  action: string | undefined;
  query: URLSearchParams;
  request: ApiRequest;
  deps: WorkbenchDeps;
  source: HistorySource;
  capabilities: HistoryCapabilities;
  route: Route;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cap = (text: string): string => `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;

/** What undoing one record would do, from its state before the checkpoint and now. */
interface Plan {
  record: CheckpointRecord;
  view: CheckpointSubject;
  /** the main part's target: undefined = the record did not exist before */
  target?: unknown;
  drawing?: unknown;
  /** what the undo leaves, one sentence (a list entry or build file the agent added) */
  note?: string;
}

/** A document the undo puts back besides records (Explore's kept explorations), merged per entry. */
interface DocPlan {
  view: CheckpointSubject;
  path: string;
  /** the document after the undo; undefined: remove it */
  value: unknown;
}

type ListEntry = { id: string; label?: string; aliases?: string[]; note?: string };
const entriesOf = (list: unknown): ListEntry[] => ((list as { entries?: ListEntry[] } | undefined)?.entries ?? []);
/** whether a list's restore (`list-restore.ts`: labels, aliases, notes of the entries both have) would change anything */
function listMoves(was: unknown, now: unknown): boolean {
  const wanted = new Map(entriesOf(was).map((e) => [e.id, e] as const));
  return entriesOf(now).some((e) => {
    const w = wanted.get(e.id);
    return w !== undefined && (w.label !== e.label || (w.aliases ?? []).some((a) => !(e.aliases ?? []).includes(a)) || (w.note !== undefined && w.note !== e.note));
  });
}

const mainPart = (subject: Subject): string => (subject.type === 'design' ? 'design' : 'record');

async function plan(record: CheckpointRecord, deps: WorkbenchDeps): Promise<Plan> {
  const { subject } = record;
  const key = subjectKey(subject);
  const label = subjectLabel(subject);
  const now = await currentParts(subject, deps);
  const current = Object.fromEntries(quotedParts(subject).map((part) => [part, etagOf(now[part])]));
  const base = { subject: key, label, parts: record.parts, current };
  const blocked = (why: string): Plan => ({ record, view: { ...base, action: 'none', blocked: why } });
  if (subject.type === 'note' || subject.type === 'project') return blocked(`${cap(label)} is restored from its own History.`);
  const main = mainPart(subject);
  if (subject.type === 'vocab' || subject.type === 'build') {
    const was = recorded(record.before[main], now[main]);
    if (!was.ok) return blocked(`Its state before the agent began was not recorded.`);
    // a list never loses an entry and a build file has no delete: one the agent made stays
    if (was.value === undefined) return { record, view: { ...base, action: 'none' }, ...(now[main] === undefined ? {} : { note: `${cap(label)} is kept: the agent made it.` }) };
    if (subject.type === 'vocab' ? !listMoves(was.value, now[main]) : JSON.stringify(was.value) === JSON.stringify(now[main])) return { record, view: { ...base, action: 'none' } };
    if (record.others.length > 0) return blocked(`Someone else changed it after the agent began (change ${record.others.slice(0, 3).join(', ')}${record.others.length > 3 ? '…' : ''}): undo it from its own History instead.`);
    return { record, view: { ...base, action: 'restore' }, target: was.value };
  }
  let target: unknown = now[main];
  if (record.parts.includes(main)) {
    const was = recorded(record.before[main], now[main]);
    if (!was.ok) return blocked(`Its state before the agent began was not recorded.`);
    target = was.value;
  }
  let drawing: unknown;
  if (subject.type === 'design' && record.parts.includes('drawing') && target !== undefined) {
    const was = recorded(record.before['drawing'], now['drawing']);
    if (was.ok && was.value !== undefined && JSON.stringify(was.value) !== JSON.stringify(now['drawing'])) drawing = was.value;
  }
  // a renamed design keeps its current id
  if (subject.type === 'design' && typeof target === 'object' && target !== null) target = { ...(target as object), id: subject.id };
  const mainMoves = JSON.stringify(target) !== JSON.stringify(now[main]);
  const photo = record.parts.includes('photo') ? record.photo : undefined;
  const photoMoves = photo !== undefined && (photo === 'none' ? now['photo'] !== undefined : 'sha256' in photo ? now['photo'] !== `sha256:${photo.sha256}` : false);
  const action: CheckpointSubject['action'] = target === undefined ? (now[main] === undefined ? 'none' : 'remove') : mainMoves || drawing !== undefined || photoMoves ? 'restore' : 'none';
  // already back (an earlier undo, or a person put it back): nothing to do, nothing to block
  if (action === 'none') return { record, view: { ...base, action } };
  if (record.others.length > 0) {
    return blocked(`Someone else changed it after the agent began (change ${record.others.slice(0, 3).join(', ')}${record.others.length > 3 ? '…' : ''}): undo it from its own History instead.`);
  }
  return { record, view: { ...base, action }, ...(target === undefined ? {} : { target }), ...(drawing === undefined ? {} : { drawing }) };
}

type Saved = { key: string; [field: string]: unknown };
const savedList = (value: unknown): Saved[] => (Array.isArray(value) ? (value as Saved[]).filter((s) => typeof s?.key === 'string') : []);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Explore's kept explorations (`data/explore/saved.json`), back per exploration: each one the agent
 * changed returns to how it was (one it added is forgotten), unless someone changed it since, which
 * is left and said. Explorations nobody but the agent touched are the only ones that move.
 */
async function planDoc(doc: CheckpointDoc, deps: WorkbenchDeps, skipped: string[]): Promise<DocPlan | undefined> {
  if (!doc.recorded) {
    skipped.push('The kept explorations are left as they are: their state before the agent began was not recorded.');
    return undefined;
  }
  const now = await deps.docs?.read(doc.path);
  const before = new Map(savedList(doc.before).map((s) => [s.key, s] as const));
  const after = new Map(savedList(doc.after).map((s) => [s.key, s] as const));
  const next = new Map(savedList(now).map((s) => [s.key, s] as const));
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const left = after.get(key);
    if (same(was, left) || same(next.get(key), was)) continue;
    if (!same(next.get(key), left)) {
      const label = (left ?? was)?.['label'];
      skipped.push(`${typeof label === 'string' && label !== '' ? `Exploration ${label}` : 'An exploration'} is left as it is: it changed after the agent.`);
      continue;
    }
    if (was === undefined) next.delete(key);
    else next.set(key, was);
  }
  const list = [...next.values()].sort((a, b) => a.key.localeCompare(b.key));
  const value = list.length === 0 && now === undefined ? undefined : list;
  if (same(value, now)) return undefined;
  return {
    path: doc.path,
    value,
    view: { subject: `other:doc:${doc.path}`, label: 'kept explorations', parts: ['record'], current: { record: etagOf(now) }, action: 'restore' },
  };
}

async function detailOf(ctx: Ctx, token: string, from: string | undefined): Promise<{ detail: CheckpointDetail; plans: Plan[]; docs: DocPlan[] } | undefined> {
  const found = await ctx.source.checkpoints?.of(token, from);
  if (found === undefined) return undefined;
  const plans: Plan[] = [];
  for (const record of found.records) plans.push(await plan(record, ctx.deps));
  const skipped = found.others.map((t) => `${historyTouchLabel(t)} is left as it is: change it back from its own page.`);
  for (const p of plans) if (p.note !== undefined) skipped.push(p.note);
  const docs: DocPlan[] = [];
  for (const doc of found.docs ?? []) {
    const planned = await planDoc(doc, ctx.deps, skipped);
    if (planned !== undefined) docs.push(planned);
  }
  const subjects = [...plans.map((p) => p.view), ...docs.map((d) => d.view)];
  return {
    plans,
    docs,
    detail: {
      capabilities: ctx.capabilities,
      checkpoint: found.summary,
      from: found.from,
      entries: found.entries,
      subjects,
      skipped,
      restorable: ctx.capabilities.restore && subjects.every((s) => s.blocked === undefined) && subjects.some((s) => s.action !== 'none'),
    },
  };
}

/** Designs first (one may use a part the agent made), then library records, removals of those last. */
function order(a: Plan, b: Plan): number {
  const rank = (p: Plan): number => (p.record.subject.type === 'design' ? 0 : p.view.action === 'remove' ? 2 : 1);
  return rank(a) - rank(b);
}

export async function handleCheckpointRequest(ctx: Ctx): Promise<ApiResponse> {
  const { method, token, action, query } = ctx;
  if (ctx.source.checkpoints === undefined || ctx.capabilities.checkpoints !== true) {
    return fail(501, 'This hub does not group changes by API token.', 'The database backend records the token each change was made with; the file backend does not.');
  }
  if (token === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    const n = Number(query.get('limit') ?? 50);
    const checkpoints = await ctx.source.checkpoints.list(Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50);
    return ok({ capabilities: ctx.capabilities, checkpoints });
  }
  if (!UUID.test(token)) return fail(400, `${JSON.stringify(token)} is not an API token id.`, 'Pick an agent checkpoint from the History page.');
  const missing = (): ApiResponse => fail(404, 'That token made no changes in this hub.', 'Pick an agent checkpoint from the History page.');

  if (action === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    const found = await detailOf(ctx, token, query.get('from') ?? undefined);
    return found === undefined ? missing() : ok(found.detail);
  }
  if (action !== 'restore') return fail(404, `${action} is not part of the history API.`);
  if (method !== 'POST') return methodNotAllowed(method, ['POST']);
  if (!ctx.capabilities.restore) return fail(501, 'This hub keeps no history to restore from.');

  const body = (typeof ctx.request.body === 'object' && ctx.request.body !== null ? ctx.request.body : {}) as { from?: unknown; current?: unknown };
  const quoted = (typeof body.current === 'object' && body.current !== null ? body.current : undefined) as Record<string, Record<string, unknown> | undefined> | undefined;
  if (quoted === undefined) {
    return fail(428, 'Undoing an agent checkpoint needs the versions you were looking at, and none were sent.', 'Nothing was written. Open the checkpoint again (its versions come with it) and undo from there.');
  }
  const found = await detailOf(ctx, token, typeof body.from === 'string' ? body.from : undefined);
  if (found === undefined) return missing();
  const blocked = found.detail.subjects.filter((s) => s.blocked !== undefined);
  if (blocked.length > 0) {
    return { status: 409, body: { error: `${blocked.length === 1 ? 'One record' : `${blocked.length} records`} cannot be undone with the rest, so nothing was undone.`, hint: blocked.map((s) => `${s.label}: ${s.blocked}`).join(' '), blocked } };
  }
  const todo = found.plans.filter((p) => p.view.action !== 'none').sort(order);
  if (todo.length === 0 && found.docs.length === 0) return fail(409, 'Everything this checkpoint changed is already back as it was.', 'Nothing was written.');
  // nothing moved since the person looked: every quoted version is still the stored one
  for (const p of todo) {
    const saw = quoted[p.view.subject];
    if (saw === undefined) return fail(428, `The version of ${p.view.label} was not sent.`, 'Nothing was written. Open the checkpoint again and undo from there.');
    for (const [part, now] of Object.entries(p.view.current)) {
      if (part in saw && saw[part] !== now) return staleWriteResponse(p.record.subject.type === 'design' ? 'design' : 'record', p.view.subject);
    }
  }
  for (const d of found.docs) {
    const saw = quoted[d.view.subject];
    if (saw !== undefined && 'record' in saw && saw['record'] !== d.view.current['record']) return staleWriteResponse('record', d.view.subject);
  }

  const as = ctx.request.user === undefined ? {} : { user: ctx.request.user };
  const done: CheckpointRestoreAnswer['restored']['subjects'] = [];
  const skipped = [...found.detail.skipped];
  for (const p of todo) {
    const { subject } = p.record;
    const parts: string[] = [];
    if (subject.type === 'design') {
      const now = await ctx.deps.designs.read(subject.id);
      const path = `/api/designs/${encodeURIComponent(subject.id)}`;
      if (p.view.action === 'remove') {
        const answer = await ctx.route({ method: 'DELETE', path, body: { confirm: subject.id }, headers: { 'if-match': contentETag(now) }, ...as }, ctx.deps);
        if (answer.status >= 400) return refusedAt(answer, p);
        done.push({ subject: p.view.subject, action: 'remove', parts: ['design'] });
        continue;
      }
      if (JSON.stringify(now) !== JSON.stringify(p.target)) {
        const answer = now === undefined
          ? await ctx.route({ method: 'POST', path: '/api/designs', body: p.target, ...as }, ctx.deps)
          : await ctx.route({ method: 'PUT', path, body: p.target, headers: { 'if-match': contentETag(now) }, ...as }, ctx.deps);
        if (answer.status >= 400) return refusedAt(answer, p);
        parts.push('design');
      }
      if (p.drawing !== undefined && ctx.deps.drawings !== undefined) {
        await ctx.deps.drawings.writeMeta(subject.id, p.drawing as Parameters<NonNullable<WorkbenchDeps['drawings']>['writeMeta']>[1]);
        parts.push('drawing');
      }
      if (p.record.parts.includes('photo')) {
        const photo = await restorePhotoTo(subject.id, p.record.photo, ctx.deps);
        if (photo.restored) parts.push('photo');
        if (photo.skipped !== undefined) skipped.push(photo.skipped);
      }
      done.push({ subject: p.view.subject, action: 'restore', parts });
      continue;
    }
    if (subject.type === 'vocab' || subject.type === 'build') {
      const answer = await restoreList(subject, p.target, (await currentParts(subject, ctx.deps))['record'], { key: p.view.subject, entry: token, request: ctx.request, deps: ctx.deps, route: ctx.route });
      if (answer.status >= 400) return refusedAt(answer, p);
      const body = answer.body as { restored?: { parts?: string[] }; kept?: string[] };
      if ((body.kept?.length ?? 0) > 0) skipped.push(`${cap(p.view.label)} keeps ${body.kept!.length} entr${body.kept!.length === 1 ? 'y' : 'ies'} added since (a list keeps its entries).`);
      done.push({ subject: p.view.subject, action: 'restore', parts: body.restored?.parts ?? [] });
      continue;
    }
    if (subject.type !== 'definition') continue;
    const now = (await ctx.deps.definitions?.list(subject.kind as DefinitionKind))?.find((r) => r.id === subject.id);
    const path = `/api/definitions/${subject.kind}/${encodeURIComponent(subject.id)}`;
    const answer =
      p.view.action === 'remove'
        ? await ctx.route({ method: 'DELETE', path, body: { confirm: subject.id }, headers: { 'if-match': contentETag(now) }, ...as }, ctx.deps)
        : now === undefined
          ? await ctx.route({ method: 'POST', path: `/api/definitions/${subject.kind}`, body: p.target, ...as }, ctx.deps)
          : await ctx.route({ method: 'PUT', path, body: p.target, headers: { 'if-match': contentETag(now) }, ...as }, ctx.deps);
    if (answer.status >= 400) return refusedAt(answer, p);
    done.push({ subject: p.view.subject, action: p.view.action === 'remove' ? 'remove' : 'restore', parts: ['record'] });
  }
  // Explore's kept explorations last: a pick's record is already gone or back by now
  for (const d of found.docs) {
    if (ctx.deps.docs === undefined) break;
    if (d.value === undefined) await ctx.deps.docs.remove(d.path);
    else await ctx.deps.docs.write(d.path, d.value);
    done.push({ subject: d.view.subject, action: 'restore', parts: ['record'] });
  }
  const answer: CheckpointRestoreAnswer = { restored: { token, from: found.detail.from, subjects: done }, ...(skipped.length === 0 ? {} : { skipped }) };
  return ok(answer);
}

/** A route's refusal for one record: nothing is committed (the unit of work is dropped), and the answer says which record. */
function refusedAt(answer: ApiResponse, p: Plan): ApiResponse {
  const body = (typeof answer.body === 'object' && answer.body !== null ? answer.body : {}) as Record<string, unknown>;
  return { ...answer, body: { ...body, error: `${cap(p.view.label)} could not be ${p.view.action === 'remove' ? 'removed' : 'restored'}, so nothing was undone: ${String(body['error'] ?? `HTTP ${answer.status}`)}`, subject: p.view.subject } };
}
