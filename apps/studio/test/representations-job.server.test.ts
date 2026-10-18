/** Native intake → job → publish → cover → cable views, over isolated real file stores. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDepictionMeta } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { boardImport } from '@wirehub/module-board-import';
import { boardArt, deriveFlow } from '@wirehub/editor-react';
import { layoutSchematic, type DepictionSource } from '@wirehub/layout';
import { renderSchematic } from '@wirehub/render-svg';
import { validateDesign, type CableDesign } from '@wirehub/model';
import { afterAll, expect, it } from 'vitest';
import { handleWorkbenchRequest } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { resolveCover, type RepresentationView } from '../src/representations.ts';
import { representationFixture } from './representation-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'wirehub-native-cover-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(root, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(root, 'data');
process.env.WIREHUB_PACKS_DIR = join(root, 'packs');
process.env.AUTH_DATA_DIR = join(root, 'auth');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  delete process.env.AUTH_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

it('publishes actual native-derived artwork and keeps both occurrences/board faces after changing the cover', async () => {
  const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
  const deps = defaultWorkbenchDeps({ modules: createRegistry([boardImport]) });
  const store = memoryJobStore();
  deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'] });
  const { native, board, sourceHash } = await representationFixture();
  const started = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/board-import/_import/kicad-board',
    body: { fileName: 'synthetic-adapter.kicad_pcb', base64: Buffer.from(native).toString('base64'), job: true } }, deps);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as { job: { id: string } }).job.id;
  const done = await deps.jobs.wait(id, 15_000);
  expect(done.status, done.error).toBe('done');
  expect(done.steps.length).toBeGreaterThan(0);
  expect(JSON.stringify(done.request)).toContain(sourceHash);
  const published = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${id}/publish` }, deps);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const path = `/api/representations/pcbas/${board.id}`;
  const initial = await handleWorkbenchRequest({ method: 'GET', path }, deps);
  const bottom = (initial.body as RepresentationView).candidates[1]!;
  expect(bottom.asset).toBeTruthy();
  const saved = await handleWorkbenchRequest({ method: 'PUT', path, body: { choice: { view: bottom.view, lineage: bottom.lineage } }, headers: { 'if-match': initial.headers!.ETag! } }, deps);
  expect(resolveCover(saved.body as RepresentationView)).toMatchObject({ state: 'chosen', selected: { view: 'board-bottom' } });
  const blob = await handleWorkbenchRequest({ method: 'GET', path: `/api/blobs/${bottom.asset}` }, deps);
  expect(blob.status).toBe(200);
  const parsed = parseDepictionMeta(await deps.depictions!.readMeta(board.id), 'native board');
  expect(parsed.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  const art = Object.fromEntries(await Promise.all(['board-top', 'board-bottom'].map(async (side) => [side, new TextDecoder().decode(await deps.depictions!.readAsset(board.id, `${side}.svg`))])));
  const depictions: DepictionSource = {
    meta: (defId) => defId === board.id ? parsed.meta : undefined,
    artwork: (defId, view) => defId !== board.id || art[view] === undefined ? undefined : { kind: 'vector', source: art[view] },
  };
  const terminals = board.terminals.map((t) => t.id);
  const a = boardArt({ instanceId: 'board-a', defId: board.id, terminals, cableFacing: 'right', depictions });
  const b = boardArt({ instanceId: 'board-b', defId: board.id, terminals, cableFacing: 'left', depictions });
  expect(a?.views.map((v) => v.side)).toEqual(['top', 'bottom']);
  expect(b?.views.map((v) => v.side)).toEqual(['top', 'bottom']);
  expect(a!.handles.every((h) => h.id.startsWith('board-a:'))).toBe(true);
  expect(b!.handles.every((h) => h.id.startsWith('board-b:'))).toBe(true);
  const design: CableDesign = {
    schemaVersion: 4, id: 'native-board-cable', label: 'Synthetic native board cable — no 3D models attached', src: 'synthetic example',
    instances: { connectors: [], components: [], pcbas: [{ id: 'board-a', def: board.id }, { id: 'board-b', def: board.id }],
      segments: [{ id: 'wire', def: 'dc-2core-24awg', lengthMm: 300 }] },
    joints: [
      { a: { instance: 'board-a', terminal: 'A' }, b: { instance: 'wire', terminal: 'red', end: 'a' } },
      { a: { instance: 'board-b', terminal: 'A' }, b: { instance: 'wire', terminal: 'red', end: 'b' } },
      { a: { instance: 'board-a', terminal: 'GND' }, b: { instance: 'wire', terminal: 'black', end: 'a' } },
      { a: { instance: 'board-b', terminal: 'GND' }, b: { instance: 'wire', terminal: 'black', end: 'b' } },
    ],
  };
  const db = await deps.loadDb();
  expect(validateDesign(design, db).filter((issue) => issue.severity === 'error')).toEqual([]);
  const savedDesign = await handleWorkbenchRequest({ method: 'POST', path: '/api/designs', body: design }, deps);
  expect(savedDesign.status, JSON.stringify(savedDesign.body)).toBe(201);
  const readDesign = await handleWorkbenchRequest({ method: 'GET', path: `/api/designs/${design.id}` }, deps);
  expect(readDesign.status).toBe(200);
  const persisted = readDesign.body as CableDesign;
  expect(persisted.instances.pcbas).toEqual(design.instances.pcbas);
  const flow = deriveFlow(persisted, db, { depictions });
  expect(flow.nodes.flatMap((node) => node.data.kind === 'pcba' ? [node.data.board?.defId] : [])).toEqual([board.id, board.id]);
  // The simplified document renderer resolves the same native board and mirror frame.
  const diagram = layoutSchematic(persisted, db, { depictions });
  expect(diagram.blocks.filter((block) => block.kind === 'pcba').map((block) => block.depiction?.faces?.map((face) => face.view))).toEqual([
    ['board-top', 'board-bottom'], ['board-top', 'board-bottom'],
  ]);
  const svg = renderSchematic(persisted, db, { depictions });
  expect(svg).toContain('board-top');
  expect(svg).toContain('board-bottom');
}, 30_000);
