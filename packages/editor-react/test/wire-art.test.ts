/**
 * Wire artwork geometry: both cut ends of a segment in one node, a handle on
 * every element of each, ids that are the design's own terminal keys.
 */

import {
  electricalPaths,
  findWire,
  terminalKey,
  type Db,
  type WireDefinition,
} from '@wirehub/model';
import { bondFoldedPaths, endFaceLayout } from '@wirehub/render-svg';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { autoLayout, deriveNodes, type SegmentNodeData } from '../src/derive.ts';
import { estimateNodeSize, nodeRect, overlappingPairs } from '../src/layout-size.ts';
import { WIRE_LAYOUT, feetAndInches, runLabel, wireArt, type WireArt } from '../src/wire-art.ts';
import { designWithFacelessWhip, loadDbFromDisk, loadDesignFromDisk, multicoreDesign } from './fixture.ts';

const db: Db = loadDbFromDisk();

function wireOf(id: string): WireDefinition {
  const wire = findWire(db, id);
  if (wire === undefined) throw new Error(`no wire ${id}`);
  return wire;
}

function artOf(id: string, rotation?: { a?: number; b?: number }): WireArt {
  const art = wireArt({ instanceId: 'w1', wire: wireOf(id), lengthMm: 1830, rotation });
  if (art === undefined) throw new Error(`no art for ${id}`);
  return art;
}

const DESIGNS = readdirSync(join(process.cwd(), '..', 'catalog', 'data', 'designs'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

describe('wireArt', () => {

  it('is the layout end face, scaled into the node', () => {
    const art = artOf('multicore-3coax-4core', { a: 40, b: 200 });
    for (const face of art.faces) {
      const geometry = endFaceLayout(wireOf('multicore-3coax-4core'), face.end, {
        rotationDeg: face.end === 'a' ? 40 : 200,
      })!;
      expect(face.rotationDeg).toBe(face.end === 'a' ? 40 : 200);
      geometry.cores.forEach((core, index) => {
        expect(face.cores[index]!.x).toBeCloseTo(face.cx + core.x * face.scale, 9);
        expect(face.cores[index]!.y).toBeCloseTo(face.cy + core.y * face.scale, 9);
      });
    }
  });

  it('puts one handle per electrical element per end, minus folded bonded screens, edges leaving a left and b right', () => {
    const wire = wireOf('multicore-3coax-4core');
    const art = artOf('multicore-3coax-4core');
    //: a bonded screen other than its set's
    // representative gets no handle — "the drain stands for the mass"
    const dropped = bondFoldedPaths(wire);
    const paths = electricalPaths(wire.structure).filter((path) => !dropped.has(path));
    expect(art.handles).toHaveLength(paths.length * 2);
    for (const end of ['a', 'b'] as const) {
      const handles = art.handles.filter((handle) => handle.end === end);
      expect(handles.map((handle) => handle.terminal)).toEqual(paths);
      for (const handle of handles) {
        expect(handle.id).toBe(terminalKey({ instance: 'w1', terminal: handle.terminal, end }));
        expect(handle.facing).toBe(end === 'a' ? 'left' : 'right');
        const face = art.faces[end === 'a' ? 0 : 1];
        expect(Math.hypot(handle.x - face.cx, handle.y - face.cy)).toBeLessThan(face.jacket.r);
      }
    }
    expect(new Set(art.handles.map((handle) => handle.id)).size).toBe(art.handles.length);
  });

});

describe('wire nodes in the catalog designs', () => {

  it('widens the art for a long title so the header fits', () => {
    const design = multicoreDesign();
    const w1 = deriveNodes(design, db).find((node) => node.id === 'w1')!;
    const data = w1.data as SegmentNodeData;
    expect(data.wire!.width).toBeGreaterThanOrEqual(WIRE_LAYOUT.minWidth);
    expect(data.wire!.faces[1].cx).toBeCloseTo(data.wire!.width - WIRE_LAYOUT.faceInset, 9);
  });
});

describe('wireArt flipped', () => {
  it('draws end b on the left, a on the right, faces unmirrored, shields picked up outward', () => {
    const wire = wireOf('multicore-3coax-4core');
    const plain = wireArt({ instanceId: 'w1', wire, lengthMm: 1830 })!;
    const flipped = wireArt({ instanceId: 'w1', wire, lengthMm: 1830, flip: true })!;
    expect(flipped.flipped).toBe(true);
    const [a, b] = flipped.faces;
    expect(b.cx).toBeLessThan(a.cx);
    expect(a.caption).toBe('source · CCW');
    expect(flipped.run).toEqual(plain.run);
    for (const face of flipped.faces) {
      const other = plain.faces.find((candidate) => candidate.end === face.end)!;
      // the same face, moved: every core keeps its offset from the centre
      face.cores.forEach((core, index) => {
        expect(core.x - face.cx).toBeCloseTo(other.cores[index]!.x - other.cx, 9);
        expect(core.y).toBeCloseTo(other.cores[index]!.y, 9);
      });
    }
    for (const handle of flipped.handles) {
      expect(handle.facing).toBe(handle.end === 'b' ? 'left' : 'right');
      if (handle.role !== 'shield' || handle.core === undefined) continue;
      const face = flipped.faces.find((candidate) => candidate.end === handle.end)!;
      const core = face.cores.find((candidate) => candidate.path === handle.core)!;
      // picked up on the side its edges leave toward
      expect(Math.sign(handle.x - core.x)).toBe(handle.facing === 'left' ? -1 : 1);
    }
  });
});
