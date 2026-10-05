/**
 * Catalog packs in the file backend: the read-only layer and the installer
 * (`src/packs.ts`). Every case works in temporary directories built from the
 * starter catalog plus a small synthetic pack.
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateDb, validateDesign } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  catalogWithPacksSource,
  createCatalog,
  dataPath,
  fsCatalogSource,
  installPack,
  installPackLayer,
  installedPackSources,
  liveCatalogSource,
  localPartOf,
  layeredCatalogSource,
  planPackInstall,
  readInstalledPacks,
  readPackManifest,
} from '../src/index.ts';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

let work = '';
let catalogDir = '';
let packDir = '';

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'wirehub-packs-'));
  catalogDir = join(work, 'catalog');
  packDir = join(work, 'pack');
  cpSync(dataPath(''), catalogDir, { recursive: true });
  mkdirSync(join(packDir, 'vocab'), { recursive: true });
  mkdirSync(join(packDir, 'designs'), { recursive: true });
  writeFileSync(join(packDir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version: '1.0.0', license: 'CC0-1.0' }));
  writeFileSync(
    join(packDir, 'vocab/signals.json'),
    json({
      id: 'signals',
      label: 'Signals',
      src: 'demo pack',
      entries: [
        { id: 'can-h', label: 'CAN high', kind: 'data', aliases: ['CANH'], src: 'synthetic example: demo pack' },
        { id: 'can-l', label: 'CAN low', kind: 'data', aliases: ['CANL'], src: 'synthetic example: demo pack' },
      ],
    }),
  );
  writeFileSync(
    join(packDir, 'components.json'),
    json([{ id: 'r-60', label: '60 Ω resistor', kind: 'resistor', value: '60 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example: demo pack' }]),
  );
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('a pack read as a layer', () => {
  it('adds its records and vocabulary without touching the catalog', () => {
    const before = readFileSync(join(catalogDir, 'components.json'), 'utf8');
    const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(catalogDir), fsCatalogSource(packDir)]));
    const db = catalog.loadDb();
    expect(db.components.some((c) => c.id === 'r-60')).toBe(true);
    expect(db.vocab?.['signals']?.entries.some((e) => e.id === 'can-h')).toBe(true);
    expect(db.vocab?.['signals']?.entries.some((e) => e.id === 'gnd')).toBe(true);
    expect(validateDb(db).filter((i) => i.severity === 'error')).toEqual([]);
    for (const id of catalog.listDesignIds()) {
      expect(validateDesign(catalog.loadDesign(id), db).filter((i) => i.severity === 'error'), id).toEqual([]);
    }
    expect(readFileSync(join(catalogDir, 'components.json'), 'utf8')).toBe(before);
  });

  it('lets the first layer win when both have a record', () => {
    writeFileSync(join(packDir, 'components.json'), json([{ id: 'r-120', label: 'pack copy', kind: 'resistor', terminals: [{ id: 'a' }, { id: 'b' }], src: 'x' }]));
    const db = createCatalog(layeredCatalogSource([fsCatalogSource(catalogDir), fsCatalogSource(packDir)])).loadDb();
    expect(db.components.find((c) => c.id === 'r-120')?.label).not.toBe('pack copy');
  });
});

describe('installing a pack', () => {
  it('appends the new records, records the install, and is idempotent', () => {
    const plan = installPack(catalogDir, packDir);
    expect(plan.conflicts).toEqual([]);
    expect(plan.added['components.json']).toEqual(['r-60']);
    expect(plan.added['vocab/signals.json']).toEqual(['can-h', 'can-l']);
    const components = JSON.parse(readFileSync(join(catalogDir, 'components.json'), 'utf8')) as { id: string }[];
    expect(components.at(-1)?.id).toBe('r-60');
    expect(readInstalledPacks(catalogDir).packs).toEqual([
      { id: 'demo', version: '1.0.0', license: 'CC0-1.0', added: plan.added },
    ]);
    const after = readFileSync(join(catalogDir, 'components.json'), 'utf8');
    expect(installPack(catalogDir, packDir).alreadyInstalled).toBe(true);
    expect(readFileSync(join(catalogDir, 'components.json'), 'utf8')).toBe(after);
    expect(validateDb(createCatalog(fsCatalogSource(catalogDir)).loadDb()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('refuses a record whose id the catalog uses for something else, and writes nothing', () => {
    writeFileSync(join(packDir, 'components.json'), json([{ id: 'r-120', label: 'not the same', kind: 'resistor', terminals: [{ id: 'a' }, { id: 'b' }], src: 'x' }]));
    expect(planPackInstall(catalogDir, packDir).conflicts).toEqual(["components.json: 'r-120' already exists with different content"]);
    const before = readFileSync(join(catalogDir, 'vocab/signals.json'), 'utf8');
    expect(() => installPack(catalogDir, packDir)).toThrow(/cannot be installed/);
    expect(readFileSync(join(catalogDir, 'vocab/signals.json'), 'utf8')).toBe(before);
  });

  it('says plainly when a directory is not a pack', () => {
    expect(() => readPackManifest(catalogDir)).toThrow(/is not a catalog pack/);
  });
});

describe('a pack installed as a layer in a packs directory', () => {
  const packsDir = (): string => join(work, 'packs');

  it('copies the pack beside the catalog, records it, and leaves the catalog untouched', () => {
    const before = readFileSync(join(catalogDir, 'components.json'), 'utf8');
    const result = installPackLayer(catalogDir, packsDir(), packDir);
    expect(result.alreadyInstalled).toBe(false);
    expect(result.added['components.json']).toEqual(['r-60']);
    expect(readInstalledPacks(packsDir()).packs.map((p) => `${p.id}@${p.version}`)).toEqual(['demo@1.0.0']);
    expect(readFileSync(join(packsDir(), 'demo', 'components.json'), 'utf8')).toBe(readFileSync(join(packDir, 'components.json'), 'utf8'));
    expect(readFileSync(join(catalogDir, 'components.json'), 'utf8')).toBe(before);
    const db = createCatalog(catalogWithPacksSource(catalogDir, packsDir())).loadDb();
    expect(db.components.some((c) => c.id === 'r-60')).toBe(true);
    expect(db.vocab?.['signals']?.entries.some((e) => e.id === 'can-h')).toBe(true);
    expect(validateDb(db).filter((i) => i.severity === 'error')).toEqual([]);
    expect(installPackLayer(catalogDir, packsDir(), packDir).alreadyInstalled).toBe(true);
  });

  it('sees a pack installed after the source was made', () => {
    const source = catalogWithPacksSource(catalogDir, packsDir());
    expect(source.read('components.json')).not.toContain('r-60');
    installPackLayer(catalogDir, packsDir(), packDir);
    expect(source.read('components.json')).toContain('r-60');
  });

  it('refuses a pack that clashes with the catalog or another installed pack, writing nothing', () => {
    const other = join(work, 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'wirehub-pack.json'), json({ format: 1, id: 'other', name: 'Other', version: '1.0.0', license: 'CC0-1.0' }));
    writeFileSync(join(other, 'components.json'), json([{ id: 'r-60', label: 'not the same', kind: 'resistor', terminals: [], src: 'x' }]));
    installPackLayer(catalogDir, packsDir(), packDir);
    expect(() => installPackLayer(catalogDir, packsDir(), other)).toThrow(/'r-60' already exists/);
    expect(readInstalledPacks(packsDir()).packs.map((p) => p.id)).toEqual(['demo']);
  });

  it('replaces the layer with another version of the same pack', () => {
    installPackLayer(catalogDir, packsDir(), packDir);
    writeFileSync(join(packDir, 'wirehub-pack.json'), json({ format: 1, id: 'demo', name: 'Demo', version: '1.1.0', license: 'CC0-1.0' }));
    writeFileSync(join(packDir, 'components.json'), json([{ id: 'r-60', label: '60 Ω resistor, 1 %', kind: 'resistor', value: '60 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example: demo pack' }]));
    expect(installPackLayer(catalogDir, packsDir(), packDir).alreadyInstalled).toBe(false);
    expect(readInstalledPacks(packsDir()).packs.map((p) => `${p.id}@${p.version}`)).toEqual(['demo@1.1.0']);
    const db = createCatalog(catalogWithPacksSource(catalogDir, packsDir())).loadDb();
    expect(db.components.find((c) => c.id === 'r-60')?.label).toBe('60 Ω resistor, 1 %');
  });

  it('localPartOf leaves out what a pack supplies unchanged, and keeps edits and new records', () => {
    installPackLayer(catalogDir, packsDir(), packDir);
    const packs = installedPackSources(packsDir());
    const merged = JSON.parse(catalogWithPacksSource(catalogDir, packsDir()).read('components.json') as string) as { id: string; label: string }[];
    const local = JSON.parse(readFileSync(join(catalogDir, 'components.json'), 'utf8')) as unknown[];
    // saved unchanged: exactly the catalog's own records
    expect(localPartOf('components.json', merged, packs, true)).toEqual(local);
    // a new record stays; an edited pack record stays (it shadows the pack's)
    const edited = merged.map((c) => (c.id === 'r-60' ? { ...c, label: 'mine' } : c));
    const withNew = [...edited, { id: 'r-1k', label: '1 kΩ' }];
    const out = localPartOf('components.json', withNew, packs, true) as { id: string; label: string }[];
    expect(out.map((c) => c.id).slice(-2)).toEqual(['r-60', 'r-1k']);
    expect(out.length).toBe(local.length + 2);
    // vocabulary lists by entry id
    const signals = JSON.parse(catalogWithPacksSource(catalogDir, packsDir()).read('vocab/signals.json') as string) as { entries: { id: string }[] };
    const localSignals = localPartOf('vocab/signals.json', signals, packs, true) as { entries: { id: string }[] };
    expect(localSignals.entries.some((e) => e.id === 'can-h')).toBe(false);
    expect(localSignals.entries.length).toBe(signals.entries.length - 2);
    // a file only a pack has, saved unchanged: nothing to write
    mkdirSync(join(packsDir(), 'demo', 'designs'), { recursive: true });
    writeFileSync(join(packsDir(), 'demo', 'designs', 'demo-only.json'), json({ id: 'demo-only' }));
    expect(localPartOf('designs/demo-only.json', { id: 'demo-only' }, installedPackSources(packsDir()), false)).toBeUndefined();
    expect(localPartOf('designs/demo-only.json', { id: 'demo-only', label: 'edited' }, installedPackSources(packsDir()), false)).toEqual({ id: 'demo-only', label: 'edited' });
  });

  it('the live catalog layers packs only where WIREHUB_PACKS_DIR says', () => {
    const before = process.env['WIREHUB_PACKS_DIR'];
    try {
      delete process.env['WIREHUB_PACKS_DIR'];
      expect(liveCatalogSource().read('components.json')).toBe(readFileSync(dataPath('components.json'), 'utf8'));
      // a packs directory with the demo pack installed against the starter
      installPackLayer(dataPath(''), packsDir(), packDir);
      process.env['WIREHUB_PACKS_DIR'] = packsDir();
      expect(liveCatalogSource().read('components.json')).toContain('r-60');
      // derived files beside the packs sit above the catalog
      mkdirSync(join(packsDir(), 'derived', 'tags'), { recursive: true });
      writeFileSync(join(packsDir(), 'derived', 'tags', 'report.md'), 'derived\n');
      expect(liveCatalogSource().read('tags/report.md')).toBe('derived\n');
    } finally {
      if (before === undefined) delete process.env['WIREHUB_PACKS_DIR'];
      else process.env['WIREHUB_PACKS_DIR'] = before;
    }
  });
});
