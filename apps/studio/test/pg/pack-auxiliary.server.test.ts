/** Model links and drawing/build sidecars follow pack updates and disables on Postgres. */
import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const src = 'synthetic example: auxiliary pack';
const link = (record: string, mark: string) => ({ record, asset: mark.repeat(64), sourceKind: 'vendor', src, status: 'wip' });
const bundle = (version: string, mark: string) => ({ format: 1, manifest: { format: 1, id: 'auxiliary', name: 'Auxiliary', version, license: 'CC0-1.0' }, files: {
  'models.json': { src, links: [link('revisions/pack-board/one', mark)] },
  'wire-parts.json': [{ id: 'pack-conductor', kind: 'conductor', label: `Pack ${version}`, src }],
  'strip-practice.json': [{ id: 'pack-practice', label: `Pack ${version}`, appliesTo: 'any', jacketMm: 30, shield: 'trim', insulationMm: 6, drain: { source: 'landed', destination: 'cut' }, src }],
  'drawings/de9-crossover.json': { title: `Pack ${version}`, revision: mark },
  'builds/pack-board-rev1.json': { board: 'PCA-00003', revision: 'Rev1', label: `Pack ${version}`, end: 'source', builds: [{ key: 'bare', build: 'bare', src }] },
} });

describePg('pack auxiliary ownership on Postgres', () => {
  let database: TestDatabase;
  let handle: PgHandle;
  beforeAll(async () => { database = await freshDatabase(); handle = openPg(database.appUrl, { max: 2 }); }, 60_000);
  afterAll(async () => { await handle?.close(); await database?.drop(); }, 60_000);
  it('updates and removes owned sidecars and links without removing local links or edited drawings', async () => {
    const tree = new Map(readCatalogTree(dataPath('..')));
    tree.delete('data/drawings/de9-crossover.json'); // the pack supplies this sidecar; the starter's own would shadow it
    tree.set('data/models.json', `${JSON.stringify({ src, links: [link('revisions/local-board/one', 'c')] }, null, 2)}\n`);
    const { orgId } = await importCatalog(handle.db, { org: { slug: 'auxiliary', create: true }, files: tree, blobs: testBlobs() });
    const cache = new SnapshotCache(handle.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: handle.db, blobs: testBlobs() });
    deps.modules = createRegistry([]);
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-06T09:00:00.000Z' });
    const call = async (method: string, path: string, body?: unknown) => await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps) as { status: number; body: any; headers?: Record<string, string> };
    for (const [version, mark] of [['1.0.0', 'a'], ['1.1.0', 'b']] as const) {
      const result = await call('POST', '/api/packs/install', { bundle: bundle(version, mark), apply: true });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect((await deps.modelLinks!.list()).find((l) => l.record === 'revisions/pack-board/one')!.asset).toBe(mark.repeat(64));
      expect(JSON.parse((await cache.get()).files.get('data/wire-parts.json') as string).find((r: { id: string }) => r.id === 'pack-conductor').label).toBe(`Pack ${version}`);
      expect(JSON.parse((await cache.get()).files.get('data/strip-practice.json') as string).find((r: { id: string }) => r.id === 'pack-practice').label).toBe(`Pack ${version}`);
      expect(JSON.parse((await cache.get()).files.get('data/drawings/de9-crossover.json') as string).title).toBe(`Pack ${version}`);
      expect((await call('GET', '/api/builds/pack-board-rev1')).body.file.label).toBe(`Pack ${version}`);
    }
    // A deployment's changed drawing survives disabling its supplying pack.
    const currentDrawing = await call('GET', '/api/drawings/de9-crossover');
    const edited = await handleWorkbenchRequest({ method: 'PUT', path: '/api/drawings/de9-crossover', body: { title: 'Local title', revision: 'Z' }, headers: { 'if-match': currentDrawing.headers!.ETag! } }, deps);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    cache.invalidate();
    const removed = await call('DELETE', '/api/packs/auxiliary');
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(JSON.parse(((await cache.get()).files.get('data/wire-parts.json') as string | undefined) ?? '[]').some((r: { id: string }) => r.id === 'pack-conductor')).toBe(false);
    expect((await deps.modelLinks!.list()).map((l) => l.record)).toEqual(['revisions/local-board/one']);
    expect((await call('GET', '/api/builds/pack-board-rev1')).status).toBe(404);
    expect(JSON.parse((await cache.get()).files.get('data/drawings/de9-crossover.json') as string).title).toBe('Local title');
  }, 180_000);
});
