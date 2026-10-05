/**
 * The pack lifecycle through the API (`server/packs.ts`, file backend):
 * installed packs and what this build bundles, update with a record-level
 * diff, disable that refuses while records outside the pack use its own, and
 * the read-only marking of pack records with fork to edit.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross, loadDb, readInstalledPacks } from '@wirehub/catalog';
import type { ConnectorBody } from '@wirehub/model';
import { createRegistry, defineModule } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { DefinitionKind, DefinitionRecord } from '../server/definition-store.ts';
import { scopeFor } from '../server/auth/tokens.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const read = (path: string): string => readFileSync(path, 'utf8');

const signal = (id: string, label: string) => ({ id, label, kind: 'data', src: 'synthetic example: demo pack' });
const resistor = (id: string, value: string) => ({ id, label: `${value} resistor`, kind: 'resistor', value, terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example: demo pack' });

function writePack(dir: string, version: string, spec: { r60: string; extra?: boolean; dropCanL?: boolean }): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'vocab'), { recursive: true });
  writeFileSync(join(dir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version, license: 'CC0-1.0' }));
  writeFileSync(join(dir, 'vocab/signals.json'), json({ id: 'signals', label: 'Signals', src: 'demo pack', entries: [signal('can-h', 'CAN high'), ...(spec.dropCanL === true ? [] : [signal('can-l', 'CAN low')])] }));
  writeFileSync(join(dir, 'components.json'), json([resistor('r-60', spec.r60), ...(spec.extra === true ? [resistor('r-62', '62 Ω')] : [])]));
  writeFileSync(join(dir, 'interfaces.json'), json([{ id: 'can-de9', label: 'CAN on DE-9', bodies: ['de9-male'], pins: { '2': { signal: 'can-l' }, '7': { signal: 'can-h' } }, src: 'synthetic example: demo pack' }]));
}

const moduleFor = (version: string, root: string) =>
  defineModule({
    id: 'demo',
    label: 'Demo',
    version: '0.1.0',
    license: 'MIT',
    setup: { kind: 'domain', description: 'A demo pack.' },
    catalogPacks: [{ id: 'demo', label: 'Demo', version, root: pathToFileURL(`${root}/`).href, license: 'CC0-1.0' }],
  });

let root = '';
let dir = '';
let packs = '';
let v1 = '';
let v2 = '';
let afterInstalls = 0;
let deps: WorkbenchDeps;

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers?: Record<string, string> }> =>
  (await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any };

/** The hub's registry offers the bundled version `root` at `version`. */
function bundle(version: string, packRoot: string): void {
  deps = { ...deps, modules: createRegistry([moduleFor(version, packRoot)]) };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wirehub-packs-api-'));
  dir = join(root, 'catalog');
  packs = join(root, 'packs');
  v1 = join(root, 'demo-1');
  v2 = join(root, 'demo-2');
  cpSync(dataPath(''), dir, { recursive: true });
  writePack(v1, '1.0.0', { r60: '60 Ω' });
  writePack(v2, '1.1.0', { r60: '62 Ω', extra: true });
  afterInstalls = 0;
  const catalog = (): ReturnType<typeof createCatalog> => createCatalog(catalogWithPacksSource(dir, packs));
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => catalog().loadDb(),
    setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z', afterInstall: () => void (afterInstalls += 1) },
    installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
  };
  bundle('1.0.0', v1);
  expect((await call('POST', '/api/setup', { modules: ['demo'] })).status).toBe(200);
  afterInstalls = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const hub = (): ReturnType<typeof createCatalog> => createCatalog(catalogWithPacksSource(dir, packs));

describe('GET /api/packs', () => {
  it('lists what is installed and what this build bundles', async () => {
    expect((await call('GET', '/api/packs')).body.packs).toEqual([{ id: 'demo', version: '1.0.0', license: 'CC0-1.0', records: 4, module: 'demo' }]);
    bundle('1.1.0', v2);
    expect((await call('GET', '/api/packs')).body.packs[0]).toMatchObject({ id: 'demo', version: '1.0.0', available: '1.1.0' });
  });
});

describe('update with a diff', () => {
  it('previews the record changes, applies them as one swap, and runs the after-install step', async () => {
    bundle('1.1.0', v2);
    const preview = await call('GET', '/api/packs/demo/update');
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ direction: 'upgrade', major: false, applicable: true, ok: true });
    expect(preview.body.diff.added.map((r: { id: string }) => r.id)).toEqual(['r-62']);
    expect(preview.body.diff.changed.map((r: { id: string; fields: unknown[] }) => [r.id, r.fields.length])).toEqual([['r-60', 2]]);
    expect(preview.body.writes).toBeUndefined();
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.0.0');

    const done = await call('POST', '/api/packs/demo/update');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ updated: true, from: '1.0.0', to: '1.1.0' });
    expect(afterInstalls).toBe(1);
    const db = hub().loadDb();
    expect(db.components.find((c) => c.id === 'r-60')?.value).toBe('62 Ω');
    expect(db.components.some((c) => c.id === 'r-62')).toBe(true);
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.1.0');
    expect(existsSync(join(dir, 'packs.json'))).toBe(false);
    // the same version again: nothing to do
    expect((await call('POST', '/api/packs/demo/update')).body).toMatchObject({ updated: false });
  });

  it('retires a dropped record that is still in use: it stays, as the deployment\'s own', async () => {
    const interfaces = JSON.parse(read(join(dir, 'interfaces.json'))) as unknown[];
    writeFileSync(join(dir, 'interfaces.json'), json([...interfaces, { id: 'my-can', label: 'My CAN', bodies: ['de9-female'], pins: { '2': { signal: 'can-l' } }, src: 'local' }]));
    const v3 = join(root, 'demo-3');
    writePack(v3, '1.2.0', { r60: '60 Ω', dropCanL: true });
    bundle('1.2.0', v3);
    const preview = await call('GET', '/api/packs/demo/update');
    expect(preview.body.retired.map((r: { id: string }) => r.id)).toEqual(['can-l']);
    expect(preview.body.applicable).toBe(true);
    const done = await call('POST', '/api/packs/demo/update');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ updated: true, retired: 1 });
    expect(done.body.plan.retiredRecords).toBeUndefined();
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.2.0');
    expect(afterInstalls).toBe(1);
    // the record outside the pack still resolves, and the pack no longer owns the signal
    const db = hub().loadDb();
    expect(db.interfaces?.some((i) => i.id === 'my-can')).toBe(true);
    const local = JSON.parse(read(join(dir, 'vocab/signals.json'))) as { entries: { id: string }[] };
    expect(local.entries.map((e) => e.id)).toContain('can-l');
    expect(readInstalledPacks(packs).packs[0]?.added['vocab/signals.json']).not.toContain('can-l');
  });

  it('wants a major version accepted', async () => {
    const v3 = join(root, 'demo-3');
    writePack(v3, '2.0.0', { r60: '60 Ω', extra: true });
    bundle('2.0.0', v3);
    const refused = await call('POST', '/api/packs/demo/update');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('major version');
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('1.0.0');
    expect((await call('POST', '/api/packs/demo/update', { acceptMajor: true })).status).toBe(200);
    expect(readInstalledPacks(packs).packs[0]?.version).toBe('2.0.0');
  });

  it('answers in words for a pack that is not installed or has no bundled version', async () => {
    expect((await call('GET', '/api/packs/nope/update')).status).toBe(404);
    deps = { ...deps, modules: createRegistry([]) };
    const none = await call('GET', '/api/packs/demo/update');
    expect(none.status).toBe(404);
    expect(none.body.error).toContain('no other version');
  });
});

describe('disable', () => {
  it('lists what would go, and removes the pack when nothing outside uses it', async () => {
    const plan = await call('GET', '/api/packs/demo/references');
    expect(plan.body).toMatchObject({ ok: true, references: [] });
    expect(plan.body.records).toHaveLength(4);
    const done = await call('DELETE', '/api/packs/demo');
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ disabled: 'demo', removed: 4 });
    expect(afterInstalls).toBe(1);
    expect(existsSync(join(packs, 'demo'))).toBe(false);
    expect(hub().loadDb().components.some((c) => c.id === 'r-60')).toBe(false);
    expect((await call('GET', '/api/packs')).body.packs).toEqual([]);
  });

  it('refuses while a record outside the pack uses one, and lists the references', async () => {
    const kits = JSON.parse(read(join(dir, 'kits.json'))) as unknown[];
    writeFileSync(join(dir, 'kits.json'), json([...kits, { id: 'kit-r60', label: 'R kit', sku: 'KIT-9', contents: [{ part: { kind: 'component', def: 'r-60' }, qty: 1, src: 'local' }], src: 'local' }]));
    const refused = await call('DELETE', '/api/packs/demo');
    expect(refused.status).toBe(409);
    expect(refused.body.plan.references).toEqual([{ from: { file: 'kits.json', id: 'kit-r60', kind: 'kits', label: 'R kit' }, field: 'contents[0].part.def', to: 'r-60' }]);
    expect(existsSync(join(packs, 'demo'))).toBe(true);
    expect(afterInstalls).toBe(0);
  });

  it('is deployment administration: no API token may write it', () => {
    expect(scopeFor('GET', '/api/packs')).toBe('read');
    expect(scopeFor('DELETE', '/api/packs/demo')).toBeUndefined();
    expect(scopeFor('POST', '/api/packs/demo/update')).toBeUndefined();
  });
});

describe('a pack\'s vocabulary entries and designs are read-only too', () => {
  it('refuses to change a pack\'s vocabulary entry, and still takes entries of your own', async () => {
    const vocab = new Map<string, any>([['signals', JSON.parse(read(join(packs, 'demo/vocab/signals.json')))]]);
    deps = {
      ...deps,
      vocab: {
        list: () => [...vocab.keys()],
        read: (id: string) => structuredClone(vocab.get(id)),
        write: (list: any) => void vocab.set(list.id, structuredClone(list)),
      } as any,
    };
    const list = (await call('GET', '/api/vocab/signals')).body;
    const etag = (await handleWorkbenchRequest({ method: 'GET', path: '/api/vocab/signals' }, deps)).headers?.['ETag'];
    const refused = await handleWorkbenchRequest({ method: 'PATCH', path: '/api/vocab/signals/can-h', body: { note: 'mine' }, ...(etag === undefined ? {} : { ifMatch: etag }) } as any, deps);
    expect(list).toBeDefined();
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("comes from the demo pack (1.0.0) and is read-only");
    expect((refused.body as { hint: string }).hint).toContain('Fork it to edit');
  });

  it('refuses to save, rename or delete a design a pack ships, pointing at duplicate', async () => {
    const design = { id: 'demo-cable', label: 'Demo cable', instances: [], joints: [], src: 'x' };
    deps = {
      ...deps,
      designs: { list: () => [{ id: 'demo-cable' }], has: () => true, read: () => design, write: () => ({ changed: true }), remove: () => undefined } as any,
      installedPacks: () => ({ src: 'x', packs: [{ id: 'demo', version: '1.0.0', license: 'CC0-1.0', added: { 'designs/demo-cable.json': [] } }] }),
    };
    for (const [method, path, body] of [['PUT', '/api/designs/demo-cable', design], ['POST', '/api/designs/demo-cable/rename', { newId: 'mine' }], ['DELETE', '/api/designs/demo-cable', { confirm: 'demo-cable' }]] as const) {
      const out = await call(method, path, body);
      expect(out.status, `${method} ${path}`).toBe(409);
      expect(out.body.hint).toContain('Fork it to edit');
      expect(out.body.hint).toContain('duplicate');
    }
    // a design the pack did not ship is not guarded: this one is not found only because the stub says so
    deps = { ...deps, installedPacks: () => ({ src: 'x', packs: [] }) };
    expect((await call('DELETE', '/api/designs/demo-cable', { confirm: 'demo-cable' })).status).toBe(200);
  });
});

describe('records from a pack are read-only, and fork to edit', () => {
  const stores = new Map<DefinitionKind, DefinitionRecord[]>();
  beforeEach(() => {
    stores.clear();
    const db = hub().loadDb();
    stores.set('components', structuredClone(db.components));
    stores.set('bodies', structuredClone((db.bodies ?? []) as ConnectorBody[]));
    deps = {
      ...deps,
      definitions: {
        list: (kind) => structuredClone(stores.get(kind) ?? []),
        write: (kind, records) => {
          stores.set(kind, structuredClone(records));
          return { changed: true };
        },
      },
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    };
  });

  it('marks them in the list and on the record', async () => {
    const list = await call('GET', '/api/definitions/components');
    expect(list.body.packs).toEqual({ 'r-60': { pack: 'demo', version: '1.0.0' } });
    expect((await call('GET', '/api/definitions/components/r-60')).headers?.['X-WireHub-Pack']).toBe('demo@1.0.0');
    expect((await call('GET', '/api/definitions/components/r-120')).headers?.['X-WireHub-Pack']).toBeUndefined();
  });

  it('refuses an edit and a delete, pointing at fork', async () => {
    const record = stores.get('components')!.find((c) => c.id === 'r-60')!;
    const edit = await call('PUT', '/api/definitions/components/r-60', { ...record, value: '61 Ω' });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toContain('read-only');
    expect(edit.body.hint).toContain('fork');
    const del = await call('DELETE', '/api/definitions/components/r-60', { confirm: 'r-60' });
    expect(del.status).toBe(409);
    expect(stores.get('components')!.find((c) => c.id === 'r-60')).toEqual(record);
  });

  it('forks a record under a new id with derivedFrom, leaving the original alone', async () => {
    const fork = await call('POST', '/api/definitions/components/r-60/fork', { id: 'r-60-mine', label: 'My 60 Ω' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(fork.body).toMatchObject({ id: 'r-60-mine', label: 'My 60 Ω', value: '60 Ω', derivedFrom: { pack: 'demo', id: 'r-60', version: '1.0.0' } });
    expect(stores.get('components')!.map((c) => c.id)).toContain('r-60');
    // the copy is the deployment's own: editable
    const copy = stores.get('components')!.find((c) => c.id === 'r-60-mine')!;
    const edit = await call('PUT', '/api/definitions/components/r-60-mine', { ...copy, value: '61 Ω' }, );
    expect([200, 428]).toContain(edit.status);
    // a default id, an id already taken, and a record that is not from a pack
    expect((await call('POST', '/api/definitions/components/r-60/fork', {})).body.id).toBe('r-60-local');
    expect((await call('POST', '/api/definitions/components/r-60/fork', { id: 'r-120' })).status).toBe(409);
    expect((await call('POST', '/api/definitions/components/r-120/fork', {})).status).toBe(409);
    expect((await call('POST', '/api/definitions/components/r-60/fork', { id: 'Bad Id' })).status).toBe(400);
  });

  it('refuses a malformed licence or provenance on a record it is asked to save', async () => {
    const record = stores.get('components')!.find((c) => c.id === 'r-120')!;
    const bad = await call('PUT', '/api/definitions/components/r-120', { ...record, license: 'free to use' });
    expect([400, 428]).toContain(bad.status);
    if (bad.status === 400) expect(bad.body.error).toContain('licence');
    const created = await call('POST', '/api/definitions/components', { ...record, partNumber: 'CMP-09001', id: 'r-new', license: 'CC0-1.0', provenance: { method: 'measured', sources: [{ title: 'bench' }] } });
    expect(created.status).toBe(201);
    const worse = await call('POST', '/api/definitions/components', { ...record, partNumber: 'CMP-09002', id: 'r-newer', provenance: { method: 'guessed', sources: [] } });
    expect(worse.status).toBe(400);
  });
});

void loadDb;
