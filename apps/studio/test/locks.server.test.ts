/**
 * Edit locks: the lease table, the `/api/locks`
 * endpoints and the 423 write gate — through both transports (the Hono app
 * the standalone server mounts, and the Connect middleware the Vite dev
 * server mounts), so neither can forget to apply it.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { DEFINITION_KINDS } from '../server/definition-store.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { editLockLayer, handleLockRequest } from '../server/locks/lock-api.ts';
import { memoryLockStore, type LockHolder, type LockStore } from '../server/locks/lock-store.ts';
import { workbenchMiddleware } from '../server/plugin.ts';
import type { DepictionDeps, DepictionStore } from '../server/depictions.ts';
import { describeLockContract } from './storage-contract/locks.ts';
import { LEASE_MS, LOCKABLE_DEFINITION_KINDS, LOCK_HEADER, recordsOfWrite } from '../src/locks/records.ts';

const ALEX: LockHolder = { name: 'Alex', clientId: 'client-alex-1', tabId: 'tab-alex-1' };
const WILL: LockHolder = { name: 'Sam', clientId: 'client-sam-1', tabId: 'tab-sam-1' };
const WILL_TAB2: LockHolder = { ...WILL, tabId: 'tab-will-2' };

function tokens(): () => string {
  let n = 0;
  return () => `token-${++n}`;
}

describeLockContract('memory', (newToken) => memoryLockStore({ newToken }));

describe('LockStore (memory only)', () => {
  let store: LockStore;
  beforeEach(() => {
    store = memoryLockStore({ newToken: tokens() });
  });

  it('a heartbeat on a free record re-acquires it — what a client does after a server restart', async () => {
    const before = await store.acquire('design:x', ALEX, 0);
    const restarted = memoryLockStore({ newToken: () => 'after-restart' });
    const beat = await restarted.heartbeat('design:x', before.lock.token, ALEX, 10);
    expect(beat).toMatchObject({ ok: true, lock: { token: 'after-restart', holder: { name: 'Alex' } } });
  });

});

describe('records', () => {
  it('names what each write touches', () => {
    expect(recordsOfWrite('GET', '/api/designs/x')).toEqual([]);
    expect(recordsOfWrite('PUT', '/api/designs/x')).toEqual(['design:x']);
    expect(recordsOfWrite('POST', '/api/designs')).toEqual([]);
    expect(recordsOfWrite('POST', '/api/designs/x/duplicate')).toEqual([]);
    expect(recordsOfWrite('POST', '/api/designs/x/rename')).toEqual(['design:x']);
    expect(recordsOfWrite('POST', '/api/designs/x/versions')).toEqual(['design:x']);
    expect(recordsOfWrite('PUT', '/api/drawings/x/photo')).toEqual(['design:x']);
    expect(recordsOfWrite('PUT', '/api/definitions/connectors/db9')).toEqual(['definition:connectors:db9']);
    expect(recordsOfWrite('POST', '/api/definitions/connectors')).toEqual([]);
    expect(recordsOfWrite('PUT', '/api/tags/pcbas/b1')).toEqual(['definition:pcbas:b1']);
    expect(recordsOfWrite('PUT', '/api/wire-library/stocks/w1')).toEqual(['definition:wires:w1']);
    expect(recordsOfWrite('PUT', '/api/builds/demo')).toEqual(['build:demo']);
    expect(recordsOfWrite('PATCH', '/api/vocab/manufacturers/belden')).toEqual(['vocab:manufacturers']);
    expect(recordsOfWrite('POST', '/api/depictions/db9/front')).toContain('definition:connectors:db9');
    expect(
      recordsOfWrite('POST', '/api/lineup/apply', { update: [{ design: { id: 'a' } }, { design: { id: 'b' } }], confirm: true }),
    ).toEqual(['design:a', 'design:b']);
  });

  it('knows every definition kind the server does', () => {
    expect([...LOCKABLE_DEFINITION_KINDS].sort()).toEqual([...DEFINITION_KINDS].sort());
  });
});

/* ------------------------------------------------------------------ *
 * The endpoints, as a pure function
 * ------------------------------------------------------------------ */

describe('/api/locks', () => {
  let now = 1_000_000;
  let deps: { locks: LockStore; clock: () => number };
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await handleLockRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps);
    return response!;
  };
  beforeEach(() => {
    now = 1_000_000;
    deps = { locks: memoryLockStore({ newToken: tokens() }), clock: () => now };
  });

  it('acquire → list → 423 for a second holder → release', async () => {
    const got = await call('/api/locks/acquire', { record: 'design:x', holder: ALEX });
    expect(got).toMatchObject({ status: 200, body: { token: 'token-1', lock: { record: 'design:x', holder: { name: 'Alex' } } } });
    const list = await call('/api/locks', undefined, 'GET');
    expect((list.body as { locks: unknown[] }).locks).toHaveLength(1);
    // the list never hands out a token
    expect(JSON.stringify(list.body)).not.toContain('token-1');
    const refused = await call('/api/locks/acquire', { record: 'design:x', holder: WILL_TAB2 });
    expect(refused.status).toBe(423);
    expect(refused.body).toMatchObject({ error: "'x' is being edited by Alex.", lock: { holder: { name: 'Alex', tabId: 'tab-alex-1' } } });
    expect(await call('/api/locks/release', { record: 'design:x', token: 'token-1' })).toMatchObject({ status: 200, body: { released: true } });
    expect((await call('/api/locks/acquire', { record: 'design:x', holder: WILL_TAB2 })).status).toBe(200);
  });

  it('heartbeat renews; after a takeover it answers 409 lost', async () => {
    await call('/api/locks/acquire', { record: 'design:x', holder: ALEX });
    now += 30_000;
    expect((await call('/api/locks/heartbeat', { record: 'design:x', token: 'token-1', holder: ALEX })).status).toBe(200);
    const live = await call('/api/locks/takeover', { record: 'design:x', holder: WILL });
    expect(live).toMatchObject({ status: 409, body: { needsConfirm: true } });
    const forced = await call('/api/locks/takeover', { record: 'design:x', holder: WILL, force: true });
    expect(forced).toMatchObject({ status: 200, body: { token: 'token-2' } });
    const lost = await call('/api/locks/heartbeat', { record: 'design:x', token: 'token-1', holder: ALEX });
    expect(lost).toMatchObject({ status: 409, body: { lost: true, error: "Sam took over 'x'.", lock: { holder: { name: 'Sam' } } } });
  });

  it('request edit reaches the holder on the next heartbeat; Keep answers it', async () => {
    await call('/api/locks/acquire', { record: 'design:x', holder: ALEX });
    await call('/api/locks/request', { record: 'design:x', holder: WILL });
    const beat = await call('/api/locks/heartbeat', { record: 'design:x', token: 'token-1', holder: ALEX });
    expect(beat.body).toMatchObject({ lock: { request: { name: 'Sam' } } });
    const kept = await call('/api/locks/decline', { record: 'design:x', token: 'token-1' });
    expect(kept.body).toMatchObject({ lock: { declined: { name: 'Sam' } } });
  });

  it('refuses a malformed record or holder', async () => {
    expect((await call('/api/locks/acquire', { record: '../etc', holder: ALEX })).status).toBe(400);
    expect((await call('/api/locks/acquire', { record: 'design:x', holder: { tabId: 'x' } })).status).toBe(400);
    expect((await call('/api/locks/acquire', { record: 'design:x' })).status).toBe(400);
  });

  it('with the login on, the session user is the holder, whatever name the client sent', async () => {
    const got = await handleLockRequest(
      { method: 'POST', path: '/api/locks/acquire', body: { record: 'design:x', holder: { ...ALEX, name: 'Mallory' } }, user: { name: 'Alex B', email: 'k@example.com', source: 'session' } },
      deps,
    );
    expect(got?.body).toMatchObject({ lock: { holder: { name: 'Alex B' } } });
  });

  it('the gate: a write to a held record without its token is 423; with it, or to a free record, it passes', async () => {
    await call('/api/locks/acquire', { record: 'design:x', holder: ALEX });
    const put = { method: 'PUT', path: '/api/designs/x' };
    expect(await editLockLayer(put, deps)).toMatchObject({ status: 423, body: { issues: [{ code: 'edit-locked' }] } });
    expect(await editLockLayer({ ...put, lockHeader: 'wrong' }, deps)).toMatchObject({ status: 423 });
    expect(await editLockLayer({ ...put, lockHeader: 'other, token-1' }, deps)).toBeUndefined();
    expect(await editLockLayer({ method: 'PUT', path: '/api/designs/y' }, deps)).toBeUndefined();
    // reads are never gated
    expect(await editLockLayer({ method: 'GET', path: '/api/designs/x' }, deps)).toBeUndefined();
    // …and once the lease lapses, the record is free again
    now += LEASE_MS + 1;
    expect(await editLockLayer(put, deps)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Through both transports
 * ------------------------------------------------------------------ */

const CATALOG: Db = loadDb();
const REAL: CableDesign = loadDesign('de9-terminal-board');

function memoryDesignStore(seed: CableDesign[]): DesignStore {
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      const next = formatDesignJson(design);
      const changed = files.get(id) !== next;
      files.set(id, next);
      return { changed };
    },
    remove: (id) => void files.delete(id),
  };
}

const noDepictions: DepictionStore = {
  listDefIds: () => [],
  readMeta: () => undefined,
  writeMeta: () => undefined,
  readAsset: () => undefined,
  writeAsset: () => undefined,
  dirFor: () => undefined,
};

function backend(): { deps: WorkbenchDeps; depictionDeps: DepictionDeps } {
  return {
    deps: { designs: memoryDesignStore([structuredClone(REAL)]), loadDb: () => CATALOG, locks: memoryLockStore() },
    depictionDeps: { store: noDepictions, loadDb: () => CATALOG },
  };
}

type Send = (path: string, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function lockFlow(send: Send): Promise<void> {
  const etag = (await send(`/api/designs/${REAL.id}`)).headers.get('etag')!;
  const acquired = (await (
    await send('/api/locks/acquire', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ record: `design:${REAL.id}`, holder: ALEX }) })
  ).json()) as { token: string };
  const body = JSON.stringify({ ...REAL, label: `${REAL.label} (edited)` });

  // Sam's save, without the token: refused before anything is read or written
  const refused = await send(`/api/designs/${REAL.id}`, { method: 'PUT', headers: { ...JSON_HEADERS, 'if-match': etag }, body });
  expect(refused.status).toBe(423);
  expect(await refused.json()).toMatchObject({ error: `'${REAL.id}' is being edited by Alex.` });

  // artwork of a locked record is gated too (path only — the body is never read)
  const art = await send(`/api/depictions/${REAL.id}/anchors`, { method: 'PUT', headers: JSON_HEADERS, body: '{}' });
  expect(art.status).not.toBe(423); // a design id is not a definition — no lease on that record

  // reads are never blocked
  expect((await send(`/api/designs/${REAL.id}`)).status).toBe(200);

  // Alex's save, with it: through the gate to the If-Match check and the write
  const saved = await send(`/api/designs/${REAL.id}`, { method: 'PUT', headers: { ...JSON_HEADERS, 'if-match': etag, [LOCK_HEADER]: acquired.token }, body });
  expect(saved.status).toBe(200);

  // the If-Match backstop still stands behind the lock: a stale version with the right token is 409
  const stale = await send(`/api/designs/${REAL.id}`, { method: 'PUT', headers: { ...JSON_HEADERS, 'if-match': etag, [LOCK_HEADER]: acquired.token }, body });
  expect(stale.status).toBe(409);
}

describe('both transports apply the lock layer', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const b = backend();
    server = createServer((req, res) => {
      workbenchMiddleware(b.deps, b.depictionDeps)(req, res, () => {
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('the standalone server (Hono)', async () => {
    const b = backend();
    const app = new Hono();
    mountWorkbenchApi(app, b.deps, b.depictionDeps);
    await lockFlow(async (path, init) => app.request(path, init));
  });

  it('the Vite dev server (Connect middleware)', async () => {
    await lockFlow((path, init) => fetch(`${base}${path}`, init));
  });

  it('gates artwork uploads to a held library record', async () => {
    const b = backend();
    const app = new Hono();
    mountWorkbenchApi(app, b.deps, b.depictionDeps);
    await b.deps.locks!.acquire('definition:connectors:db9-male', ALEX, Date.now());
    const art = await app.request('/api/depictions/db9-male/anchors', { method: 'PUT', headers: JSON_HEADERS, body: '{}' });
    expect(art.status).toBe(423);
    const dev = await fetch(`${base}/api/depictions/db9-male/anchors`, { method: 'PUT', headers: JSON_HEADERS, body: '{}' });
    // the dev server has its own (empty) table: not locked there
    expect(dev.status).not.toBe(423);
  });
});
