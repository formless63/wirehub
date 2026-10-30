/**
 * Bulk tagging (`docs/design-tags.md`): add or remove free tags on many designs in one request.
 *
 *   POST /api/design-tags   { designs: [id | { id, etag? }], add?: [tag], remove?: [tag] }
 *
 * Each design's working copy is written through the ordinary save route (`PUT /api/designs/:id`),
 * inside this request's one unit of work: the same validation, the same `design.saved` event per
 * design, and one change set (one history entry) for the whole request. A design that cannot be
 * changed — gone, someone else's live edit lock, a pack's read-only record, a stale `etag`, a
 * refused save — is skipped and reported; the others are still tagged. An invalid tag refuses the
 * whole request before anything is read.
 *
 * Edit locks: the transport's lock gate does not see the designs in the body, so this route checks
 * each one against the lease table itself, honouring the tokens the caller quotes in `x-edit-lock`.
 */

import { MAX_DESIGN_TAGS, cleanTags, isDesignTag, retagDesign, type Issue } from '@wirehub/model';

import { designRecord, tokensOf, LOCK_HEADER } from '../src/locks/records.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { contentETag } from './etag.ts';
import { holds } from './locks/lock-store.ts';
import { packOwnerOf } from './pack-guard.ts';

export const DESIGN_TAG_ROUTES = ['POST   /api/design-tags'] as const;

/** At most this many designs in one request. */
export const MAX_TAGGED_DESIGNS = 500;

export const isDesignTagsPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'design-tags' && parts.length === 2;

type Route = (request: ApiRequest, deps: WorkbenchDeps) => Promise<ApiResponse>;

/** Why a design was left as it was. */
export type TagSkipReason = 'not-found' | 'locked' | 'read-only' | 'stale' | 'invalid' | 'refused';

export interface DesignTagResult {
  id: string;
  outcome: 'changed' | 'unchanged' | 'skipped';
  /** the design's tags now (changed, unchanged) */
  tags?: string[];
  /** the saved working copy's ETag (changed, unchanged) */
  etag?: string;
  reason?: TagSkipReason;
  error?: string;
}

const fail = (status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse => ({
  status,
  body: { error, ...(hint === undefined ? {} : { hint }), ...(issues === undefined ? {} : { issues }) },
});

interface TagRequest {
  designs: { id: string; etag?: string }[];
  add: string[];
  remove: string[];
}

function readTagRequest(body: unknown): { ok: true; value: TagRequest } | { ok: false; response: ApiResponse } {
  const usage = 'Send { designs: [id | { id, etag }], add?: [tag], remove?: [tag] }.';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, response: fail(400, usage, 'Nothing was written.') };
  const b = body as { designs?: unknown; add?: unknown; remove?: unknown };
  if (!Array.isArray(b.designs) || b.designs.length === 0 || b.designs.length > MAX_TAGGED_DESIGNS) {
    return { ok: false, response: fail(400, `designs is a list of 1 to ${MAX_TAGGED_DESIGNS} designs.`, 'Nothing was written.') };
  }
  const designs: { id: string; etag?: string }[] = [];
  const seen = new Set<string>();
  for (const entry of b.designs as unknown[]) {
    const id = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
    const etag = typeof entry === 'object' && entry !== null ? (entry as { etag?: unknown }).etag : undefined;
    if (typeof id !== 'string' || id === '' || (etag !== undefined && typeof etag !== 'string')) return { ok: false, response: fail(400, usage, 'Nothing was written.') };
    if (seen.has(id)) continue;
    seen.add(id);
    designs.push({ id, ...(etag === undefined ? {} : { etag: etag as string }) });
  }
  const list = (value: unknown): string[] | undefined => (value === undefined ? [] : Array.isArray(value) && value.length <= MAX_DESIGN_TAGS && value.every((t) => typeof t === 'string') ? cleanTags(value as string[]) : undefined);
  const add = list(b.add);
  const remove = list(b.remove);
  if (add === undefined || remove === undefined) return { ok: false, response: fail(400, `add and remove are lists of at most ${MAX_DESIGN_TAGS} tags.`, 'Nothing was written.') };
  if (add.length === 0 && remove.length === 0) return { ok: false, response: fail(400, 'Name at least one tag to add or remove.', 'Nothing was written.') };
  const bad = [...add, ...remove].filter((t) => !isDesignTag(t));
  if (bad.length > 0) {
    const issues: Issue[] = bad.map((t) => ({ code: 'invalid-tags', severity: 'error', message: `${JSON.stringify(t).slice(0, 60)} is not a tag: a short word of letters, digits, spaces, dash, underscore, dot or slash, up to 40 characters`, where: 'tags' }));
    return { ok: false, response: fail(422, `${bad.length === 1 ? 'A tag is' : `${bad.length} tags are`} not valid: ${bad.map((t) => JSON.stringify(t).slice(0, 60)).join(', ')}.`, 'Nothing was written. A tag is a short word: letters, digits, spaces, dash, underscore, dot or slash, up to 40 characters.', issues) };
  }
  const both = add.filter((t) => remove.includes(t));
  if (both.length > 0) return { ok: false, response: fail(400, `${both.map((t) => `'${t}'`).join(', ')} cannot be added and removed at once.`, 'Nothing was written.') };
  return { ok: true, value: { designs, add, remove } };
}

/** The reason a refused save is reported under. */
function reasonOf(status: number): TagSkipReason {
  if (status === 404) return 'not-found';
  if (status === 409 || status === 412 || status === 428) return 'stale';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 423) return 'locked';
  return 'refused';
}

export async function handleDesignTagsRequest(request: ApiRequest, deps: WorkbenchDeps, route: Route): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  if (method !== 'POST') return { status: 405, headers: { Allow: 'POST' }, body: { error: `${method} is not allowed here.`, hint: 'It answers POST.' } };
  const parsed = readTagRequest(request.body);
  if (!parsed.ok) return parsed.response;
  const { designs, add, remove } = parsed.value;
  const tokens = tokensOf(request.headers?.[LOCK_HEADER]);
  const now = (deps.lockClock ?? Date.now)();
  const results: DesignTagResult[] = [];
  const events: NonNullable<ApiResponse['events']> = [];
  const skip = (id: string, reason: TagSkipReason, error: string): void => void results.push({ id, outcome: 'skipped', reason, error });

  for (const entry of designs) {
    const design = await deps.designs.read(entry.id);
    if (design === undefined) {
      skip(entry.id, 'not-found', 'No such design.');
      continue;
    }
    const lock = await deps.locks?.get(designRecord(entry.id), now);
    if (lock !== undefined && !holds(lock, tokens)) {
      skip(entry.id, 'locked', `${lock.holder.name} is editing it.`);
      continue;
    }
    const origin = await packOwnerOf(deps, `designs/${entry.id}.json`, entry.id);
    if (origin !== undefined) {
      skip(entry.id, 'read-only', `It comes from the ${origin.pack} pack and is read-only here.`);
      continue;
    }
    const etag = contentETag(design);
    if (entry.etag !== undefined && entry.etag !== etag) {
      skip(entry.id, 'stale', 'It changed since that version was read.');
      continue;
    }
    const next = retagDesign(design, add, remove);
    if (next === design) {
      results.push({ id: entry.id, outcome: 'unchanged', tags: design.tags ?? [], etag });
      continue;
    }
    if ((next.tags ?? []).length > MAX_DESIGN_TAGS) {
      skip(entry.id, 'invalid', `A design holds at most ${MAX_DESIGN_TAGS} tags.`);
      continue;
    }
    const answer = await route({ method: 'PUT', path: `/api/designs/${encodeURIComponent(entry.id)}`, body: next, headers: { 'if-match': etag }, ...(request.user === undefined ? {} : { user: request.user }) }, deps);
    if (answer.status >= 400) {
      const error = (answer.body as { error?: unknown } | null)?.error;
      skip(entry.id, reasonOf(answer.status), typeof error === 'string' ? error : `Refused (${answer.status}).`);
      continue;
    }
    const saved = answer.body as { tags?: string[] } | null;
    const newTag = answer.headers?.ETag;
    results.push({ id: entry.id, outcome: 'changed', tags: saved?.tags ?? next.tags ?? [], ...(newTag === undefined ? {} : { etag: newTag }) });
    events.push(...(answer.events ?? []));
  }

  const count = (outcome: DesignTagResult['outcome']): number => results.filter((r) => r.outcome === outcome).length;
  return {
    status: 200,
    body: { add, remove, changed: count('changed'), unchanged: count('unchanged'), skipped: count('skipped'), results },
    ...(events.length === 0 ? {} : { events }),
  };
}
