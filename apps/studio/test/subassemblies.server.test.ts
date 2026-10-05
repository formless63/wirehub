/**
 * Sub-assemblies over the workbench API: validation against the designs a
 * cable places, the library route, where used, refused deletes and renames,
 * a saved version freezing its sub-assemblies, documents and exports — memory
 * stores, no disk.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign, DesignVersionFile } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type ApiResponse, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore } from '../server/drawings.ts';
import { contentETag } from '../server/etag.ts';
import { memoryVersionStore, type VersionListing } from '../server/versions.ts';
import { withLoadedVersion } from './loaded-version.ts';

const db = loadDb();
const LEAD = 'dc-pigtail-lead';
const Y = 'dc-y-from-leads';

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

beforeEach(() => {
  clock = 0;
  deps = {
    designs: memoryDesigns([loadDesign(LEAD), loadDesign(Y), loadDesign('dc-led-lead')]),
    loadDb: () => db,
    drawings: memoryDrawingStore(),
    versions: memoryVersionStore(),
    now: () => `2026-10-05T10:00:0${clock++}.000Z`,
    localUser: { name: 'Owner', source: 'local' },
  };
});

async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse & { body: any }> {
  const request: ApiRequest = { method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) };
  return (await handleWorkbenchRequest(await withLoadedVersion(request, deps), deps)) as ApiResponse & { body: any };
}

const text = (r: ApiResponse): string => new TextDecoder().decode(r.bytes);

async function put(design: CableDesign): Promise<ApiResponse & { body: any }> {
  const current = await deps.designs.read(design.id);
  return await call('PUT', `/api/designs/${design.id}`, design, { 'if-match': contentETag(current) });
}

describe('validation', () => {
  it('checks a save against the designs it places', async () => {
    const y = loadDesign(Y);
    y.joints.push({ a: { instance: 'j1', terminal: '3' }, b: { instance: 'lead-1', terminal: 'w1@a:red' } });
    const refused = await put(y);
    expect(refused.status).toBe(422);
    expect(refused.body.issues.map((i: { code: string }) => i.code)).toContain('subassembly-unknown-port');

    const ok = loadDesign(Y);
    ok.label = 'Y, renamed';
    expect((await put(ok)).status).toBe(200);
  });

  it('refuses a cycle and a missing design', async () => {
    const lead = loadDesign(LEAD);
    lead.instances.subassemblies = [{ id: 'back', def: Y }];
    const cycle = await put(lead);
    expect(cycle.status).toBe(422);
    expect(cycle.body.issues.map((i: { code: string }) => i.code)).toContain('subassembly-cycle');

    const y = loadDesign(Y);
    y.instances.subassemblies![1]!.def = 'no-such-cable';
    expect((await put(y)).body.issues.map((i: { code: string }) => i.code)).toContain('subassembly-unknown-design');
  });

  it('stores a design that gains its first sub-assembly at schema v5', async () => {
    const led = loadDesign('dc-led-lead');
    led.instances.subassemblies = [{ id: 'extra', def: LEAD }];
    const saved = await put(led);
    expect(saved.status).toBe(200);
    expect(saved.body.schemaVersion).toBe(5);
  });
});

describe('the library and where used', () => {
  it('serves the designs a cable places, transitively, with their versions', async () => {
    expect((await call('POST', `/api/designs/${LEAD}/versions`, { note: 'first' })).status).toBe(201);
    const library = await call('GET', `/api/assemblies?designs=${Y}`);
    expect(library.status).toBe(200);
    expect(library.body.working.map((d: CableDesign) => d.id)).toEqual([Y, LEAD]);
    expect(library.body.versions).toEqual([expect.objectContaining({ designId: LEAD, rev: 0, released: true })]);
    expect((await call('GET', '/api/assemblies?designs=../etc')).status).toBe(400);
  });

  it('answers where a design is used, and lists it in the cable list', async () => {
    const used = await call('GET', `/api/designs/${LEAD}/used-in`);
    expect(used.body.designs).toEqual([{ id: Y, label: loadDesign(Y).label, instances: ['lead-1', 'lead-2'] }]);
    expect((await call('GET', '/api/designs/no-such/used-in')).status).toBe(404);
    const list = (await call('GET', '/api/designs')).body.designs as { id: string; features: { text: string }[] }[];
    expect(list.find((d) => d.id === LEAD)!.features.map((f) => f.text)).toContain('used in 1');
    expect(list.find((d) => d.id === Y)!.features.map((f) => f.text)).toContain('+ 2 sub-assemblies');
  });

  it('refuses to delete or rename a design placed as a sub-assembly, naming the parents', async () => {
    const del = await call('DELETE', `/api/designs/${LEAD}`, { confirm: LEAD });
    expect(del.status).toBe(409);
    expect(del.body.error).toContain(Y);
    const current = await deps.designs.read(LEAD);
    const rename = await call('POST', `/api/designs/${LEAD}/rename`, { newId: 'other-lead' }, { 'if-match': contentETag(current) });
    expect(rename.status).toBe(409);
    expect(await deps.designs.has(LEAD)).toBe(true);
    // the parent itself goes freely
    expect((await call('DELETE', `/api/designs/${Y}`, { confirm: Y })).status).toBe(200);
    expect((await call('DELETE', `/api/designs/${LEAD}`, { confirm: LEAD })).status).toBe(200);
  });
});

describe('versions', () => {
  it('refuses to save a version standing on a sub-assembly with nothing released', async () => {
    const refused = await call('POST', `/api/designs/${Y}/versions`, { note: 'first' });
    expect(refused.status).toBe(422);
    expect(refused.body.issues.map((i: { code: string }) => i.code)).toEqual(['subassembly-not-released', 'subassembly-not-released']);
  });

  it('freezes each sub-assembly to its released revision, and the working copy stays released', async () => {
    expect((await call('POST', `/api/designs/${LEAD}/versions`, { note: 'lead released' })).status).toBe(201);
    const saved = await call('POST', `/api/designs/${Y}/versions`, { note: 'Y released' });
    expect(saved.status).toBe(201);
    const file = (await deps.versions!.read(Y, saved.body.version.rev)) as DesignVersionFile;
    expect(file.design.instances.subassemblies!.map((s) => s.rev)).toEqual([0, 0]);
    // the working copy still follows the lead's working copy, and is not "unreleased" for the pins alone
    expect((await deps.designs.read(Y))!.instances.subassemblies!.map((s) => s.rev)).toEqual([undefined, undefined]);
    expect(((await call('GET', `/api/designs/${Y}/versions`)).body as VersionListing).working.unreleased).toBe(false);
    // a saved version pinning the lead also counts as a use
    const used = await call('GET', `/api/designs/${LEAD}/used-in`);
    expect(used.body.versions).toEqual([{ design: Y, rev: saved.body.version.rev, instances: ['lead-1', 'lead-2'], pinned: 0 }]);
    // the revision renders with the designs it pins
    const bom = await call('GET', `/api/designs/${Y}/exports/bom.csv?rev=${saved.body.version.rev}`);
    expect(text(bom)).toContain('Sub-assemblies');
    expect(text(bom)).toContain('Rev 0');
  });
});

describe('documents and exports', () => {
  it('list each sub-assembly as one line, explode on request, and test the flattened nets', async () => {
    const bom = text(await call('GET', `/api/designs/${Y}/exports/bom.csv`));
    expect(bom.split('\n').filter((l) => l.startsWith('Sub-assemblies'))).toHaveLength(2);
    const exploded = text(await call('GET', `/api/designs/${Y}/exports/bom.csv?explode=1`));
    expect(exploded).not.toContain('Sub-assemblies');
    expect(exploded).toContain('lead-1/j1 lead-2/j1');
    const continuity = text(await call('GET', `/api/designs/${Y}/exports/continuity.csv`));
    expect(continuity).toContain('net-pin,net/net-1/lead-1/j1.1');
    const sheet = text(await call('GET', `/api/designs/${Y}/documents/build-sheet?format=html`));
    expect(sheet).toContain('build to the build sheet of dc-pigtail-lead');
    const bomSheet = text(await call('GET', `/api/designs/${Y}/documents/bom?format=html&explode=1`));
    expect(bomSheet).not.toContain('data-section="subassemblies"');
  });
});
