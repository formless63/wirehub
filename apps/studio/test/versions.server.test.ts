/**
 * Design versions over the workbench API: save, list,
 * unlock with a reason, edit + re-lock, branch (the displaced working copy is
 * kept), restore, delete/rename rules — memory stores, no disk; plus the file
 * store's bytes against a temp directory.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath, loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign, DesignVersionFile } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore } from '../server/drawings.ts';
import { contentETag } from '../server/etag.ts';
import { fileVersionStore, memoryVersionStore, type VersionListing } from '../server/versions.ts';
import { withLoadedVersion } from './loaded-version.ts';

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
let clock = 0;

beforeEach(async () => {
  clock = 0;
  const drawings = memoryDrawingStore();
  drawings.writeMeta(ID, { revision: '1', title: 'DE-9 crossover lead' });
  deps = {
    designs: memoryDesigns([loadDesign(ID)]),
    loadDb: () => db,
    drawings,
    versions: memoryVersionStore(),
    now: () => `2026-09-25T10:00:0${clock++}.000Z`,
    localUser: { name: 'Owner', source: 'local' },
  };
});

async function call(method: string, path: string, body?: unknown, user?: string): Promise<{ status: number; body: any }> {
  const request: ApiRequest = { method, path, ...(body === undefined ? {} : { body }), ...(user === undefined ? {} : { user: { name: user, source: 'session' } }) };
  return await handleWorkbenchRequest(await withLoadedVersion(request, deps), deps) as { status: number; body: any };
}

const base = `/api/designs/${ID}/versions`;

describe('save version', () => {
  it('needs a note, takes the drawing revision first, then counts up', async () => {
    expect((await call('POST', base, { note: ' ' })).status).toBe(400);
    const first = await call('POST', base, { note: 'first release' });
    expect(first.status).toBe(201);
    expect(first.body.version).toMatchObject({ rev: 1, savedBy: 'Owner', note: 'first release', locked: true });
    expect(first.body.working).toMatchObject({ basedOnRev: 1, unreleased: false, nextRev: 2 });
    // nothing new to release
    expect((await call('POST', base, { note: 'again' })).status).toBe(409);
    const edited = { ...loadDesign(ID), label: 'changed' };
    deps.designs.write(ID, edited);
    expect(((await call('GET', base)).body as VersionListing).working.unreleased).toBe(true);
    const second = await call('POST', base, { note: 'renamed' });
    expect(second.body.version).toMatchObject({ rev: 2, basedOnRev: 1 });
    expect((await deps.drawings?.read(ID))?.meta.revision).toBe('2');
    const file = (await call('GET', `${base}/1`)).body as DesignVersionFile;
    expect(file.design.label).toBe(loadDesign(ID).label);
    expect(file.definitions.connectors.length).toBeGreaterThan(0);
  });

  it('hands back the drawing\'s fresh ETag exactly when this save rewrote it', async () => {
    // the first save's revision already matches the drawing's seeded one —
    // nothing to rewrite, so nothing for an open drawing form to catch up on
    const first = await call('POST', base, { note: 'first release' });
    expect(first.body.drawingTag).toBeUndefined();

    const edited = { ...loadDesign(ID), label: 'changed' };
    deps.designs.write(ID, edited);
    const second = await call('POST', base, { note: 'renamed' });
    expect(second.body.version).toMatchObject({ rev: 2 });
    // this save just bumped the drawing's `revision` behind whichever
    // browser has it open — the tag it hands back is exactly what that form
    // would see from a fresh GET, so its next save does not 409 over it
    const drawingNow = await deps.drawings?.read(ID);
    expect(drawingNow?.meta.revision).toBe('2');
    expect(second.body.drawingTag).toBe(contentETag(drawingNow));
  });

  it('the cable list carries the rev and the unreleased chip', async () => {
    await call('POST', base, { note: 'first release' });
    const row = ((await call('GET', '/api/designs')).body.designs as { id: string; rev?: number; unreleased?: boolean }[]).find((d) => d.id === ID);
    expect(row).toMatchObject({ rev: 1, unreleased: false });
  });
});

describe('locking', () => {
  it('a locked version refuses edits; unlock needs a reason; edit re-locks with history', async () => {
    await call('POST', base, { note: 'first release' });
    const design = { ...loadDesign(ID), notes: ['a note'] };
    expect((await call('PUT', `${base}/1`, { design })).status).toBe(409);
    expect((await call('POST', `${base}/1/unlock`, { reason: '' })).status).toBe(400);
    expect((await call('POST', `${base}/1/unlock`, { reason: 'typo on the sheet' }, 'Alex')).status).toBe(200);
    expect((await call('POST', `${base}/1/unlock`, { reason: 'again' })).status).toBe(409);
    const edited = await call('PUT', `${base}/1`, { design }, 'Alex');
    expect(edited.status).toBe(200);
    const file = edited.body as DesignVersionFile;
    expect(file.unlocked).toBeUndefined();
    expect(file.history.map((h) => [h.action, h.by])).toEqual([
      ['save', 'Owner'],
      ['unlock', 'Alex'],
      ['edit', 'Alex'],
    ]);
    expect(file.history[2]).toMatchObject({ note: 'typo on the sheet', changes: ['~ notes'] });
  });

  it('lock without an edit is recorded', async () => {
    await call('POST', base, { note: 'first release' });
    await call('POST', `${base}/1/unlock`, { reason: 'look' });
    const file = (await call('POST', `${base}/1/lock`)).body as DesignVersionFile;
    expect(file.history.map((h) => h.action)).toEqual(['save', 'unlock', 'relock']);
    expect((await call('POST', `${base}/1/lock`)).status).toBe(409);
  });
});

describe('new version from an old one', () => {
  it('replaces the working copy, keeps the displaced one as a draft, never touches the versions', async () => {
    await call('POST', base, { note: 'first release' });
    deps.designs.write(ID, { ...loadDesign(ID), label: 'rev 2 label' });
    await call('POST', base, { note: 'second' });
    deps.designs.write(ID, { ...loadDesign(ID), label: 'work in progress' });
    const before = JSON.stringify((await call('GET', `${base}/2`)).body);
    expect((await call('POST', `${base}/1/branch`, {})).status).toBe(400);
    const branched = await call('POST', `${base}/1/branch`, { confirm: 1 });
    expect(branched.status).toBe(200);
    expect(branched.body.keptDraft).toBe(1);
    expect((await deps.designs.read(ID))?.label).toBe(loadDesign(ID).label);
    expect(branched.body.working).toMatchObject({ basedOnRev: 1, unreleased: false, nextRev: 3 });
    expect(JSON.stringify((await call('GET', `${base}/2`)).body)).toBe(before);
    expect(branched.body.drafts).toMatchObject([{ n: 1, basedOnRev: 2 }]);

    const restored = await call('POST', `${base}/drafts/1/restore`, { confirm: 1 });
    expect(restored.status).toBe(200);
    expect((await deps.designs.read(ID))?.label).toBe('work in progress');
    expect(restored.body.working).toMatchObject({ basedOnRev: 2, unreleased: true });
    // the copy it displaced (identical to Rev 1) … was different from the draft, so it is kept
    expect(restored.body.drafts.map((d: { n: number }) => d.n)).toEqual([2]);
  });
});

describe('design lifecycle', () => {
  it('a design with saved versions cannot be deleted; rename moves its versions', async () => {
    await call('POST', base, { note: 'first release' });
    expect((await call('DELETE', `/api/designs/${ID}`, { confirm: ID })).status).toBe(409);
    expect((await call('POST', `/api/designs/${ID}/rename`, { newId: 'de9-crossover-renamed' })).status).toBe(200);
    const moved = (await call('GET', '/api/designs/de9-crossover-renamed/versions/1')).body as DesignVersionFile;
    expect(moved.designId).toBe('de9-crossover-renamed');
    expect(moved.design.id).toBe('de9-crossover-renamed');
  });

  it('refuses paths and numbers that are not ids', async () => {
    expect((await call('GET', '/api/designs/..%2Fx/versions')).status).toBe(400);
    expect((await call('GET', `${base}/abc`)).status).toBe(400);
    expect((await call('GET', `${base}/7`)).status).toBe(404);
  });
});

describe('the file store', () => {
  let dir: string;
  afterEach(async () => rmSync(dir, { recursive: true, force: true }));

  it('writes deterministic files, the working pointer and drafts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'versions-'));
    const store = fileVersionStore((id) => join(dir, id), undefined);
    deps.versions = store;
    await call('POST', base, { note: 'first release' });
    const text = readFileSync(join(dir, ID, '1.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ format: 'wirehub/design-version@2', rev: 1 });
    expect(readFileSync(join(dir, ID, 'working.json'), 'utf8')).toBe('{\n  "basedOnRev": 1\n}\n');
    expect(store.revisions(ID)).toEqual([1]);
  });

});
