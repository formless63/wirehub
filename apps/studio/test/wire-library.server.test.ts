/**
 * The wire builder's endpoints (pci.17): parts in, stocks compiled from
 * recipes out, the whole library validated before anything is written.
 */

import { loadDb, loadStripPractice, loadWireLibrary } from '@wirehub/catalog';
import type { WirePart } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { DesignStore } from '../server/designs.ts';
import { memoryWireLibraryStore, type WireLibraryStore } from '../server/wire-library.ts';
import { withLoadedVersion } from './loaded-version.ts';

const CATALOG = loadDb();
const LIBRARY = loadWireLibrary();

const noDesigns: DesignStore = {
  list: () => [],
  has: () => false,
  read: () => undefined,
  write: () => ({ changed: false }),
  remove: () => undefined,
};

let store: WireLibraryStore;
let deps: WorkbenchDeps;

beforeEach(async () => {
  store = memoryWireLibraryStore(LIBRARY, CATALOG.wires);
  deps = { designs: noDesigns, loadDb: async () => ({ ...CATALOG, wires: await store.wires() }), wireLibrary: store };
});

const call = async (method: string, path: string, body?: unknown) => await handleWorkbenchRequest(await withLoadedVersion({ method, path, body }, deps), deps);

describe('/api/wire-library', () => {
  it('serves the strip practice read-only, and an empty list without it (50a.58)', async () => {
    const practice = loadStripPractice();
    const withPractice: WorkbenchDeps = { ...deps, wireLibrary: memoryWireLibraryStore(LIBRARY, CATALOG.wires, practice) };
    const read = await handleWorkbenchRequest(await withLoadedVersion({ method: 'GET', path: '/api/wire-library/strip-practice' }, withPractice), withPractice);
    expect(read.status).toBe(200);
    expect((read.body as { id: string }[]).map((p) => p.id)).toEqual(practice.map((p) => p.id));
    expect((await call('GET', '/api/wire-library/strip-practice')).body).toEqual([]);
    expect((await call('PUT', '/api/wire-library/strip-practice', [])).status).toBe(405);
  });

  it('adds a cited part and refuses an uncited or duplicate one', async () => {
    const part: WirePart = { kind: 'conductor', id: 'c-test', label: 'Test', material: 'tinned copper', strands: 7, strandMm: 0.1, src: 'bench' };
    expect((await call('POST', '/api/wire-library/parts', { part })).status).toBe(201);
    expect((await store.read()).parts.some((p) => p.id === 'c-test')).toBe(true);
    expect((await call('POST', '/api/wire-library/parts', { part })).status).toBe(409);
    expect((await call('POST', '/api/wire-library/parts', { part: { ...part, id: 'c-other', src: '' } })).status).toBe(400);
  });
});
