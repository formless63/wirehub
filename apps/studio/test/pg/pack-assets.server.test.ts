/**
 * A pack's depictions and art on Postgres (cs-093): `packs.json` records the files a pack
 * installed; an update replaces or removes them, a disable removes them, and a file the
 * catalog holds of its own is never touched.
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
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const src = 'synthetic example: depiction pack';
const meta = (defId: string, file: string) => ({ defId, views: { 'mating-face': { file, kind: 'vector', mmPerUnit: 1, sourceKind: 'hand', widthUnits: 4, heightUnits: 4, src } }, src, license: 'CC0-1.0' });
const svg = (mark: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><title>${mark}</title><rect width="4" height="4"/></svg>\n`;
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);

function writePack(dir: string, version: string, spec: { files: Record<string, string | Uint8Array> }): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version, license: 'CC0-1.0' }));
  writeFileSync(join(dir, 'components.json'), json([{ id: 'r-60', label: '60 resistor', kind: 'resistor', value: '60 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src }]));
  for (const [path, content] of Object.entries(spec.files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
const demo = (version: string, root: string) =>
  defineModule({ id: 'demo', label: 'Demo', version: '0.1.0', license: 'MIT', setup: { kind: 'domain', description: 'demo' }, catalogPacks: [{ id: 'demo', label: 'Demo', version, root: pathToFileURL(`${root}/`).href, license: 'CC0-1.0' }] });

describePg('a pack\'s depictions across install, update and disable on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-assets-'));
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('records ownership, replaces and removes on update, removes on disable, leaves the catalog\'s own files', async () => {
    const now = () => '2026-10-05T09:00:00.000Z';
    const v1 = join(work, 'demo-1');
    const v2 = join(work, 'demo-2');
    writePack(v1, '1.0.0', {
      files: {
        'depictions/demo-def/meta.json': json(meta('demo-def', 'a.svg')),
        'depictions/demo-def/a.svg': svg('a1'),
        'depictions/demo-def/b.svg': svg('b1'),
        'depictions/demo-own/meta.json': json(meta('demo-own', 'own.svg')),
        'depictions/demo-own/own.svg': svg('pack-own'),
        'depictions/demo-own/extra.svg': svg('extra1'),
        'art/logo.png': png(1),
      },
    });
    writePack(v2, '1.1.0', {
      files: {
        'depictions/demo-def/meta.json': json(meta('demo-def', 'a.svg')),
        'depictions/demo-def/a.svg': svg('a2'),
        'depictions/demo-def/c.svg': svg('c2'),
        'depictions/demo-own/meta.json': json(meta('demo-own', 'own.svg')),
        'depictions/demo-own/own.svg': svg('pack-own-2'),
        'art/logo2.png': png(2),
      },
    });
    // the catalog's own depiction of demo-own/own.svg, there before the pack
    const files = new Map(readCatalogTree(dataPath('..')));
    files.set('depictions/demo-own/meta.json', json(meta('demo-own', 'own.svg')));
    files.set('depictions/demo-own/own.svg', svg('catalog-own'));
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'assets', create: true }, files, blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now });
    const bundled = (version: string, root: string) => void (deps.modules = createRegistry([demo(version, root)]));
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
    const text = async (def: string, file: string): Promise<string | undefined> => {
      const bytes = await deps.depictions?.readAsset(def, file);
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    };
    const record = async () => {
      const snapshot = await cache.get();
      return { snapshot, pack: (JSON.parse(snapshot.files.get('data/packs.json') as string).packs as any[]).find((p) => p.id === 'demo') };
    };

    // install: ownership recorded, the catalog's own file is not the pack's and is not overwritten
    bundled('1.0.0', v1);
    const installed = await call('POST', '/api/setup', { modules: ['demo'] });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    expect(await text('demo-def', 'a.svg')).toContain('a1');
    expect(await text('demo-def', 'b.svg')).toContain('b1');
    expect(await text('demo-own', 'own.svg')).toContain('catalog-own');
    expect(await text('demo-own', 'extra.svg')).toContain('extra1');
    let { snapshot, pack } = await record();
    expect(Object.keys(pack.assets)).toEqual(['art/logo.png', 'depictions/demo-def/a.svg', 'depictions/demo-def/b.svg', 'depictions/demo-def/meta.json', 'depictions/demo-own/extra.svg']);
    expect(snapshot.blobOf.has('data/art/logo.png')).toBe(true);

    // update: a replaced, b and logo.png removed, c and logo2.png added; the catalog's own file still wins
    bundled('1.1.0', v2);
    const before = BigInt(await cache.version());
    const updated = await call('POST', '/api/packs/demo/update');
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(BigInt(await cache.version())).toBe(before + 1n);
    expect(await text('demo-def', 'a.svg')).toContain('a2');
    expect(await text('demo-def', 'b.svg')).toBeUndefined();
    expect(await text('demo-def', 'c.svg')).toContain('c2');
    expect(await text('demo-own', 'own.svg')).toContain('catalog-own');
    expect(await text('demo-own', 'extra.svg')).toBeUndefined();
    ({ snapshot, pack } = await record());
    expect(snapshot.blobOf.has('data/art/logo.png')).toBe(false);
    expect(snapshot.blobOf.has('data/art/logo2.png')).toBe(true);
    expect(Object.keys(pack.assets)).toEqual(['art/logo2.png', 'depictions/demo-def/a.svg', 'depictions/demo-def/c.svg', 'depictions/demo-def/meta.json']);

    // disable: everything the pack owned goes, the catalog's own files stay
    const disabled = await call('DELETE', '/api/packs/demo');
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    for (const file of ['a.svg', 'c.svg', 'meta.json']) expect(await deps.depictions?.readAsset('demo-def', file), file).toBeUndefined();
    expect(await deps.depictions?.listDefIds()).not.toContain('demo-def');
    expect(await text('demo-own', 'own.svg')).toContain('catalog-own');
    snapshot = (await record()).snapshot;
    expect(snapshot.blobOf.has('data/art/logo2.png')).toBe(false);
    expect((JSON.parse(snapshot.files.get('data/packs.json') as string).packs as any[]).some((p) => p.id === 'demo')).toBe(false);
  }, 180_000);
});
