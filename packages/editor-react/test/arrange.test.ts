/**
 * Auto-arrange: ELK layered over the design's columns (`ranks.ts`, `elk.ts`).
 *
 * Every design in the catalog, with and without board artwork: no two drawn
 * boxes overlap, every "left of" the design implies holds on the canvas, and
 * the same design always lands in the same place.
 */

import { loadDb, loadDesign, loadDesigns } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { autoLayout, deriveNodes, type EditorNode } from '../src/derive.ts';
import { estimateNodeSize, overlappingPairs, type NodeRect } from '../src/layout-size.ts';
import { designRanks } from '../src/ranks.ts';
import { canvasView, mouldIds, rankView } from '../src/moulds.ts';
import { editorReducer, initialEditorState } from '../src/store.ts';
import { diskDepictions } from './fixture.ts';

const db: Db = loadDb();
const designs: CableDesign[] = loadDesigns();
const depictions = diskDepictions();


/** The drawn top-level boxes (a docked connector is inside its board's). */
function boxes(nodes: EditorNode[]): Map<string, NodeRect> {
  return new Map(
    nodes
      .filter((node) => node.parentId === undefined)
      .map((node) => [node.id, { id: node.id, ...node.position, ...estimateNodeSize(node.data) }]),
  );
}

function arranged(design: CableDesign, art: boolean): Map<string, NodeRect> {
  const options = art ? { depictions } : {};
  const { positions } = autoLayout(design, db, options.depictions);
  return boxes(deriveNodes(design, db, { ...options, positions }));
}

describe.each([
  ['with board art', true],
  ['as pin lists', false],
] as const)('auto-arrange, %s', (_label, art) => {
  it.each(designs.map((design) => [design.id, design] as const))('%s: no overlaps, left to right', (_id, design) => {
    const rects = arranged(design, art);
    expect(overlappingPairs([...rects.values()])).toEqual([]);
    // every "left of" the design implies, between two drawn boxes, holds
    const docked = new Map(
      deriveNodes(design, db, art ? { depictions } : {})
        .filter((node) => node.parentId !== undefined)
        .map((node) => [node.id, node.parentId as string]),
    );
    const own = (id: string): string => docked.get(id) ?? id;
    const broken: string[] = [];
    // the columns the canvas draws: a breakout mould between its trunk and its legs
    for (const [u, v] of designRanks(rankView(canvasView(design, db)), new Map(), mouldIds(design)).constraints) {
      const a = rects.get(own(u));
      const b = rects.get(own(v));
      if (a === undefined || b === undefined || a === b) continue;
      if (a.x + a.width > b.x) broken.push(`${u} → ${v}`);
    }
    expect(broken).toEqual([]);
  });
});

describe('determinism', () => {
  it('lays every design out the same way twice', { timeout: 30_000 }, () => {
    for (const design of designs) {
      expect(autoLayout(design, db, depictions)).toEqual(autoLayout(design, db, depictions));
    }
  });

  it('does not depend on what was laid out before', () => {
    const design = loadDesign('de9-terminal-board');
    const first = autoLayout(design, db, depictions);
    for (const other of designs.slice(0, 5)) autoLayout(other, db, depictions);
    expect(autoLayout(design, db, depictions)).toEqual(first);
  });
});

describe('the Auto-arrange action', () => {
  it('replaces a dragged arrangement with the ELK one, and only when asked', () => {
    const design = loadDesign('de9-terminal-board');
    const start = initialEditorState(design, db, undefined, depictions);
    const moved = editorReducer(start, { type: 'move-node', id: 'w1', position: { x: 9999, y: 9999 } });
    expect(moved.positions['w1']).toEqual({ x: 9999, y: 9999 });
    // an edit does not move it back
    const edited = editorReducer(moved, { type: 'select', selection: { kind: 'instance', id: 'w1' } });
    expect(edited.positions['w1']).toEqual({ x: 9999, y: 9999 });
    const arrangedState = editorReducer(edited, { type: 'auto-arrange' });
    expect(arrangedState.positions).toEqual(autoLayout(design, db, depictions).positions);
    // presentation only: the design itself is untouched
    expect(arrangedState.design).toBe(edited.design);
  });
});
