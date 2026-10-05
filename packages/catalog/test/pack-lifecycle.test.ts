/**
 * The pack lifecycle on directories (`src/pack-lifecycle.ts`): update with a
 * record-level diff, disable, references. Layered (`packs/<id>/`) and merged
 * (records in the catalog's own files) installs behave the same.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyPackDisable,
  applyPackUpdate,
  catalogWithPacksSource,
  createCatalog,
  dataPath,
  diffRecords,
  fieldChanges,
  fsCatalogSource,
  installPack,
  installPackLayer,
  installedAcross,
  planPackDisable,
  planPackUpdate,
  readInstalledPacks,
} from '../src/index.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const read = (path: string): string => readFileSync(path, 'utf8');

const signal = (id: string, label: string) => ({ id, label, kind: 'data', src: 'synthetic example: demo pack' });
const resistor = (id: string, value: string) => ({ id, label: `${value} resistor`, kind: 'resistor', value, terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example: demo pack' });
const iface = (signalH: string) => ({
  id: 'can-de9',
  label: 'CAN on DE-9',
  bodies: ['de9-male'],
  pins: { '2': { signal: 'can-l' }, '7': { signal: signalH } },
  src: 'synthetic example: demo pack',
});

/** Write a demo pack version into `dir`. */
function writePack(dir: string, version: string, spec: { r60: string; extra?: boolean; dropCanL?: boolean; license?: string }): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'vocab'), { recursive: true });
  writeFileSync(join(dir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version, license: spec.license ?? 'CC0-1.0' }));
  writeFileSync(
    join(dir, 'vocab/signals.json'),
    json({ id: 'signals', label: 'Signals', src: 'demo pack', entries: [signal('can-h', 'CAN high'), ...(spec.dropCanL === true ? [] : [signal('can-l', 'CAN low')])] }),
  );
  writeFileSync(join(dir, 'components.json'), json([resistor('r-60', spec.r60), ...(spec.extra === true ? [resistor('r-62', '62 Ω')] : [])]));
  writeFileSync(join(dir, 'interfaces.json'), json([iface('can-h')]));
}

let work = '';
let catalogDir = '';
let packsDir = '';
let v1 = '';
let v2 = '';
let v3 = '';

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'wirehub-lifecycle-'));
  catalogDir = join(work, 'catalog');
  packsDir = join(work, 'packs');
  cpSync(dataPath(''), catalogDir, { recursive: true });
  v1 = join(work, 'demo-1');
  v2 = join(work, 'demo-2');
  v3 = join(work, 'demo-3');
  writePack(v1, '1.0.0', { r60: '60 Ω' });
  writePack(v2, '1.1.0', { r60: '62 Ω', extra: true });
  // a major version that drops a record and an interface's signal
  writePack(v3, '2.0.0', { r60: '60 Ω', dropCanL: true });
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

const layered = () => catalogWithPacksSource(catalogDir, packsDir);

describe('diffRecords and fieldChanges', () => {
  it('names the fields that differ, objects recursively', () => {
    expect(fieldChanges({ a: 1, p: { x: 1, y: 2 }, gone: true }, { a: 1, p: { x: 1, y: 3 }, new: 'n' })).toEqual([
      { path: 'p.y', before: 2, after: 3 },
      { path: 'gone', before: true },
      { path: 'new', after: 'n' },
    ]);
  });
});

describe('update with a diff (layered)', () => {
  it('shows added, changed (field by field) and unchanged records, then applies them', () => {
    installPackLayer(catalogDir, packsDir, v1);
    const plan = planPackUpdate(layered(), readInstalledPacks(packsDir).packs, v2);
    expect(plan.direction).toBe('upgrade');
    expect(plan.major).toBe(false);
    expect(plan.diff.added.map((r) => `${r.file}#${r.id}`)).toEqual(['components.json#r-62']);
    expect(plan.diff.changed.map((r) => `${r.file}#${r.id}`)).toEqual(['components.json#r-60']);
    expect(plan.diff.changed[0]?.fields).toEqual([
      { path: 'label', before: '60 Ω resistor', after: '62 Ω resistor' },
      { path: 'value', before: '60 Ω', after: '62 Ω' },
    ]);
    expect(plan.diff.removed).toEqual([]);
    expect(plan.diff.unchanged).toBe(3); // can-h, can-l and the interface
    expect(plan.ok).toBe(true);

    applyPackUpdate(catalogDir, packsDir, v2, plan, 'layer');
    const db = createCatalog(layered()).loadDb();
    expect(db.components.find((c) => c.id === 'r-60')?.value).toBe('62 Ω');
    expect(db.components.some((c) => c.id === 'r-62')).toBe(true);
    expect(readInstalledPacks(packsDir).packs.map((p) => `${p.id}@${p.version}`)).toEqual(['demo@1.1.0']);
  });

  it('flags a major version and a licence change', () => {
    installPackLayer(catalogDir, packsDir, v1);
    writePack(v3, '2.0.0', { r60: '60 Ω', license: 'CC-BY-4.0' });
    const plan = planPackUpdate(layered(), readInstalledPacks(packsDir).packs, v3);
    expect(plan.major).toBe(true);
    expect(plan.licenseChanged).toBe(true);
  });

  it('retires a dropped record that something outside the pack still uses: kept, as the deployment\'s own', () => {
    installPackLayer(catalogDir, packsDir, v1);
    // a local interface of the shop's uses the pack's can-l signal
    const local = JSON.parse(read(join(catalogDir, 'interfaces.json'))) as unknown[];
    local.push({ id: 'my-can', label: 'My CAN', bodies: ['de9-female'], pins: { '2': { signal: 'can-l' } }, src: 'local' });
    writeFileSync(join(catalogDir, 'interfaces.json'), json(local));
    const plan = planPackUpdate(layered(), readInstalledPacks(packsDir).packs, v3);
    expect(plan.diff.removed.map((r) => r.id)).toEqual(['can-l']);
    expect(plan.ok).toBe(true);
    expect(plan.retired.map((r) => `${r.file}#${r.id}`)).toEqual(['vocab/signals.json#can-l']);
    expect(plan.references.map((r) => `${r.from.id} ${r.field} -> ${r.to}`)).toEqual(['my-can pins.2.signal -> can-l']);
    expect('retiredRecords' in plan).toBe(true);
    applyPackUpdate(catalogDir, packsDir, v3, plan, 'layer');
    // the signal is still there (in the catalog's own vocabulary now), the pack no longer owns it
    const kept = JSON.parse(read(join(catalogDir, 'vocab/signals.json'))) as { entries: { id: string }[] };
    expect(kept.entries.map((e) => e.id)).toContain('can-l');
    expect(readInstalledPacks(packsDir).packs[0]?.added['vocab/signals.json']).not.toContain('can-l');
    expect(createCatalog(layered()).loadDb().interfaces.some((i) => i.id === 'my-can')).toBe(true);
  });

  it('refuses an update whose new records clash with a different local record', () => {
    installPackLayer(catalogDir, packsDir, v1);
    const local = JSON.parse(read(join(catalogDir, 'components.json'))) as unknown[];
    local.push(resistor('r-62', 'local 62'));
    writeFileSync(join(catalogDir, 'components.json'), json(local));
    const plan = planPackUpdate(layered(), readInstalledPacks(packsDir).packs, v2);
    expect(plan.conflicts).toEqual(["components.json: 'r-62' already exists with different content"]);
    expect(plan.ok).toBe(false);
  });

  it('blocks an update that would add library errors', () => {
    installPackLayer(catalogDir, packsDir, v1);
    // 1.1.0 points the interface at a signal nobody defines
    writePack(v2, '1.1.0', { r60: '62 Ω' });
    writeFileSync(join(v2, 'interfaces.json'), json([iface('no-such-signal')]));
    const plan = planPackUpdate(layered(), readInstalledPacks(packsDir).packs, v2);
    expect(plan.issues.map((i) => i.code)).toContain('vocab-unknown');
    expect(plan.ok).toBe(false);
  });
});

describe('update (merged into the catalog)', () => {
  it('rewrites the pack records in place, keeping file order, and the install record', () => {
    installPack(catalogDir, v1);
    const before = JSON.parse(read(join(catalogDir, 'components.json'))) as { id: string }[];
    const at = before.findIndex((c) => c.id === 'r-60');
    const installed = installedAcross(catalogDir, undefined);
    expect(installed.where.get('demo')).toBe('merged');
    const plan = planPackUpdate(fsCatalogSource(catalogDir), installed.packs, v2);
    expect(plan.ok).toBe(true);
    applyPackUpdate(catalogDir, undefined, v2, plan, 'merged');
    const after = JSON.parse(read(join(catalogDir, 'components.json'))) as { id: string; value?: string }[];
    expect(after.findIndex((c) => c.id === 'r-60')).toBe(at);
    expect(after.find((c) => c.id === 'r-60')?.value).toBe('62 Ω');
    expect(after.at(-1)?.id).toBe('r-62');
    expect(readInstalledPacks(catalogDir).packs[0]).toMatchObject({ id: 'demo', version: '1.1.0' });
    expect(readInstalledPacks(catalogDir).packs[0]?.added['components.json']).toEqual(['r-60', 'r-62']);
    // and a downgrade goes back through the same path
    const back = planPackUpdate(fsCatalogSource(catalogDir), readInstalledPacks(catalogDir).packs, v1);
    expect(back.direction).toBe('downgrade');
    expect(back.diff.removed.map((r) => r.id)).toEqual(['r-62']);
    applyPackUpdate(catalogDir, undefined, v1, back, 'merged');
    expect((JSON.parse(read(join(catalogDir, 'components.json'))) as { id: string }[]).some((c) => c.id === 'r-62')).toBe(false);
  });
});

describe('disable', () => {
  it('removes a layer when nothing outside the pack uses its records', () => {
    installPackLayer(catalogDir, packsDir, v1);
    const plan = planPackDisable(layered(), readInstalledPacks(packsDir).packs, 'demo');
    expect(plan.ok).toBe(true);
    expect(plan.records.map((r) => r.id).sort()).toEqual(['can-de9', 'can-h', 'can-l', 'r-60']);
    applyPackDisable(catalogDir, packsDir, 'demo', plan, 'layer');
    expect(existsSync(join(packsDir, 'demo'))).toBe(false);
    expect(readInstalledPacks(packsDir).packs).toEqual([]);
    const db = createCatalog(layered()).loadDb();
    expect(db.components.some((c) => c.id === 'r-60')).toBe(false);
  });

  it('refuses and lists the references when a record outside the pack uses one', () => {
    installPackLayer(catalogDir, packsDir, v1);
    const kits = JSON.parse(read(join(catalogDir, 'kits.json'))) as unknown[];
    kits.push({ id: 'kit-r60', label: 'R kit', sku: 'KIT-9', contents: [{ part: { kind: 'component', def: 'r-60' }, qty: 1, src: 'local' }], src: 'local' });
    writeFileSync(join(catalogDir, 'kits.json'), json(kits));
    const plan = planPackDisable(layered(), readInstalledPacks(packsDir).packs, 'demo');
    expect(plan.ok).toBe(false);
    expect(plan.references.map((r) => `${r.from.file}#${r.from.id} ${r.field} -> ${r.to}`)).toEqual(['kits.json#kit-r60 contents[0].part.def -> r-60']);
  });

  it('removes merged records and an emptied vocabulary file, leaving the others', () => {
    installPack(catalogDir, v1);
    const signals = JSON.parse(read(join(catalogDir, 'vocab/signals.json'))) as { entries: { id: string }[] };
    expect(signals.entries.some((e) => e.id === 'can-h')).toBe(true);
    const plan = planPackDisable(fsCatalogSource(catalogDir), readInstalledPacks(catalogDir).packs, 'demo');
    expect(plan.ok).toBe(true);
    applyPackDisable(catalogDir, undefined, 'demo', plan, 'merged');
    const after = JSON.parse(read(join(catalogDir, 'vocab/signals.json'))) as { entries: { id: string }[] };
    expect(after.entries.some((e) => e.id === 'can-h')).toBe(false);
    expect(after.entries.some((e) => e.id === 'gnd')).toBe(true);
    expect(read(join(catalogDir, 'components.json'))).toBe(read(join(dataPath(''), 'components.json')));
    expect(read(join(catalogDir, 'interfaces.json'))).toBe(read(join(dataPath(''), 'interfaces.json')));
  });

  it('a record identical to one already there is not the pack\'s: disabling leaves it', () => {
    // the starter already has r-120 exactly as the pack says
    const starter = JSON.parse(read(join(catalogDir, 'components.json'))) as { id: string }[];
    const r120 = starter.find((c) => c.id === 'r-120');
    writePack(v1, '1.0.0', { r60: '60 Ω' });
    writeFileSync(join(v1, 'components.json'), json([resistor('r-60', '60 Ω'), r120]));
    installPackLayer(catalogDir, packsDir, v1);
    const plan = planPackDisable(layered(), readInstalledPacks(packsDir).packs, 'demo');
    expect(plan.records.map((r) => r.id)).not.toContain('r-120');
    applyPackDisable(catalogDir, packsDir, 'demo', plan, 'layer');
    expect(createCatalog(layered()).loadDb().components.some((c) => c.id === 'r-120')).toBe(true);
  });
});

describe('diffRecords', () => {
  it('is empty for identical sets', () => {
    const map = new Map([['a#x', { file: 'a', id: 'x', record: { id: 'x' } }]]);
    expect(diffRecords(map, map)).toEqual({ added: [], changed: [], removed: [], unchanged: 1 });
  });
});
