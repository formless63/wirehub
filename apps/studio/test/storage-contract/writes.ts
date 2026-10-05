/**
 * The storage contract's write cases (`specs/postgres-backend.md` §10, task
 * B9): one scripted session of real API requests — design saves and stale
 * saves, new / duplicate / rename / delete, drawing title block and photo,
 * versions (save, unlock, edit, branch into a draft), a definition edit that
 * regenerates the tag tables, vocabulary, the wire library, a build file, a
 * model upload and detach, artwork, and a two-record change refused whole —
 * run against a backend holding the starter catalog.
 *
 * Every backend must answer every step the same (status and body) and end
 * with the same catalog, byte for byte (`GET /api/export`). The suite runs it
 * on the file backend (a temporary copy of the catalog), on the in-memory
 * commit tree and on Postgres, and compares them.
 */

import { createHash } from 'node:crypto';

import { dataPath } from '@wirehub/catalog';
import { explode } from '@wirehub/catalog/src/codec/index.ts';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import type { ModuleRegistry } from '@wirehub/modules';
import { expect } from 'vitest';

import { makePng, pngDataUri } from '../png-fixture.ts';
import { exportTree } from '../../server/pg/export.ts';
import { snapshotOf } from '../../server/pg/snapshot.ts';
import { CatalogTree, treeWorkbenchDeps } from '../../server/pg/tree.ts';

import { handleWorkbenchRequest, transactingDepictionDeps, type ApiRequest, type ApiResponse, type WorkbenchDeps } from '../../server/api.ts';
import { handleDepictionRequest, type DepictionDeps } from '../../server/depictions.ts';
import type { ConvertedModel } from '../../server/models/convert.ts';
import { linkETag } from '../../server/models/api.ts';
import type { CatalogExport } from '../../server/pg/export.ts';
import { UnitOfWork } from '../../server/storage/unit-of-work.ts';
import { StaleRecordError } from '../../server/storage/change-set.ts';

export interface WriteBackend {
  deps: WorkbenchDeps;
  depictionDeps: DepictionDeps;
  /** how a request reaches the studio: straight into the router (default), or over HTTP (`http.ts`, SA1) */
  transport?: {
    call: (request: ApiRequest) => Promise<ApiResponse>;
    depiction: (request: { method: string; path: string; json?: unknown }) => Promise<{ status: number; body?: unknown; bytes?: Uint8Array }>;
  };
  close?: () => Promise<void>;
}

export const fixed = {
  now: () => '2026-10-04T12:00:00.000Z',
  today: () => '2026-10-04',
  localUser: { name: 'Contract Tester', email: 'tester@example.com', source: 'local' as const },
  convertModel: async (bytes: Uint8Array): Promise<ConvertedModel> => ({
    glb: new Uint8Array([...new TextEncoder().encode('glTF'), ...bytes]),
    format: 'glb',
    stats: { triangles: 12, sourceTriangles: 12, simplified: false, parts: 1, glbBytes: bytes.length + 4 },
  }),
};

const PNG = `data:image/png;base64,${Buffer.from('a photo of the cable').toString('base64')}`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>';

/** What a step answered, comparable across backends (ETags included; nothing time- or host-dependent is in a body). */
function summary(response: ApiResponse | { status: number; body?: unknown; bytes?: Uint8Array }): string {
  const etag = 'headers' in response ? (response.headers?.ETag ?? '') : '';
  const body = 'bytes' in response && response.bytes !== undefined ? `bytes:${createHash('sha256').update(response.bytes).digest('hex')}` : JSON.stringify(response.body);
  return `${response.status} ${etag} ${body}`;
}

/** Run the session; returns every step's answer and the catalog it ends with. */
export async function writeScenario(backend: WriteBackend): Promise<{ log: string[]; exported: CatalogExport }> {
  const deps: WorkbenchDeps = { ...backend.deps, ...fixed };
  const log: string[] = [];
  const send = backend.transport?.call ?? ((request: ApiRequest) => handleWorkbenchRequest(request, deps));
  const call = async (label: string, request: ApiRequest, status: number): Promise<ApiResponse> => {
    const response = await send(request);
    log.push(`${label}: ${summary(response)}`);
    expect(response.status, `${label}: ${JSON.stringify(response.body).slice(0, 300)}`).toBe(status);
    return response;
  };
  const etag = (r: ApiResponse): string => r.headers?.ETag ?? '';

  // designs
  const read = await call('read design', { method: 'GET', path: '/api/designs/de9-crossover' }, 200);
  const design = read.body as Record<string, unknown>;
  const saved = await call('save design', { method: 'PUT', path: '/api/designs/de9-crossover', body: { ...design, label: `${String(design.label)} (contract)` }, headers: { 'if-match': etag(read) } }, 200);
  await call('stale save', { method: 'PUT', path: '/api/designs/de9-crossover', body: { ...design, label: 'stale' }, headers: { 'if-match': etag(read) } }, 409);
  const fresh = (await call('read lead', { method: 'GET', path: '/api/designs/dc-led-lead' }, 200)).body as Record<string, unknown>;
  await call('new design', { method: 'POST', path: '/api/designs', body: { ...fresh, id: 'contract-new', label: 'A new lead' } }, 201);
  await call('duplicate', { method: 'POST', path: '/api/designs/de9-crossover/duplicate', body: { newId: 'de9-crossover-copy' } }, 201);

  // drawing sheet and photo, then a rename that carries them
  const sheet = await call('read drawing', { method: 'GET', path: '/api/drawings/dc-led-lead' }, 200);
  const sheetSaved = await call('drawing', { method: 'PUT', path: '/api/drawings/dc-led-lead', body: { title: 'LED lead', partNumber: 'CAB-01000', src: 'contract test' }, headers: { 'if-match': etag(sheet) } }, 200);
  await call('photo', { method: 'PUT', path: '/api/drawings/dc-led-lead/photo', body: { photo: PNG }, headers: { 'if-match': etag(sheetSaved) } }, 200);
  await call('rename', { method: 'POST', path: '/api/designs/dc-led-lead/rename', body: { newId: 'dc-led-lead-renamed', newLabel: 'DC LED lead (renamed)' }, headers: { 'if-match': etag(await call('read before rename', { method: 'GET', path: '/api/designs/dc-led-lead' }, 200)) } }, 200);
  // hub branding: a catalog document and a sanitised logo asset, on every backend
  const brand = await call('read branding', { method: 'GET', path: '/api/settings/branding' }, 200);
  await call('save branding', { method: 'PUT', path: '/api/settings/branding', body: { organisation: 'Contract Cables', rights: 'Confidential', logo: pngDataUri(makePng(4)) }, headers: { 'if-match': etag(brand) } }, 200);
  await call('stale branding', { method: 'PUT', path: '/api/settings/branding', body: { organisation: 'Stale' }, headers: { 'if-match': etag(brand) } }, 409);
  await call('renamed drawing', { method: 'GET', path: '/api/drawings/dc-led-lead-renamed' }, 200);
  await call('old id gone', { method: 'GET', path: '/api/designs/dc-led-lead' }, 404);

  // versions: save, unlock, edit (relocks), branch a draft
  const base = '/api/designs/de9-crossover/versions';
  await call('save version', { method: 'POST', path: base, body: { note: 'first release' } }, 201);
  await call('locked edit refused', { method: 'PUT', path: `${base}/0`, body: { design: saved.body } }, 409);
  await call('unlock', { method: 'POST', path: `${base}/0/unlock`, body: { reason: 'fix a note' } }, 200);
  await call('edit version', { method: 'PUT', path: `${base}/0`, body: { design: { ...(saved.body as object), notes: ['contract note'] } } }, 200);
  await call('save rev 1', { method: 'POST', path: base, body: { note: 'second' } }, 201);
  await call('branch', { method: 'POST', path: `${base}/0/branch`, body: { confirm: 0, reason: 'try the first again' } }, 200);
  await call('versions list', { method: 'GET', path: base }, 200);

  // definitions (the tag tables follow), vocabulary, wire library, a build
  const part = (await call('read part', { method: 'GET', path: '/api/definitions/components/r-150' }, 200));
  await call('edit part', { method: 'PUT', path: '/api/definitions/components/r-150', body: { ...(part.body as object), label: '150 Ω resistor, re-checked' }, headers: { 'if-match': etag(part) } }, 200);
  await call('vocab entry', { method: 'POST', path: '/api/vocab/families', body: { label: 'Contract family', src: 'contract test' } }, 201);
  await call('wire part', { method: 'POST', path: '/api/wire-library/parts', body: { part: { kind: 'conductor', id: 'c-contract', label: 'Contract conductor', material: 'tinned copper', strands: 7, strandMm: 0.1, src: 'contract test' } } }, 201);
  await call('tags', { method: 'GET', path: '/api/vocab' }, 200);

  // a 3D model: upload (bytes + link in one change set), then detach
  const model = await call('model upload', { method: 'POST', path: '/api/models/connectors/de9-female/upload', body: { name: 'shell.glb', data: Buffer.from('model bytes').toString('base64') }, headers: { 'if-match': linkETag(undefined) } }, 200);
  await call('model list', { method: 'GET', path: '/api/models' }, 200);
  const asset = (model.body as { link: { asset: string } }).link.asset;
  const blob = await call('blob by address', { method: 'GET', path: `/api/blobs/${asset}` }, 200);
  expect(blob.headers?.ETag).toBe(`"${asset}"`);
  await call('no such blob', { method: 'GET', path: `/api/blobs/${'0'.repeat(64)}` }, 404);
  await call('detach', { method: 'DELETE', path: '/api/models/connectors/de9-female', headers: { 'if-match': etag(model) } }, 200);

  // artwork, staged and committed with its manifest
  const upload = { fileName: 'face.svg', widthMm: 31, data: Buffer.from(SVG).toString('base64') };
  const artwork =
    backend.transport !== undefined
      ? await backend.transport.depiction({ method: 'POST', path: '/api/depictions/de9-female/mating-face', json: upload })
      : await handleDepictionRequest(
          { method: 'POST', path: '/api/depictions/de9-female/mating-face', contentType: 'application/json', raw: new TextEncoder().encode(JSON.stringify(upload)) },
          transactingDepictionDeps(backend.depictionDeps, deps),
        );
  log.push(`artwork: ${artwork.status}`);
  expect(artwork.status, JSON.stringify('body' in artwork ? artwork.body : '')).toBe(201);
  const artworkDetail =
    backend.transport !== undefined
      ? await backend.transport.depiction({ method: 'GET', path: '/api/depictions/de9-female' })
      : await handleDepictionRequest({ method: 'GET', path: '/api/depictions/de9-female' }, backend.depictionDeps);
  log.push(`artwork detail: ${summary(artworkDetail)}`);

  // delete (with its confirm token)
  await call('delete copy', { method: 'DELETE', path: '/api/designs/de9-crossover-copy', body: { confirm: 'de9-crossover-copy' } }, 200);

  // two records in one change set, the second changed underneath: nothing is written
  const uow = new UnitOfWork(deps);
  const a = await uow.deps.designs.read('contract-new');
  const b = await uow.deps.designs.read('de9-crossover');
  await uow.deps.designs.write('contract-new', { ...(a as object), label: 'should not land' } as never);
  await uow.deps.designs.write('de9-crossover', { ...(b as object), label: 'should not land either' } as never);
  // another request lands between this one's read and its commit
  const theirs = await send({ method: 'GET', path: '/api/designs/de9-crossover' });
  await call('their save', { method: 'PUT', path: '/api/designs/de9-crossover', body: { ...(theirs.body as object), label: 'changed by someone else' }, headers: { 'if-match': etag(theirs) } }, 200);
  await expect(uow.commit({ method: 'PUT', path: '/api/designs/contract-new' })).rejects.toThrow(StaleRecordError);
  const after = await call('all or nothing', { method: 'GET', path: '/api/designs/contract-new' }, 200);
  expect((after.body as { label: string }).label).toBe('A new lead');

  const exported = (await call('export', { method: 'GET', path: '/api/export' }, 200)).body as CatalogExport;
  return { log, exported };
}

/** The in-memory commit tree over the starter catalog: the Postgres commit's stores, no database. */
/** `root`: the catalog package directory (default: where `@wirehub/catalog` says; a jsdom test passes the path itself) */
export function memoryWriteBackend(modules?: ModuleRegistry, root: string = dataPath('..')): WriteBackend {
  const tree = CatalogTree.fromSnapshot(snapshotOf('1', explode(readCatalogTree(root)).rows));
  const deps = { ...treeWorkbenchDeps(tree, { orgId: 'memory', ...(modules === undefined ? {} : { modules }) }), ...(modules === undefined ? {} : { modules }), exportCatalog: async () => exportTree(tree.contents(), 'memory') };
  return { deps, depictionDeps: { store: deps.depictions!, loadDb: deps.loadDb, loadDesigns: () => tree.catalog.loadDesigns() } };
}

