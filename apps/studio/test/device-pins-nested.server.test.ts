/**
 * A saved parent device's geometry follows the child revision it pins, not the
 * child's newer working copy. Synthetic designs.
 */

import { withAssemblies, type CableDesign, type Db, type DesignVersionFile } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { captureDevicePins, reachDevices } from '../server/devices/pins.ts';

const design = (id: string, boards: string[], subs: { id: string; def: string; rev?: number }[] = []): CableDesign =>
  ({ id, label: id, instances: { connectors: [], segments: [], pcbas: boards.map((def, i) => ({ id: `b${i + 1}`, def })), subassemblies: subs }, device: { placements: [] } }) as unknown as CableDesign;
const empty = { connectors: [], bodies: [], interfaces: [], wires: [], components: [], mechanicals: [] };

describe('nested device pins', () => {
  const childRev1 = design('synthetic-child', ['old-board']);
  const childWorking = design('synthetic-child', ['new-board']);
  const parent = design('synthetic-parent', [], [{ id: 'sub1', def: 'synthetic-child', rev: 1 }]);
  const db = withAssemblies({ ...empty, pcbas: [{ id: 'old-board' }, { id: 'new-board' }] } as unknown as Db, {
    working: [childWorking],
    versions: [{ designId: 'synthetic-child', rev: 1, released: true, design: childRev1, definitions: { ...empty, pcbas: [{ id: 'old-board' }] } as never }],
  });

  it('reaches the pinned child revision', () => {
    const boards = reachDevices(parent, db).flatMap((r) => r.design.instances.pcbas.map((b) => b.def));
    expect(boards).toEqual(['old-board']);
  });

  it("takes the pinned child's saved geometry", async () => {
    const saved = { enclosures: {}, boards: { 'old-board': { glb: 'a'.repeat(64), from: 'saved with the child' } } };
    const versions = { read: (id: string, rev: number) => (id === 'synthetic-child' && rev === 1 ? ({ device: saved } as unknown as DesignVersionFile) : undefined) };
    const pins = await captureDevicePins({ versions }, parent, db);
    expect(pins?.boards).toEqual(saved.boards);
  });

  it('keeps two placements of one child at different revisions apart', async () => {
    const twice = design('synthetic-parent', [], [{ id: 'sub1', def: 'synthetic-child', rev: 1 }, { id: 'sub2', def: 'synthetic-child', rev: 2 }]);
    const both = withAssemblies({ ...empty, pcbas: [{ id: 'old-board' }] } as unknown as Db, {
      working: [childWorking],
      versions: [1, 2].map((rev) => ({ designId: 'synthetic-child', rev, released: true, design: childRev1, definitions: { ...empty, pcbas: [{ id: 'old-board' }] } as never })),
    });
    const glb = (rev: number): string => String(rev).repeat(64);
    const versions = { read: (_id: string, rev: number) => ({ device: { enclosures: {}, boards: { 'old-board': { glb: glb(rev), from: `Rev ${rev}` } } } }) as unknown as DesignVersionFile };
    const pins = await captureDevicePins({ versions }, twice, both);
    expect(pins?.occurrences?.boards['sub1/b1']?.glb).toBe(glb(1));
    expect(pins?.occurrences?.boards['sub2/b1']?.glb).toBe(glb(2));
  });
});
