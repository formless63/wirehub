/**
 * Canvas geometry for the tests: a catalog design laid out the way the
 * editor first opens it, each drawn edge's route as a polyline, and how many
 * times runs cross near given parts.
 */

import type { CableDesign, Db } from '@cable-studio/model';
import { segmentsIntersect } from '@cable-studio/render-svg';

import { anchorOf, edgeRoute, placedNode, type PlacedNode, type XY } from '../src/breakout.ts';
import { autoLayout, deriveFlow, type EditorEdge, type Flow } from '../src/derive.ts';
import { diskDepictions, loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const depictions = diskDepictions();

export function flowOf(id: string): { design: CableDesign; flow: Flow; placed: Map<string, PlacedNode> } {
  const design = loadDesignFromDisk(id);
  const { positions } = autoLayout(design, db, depictions);
  const flow = deriveFlow(design, db, { depictions, positions });
  // a docked connector's position is relative to its board's (`parentId`)
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const absolute = (id: string): XY => {
    const node = byId.get(id)!;
    const parent = node.parentId === undefined ? undefined : absolute(node.parentId);
    return parent === undefined ? node.position : { x: parent.x + node.position.x, y: parent.y + node.position.y };
  };
  const placed = new Map(flow.nodes.map((node) => [node.id, placedNode(node.id, node.data, absolute(node.id))]));
  return { design, flow, placed };
}

/** An edge's drawn route as a polyline, flow coordinates (fillets ignored, the bend sampled). */
export function polyline(e: EditorEdge, placed: ReadonlyMap<string, PlacedNode>): XY[] | undefined {
  const source = placed.get(e.source);
  const target = placed.get(e.target);
  if (source === undefined || target === undefined || e.sourceHandle == null || e.targetHandle == null) return undefined;
  const a = anchorOf(source, e.sourceHandle);
  const b = anchorOf(target, e.targetHandle);
  if (a === undefined || b === undefined) return undefined;
  if (e.data?.stub === true) return [a, b];
  const d = e.data;
  const route = edgeRoute({
    source: a,
    target: b,
    sourceFacing: a.facing,
    targetFacing: b.facing,
    sourceEntryX: d?.sourceEntryX,
    targetEntryX: d?.targetEntryX,
    sourceEntryY: d?.sourceEntryY,
    targetEntryY: d?.targetEntryY,
    sourceClearX: d?.sourceClearX,
    targetClearX: d?.targetClearX,
    sourceApproach: d?.sourceApproach,
    targetApproach: d?.targetApproach,
    sourceApproachLead: d?.sourceApproachLead,
    targetApproachLead: d?.targetApproachLead,
    sourceSlot: d?.sourceSlot ?? a.slot,
    targetSlot: d?.targetSlot ?? b.slot,
  });
  const bend: XY[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    const u = 1 - t;
    bend.push({
      x: u * u * u * route.from.x + 3 * u * u * t * route.c1.x + 3 * u * t * t * route.c2.x + t * t * t * route.to.x,
      y: u * u * u * route.from.y + 3 * u * u * t * route.c1.y + 3 * u * t * t * route.c2.y + t * t * t * route.to.y,
    });
  }
  return [route.start, ...(route.sourceLead ?? []), ...bend, ...(route.targetLead ?? []), route.end];
}

/**
 * How many times two drawn runs cross within `margin` px of a part's box
 * (inside it or just outside) — the "bunch and cross going into the
 * connector" the owner saw. Runs that share an end (the two halves of one
 * net at a pad) are not counted against each other.
 */
export function crossingsNear(id: string, parts: readonly string[], margin: number): number {
  const { flow, placed } = flowOf(id);
  const boxes = parts.flatMap((part) => {
    const node = placed.get(part);
    return node === undefined
      ? []
      : [{ x0: node.position.x - margin, y0: node.position.y - margin, x1: node.position.x + node.size.width + margin, y1: node.position.y + node.size.height + margin }];
  });
  const near = (p: XY): boolean => boxes.some((box) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1);
  const runs = flow.edges
    .filter((e) => e.hidden !== true)
    .flatMap((e) => {
      const line = polyline(e, placed);
      return line === undefined ? [] : [{ e, line }];
    });
  let count = 0;
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const p = runs[i]!;
      const q = runs[j]!;
      const ends = new Set([p.e.sourceHandle, p.e.targetHandle]);
      if (ends.has(q.e.sourceHandle) || ends.has(q.e.targetHandle)) continue;
      let hit = false;
      for (let s = 0; s + 1 < p.line.length && !hit; s += 1) {
        for (let t = 0; t + 1 < q.line.length && !hit; t += 1) {
          const a1 = p.line[s]!;
          const a2 = p.line[s + 1]!;
          if (!segmentsIntersect(a1, a2, q.line[t]!, q.line[t + 1]!)) continue;
          if (near(a1) || near(a2)) hit = true;
        }
      }
      if (hit) count += 1;
    }
  }
  return count;
}

