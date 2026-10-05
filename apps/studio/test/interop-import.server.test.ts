/**
 * The bundled interop modules end to end through the API (cs-5k1.18, cs-5k1.19):
 * a CSV of components and a WireViz harness each run as an import job, are
 * reviewed (the plan), publish as one change set, and read back; the WireViz
 * exporter renders a stored design.
 */

import { join } from 'node:path';

import { csvLibrary, templateCsv } from '@wirehub/module-csv-library';
import { wireviz } from '@wirehub/module-wireviz';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const registry = createRegistry([wireviz, csvLibrary]);
const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');

function serve() {
  const deps = memoryWriteBackend(registry, join(DATA, '..')).deps;
  const store = memoryJobStore();
  deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'], pollMs: 20 });
  return deps;
}

const run = async (deps: ReturnType<typeof serve>, module: string, importer: string, fileName: string, text: string) => {
  const started = await handleWorkbenchRequest({ method: 'POST', path: `/api/modules/${module}/_import/${importer}`, body: { fileName, base64: Buffer.from(text).toString('base64'), job: true }, user: { name: 'Ada', source: 'session' } }, deps);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as { job: { id: string } }).job.id;
  await deps.jobs!.wait(id, 20_000);
  const got = await handleWorkbenchRequest({ method: 'GET', path: `/api/jobs/${id}` }, deps);
  return { id, job: (got.body as { job: { status: string; result: { proposal: { definitions: Record<string, { id: string }[]>; designs: { id: string }[]; existing: string[]; notes: string[] }; notes: string[] } } }).job };
};

describe('bulk CSV through the import job', () => {
  it('plans the valid rows, lists the invalid ones, and publishes one change set with src and prices', async () => {
    const deps = serve();
    const csv = ['type,id,label,kind,value,src,unit_cost,currency', 'component,r-test-1,Test resistor,resistor,1 kΩ,s1,0.01,USD', 'component,r-test-2,No source,resistor,2 kΩ,,,'].join('\r\n');
    const { id, job } = await run(deps, 'csv-library', 'library-csv', 'parts.csv', csv);
    expect(job.status).toBe('done');
    expect(job.result.proposal.definitions['components']?.map((r) => r.id)).toEqual(['r-test-1']);
    expect(job.result.notes.join('\n')).toContain('line 3 (r-test-2) was not imported: no source');
    // nothing is in the catalog before Publish
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/r-test-1' }, deps)).status).toBe(404);
    const published = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${id}/publish`, user: { name: 'Ada', source: 'session' } }, deps);
    expect(published.status).toBe(200);
    const got = await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/r-test-1' }, deps);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: 'r-test-1', src: 's1', cost: { unit: 0.01, currency: 'USD' } });
  }, 30_000);
});

const HARNESS = `metadata:
  title: Bench lead
connectors:
  X1: {type: Header, pincount: 2}
  X2: {type: Header, pincount: 2}
cables:
  W1: {wirecount: 2, colors: [RD, BK], gauge: 0.25 mm2, length: 0.3}
connections:
  - [{X1: [1, 2]}, {W1: [1, 2]}, {X2: [1, 2]}]
`;

describe('costing fields survive the API', () => {
  it('keeps a design\'s labour minutes and a price with breaks on a definition', async () => {
    const deps = serve();
    const design = (await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/de9-crossover' }, deps)).body as Record<string, unknown>;
    const saved = await handleWorkbenchRequest({ method: 'POST', path: '/api/designs', body: { ...design, id: 'de9-crossover-labour', labourMinutes: 12 } }, deps);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/de9-crossover-labour' }, deps)).body as { labourMinutes?: number }).labourMinutes).toBe(12);
    const bad = await handleWorkbenchRequest({ method: 'POST', path: '/api/designs', body: { ...design, id: 'de9-crossover-bad', labourMinutes: -1 } }, deps);
    expect([400, 422]).toContain(bad.status);
    const part = { id: 'nut-test', label: 'Nut', kind: 'fastener', src: 's', cost: { unit: 0.05, currency: 'EUR', breaks: [{ minQty: 100, unit: 0.03 }] } };
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/definitions/mechanicals', body: part }, deps)).status).toBe(201);
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/mechanicals/nut-test' }, deps)).body).toMatchObject({ cost: part.cost });
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/definitions/mechanicals', body: { ...part, id: 'nut-bad', cost: { unit: -1 } } }, deps)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('WireViz through the import job and the exporter', () => {
  it('imports a harness as a reviewable design, publishes it, and exports it back', async () => {
    const deps = serve();
    const { id, job } = await run(deps, 'wireviz', 'wireviz-yaml', 'bench-lead.yml', HARNESS);
    expect(job.status).toBe('done');
    expect(job.result.proposal.designs.map((d) => d.id)).toEqual(['bench-lead']);
    expect(job.result.proposal.definitions['connectors']).toHaveLength(2);
    expect(job.result.proposal.definitions['wires']).toHaveLength(1);
    expect(job.result.notes.join('\n')).toContain('is proposed');
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/bench-lead' }, deps)).status).toBe(404);
    const published = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${id}/publish`, user: { name: 'Ada', source: 'session' } }, deps);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/bench-lead' }, deps)).status).toBe(200);
    const exported = await handleWorkbenchRequest({ method: 'GET', path: '/api/modules/wireviz/_export/wireviz-yaml?design=bench-lead' }, deps);
    expect(exported.status).toBe(200);
    const text = new TextDecoder().decode((exported as { bytes?: Uint8Array }).bytes ?? new TextEncoder().encode(String(exported.body)));
    expect(text).toContain('Bench lead');
    expect(text).toContain('W1:');
  }, 30_000);
});
