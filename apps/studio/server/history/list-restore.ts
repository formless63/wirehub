/**
 * Restoring a controlled list or a board build file through its own routes: a record's History
 * restore (`api.ts`) and an agent checkpoint's undo (`checkpoints.ts`) both use it.
 */

import { subjectLabel, type RestoreAnswer, type Subject } from '../../src/history/types.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { contentETag } from '../etag.ts';
import { fail, ok, type Route } from './shared.ts';

export interface ListRestore {
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
export async function restoreList(subject: Subject, target: unknown, now: unknown, ctx: ListRestore): Promise<ApiResponse> {
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
