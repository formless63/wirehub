/**
 * The module contract's server session (`docs/modules.md`): the example module
 * (`modules/example`) driven through the real API on a backend holding the
 * starter catalog. Every backend must answer every step the same and end with
 * the same catalog byte for byte, derived records included — the file backend,
 * the in-memory commit tree and Postgres all run it.
 *
 * Covers the server-side extension points: integration routes (a read and a
 * write-locked one), the validation rule, the importer (proposal, then accept
 * as one change set), the exporter, owned documents, and derived records.
 */

import { createRegistry } from '@wirehub/modules';
import { example } from '@wirehub/module-example';
import { expect } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type ApiResponse, type WorkbenchDeps } from '../../server/api.ts';
import { contentETag } from '../../server/etag.ts';

export const exampleRegistry = createRegistry([example]);

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export async function moduleScenario(base: WorkbenchDeps, send?: (request: ApiRequest) => Promise<ApiResponse>): Promise<string[]> {
  const deps: WorkbenchDeps = { ...base, modules: exampleRegistry, now: base.now ?? (() => '2026-10-05T12:00:00.000Z'), today: base.today ?? (() => '2026-10-05') };
  const log: string[] = [];
  const call = async (label: string, request: ApiRequest, status: number): Promise<ApiResponse> => {
    const response = await (send ?? ((r: ApiRequest) => handleWorkbenchRequest(r, deps)))(request);
    const shown = response.bytes === undefined ? JSON.stringify(response.body) : `${response.contentType} ${new TextDecoder().decode(response.bytes)}`;
    log.push(`${label}: ${response.status} ${response.headers?.ETag ?? ''} ${shown}`);
    expect(response.status, `${label}: ${shown.slice(0, 300)}`).toBe(status);
    return response;
  };

  // integration routes: a read, and a write that takes the lock
  const status = await call('status route', { method: 'GET', path: '/api/modules/example/status' }, 200);
  expect(status.body).toEqual({ module: 'example', ok: true });
  await call('echo route', { method: 'POST', path: '/api/modules/example/echo', body: { a: 1 } }, 200);
  await call('reserved sub-path', { method: 'GET', path: '/api/modules/example/_nothing/x' }, 404);

  // the validation rule refuses a save whose label says TODO
  const design = await call('read design', { method: 'GET', path: '/api/designs/de9-crossover' }, 200);
  const refused = await call('rule refuses', { method: 'PUT', path: '/api/designs/de9-crossover', body: { ...(design.body as object), label: 'TODO name this' }, headers: { 'if-match': design.headers?.ETag ?? '' } }, 422);
  expect(JSON.stringify(refused.body)).toContain('example/todo-label');

  // importer: a proposal first (nothing written), then accepted as one change set
  const csv = 'id,label,value\nex-r-1k,Example resistor 1 kΩ,1 kΩ\nex-r-2k,Example resistor 2 kΩ,2 kΩ\nnot a line\n';
  const before = await call('library before import', { method: 'GET', path: '/api/definitions/components' }, 200);
  const preview = await call('import preview', { method: 'POST', path: '/api/modules/example/_import/resistor-csv', body: { fileName: 'parts.csv', base64: b64(csv) } }, 200);
  const proposal = (preview.body as { accepted: boolean; proposal: { definitions: { components: { id: string }[] }; notes: string[] } });
  expect(proposal.accepted).toBe(false);
  expect(proposal.proposal.definitions.components.map((c) => c.id)).toEqual(['ex-r-1k', 'ex-r-2k']);
  expect(proposal.proposal.notes).toHaveLength(1);
  expect((await call('library unchanged by a preview', { method: 'GET', path: '/api/definitions/components' }, 200)).body).toEqual(before.body);
  await call('import accepted', { method: 'POST', path: '/api/modules/example/_import/resistor-csv', body: { fileName: 'parts.csv', base64: b64(csv), accept: true } }, 200);
  await call('imported record is stored', { method: 'GET', path: '/api/definitions/components/ex-r-2k' }, 200);
  await call('nothing new the second time', { method: 'POST', path: '/api/modules/example/_import/resistor-csv', body: { fileName: 'parts.csv', base64: b64(csv), accept: true } }, 409);
  await call('importer refuses a wrong extension', { method: 'POST', path: '/api/modules/example/_import/resistor-csv', body: { fileName: 'parts.txt', base64: b64(csv) } }, 400);
  await call('unknown importer', { method: 'POST', path: '/api/modules/example/_import/nope', body: { fileName: 'parts.csv', base64: '' } }, 404);

  // exporter: a stored design as a file
  const exported = await call('export joints', { method: 'GET', path: '/api/modules/example/_export/joints-csv?design=de9-crossover' }, 200);
  expect(new TextDecoder().decode(exported.bytes)).toMatch(/^a,b,note\n/);
  expect(exported.contentType).toBe('text/csv');
  await call('export of a missing design', { method: 'GET', path: '/api/modules/example/_export/joints-csv?design=nope' }, 404);

  // owned documents: written by path under the module's prefix, never a derived file
  const doc = await call('write module document', { method: 'PUT', path: '/api/docs/data/example/notes.json', body: { src: 'synthetic example', n: 1 }, headers: { 'if-match': contentETag(null) } }, 200);
  await call('read module document', { method: 'GET', path: '/api/docs/data/example/notes.json' }, 200);
  await call('derived files are not writable', { method: 'PUT', path: '/api/docs/data/derived/example/summary.json', body: {}, headers: { 'if-match': contentETag(null) } }, 403);
  await call('remove module document', { method: 'DELETE', path: '/api/docs/data/example/notes.json', headers: { 'if-match': doc.headers?.ETag ?? '' } }, 200);

  // derived records: recomputed by the commit that changed their inputs
  const a = await call('read design again', { method: 'GET', path: '/api/designs/dc-y-splitter' }, 200);
  await call('save a design', { method: 'PUT', path: '/api/designs/dc-y-splitter', body: { ...(a.body as object), label: 'Y splitter (module run)' }, headers: { 'if-match': a.headers?.ETag ?? '' } }, 200);
  const summary = await call('derived summary', { method: 'GET', path: '/api/docs/data/derived/example/summary.json' }, 200);
  const data = summary.body as { designs: number; joints: number };
  const listed = await call('designs list', { method: 'GET', path: '/api/designs' }, 200);
  expect(data.designs).toBe((listed.body as { designs: unknown[] }).designs.length);
  expect(data.joints).toBeGreaterThan(0);
  const md = await call('derived report', { method: 'GET', path: '/api/docs/data/derived/example/summary.md' }, 200);
  expect(md.body).toMatch(/^# Example summary\n/);
  // …and moves again with the next change: a new design
  const created = await call('create a design', { method: 'POST', path: '/api/designs/dc-y-splitter/duplicate', body: { newId: 'dc-y-splitter-copy', newLabel: 'Y splitter copy' } }, 201);
  expect(created.status).toBe(201);
  const again = await call('derived summary after', { method: 'GET', path: '/api/docs/data/derived/example/summary.json' }, 200);
  expect((again.body as { designs: number }).designs).toBe(data.designs + 1);
  return log;
}
