/**
 * Batches, dry runs and the docs route (task B13; SA1): every backend answers
 * this session identically. A dry run writes nothing and lists exactly what
 * the real run then commits; a batch of N writes is one commit or nothing.
 */

import { createRegistry, defineModule } from '@wirehub/modules';
import { expect } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type ApiResponse, type WorkbenchDeps } from '../../server/api.ts';
import { contentETag } from '../../server/etag.ts';

const docsModule = defineModule({ id: 'acme-docs', label: 'Acme docs', version: '0.0.1', documents: [{ path: 'data/acme/', class: 'imported' }] });

export async function batchScenario(base: WorkbenchDeps): Promise<string[]> {
  const deps: WorkbenchDeps = { ...base, modules: createRegistry([docsModule]), now: () => '2026-10-05T12:00:00.000Z', today: () => '2026-10-05' };
  const log: string[] = [];
  const call = async (label: string, request: ApiRequest, status: number): Promise<ApiResponse> => {
    const response = await handleWorkbenchRequest(request, deps);
    log.push(`${label}: ${response.status} ${response.headers?.ETag ?? ''} ${JSON.stringify(response.body)}`);
    expect(response.status, `${label}: ${JSON.stringify(response.body).slice(0, 300)}`).toBe(status);
    return response;
  };
  const read = (id: string) => call(`read ${id}`, { method: 'GET', path: `/api/designs/${id}` }, 200);

  // a dry run writes nothing, and says what the real save will change
  const a = await read('de9-crossover');
  const edited = { ...(a.body as object), label: 'Dry-run label' };
  const dry = await call('dry run', { method: 'PUT', path: '/api/designs/de9-crossover?dryRun=1', body: edited, headers: { 'if-match': a.headers?.ETag ?? '' } }, 200);
  const preview = dry.body as { dryRun: boolean; changes: { kind: string; key: string; op: string; after: string; patch: { op: string; path: string }[] }[]; derived: string[] };
  expect(preview.dryRun).toBe(true);
  expect(preview.changes.map((c) => [c.kind, c.key, c.op])).toEqual([['design', 'de9-crossover', 'put']]);
  expect(preview.changes[0]?.patch).toEqual([{ op: 'replace', path: '/label', value: 'Dry-run label' }]);
  expect(preview.derived).toContain('tags');
  expect(((await read('de9-crossover')).body as { label: string }).label).not.toBe('Dry-run label');
  const real = await call('real save', { method: 'PUT', path: '/api/designs/de9-crossover', body: edited, headers: { 'if-match': a.headers?.ETag ?? '' } }, 200);
  expect(preview.changes[0]?.after).toBe(real.headers?.ETag);

  // a batch: two designs and a vocabulary entry, one commit
  const [x, y] = [await read('dc-y-splitter'), await read('de9-terminal-board')];
  const batch = {
    message: 'Relabel two cables and add a family',
    requests: [
      { method: 'PUT', path: '/api/designs/dc-y-splitter', ifMatch: x.headers?.ETag, body: { ...(x.body as object), label: 'Y splitter (batch)' } },
      { method: 'PUT', path: '/api/designs/de9-terminal-board', ifMatch: y.headers?.ETag, body: { ...(y.body as object), label: 'Terminal board (batch)' } },
      { method: 'POST', path: '/api/vocab/families', body: { label: 'Batch family', src: 'batch test' } },
    ],
  };
  const previewed = await call('batch dry run', { method: 'POST', path: '/api/batch', body: { ...batch, dryRun: true } }, 200);
  expect((previewed.body as { changes: unknown[] }).changes.length).toBe(3);
  expect(((await read('dc-y-splitter')).body as { label: string }).label).not.toBe('Y splitter (batch)');
  const committed = await call('batch', { method: 'POST', path: '/api/batch', body: batch }, 200);
  expect((committed.body as { results: { status: number }[] }).results.map((r) => r.status)).toEqual([200, 200, 201]);

  // a refused request refuses the whole batch
  const [p, q] = [await read('dc-y-splitter'), await read('de9-terminal-board')];
  const refused = await call(
    'refused batch',
    {
      method: 'POST',
      path: '/api/batch',
      body: {
        requests: [
          { method: 'PUT', path: '/api/designs/dc-y-splitter', ifMatch: p.headers?.ETag, body: { ...(p.body as object), label: 'should not land' } },
          { method: 'PUT', path: '/api/designs/de9-terminal-board', ifMatch: '"stale"', body: { ...(q.body as object), label: 'stale' } },
        ],
      },
    },
    409,
  );
  expect((refused.body as { committed: boolean; failed: number }).failed).toBe(1);
  expect(((await read('dc-y-splitter')).body as { label: string }).label).toBe('Y splitter (batch)');
  await call('no uploads in a batch', { method: 'POST', path: '/api/batch', body: { requests: [{ method: 'PUT', path: '/api/models/kits/k', body: {} }] } }, 400);

  // a module's document by path
  await call('not a module document', { method: 'PUT', path: '/api/docs/data/elsewhere/x.json', body: { a: 1 }, headers: { 'if-match': contentETag(null) } }, 403);
  await call('document needs If-Match', { method: 'PUT', path: '/api/docs/data/acme/register.json', body: { src: 'synthetic example', entries: [] } }, 428);
  const doc = await call('write document', { method: 'PUT', path: '/api/docs/data/acme/register.json', body: { src: 'synthetic example', entries: [] }, headers: { 'if-match': contentETag(null) } }, 200);
  await call('read document', { method: 'GET', path: '/api/docs/data/acme/register.json' }, 200);
  await call('document in a batch', { method: 'POST', path: '/api/batch', body: { requests: [{ method: 'PUT', path: '/api/docs/data/acme/report.md', ifMatch: contentETag(null), body: '# Report\n' }] } }, 200);
  await call('remove document', { method: 'DELETE', path: '/api/docs/data/acme/register.json', headers: { 'if-match': doc.headers?.ETag ?? '' } }, 200);
  await call('read export', { method: 'GET', path: '/api/export' }, 200);
  return log;
}
