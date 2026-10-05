/**
 * The board-import module end to end through the API, as jobs (cs-5k1.13,
 * cs-5k1.12): a synthetic board's `.kicad_pcb` becomes a PCBA with art, its
 * Gerber set replaces that art, its BOM and placement add components and the
 * board's placed parts, and the same `.kicad_pcb` uploaded as the board's
 * model source is built by the model-cache job with the KiCad library model
 * it names (served from a stand-in library here: nothing is fetched). Run on
 * the file backend and on Postgres; the logs and exported catalogs must agree.
 */

import { BOARD_BOM_FORMAT, boardImport, writeZip } from '@wirehub/module-board-import';
import { BOM_CSV, CPL_CSV, gerberFiles, kicadPcb } from '@wirehub/module-board-import/test/synthetic.ts';
import { createRegistry } from '@wirehub/modules';
import { expect } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { CatalogExport } from '../server/pg/export.ts';
import type { StudioUser } from '../server/me.ts';
import { runModelCacheJob } from '../server/jobs/model-cache.ts';
import type { Converter } from '../server/models/build.ts';
import type { JobRun } from '../server/jobs/types.ts';

export const boardImportRegistry = createRegistry([boardImport]);

const USER: StudioUser = { name: 'Board Person', email: 'boards@example.com', source: 'session' };
const enc = new TextEncoder();
const b64 = (text: string | Uint8Array): string => Buffer.from(typeof text === 'string' ? enc.encode(text) : text).toString('base64');
export const BOARD_ID = 'synthetic-adapter-rev-2';

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

export interface BoardScenarioResult {
  log: string[];
  exported: CatalogExport;
}

async function runImport(deps: WorkbenchDeps, log: string[], importer: string, fileName: string, base64: string, options?: Record<string, string>): Promise<void> {
  const started = await handleWorkbenchRequest({ method: 'POST', path: `/api/modules/board-import/_import/${importer}`, body: { fileName, base64, job: true, ...(options === undefined ? {} : { options }) }, user: USER }, deps);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as { job: { id: string } }).job.id;
  const done = await deps.jobs!.wait(id, 60_000);
  log.push(`${importer}: ${done.status}${done.error === undefined ? '' : ` ${done.error}`}`);
  const got = await handleWorkbenchRequest({ method: 'GET', path: `/api/jobs/${id}`, user: USER }, deps);
  const body = got.body as { job: { result: Record<string, unknown> }; files: { path: string; status: string; content?: string }[] };
  log.push(`${importer} proposal: ${sortedJson(body.job.result['proposal'])}`);
  for (const f of body.files) log.push(`${importer} plan: ${f.status} ${f.path}${f.path.endsWith('.svg') ? ` svg=${String(f.content?.startsWith('<svg'))}` : ''}`);
  const published = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${id}/publish`, user: USER }, deps);
  log.push(`${importer} publish: ${published.status} applied ${String((published.body as { applied?: number }).applied)}`);
}

export async function boardImportScenario(deps: WorkbenchDeps): Promise<BoardScenarioResult> {
  const log: string[] = [];
  // 1. the board file → a PCBA and kicad-tier art
  await runImport(deps, log, 'kicad-board', 'synthetic-adapter.kicad_pcb', b64(kicadPcb()));
  const board = await handleWorkbenchRequest({ method: 'GET', path: `/api/definitions/pcbas/${BOARD_ID}` }, deps);
  const pcba = (board.body as { record?: { terminals: { id: string }[]; internalLinks: { from: string; to: string; via?: string }[] } }).record ?? (board.body as never);
  log.push(`board: ${board.status} terminals ${pcba.terminals.map((t) => t.id).join(',')}; links ${pcba.internalLinks.map((l) => `${l.from}-${l.to}${l.via === undefined ? '' : `(${l.via})`}`).join(',')}`);
  let exported = await deps.exportCatalog!();
  log.push(`art after kicad: ${JSON.parse(exported.files[`depictions/${BOARD_ID}/meta.json`] ?? '{}').views?.['board-top']?.sourceKind}`);

  // a preview without a job answers the proposal and writes nothing
  const zip = writeZip(gerberFiles().map((f) => ({ path: f.path, bytes: enc.encode(f.text) })));
  const preview = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/board-import/_import/gerbers', body: { fileName: 'fab.zip', base64: b64(zip) }, user: USER }, deps);
  log.push(`gerbers preview: ${preview.status} ${sortedJson((preview.body as { proposal: unknown }).proposal)}`);

  // 2. the Gerber set → gerber-tier art over the kicad tier
  await runImport(deps, log, 'gerbers', 'fab.zip', b64(zip), { board: BOARD_ID });
  exported = await deps.exportCatalog!();
  const meta = JSON.parse(exported.files[`depictions/${BOARD_ID}/meta.json`] ?? '{}') as { views: Record<string, { sourceKind: string }>; pinAnchors: Record<string, { x: number; y: number }> };
  log.push(`art after gerbers: ${meta.views['board-top']?.sourceKind}/${meta.views['board-bottom']?.sourceKind}; anchor A ${JSON.stringify(meta.pinAnchors['A'])}`);

  // 3. BOM and placement → components and placed parts, with a column mapping
  const bundle = { format: BOARD_BOM_FORMAT, version: 1, bom: { fileName: 'bom.csv', text: BOM_CSV }, cpl: { fileName: 'cpl.csv', text: CPL_CSV } };
  await runImport(deps, log, 'fab-bom', 'synthetic.board-bom.json', b64(JSON.stringify(bundle)), { board: BOARD_ID, mapping: JSON.stringify({ cpl: { side: 'Layer' } }) });
  const db = await deps.loadDb();
  const entry = db.boardParts?.find((e) => e.revision === '2');
  log.push(`board parts: ${entry?.board} ${entry?.revision} ${entry?.parts.map((p) => `${p.ref}=${p.component}`).join(',')}`);
  log.push(`components: ${db.components.filter((c) => c.review?.includes('Synthetic adapter') === true).map((c) => c.id).join(',')}`);

  // 4. the board file as the board's 3D model source, built by the model-cache job
  const upload = await handleWorkbenchRequest({ method: 'POST', path: `/api/models/pcbas/${BOARD_ID}/upload`, body: { name: 'synthetic-adapter.kicad_pcb', data: b64(kicadPcb()) }, headers: { 'if-match': '*' }, user: USER }, deps);
  const link = (upload.body as { link: { asset: string; sourceKind: string; files: { path: string }[]; build: { kind: string; library?: string } }; board: unknown }).link;
  log.push(`model upload: ${upload.status} ${link.sourceKind} ${link.build.kind}@${link.build.library?.slice(0, 8)} ${link.files.map((f) => f.path.replace(/[0-9a-f]{64}/, '<sha>')).join(',')} ${JSON.stringify((upload.body as { board: unknown }).board)}`);
  const before = await handleWorkbenchRequest({ method: 'GET', path: `/api/models/pcbas/${BOARD_ID}` }, deps);
  log.push(`model built before the job: ${String((before.body as { built?: boolean }).built)}`);
  const asked: string[] = [];
  const planned: number[] = [];
  const painted: string[] = [];
  const convert: Converter = {
    model: async () => {
      throw new Error('not used');
    },
    files: async () => {
      throw new Error('not used');
    },
    assembly: async (plan, _name, options) => {
      planned.push(plan.instances.length);
      painted.push(options?.boardArt === undefined ? 'no art' : `art top ${options.boardArt.top.startsWith('<svg')} bottom ${options.boardArt.bottom.startsWith('<svg')}`);
      return { glb: enc.encode(`glb with ${plan.models.length} model(s)`), format: 'glb', stats: { triangles: 12 } } as never;
    },
  };
  const job = { id: '00000000-0000-4000-8000-000000000001', kind: 'model-cache', status: 'running', request: { reason: 'requested' }, steps: [], createdAt: '2026-01-01T00:00:00Z' } as unknown as JobRun;
  const outcome = await runModelCacheJob(
    { job, step: async () => {} },
    {
      deps,
      convert,
      library: (commit) => async (path) => {
        asked.push(`${commit.slice(0, 8)}:${path}`);
        return path.endsWith('R_0603_1608Metric.step') ? enc.encode('ISO-10303-21; stand-in') : undefined;
      },
    },
  );
  const result = outcome.result as { built: { record: string }[]; failed: unknown[] };
  log.push(`model-cache: built ${result.built.map((b) => b.record).join(',')} failed ${JSON.stringify(result.failed)}; library asked ${asked.join(',')}; instances ${planned.join(',')}; ${painted.join(',')}`);
  log.push(`model built after the job: ${String(await deps.modelCache!.has(link.asset))}`);
  return { log, exported: await deps.exportCatalog!() };
}
