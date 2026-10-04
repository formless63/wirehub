/**
 * The stale-write guard: a content-hash version for a design or a definition
 * record, carried as an `ETag` on every GET and checked as `If-Match` on every
 * write that can clobber someone else's save.
 *
 * absorbs (design PUT) and
 * (definition PUT): two owners, or two tabs, on the same
 * record must not silently overwrite each other. The version is a sha256 of
 * the record's own canonical JSON — cheap, and it changes exactly when the
 * bytes a person is looking at would change.
 *
 * The guard is **required** (review fix, 2026-09-26): a write that edits an
 * existing record without `If-Match` is refused with 428, because a caller
 * that never loaded a version (a stale bundled copy, a script) cannot know
 * what it is overwriting. `If-Match: *` is the explicit "overwrite whatever is
 * there" for a script that means it.
 */

import { createHash } from 'node:crypto';

import type { Issue } from '@wirehub/model';

import type { ApiError, ApiResponse } from './api.ts';

/** A short, quoted content-hash ETag for a JSON-serialisable value. */
export function contentETag(value: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 32);
  return `"${hash}"`;
}

function normalize(tag: string): string {
  return tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

/**
 * Whether an incoming `If-Match` header is satisfied by the current tag.
 * `undefined` — no header sent — never passes. `*` matches whatever is there,
 * per RFC 9110.
 */
export function ifMatchSatisfied(header: string | undefined, current: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((part) => part.trim() === '*' || normalize(part) === normalize(current));
}

/** The missing-version refusal: 428, nothing written. */
export function preconditionRequiredResponse(what: string, id: string): ApiResponse {
  const issue: Issue = {
    code: 'if-match-required',
    severity: 'error',
    message: `A save of this ${what} has to say which version it was made from (If-Match).`,
    where: id,
  };
  const body: ApiError = {
    error: `Saving '${id}' needs the version you loaded, and none was sent.`,
    hint: 'Nothing was written. Reload the page to load the current version, then save again.',
    issues: [issue],
  };
  return { status: 428, body };
}

/**
 * The guard in one call: `undefined` when the write may go ahead, else the
 * 428 (no `If-Match`) or 409 (stale) refusal.
 */
export function checkIfMatch(header: string | undefined, current: string, what: string, id: string): ApiResponse | undefined {
  if (header === undefined || header.trim() === '') return preconditionRequiredResponse(what, id);
  return ifMatchSatisfied(header, current) ? undefined : staleWriteResponse(what, id);
}

/** The stale-write refusal: 409, nothing written, and a marker (`issues[0].code`) the browser adapters key off of. */
export function staleWriteResponse(what: string, id: string): ApiResponse {
  const issue: Issue = {
    code: 'stale-write',
    severity: 'error',
    message: `This ${what} changed on disk since this copy was loaded — saving now would overwrite that change.`,
    where: id,
  };
  const body: ApiError = {
    error: `'${id}' changed on disk since you opened it.`,
    hint: 'Nothing was written — the stored version is untouched. Reload to see the new version, then reapply your changes.',
    issues: [issue],
  };
  return { status: 409, body };
}
