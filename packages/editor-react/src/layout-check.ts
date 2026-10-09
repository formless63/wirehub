/**
 * How well a fresh layout reads: the edges that run against the grain.
 *
 * A **back-edge** leaves a handle on the side facing away from the part it goes to (a right-facing
 * handle whose partner lies to its left, a left-facing one whose partner lies to its right), or
 * joins two handles that face the same way, so the wire has to loop round a node. A fresh layout
 * of a two-ended design (connector, wire, connector) should have none: the connectors stand on the
 * outside, the wire in the middle, every handle facing it.
 *
 * Pure and deterministic; it lays the design out the way the editor first opens it (`autoLayout`).
 */

import type { CableDesign, Db } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import { anchorOf, placedNode, type XY } from './breakout.ts';
import { autoLayout, deriveFlow } from './derive.ts';

export interface BackEdge {
  /** `source -> target`, with the handle each leaves from */
  edge: string;
  reason: 'away' | 'same-facing';
}

export function backEdges(design: CableDesign, db: Db, depictions?: DepictionSource): BackEdge[] {
  const { positions } = autoLayout(design, db, depictions);
  const flow = deriveFlow(design, db, { ...(depictions === undefined ? {} : { depictions }), positions });
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const absolute = (id: string): XY => {
    const node = byId.get(id);
    if (node === undefined) return { x: 0, y: 0 };
    const parent = node.parentId === undefined ? undefined : absolute(node.parentId);
    return parent === undefined ? node.position : { x: parent.x + node.position.x, y: parent.y + node.position.y };
  };
  const placed = new Map(flow.nodes.map((node) => [node.id, placedNode(node.id, node.data, absolute(node.id))]));
  const out: BackEdge[] = [];
  for (const edge of flow.edges) {
    if (edge.hidden === true || edge.data?.stub === true || edge.sourceHandle == null || edge.targetHandle == null) continue;
    const source = placed.get(edge.source);
    const target = placed.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const a = anchorOf(source, edge.sourceHandle);
    const b = anchorOf(target, edge.targetHandle);
    if (a === undefined || b === undefined) continue;
    const label = `${edge.source}:${edge.sourceHandle} -> ${edge.target}:${edge.targetHandle}`;
    if (a.facing === b.facing) out.push({ edge: label, reason: 'same-facing' });
    else if ((a.facing === 'right' && b.x < a.x) || (a.facing === 'left' && b.x > a.x)) out.push({ edge: label, reason: 'away' });
  }
  return out;
}
