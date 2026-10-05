/**
 * The pack lifecycle on Postgres: update with a diff, disable, install from an
 * upload, read-only marking and fork — each one change set, and the catalog the
 * database ends up with is byte for byte the one the file backend makes.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree, readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry, defineModule } from '@wirehub/modules';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { exportSnapshot } from '../../server/pg/export.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { handleSetupRequest } from '../../server/setup.ts';
import { handlePacksRequest } from '../../server/packs.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sig = (id: string, label: string) => ({ id, label, kind: 'data', src: 'synthetic example: demo pack' });
const resistor = (id: string, value: string) => ({ id, label: `${value} resistor`, kind: 'resistor', value, terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example: demo pack' });

function writePack(dir: string, version: string, spec: { r60: string; extra?: boolean }): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'vocab'), { recursive: true });
  writeFileSync(join(dir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version, license: 'CC0-1.0' }));
  writeFileSync(join(dir, 'vocab/signals.json'), json({ id: 'signals', label: 'Signals', src: 'demo pack', entries: [sig('can-h', 'CAN high'), sig('can-l', 'CAN low')] }));
  writeFileSync(join(dir, 'components.json'), json([resistor('r-60', spec.r60), ...(spec.extra === true ? [resistor('r-62', '62 Ω')] : [])]));
  writeFileSync(join(dir, 'interfaces.json'), json([{ id: 'can-de9', label: 'CAN on DE-9', bodies: ['de9-male'], pins: { '2': { signal: 'can-l' }, '7': { signal: 'can-h' } }, src: 'synthetic example: demo pack' }]));
}
const demo = (version: string, root: string) =>
  defineModule({ id: 'demo', label: 'Demo', version: '0.1.0', license: 'MIT', setup: { kind: 'domain', description: 'demo' }, catalogPacks: [{ id: 'demo', label: 'Demo', version, root: pathToFileURL(`${root}/`).href, license: 'CC0-1.0' }] });

describePg('pack lifecycle on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-packs-'));
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('installs, updates with a diff, forks, refuses a disable that breaks a use, then disables — same bytes as the file backend', async () => {
    const now = () => '2026-10-05T09:00:00.000Z';
    const v1 = join(work, 'demo-1');
    const v2 = join(work, 'demo-2');
    writePack(v1, '1.0.0', { r60: '60 Ω' });
    writePack(v2, '1.1.0', { r60: '62 Ω', extra: true });
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'packs', create: true }, files: readCatalogTree(dataPath('..')) });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now });
    const bundled = (version: string, root: string) => void (deps.modules = createRegistry([demo(version, root)]));
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string> };

    bundled('1.0.0', v1);
    expect((await call('POST', '/api/setup', { modules: ['demo'] })).status).toBe(200);
    expect((await call('GET', '/api/packs')).body.packs).toEqual([{ id: 'demo', version: '1.0.0', license: 'CC0-1.0', records: 4, module: 'demo' }]);

    // read-only marking and fork, from the database
    expect((await call('GET', '/api/definitions/components')).body.packs).toEqual({ 'r-60': { pack: 'demo', version: '1.0.0' } });
    const edit = await call('PUT', '/api/definitions/components/r-60', { ...resistor('r-60', '1 Ω') });
    expect(edit.status).toBe(409);
    const fork = await call('POST', '/api/definitions/components/r-60/fork', { id: 'r-60-mine' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(fork.body.derivedFrom).toEqual({ pack: 'demo', id: 'r-60', version: '1.0.0' });

    // update with a diff: one change set
    bundled('1.1.0', v2);
    const before = BigInt(await cache.version());
    const preview = await call('GET', '/api/packs/demo/update');
    expect(preview.body.diff.changed.map((r: { id: string }) => r.id)).toEqual(['r-60']);
    expect(preview.body.diff.added.map((r: { id: string }) => r.id)).toEqual(['r-62']);
    expect(BigInt(await cache.version())).toBe(before);
    const updated = await call('POST', '/api/packs/demo/update');
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(BigInt(await cache.version())).toBe(before + 1n);
    expect((await call('GET', '/api/definitions/components/r-62')).status).toBe(200);
    expect((await call('GET', '/api/packs')).body.packs[0]).toMatchObject({ version: '1.1.0', records: 5 });

    // a use outside the pack stops the disable; nothing changes
    const kit = { id: 'kit-r60', label: 'R kit', sku: 'KIT-9', contents: [{ part: { kind: 'component', def: 'r-62' }, qty: 1, src: 'local' }], src: 'local' };
    expect((await call('POST', '/api/definitions/kits', kit)).status).toBe(201);
    const afterKit = BigInt(await cache.version());
    const refused = await call('DELETE', '/api/packs/demo');
    expect(refused.status).toBe(409);
    expect(refused.body.plan.references.map((r: { from: { id: string }; to: string }) => `${r.from.id}->${r.to}`)).toEqual(['kit-r60->r-62']);
    expect(BigInt(await cache.version())).toBe(afterKit);
    expect((await call('DELETE', '/api/definitions/kits/kit-r60', { confirm: 'kit-r60' })).status).toBe(200);

    // the file backend, same steps, same clock: the same flattened catalog (before the disable)
    const copy = join(work, 'data');
    const packsDir = join(work, 'packs');
    cpSync(dataPath(''), copy, { recursive: true });
    const fileDeps = { dataDir: copy, packsDir, prompt: false, now };
    const registry1 = createRegistry([demo('1.0.0', v1)]);
    expect((await handleSetupRequest({ method: 'POST', body: { modules: ['demo'] } }, fileDeps, registry1)).status).toBe(200);
    expect((await handlePacksRequest({ method: 'POST', path: '/api/packs/demo/update' }, fileDeps, createRegistry([demo('1.1.0', v2)]))).status).toBe(200);
    const files = readFlattenedCatalog(work, packsDir);
    const pg = exportSnapshot(await cache.get()).files;
    const derived = (path: string): boolean => path.startsWith('data/tags/') && path !== 'data/tags/review.json';
    // the fork (a local record) is the one difference; compare the pack-carrying files after removing it
    for (const [path, text] of Object.entries(pg)) {
      if (derived(path) || path === 'data/components.json') continue;
      expect(text, path).toBe(files.get(path));
    }

    // disable: one change set, the pack's records gone, the fork (its own record) stays
    const gone = await call('DELETE', '/api/packs/demo');
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect((await call('GET', '/api/definitions/components/r-62')).status).toBe(404);
    expect((await call('GET', '/api/definitions/components/r-60-mine')).status).toBe(200);
    expect((await call('GET', '/api/packs')).body.packs).toEqual([]);
    const tree = exportSnapshot(await cache.get()).files;
    expect(tree['data/interfaces.json']).toBe(readFlattenedCatalog(dataPath('../'), undefined).get('data/interfaces.json'));
  }, 180_000);

  it('installs an uploaded bundle, and updates it by uploading another', async () => {
    const { orgId } = await importCatalog(pgh.db, { org: { slug: 'upload', create: true }, files: readCatalogTree(dataPath('..')) });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T09:00:00.000Z' });
    deps.modules = createRegistry([]);
    const call = async (method: string, path: string, body?: unknown) => (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };
    const bundle = (version: string, value: string) => ({ format: 1, manifest: { format: 1, id: 'upload', name: 'Upload', version, license: 'CC-BY-4.0' }, files: { 'components.json': [resistor('up-r', value)] } });
    const before = BigInt(await cache.version());
    const preview = await call('POST', '/api/packs/install', { bundle: bundle('1.0.0', '10 Ω') });
    expect(preview.body).toMatchObject({ kind: 'install', verified: true });
    expect(BigInt(await cache.version())).toBe(before);
    const done = await call('POST', '/api/packs/install', { bundle: bundle('1.0.0', '10 Ω'), apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(BigInt(await cache.version())).toBe(before + 1n);
    expect((await call('GET', '/api/packs')).body.packs[0]).toMatchObject({ id: 'upload', version: '1.0.0', license: 'CC-BY-4.0' });
    const update = await call('POST', '/api/packs/install', { bundle: bundle('1.0.1', '11 Ω'), apply: true });
    expect(update.body).toMatchObject({ kind: 'update', installed: true });
    expect((await call('GET', '/api/definitions/components/up-r')).body.value).toBe('11 Ω');
    expect((await call('DELETE', '/api/packs/upload')).body).toMatchObject({ disabled: 'upload', removed: 1 });
    expect((await call('GET', '/api/definitions/components/up-r')).status).toBe(404);
  }, 120_000);
});
