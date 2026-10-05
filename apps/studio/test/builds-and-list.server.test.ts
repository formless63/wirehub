/**
 * The cable list's row derivation and the board-build routes, over the starter
 * designs and a Map-backed store. Re-covers the generic cases of the studio
 * tests dropped at the split (docs/boundaries.md §6).
 */

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import type { BoardBuilds } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { cableListEntry, designPartNumber, designPartNumbers, variationPartNumbers } from '../src/cable-list.ts';
import { handleBuildsRequest, readBuildsBody, type BuildsStore } from '../server/builds.ts';

const db = loadDb();

describe('cable list rows', () => {
  it('splits the label at the arrow into source and destination', () => {
    const row = cableListEntry(loadDesign('de9-terminal-board'), db);
    expect(row.source).toBe('DE-9');
    expect(row.destination).toBe('terminal adapter board, terminated pair');
    expect(row.destinationMain).toBe('terminal adapter board');
  });

  it('names the wire stocks without a vendor and without the part number in the name', () => {
    for (const id of listDesignIds()) {
      const row = cableListEntry(loadDesign(id), db);
      for (const wire of row.wires) {
        expect(wire.name, id).not.toMatch(/\(WIR-/);
        expect(wire.title).toMatch(/WIR-\d+/);
      }
    }
  });

  it('marks a breakout as a feature chip and a board by its part number and revision', () => {
    expect(cableListEntry(loadDesign('dc-y-splitter'), db).features.map((f) => f.text)).toContain('+ Breakout');
    expect(cableListEntry(loadDesign('dc-led-lead'), db).features).toEqual([]);
    expect(cableListEntry(loadDesign('de9-terminal-board'), db).boardLabels).toEqual(['PCA-00001 r1']);
  });

  it('counts parts and joints from the design', () => {
    const design = loadDesign('de9-crossover');
    expect(cableListEntry(design, db).jointCount).toBe(design.joints.length);
  });

  it('defaults the status to active and lists every part number the cable is built from', () => {
    const row = cableListEntry(loadDesign('dc-led-lead'), db);
    expect(row.status).toBe('active');
    expect(row.partNumbers).toEqual(expect.arrayContaining(['WIR-00005', 'CON-00010']));
  });
});

describe('cable part numbers', () => {
  it('prefers the design own product reference', () => {
    const r = designPartNumber({ id: 'x', productRef: ' cbl-00001 ' } as never, { drawing: { partNumber: 'CBL-00009' } });
    expect(r).toMatchObject({ pn: 'CBL-00001', basis: 'productRef' });
  });

  it('takes a fully written drawing number, and reports a length family as a family', () => {
    expect(designPartNumber({ id: 'x' }, { drawing: { partNumber: 'CBL-00009' } })).toMatchObject({ pn: 'CBL-00009', basis: 'drawing' });
    const family = designPartNumber({ id: 'x' }, { drawing: { partNumber: 'cbl-00012-xx' } });
    expect(family.pn).toBeUndefined();
    expect(family.family).toBe('CBL-00012-XX');
  });

  it('says there is none rather than guessing', () => {
    expect(designPartNumber({ id: 'x' })).toMatchObject({ basis: 'none' });
  });

  it('builds each length variation from the family stem', () => {
    expect(variationPartNumbers('CBL-00012-XX', [{ suffix: '-06' }, { suffix: '10' }, { suffix: 'too long' }])).toEqual(['CBL-00012-06', 'CBL-00012-10']);
    expect(variationPartNumbers('CBL-00012', [{ suffix: '06' }])).toEqual([]);
    expect(variationPartNumbers(undefined, undefined)).toEqual([]);
  });

  it('lists the family, every length and the parts for search', () => {
    const all = designPartNumbers(loadDesign('dc-led-lead'), db, { drawing: { partNumber: 'CBL-00012-XX', lengths: [{ suffix: '-06' }] } });
    expect(all).toEqual(expect.arrayContaining(['CBL-00012-XX', 'CBL-00012-06', 'WIR-00005']));
  });
});

function memoryBuilds(seed: Record<string, BoardBuilds> = {}): BuildsStore & { files: Map<string, BoardBuilds> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    list: () => [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, file]) => ({ name, file })),
    read: (name) => files.get(name),
    write: (name, file) => {
      files.set(name, file);
    },
  };
}

const good = (): BoardBuilds => ({
  board: 'PCA-00001',
  revision: 'Rev1',
  label: 'Terminal adapter board',
  end: 'destination',
  builds: [{ key: 'terminated', build: 'terminated', src: 'synthetic example' }],
});

describe('GET/PUT /api/builds', () => {
  const deps = (store?: BuildsStore) => ({ loadDb: () => db, ...(store === undefined ? {} : { builds: store }) });

  it('answers 501 when the studio keeps no build files', async () => {
    expect((await handleBuildsRequest('GET', ['api', 'builds'], undefined, deps()))?.status).toBe(501);
  });

  it('ignores any other path', async () => {
    expect(await handleBuildsRequest('GET', ['api', 'designs'], undefined, deps(memoryBuilds()))).toBeUndefined();
    expect(await handleBuildsRequest('GET', ['api', 'builds', 'x', 'extra'], undefined, deps(memoryBuilds()))).toBeUndefined();
  });

  it('lists nothing for an empty store and only accepts GET on the list', async () => {
    const store = memoryBuilds();
    expect((await handleBuildsRequest('GET', ['api', 'builds'], undefined, deps(store)))?.body).toEqual({ files: [] });
    expect((await handleBuildsRequest('DELETE', ['api', 'builds'], undefined, deps(store)))?.status).toBe(405);
  });

  it('refuses a name that is not a slug, and says 404 for one that is not there', async () => {
    const store = memoryBuilds();
    expect((await handleBuildsRequest('GET', ['api', 'builds', '..%2Fx'], undefined, deps(store)))?.status).toBe(400);
    expect((await handleBuildsRequest('GET', ['api', 'builds', 'pca-00009'], undefined, deps(store)))?.status).toBe(404);
  });

  it('refuses a body that is not a build file, naming what is wrong', () => {
    const bad = (file: unknown) => {
      const r = readBuildsBody({ file });
      return r.ok ? undefined : r.response.status;
    };
    expect(bad(undefined)).toBe(400);
    expect(bad({ ...good(), board: '' })).toBe(400);
    expect(bad({ ...good(), end: 'middle' })).toBe(400);
    expect(bad({ ...good(), builds: [] })).toBe(400);
    expect(bad({ ...good(), builds: [{ key: 'Bad Key', build: 'x', src: 'y' }] })).toBe(400);
    expect(bad({ ...good(), builds: [{ key: 'ok', build: 'x', src: '' }] })).toBe(400);
    expect(bad({ ...good(), settings: 'nope' })).toBe(400);
    expect(readBuildsBody({ file: good() }).ok).toBe(true);
  });

  it('will not save a file under a name that is not its own', async () => {
    const store = memoryBuilds();
    const res = await handleBuildsRequest('PUT', ['api', 'builds', 'something-else'], { file: good() }, deps(store));
    expect(res?.status).toBe(400);
    expect(store.files.size).toBe(0);
  });

  it('only accepts GET and PUT on one file', async () => {
    expect((await handleBuildsRequest('POST', ['api', 'builds', 'pca-00001-rev1'], {}, deps(memoryBuilds())))?.status).toBe(405);
  });

  it('saves a good file, serves it back with an ETag, and guards a second write with If-Match', async () => {
    const store = memoryBuilds();
    const name = 'pca-00001-rev1';
    const put = await handleBuildsRequest('PUT', ['api', 'builds', name], { file: good() }, deps(store));
    expect(put?.status).toBe(200);
    expect(store.files.has(name)).toBe(true);
    const etag = put?.headers?.['ETag'];
    expect(etag).toBeDefined();
    const got = await handleBuildsRequest('GET', ['api', 'builds', name], undefined, deps(store));
    expect(got?.headers?.['ETag']).toBe(etag);
    const stale = await handleBuildsRequest('PUT', ['api', 'builds', name], { file: { ...good(), label: 'Changed' } }, deps(store), '"stale"');
    expect([409, 428]).toContain(stale?.status);
    expect(store.files.get(name)?.label).toBe('Terminal adapter board');
    const fresh = await handleBuildsRequest('PUT', ['api', 'builds', name], { file: { ...good(), label: 'Changed' } }, deps(store), etag);
    expect(fresh?.status).toBe(200);
    expect(store.files.get(name)?.label).toBe('Changed');
  });
});
