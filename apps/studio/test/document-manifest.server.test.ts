/**
 * The released document manifest (`docs/document-manifest.md`): every hash is the hash of the
 * bytes its URL returns, a revision's renders are kept (no re-render, untouched by a newer
 * revision or live edits), approving moves the keys, an unlocked revision has no manifest, and
 * `released` resolves to a number. Memory stores and a memory document cache.
 */

import { createHash } from 'node:crypto';

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { routeWorkbenchRequest, type ApiResponse, type WorkbenchDeps } from '../server/api.ts';
import { memoryDocumentCache } from '../server/document-cache.ts';
import type { DocumentManifest } from '../server/document-manifest.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore } from '../server/drawings.ts';
import { ENGINEERING_PATH } from '../server/settings.ts';
import { memoryDocStore } from '../server/storage/doc-store.ts';
import { memoryVersionStore } from '../server/versions.ts';

const db = loadDb();
const ID = 'de9-crossover';

function memoryDesigns(seed: CableDesign[]): DesignStore {
  const files = new Map(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? (JSON.parse(files.get(id) as string) as CableDesign) : undefined),
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

let deps: WorkbenchDeps;
let cache: ReturnType<typeof memoryDocumentCache>;
let clock = 0;

beforeEach(() => {
  clock = 0;
  cache = memoryDocumentCache();
  const drawings = memoryDrawingStore();
  drawings.writeMeta(ID, { revision: '1', title: 'DE-9 crossover lead' });
  deps = {
    designs: memoryDesigns([loadDesign(ID)]),
    loadDb: () => db,
    drawings,
    docs: memoryDocStore(),
    versions: memoryVersionStore(),
    documentCache: cache,
    now: () => `2026-09-25T10:00:0${clock++}.000Z`,
    localUser: { name: 'Owner', source: 'local' },
  };
});

const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> => routeWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps);
const manifest = async (rev: string | number): Promise<DocumentManifest> => {
  const answer = await call('GET', `/api/designs/${ID}/versions/${rev}/documents`);
  expect(answer.status).toBe(200);
  return answer.body as DocumentManifest;
};
const hashes = (m: DocumentManifest): Record<string, string> => Object.fromEntries(m.documents.map((d) => [d.name, d.sha256]));
const keys = (m: DocumentManifest): Record<string, string> => Object.fromEntries(m.documents.map((d) => [d.name, d.renderKey]));

describe('released document manifest', () => {
  it('hashes the bytes each URL returns; a second call renders nothing; a newer revision and live edits leave it alone', async () => {
    expect((await call('POST', `/api/designs/${ID}/versions`, { note: 'first' })).status).toBe(201);
    const first = await manifest('released');
    expect(first.rev).toBe(1);
    expect(first.released).toBe(true);
    expect(first.unavailable).toEqual([]);
    expect(first.documents.map((d) => d.name)).toContain('documents/drawing.pdf');
    expect(first.documents.map((d) => d.name)).toContain('exports/bom.csv');
    for (const doc of first.documents) {
      const got = await call('GET', doc.url);
      expect(got.status).toBe(200);
      expect(createHash('sha256').update(got.bytes as Uint8Array).digest('hex'), doc.name).toBe(doc.sha256);
      expect(got.headers?.['ETag']).toBe(`"sha256:${doc.sha256}"`);
    }
    const puts = cache.puts;
    expect(puts).toBe(first.documents.length);
    expect((await manifest(1)).packageHash).toBe(first.packageHash);
    expect(cache.puts).toBe(puts);

    // a live edit, Rev 2 saved (the drawing sidecar's revision moves to 2), the library changed under it
    deps.designs.write(ID, { ...loadDesign(ID), label: 'changed after Rev 1' });
    expect((await call('POST', `/api/designs/${ID}/versions`, { note: 'second' })).status).toBe(201);
    deps.loadDb = () => ({ ...db, wires: [] });
    const again = await manifest(1);
    expect(hashes(again)).toEqual(hashes(first));
    expect(keys(again)).toEqual(keys(first));
    expect(again.packageHash).toBe(first.packageHash);
    expect(again.released).toBe(false);
    expect(cache.puts).toBe(puts);
  });

  it('approving moves the keys and the printed hashes; released resolves to the approved number; an unlocked revision is refused', async () => {
    await deps.docs!.write(ENGINEERING_PATH, { approvals: { enabled: true }, src: 'test' });
    expect((await call('POST', `/api/designs/${ID}/versions`, { note: 'first' })).status).toBe(201);
    expect((await call('GET', `/api/designs/${ID}/versions/released/documents`)).status).toBe(404);
    const draft = await manifest(1);
    expect(draft.released).toBe(false);
    expect((await call('POST', `/api/designs/${ID}/versions/1/submit`, { comment: 'check it' })).status).toBe(200);
    expect((await call('POST', `/api/designs/${ID}/versions/1/approve`, { comment: 'checked' })).status).toBe(200);
    const approved = await manifest('released');
    expect(approved.rev).toBe(1);
    expect(approved.released).toBe(true);
    expect(approved.approval).toMatchObject({ state: 'approved', by: 'Owner' });
    for (const doc of approved.documents) expect(doc.renderKey).not.toBe(keys(draft)[doc.name]);
    expect(hashes(approved)['documents/drawing.svg']).not.toBe(hashes(draft)['documents/drawing.svg']);
    expect(approved.packageHash).not.toBe(draft.packageHash);

    expect((await call('POST', `/api/designs/${ID}/versions/1/unlock`, { reason: 'fix a note' })).status).toBe(200);
    expect((await call('GET', `/api/designs/${ID}/versions/1/documents`)).status).toBe(409);
  });
});
