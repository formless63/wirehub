/**
 * The AV / video module against the WireHub base: its pack validates over
 * the starter catalog and installs into it cleanly, and once its vocabulary
 * is in, the base's generic readers — the wizard, the compatibility rules,
 * the tag proposals, the continuity spec — understand video without a line
 * of video code in the base.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCatalog,
  dataPath,
  fsCatalogSource,
  installPack,
  layeredCatalogSource,
  readPackManifest,
} from '@wirehub/catalog';
import { pinSignal } from '@wirehub/catalog/src/tags/classify.ts';
import { deriveTestSpec, renderWireSpecSheet } from '@wirehub/docs';
import { initialWizardState, planCable, readingsOfLabels, roleOfLabels } from '@wirehub/editor-react';
import { connectorArt, crossSectionLayout, endFaceLayout, registerConnectorArt } from '@wirehub/layout';
import { findWire, signalFromLabel, validateDb, validateDesign, type CableDesign, type Db, type Joint } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { AV_VIDEO_PACK, avVideo } from '../src/index.ts';

const packDir = fileURLToPath(AV_VIDEO_PACK);
const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'av-video')]));
const db: Db = catalog.loadDb();
const base: Db = createCatalog(fsCatalogSource(dataPath(''), 'starter')).loadDb();
const errors = (issues: { severity: string }[]): unknown[] => issues.filter((i) => i.severity === 'error');

const jointKey = (joint: Joint): string => {
  const side = (ref: Joint['a']): string => `${ref.instance}.${ref.terminal}${ref.end === undefined ? '' : `@${ref.end}`}`;
  return [side(joint.a), side(joint.b)].sort().join(' — ');
};

describe('the module', () => {
  it('is a domain module with one pack, and a valid manifest entry', () => {
    const registry = createRegistry([avVideo]);
    expect(registry.domains().map((m) => m.id)).toEqual(['av-video']);
    expect(registry.catalogPacks().map((p) => `${p.module}:${p.id}@${p.version}`)).toEqual(['av-video:av-video@0.1.0']);
    expect(readPackManifest(packDir)).toMatchObject({ id: 'av-video', version: '0.1.0', license: 'CC0-1.0' });
  });

  it('keeps video out of the base: no video signal or VGA record without the pack', () => {
    expect(base.vocab?.['signals']?.entries.some((e) => e.id === 'video-r' || e.id === 'csync')).toBe(false);
    expect(base.connectors.some((c) => c.family === 'hd15' || c.family === 'scart')).toBe(false);
  });
});

describe('the pack over the starter catalog', () => {
  it('validates, and so does every design, the VGA cable included', () => {
    expect(errors(validateDb(db))).toEqual([]);
    expect(catalog.listDesignIds()).toContain('vga-monitor-cable');
    for (const id of catalog.listDesignIds()) expect(errors(validateDesign(catalog.loadDesign(id), db)), id).toEqual([]);
  });

  it('installs into a copy of the starter catalog with no conflicts, once', () => {
    const work = mkdtempSync(join(tmpdir(), 'wirehub-av-'));
    try {
      cpSync(dataPath(''), work, { recursive: true });
      const plan = installPack(work, packDir);
      expect(plan.conflicts).toEqual([]);
      expect(plan.added['connectors.json']).toEqual(['hd15-male-vga', 'scart-male']);
      expect(plan.added['designs/vga-monitor-cable.json']).toEqual([]);
      const installed = createCatalog(fsCatalogSource(work));
      expect(errors(validateDesign(installed.loadDesign('vga-monitor-cable'), installed.loadDb()))).toEqual([]);
      expect(installPack(work, packDir).alreadyInstalled).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('the base readers, taught by the vocabulary', () => {
  it('the wizard reads video labels and per-colour returns', () => {
    expect(roleOfLabels(db, ['Video R'])?.role).toBe('video-r');
    expect(roleOfLabels(db, ['CSync'])?.role).toBe('csync');
    expect(roleOfLabels(db, ['Sync (delivered)'])?.role).toBe('csync');
    expect(roleOfLabels(db, ['Red GND'])).toEqual({ role: 'ground', ground: 'gnd-video-r' });
    expect(roleOfLabels(db, ['CVBS GND'])).toEqual({ role: 'ground', ground: 'gnd-sync' });
    // the same words mean nothing to the base alone
    expect(roleOfLabels(base, ['Video R'])).toBeUndefined();
  });

  it('a pin printed "CVBS in" and aliased "Sync in" takes either core', () => {
    expect(readingsOfLabels(db, ['CVBS in', '20', 'Sync in']).map((r) => r.role)).toEqual(['cvbs', 'csync']);
    expect(pinSignal(db.vocab, { id: '20', label: 'CVBS in', aliases: ['Sync in'] })).toEqual({ oneOf: ['cvbs', 'csync'] });
  });

  it('compat names the signal for ranking', () => {
    expect(signalFromLabel('Green', db)).toBe('video-g');
    expect(signalFromLabel('Blue GND', db)).toBe('ground');
    expect(signalFromLabel('Green', base)).toBeUndefined();
  });

  it('the wizard rebuilds the VGA cable from its ends and its stock', () => {
    const state = {
      ...initialWizardState(db, []),
      label: 'VGA',
      id: 'vga-test',
      src: 'module test',
      source: { kind: 'connector' as const, def: 'hd15-male-vga', plugs: {} },
      destination: { kind: 'connector' as const, def: 'hd15-male-vga', plugs: {} },
      wireDef: 'vga-3coax-4core',
      lengthText: '1800',
    };
    const plan = planCable(state);
    expect(plan.errors).toEqual([]);
    // the signal cores: every one lands where the hand-made cable lands it
    // (screens are compared by the validator, not joint by joint — the
    // hand-made cable twists foil and drain into a pigtail; its jumper from
    // the sync return to ground is a builder's choice, not the wizard's)
    const screen = /drain|foil|shield|pigtail/;
    const cores = (design: CableDesign): string[] =>
      design.joints.map(jointKey).filter((key) => key.includes('w1.') && !screen.test(key)).sort();
    const handMade: CableDesign = catalog.loadDesign('vga-monitor-cable');
    expect(cores(plan.design)).toEqual(cores(handMade));
    expect(cores(plan.design).length).toBeGreaterThan(10);
  });

  it('the continuity spec holds video lines apart and catches a short', () => {
    const design = catalog.loadDesign('vga-monitor-cable');
    expect(deriveTestSpec(design, db).violations).toEqual([]);
    const shorted: CableDesign = {
      ...design,
      id: 'vga-shorted',
      joints: [...design.joints, { a: { instance: 'j1', terminal: '1' }, b: { instance: 'j1', terminal: '5' }, note: 'DELIBERATE FAULT' }],
    };
    expect(deriveTestSpec(shorted, db).violations.length).toBeGreaterThan(0);
  });
});

describe('drawing the VGA parts', () => {
  const vga = findWire(db, 'vga-3coax-4core')!;

  it('lays the VGA ring in the catalogued order, and reads it the other way at the far end', () => {
    const ring = crossSectionLayout(vga)!.cores.filter((core) => core.layIndex >= 0).map((core) => core.elementPath);
    expect(ring).toEqual(vga.layOrder!.ring);
    expect(endFaceLayout(vga, 'a')?.reading).not.toBe(endFaceLayout(vga, 'b')?.reading);
  });

  it('draws the HD15 and SCART faces (SCART from the module\'s own art)', () => {
    const off = registerConnectorArt(createRegistry([avVideo]).art().flatMap((a) => (a.connectors ?? []) as never[]));
    for (const id of ['hd15-male-vga', 'scart-male']) {
      const def = db.connectors.find((c) => c.id === id)!;
      const body = db.bodies?.find((b) => b.id === def.body);
      expect(connectorArt({ def, facing: 'right', ...(body === undefined ? {} : { body }) }), id).toBeDefined();
    }
    off();
  });

  it('renders the stock\'s wire spec sheet, deterministically', async () => {
    const html = renderWireSpecSheet(vga, {});
    expect(renderWireSpecSheet(vga, {})).toBe(html);
    await expect(html).toMatchFileSnapshot('./__snapshots__/vga-3coax-4core.html');
  });
});
