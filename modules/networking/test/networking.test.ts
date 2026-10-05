/**
 * The networking module against the WireHub base: its pack validates over
 * the starter catalog and installs cleanly; the patch cable is one net per
 * pin, the T568A-to-T568B crossover swaps the orange and green pairs, and the
 * base readers learn the Ethernet MDI words from the vocabulary.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, installPack, layeredCatalogSource, readPackManifest } from '@wirehub/catalog';
import { deriveTestSpec, renderBomMarkdown } from '@wirehub/docs';
import { roleOfLabels } from '@wirehub/editor-react';
import { deriveNets, netForTerminal, validateDb, validateDesign, type CableDesign, type Db } from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { NETWORKING_PACK, networking } from '../src/index.ts';

const packDir = fileURLToPath(NETWORKING_PACK);
const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'networking')]));
const db: Db = catalog.loadDb();
const base: Db = createCatalog(fsCatalogSource(dataPath(''), 'starter')).loadDb();
const design = (id: string): CableDesign => catalog.loadDesign(id);
const DESIGNS = ['rj45-patch-t568b', 'rj45-crossover-t568a-b'];

/** The pin at end B that pin `pin` at end A is joined to, through the cable. */
function farPin(d: CableDesign, pin: string): string[] {
  const nets = deriveNets(d, db);
  return (netForTerminal(nets, { instance: 'j1', terminal: pin })?.terminals ?? [])
    .map((t) => t.key)
    .filter((key) => key.startsWith('j2:'))
    .map((key) => key.slice(3));
}

/** The conductor a pin lands on at one end. */
function conductorAt(d: CableDesign, connector: 'j1' | 'j2', pin: string): string | undefined {
  for (const joint of d.joints) {
    for (const [mine, other] of [[joint.a, joint.b], [joint.b, joint.a]] as const) {
      if (mine.instance === connector && mine.terminal === pin && other.instance === 'w1') return other.terminal;
    }
  }
  return undefined;
}

describe('the module', () => {
  it('is an optional domain module, unticked at setup, with one CC0 pack', () => {
    expect(createRegistry([networking]).domains().map((m) => m.id)).toEqual(['networking']);
    expect(networking.setup).not.toHaveProperty('suggested');
    expect(readPackManifest(packDir)).toMatchObject({ id: 'networking', version: '0.1.0', license: 'CC0-1.0' });
  });

  it('keeps Ethernet out of the base: no MDI signal or RJ45 record without the pack', () => {
    expect((base.vocab?.['signals']?.entries ?? []).some((e) => e.id.startsWith('eth-'))).toBe(false);
    expect(base.connectors.some((c) => c.family === 'rj45')).toBe(false);
    expect(base.bodies?.some((b) => b.family === 'rj45')).toBe(false);
  });
});

describe('the pack over the starter catalog', () => {
  it('validates, and every design is clean', () => {
    expect(validateDb(db)).toEqual([]);
    for (const id of DESIGNS) {
      expect(catalog.listDesignIds()).toContain(id);
      expect(validateDesign(design(id), db), id).toEqual([]);
    }
  });

  it('installs into a copy of the starter catalog with no conflicts, once', () => {
    const work = mkdtempSync(join(tmpdir(), 'wirehub-net-'));
    try {
      cpSync(dataPath(''), work, { recursive: true });
      const plan = installPack(work, packDir);
      expect(plan.conflicts).toEqual([]);
      expect(plan.added['connectors.json']).toEqual(['rj45-plug-t568b', 'rj45-plug-t568a']);
      const installed = createCatalog(fsCatalogSource(work));
      for (const id of DESIGNS) expect(validateDesign(installed.loadDesign(id), installed.loadDb()), id).toEqual([]);
      expect(installPack(work, packDir).alreadyInstalled).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('T568B and T568A', () => {
  it('the patch cable has one net per pin, each joining the same pin at both ends', () => {
    const d = design('rj45-patch-t568b');
    for (let pin = 1; pin <= 8; pin += 1) expect(farPin(d, String(pin)), `pin ${pin}`).toEqual([String(pin)]);
  });

  it('T568B puts the orange pair on 1/2 at both ends of the patch cable', () => {
    const d = design('rj45-patch-t568b');
    for (const end of ['j1', 'j2'] as const) {
      expect(conductorAt(d, end, '1')).toBe('pair-2.b'); // white/orange
      expect(conductorAt(d, end, '2')).toBe('pair-2.a'); // orange
      expect(conductorAt(d, end, '3')).toBe('pair-3.b'); // white/green
    }
  });

  it('the crossover is T568A at end A, T568B at end B: 1/2 meet 3/6, the blue and brown pairs run straight', () => {
    const d = design('rj45-crossover-t568a-b');
    expect(conductorAt(d, 'j1', '1')).toBe('pair-3.b'); // white/green under T568A
    expect(conductorAt(d, 'j2', '1')).toBe('pair-2.b'); // white/orange under T568B
    expect(farPin(d, '1')).toEqual(['3']);
    expect(farPin(d, '2')).toEqual(['6']);
    expect(farPin(d, '3')).toEqual(['1']);
    expect(farPin(d, '6')).toEqual(['2']);
    for (const pin of ['4', '5', '7', '8']) expect(farPin(d, pin), `pin ${pin}`).toEqual([pin]);
  });
});

describe('documents', () => {
  it('a patch cable is plain copper: one net per pin, no path checks, nothing wrong', () => {
    const spec = deriveTestSpec(design('rj45-patch-t568b'), db);
    expect(spec.pathChecks).toEqual([]);
    expect(spec.netChecks.length).toBeGreaterThanOrEqual(8);
    expect(spec.violations).toEqual([]);
  });

  it('the markdown BOM names the base stock by its part number', () => {
    expect(renderBomMarkdown(design('rj45-patch-t568b'), db, { depictions: false })).toContain('WIR-00001');
  });
});

describe('the base readers, taught by the vocabulary', () => {
  it('the wizard reads MDI labels; the base alone does not', () => {
    expect(roleOfLabels(db, ['BI_DA+'])?.role).toBe('eth-da-p');
    expect(roleOfLabels(db, ['BI_DD-'])?.role).toBe('eth-dd-n');
    expect(roleOfLabels(base, ['BI_DA+'])).toBeUndefined();
  });
});
