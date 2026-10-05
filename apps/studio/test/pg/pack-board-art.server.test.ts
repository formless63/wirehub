/**
 * A pack's board art and the board's 3D model link on Postgres (cs-d97): the
 * link (`pcbas/<id>`) is keyed to the board's Gerber art, so art that comes
 * with a pack install or update, or goes with a disable, re-keys it, as an
 * upload through /api/depictions does.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry, defineModule } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { sha256Hex, sourceKey } from '../../server/models/cache.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const src = 'synthetic example: board art pack';
const view = (file: string) => ({ file, kind: 'vector', mmPerUnit: 1, sourceKind: 'gerber', widthUnits: 4, heightUnits: 4, src });
const meta = { defId: 'demo-board', views: { 'board-top': view('board-top.svg'), 'board-bottom': view('board-bottom.svg') }, src, license: 'CC0-1.0' };
const svg = (mark: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><title>${mark}</title><rect width="4" height="4"/></svg>\n`;
const enc = new TextEncoder();

function writePack(dir: string, version: string, mark: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'depictions/demo-board'), { recursive: true });
  writeFileSync(join(dir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version, license: 'CC0-1.0' }));
  writeFileSync(join(dir, 'components.json'), json([{ id: 'r-61', label: '61 resistor', kind: 'resistor', value: '61 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src }]));
  writeFileSync(join(dir, 'depictions/demo-board/meta.json'), json(meta));
  writeFileSync(join(dir, 'depictions/demo-board/board-top.svg'), svg(`top-${mark}`));
  writeFileSync(join(dir, 'depictions/demo-board/board-bottom.svg'), svg(`bottom-${mark}`));
}
const demo = (version: string, root: string) =>
  defineModule({ id: 'demo', label: 'Demo', version: '0.1.0', license: 'MIT', setup: { kind: 'domain', description: 'demo' }, catalogPacks: [{ id: 'demo', label: 'Demo', version, root: pathToFileURL(`${root}/`).href, license: 'CC0-1.0' }] });

describePg('a pack\'s board art re-keys the board\'s model link on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-board-art-'));
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('install and update key the link to the pack\'s art; disable takes it out again', async () => {
    const v1 = join(work, 'demo-1');
    const v2 = join(work, 'demo-2');
    writePack(v1, '1.0.0', 'one');
    writePack(v2, '1.1.0', 'two');
    // the board's model link: built from one source file, no art yet
    const step = { path: 'models/demo-board.step', sha256: sha256Hex(enc.encode('step bytes')) };
    const bare = { record: 'pcbas/demo-board', asset: sourceKey([step], 50000), files: [step], sourceKind: 'kicad-board', src };
    const files = new Map(readCatalogTree(dataPath('..')));
    files.set('data/models.json', json({ src, links: [bare] }));
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'board-art', create: true }, files, blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    const bundled = (version: string, root: string) => void (deps.modules = createRegistry([demo(version, root)]));
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
    const link = async () => (await deps.modelLinks!.list()).find((l) => l.record === 'pcbas/demo-board')!;
    const artPaths = async () => (await link()).files!.filter((f) => f.path.startsWith('depictions/')).map((f) => f.path);
    expect((await link()).asset).toBe(bare.asset);

    bundled('1.0.0', v1);
    const installed = await call('POST', '/api/setup', { modules: ['demo'] });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    const afterInstall = await link();
    expect(await artPaths()).toEqual(['depictions/demo-board/board-bottom.svg', 'depictions/demo-board/board-top.svg']);
    expect(afterInstall.asset).not.toBe(bare.asset);

    bundled('1.1.0', v2);
    const updated = await call('POST', '/api/packs/demo/update');
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const afterUpdate = await link();
    expect(afterUpdate.asset).not.toBe(afterInstall.asset);
    const top = await deps.depictions!.readAsset('demo-board', 'board-top.svg');
    expect(afterUpdate.files!.find((f) => f.path.endsWith('board-top.svg'))!.sha256).toBe(sha256Hex(top!));

    const disabled = await call('DELETE', '/api/packs/demo');
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(await artPaths()).toEqual([]);
    expect((await link()).asset).toBe(bare.asset);
  }, 180_000);
});
