/**
 * The layout over the starter catalog: every example design lays out
 * deterministically, every segment gets its band, and the stocks with a lay
 * order get a cross-section, end faces and a 3D wire model.
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { findWire, type WireDefinition } from '@wirehub/model';

import { connectorArt, crossSectionLayout, endFaceLayout, layoutSchematic, wireModel } from '../src/index.ts';

const db = loadDb();
const wire = (id: string): WireDefinition => {
  const found = findWire(db, id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

describe('schematic layout', () => {
  for (const id of listDesignIds()) {
    it(`${id}: deterministic, one band per segment, a block per connector`, () => {
      const design = loadDesign(id);
      const a = layoutSchematic(design, db, { depictions: false });
      const b = layoutSchematic(loadDesign(id), db, { depictions: false });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      for (const segment of design.instances.segments) expect(a.bands.some((band) => band.segment === segment.id), segment.id).toBe(true);
      for (const connector of design.instances.connectors) expect(a.blocks.some((block) => block.id === connector.id), connector.id).toBe(true);
    });
  }

  it('the breakout cable keeps its mould', () => {
    expect(layoutSchematic(loadDesign('dc-y-splitter'), db, { depictions: false }).breakouts?.[0]?.id).toBe('bk1');
  });
});

describe('wire stock geometry', () => {
  it('lays the multicore ring in the catalogued order around its centre core', () => {
    const cs = crossSectionLayout(wire('multicore-3coax-4core'));
    expect(cs).toBeDefined();
    const ring = cs!.cores.filter((core) => core.layIndex >= 0).map((core) => core.elementPath);
    expect(ring).toEqual(wire('multicore-3coax-4core').layOrder!.ring);
  });

  it('reads the ring the other way round at the far end', () => {
    const a = endFaceLayout(wire('multicore-3coax-4core'), 'a');
    const b = endFaceLayout(wire('multicore-3coax-4core'), 'b');
    expect(a?.reading).toBeDefined();
    expect(b?.reading).toBeDefined();
    expect(a?.reading).not.toBe(b?.reading);
  });

  it('builds a 3D model for every stock', () => {
    for (const w of db.wires) {
      expect(wireModel(w), w.id).toBeDefined();
    }
  });
});

describe('connector art', () => {
  it('draws the D-sub family', () => {
    for (const id of ['de9-female', 'de9-male']) {
      const def = db.connectors.find((c) => c.id === id)!;
      expect(connectorArt({ def, facing: 'right' }), id).toBeDefined();
    }
  });
});
