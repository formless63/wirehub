/**
 * The automotive module against the WireHub base: the pack validates over
 * the starter catalog, installs cleanly, and teaches the base readers its
 * signal words.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, installPack, layeredCatalogSource, readPackManifest } from '@wirehub/catalog';
import { roleOfLabels } from '@wirehub/editor-react';
import { signalFromLabel, validateDb, type Db } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { AUTOMOTIVE_PACK, automotive } from '../src/index.ts';

const packDir = fileURLToPath(AUTOMOTIVE_PACK);
const db: Db = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath('')), fsCatalogSource(packDir)])).loadDb();

describe('the automotive module', () => {
  it('is a domain module with one pack', () => {
    expect(createRegistry([automotive]).domains().map((m) => m.id)).toEqual(['automotive']);
    expect(readPackManifest(packDir)).toMatchObject({ id: 'automotive', license: 'CC0-1.0' });
  });

  it('validates over the starter catalog', () => {
    expect(validateDb(db).filter((i) => i.severity === 'error')).toEqual([]);
    const obd = db.connectors.find((c) => c.id === 'obd2-male');
    expect(obd?.pins.find((p) => p.id === '6')?.signal).toBe('can-h');
    expect(obd?.pins.find((p) => p.id === '16')?.signal).toBe('pwr-battery');
  });

  it('installs into a copy of the starter catalog with no conflicts', () => {
    const work = mkdtempSync(join(tmpdir(), 'wirehub-auto-'));
    try {
      cpSync(dataPath(''), work, { recursive: true });
      expect(installPack(work, packDir).added['connectors.json']).toEqual(['obd2-male']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('teaches the readers its words', () => {
    expect(roleOfLabels(db, ['CAN H'])?.role).toBe('can-h');
    expect(roleOfLabels(db, ['CANL'])?.role).toBe('can-l');
    expect(signalFromLabel('Battery +', db)).toBe('power');
  });
});
