/**
 * Bulk tagging over the workbench API (`POST /api/design-tags`, `server/design-tags.ts`): tags added
 * and removed across designs through the ordinary save route, duplicates folded, an invalid tag
 * refusing the whole request, and the designs it may not change (someone else's edit lock, a pack's
 * read-only design, a stale version, a missing one) skipped and reported — memory stores, no disk.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiResponse, type WorkbenchDeps } from '../server/api.ts';
import { isDraftWrite } from '../server/auth/draft-grant.ts';
import { describeSave } from '../server/backup/commit-message.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { contentETag } from '../server/etag.ts';
import { memoryLockStore, type LockStore } from '../server/locks/lock-store.ts';
import { LOCK_HEADER } from '../src/locks/records.ts';

const db = loadDb();
const A = 'dc-pigtail-lead';
const B = 'dc-y-from-leads';
const C = 'dc-led-lead';

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
let locks: LockStore;
let packDesigns: string[];

beforeEach(() => {
  locks = memoryLockStore({ newToken: () => 'lease-token' });
  packDesigns = [];
  deps = {
    designs: memoryDesigns([loadDesign(A), loadDesign(B), loadDesign(C)]),
    loadDb: () => db,
    locks,
    lockClock: () => 1_000,
    installedPacks: () => ({ src: 'test', packs: [{ id: 'demo-pack', version: '1.0.0', license: 'CC0-1.0', added: Object.fromEntries(packDesigns.map((id) => [`designs/${id}.json`, []])) }] }),
    localUser: { name: 'Owner', source: 'local' },
  };
});

async function tag(body: unknown, headers?: Record<string, string>): Promise<ApiResponse & { body: any }> {
  return (await handleWorkbenchRequest({ method: 'POST', path: '/api/design-tags', body, ...(headers === undefined ? {} : { headers }) }, deps)) as ApiResponse & { body: any };
}

const tagsOf = async (id: string): Promise<string[] | undefined> => (await deps.designs.read(id))?.tags;

describe('POST /api/design-tags', () => {
  it('adds a tag to several designs, folding duplicates, and saves each through the design route', async () => {
    const first = await tag({ designs: [A, B, A], add: ['Batch 7', ' Batch 7 ', 'Phase 1'] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ add: ['Batch 7', 'Phase 1'], changed: 2, unchanged: 0, skipped: 0 });
    expect(await tagsOf(A)).toEqual(['Batch 7', 'Phase 1']);
    expect(await tagsOf(B)).toEqual(['Batch 7', 'Phase 1']);
    expect(await tagsOf(C)).toBeUndefined();
    // each changed design is an ordinary save: its event, its new ETag
    expect(first.events?.map((e) => [e.type, e.subject.id])).toEqual([['design.saved', A], ['design.saved', B]]);
    const a = first.body.results.find((r: { id: string }) => r.id === A);
    expect(a.etag).toBe(contentETag(await deps.designs.read(A)));

    // again, with one more design: the tagged ones are unchanged, nothing duplicated
    const again = await tag({ designs: [A, B, C], add: ['Batch 7'] });
    expect(again.body).toMatchObject({ changed: 1, unchanged: 2 });
    expect(await tagsOf(A)).toEqual(['Batch 7', 'Phase 1']);
    expect(await tagsOf(C)).toEqual(['Batch 7']);

    // the list carries the tags, for the Tags filter
    const list = (await handleWorkbenchRequest({ method: 'GET', path: '/api/designs' }, deps)).body as { designs: { id: string; tags?: string[] }[] };
    expect(list.designs.find((d) => d.id === C)?.tags).toEqual(['Batch 7']);
  });

  it('removes a tag, dropping the field once none are left', async () => {
    await tag({ designs: [A, B], add: ['Phase 1', 'Phase 2'] });
    const removed = await tag({ designs: [A, B, C], remove: ['Phase 1'] });
    expect(removed.body).toMatchObject({ changed: 2, unchanged: 1, skipped: 0 });
    expect(await tagsOf(A)).toEqual(['Phase 2']);
    await tag({ designs: [A], remove: ['Phase 2'] });
    const a = await deps.designs.read(A);
    expect(a !== undefined && 'tags' in a).toBe(false);
  });

  it('refuses an invalid tag before anything is written', async () => {
    const before = await deps.designs.read(A);
    const bad = await tag({ designs: [A, B], add: ['Phase 1', '#bad tag!'] });
    expect(bad.status).toBe(422);
    expect(bad.body.issues.map((i: { code: string }) => i.code)).toEqual(['invalid-tags']);
    expect(await deps.designs.read(A)).toEqual(before);
    expect((await tag({ designs: [A], add: ['x'.repeat(41)] })).status).toBe(422);
    expect((await tag({ designs: [A] })).status).toBe(400);
    expect((await tag({ designs: [A], add: ['Phase 1'], remove: ['Phase 1'] })).status).toBe(400);
    expect((await tag({ designs: [], add: ['Phase 1'] })).status).toBe(400);
  });

  it('skips and reports what it may not change, and tags the rest', async () => {
    // someone else holds an edit lock on B; C is a pack's read-only design
    await locks.acquire(`design:${B}`, { name: 'Sam', clientId: 'client-sam-1', tabId: 'tab-sam-1' }, 1_000);
    packDesigns = [C];
    const out = await tag({ designs: [A, B, C, 'no-such-design', { id: A, etag: '"stale"' }], add: ['Phase 1'] });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ changed: 1, skipped: 3 });
    const reasons = Object.fromEntries(out.body.results.map((r: { id: string; outcome: string; reason?: string }) => [r.id, r.reason ?? r.outcome]));
    expect(reasons).toEqual({ [A]: 'changed', [B]: 'locked', [C]: 'read-only', 'no-such-design': 'not-found' });
    expect(out.body.results.find((r: { id: string }) => r.id === B).error).toContain('Sam');
    expect(await tagsOf(B)).toBeUndefined();
    expect(await tagsOf(C)).toBeUndefined();

    // the lease holder quoting its token may tag it; a stale ETag is reported, not written
    const held = await tag({ designs: [B], add: ['Phase 1'] }, { [LOCK_HEADER]: 'lease-token' });
    expect(held.body.changed).toBe(1);
    const stale = await tag({ designs: [{ id: A, etag: '"not-this-one"' }], add: ['Phase 2'] });
    expect(stale.body.results).toEqual([expect.objectContaining({ id: A, outcome: 'skipped', reason: 'stale' })]);
    expect(await tagsOf(A)).toEqual(['Phase 1']);
  });

  it('is a draft write, and says what it did in the change set', () => {
    expect(isDraftWrite('POST', '/api/design-tags')).toBe(true);
    expect(describeSave({ method: 'POST', path: '/api/design-tags', body: { designs: [A, B], add: ['Phase 1'], remove: ['Phase 2'] } })).toBe('tag 2 designs: +Phase 1, -Phase 2');
  });
});
