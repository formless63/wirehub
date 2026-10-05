/**
 * The pro-audio module against the WireHub base: its pack validates over the
 * starter catalog (alone and beside the AV / video pack, which shares its
 * audio signals) and installs cleanly; once its vocabulary is in, the base's
 * generic readers — the wizard, trace, breakouts, the layout, the continuity
 * spec — understand balanced and unbalanced audio. (These cases were the
 * base's own tests while the examples lived in the starter catalog.)
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, parseConnectorArt, type ConnectorArtRecord, fsCatalogSource, installPack, layeredCatalogSource, readPackManifest } from '@wirehub/catalog';
import { deriveTestSpec, renderWireSpecSheet } from '@wirehub/docs';
import { initialWizardState, planCable, readingsOfLabels, roleOfLabels } from '@wirehub/editor-react';
import { connectorArt, crossSectionLayout, layoutSchematic, registerConnectorArt } from '@wirehub/layout';
import { AV_VIDEO_PACK } from '@wirehub/module-av-video';
import {
  breakoutFates,
  breakoutIssues,
  findWire,
  reachedTerminal,
  trace,
  validateDb,
  validateDesign,
  vocabEntry,
  type CableDesign,
  type Db,
  type Joint,
} from '@wirehub/model';
import { createRegistry } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { PRO_AUDIO_PACK, proAudio } from '../src/index.ts';

const packDir = fileURLToPath(PRO_AUDIO_PACK);
const starter = (): ReturnType<typeof fsCatalogSource> => fsCatalogSource(dataPath(''), 'starter');
const catalog = createCatalog(layeredCatalogSource([starter(), fsCatalogSource(packDir, 'pro-audio')]));
const db: Db = catalog.loadDb();
const base: Db = createCatalog(starter()).loadDb();
const design = (id: string): CableDesign => catalog.loadDesign(id);
const DESIGNS = ['trs-to-2rca-y', 'xlr-mic-cable'];

const jointKey = (joint: Joint): string => {
  const side = (ref: Joint['a']): string => `${ref.instance}.${ref.terminal}${ref.end === undefined ? '' : `@${ref.end}`}`;
  return [side(joint.a), side(joint.b)].sort().join(' — ');
};

describe('the module', () => {
  it('is an optional domain module, unticked at setup, with one CC0 pack', () => {
    expect(createRegistry([proAudio]).domains().map((m) => m.id)).toEqual(['pro-audio']);
    expect(proAudio.setup).not.toHaveProperty('suggested');
    expect(readPackManifest(packDir)).toMatchObject({ id: 'pro-audio', version: '0.1.0', license: 'CC0-1.0' });
  });

  it('keeps audio out of the base: no audio signal, lane or connector without the pack', () => {
    expect((base.vocab?.['signals']?.entries ?? []).some((e) => e.id.startsWith('audio-') || e.id === 'gnd-audio')).toBe(false);
    expect((base.vocab?.['lanes']?.entries ?? []).some((e) => e.id.startsWith('audio-'))).toBe(false);
    expect(base.connectors.some((c) => ['xlr', 'rca', 'trs-3-5mm'].includes(c.family))).toBe(false);
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

  it('installs into a copy of the starter catalog with no conflicts, once — and beside the AV / video pack', () => {
    const work = mkdtempSync(join(tmpdir(), 'wirehub-audio-'));
    try {
      cpSync(dataPath(''), work, { recursive: true });
      const plan = installPack(work, packDir);
      expect(plan.conflicts).toEqual([]);
      expect(plan.added['connectors.json']).toEqual(['xlr3-female', 'xlr3-male', 'rca-male', 'trs-3-5mm-male']);
      expect(installPack(work, packDir).alreadyInstalled).toBe(true);
      // the video pack carries the same audio signal entries (SCART has audio pins): identical, so no clash
      expect(installPack(work, fileURLToPath(AV_VIDEO_PACK)).conflicts).toEqual([]);
      const installed = createCatalog(fsCatalogSource(work));
      const all = installed.loadDb();
      expect(validateDb(all).filter((i) => i.severity === 'error')).toEqual([]);
      for (const id of [...DESIGNS, 'vga-monitor-cable']) expect(validateDesign(installed.loadDesign(id), all), id).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('maps the RCA audio colour code: white left, red right', () => {
    const rca = vocabEntry<{ id: string; label: string; src: string; lanes: Record<string, string> }>(db.vocab, 'colour-codes', 'rca-audio');
    expect(rca?.lanes).toEqual({ white: 'audio-l', red: 'audio-r' });
  });
});

describe('the wizard, taught by the vocabulary', () => {
  it('reads audio labels and the return a ground belongs to; the base alone does not', () => {
    expect(roleOfLabels(db, ['Audio L'])?.role).toBe('audio-l');
    expect(roleOfLabels(db, ['Audio (mono)'])?.role).toBe('audio-mono');
    expect(readingsOfLabels(db, ['Audio L', '2', 'Audio (mono)']).map((r) => r.role)).toEqual(['audio-l', 'audio-mono']);
    expect(roleOfLabels(db, ['Audio GND'])).toEqual({ role: 'ground', ground: 'gnd-audio' });
    expect(roleOfLabels(base, ['Audio L'])).toBeUndefined();
  });

  it('reproduces the hand-made microphone lead from the vocabulary alone', () => {
    const state = {
      ...initialWizardState(db, []),
      label: 'Mic',
      id: 'mic-test',
      src: 'module test',
      source: { kind: 'connector' as const, def: 'xlr3-female', plugs: {} },
      destination: { kind: 'connector' as const, def: 'xlr3-male', plugs: {} },
      wireDef: 'mic-2core-braid',
      lengthText: '3000',
    };
    const plan = planCable(state);
    expect(plan.errors).toEqual([]);
    expect(plan.choices).toEqual([]);
    expect(plan.unconnected).toEqual([]);
    expect(plan.design.joints.map(jointKey).sort()).toEqual(design('xlr-mic-cable').joints.map(jointKey).sort());
  });
});

describe('the Y lead', () => {
  const y = design('trs-to-2rca-y');

  it('the tip reaches the left RCA tip through the mould splice; the ring reaches the right and not the left', () => {
    const tip = reachedTerminal(trace(y, db, { instance: 'j1', terminal: 'tip' }), 'j2:tip');
    expect(tip?.passages.map((p) => p.description)).toEqual([]);
    const ring = trace(y, db, { instance: 'j1', terminal: 'ring' });
    expect(reachedTerminal(ring, 'j3:tip')).toBeDefined();
    expect(reachedTerminal(ring, 'j2:tip')).toBeUndefined();
  });

  it('accounts for every conductor in the mould, the legs’ spare cores marked NC', () => {
    expect(breakoutIssues(y, db)).toEqual([]);
    const fates = breakoutFates(y, db);
    expect(fates.get('w2:right@a')?.fate).toBe('nc');
    expect(fates.get('w1:left@b')?.fate).toBe('terminated');
    const mould = layoutSchematic(y, db, { depictions: false }).breakouts?.[0];
    expect(mould?.rows.filter((row) => row.fate === 'nc').map((row) => row.key).sort()).toEqual(['w2:right@a', 'w3:left@a']);
  });
});

describe('the continuity spec', () => {
  it('finds nothing wrong with the pack designs, and catches the hot pin shorted to the shield', () => {
    for (const id of DESIGNS) expect(deriveTestSpec(design(id), db).violations.map((c) => c.id), id).toEqual([]);
    const mic = design('xlr-mic-cable');
    const shorted: CableDesign = { ...mic, joints: [...mic.joints, { a: { instance: 'j1', terminal: '2' }, b: { instance: 'j1', terminal: '1' }, note: 'DELIBERATE FAULT' }] };
    expect(deriveTestSpec(shorted, db).violations.length).toBeGreaterThan(0);
  });
});

describe('drawing the audio parts', () => {
  const records = createRegistry([proAudio])
    .art()
    .flatMap((a) => (a.connectors ?? []).map((raw) => parseConnectorArt(raw, 'art').record as ConnectorArtRecord));

  it('contributes valid side views for RCA and 3.5 mm TRS, licensed and sourced', () => {
    expect(records.map((r) => r.id)).toEqual(['rca-plug', 'rca-jack', 'trs-3-5mm-plug', 'trs-3-5mm-jack']);
    for (const r of records) {
      expect(r.view).toBe('profile');
      expect(r.license).toBe('CC0-1.0');
      expect(r.provenance?.sources[0]?.title).toBe(r.src);
    }
  });

  it('draws the RCA plug in side view with the pack, facing the wire, and a generic plug without it', () => {
    const def = db.connectors.find((c) => c.id === 'rca-male')!;
    const body = db.bodies?.find((b) => b.id === def.body);
    const input = (facing: 'left' | 'right') => ({ def, facing, ...(body === undefined ? {} : { body }) });
    const bare = connectorArt(input('right'))!;
    expect(bare).toMatchObject({ view: 'profile', short: 'Plug', approximate: true });
    const off = registerConnectorArt(records);
    try {
      const left = connectorArt(input('left'))!;
      const right = connectorArt(input('right'))!;
      expect(left).toMatchObject({ view: 'profile', short: 'RCA', approximate: false, facing: 'left' });
      expect(left.pins.map((p) => p.terminal)).toEqual(['tip', 'sleeve']);
      expect(left.pins.every((p) => p.x < left.width / 2)).toBe(true);
      expect(right.pins.every((p) => p.x > right.width / 2)).toBe(true);
    } finally {
      off();
    }
    expect(connectorArt(input('right'))).toEqual(bare);
  });

  it('draws the 3.5 mm TRS plug, and the Y lead schematic with the pack and without', () => {
    const trs = db.connectors.find((c) => c.id === 'trs-3-5mm-male')!;
    const off = registerConnectorArt(records);
    try {
      expect(connectorArt({ def: trs, facing: 'left' })).toMatchObject({ short: '3.5 mm', view: 'profile' });
      const shorts = layoutSchematic(design('trs-to-2rca-y'), db).blocks.flatMap((b) => (b.connectorArt === undefined ? [] : [b.connectorArt.short]));
      expect(shorts).toContain('RCA');
      expect(shorts).toContain('3.5 mm');
    } finally {
      off();
    }
    const bare = layoutSchematic(design('trs-to-2rca-y'), db).blocks.flatMap((b) => (b.connectorArt === undefined ? [] : [b.connectorArt.short]));
    expect(bare).not.toContain('RCA');
    expect(bare).toContain('Plug');
  });

  it('lays the stocks in their catalogued order', () => {
    for (const id of ['mic-2core-braid', 'audio-stereo-2core']) {
      const wire = findWire(db, id)!;
      const ring = crossSectionLayout(wire)!.cores.filter((core) => core.layIndex >= 0).map((core) => core.elementPath);
      expect(ring, id).toEqual(wire.layOrder!.ring);
    }
  });

  it.each(['mic-2core-braid', 'audio-stereo-2core'])('renders the %s wire spec sheet, deterministically', async (id) => {
    const wire = findWire(db, id)!;
    const html = renderWireSpecSheet(wire, {});
    expect(renderWireSpecSheet(wire, {})).toBe(html);
    await expect(html).toMatchFileSnapshot(`./__snapshots__/${id}.html`);
  });
});
