/**
 * The board-import module on the file backend (cs-5k1.13, cs-5k1.12): every
 * importer as a job, planned and published; the KiCad board as a 3D model
 * source built by the model-cache job. The real file stores, over a temporary
 * copy of the starter catalog. `test/pg/board-import.server.test.ts` runs the
 * same scenario on Postgres and compares.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-boards-'));
const catalogPackage = fileURLToPath(new URL('../../../packages/catalog', import.meta.url));
cpSync(join(catalogPackage, 'data'), join(work, 'catalog', 'data'), { recursive: true });
cpSync(join(catalogPackage, 'depictions'), join(work, 'catalog', 'depictions'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'catalog', 'data');
process.env.MODEL_CACHE_DIR = join(work, 'model-cache');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.MODEL_CACHE_DIR;
  rmSync(work, { recursive: true, force: true });
});

const quiet = (): void => {};

export const EXPECTED_LOG = [
  'kicad-board: done',
  expect.stringMatching(/^kicad-board proposal: \{"definitions":\{"pcbas":\[\{"id":"synthetic-adapter-rev-2","label":"Synthetic adapter"\}\]\},"depictions":\["synthetic-adapter-rev-2"\],"designs":\[\],"existing":\[\],"existingDesigns":\[\],"notes":/),
  // the native board file is kept at import (content-addressed), for board outputs and enclosures
  expect.stringMatching(/^kicad-board plan: new data\/model-sources\/[0-9a-f]{64}\.kicad_pcb\.txt$/),
  'kicad-board plan: changed data/pcbas.json',
  'kicad-board plan: new depictions/synthetic-adapter-rev-2/board-bottom.svg svg=true',
  'kicad-board plan: new depictions/synthetic-adapter-rev-2/board-top.svg svg=true',
  'kicad-board plan: new depictions/synthetic-adapter-rev-2/meta.json',
  'kicad-board publish: 200 applied 5',
  'board: 200 terminals j1.1,j1.2,j1.3,A,B,GND,OUT,5V; links j1.1-A,j1.2-B,j1.3-GND,j1.1-j1.2(R1 120 Ω),j1.2-OUT(R2 1 kΩ → C1 100 nF)',
  'art after kicad: kicad',
  expect.stringMatching(/^gerbers preview: 200 \{"definitions":\{\},"depictions":\["synthetic-adapter-rev-2"\],/),
  'gerbers: done',
  expect.stringMatching(/^gerbers proposal: \{"definitions":\{\},"depictions":\["synthetic-adapter-rev-2"\],/),
  // a replaced SVG is a change, not a new file (cs-5k1.31)
  'gerbers plan: changed depictions/synthetic-adapter-rev-2/board-bottom.svg svg=true',
  'gerbers plan: changed depictions/synthetic-adapter-rev-2/board-top.svg svg=true',
  'gerbers plan: changed depictions/synthetic-adapter-rev-2/meta.json',
  'gerbers publish: 200 applied 3',
  'art after gerbers: gerber/gerber; anchor A {"x":5,"y":5,"side":"top","pads":[{"ref":"TP1","pad":"1","x":5,"y":5,"side":"top"}]}',
  'fab-bom: done',
  expect.stringMatching(/^fab-bom proposal: \{"boardParts":\["Synthetic adapter@2"\],"definitions":\{"components":\[/),
  'fab-bom plan: new data/board-parts.json',
  'fab-bom plan: changed data/components.json',
  'fab-bom publish: 200 applied 6',
  'board parts: Synthetic adapter 2 C1=capacitor-100nf-0603,C2=capacitor-100nf-0603,J1=connector-conn-01x03-pinheader-1x03-p2.54mm-vertical,R1=resistor-120r-0603,R2=resistor-1k-0603,U1=ic-xcvr-soic-8',
  'components: capacitor-100nf-0603,connector-conn-01x03-pinheader-1x03-p2.54mm-vertical,ic-xcvr-soic-8,resistor-120r-0603,resistor-1k-0603',
  'model upload: 200 kicad-board assembly@2a697f25 data/model-sources/<sha>.kicad_pcb.txt,depictions/synthetic-adapter-rev-2/board-bottom.svg,depictions/synthetic-adapter-rev-2/board-top.svg {"footprints":12,"libraryModels":1,"embeddedModels":0}',
  'model built before the job: false',
  'model-cache: built pcbas/synthetic-adapter-rev-2 failed []; library asked 2a697f25:kicad-packages3D/Resistor_SMD.3dshapes/R_0603_1608Metric.step; instances 1; art top true bottom true',
  'model built after the job: true',
];

describe('board import on the file backend', () => {
  it('imports a board, its art and its parts as jobs, and builds its 3D model from the same board file', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { boardImportRegistry, boardImportScenario } = await import('./board-import-scenario.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../server/jobs/handlers.ts');
    const deps = defaultWorkbenchDeps({ modules: boardImportRegistry });
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps }), quiet), kinds: ['import'] });
    const { log } = await boardImportScenario(deps);
    expect(log).toEqual(EXPECTED_LOG);
    const data = join(work, 'catalog', 'data');
    expect(JSON.parse(readFileSync(join(data, 'board-parts.json'), 'utf8')).boards).toHaveLength(1);
    expect(existsSync(join(work, 'catalog', 'depictions', 'synthetic-adapter-rev-2', 'board-top.svg'))).toBe(true);
    expect(readFileSync(join(work, 'catalog', 'depictions', 'synthetic-adapter-rev-2', 'board-top.svg'), 'utf8')).toContain('synthetic-adapter-rev-2-top-clip');
  }, 120_000);

  it('refuses a board file on a part that is not a board, and an unreadable one', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const deps = defaultWorkbenchDeps({});
    const data = Buffer.from('(kicad_pcb (version 1))').toString('base64');
    const connector = (await deps.loadDb()).connectors[0]!.id;
    const wrongKind = await handleWorkbenchRequest({ method: 'POST', path: `/api/models/connectors/${connector}/upload`, body: { name: 'x.kicad_pcb', data }, headers: { 'if-match': '*' } }, deps);
    expect(wrongKind.status).toBe(400);
    const pcba = (await deps.loadDb()).pcbas[0]!.id;
    const noOutline = await handleWorkbenchRequest({ method: 'POST', path: `/api/models/pcbas/${pcba}/upload`, body: { name: 'x.kicad_pcb', data }, headers: { 'if-match': '*' } }, deps);
    expect(noOutline.status).toBe(422);
    expect((noOutline.body as { error: string }).error).toMatch(/no closed board outline/);
  });

  it('accepts an import without a job: records and art in one change set', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { boardImportRegistry } = await import('./board-import-scenario.ts');
    const { kicadPcb } = await import('@wirehub/module-board-import/test/synthetic.ts');
    const deps = defaultWorkbenchDeps({ modules: boardImportRegistry });
    const body = { fileName: 'synthetic-adapter.kicad_pcb', base64: Buffer.from(kicadPcb()).toString('base64'), accept: true, options: { id: 'sync-adapter', partNumber: 'PCA-SYNC-1' } };
    const answer = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/board-import/_import/kicad-board', body }, deps);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as { proposal: { depictions: string[] } }).proposal.depictions).toEqual(['sync-adapter']);
    expect((await deps.loadDb()).pcbas.some((p) => p.id === 'sync-adapter')).toBe(true);
    expect(existsSync(join(work, 'catalog', 'depictions', 'sync-adapter', 'meta.json'))).toBe(true);
    // again: the board and its art are kept, nothing new to add
    const again = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/board-import/_import/kicad-board', body: { ...body, options: { id: 'sync-adapter', partNumber: 'PCA-SYNC-1', art: 'no' } } }, deps);
    expect(again.status).toBe(409);
  });

  it('keeps art anchors through an update that renames and removes terminals', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { boardImportRegistry } = await import('./board-import-scenario.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../server/jobs/handlers.ts');
    const { BOARD_SET_FORMAT, writeZip } = await import('@wirehub/module-board-import');
    const { gerberFiles, kicadPcb } = await import('@wirehub/module-board-import/test/synthetic.ts');
    const deps = defaultWorkbenchDeps({ modules: boardImportRegistry });
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps }), quiet), kinds: ['import'] });
    const b64 = (v: string | Uint8Array): string => Buffer.from(v).toString('base64');
    const run = async (importer: string, fileName: string, base64: string, options: Record<string, string>): Promise<{ skipped?: string[] }> => {
      const started = await handleWorkbenchRequest({ method: 'POST', path: `/api/modules/board-import/_import/${importer}`, body: { fileName, base64, job: true, options } }, deps);
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      const done = await deps.jobs!.wait((started.body as { job: { id: string } }).job.id, 60_000);
      expect(done.status, done.error).toBe('done');
      expect((await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${done.id}/publish` }, deps)).status).toBe(200);
      return (done.result as { proposal: { skipped?: string[] } }).proposal;
    };
    const set = (text: string): string => b64(JSON.stringify({ format: BOARD_SET_FORMAT, version: 1, board: { fileName: 'synthetic-adapter.kicad_pcb', base64: b64(text) } }));
    // TP1 renamed (A → <name>, same pad), TP6 (5V) taken off the board
    const edited = (name: string): string => {
      const lines = kicadPcb().replaceAll('"Value" "A"', `"Value" "${name}"`).replaceAll('"/A"', `"/${name}"`).split('\n');
      const at = lines.findIndex((l) => l.includes('"Reference" "TP6"'));
      const end = lines.findIndex((l, i) => i > at && l === '\t)');
      return [...lines.slice(0, at - 1), ...lines.slice(end + 1)].join('\n');
    };
    const anchors = async (): Promise<string[]> => Object.keys(JSON.parse(readFileSync(join(work, 'catalog', 'depictions', 'upd-adapter', 'meta.json'), 'utf8')).pinAnchors).sort();
    await run('board-set', 'a.board-set.json', set(kicadPcb()), { id: 'upd-adapter', label: 'Update adapter', partNumber: 'PCA-UPD-1' });
    expect(await anchors()).toContain('A');

    // kicad-tier art is redrawn from the file: checked against the updated terminals, not the old ones
    expect((await run('board-set', 'b.board-set.json', set(edited('DATA_A')), { update: 'upd-adapter' })).skipped).toBeUndefined();
    expect(await anchors()).toEqual(expect.arrayContaining(['DATA_A', 'B', 'GND', 'j1.1']));
    expect(await anchors()).not.toContain('5V');

    // Gerber art is kept: its anchors follow the rename
    await run('gerbers', 'fab.zip', b64(writeZip(gerberFiles().map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.text) })))), { board: 'upd-adapter' });
    const before = await anchors();
    expect((await run('board-set', 'c.board-set.json', set(edited('LINE_A')), { update: 'upd-adapter' })).skipped).toBeUndefined();
    expect(await anchors()).toEqual(before.map((id) => (id === 'DATA_A' ? 'LINE_A' : id)).sort());
  }, 120_000);

  it('refuses malformed import options', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { boardImportRegistry } = await import('./board-import-scenario.ts');
    const deps = defaultWorkbenchDeps({ modules: boardImportRegistry });
    const answer = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/board-import/_import/kicad-board', body: { fileName: 'a.kicad_pcb', base64: 'AA==', options: { revision: 2 } } }, deps);
    expect(answer.status).toBe(400);
    expect((answer.body as { error: string }).error).toBe("Option 'revision' must be text.");
  });
});
