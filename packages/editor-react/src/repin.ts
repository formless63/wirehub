/**
 * Re-pinning a wire by dragging its end.
 *
 * A selected wire shows a grip on each end that can move; dragging a grip
 * onto another pin, pad or face element moves that end of the joint(s) the
 * edge draws — one `move-joint-ends` edit, validated whole, one undo step.
 * Dragging from a pin (not a grip) still starts a new wire, as before.
 *
 * Which ends can move: the end whose handle is, for every joint the edge
 * draws, one side of that joint. A plain wire moves at both ends; a ground
 * bundle (several screens onto one pad) and a pigtail braid move only at
 * their landing — their other end is a port standing for several screens, or
 * for one braid of a twist, and moving it is a pigtail edit, not a re-pin.
 */

import { parseTerminalKey, terminalKey, type CableDesign, type JointEndMove, type TerminalRef } from '@cable-studio/model';

import { terminalKeyOfHandle } from './board-art.ts';
import type { EditorEdgeData } from './derive.ts';

export type EdgeEnd = 'source' | 'target';

/** The part of a React Flow edge re-pinning reads. */
export interface RepinEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: EditorEdgeData | undefined;
}

/** The part of a React Flow connection re-pinning reads. */
export interface RepinConnection {
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

/** For each joint the edge draws, which side of it this end of the edge is — or nothing, if any joint has no such side. */
export function endSides(design: CableDesign, edge: RepinEdge, end: EdgeEnd): Omit<JointEndMove, 'to'>[] | undefined {
  const data = edge.data;
  if (data === undefined || data.mould !== undefined || data.docked === true || data.stub === true) return undefined;
  const handle = end === 'source' ? edge.sourceHandle : edge.targetHandle;
  if (handle === null || handle === undefined || data.joints.length === 0) return undefined;
  const key = terminalKeyOfHandle(handle);
  const sides: Omit<JointEndMove, 'to'>[] = [];
  for (const index of data.joints) {
    const joint = design.joints[index];
    if (joint === undefined) return undefined;
    const side = terminalKey(joint.a) === key ? 'a' : terminalKey(joint.b) === key ? 'b' : undefined;
    if (side === undefined) return undefined;
    sides.push({ index, side });
  }
  return sides;
}

/** What React Flow's `reconnectable` should be for this edge: the ends that can move. */
export function reconnectableEnds(design: CableDesign, edge: RepinEdge): boolean | EdgeEnd {
  const source = endSides(design, edge, 'source') !== undefined;
  const target = endSides(design, edge, 'target') !== undefined;
  return source && target ? true : source ? 'source' : target ? 'target' : false;
}

/**
 * The moves a finished reconnect gesture asks for: the dragged end of `edge`
 * onto the handle it was dropped on. `undefined` when the gesture moved
 * nothing this module understands (a grip that cannot move, a drop back
 * where it started).
 *
 * React Flow hands back a connection whose one end is the edge's fixed end;
 * in loose mode it may have swapped source and target, so the fixed end is
 * found by matching, not assumed.
 */
export function reconnectMoves(
  design: CableDesign,
  edge: RepinEdge,
  connection: RepinConnection,
  refOf: (node: string, handle: string) => TerminalRef = (_node, handle) => parseTerminalKey(terminalKeyOfHandle(handle)),
): JointEndMove[] | undefined {
  const same = (node: string, handle: string | null, n: string, h: string | null | undefined): boolean =>
    node === n && handle === (h ?? null);
  let dragged: EdgeEnd;
  let drop: { node: string; handle: string | null };
  if (same(connection.source, connection.sourceHandle, edge.source, edge.sourceHandle)) {
    dragged = 'target';
    drop = { node: connection.target, handle: connection.targetHandle };
  } else if (same(connection.target, connection.targetHandle, edge.target, edge.targetHandle)) {
    dragged = 'source';
    drop = { node: connection.source, handle: connection.sourceHandle };
  } else if (same(connection.target, connection.targetHandle, edge.source, edge.sourceHandle)) {
    dragged = 'target';
    drop = { node: connection.source, handle: connection.sourceHandle };
  } else if (same(connection.source, connection.sourceHandle, edge.target, edge.targetHandle)) {
    dragged = 'source';
    drop = { node: connection.target, handle: connection.targetHandle };
  } else {
    return undefined;
  }
  if (drop.handle === null) return undefined;
  const sides = endSides(design, edge, dragged);
  if (sides === undefined) return undefined;
  const to = refOf(drop.node, drop.handle);
  return sides.map((side) => ({ ...side, to }));
}
