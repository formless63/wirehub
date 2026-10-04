/**
 * The connection model (spec: ui-redesign, Canvas v2 item 6).
 *
 * A **connection** is every joint between one instance (or one wire end of a
 * segment instance) and another — not a single edge on the canvas, which may
 * draw just one conductor or one ground bundle. Clicking any edge between
 * `u1` and `w1`'s end `a` selects the *whole* connection: every pad the two
 * land on together, R/G/B/S/5V/LA/RA plus both ground bundles.
 *
 * Pure — no React, no DOM, no `Db` — so the grouping rule has its own tests
 * independent of how the panel renders a row. `panels/connection-rows.ts`
 * turns a `Connection` into display rows; this module only decides which
 * joints belong to which connection.
 */

import { terminalKey, type CableDesign, type Joint, type TerminalRef } from '@cable-studio/model';

import type { Selection } from './store.ts';

/**
 * One side of a connection: an instance, and — only when that instance is a
 * segment — the wire end this side lands on. Convention: end `a` = source
 * (console) side, `b` = destination side (same as `TerminalRef.end`).
 */
export interface ConnectionEnd {
  instance: string;
  end?: 'a' | 'b';
}

/** Every joint running between `a` and `b`, in `design.joints` order. */
export interface Connection {
  a: ConnectionEnd;
  b: ConnectionEnd;
  /** indices into `design.joints` */
  joints: number[];
}

/** The `ConnectionEnd` a terminal ref lands on — its instance, plus its end when it has one. */
export function endOfTerminal(ref: TerminalRef): ConnectionEnd {
  return ref.end === undefined ? { instance: ref.instance } : { instance: ref.instance, end: ref.end };
}

/** Stable string form of one end, for keying and equality. */
export function connectionEndKey(end: ConnectionEnd): string {
  return end.end === undefined ? end.instance : `${end.instance}@${end.end}`;
}

/** Order-independent identity of the connection between `a` and `b`. */
export function connectionKey(a: ConnectionEnd, b: ConnectionEnd): string {
  const x = connectionEndKey(a);
  const y = connectionEndKey(b);
  return x <= y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

/** Is this instance a segment (a wire, with ends)? */
export function isSegmentInstance(design: CableDesign, instanceId: string): boolean {
  return design.instances.segments.some((instance) => instance.id === instanceId);
}

/**
 * `a`/`b`, ordered so a segment (when there is exactly one) is named `b` —
 * "u1 → w1 · end a" reads pad-instance-first, the way the mockup's header
 * does. Two segments, or two non-segments, keep first-seen order.
 */
function canonicalOrder(
  design: CableDesign,
  x: ConnectionEnd,
  y: ConnectionEnd,
): [ConnectionEnd, ConnectionEnd] {
  const xSeg = isSegmentInstance(design, x.instance);
  const ySeg = isSegmentInstance(design, y.instance);
  if (ySeg && !xSeg) return [x, y];
  if (xSeg && !ySeg) return [y, x];
  return [x, y];
}

/** Every connection in the design: joints grouped by the instance(+end) pair they run between. */
export function connectionsOf(design: CableDesign): Connection[] {
  const byKey = new Map<string, Connection>();
  design.joints.forEach((joint, index) => {
    const x = endOfTerminal(joint.a);
    const y = endOfTerminal(joint.b);
    const key = connectionKey(x, y);
    let entry = byKey.get(key);
    if (entry === undefined) {
      const [a, b] = canonicalOrder(design, x, y);
      entry = { a, b, joints: [] };
      byKey.set(key, entry);
    }
    entry.joints.push(index);
  });
  return [...byKey.values()];
}

/** The connection joint `index` belongs to — every joint sharing its instance pair (and ends). */
export function connectionOfJoint(design: CableDesign, index: number): Connection | undefined {
  const joint = design.joints[index];
  if (joint === undefined) return undefined;
  const key = connectionKey(endOfTerminal(joint.a), endOfTerminal(joint.b));
  return connectionsOf(design).find((connection) => connectionKey(connection.a, connection.b) === key);
}

/** The connection carrying the first joint that lands on this terminal, if any. */
export function connectionOfTerminal(design: CableDesign, ref: TerminalRef): Connection | undefined {
  const key = terminalKey(ref);
  const index = design.joints.findIndex(
    (joint) => terminalKey(joint.a) === key || terminalKey(joint.b) === key,
  );
  return index === -1 ? undefined : connectionOfJoint(design, index);
}

/** Every connection this instance takes part in (as either side, at either end). */
export function connectionsOfInstance(design: CableDesign, instanceId: string): Connection[] {
  return connectionsOf(design).filter(
    (connection) => connection.a.instance === instanceId || connection.b.instance === instanceId,
  );
}

/**
 * The connection the current selection implies, for the Connection tab: a
 * joint or a ground bundle names its connection directly; a terminal names
 * whichever connection its first joint belongs to (a bare pin selects
 * nothing — there is nothing to show a wire list *of* yet). An instance
 * selection is not a connection — see `connectionsOfInstance`, the Part tab's
 * list.
 */
export function connectionForSelection(
  design: CableDesign,
  selection: Selection | undefined,
): Connection | undefined {
  if (selection === undefined) return undefined;
  switch (selection.kind) {
    case 'joint':
      return connectionOfJoint(design, selection.index);
    case 'joints': {
      const [first] = selection.indices;
      return first === undefined ? undefined : connectionOfJoint(design, first);
    }
    case 'terminal':
      return connectionOfTerminal(design, selection.ref);
    case 'instance':
      return undefined;
  }
}

/** The joint's two terminal refs, ordered to match `connection.a`/`.b`. */
export function orientJoint(connection: Connection, joint: Joint): { a: TerminalRef; b: TerminalRef } {
  const aEnd = endOfTerminal(joint.a);
  return connectionEndKey(aEnd) === connectionEndKey(connection.a)
    ? { a: joint.a, b: joint.b }
    : { a: joint.b, b: joint.a };
}

function formatEnd(end: ConnectionEnd): string {
  return end.end === undefined ? end.instance : `${end.instance} · end ${end.end}`;
}

/** "u1 → w1 · end a" — the Connection tab's header line, and a good test/aria label. */
export function connectionLabel(connection: Connection): string {
  return `${formatEnd(connection.a)} → ${formatEnd(connection.b)}`;
}
