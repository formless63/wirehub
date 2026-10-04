/**
 * Edit locks — the endpoints and the write gate.
 *
 * Both live at the request layer, ahead of `handleWorkbenchRequest`, so no
 * store or handler knows locks exist: the transports (`hono-adapter.ts`,
 * `plugin.ts`, `depictions.ts`'s middleware) call `editLockLayer` first and
 * only fall through to the API when it answers `undefined`.
 *
 *   GET  /api/locks            every live lease (list markers, banners)
 *   POST /api/locks/acquire    { record, holder }            → { token, lock } | 423
 *   POST /api/locks/heartbeat  { record, token, holder }     → { token, lock } | 409 lost
 *   POST /api/locks/release    { record, token }             → { released }
 *   POST /api/locks/request    { record, holder }            → { lock }  ("Request edit")
 *   POST /api/locks/decline    { record, token }             → { lock }  (the holder's Keep)
 *   POST /api/locks/takeover   { record, holder, force? }    → { token, lock } | 409 live
 *
 * The gate: a write that changes a leased record (`recordsOfWrite`) must quote
 * that lease's token in `x-edit-lock`, or it is refused 423 with who holds it.
 * A record nobody holds is written as before — scripts and the If-Match guard
 * (the backstop, still required) are unchanged. Reads are never gated.
 *
 * Who a holder is: the signed-in user when the login is on (the name a client
 * sends is ignored then); with it off, the name this browser chose. `tabId`
 * is per page load, so two tabs of one person are two holders.
 */

import type { Issue } from '@wirehub/model';

import { isRecordKey, recordsOfWrite, tokensOf, LEASE_MS, type LockView } from '../../src/locks/records.ts';
import type { ApiResponse } from '../api.ts';
import type { EventHub } from '../events.ts';
import type { StudioUser } from '../me.ts';
import { holds, lockView, type EditLock, type LockHolder, type LockStore } from './lock-store.ts';

export const LOCK_ROUTES = [
  'GET    /api/locks',
  'POST   /api/locks/acquire',
  'POST   /api/locks/heartbeat',
  'POST   /api/locks/release',
  'POST   /api/locks/request',
  'POST   /api/locks/decline',
  'POST   /api/locks/takeover',
] as const;

export const DEFAULT_HOLDER_NAME = 'This browser';

export interface EditLockDeps {
  locks?: LockStore;
  /** epoch ms (injected by tests) */
  clock?: () => number;
  /** told of every lease change (`GET /api/events`) */
  events?: EventHub;
}

export interface EditLockRequest {
  method: string;
  path: string;
  body?: unknown;
  /** the raw `x-edit-lock` header */
  lockHeader?: string | undefined;
  user?: StudioUser | undefined;
}

function fail(status: number, error: string, hint?: string, extra?: Record<string, unknown>): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** The record's own id, for a sentence: `design:x` → `x`. */
function recordName(record: string): string {
  return record.split(':').slice(-1)[0] ?? record;
}

function readHolder(value: unknown, user: StudioUser | undefined): LockHolder | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as { tabId?: unknown; clientId?: unknown; name?: unknown };
  if (typeof raw.tabId !== 'string' || !ID.test(raw.tabId)) return undefined;
  if (typeof raw.clientId !== 'string' || !ID.test(raw.clientId)) return undefined;
  if (user?.source === 'session') {
    return { tabId: raw.tabId, clientId: raw.clientId, name: user.name, ...(user.email === undefined ? {} : { email: user.email }) };
  }
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return { tabId: raw.tabId, clientId: raw.clientId, name: name === '' ? DEFAULT_HOLDER_NAME : name };
}

/** 423: someone else holds `lock`, and this write did not quote its token. */
export function lockedResponse(lock: EditLock): ApiResponse {
  const view = lockView(lock);
  const what = recordName(lock.record);
  const issue: Issue = {
    code: 'edit-locked',
    severity: 'error',
    message: `${lock.holder.name} is editing '${what}' — nothing was written.`,
    where: lock.record,
  };
  return {
    status: 423,
    body: {
      error: `'${what}' is being edited by ${lock.holder.name}.`,
      hint: 'Nothing was written. Use Request edit to ask for it, or Take over once their lock lapses.',
      issues: [issue],
      lock: view,
    },
  };
}

/** The write gate: 423 for the first leased record this write does not hold; `undefined` when it may go on. */
export async function editLockGate(request: EditLockRequest, deps: EditLockDeps): Promise<ApiResponse | undefined> {
  const store = deps.locks;
  if (store === undefined) return undefined;
  const records = recordsOfWrite(request.method, request.path, request.body);
  if (records.length === 0) return undefined;
  const tokens = tokensOf(request.lockHeader);
  const now = (deps.clock ?? Date.now)();
  for (const record of records) {
    const lock = await store.get(record, now);
    if (!holds(lock, tokens)) return lockedResponse(lock!);
  }
  return undefined;
}

function isLockPath(path: string): boolean {
  const head = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return head === '/api/locks' || head.startsWith('/api/locks/');
}

/** Everything under `/api/locks`; `undefined` for any other path. */
export async function handleLockRequest(request: EditLockRequest, deps: EditLockDeps): Promise<ApiResponse | undefined> {
  if (!isLockPath(request.path)) return undefined;
  const store = deps.locks;
  if (store === undefined) return fail(501, 'This studio does not keep edit locks.', 'Edits still save; the version check stops a stale save.');
  const now = (deps.clock ?? Date.now)();
  const method = request.method.toUpperCase();
  const action = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '')[2];

  if (action === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const locks = await store.list(now);
    return ok({ locks: locks.map((lock) => lockView(lock)), now: new Date(now).toISOString(), leaseMs: LEASE_MS });
  }
  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');

  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const record = body['record'];
  if (!isRecordKey(record)) return fail(400, `${JSON.stringify(String(record))} is not a record that can be locked.`);
  const token = typeof body['token'] === 'string' ? body['token'] : undefined;
  const needHolder = (): LockHolder | ApiResponse => readHolder(body['holder'], request.user) ?? fail(400, 'That request does not say who is editing.', 'Send holder: { tabId, clientId, name }.');
  const granted = (lock: EditLock): ApiResponse => ok({ token: lock.token, lock: lockView(lock) });

  switch (action) {
    case 'acquire': {
      const holder = needHolder();
      if ('status' in holder) return holder;
      const result = await store.acquire(record, holder, now);
      return result.ok ? granted(result.lock) : lockedResponse(result.lock);
    }
    case 'heartbeat': {
      if (token === undefined) return fail(400, 'A heartbeat has to quote its lock token.');
      const holder = needHolder();
      if ('status' in holder) return holder;
      const result = await store.heartbeat(record, token, holder, now);
      if (result.ok) return granted(result.lock);
      const by = result.lock?.holder.name;
      return fail(
        409,
        by === undefined ? `Your edit lock on '${recordName(record)}' is gone.` : `${by} took over '${recordName(record)}'.`,
        'Your unsaved changes stay in this tab; they cannot be saved over theirs.',
        {
          lost: true,
          ...(result.lock === undefined ? {} : { lock: lockView(result.lock) }),
          ...(result.takenOverAt === undefined ? {} : { takenOverAt: new Date(result.takenOverAt).toISOString() }),
        },
      );
    }
    case 'release': {
      if (token === undefined) return fail(400, 'A release has to quote its lock token.');
      return ok({ released: await store.release(record, token, now) });
    }
    case 'request': {
      const holder = needHolder();
      if ('status' in holder) return holder;
      const lock = await store.request(record, holder, now);
      return lock === undefined ? ok({ free: true }) : ok({ lock: lockView(lock) });
    }
    case 'decline': {
      if (token === undefined) return fail(400, 'An answer has to quote its lock token.');
      const lock = await store.decline(record, token, now);
      return ok(lock === undefined ? { free: true } : { lock: lockView(lock) });
    }
    case 'takeover': {
      const holder = needHolder();
      if ('status' in holder) return holder;
      const result = await store.takeOver(record, holder, now, body['force'] === true);
      if (result.ok) return granted(result.lock);
      const view: LockView = lockView(result.lock);
      return fail(
        409,
        `${result.lock.holder.name}'s lock on '${recordName(record)}' is still live.`,
        'Confirm to take over anyway. Their unsaved changes stay in their browser; they cannot save over yours.',
        { lock: view, needsConfirm: true },
      );
    }
    default:
      return fail(404, `${request.path} is not part of the workbench API.`, `Try one of: ${LOCK_ROUTES.join('; ')}.`);
  }
}

/**
 * The whole lock layer for a transport: `/api/locks/*` answered here, a write
 * to a record someone else holds refused here, everything else `undefined`
 * (carry on to the API).
 */
export async function editLockLayer(request: EditLockRequest, deps: EditLockDeps): Promise<ApiResponse | undefined> {
  const answer = await handleLockRequest(request, deps);
  if (answer !== undefined) {
    const record = (request.body as { record?: unknown } | undefined)?.record;
    if (answer.status < 400 && request.method.toUpperCase() === 'POST' && typeof record === 'string') deps.events?.publish({ type: 'locks', record });
    return answer;
  }
  return await editLockGate(request, deps);
}
