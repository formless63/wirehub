/**
 * The `model-link` record kind (Postgres plan task B0, on the file backend
 * first): the Library's attach / detach / upload are staged in the unit of
 * work like every other write — read-your-writes, a precondition on the link
 * the request read, and one commit for the link and an upload's bytes.
 */

import { fixtureCatalog } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryAssetStore } from '../server/assets.ts';
import type { DesignStore } from '../server/designs.ts';
import { linkETag } from '../server/models/api.ts';
import { memoryModelLinkStore, sortLinks, type ModelLink } from '../server/models/links.ts';
import { StaleRecordError } from '../server/storage/change-set.ts';
import { UnitOfWork } from '../server/storage/unit-of-work.ts';

const fixture = fixtureCatalog();
const noDesigns: DesignStore = { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: true }), remove: () => {} };
const link = (record: string, asset = 'a'.repeat(64)): ModelLink => ({ record, asset, sourceKind: 'uploaded', src: 'synthetic example' });

function deps(): WorkbenchDeps & { modelLinks: ReturnType<typeof memoryModelLinkStore>; assets: ReturnType<typeof memoryAssetStore> } {
  return { designs: noDesigns, loadDb: () => fixture.loadDb(), modelLinks: memoryModelLinkStore(), assets: memoryAssetStore() };
}

describe('model-link kind', () => {
  it('stages a put and a detach, reads its own writes, and commits both', async () => {
    const d = deps();
    await d.modelLinks.put(link('kits/k'));
    const uow = new UnitOfWork(d);
    await uow.deps.modelLinks!.put(link('connectors/de9-female'));
    expect(await uow.deps.modelLinks!.remove('kits/k')).toBe(true);
    expect((await uow.deps.modelLinks!.list()).map((l) => l.record)).toEqual(['connectors/de9-female']);
    // nothing reached the store yet
    expect(d.modelLinks.links.map((l) => l.record)).toEqual(['kits/k']);
    await uow.commit({ method: 'PUT', path: '/api/models/connectors/de9-female' });
    expect(d.modelLinks.links.map((l) => l.record)).toEqual(['connectors/de9-female']);
    expect(uow.changes.map((c) => [c.kind, c.key, c.op])).toEqual([
      ['model-link', 'connectors/de9-female', 'put'],
      ['model-link', 'kits/k', 'delete'],
    ]);
  });

  it('refuses the commit when the link changed after the request read it', async () => {
    const d = deps();
    const uow = new UnitOfWork(d);
    expect(await uow.deps.modelLinks!.get('kits/k')).toBeUndefined();
    await uow.deps.modelLinks!.put(link('kits/k'));
    await d.modelLinks.put(link('kits/k', 'b'.repeat(64)));
    await expect(uow.commit({ method: 'PUT', path: '/api/models/kits/k' })).rejects.toThrow(StaleRecordError);
    expect(d.modelLinks.links[0]?.asset).toBe('b'.repeat(64));
  });

  it('sorts links in code-point order', () => {
    expect(sortLinks([link('kits/b'), link('kits/B'), link('kits/a-b'), link('kits/a.b')]).map((l) => l.record)).toEqual(['kits/B', 'kits/a-b', 'kits/a.b', 'kits/b']);
  });

  it('attach and detach through the API commit through the unit of work', async () => {
    const d = deps();
    const asset = await d.assets.put(Buffer.from('glTF-model-bytes'), 'model/gltf-binary', 'm.glb', 'synthetic example');
    const put = await handleWorkbenchRequest(
      { method: 'PUT', path: '/api/models/connectors/de9-female', body: { asset: asset.id }, headers: { 'if-match': linkETag(undefined) } },
      d,
    );
    expect(put.status).toBe(200);
    expect(d.modelLinks.links.map((l) => l.record)).toEqual(['connectors/de9-female']);
    const stale = await handleWorkbenchRequest({ method: 'DELETE', path: '/api/models/connectors/de9-female', headers: { 'if-match': linkETag(undefined) } }, d);
    expect(stale.status).toBe(409);
    const del = await handleWorkbenchRequest({ method: 'DELETE', path: '/api/models/connectors/de9-female', headers: { 'if-match': put.headers?.ETag ?? '' } }, d);
    expect(del.status).toBe(200);
    expect(d.modelLinks.links).toEqual([]);
  });
});
