/** Adopting a newer board revision: renamed terminals carry their landings; only the listed losses go. */

import { describe, expect, it } from 'vitest';

import { adoptImpact, adoptRevision, compareRevisions, newerRevisionsInDesign, type CableDesign, type Db, type PcbaDefinition } from '../src/index.ts';

const board = (id: string, revision: string, terminals: PcbaDefinition['terminals']): PcbaDefinition => ({
  id,
  label: `synthetic board ${revision}`,
  partNumber: 'PCA-00009',
  revision,
  terminals,
  internalLinks: [],
  src: 'synthetic example',
});

const db: Db = {
  connectors: [],
  wires: [],
  components: [],
  pcbas: [
    board('b-rev9', 'Rev9', [{ id: 'A' }, { id: 'GND', label: 'Ground', pads: [{ ref: 'GND1' }, { ref: 'GND2' }] }, { id: 'SHLD' }]),
    board('b-rev10', 'Rev10', [{ id: 'A' }, { id: '0V', label: 'Ground', pads: [{ ref: 'GND1' }] }, { id: 'EN' }]),
  ],
};

const design: CableDesign = {
  schemaVersion: 5,
  id: 'synthetic-lead',
  label: 'Synthetic lead',
  src: 'synthetic example',
  instances: { connectors: [], segments: [], components: [], pcbas: [{ id: 'u1', def: 'b-rev9' }, { id: 'u2', def: 'b-rev9' }] },
  joints: [
    { a: { instance: 'u1', terminal: 'A' }, b: { instance: 'u2', terminal: 'A' } },
    { a: { instance: 'u1', terminal: 'GND', pad: 'GND2' }, b: { instance: 'u2', terminal: 'GND', pad: 'GND1' } },
    { a: { instance: 'u1', terminal: 'SHLD' }, b: { instance: 'u2', terminal: 'A' } },
  ],
};

describe('adopt a newer revision', () => {
  it('orders revisions naturally', () => {
    expect(compareRevisions('Rev9', 'Rev10')).toBeLessThan(0);
    expect(compareRevisions('B', 'A')).toBeGreaterThan(0);
    expect(compareRevisions('Z', 'AA')).toBeLessThan(0);
  });

  it('lists the impact, then removes exactly what it listed', () => {
    const [found] = newerRevisionsInDesign(db, design);
    expect(found?.to.id).toBe('b-rev10');
    const impact = adoptImpact(db, design, 'pcbas', 'b-rev9', 'b-rev10')!;
    expect(impact.renamed).toEqual([{ from: 'GND', to: '0V', label: 'Ground' }]);
    expect(impact.lostTerminals.map((l) => `${l.instance}:${l.terminal}`)).toEqual(['u1:SHLD']);
    expect(impact.lostPads.map((l) => `${l.instance}:${l.pad}`)).toEqual(['u1:GND2']);

    const next = adoptRevision(db, design, 'pcbas', 'b-rev9', 'b-rev10');
    expect(next.instances.pcbas.map((p) => p.def)).toEqual(['b-rev10', 'b-rev10']);
    expect(next.joints).toEqual([
      { a: { instance: 'u1', terminal: 'A' }, b: { instance: 'u2', terminal: 'A' } },
      { a: { instance: 'u1', terminal: '0V' }, b: { instance: 'u2', terminal: '0V', pad: 'GND1' } },
    ]);
    expect(newerRevisionsInDesign(db, next)).toEqual([]);
  });
});
