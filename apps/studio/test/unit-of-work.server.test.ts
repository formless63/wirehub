/**
 * The unit of work (storage seams): handlers stage,
 * the commit writes in one step, a refusal writes nothing, a record that
 * moved underneath the request refuses the whole set, mutating requests run
 * one at a time, derived records follow their inputs, and the db snapshot is
 * reused per catalog version.
 */

import { fixtureCatalog } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { DerivedStore } from '../server/derived.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { contentETag } from '../server/etag.ts';
import { StaleRecordError, type DerivedKind } from '../server/storage/change-set.ts';
import { commitChangeSet, derivedFor, UnitOfWork } from '../server/storage/unit-of-work.ts';

const fixture = fixtureCatalog();
const DB: Db = fixture.loadDb();
const A = fixture.loadDesign('db9-null-modem');
const B = fixture.loadDesign('xlr-mic-cable');

/** A design store over a Map of file texts, counting the writes that reach it. */
function memoryDesigns(seed: CableDesign[]): DesignStore & { files: Map<string, string>; writes: string[]; slow?: number } {
  const files = new Map(seed.map((d) => [d.id, formatDesignJson(d)]));
  const store = {
    files,
    writes: [] as string[],
    slow: undefined as number | undefined,
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id: string) => files.has(id),
    // a store that answers later, like a database would
    read: async (id: string) => {
      if (store.slow !== undefined) await new Promise((resolve) => setTimeout(resolve, store.slow));
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id: string, design: CableDesign) => {
      store.writes.push(id);
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id: string) => {
      store.writes.push(`-${id}`);
      files.delete(id);
    },
  };
  return store;
}

function recordingDerived(): DerivedStore & { runs: number } {
  const d = {
    runs: 0,
    regenerate: (): DerivedKind[] => {
      d.runs += 1;
      return ['module'];
    },
  };
  return d;
}

describe('a unit of work', () => {
  it('stages writes (read back inside the request), and nothing reaches the store until commit', async () => {
    const designs = memoryDesigns([A]);
    const uow = new UnitOfWork({ designs, loadDb: () => DB });
    const renamed = { ...structuredClone(A), label: 'staged' };
    await uow.deps.designs.write(A.id, renamed);
    expect((await uow.deps.designs.read(A.id))?.label).toBe('staged');
    expect((await uow.deps.designs.list()).map((d) => d.label)).toEqual(['staged']);
    expect(designs.writes).toEqual([]);

    // the change set: storage-agnostic records, conditional on what was read
    expect(uow.changes).toEqual([{ kind: 'design', key: A.id, op: 'put', value: renamed, expect: contentETag(A) }]);

    await uow.commit({ method: 'PUT', path: `/api/designs/${A.id}` });
    expect(designs.writes).toEqual([A.id]);
    expect(JSON.parse(designs.files.get(A.id) as string).label).toBe('staged');
  });

  it('refuses the whole set when a record it read changed underneath it — nothing written', async () => {
    const designs = memoryDesigns([A, B]);
    const uow = new UnitOfWork({ designs, loadDb: () => DB });
    await uow.deps.designs.write(B.id, { ...structuredClone(B), label: 'mine' });
    await uow.deps.designs.write(A.id, { ...structuredClone(A), label: 'mine too' });
    // another process saves A in between
    designs.files.set(A.id, formatDesignJson({ ...A, label: 'theirs' }));
    await expect(uow.commit({ method: 'POST', path: '/api/lineup/apply' })).rejects.toBeInstanceOf(StaleRecordError);
    expect(designs.writes).toEqual([]);
    expect(JSON.parse(designs.files.get(B.id) as string).label).toBe(B.label);
  });

  it('a create is conditional on the record not existing', async () => {
    const designs = memoryDesigns([]);
    const uow = new UnitOfWork({ designs, loadDb: () => DB });
    expect(await uow.deps.designs.read(A.id)).toBeUndefined();
    await uow.deps.designs.write(A.id, A);
    expect(uow.changes[0]?.expect).toBeNull();
    designs.files.set(A.id, formatDesignJson(A));
    await expect(uow.commit({ method: 'POST', path: '/api/designs' })).rejects.toBeInstanceOf(StaleRecordError);
  });

  it('answers a request with 409 when the commit finds a stale record', async () => {
    const designs = memoryDesigns([A]);
    const deps: WorkbenchDeps = { designs, loadDb: () => DB };
    const etag = (await handleWorkbenchRequest({ method: 'GET', path: `/api/designs/${A.id}` }, deps)).headers?.['ETag'] as string;
    // a store that changes the record between the handler's read and the commit
    const read = designs.read;
    let reads = 0;
    designs.read = async (id: string) => {
      reads += 1;
      if (reads === 2) designs.files.set(A.id, formatDesignJson({ ...A, label: 'hand edit on disk' }));
      return read(id);
    };
    const out = await handleWorkbenchRequest(
      { method: 'PUT', path: `/api/designs/${A.id}`, body: { ...structuredClone(A), label: 'mine' }, headers: { 'if-match': etag } },
      deps,
    );
    expect(out.status).toBe(409);
    expect(JSON.parse(designs.files.get(A.id) as string).label).toBe('hand edit on disk');
  });

  it('writes nothing when the handler refuses', async () => {
    const designs = memoryDesigns([A]);
    const deps: WorkbenchDeps = { designs, loadDb: () => DB };
    const broken = structuredClone(A);
    broken.instances.pcbas.push({ id: 'u9', def: 'no-such-board' });
    const etag = contentETag(A);
    const out = await handleWorkbenchRequest({ method: 'PUT', path: `/api/designs/${A.id}`, body: broken, headers: { 'if-match': etag } }, deps);
    expect(out.status).toBe(422);
    expect(designs.writes).toEqual([]);
  });

  it('runs mutating requests one at a time: two saves quoting the same version — one wins, one is stale', async () => {
    const designs = memoryDesigns([A]);
    designs.slow = 5;
    const deps: WorkbenchDeps = { designs, loadDb: () => DB };
    const etag = contentETag(A);
    const save = (label: string) =>
      handleWorkbenchRequest({ method: 'PUT', path: `/api/designs/${A.id}`, body: { ...structuredClone(A), label }, headers: { 'if-match': etag } }, deps);
    const [one, two] = await Promise.all([save('first'), save('second')]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(designs.writes).toEqual([A.id]);
  });

  it('recomputes the derived records when a save changes their inputs, and not otherwise', async () => {
    const designs = memoryDesigns([A]);
    const derived = recordingDerived();
    const deps: WorkbenchDeps = { designs, loadDb: () => DB, derived };
    await handleWorkbenchRequest({ method: 'GET', path: '/api/designs' }, deps);
    expect(derived.runs).toBe(0);
    const out = await handleWorkbenchRequest(
      { method: 'PUT', path: `/api/designs/${A.id}`, body: { ...structuredClone(A), label: 'x' }, headers: { 'if-match': contentETag(A) } },
      deps,
    );
    expect(out.status).toBe(200);
    expect(derived.runs).toBe(1);
    expect(derivedFor([{ kind: 'asset', key: 'k', op: 'put' } as never])).toEqual([]);
    expect(derivedFor([{ kind: 'definitions', key: 'connectors', op: 'put' }])).toEqual(['tags', 'module']);
  });

  it('loads the db once per catalog version, and a fresh copy per request', async () => {
    let loads = 0;
    let version = 'v1';
    const deps: WorkbenchDeps = {
      designs: memoryDesigns([A]),
      loadDb: () => {
        loads += 1;
        return DB;
      },
      catalogVersion: () => version,
    };
    const first = await new UnitOfWork(deps).deps.loadDb();
    const second = await new UnitOfWork(deps).deps.loadDb();
    expect(loads).toBe(1);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    version = 'v2';
    await new UnitOfWork(deps).deps.loadDb();
    expect(loads).toBe(2);
  });

  it('applies a change set through any backend whose stores persist', async () => {
    const designs = memoryDesigns([A]);
    const result = await commitChangeSet(
      { designs, loadDb: () => DB },
      { changes: [{ kind: 'design', key: B.id, op: 'put', value: B, expect: null }, { kind: 'design', key: A.id, op: 'delete' }], context: { method: 'POST', path: '/x' } },
    );
    expect(result.applied).toBe(2);
    expect([...designs.files.keys()]).toEqual([B.id]);
  });
});
