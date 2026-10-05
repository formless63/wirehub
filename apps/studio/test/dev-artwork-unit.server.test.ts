/**
 * The Vite dev host's artwork writes (`plugin.ts`) go through a unit of work
 * like the standalone server's: one change set per write, and `?dryRun=1`
 * answers the would-be change without writing anything.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadDb } from '@wirehub/catalog';
import type { Db } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { formatMetaJson, type DepictionDeps, type DepictionStore } from '../server/depictions.ts';
import { workbenchMiddleware } from '../server/plugin.ts';
import { commitChangeSet } from '../server/storage/unit-of-work.ts';

const db: Db = loadDb();
const BOARD = 'pair-terminal-board';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 200 100"><rect x="10" y="10" width="180" height="80" fill="#fff" stroke="#000" stroke-width="2"/></svg>';

function memoryStore(): DepictionStore & { metas: Map<string, string>; assets: Map<string, Uint8Array> } {
  const metas = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  return {
    metas,
    assets,
    listDefIds: () => [...metas.keys()].sort(),
    readMeta: (id) => (metas.has(id) ? (JSON.parse(metas.get(id) as string) as Record<string, unknown>) : undefined),
    writeMeta: (id, meta) => void metas.set(id, formatMetaJson(meta)),
    readAsset: (id, file) => assets.get(`${id}/${file}`),
    writeAsset: (id, file, content) => void assets.set(`${id}/${file}`, typeof content === 'string' ? new TextEncoder().encode(content) : content),
    dirFor: () => undefined,
  };
}

let server: Server;
let base: string;
let store: ReturnType<typeof memoryStore>;
const commits: string[][] = [];

beforeEach(async () => {
  store = memoryStore();
  commits.length = 0;
  const deps: WorkbenchDeps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: true }), remove: () => {} },
    loadDb: () => db,
    depictions: store,
    commit: async (set) => {
      commits.push(set.changes.map((c) => `${c.kind} ${c.key} ${c.op}`));
      return commitChangeSet({ designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: true }), remove: () => {} }, loadDb: () => db, depictions: store }, set);
    },
  };
  const depictionDeps: DepictionDeps = { store, loadDb: () => db };
  server = createServer((req, res) =>
    workbenchMiddleware(deps, depictionDeps)(req, res, () => {
      res.statusCode = 404;
      res.end('{}');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const upload = (query = '') =>
  fetch(`${base}/api/depictions/${BOARD}/board-top${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'b.svg', data: Buffer.from(SVG).toString('base64') }),
  });

describe('artwork writes on the dev host', () => {
  it('a dry run answers the would-be change set and writes nothing', async () => {
    const response = await upload('?dryRun=1');
    const answer = (await response.json()) as { dryRun?: boolean; changes?: { kind: string }[] };
    expect(response.status).toBe(200);
    expect(answer.dryRun).toBe(true);
    expect(answer.changes?.map((c) => c.kind).sort()).toEqual(['depiction-asset', 'depiction-meta']);
    expect(store.metas.size).toBe(0);
    expect(store.assets.size).toBe(0);
    expect(commits).toEqual([]);
  });

  it('a real write commits once, as one change set', async () => {
    const response = await upload();
    expect(response.status).toBe(201);
    expect(commits).toEqual([[`depiction-asset ${BOARD}/board-top.svg put`, `depiction-meta ${BOARD} put`]]);
    expect(store.metas.has(BOARD)).toBe(true);
  });
});
