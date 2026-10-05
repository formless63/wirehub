/**
 * The automotive module against the WireHub base: the pack validates over
 * the starter catalog, installs cleanly, and teaches the base readers its
 * signal words.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, installPack, layeredCatalogSource, readPackManifest } from '@wirehub/catalog';
import { roleOfLabels } from '@wirehub/editor-react';
import { crimpListTable, deriveBom, renderBuildSheet } from '@wirehub/docs';
import { cavityIssues, fillCavities, signalFromLabel, validateDb, validateDesign, withCavities, type CableDesign, type Db } from '@wirehub/model';
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
      expect(installPack(work, packDir).added['connectors.json']).toEqual(['obd2-male', 'sealed-3-female-numbered', 'sealed-3-male-numbered']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('teaches the readers its words', () => {
    expect(roleOfLabels(db, ['CAN H'])?.role).toBe('can-h');
    expect(roleOfLabels(db, ['CANL'])?.role).toBe('can-l');
    expect(signalFromLabel('Battery +', db)).toBe('power');
  });

  describe('the sealed connector family', () => {
    const lead = JSON.parse(readFileSync(join(packDir, 'designs/sealed-sensor-lead.json'), 'utf8')) as CableDesign;

    it('the sensor lead validates with no warnings: contacts in range, seals on every wire, cavity 3 plugged', () => {
      expect(validateDesign(lead, db)).toEqual([]);
    });

    it('the BOM counts contacts, seals and plugs per cavity, and no tool', () => {
      const lines = deriveBom(lead, db).lines.filter((l) => l.category === 'termination');
      const qty = (ref: string): number => lines.filter((l) => l.ref === ref).reduce((n, l) => n + l.qty, 0);
      expect(qty('sealed-1-5-pin-0-5-1')).toBe(2);
      expect(qty('sealed-1-5-socket-0-5-1')).toBe(2);
      expect(qty('sealed-1-5-seal-1-2-1-6')).toBe(4);
      expect(qty('sealed-1-5-cavity-plug')).toBe(2);
      expect(lines.some((l) => l.ref === 'sealed-1-5-crimp-tool')).toBe(false);
    });

    it('the build sheet lists contact, seal, strip, crimp height and tool per cavity', () => {
      const html = renderBuildSheet(lead, db, { depictions: false });
      expect(html).toContain('Crimp — x1');
      expect(html).toContain('Pin contact, 1.5 mm class');
      expect(html).toContain('4.5 mm');
      expect(html).toContain('1.15 mm × 1.7');
      expect(html).toContain('Plug unused cavities');
      expect(html).toContain('Hand crimp tool, 1.5 mm class');
      expect(crimpListTable(lead, db).rows).toHaveLength(6);
    });

    it('fill all by wire gauge rebuilds the same assignments from the wires', () => {
      let bare = withCavities(withCavities(lead, 'x1', []), 'x2', []);
      expect(cavityIssues(bare, db).map((i) => i.code)).toContain('cavity-unplugged');
      bare = fillCavities(fillCavities(bare, db, 'x1'), db, 'x2');
      expect(bare.instances.connectors).toEqual(lead.instances.connectors);
    });

    it('a wire out of the contact range raises a warning', () => {
      const thin = withCavities(lead, 'x2', [
        { pin: '1', contact: 'sealed-1-5-socket-0-2-0-35', seal: 'sealed-1-5-seal-1-2-1-6' },
        { pin: '2', contact: 'sealed-1-5-socket-0-5-1', seal: 'sealed-1-5-seal-1-2-1-6' },
        { pin: '3', plug: 'sealed-1-5-cavity-plug' },
      ]);
      const issues = validateDesign(thin, db);
      expect(issues.map((i) => [i.code, i.severity])).toEqual([['contact-wire-range', 'warning']]);
    });
  });
});
