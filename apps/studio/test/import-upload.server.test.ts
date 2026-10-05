/**
 * An importer's file as raw bytes (cs-rni): `PUT /api/modules/:m/_import/:i?fileName=…`
 * with application/octet-stream — no base64, no JSON, room beyond the JSON limits
 * (`WIREHUB_IMPORT_MAX_MB`) — always an import job.
 */

import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { exampleRegistry, EXAMPLE_CSV, EXAMPLE_FILE } from './fixtures/example-importer.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const BASE = 'http://studio.test';
const PATH = '/api/modules/example-parts/_import/mechanicals-csv';
let app: Hono;
let jobs: ReturnType<typeof createJobService>;

const put = async (path: string, body: BodyInit | null, type: string | null = 'application/octet-stream'): Promise<Response> =>
  await app.request(`${BASE}${path}`, { method: 'PUT', headers: { ...(type === null ? {} : { 'content-type': type }), origin: BASE }, ...(body === null ? {} : { body }) });

beforeEach(() => {
  const backend = memoryWriteBackend(exampleRegistry, join(process.cwd(), '..', '..', 'packages', 'catalog', 'data', '..'));
  const store = memoryJobStore();
  jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps: backend.deps })), kinds: ['import'], pollMs: 20 });
  backend.deps.jobs = jobs;
  app = new Hono();
  mountWorkbenchApi(app, backend.deps, backend.depictionDeps);
});
afterEach(() => {
  delete process.env['WIREHUB_IMPORT_MAX_MB'];
});

describe('PUT an importer file as raw bytes', () => {
  it('queues an import job from the bytes, which plans and publishes like any other', async () => {
    const res = await put(`${PATH}?fileName=${EXAMPLE_FILE}`, Buffer.from(EXAMPLE_CSV));
    expect(res.status, await res.clone().text()).toBe(202);
    const { job } = (await res.json()) as { job: { id: string; kind: string; request: { fileName: string } } };
    expect(job).toMatchObject({ kind: 'import', request: { fileName: EXAMPLE_FILE } });
    expect(res.headers.get('location')).toBe(`/api/jobs/${job.id}`);
    expect((await jobs.wait(job.id, 10_000)).status).toBe('done');
    const published = await app.request(`${BASE}/api/jobs/${job.id}/publish`, { method: 'POST', headers: { origin: BASE } });
    expect(published.status).toBe(200);
    expect(((await published.json()) as { committed: boolean }).committed).toBe(true);
  });

  it('takes a file past the JSON body limit, up to WIREHUB_IMPORT_MAX_MB, and refuses one past that', async () => {
    // 5 MB of comment lines: bigger than a JSON body (4 MB), well inside an upload
    const big = Buffer.from(`${'# padding padding padding padding\n'.repeat(150_000)}${EXAMPLE_CSV}`);
    expect(big.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const res = await put(`${PATH}?fileName=${EXAMPLE_FILE}`, big);
    expect(res.status, await res.clone().text()).toBe(202);
    const { job } = (await res.json()) as { job: { id: string } };
    expect((await jobs.wait(job.id, 20_000)).status).toBe('done');
    process.env['WIREHUB_IMPORT_MAX_MB'] = '1';
    const refused = await put(`${PATH}?fileName=${EXAMPLE_FILE}`, big);
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toContain('1 MB');
  });

  it('says in words what is wrong before it reads the body', async () => {
    expect((await put(`${PATH}`, Buffer.from(EXAMPLE_CSV))).status).toBe(400);
    expect((await put(`${PATH}?fileName=notes.txt`, Buffer.from('x'))).status).toBe(400);
    expect((await put('/api/modules/example-parts/_import/nope?fileName=a.parts.csv', Buffer.from('x'))).status).toBe(404);
    const wrongType = await put(`${PATH}?fileName=${EXAMPLE_FILE}`, JSON.stringify({ base64: 'eA==' }), 'application/json');
    expect(wrongType.status).toBe(415);
    expect((await put(`${PATH}?fileName=${EXAMPLE_FILE}`, Buffer.from('x'), null)).status).toBe(415);
    expect((await put(`${PATH}?fileName=${EXAMPLE_FILE}`, new Uint8Array(0))).status).toBe(400);
  });

  it('answers 501 where this studio runs no jobs', async () => {
    const backend = memoryWriteBackend(exampleRegistry, join(process.cwd(), '..', '..', 'packages', 'catalog', 'data', '..'));
    const bare = new Hono();
    mountWorkbenchApi(bare, backend.deps, backend.depictionDeps);
    const res = await bare.request(`${BASE}${PATH}?fileName=${EXAMPLE_FILE}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', origin: BASE }, body: Buffer.from('x') });
    expect(res.status).toBe(501);
  });
});
