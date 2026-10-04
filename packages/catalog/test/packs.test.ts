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
  createCatalog,
  dataPath,
  fsCatalogSource,
  installPack,
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
