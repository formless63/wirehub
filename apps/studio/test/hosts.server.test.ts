/**
 * Both hosts, one core.
 *
 * The Vite dev server (`plugin.ts`'s `workbenchMiddleware`, a plain
 * Connect-style `(req, res, next)` over a real socket) and the standalone
 * server (`hono-adapter.ts`'s `mountWorkbenchApi`, a Hono app exercised
 * in-process with `app.request()`) are two transports around the exact same
 * `handleWorkbenchRequest` / `handleDepictionRequest`. This file proves they
 * answer identically for a representative set of routes — including the
 * stale-write guard's 409 — by sending the same requests, in the same order,
 * against two independently-seeded-but-identical stores and diffing the
 * responses.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadDb, loadDesign } from '@cable-studio/catalog';
import type { CableDesign, ConnectorDefinition, Db } from '@cable-studio/model';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import type { DefinitionKind, DefinitionRecord, DefinitionStore } from '../server/definition-store.ts';
import type { DepictionDeps, DepictionStore } from '../server/depictions.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { workbenchMiddleware } from '../server/plugin.ts';

const CATALOG: Db = loadDb();
const REAL: CableDesign = loadDesign('rs485-de9-terminal-board');

function memoryDesignStore(seed: CableDesign[]): DesignStore {
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () =>
      [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
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

function memoryDefinitionStore(): DefinitionStore {
  const files = new Map<DefinitionKind, DefinitionRecord[]>([
    ['connectors', structuredClone(CATALOG.connectors)],
    ['components', structuredClone(CATALOG.components)],
    ['wires', structuredClone(CATALOG.wires)],
    ['pcbas', []],
  ]);
  return {
    list: (kind) => structuredClone(files.get(kind) ?? []),
    write: (kind, records) => {
      files.set(kind, structuredClone(records));
      return { changed: true };
    },
  };
}

function memoryDepictionStore(): DepictionStore {
  return {
    listDefIds: () => [],
    readMeta: () => undefined,
    writeMeta: () => undefined,
    readAsset: () => undefined,
    writeAsset: () => undefined,
    dirFor: () => undefined,
  };
}

/** Two independent, identically-seeded backends — one per host. */
function backend(): { deps: WorkbenchDeps; depictionDeps: DepictionDeps } {
  const deps: WorkbenchDeps = {
    designs: memoryDesignStore([structuredClone(REAL)]),
    definitions: memoryDefinitionStore(),
    loadDb: () => CATALOG,
  };
  const depictionDeps: DepictionDeps = { store: memoryDepictionStore(), loadDb: () => CATALOG };
  return { deps, depictionDeps };
}

/* ------------------------------------------------------------------ *
 * The two hosts
 * ------------------------------------------------------------------ */

let connectServer: Server;
let connectBase: string;
let honoApp: Hono;

beforeEach(async () => {
  const connectBackend = backend();
  connectServer = createServer((req, res) => {
    workbenchMiddleware(connectBackend.deps, connectBackend.depictionDeps)(req, res, () => {
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => connectServer.listen(0, '127.0.0.1', resolve));
  const address = connectServer.address() as AddressInfo;
  connectBase = `http://127.0.0.1:${address.port}`;

  const honoBackend = backend();
  honoApp = new Hono();
  mountWorkbenchApi(honoApp, honoBackend.deps, honoBackend.depictionDeps);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    connectServer.close((error) => (error ? reject(error) : resolve())),
  );
});

interface Compared {
  status: number;
  body: unknown;
  etag: string | null;
}

/** Sends the same GET (this file only needs GET here — writes are compared by hand below, since each host's own store has to be mutated in step). */
async function onBothHosts(method: string, path: string): Promise<{ connect: Compared; hono: Compared }> {
  const init: RequestInit = { method };

  const connectResponse = await fetch(`${connectBase}${path}`, init);
  const connectBody: unknown = await connectResponse.json();
  const connect: Compared = { status: connectResponse.status, body: connectBody, etag: connectResponse.headers.get('etag') };

  const honoResponse = await honoApp.request(path, init);
  const honoBody: unknown = await honoResponse.json();
  const hono: Compared = { status: honoResponse.status, body: honoBody, etag: honoResponse.headers.get('etag') };

  return { connect, hono };
}

describe('the Vite dev host and the standalone Hono host answer /api/* identically', () => {
  it('GET /api — the route index', async () => {
    const { connect, hono } = await onBothHosts('GET', '/api');
    expect(hono.status).toBe(connect.status);
    expect(hono.body).toEqual(connect.body);
  });

  it('GET /api/designs — the list', async () => {
    const { connect, hono } = await onBothHosts('GET', '/api/designs');
    expect(hono.status).toBe(200);
    expect(hono.status).toBe(connect.status);
    expect(hono.body).toEqual(connect.body);
  });

  it('GET /api/designs/:id — with an ETag on both', async () => {
    const { connect, hono } = await onBothHosts('GET', `/api/designs/${REAL.id}`);
    expect(hono.status).toBe(200);
    expect(hono.status).toBe(connect.status);
    expect(hono.body).toEqual(connect.body);
    expect(hono.etag).not.toBeNull();
    expect(hono.etag).toBe(connect.etag);
  });

  it('GET /api/designs/no-such-cable — a 404, same words', async () => {
    const { connect, hono } = await onBothHosts('GET', '/api/designs/no-such-cable');
    expect(hono.status).toBe(404);
    expect(hono.body).toEqual(connect.body);
  });

  it('PUT /api/designs/:id — a fresh If-Match writes on both hosts', async () => {
    const first = await onBothHosts('GET', `/api/designs/${REAL.id}`);
    const edited = { ...structuredClone(REAL), label: 'edited on both hosts' };

    const connectPut = await fetch(`${connectBase}/api/designs/${REAL.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': first.connect.etag as string },
      body: JSON.stringify(edited),
    });
    const honoPut = await honoApp.request(`/api/designs/${REAL.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': first.hono.etag as string },
      body: JSON.stringify(edited),
    });
    expect(connectPut.status).toBe(200);
    expect(honoPut.status).toBe(200);
    expect(await connectPut.json()).toEqual(await honoPut.json());
  });

  it('PUT /api/designs/:id — a stale If-Match is refused 409 on both hosts, same marker', async () => {
    const first = await onBothHosts('GET', `/api/designs/${REAL.id}`);

    // someone else saves first, on each host independently
    await fetch(`${connectBase}/api/designs/${REAL.id}`, {
      method: 'PUT',
      // an explicit "overwrite whatever is there"
      headers: { 'content-type': 'application/json', 'if-match': '*' },
      body: JSON.stringify({ ...structuredClone(REAL), label: 'saved elsewhere' }),
    });
    await honoApp.request(`/api/designs/${REAL.id}`, {
      method: 'PUT',
      // an explicit "overwrite whatever is there"
      headers: { 'content-type': 'application/json', 'if-match': '*' },
      body: JSON.stringify({ ...structuredClone(REAL), label: 'saved elsewhere' }),
    });

    const connectPut = await fetch(`${connectBase}/api/designs/${REAL.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': first.connect.etag as string },
      body: JSON.stringify({ ...structuredClone(REAL), label: 'my stale edit' }),
    });
    const honoPut = await honoApp.request(`/api/designs/${REAL.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': first.hono.etag as string },
      body: JSON.stringify({ ...structuredClone(REAL), label: 'my stale edit' }),
    });
    expect(connectPut.status).toBe(409);
    expect(honoPut.status).toBe(409);
    const connectBody = (await connectPut.json()) as { issues?: { code: string }[] };
    const honoBody = (await honoPut.json()) as { issues?: { code: string }[] };
    expect(connectBody.issues?.[0]?.code).toBe('stale-write');
    expect(honoBody.issues?.[0]?.code).toBe('stale-write');
  });

  it('GET /api/definitions/:kind/:id — a definition record, with an ETag on both', async () => {
    const id = (CATALOG.connectors[0] as ConnectorDefinition).id;
    const { connect, hono } = await onBothHosts('GET', `/api/definitions/connectors/${id}`);
    expect(hono.status).toBe(200);
    expect(hono.body).toEqual(connect.body);
    expect(hono.etag).not.toBeNull();
    expect(hono.etag).toBe(connect.etag);
  });

  it('GET /api/depictions — the artwork index, empty on both', async () => {
    const { connect, hono } = await onBothHosts('GET', '/api/depictions');
    expect(hono.status).toBe(200);
    expect(hono.body).toEqual(connect.body);
    expect(hono.body).toEqual({ depictions: [] });
  });

  it('an unknown route is a 404 with the same route list, on both', async () => {
    const { connect, hono } = await onBothHosts('GET', '/api/not-a-real-route');
    expect(hono.status).toBe(404);
    expect(hono.body).toEqual(connect.body);
  });
});

/* ------------------------------------------------------------------ *
 * The write rails (review fix, 2026-09-26): the same answers on both hosts
 * ------------------------------------------------------------------ */

describe('write rails, identical on both hosts', () => {
  /** One write, sent to each host in turn; the statuses back. */
  async function writeBoth(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<[number, number]> {
    const connect = await fetch(`${connectBase}${path}`, init);
    const hono = await honoApp.request(path, init);
    return [connect.status, hono.status];
  }

  it('a design save with no If-Match is refused 428', async () => {
    const body = JSON.stringify(structuredClone(REAL));
    expect(await writeBoth(`/api/designs/${REAL.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).toEqual([428, 428]);
  });

  it('a cross-site write is refused 403 — by Origin and by Sec-Fetch-Site — and nothing is created', async () => {
    const body = JSON.stringify({ newId: 'csrf-dup-test' });
    const path = `/api/designs/${REAL.id}/duplicate`;
    expect(await writeBoth(path, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://evil.example' }, body })).toEqual([403, 403]);
    expect(await writeBoth(path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body })).toEqual([403, 403]);
    expect(await writeBoth(path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }, body })).toEqual([403, 403]);
    expect((await onBothHosts('GET', '/api/designs/csrf-dup-test')).hono.status).toBe(404);
  });

  it('a write body that is not JSON is refused 415, even from the same origin', async () => {
    const body = JSON.stringify({ newId: 'plain-text-dup' });
    expect(await writeBoth(`/api/designs/${REAL.id}/duplicate`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).toEqual([415, 415]);
  });

  it('a same-origin or no-Origin (curl) JSON write goes through', async () => {
    const body = (id: string): string => JSON.stringify({ newId: id });
    const path = `/api/designs/${REAL.id}/duplicate`;
    expect(await writeBoth(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('curl-dup') })).toEqual([201, 201]);
    expect(await writeBoth(path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: body('same-origin-dup') })).toEqual([201, 201]);
  });

  it('a JSON body over 4 MB is refused 413 without being parsed', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024) });
    expect(await writeBoth('/api/designs', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).toEqual([413, 413]);
  });
});
