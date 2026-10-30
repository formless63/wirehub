import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDb } from '@wirehub/catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { fileDepictionStore } from '../server/depictions.ts';
import { coverPath } from '../server/representations.ts';
import { fileDocStore } from '../server/storage/doc-store.ts';
import { resolveCover, type RepresentationView } from '../src/representations.ts';
import { recordsOfWrite } from '../src/locks/records.ts';
import { scopeFor } from '../server/auth/tokens.ts';
import { representationFixture } from './representation-fixture.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wirehub-cover-test-'));
  roots.push(root);
  const { board, depiction, sourceHash } = await representationFixture();
  const depictions = fileDepictionStore(join(root, 'depictions'));
  await depictions.writeMeta(board.id, depiction.meta);
  for (const [file, content] of Object.entries(depiction.files)) await depictions.writeAsset(board.id, file, content);
  const db = { ...loadDb(), pcbas: [board] };
  const deps = (): WorkbenchDeps => ({ docs: fileDocStore(root), depictions: fileDepictionStore(join(root, 'depictions')), loadDb: () => db }) as WorkbenchDeps;
  const path = `/api/representations/pcbas/${board.id}`;
  const call = (method = 'GET', body?: unknown, etag?: string, suffix = '') => handleWorkbenchRequest({ method, path: path + suffix,
    ...(body === undefined ? {} : { body }), ...(etag === undefined ? {} : { headers: { 'if-match': etag } }) }, deps());
  return { root, board, depiction, depictions, db, deps, path, call, sourceHash };
}
const view = (body: unknown) => body as RepresentationView;

describe('source-based record covers', () => {
  it('selects native board art, keeps its exact hash/frame, persists a choice across reopening the file store', async () => {
    const f = await fixture();
    const initial = await f.call();
    expect(initial.status).toBe(200);
    const data = view(initial.body);
    expect(resolveCover(data)).toMatchObject({ state: 'automatic', selected: { view: 'board-top' } });
    const bottom = data.candidates.find((c) => c.view === 'board-bottom')!;
    expect(bottom).toMatchObject({ sourceKind: 'kicad', identity: { record: `pcbas/${f.board.id}`, revision: f.board.revision }, sources: [{ sha256: f.sourceHash }], mirrorOf: 'board-top', mirrorAxis: 'x' });
    const bytes = await f.depictions.readAsset(f.board.id, 'board-bottom.svg');
    expect(bottom.asset).toBe(createHash('sha256').update(bytes!).digest('hex'));
    expect(bottom.frame?.mmPerUnit).toBe(1);
    expect(bottom.frame).toMatchObject({ origin: 'top-left', yAxis: 'down' });
    const saved = await f.call('PUT', { choice: { view: bottom.view, lineage: bottom.lineage } }, initial.headers!.ETag);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(resolveCover(view((await f.call()).body))).toMatchObject({ state: 'chosen', selected: { view: 'board-bottom' } });
    expect(await fileDocStore(f.root).read(coverPath(f.board.id))).toEqual({ view: bottom.view, lineage: bottom.lineage });
    // Presentation choice never rewrites the native art or its mirrored anchors.
    expect(await f.depictions.readAsset(f.board.id, 'board-bottom.svg')).toEqual(bytes);
    expect(await f.depictions.readMeta(f.board.id)).toEqual(f.depiction.meta);
    expect((await f.call('PUT', { choice: null }, saved.headers!.ETag)).status).toBe(200);
    expect((await f.call()).body).toMatchObject({ choice: null });
  });

  it('retains the choice across same-source regeneration, but marks source/version/build drift and missing art explicitly', async () => {
    const f = await fixture();
    const initial = await f.call();
    const bottom = view(initial.body).candidates[1]!;
    await f.call('PUT', { choice: { view: bottom.view, lineage: bottom.lineage } }, initial.headers!.ETag);
    await f.depictions.writeAsset(f.board.id, 'board-bottom.svg', `${f.depiction.files['board-bottom.svg']}\n`);
    expect(resolveCover(view((await f.call()).body)).state).toBe('chosen');
    f.db.pcbas[0] = { ...f.board, revision: 'changed' };
    expect(resolveCover(view((await f.call()).body)).state).toBe('stale');
    f.db.pcbas[0] = { ...f.board, build: 'other population' };
    expect(resolveCover(view((await f.call()).body)).state).toBe('stale');
    f.db.pcbas[0] = f.board;
    await f.depictions.writeMeta(f.board.id, { ...f.depiction.meta, sources: [{ role: 'kicad-pcb', path: 'synthetic-adapter.kicad_pcb', sha256: 'f'.repeat(64) }] });
    expect(resolveCover(view((await f.call()).body)).state).toBe('stale');
    await f.depictions.removeAsset!(f.board.id, 'board-bottom.svg');
    expect(resolveCover(view((await f.call()).body))).toMatchObject({ state: 'unavailable', selected: { view: 'board-top' } });
  });

  it('uses the normal precondition, token, lock, dry-run and refusal paths', async () => {
    const f = await fixture();
    const initial = await f.call();
    const choice = view(initial.body).candidates[1]!;
    const body = { choice: { view: choice.view, lineage: choice.lineage } };
    expect((await f.call('PUT', body)).status).toBe(428);
    expect((await f.call('PUT', body, 'old')).status).toBe(409);
    expect((await f.call('PUT', { choice: { view: 'board-bottom', lineage: 'made-up' } }, initial.headers!.ETag)).status).toBe(409);
    expect((await f.call('PUT', body, initial.headers!.ETag, '?dryRun=1')).status).toBe(200);
    expect(await fileDocStore(f.root).read(coverPath(f.board.id))).toBeUndefined();
    expect(recordsOfWrite('PUT', f.path)).toEqual([`definition:pcbas:${f.board.id}`]);
    expect(scopeFor('PUT', f.path)).toBe('catalog:write');
    expect((await f.call('GET', undefined, undefined, '?rev=1')).status).toBe(400);
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/representations/pcbas/missing' }, f.deps())).status).toBe(404);
  });
});
