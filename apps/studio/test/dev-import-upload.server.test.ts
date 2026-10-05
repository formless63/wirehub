/**
 * The raw-bytes importer upload (`PUT /api/modules/:m/_import/:i?fileName=…`) on the
 * Vite dev host's middleware (`plugin.ts`), the same answers as the standalone
 * server's (`import-upload.server.test.ts`).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { workbenchJsonMiddleware } from '../server/plugin.ts';
import { exampleRegistry, EXAMPLE_CSV, EXAMPLE_FILE } from './fixtures/example-importer.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const PATH = '/api/modules/example-parts/_import/mechanicals-csv';
let server: Server;
let base: string;
let jobs: ReturnType<typeof createJobService>;

function listen(deps: Parameters<typeof workbenchJsonMiddleware>[0]): Promise<void> {
  const middleware = workbenchJsonMiddleware(deps);
  server = createServer((req, res) => middleware(req, res, () => void res.writeHead(404).end()));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

const put = async (path: string, body: BodyInit | null, type: string | null = 'application/octet-stream'): Promise<Response> =>
  await fetch(`${base}${path}`, { method: 'PUT', headers: { ...(type === null ? {} : { 'content-type': type }), origin: base }, ...(body === null ? {} : { body }) });

beforeEach(async () => {
  const backend = memoryWriteBackend(exampleRegistry, join(process.cwd(), '..', '..', 'packages', 'catalog', 'data', '..'));
  const store = memoryJobStore();
  jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps: backend.deps })), kinds: ['import'], pollMs: 20 });
  backend.deps.jobs = jobs;
  await listen(backend.deps);
});
afterEach(async () => {
  delete process.env['WIREHUB_IMPORT_MAX_MB'];
  await new Promise((resolve) => server.close(resolve));
});

describe('PUT an importer file as raw bytes, on the dev host', () => {
  it('queues an import job from the bytes, which plans and publishes', async () => {
    const res = await put(`${PATH}?fileName=${EXAMPLE_FILE}`, Buffer.from(EXAMPLE_CSV));
    expect(res.status, await res.clone().text()).toBe(202);
    const { job } = (await res.json()) as { job: { id: string; kind: string; request: { fileName: string } } };
    expect(job).toMatchObject({ kind: 'import', request: { fileName: EXAMPLE_FILE } });
    expect(res.headers.get('location')).toBe(`/api/jobs/${job.id}`);
    expect((await jobs.wait(job.id, 10_000)).status).toBe('done');
    const published = await fetch(`${base}/api/jobs/${job.id}/publish`, { method: 'POST', headers: { origin: base } });
    expect(published.status).toBe(200);
  });

  it('takes a file past the JSON limit and refuses one past WIREHUB_IMPORT_MAX_MB', async () => {
    const big = Buffer.from(`${'# padding padding padding padding\n'.repeat(150_000)}${EXAMPLE_CSV}`);
    expect(big.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect((await put(`${PATH}?fileName=${EXAMPLE_FILE}`, big)).status).toBe(202);
    process.env['WIREHUB_IMPORT_MAX_MB'] = '1';
    const refused = await put(`${PATH}?fileName=${EXAMPLE_FILE}`, big);
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toContain('1 MB');
  });

  it('says in words what is wrong', async () => {
    expect((await put(`${PATH}`, Buffer.from(EXAMPLE_CSV))).status).toBe(400);
    expect((await put(`${PATH}?fileName=notes.txt`, Buffer.from('x'))).status).toBe(400);
    expect((await put('/api/modules/example-parts/_import/nope?fileName=a.parts.csv', Buffer.from('x'))).status).toBe(404);
    expect((await put(`${PATH}?fileName=${EXAMPLE_FILE}`, JSON.stringify({ base64: 'eA==' }), 'application/json')).status).toBe(415);
    expect((await put(`${PATH}?fileName=${EXAMPLE_FILE}`, new Uint8Array(0))).status).toBe(400);
  });

  it('refuses a cross-site write', async () => {
    const res = await fetch(`${base}${PATH}?fileName=${EXAMPLE_FILE}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', origin: 'http://evil.example' }, body: Buffer.from(EXAMPLE_CSV) });
    expect(res.status).toBe(403);
  });
});
