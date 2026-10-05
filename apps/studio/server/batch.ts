/**
 * API clients' write tools (`specs/postgres-backend.md` §4.5; task B13):
 *
 * - **Dry runs** — `?dryRun=1` on a write route: the request runs exactly as a
 *   real one up to the commit, then the unit of work is discarded. The answer
 *   is the would-be change set: per record its kind, key, op, before and after
 *   versions, an RFC 6902 patch and a short line diff of the bodies, plus the
 *   derived records the commit would recompute. Nothing is written.
 * - **Batches** — `POST /api/batch`: several JSON write requests through the
 *   same router in **one** unit of work, so they commit as one change set, or
 *   — if any answers 4xx — not at all; a later request reads the earlier ones'
 *   staged writes. `"dryRun": true` previews the whole batch.
 */

import { contentETag } from './etag.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { derivedFor, currentValue, UnitOfWork } from './storage/unit-of-work.ts';
import type { RecordChange } from './storage/change-set.ts';

export const MAX_BATCH = 200;

export function isDryRun(path: string): boolean {
  const query = path.split('?')[1];
  return query !== undefined && new URLSearchParams(query).get('dryRun') === '1';
}

/* ------------------------------ diffs ------------------------------ */

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const escape = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: Json;
}

/** An RFC 6902 patch from `a` to `b` (objects key by key, equal-length arrays item by item, anything else replaced). */
export function jsonPatch(a: Json, b: Json, at = ''): PatchOp[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a === undefined) return [{ op: 'add', path: at, value: b }];
  if (b === undefined) return [{ op: 'remove', path: at }];
  if (isObject(a) && isObject(b)) {
    const out: PatchOp[] = [];
    for (const key of Object.keys(a)) if (!(key in b)) out.push({ op: 'remove', path: `${at}/${escape(key)}` });
    for (const [key, value] of Object.entries(b)) out.push(...(key in a ? jsonPatch(a[key], value, `${at}/${escape(key)}`) : [{ op: 'add' as const, path: `${at}/${escape(key)}`, value }]));
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((item, i) => jsonPatch(item, b[i], `${at}/${i}`));
  return [{ op: 'replace', path: at, value: b }];
}

/** A short line diff of two documents' canonical JSON: the changed lines only, `-` / `+`, at most `limit`. */
export function lineDiff(a: Json, b: Json, limit = 60): string[] {
  const left = a === undefined ? [] : JSON.stringify(a, null, 2).split('\n');
  const right = b === undefined ? [] : JSON.stringify(b, null, 2).split('\n');
  if (left.length * right.length > 4_000_000) return ['(too large for a line diff; see the patch)'];
  // longest common subsequence, then walk it
  const n = left.length;
  const m = right.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = left[i] === right[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while ((i < n || j < m) && out.length < limit) {
    if (i < n && j < m && left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+${right[j++]}`);
    else out.push(`-${left[i++]}`);
  }
  return out;
}

/* ---------------------------- dry runs ---------------------------- */

export interface DryChange {
  kind: string;
  key: string;
  op: RecordChange['op'];
  to?: string;
  before: string | null;
  after: string | null;
  patch?: PatchOp[];
  diff?: string[];
  bytes?: { sha256: string; size: number };
}

async function describe(base: WorkbenchDeps, change: RecordChange): Promise<DryChange> {
  const out: DryChange = { kind: change.kind, key: change.key, op: change.op, before: change.expect ?? null, after: null, ...(change.to === undefined ? {} : { to: change.to }) };
  if (change.bytes !== undefined) {
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(change.bytes).digest('hex');
    return { ...out, after: `"sha256:${sha256}"`, bytes: { sha256, size: change.bytes.byteLength } };
  }
  if (change.op !== 'put') return out;
  const before = await currentValue(base, change);
  return { ...out, before: out.before ?? (before === undefined ? null : contentETag(before)), after: contentETag(change.value ?? null), patch: jsonPatch(before, change.value), diff: lineDiff(before, change.value) };
}

/** What a dry run answers for a unit of work that staged its writes and was then not committed. */
export async function dryRunAnswer(uow: UnitOfWork, response: ApiResponse, extra: Record<string, unknown> = {}): Promise<ApiResponse> {
  if (response.status >= 400) return response;
  const changes = await Promise.all(uow.changes.map((c) => describe(uow.base, c)));
  const derived = [...new Set([...derivedFor(uow.changes), ...uow.derive])].filter((k) => k !== 'module' || (uow.base.derived !== undefined && (uow.base.modules === undefined || uow.base.modules.derived().length > 0)));
  return { status: 200, body: { dryRun: true, status: response.status, body: response.body, ...extra, changes, derived } };
}

/* ----------------------------- batches ---------------------------- */

export interface BatchRequestItem {
  method: string;
  path: string;
  ifMatch?: string;
  body?: unknown;
}

/** Which requests may ride in a batch: JSON writes of the catalog and the docs route — no uploads, jobs, locks, auth or modules. */
export function batchRefusal(item: BatchRequestItem): string | undefined {
  const method = item.method?.toUpperCase?.();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method ?? '')) return 'only writes (POST, PUT, PATCH, DELETE) ride in a batch';
  const path = (item.path ?? '').split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return 'a batch request path starts with /api/';
  for (const prefix of ['/api/batch', '/api/models', '/api/depictions', '/api/locks', '/api/setup', '/api/modules', '/api/auth', '/api/account', '/api/invitations', '/api/blobs', '/api/export']) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return `${prefix} does not ride in a batch (uploads go first, as their own requests)`;
  }
  return undefined;
}

/** Parse a batch body, or the refusal. */
export function readBatch(body: unknown): { ok: true; message?: string; dryRun: boolean; requests: BatchRequestItem[] } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'A batch is { message?, dryRun?, requests: [...] }.' };
  const b = body as { message?: unknown; dryRun?: unknown; requests?: unknown };
  if (!Array.isArray(b.requests) || b.requests.length === 0) return { ok: false, error: 'A batch needs at least one request.' };
  if (b.requests.length > MAX_BATCH) return { ok: false, error: `A batch holds at most ${MAX_BATCH} requests.` };
  const requests = b.requests as BatchRequestItem[];
  for (const [i, item] of requests.entries()) {
    if (typeof item !== 'object' || item === null || typeof item.path !== 'string' || typeof item.method !== 'string') return { ok: false, error: `Request ${i} needs a method and a path.` };
    const refused = batchRefusal(item);
    if (refused !== undefined) return { ok: false, error: `Request ${i}: ${refused}.` };
  }
  return { ok: true, ...(typeof b.message === 'string' && b.message.trim() !== '' ? { message: b.message.trim().slice(0, 500) } : {}), dryRun: b.dryRun === true, requests };
}

/** The sub-request a batch item becomes. */
export function batchItemRequest(item: BatchRequestItem, parent: Pick<ApiRequest, 'user'>): ApiRequest {
  return {
    method: item.method.toUpperCase(),
    path: item.path,
    ...(item.body === undefined ? {} : { body: item.body }),
    ...(item.ifMatch === undefined ? {} : { headers: { 'if-match': item.ifMatch } }),
    ...(parent.user === undefined ? {} : { user: parent.user }),
  };
}
