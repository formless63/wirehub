/**
 * A board's Gerber art on its 3D model (cs-5k1.29): the art is among the
 * model link's files, so it is part of the cache key; the real conversion
 * (in the memory-capped child) paints it on the board body as textures; and
 * importing the Gerbers after the model was linked re-keys the link.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-board-art-'));
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

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array | string): string => Buffer.from(typeof bytes === 'string' ? enc.encode(bytes) : bytes).toString('base64');

describe('board art on the 3D model', () => {
  it('paints the art as textures through the real conversion, and re-keys the link when the art arrives', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { boardImportRegistry, BOARD_ID } = await import('./board-import-scenario.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../server/jobs/handlers.ts');
    const { runModelCacheJob } = await import('../server/jobs/model-cache.ts');
    const { readGlbJson } = await import('../server/models/glb.ts');
    const { writeZip } = await import('@wirehub/module-board-import');
    const { gerberFiles, kicadPcb } = await import('@wirehub/module-board-import/test/synthetic.ts');
    const deps = defaultWorkbenchDeps({ modules: boardImportRegistry });
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps }), () => {}), kinds: ['import'] });
    const user = { name: 'Board Person', email: 'boards@example.com', source: 'session' as const };
    const run = async (importer: string, fileName: string, base64: string, options?: Record<string, string>): Promise<void> => {
      const started = await handleWorkbenchRequest({ method: 'POST', path: `/api/modules/board-import/_import/${importer}`, body: { fileName, base64, job: true, ...(options === undefined ? {} : { options }) }, user }, deps);
      const id = (started.body as { job: { id: string } }).job.id;
      expect((await deps.jobs!.wait(id, 60_000)).status).toBe('done');
      const published = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${id}/publish`, user }, deps);
      expect(published.status, JSON.stringify(published.body)).toBe(200);
    };

    // the board and its model first: kicad-tier art only, so nothing is painted
    await run('kicad-board', 'synthetic-adapter.kicad_pcb', b64(kicadPcb()));
    const upload = await handleWorkbenchRequest({ method: 'POST', path: `/api/models/pcbas/${BOARD_ID}/upload`, body: { name: 'synthetic-adapter.kicad_pcb', data: b64(kicadPcb()) }, headers: { 'if-match': '*' }, user }, deps);
    const first = (upload.body as { link: { asset: string; files: { path: string }[] } }).link;
    expect(first.files.map((f) => f.path.startsWith('depictions/'))).toEqual([false]);

    // then the Gerbers: the link is re-keyed with the art among its files
    const zip = writeZip(gerberFiles().map((f) => ({ path: f.path, bytes: enc.encode(f.text) })));
    await run('gerbers', 'fab.zip', b64(zip), { board: BOARD_ID });
    const link = await deps.modelLinks!.get(`pcbas/${BOARD_ID}`);
    expect(link!.asset).not.toBe(first.asset);
    expect(link!.files!.map((f) => f.path).filter((p) => p.startsWith('depictions/'))).toEqual([`depictions/${BOARD_ID}/board-bottom.svg`, `depictions/${BOARD_ID}/board-top.svg`]);

    // the job builds it for real (a board with no footprint model: the slab alone) and the board body carries two textures
    const job = { id: '00000000-0000-4000-8000-000000000002', kind: 'model-cache', status: 'running', request: {}, steps: [], createdAt: '2026-01-01T00:00:00Z' } as never;
    const outcome = await runModelCacheJob({ job, step: async () => {} }, { deps, library: () => async () => undefined });
    const result = outcome.result as { built: { record: string; peakRssMb?: number }[]; failed: unknown[] };
    expect(result.failed).toEqual([]);
    expect(result.built.map((b) => b.record)).toContain(`pcbas/${BOARD_ID}`);
    const glb = new Uint8Array((await deps.modelCache!.get(link!.asset))!);
    const json = readGlbJson(glb)!;
    expect((json['images'] as unknown[]).length).toBe(2);
    expect((json['textures'] as unknown[]).length).toBe(2);
    expect(JSON.stringify(json['extras'] ?? {})).not.toContain('boardArtError');
  }, 180_000);
});
