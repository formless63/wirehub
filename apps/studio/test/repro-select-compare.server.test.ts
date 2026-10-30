import { describe, expect, it } from 'vitest';
import type { WorkbenchDeps } from '../server/api.ts';
import { handleReproRequest } from '../server/repro/api.ts';
import type { ToolOutputStore, ToolRunRecord } from '../server/tools/outputs.ts';

const makeRun = (n: number, extra: Partial<ToolRunRecord> = {}): ToolRunRecord => ({
  id: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, record: 'pcbas/synthetic-board',
  identity: { revision: `Rev ${n}` }, sources: [], pack: 'kicad', packVersion: '1', image: 'kicad:1',
  imageId: `sha256:${'a'.repeat(64)}`, tool: { name: 'KiCad', version: '10' }, op: 'fab', params: {},
  status: 'ok', findings: [], outputs: [], createdAt: `2026-10-${String(n).padStart(2, '0')}T12:00:00Z`, ...extra,
});
describe('choosing runs for comparison', () => {
  const runs = [makeRun(1), makeRun(2), makeRun(3, { op: 'board-3d' }), makeRun(4, { record: 'pcbas/other' })];
  const outputs: ToolOutputStore = {
    run: async (id) => runs.find((r) => r.id === id),
    runs: async (record) => runs.filter((r) => r.record === record),
    file: () => undefined, log: async () => '', register: async () => { throw new Error('Read only'); },
  };
  const deps = { toolOutputs: outputs } as WorkbenchDeps;
  const get = (suffix = '') => handleReproRequest({ method: 'GET', path: `/api/repro/runs/${runs[1]!.id}${suffix}` }, deps);
  it('offers another revision without requiring a rerun job', async () => {
    const page = await get();
    expect(page.status).toBe(200);
    expect((page.body as { comparisons: unknown[] }).comparisons).toEqual([expect.objectContaining({ id: runs[0]!.id, identity: { revision: 'Rev 1' } })]);
    const comparison = await get(`/compare?with=${runs[0]!.id}`);
    expect(comparison.status).toBe(200);
    expect(comparison.body).toMatchObject({ a: { id: runs[0]!.id }, b: { id: runs[1]!.id } });
  });
  it('refuses unrelated items, other operations and invalid identifiers', async () => {
    for (const id of [runs[2]!.id, runs[3]!.id, 'invalid']) expect((await get(`/compare?with=${id}`)).status).toBe(400);
    expect((await get(`/compare?with=${makeRun(5).id}`)).status).toBe(404);
  });
});
