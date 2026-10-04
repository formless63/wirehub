/**
 * When React Flow has to re-read a node's handles.
 *
 * React Flow draws an edge from the handle bounds it cached when it last
 * measured the node, and it re-measures only when the node's box changes size
 * (or when told to). This canvas moves handles *inside* a node of unchanged
 * size all the time: a wire's port column re-spaces when a port comes or goes,
 * its face turns to meet its pads, a connector's rows reorder. Without a nudge
 * the edges keep leaving the old spots — or, when a handle id it has never
 * measured turns up, are not drawn at all — until some unrelated edit happens
 * to resize the node.
 *
 * The signature of a node is where every handle an edge uses sits relative to
 * the node, plus a wire's face turns (which move the free face handles too).
 * Any node whose signature changed is handed to `updateNodeInternals`.
 */

import { anchorOf, placedNode } from './breakout.ts';
import type { EditorEdge, EditorNode } from './derive.ts';

export function handleSignatures(
  nodes: readonly EditorNode[],
  edges: readonly Pick<EditorEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>[],
): Map<string, string> {
  const used = new Map<string, Set<string>>();
  const note = (node: string, handle: string | null | undefined): void => {
    if (handle === null || handle === undefined) return;
    const set = used.get(node) ?? new Set<string>();
    set.add(handle);
    used.set(node, set);
  };
  for (const edge of edges) {
    note(edge.source, edge.sourceHandle);
    note(edge.target, edge.targetHandle);
  }
  const out = new Map<string, string>();
  for (const node of nodes) {
    const placed = placedNode(node.id, node.data, node.position);
    const parts: string[] = [];
    if (node.data.kind === 'segment' && node.data.breakout !== undefined) {
      parts.push(`turn ${node.data.breakout.rotation.a}/${node.data.breakout.rotation.b}`);
    }
    for (const handle of [...(used.get(node.id) ?? [])].sort()) {
      const at = anchorOf(placed, handle);
      parts.push(
        at === undefined
          ? `${handle} ?`
          : `${handle} ${Math.round(at.x - node.position.x)},${Math.round(at.y - node.position.y)}`,
      );
    }
    out.set(node.id, parts.join(';'));
  }
  return out;
}

/** The ids of nodes still there whose handle signature changed. */
export function changedHandleNodes(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...after].filter(([id, sig]) => before.has(id) && before.get(id) !== sig).map(([id]) => id);
}
