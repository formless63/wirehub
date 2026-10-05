/**
 * The PC & serial module against the WireHub base: its pack validates over
 * the starter catalog and installs into it cleanly, and once its vocabulary
 * is in, the base's generic readers — trace, the continuity spec, the
 * wizard's label reading — understand RS-232, RS-485 and USB without a line
 * of serial code in the base. (These cases were the base's own tests while
 * the examples lived in the starter catalog.)
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, installPack, layeredCatalogSource, readPackManifest } from '@wirehub/catalog';
import { deriveTestSpec, type PathCheck, type TestSpec } from '@wirehub/docs';
import { roleOfLabels } from '@wirehub/editor-react';
import { reachedTerminal, trace, validateDb, validateDesign, type CableDesign, type Db, type TerminalRef } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { PC_SERIAL_PACK, pcSerial } from '../src/index.ts';

const packDir = fileURLToPath(PC_SERIAL_PACK);
const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'pc-serial')]));
const db: Db = catalog.loadDb();
const base: Db = createCatalog(fsCatalogSource(dataPath(''), 'starter')).loadDb();
const design = (id: string): CableDesign => catalog.loadDesign(id);

function passages(d: CableDesign, from: TerminalRef, to: string): string[] {
  const step = reachedTerminal(trace(d, db, from), to);
  expect(step, `${from.instance}:${from.terminal} should reach ${to}`).toBeDefined();
  return (step?.passages ?? []).map((p) => p.description);
}

const path = (spec: TestSpec, from: string, to: string): PathCheck => {
  const found = spec.pathChecks.find((c) => (c.from.key === from && c.to.key === to) || (c.from.key === to && c.to.key === from));
  expect(found, `expected a path check between ${from} and ${to}`).toBeDefined();
  return found as PathCheck;
};

describe('the module', () => {
  it('is an optional domain module, unticked at setup, with one CC0 pack', () => {
    const registry = createRegistry([pcSerial]);
    expect(registry.domains().map((m) => m.id)).toEqual(['pc-serial']);
    expect(pcSerial.setup).not.toHaveProperty('suggested');
    expect(registry.catalogPacks().map((p) => `${p.module}:${p.id}@${p.version}`)).toEqual(['pc-serial:pc-serial@0.2.0']);
    expect(readPackManifest(packDir)).toMatchObject({ id: 'pc-serial', version: '0.2.0', license: 'CC0-1.0' });
  });

  it('keeps serial out of the base: no RS-232, RS-485 or USB record without the pack', () => {
    const signals = (base.vocab?.['signals']?.entries ?? []).map((e) => e.id);
    for (const id of ['rs232-txd', 'rs485-a', 'usb-dp']) expect(signals, id).not.toContain(id);
    expect(base.connectors.some((c) => c.id === 'de9-female-rs232' || c.family === 'usb-a')).toBe(false);
  });
});

describe('the pack over the starter catalog', () => {
  it('validates, and every design is clean', () => {
    expect(validateDb(db)).toEqual([]);
    for (const id of ['db9-null-modem', 'rs485-de9-terminal-board', 'usb-a-led-lead']) {
      expect(catalog.listDesignIds()).toContain(id);
      expect(validateDesign(design(id), db), id).toEqual([]);
    }
  });

  it('installs into a copy of the starter catalog with no conflicts, once', () => {
    const work = mkdtempSync(join(tmpdir(), 'wirehub-serial-'));
    try {
      cpSync(dataPath(''), work, { recursive: true });
      const plan = installPack(work, packDir);
      expect(plan.conflicts).toEqual([]);
      expect(plan.added['connectors.json']).toEqual(['de9-female-rs232', 'de9-male-profibus', 'usb-a-plug']);
      const installed = createCatalog(fsCatalogSource(work));
      for (const id of ['db9-null-modem', 'rs485-de9-terminal-board', 'usb-a-led-lead']) {
        expect(validateDesign(installed.loadDesign(id), installed.loadDb()), id).toEqual([]);
      }
      expect(installPack(work, packDir).alreadyInstalled).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('composes the RS-232 DTE pinout on the base DE-9 body', () => {
    const de9 = db.connectors.find((c) => c.id === 'de9-female-rs232');
    expect(de9?.pins.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'shell']);
    expect(de9?.pins.find((p) => p.id === '3')?.signal).toBe('rs232-txd');
  });
});

describe('trace', () => {
  it('the null modem crosses TXD to RXD, runs ground straight and loops RTS back to CTS at its own end', () => {
    const d = design('db9-null-modem');
    expect(passages(d, { instance: 'j1', terminal: '3' }, 'j2:2')).toEqual([]);
    expect(passages(d, { instance: 'j1', terminal: '2' }, 'j2:3')).toEqual([]);
    expect(passages(d, { instance: 'j1', terminal: '5' }, 'j2:5')).toEqual([]);
    const rts = trace(d, db, { instance: 'j1', terminal: '7' });
    expect(reachedTerminal(rts, 'j1:8')).toBeDefined();
    expect(reachedTerminal(rts, 'j2:8')).toBeUndefined();
  });

  it('the RS-485 cable reaches the board, and A reaches B across the 120 Ω termination', () => {
    const d = design('rs485-de9-terminal-board');
    expect(passages(d, { instance: 'j1', terminal: '3' }, 'u1:tb.2')).toEqual([]);
    const via = passages(d, { instance: 'j1', terminal: '8' }, 'j1:3');
    expect(via).toHaveLength(1);
    expect(via[0]).toContain('120 Ω');
    expect(passages(d, { instance: 'j1', terminal: 'shell' }, 'u1:tb.4')).toEqual([]);
  });

  it('the USB LED lead takes VBUS through its series resistor and GND straight through', () => {
    const d = design('usb-a-led-lead');
    const via = passages(d, { instance: 'j1', terminal: '1' }, 'j2:1');
    expect(via).toHaveLength(1);
    expect(via[0]).toContain('r1');
    expect(passages(d, { instance: 'j1', terminal: '4' }, 'j2:2')).toEqual([]);
  });
});

describe('the continuity spec', () => {
  it('reads 120 Ω between A and B on the RS-485 cable, and 150 Ω on the USB LED lead', () => {
    expect(path(deriveTestSpec(design('rs485-de9-terminal-board'), db), 'j1:8', 'j1:3').behaviour.ohms).toBe(120);
    const led = path(deriveTestSpec(design('usb-a-led-lead'), db), 'j1:1', 'j2:1');
    expect(led.behaviour.verdict).toBe('resistive');
    expect(led.behaviour.ohms).toBe(150);
  });

  it('finds nothing wrong with the pack designs, and catches VBUS shorted to ground', () => {
    for (const id of ['db9-null-modem', 'rs485-de9-terminal-board', 'usb-a-led-lead']) {
      expect(deriveTestSpec(design(id), db).violations.map((c) => c.id), id).toEqual([]);
    }
    const d = design('usb-a-led-lead');
    const shorted: CableDesign = { ...d, joints: [...d.joints, { a: { instance: 'j1', terminal: '1' }, b: { instance: 'j1', terminal: '4' }, note: 'DELIBERATE FAULT' }] };
    expect(deriveTestSpec(shorted, db).violations.length).toBeGreaterThan(0);
  });
});

describe('the base readers, taught by the vocabulary', () => {
  it('the wizard reads serial labels; the base alone does not', () => {
    expect(roleOfLabels(db, ['TXD'])?.role).toBe('rs232-txd');
    expect(roleOfLabels(db, ['D+'])?.role).toBe('usb-dp');
    expect(roleOfLabels(base, ['TXD'])).toBeUndefined();
  });
});
