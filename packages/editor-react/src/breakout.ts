/**
 * Breakouts: how the canvas gets from a conductor on a wire's cut face to the
 * pad it is soldered to without a bowl of spaghetti (spec: ui-redesign,
 * Canvas v2 items 3 and 4).
 *
 * Pure geometry — no React, no DOM — and purely presentational: nothing here
 * is ever written into the design. `derive.ts` runs it once the nodes are
 * placed; `nodes/WireNode.tsx` paints the ports and stubs it returns and
 * `edges.tsx` draws the edges along `edgeRoute`.
 *
 * ## Ports
 *
 * Each end of a wire drawn as its cut face (`wire-art.ts`) gets a **port
 * column** in the clear band outside the face: one port per distinct
 * destination — a conductor's own, or one per **ground bundle** (every shield
 * and drain of that end landing on the same terminal). The column is ordered
 * by the vertical order of the terminals the ports go to, so the edges from
 * one column never cross: they all leave the same x, reach the same entry
 * column, and bend with the same control distance, which makes each curve a
 * convex blend of its two end heights — two curves whose ends are in the same
 * order stay in that order all the way.
 *
 * Each conductor reaches its port along a **stub** that the node draws beneath
 * the face, so it appears to leave the jacket's edge.
 *
 * ## Pigtails
 *
 * A **pigtail** of the design (`SegmentInstance.pigtails`, shield bonding —
 * `specs/shield-bonding.md`) is drawn as its member braids, each running on
 * its own from its element on the face, through its own port, to the pad the
 * pigtail lands on — they converge at the pad, the way the bench twists them
 * right at the board (owner, 2026-09-25: "they should
 * show separately like they do already on the destination side", not joined
 * at the cable face and split from there). Its members are the pigtail's
 * `members`, or — a mass pigtail on a fully bonded stock — the one element
 * the face draws for the mass. Every member port carries the pigtail's one
 * landing joint and its `pigtail` (id, terminal key, all members), so
 * hovering or selecting any braid lights the whole twist. The grouping is
 * the data's, never guessed from shared pads.
 *
 * ## Pads
 *
 * A joint that names its physical pad (`TerminalRef.pad`, a multi-pad board
 * terminal such as GND) is drawn to that pad's own handle on the board art,
 * not to the terminal's primary pad (`padHandle` in `planBreakouts`).
 *
 * ## Rotation
 *
 * The builder can turn the cable, so each face is turned (3° steps) to the
 * angle with the fewest **inversions** between its conductors' vertical order
 * and their ports' order; ties go to the shortest stubs, then the smallest
 * angle. The angle and both inversion counts are reported per end.
 *
 * ## Fallbacks
 *
 * A wire drawn as element rows (no documented face), a terminal with no
 * handle on the canvas, a node with no geometry: the joint keeps a direct
 * edge between its two handles — still routed with horizontal tangents, so
 * edges between the same two columns keep their order where the parts allow.
 */

import { pigtailOfTerminal, terminalKey, type CableDesign, type TerminalRef } from '@wirehub/model';

import { BOARD_LAYOUT, type Facing } from './board-art.ts';
import type { EditorNodeData } from './derive.ts';
import { BOX, estimateNodeSize, rowsTop, type NodeSize } from './layout-size.ts';
import {
  WIRE_LAYOUT,
  endFacing,
  type WireArt,
  type WireEnd,
  type WireFaceArt,
  type WireHandleArt,
} from './wire-art.ts';

export interface XY {
  x: number;
  y: number;
}

/** Every constant the breakout is drawn with, in CSS pixels. */
export const BREAKOUT_LAYOUT = {
  /** a port sits this far in from its side of the wire art */
  portInset: 12,
  /** between two ports, at most */
  portPitch: 17,
  /** a port column keeps this clear of the art's top and bottom */
  portMargin: 8,
  /** the rotation search step, degrees */
  step: 3,
  /** an edge's bend never gets shorter than this */
  minBend: 30,
} as const;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type PortKind = 'conductor' | 'ground';

/** One element feeding a port. */
export interface PortMember {
  /** the element's terminal key at this end */
  key: string;
  terminal: string;
  role: WireHandleArt['role'];
  /** how it reads, when that is not its path — a bonded multi-core mass (e5c.25) */
  label?: string;
}

/** One stub: an element to its port, drawn beneath the face. */
export interface PortStub {
  key: string;
  role: WireHandleArt['role'];
  /** SVG path, art-area coordinates */
  d: string;
}

/** The design pigtail a ground port's braid belongs to (one port per member braid). */
export interface Pigtail {
  /** the design pigtail's id (`rgb`), at the port's end */
  id: string;
  /** its terminal key (`w1:pigtail:rgb@b`): the hover id all of its braids share */
  key: string;
  /** where it lands, in words: `u1:GND · H10` */
  landing: string;
  /** every braid twisted into it */
  members: PortMember[];
}

/** One port on a wire end's column. */
export interface BreakoutPort {
  /** React Flow handle id: the first member's terminal key + `~port.<n>` */
  id: string;
  end: WireEnd;
  kind: PortKind;
  /** conductor colour name (conductor ports) */
  colorName?: string;
  /** art-area coordinates */
  x: number;
  y: number;
  facing: Facing;
  members: PortMember[];
  /** the joints this port carries (indices into `design.joints`) */
  joints: number[];
  /** the terminal key every one of its joints lands on at the other end */
  target: string;
  /** one stub per member */
  stubs: PortStub[];
  /** the design pigtail this braid is twisted into */
  pigtail?: Pigtail;
  /** one of its joints is the current selection */
  selected: boolean;
}

/** One end's column, and the face turn chosen for it. */
export interface EndBreakout {
  end: WireEnd;
  /** degrees, counter-clockwise on screen — the angle passed to `wireArt` */
  rotationDeg: number;
  /** conductor-order vs port-order inversions at that angle… */
  inversions: number;
  /** …and at 0°, for comparison */
  inversionsAtZero: number;
  ports: BreakoutPort[];
}

/** A wire node's breakouts: both ends, when each has any joint. */
export interface WireBreakout {
  rotation: Record<WireEnd, number>;
  ends: EndBreakout[];
}

/** The separator between a terminal key and a port suffix (see `terminalKeyOfHandle`). */
export const PORT_SUFFIX = '~port.';

/**
 * The handle ids of one end's ports, in column order: the first member's
 * terminal key, then `~port.<n>`, where `n` counts the ports that share that
 * first member (a conductor landing on two pins has two), ordered by what they
 * land on — never by where the port sits in the column.
 *
 * The id must not depend on the column order: React
 * Flow finds an edge's end by handle id in its cached handle bounds, so an id
 * that shifts when a port above it goes (a wire deleted) or when the router
 * re-sorts the column (a part dragged) makes every edge below it vanish until
 * something re-measures the node.
 */
function stablePortIds(groups: readonly Group[], fallback: string): string[] {
  const firsts = groups.map((group) => group.members[0]?.key ?? fallback);
  return groups.map((group, index) => {
    const first = firsts[index] ?? fallback;
    const n = groups.filter(
      (other, at) =>
        firsts[at] === first &&
        (other.other < group.other || (other.other === group.other && at < index)),
    ).length;
    return `${first}${PORT_SUFFIX}${n}`;
  });
}

/** Is this handle id a breakout port? */
export function isPortHandle(handleId: string): boolean {
  return handleId.includes(PORT_SUFFIX);
}

/* ------------------------------------------------------------------ *
 * Where handles sit (estimated, in flow coordinates)
 * ------------------------------------------------------------------ */

/** A node as the router sees it. */
export interface PlacedNode {
  id: string;
  data: EditorNodeData;
  position: XY;
  size: NodeSize;
}

/** One handle on the canvas. */
export interface Anchor extends XY {
  /** the side of the node its edges leave through */
  facing: Facing;
  /**
   * For a handle *inside* its node (a pad on a board): the x of the node's
   * outer edge on `facing`'s side. Every edge to that node crosses it at the
   * handle's own height, so edges keep their order up to the node.
   */
  entryX?: number;
  /**
   * A docked connector's own pin (its face box sits inside its board's dock
   * bay): the y just below the whole board node. An edge to anything but the
   * board leaves through `entryX` — the dock bay's own outer edge, which
   * coincides with the board's own edge — first: a horizontal stub at the
   * pin's own height (the one bit allowed inside the board, since it is
   * inside the connector itself), then straight down along that same edge to
   * here (; the two orthogonal segments in place of one
   * diagonal lead are).
   */
  entryY?: number;
  /**
   * The same docked pin's own bend does not start at `entryX`/`entryY`
   * either: that point is still directly under the board (any target on the
   * board's far side sits across the board's whole width from it, and the
   * usual horizontal-tangent bend curve between two such points re-enters the
   * board on the way, exactly like the one-segment diagonal it replaced).
   * `clearX` is the board's *other* edge — the one away from the dock bay,
   * toward wherever the rest of the design actually is — so the route runs
   * along below the whole board (`entryY`, from `entryX` to `clearX`) before
   * the bend starts, never once crossing back over it.
   */
  clearX?: number;
  /**
   * A board pad's own wire-approach direction (`BoardHandleArt.approach`,
   *): degrees, standard math convention, node screen
   * space — already turned through the board's own quarter-turn and (for a
   * bottom pad) the mirror, exactly as `x`/`y` are, so a "straight-in" board
   * (whose KiCad pads resolve to some cardinal angle) comes out horizontal
   * here too and `edgeRoute` draws the same lead it always has; only a
   * genuinely angled row (SCART's chamfered corner) comes out oblique.
   * `undefined` when the KiCad file gave the pad no orientation at all.
   */
  approach?: number;
  /** How far the approach lead-in runs before the bend starts (`BoardHandleArt.approachLead`). */
  approachLead?: number;
  /**
   * The pad's slot on its row's entry guide, as an offset from the handle
   * (`BoardHandleArt.slot`). The edge runs level with
   * the slot from the node's entry column, meets the slot, then goes
   * straight in to the pad.
   */
  slot?: { dx: number; dy: number };
}

/** The height an edge reaches its anchor at: its guide slot's, when it has one. */
export function routeY(anchor: Anchor): number {
  return anchor.y + (anchor.slot?.dy ?? 0);
}

export function placedNode(id: string, data: EditorNodeData, position: XY): PlacedNode {
  return { id, data, position, size: estimateNodeSize(data) };
}

function rowAnchor(node: PlacedNode, index: number, side: 'left' | 'right', extra = 0): Anchor {
  return {
    x: side === 'left' ? node.position.x : node.position.x + node.size.width,
    y: node.position.y + rowsTop(node.data) + extra + index * BOX.row + BOX.row / 2,
    facing: side,
  };
}

/** The art area's top-left corner, in flow coordinates. */
function artOrigin(node: PlacedNode, artWidth: number, head: number): XY {
  // `.cs-board-art` is centred in its node (`margin: 0 auto`); the wire art
  // fills its node
  const inner = node.size.width - BOX.border * 2;
  return {
    x: node.position.x + BOX.border + Math.max(0, (inner - artWidth) / 2),
    y: node.position.y + BOX.border + head,
  };
}

/**
 * Where a handle sits, estimated from the node's data and position — the
 * same numbers the node renders with, so exact for artwork and within a
 * pixel or two for rows. `undefined` when the node has no such handle.
 */
export function anchorOf(node: PlacedNode, handleId: string): Anchor | undefined {
  const data = node.data;
  switch (data.kind) {
    case 'pcba': {
      if (data.board !== undefined) {
        const handle = data.board.handles.find((candidate) => candidate.id === handleId);
        if (handle === undefined) return undefined;
        const origin = artOrigin(node, data.board.width, BOARD_LAYOUT.head);
        return {
          x: origin.x + handle.x,
          y: origin.y + handle.y,
          facing: handle.facing,
          entryX: handle.facing === 'left' ? node.position.x : node.position.x + node.size.width,
          ...(handle.approach === undefined
            ? {}
            : { approach: handle.approach, ...(handle.approachLead === undefined ? {} : { approachLead: handle.approachLead }) }),
          ...(handle.slot === undefined ? {} : { slot: handle.slot }),
        };
      }
      const away: Facing = data.cableFacing === 'left' ? 'right' : 'left';
      const pad = data.pads.findIndex((row) => row.key === handleId);
      if (pad !== -1) return rowAnchor(node, pad, data.cableFacing, BOX.sideLabel);
      const pin = data.integrated.findIndex((row) => row.key === handleId);
      if (pin !== -1) return rowAnchor(node, pin, away, BOX.sideLabel);
      return undefined;
    }
    case 'segment': {
      if (data.wire !== undefined) {
        const origin = artOrigin(node, data.wire.width, WIRE_LAYOUT.head);
        for (const end of data.breakout?.ends ?? []) {
          const port = end.ports.find((candidate) => candidate.id === handleId);
          if (port !== undefined) {
            return { x: origin.x + port.x, y: origin.y + port.y, facing: port.facing };
          }
        }
        const handle =
          data.wire.handles.find((candidate) => candidate.id === handleId) ??
          data.wire.handles.find((candidate) => candidate.id === data.wire?.foldedAliases[handleId]);
        if (handle === undefined) return undefined;
        return { x: origin.x + handle.x, y: origin.y + handle.y, facing: handle.facing };
      }
      const index = data.elements.findIndex(
        (element) => element.a.key === handleId || element.b.key === handleId,
      );
      if (index === -1) return undefined;
      const element = data.elements[index];
      const end: WireEnd = element?.a.key === handleId ? 'a' : 'b';
      return rowAnchor(node, index, endFacing(end, data.flipped));
    }
    case 'connector': {
      if (data.art !== undefined) {
        const colon = handleId.indexOf(':');
        if (handleId.slice(0, colon) !== node.id) return undefined;
        const terminal = handleId.slice(colon + 1);
        const pin = data.art.art.pins.find((candidate) => candidate.terminal === terminal);
        if (pin === undefined) return undefined;
        // a docked connector has no header or border: the node is its art area
        const head = data.dock === undefined ? BOX.border + BOARD_LAYOUT.head : 0;
        const inset = data.dock === undefined ? BOX.border : 0;
        const facing: Facing = data.dock?.facing ?? data.rows[0]?.side ?? 'right';
        const entryX =
          data.dock !== undefined
            ? node.position.x + data.dock.entryDx
            : facing === 'left'
              ? node.position.x
              : node.position.x + node.size.width;
        // a free face's pin leaves through its own slot on the exit fan (e5c.35)
        const slot = data.dock === undefined ? data.fan?.[terminal] : undefined;
        return {
          x: node.position.x + inset + data.art.ox + pin.x,
          y: node.position.y + head + data.art.oy + pin.y,
          facing,
          entryX,
          ...(slot === undefined ? {} : { slot: { dx: slot.x - pin.x, dy: slot.y - pin.y } }),
          // a docked pin's stray edge (not to its own board) dips below the
          // board node, runs clear along under it, and only then bends toward
          // its real target — see `entryY`/`clearX`
          ...(data.dock === undefined
            ? {}
            : {
                entryY: node.position.y + data.dock.entryDy,
                clearX: node.position.x + data.dock.clearDx,
              }),
        };
      }
      const index = data.rows.findIndex((row) => row.key === handleId);
      const row = data.rows[index];
      return row === undefined ? undefined : rowAnchor(node, index, row.side);
    }
    case 'component': {
      // `.cs-part` is one flex line: the first lead on the left, the rest right
      const index = data.rows.findIndex((row) => row.key === handleId);
      if (index === -1) return undefined;
      return rowAnchor(node, 0, index === 0 ? 'left' : 'right');
    }
    case 'breakout': {
      // a mould (`moulds.ts`): the trunk comes in on the left, runs leave on the right
      const index = data.rows.findIndex((row) => row.inHandle === handleId || row.outHandle === handleId);
      const row = data.rows[index];
      if (row === undefined) return undefined;
      return rowAnchor(node, index, row.inHandle === handleId ? 'left' : 'right');
    }
  }
}

/* ------------------------------------------------------------------ *
 * The edge route
 * ------------------------------------------------------------------ */

/** One edge, as the router draws it: straight leads to the entry columns, one bend between. */
export interface EdgeRoute {
  start: XY;
  /**
   * Extra waypoints between `start` and `from`, drawn as straight lines —
   * either a docked pin's own stray edge (`Anchor.entryY`/`clearX`): two
   * waypoints, the dock bay's own outer edge at the pin's own height (a stub,
   * still inside the connector, and so inside the board too: the one
   * exception allows), then that same edge's foot,
   * straight down at the board's own boundary line (`from` itself moves to
   * the board's *other* edge, so the bend's own horizontal tangent starts
   * already clear of the whole board on both axes, not just dropped below it
   * — see `from`'s note) — or an angled pad's own approach lead
   * (`Anchor.approach`): one waypoint, the far end of a
   * straight run along the pad's own wire-approach direction, so the wire's
   * very last stretch out of the pad matches the angle it actually sits at
   * instead of cutting across a neighbour's pad. Never both on one side (the
   * two sources are mutually exclusive — see `anchorOf`).
   */
  sourceLead?: XY[];
  /**
   * Where the bend starts: ordinarily the start itself or its node's entry
   * column. A docked pin's own stray edge instead puts this at the board's
   * far edge (`Anchor.clearX`), reached from `start` via `sourceLead` — never
   * at the near edge (`entryX`) directly, whose bend curve toward a target on
   * the board's far side would still cross the board on the way there,
   * exactly as the single diagonal lead it replaced did.
   */
  from: XY;
  c1: XY;
  c2: XY;
  /** where the bend ends — `from`'s mirror, target side */
  to: XY;
  /** `sourceLead`'s mirror, target side: `to` to `end`, in that order */
  targetLead?: XY[];
  end: XY;
  /**
   * A docked pin's stray-edge lead runs exactly along the board's own edge,
   * so its corners stay square (rounding them would cut into the board);
   * every other lead corner is rounded (`LEAD_FILLET`, e5c.30).
   */
  squareLeads?: { source?: true; target?: true };
}

export interface RouteInput {
  source: XY;
  target: XY;
  sourceFacing: Facing;
  targetFacing: Facing;
  sourceEntryX?: number | undefined;
  targetEntryX?: number | undefined;
  /** see `Anchor.entryY` */
  sourceEntryY?: number | undefined;
  targetEntryY?: number | undefined;
  /** see `Anchor.clearX` */
  sourceClearX?: number | undefined;
  targetClearX?: number | undefined;
  /** see `Anchor.approach` */
  sourceApproach?: number | undefined;
  targetApproach?: number | undefined;
  /** see `Anchor.approachLead` */
  sourceApproachLead?: number | undefined;
  targetApproachLead?: number | undefined;
  /** see `Anchor.slot` */
  sourceSlot?: { dx: number; dy: number } | undefined;
  targetSlot?: { dx: number; dy: number } | undefined;
}

const sign = (facing: Facing): number => (facing === 'left' ? -1 : 1);

/** A unit direction from a standard-math-convention angle (degrees). */
function approachVector(deg: number): XY {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

function along(point: XY, direction: XY, distance: number): XY {
  return { x: point.x + direction.x * distance, y: point.y + direction.y * distance };
}

/**
 * The route an edge takes. Both bends leave horizontally, with a control
 * distance that depends only on the two entry columns' x — every edge between
 * the same two columns bends identically, which is what keeps them from
 * crossing when their ends are in the same order.
 *
 * A docked pin's own stray edge (`entryY`/`clearX` given) gets a lead besides:
 * out to the dock bay's own edge at the pin's own height, straight down (or
 * up) that edge to below the whole board, then along under it to the board's
 * *other* edge — where `from`/`to` themselves land — before the bend starts.
 * Never a single diagonal lead straight from the pin, which could cut across
 * the board on the way; never a bend starting right under the board either,
 * whose curve toward a target on the board's far side would still cross it
 * (e5c.10, corrected by e5c.15).
 *
 * A board pad whose row sits at a real angle (`sourceApproach`/`targetApproach`,
 * — never given for a docked pin, which has no pad axis of
 * its own) gets a lead besides, the same way: the bend itself — `from`/`to`,
 * `c1`/`c2`, the whole shared-column ordering that keeps same-column edges
 * from crossing — is **untouched**, so nothing here can newly cross an edge
 * that did not before; only the final short run from the entry column in to
 * the pad itself (`from`→`start`, `to`→`end`, ordinarily one straight line)
 * gains a waypoint at the end of a straight lead along the pad's own approach
 * direction (`sourceApproachLead`/`targetApproachLead`, long enough to clear a
 * neighbouring pad), so the wire's very last stretch — the part that would
 * otherwise cut across a neighbour's pad — arrives from the angle the pad
 * actually sits at. A "straight-in" pad (no `approach` given, or one so close
 * to horizontal that `boardArt` left it unset) draws exactly as before.
 */
export function edgeRoute(input: RouteInput): EdgeRoute {
  // a docked pin's own stray edge (`entryY` given): the stub to the dock
  // bay's own edge, then straight down it to below the whole board — `from`/
  // `to` themselves move on to the board's *other* edge (`clearX`), so the
  // bend that follows never has to cross back over the board to get there
  const sourceCorner: XY | undefined =
    input.sourceEntryY === undefined
      ? undefined
      : { x: input.sourceEntryX ?? input.source.x, y: input.source.y };
  const sourceBelow: XY | undefined =
    input.sourceEntryY === undefined
      ? undefined
      : { x: input.sourceEntryX ?? input.source.x, y: input.sourceEntryY };
  const targetCorner: XY | undefined =
    input.targetEntryY === undefined
      ? undefined
      : { x: input.targetEntryX ?? input.target.x, y: input.target.y };
  const targetBelow: XY | undefined =
    input.targetEntryY === undefined
      ? undefined
      : { x: input.targetEntryX ?? input.target.x, y: input.targetEntryY };
  // a guided pad (e5c.28): the bend meets the entry column level with the
  // pad's slot on its row's entry guide, off the board; the slot, then the
  // pad, follow as straight leads
  const sourceSlot: XY | undefined =
    input.sourceSlot === undefined
      ? undefined
      : { x: input.source.x + input.sourceSlot.dx, y: input.source.y + input.sourceSlot.dy };
  const targetSlot: XY | undefined =
    input.targetSlot === undefined
      ? undefined
      : { x: input.target.x + input.targetSlot.dx, y: input.target.y + input.targetSlot.dy };
  const from =
    sourceBelow === undefined
      ? { x: input.sourceEntryX ?? (sourceSlot ?? input.source).x, y: (sourceSlot ?? input.source).y }
      : { x: input.sourceClearX ?? sourceBelow.x, y: sourceBelow.y };
  const to =
    targetBelow === undefined
      ? { x: input.targetEntryX ?? (targetSlot ?? input.target).x, y: (targetSlot ?? input.target).y }
      : { x: input.targetClearX ?? targetBelow.x, y: targetBelow.y };
  const bend = Math.max(BREAKOUT_LAYOUT.minBend, Math.abs(to.x - from.x) * 0.5);
  // the approach lead is never combined with a docked pin's own stray-edge
  // lead (`Anchor.approach` and `Anchor.entryY` are mutually exclusive — see
  // `anchorOf`), so at most one of a pin's corner/below or a pad's approach
  // point ever applies on a given side.
  const sourceApproachPoint: XY | undefined =
    input.sourceApproach === undefined
      ? undefined
      : along(input.source, approachVector(input.sourceApproach), input.sourceApproachLead ?? BREAKOUT_LAYOUT.minBend);
  const targetApproachPoint: XY | undefined =
    input.targetApproach === undefined
      ? undefined
      : along(input.target, approachVector(input.targetApproach), input.targetApproachLead ?? BREAKOUT_LAYOUT.minBend);
  const sourceLead: XY[] | undefined =
    sourceCorner !== undefined && sourceBelow !== undefined
      ? [sourceCorner, sourceBelow]
      : sourceSlot !== undefined
        ? [sourceSlot]
        : sourceApproachPoint !== undefined
          ? [sourceApproachPoint]
          : undefined;
  const targetLead: XY[] | undefined =
    targetCorner !== undefined && targetBelow !== undefined
      ? [targetBelow, targetCorner]
      : targetSlot !== undefined
        ? [targetSlot]
        : targetApproachPoint !== undefined
          ? [targetApproachPoint]
          : undefined;
  return {
    start: input.source,
    ...(sourceLead === undefined ? {} : { sourceLead }),
    from,
    c1: { x: from.x + sign(input.sourceFacing) * bend, y: from.y },
    c2: { x: to.x + sign(input.targetFacing) * bend, y: to.y },
    to,
    ...(targetLead === undefined ? {} : { targetLead }),
    end: input.target,
    ...(sourceBelow === undefined && targetBelow === undefined
      ? {}
      : {
          squareLeads: {
            ...(sourceBelow === undefined ? {} : { source: true as const }),
            ...(targetBelow === undefined ? {} : { target: true as const }),
          },
        }),
  };
}

const f = (value: number): string => (Math.round(value * 100) / 100).toString();

/**
 * How tight a lead's corners are rounded: the radius,
 * CSS px, of the tangent arc that replaces each hard corner along an edge's
 * straight leads — an entry-guide slot, an exit slot, a docked pin's stray
 * edge, the joint between the last lead and the bend. Never more than half
 * of either segment it joins, so it cannot swing wide of a short lead.
 */
export const LEAD_FILLET = 6;

/** One piece of a drawn lead: a straight run, or a tangent arc, to `to`. */
type Piece = { kind: 'line'; to: XY } | { kind: 'arc'; to: XY; r: number; sweep: 0 | 1; centre: XY; from: XY };

function unit(a: XY, b: XY): { u: XY; len: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? { u: { x: 0, y: 0 }, len: 0 } : { u: { x: dx / len, y: dy / len }, len };
}

interface Rounded {
  /** where the run is drawn from (moved onto the arc when its first point is a rounded corner) */
  start: XY;
  pieces: Piece[];
}

/**
 * A polyline's corners rounded with tangent arcs. A corner whose turn is under
 * a degree (straight on) or over 175° (a reversal) stays hard. `before`/`after`
 * are extra points beyond either end that only give that end's corner its other
 * tangent (the bend's control arm): nothing is drawn to them, and the end point
 * itself moves to the arc's tangent point on that arm.
 */
function filleted(points: readonly XY[], radius: number, before?: XY, after?: XY): Rounded {
  const pts: XY[] = [];
  for (const point of [...(before === undefined ? [] : [before]), ...points, ...(after === undefined ? [] : [after])]) {
    const last = pts[pts.length - 1];
    if (last === undefined || Math.hypot(point.x - last.x, point.y - last.y) > 1e-6) pts.push(point);
  }
  const first = before === undefined ? 0 : 1;
  const lastIndex = pts.length - 1 - (after === undefined ? 0 : 1);
  let start = pts[first] ?? points[0] ?? { x: 0, y: 0 };
  const pieces: Piece[] = [];
  let endMoved = false;
  for (let i = Math.max(1, first); i <= Math.min(lastIndex, pts.length - 2); i += 1) {
    const prev = pts[i - 1]!;
    const corner = pts[i]!;
    const next = pts[i + 1]!;
    const a = unit(prev, corner);
    const b = unit(corner, next);
    const turn = Math.acos(Math.max(-1, Math.min(1, a.u.x * b.u.x + a.u.y * b.u.y)));
    const hard = radius <= 0 || a.len === 0 || b.len === 0 || turn < Math.PI / 180 || turn > (175 * Math.PI) / 180;
    if (hard) {
      if (i !== first) pieces.push({ kind: 'line', to: corner });
      continue;
    }
    // tangent distance at the wanted radius, held to half of each real
    // segment (a control arm counts whole: it is only a tangent)
    const tan = Math.tan(turn / 2);
    const t = Math.min(radius * tan, i - 1 < first ? a.len : a.len / 2, i + 1 > lastIndex ? b.len : b.len / 2);
    const r = t / tan;
    const p = { x: corner.x - a.u.x * t, y: corner.y - a.u.y * t };
    const q = { x: corner.x + b.u.x * t, y: corner.y + b.u.y * t };
    const cross = a.u.x * b.u.y - a.u.y * b.u.x;
    const sweep: 0 | 1 = cross > 0 ? 1 : 0;
    const n = cross > 0 ? { x: -a.u.y, y: a.u.x } : { x: a.u.y, y: -a.u.x };
    const centre = { x: p.x + n.x * r, y: p.y + n.y * r };
    if (i === first) {
      // the run's own first point is the corner (against `before`): begin on the arc's far side
      start = p;
      pieces.push({ kind: 'arc', to: q, r, sweep, centre, from: p });
      continue;
    }
    pieces.push({ kind: 'line', to: p });
    pieces.push({ kind: 'arc', to: q, r, sweep, centre, from: p });
    if (i === lastIndex) endMoved = true;
  }
  const tail = pts[lastIndex];
  if (!endMoved && tail !== undefined && lastIndex > first) {
    const lastPiece = pieces[pieces.length - 1];
    if (lastPiece === undefined || lastPiece.to.x !== tail.x || lastPiece.to.y !== tail.y) pieces.push({ kind: 'line', to: tail });
  }
  return { start, pieces };
}

function pieceD(piece: Piece): string {
  return piece.kind === 'line'
    ? `L${f(piece.to.x)} ${f(piece.to.y)}`
    : `A${f(piece.r)} ${f(piece.r)} 0 0 ${piece.sweep} ${f(piece.to.x)} ${f(piece.to.y)}`;
}

function piecePoints(piece: Piece, steps = 6): XY[] {
  if (piece.kind === 'line') return [piece.to];
  const a0 = Math.atan2(piece.from.y - piece.centre.y, piece.from.x - piece.centre.x);
  let a1 = Math.atan2(piece.to.y - piece.centre.y, piece.to.x - piece.centre.x);
  // sweep 1 turns the way of increasing screen angle (y down)
  if (piece.sweep === 1 && a1 < a0) a1 += Math.PI * 2;
  if (piece.sweep === 0 && a1 > a0) a1 -= Math.PI * 2;
  const out: XY[] = [];
  for (let k = 1; k <= steps; k += 1) {
    const a = a0 + ((a1 - a0) * k) / steps;
    out.push({ x: piece.centre.x + Math.cos(a) * piece.r, y: piece.centre.y + Math.sin(a) * piece.r });
  }
  return out;
}

function lastPoint(run: Rounded): XY {
  return run.pieces[run.pieces.length - 1]?.to ?? run.start;
}

/**
 * The route with its lead corners rounded (e5c.30): the source-side run
 * (`start`, its leads, `from`) and the target-side run (`to`, its leads,
 * `end`). The corner at `from`/`to` is rounded against the bend's own control
 * arm, so the bend starts (ends) a few pixels along it.
 */
function roundedRoute(route: EdgeRoute, radius: number): { head: Rounded; tail: Rounded } {
  const head = filleted([route.start, ...(route.sourceLead ?? []), route.from], route.squareLeads?.source === true ? 0 : radius, undefined, route.c1);
  const tail = filleted([route.to, ...(route.targetLead ?? []), route.end], route.squareLeads?.target === true ? 0 : radius, route.c2, undefined);
  return { head, tail };
}

/** The route as an SVG path, its lead corners rounded (`LEAD_FILLET`). */
export function routePath(route: EdgeRoute, radius: number = LEAD_FILLET): string {
  const { head, tail } = roundedRoute(route, radius);
  const bendFrom = lastPoint(head);
  const parts = [`M${f(head.start.x)} ${f(head.start.y)}`, ...head.pieces.map(pieceD)];
  if (parts.length === 1 && (bendFrom.x !== head.start.x || bendFrom.y !== head.start.y)) parts.push(`L${f(bendFrom.x)} ${f(bendFrom.y)}`);
  parts.push(`C${f(route.c1.x)} ${f(route.c1.y)} ${f(route.c2.x)} ${f(route.c2.y)} ${f(tail.start.x)} ${f(tail.start.y)}`);
  parts.push(...tail.pieces.map(pieceD));
  return parts.join(' ');
}

function cubicAt(p0: XY, p1: XY, p2: XY, p3: XY, t: number): XY {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function runPoints(run: Rounded): XY[] {
  const points: XY[] = [run.start];
  for (const piece of run.pieces) points.push(...piecePoints(piece));
  return points;
}

/** The route as a polyline, arcs sampled (for hit-testing and the crossing tests). */
export function routePolyline(route: EdgeRoute, steps = 48, radius: number = LEAD_FILLET): XY[] {
  const { head, tail } = roundedRoute(route, radius);
  const points = runPoints(head);
  const bendFrom = points[points.length - 1] ?? route.from;
  for (let i = 1; i <= steps; i += 1) points.push(cubicAt(bendFrom, route.c1, route.c2, tail.start, i / steps));
  points.push(...runPoints(tail).slice(1));
  return points;
}

/**
 * One end's run out to where the bend starts, as drawn (arcs sampled), pad
 * or pin first — what the landing tests hold to "never over another pad".
 */
export function routeLeadRun(route: EdgeRoute, end: 'source' | 'target', radius: number = LEAD_FILLET): XY[] {
  const { head, tail } = roundedRoute(route, radius);
  return end === 'source' ? runPoints(head) : runPoints(tail).reverse();
}

/** The point halfway along the bend — where a label would sit. */
export function routeMidpoint(route: EdgeRoute): XY {
  return cubicAt(route.from, route.c1, route.c2, route.to, 0.5);
}

/* ------------------------------------------------------------------ *
 * Rotation
 * ------------------------------------------------------------------ */

/** Pairs out of order: `ys` listed in port order, ascending is none. */
export function inversions(ys: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < ys.length; i += 1) {
    for (let j = i + 1; j < ys.length; j += 1) {
      if ((ys[i] ?? 0) > (ys[j] ?? 0) + 0.5) count += 1;
    }
  }
  return count;
}

const DEG = Math.PI / 180;

/**
 * Where each handle of one face lands when the face is turned by `deg`
 * (counter-clockwise on screen, about the face centre) — `endFaceLayout`'s
 * turn, applied to the unturned art: cores turn with the face, a shield's
 * pick-up keeps its horizontal offset from its core, the overall shield's
 * stays put.
 */
export function turnedHandles(
  art: WireArt,
  end: WireEnd,
  deg: number,
): Map<string, XY> {
  const face = art.faces.find((candidate) => candidate.end === end);
  const out = new Map<string, XY>();
  if (face === undefined) return out;
  const cos = Math.cos(deg * DEG);
  const sin = Math.sin(deg * DEG);
  const cores = new Map(face.cores.map((core) => [core.path, core]));
  for (const handle of art.handles) {
    if (handle.end !== end) continue;
    const core = handle.core === undefined ? undefined : cores.get(handle.core);
    if (core === undefined) {
      out.set(handle.id, { x: handle.x, y: handle.y });
      continue;
    }
    const dx = core.x - face.cx;
    const dy = core.y - face.cy;
    const x = face.cx + dx * cos + dy * sin;
    const y = face.cy - dx * sin + dy * cos;
    out.set(handle.id, { x: x + (handle.x - core.x), y: y + (handle.y - core.y) });
  }
  return out;
}

interface Group {
  instance: string;
  end: WireEnd;
  /** a wire drawn as element rows: no port, the bundle leaves one member's row */
  rows?: boolean;
  /** the design pigtail this group's braid belongs to, when it is one */
  pigtail?: Pigtail;
  kind: PortKind;
  colorName?: string;
  members: PortMember[];
  joints: number[];
  /** the terminal key at the other end of every joint in the group */
  other: string;
  /** where that terminal sits, estimated */
  target?: Anchor;
}

interface RotationChoice {
  deg: number;
  inversions: number;
  inversionsAtZero: number;
}

/** Port y positions (art area), top to bottom, for `n` ports on a face. */
export function portYs(art: WireArt, end: WireEnd, n: number): number[] {
  const face = art.faces.find((candidate) => candidate.end === end);
  const cy = face?.cy ?? art.height / 2;
  if (n <= 0) return [];
  const room = art.height - BREAKOUT_LAYOUT.portMargin * 2;
  const pitch = n <= 1 ? 0 : Math.min(BREAKOUT_LAYOUT.portPitch, room / (n - 1));
  const span = pitch * (n - 1);
  const top = Math.min(
    Math.max(cy - span / 2, BREAKOUT_LAYOUT.portMargin),
    art.height - BREAKOUT_LAYOUT.portMargin - span,
  );
  return Array.from({ length: n }, (_, index) => top + index * pitch);
}

function chooseRotation(art: WireArt, end: WireEnd, groups: readonly Group[], ys: readonly number[]): RotationChoice {
  const face = art.faces.find((candidate) => candidate.end === end);
  const facing = endFacing(end, art.flipped);
  // conductor inversions first, then the length of it all — a pigtail's
  // counted from where it would leave the jacket, so the face turns its
  // grounds toward their ports
  const score = (deg: number): { inversions: number; cost: number } => {
    const at = turnedHandles(art, end, deg);
    const conductorYs: number[] = [];
    let cost = 0;
    groups.forEach((group, index) => {
      const portY = ys[index] ?? 0;
      const points = group.members.flatMap((member) => at.get(member.key) ?? []);
      if (group.kind === 'ground') {
        if (face !== undefined && points.length > 1) {
          cost += Math.abs(pigtailExit(face, points, facing).y - portY);
        } else {
          for (const point of points) cost += 0.25 * Math.abs(point.y - portY);
        }
        return;
      }
      for (const point of points) {
        conductorYs.push(point.y);
        cost += Math.abs(point.y - portY);
      }
    });
    return { inversions: inversions(conductorYs), cost };
  };
  const zero = score(0);
  let best = { deg: 0, ...zero };
  for (let deg = BREAKOUT_LAYOUT.step; deg < 360; deg += BREAKOUT_LAYOUT.step) {
    const candidate = score(deg);
    if (
      candidate.inversions < best.inversions ||
      (candidate.inversions === best.inversions && candidate.cost < best.cost - 1e-6)
    ) {
      best = { deg, ...candidate };
    }
  }
  return { deg: best.deg, inversions: best.inversions, inversionsAtZero: zero.inversions };
}

/* ------------------------------------------------------------------ *
 * Stubs
 * ------------------------------------------------------------------ */

/** A stub's cubic: out of its element horizontally, into its port horizontally. */
function stubCurve(from: XY, port: XY, facing: Facing): [XY, XY, XY, XY] {
  const dir = sign(facing);
  const reach = Math.abs(port.x - from.x);
  const out = Math.max(12, reach * 0.45);
  const into = Math.max(8, reach * 0.35);
  return [from, { x: from.x + dir * out, y: from.y }, { x: port.x - dir * into, y: port.y }, port];
}

function stubPath(from: XY, port: XY, facing: Facing): string {
  const [p0, c1, c2, p3] = stubCurve(from, port, facing);
  return `M${f(p0.x)} ${f(p0.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p3.x)} ${f(p3.y)}`;
}

/** The height a stub comes out from under the jacket at (its last point inside the face). */
function emergence(face: Pick<WireFaceArt, 'cx' | 'cy' | 'jacket'>, curve: [XY, XY, XY, XY]): number {
  const [p0, c1, c2, p3] = curve;
  let y = p0.y;
  for (let i = 0; i <= 64; i += 1) {
    const point = cubicAt(p0, c1, c2, p3, i / 64);
    if (Math.hypot(point.x - face.cx, point.y - face.cy) > face.jacket.r) return y;
    y = point.y;
  }
  return y;
}

/* ------------------------------------------------------------------ *
 * Pigtails
 * ------------------------------------------------------------------ */

/** A pigtail never leaves further round than this from straight toward its port. */
const PIGTAIL_SPREAD = 62 * DEG;

/**
 * Where a ground bundle leaves the face: on the jacket's edge, at the angle of
 * its members' centroid about the face centre, held to the half of the face
 * that looks toward the port column.
 */
export function pigtailExit(
  face: Pick<WireFaceArt, 'cx' | 'cy' | 'jacket'>,
  members: readonly XY[],
  facing: Facing,
): XY {
  const toward = facing === 'left' ? Math.PI : 0;
  let angle = toward;
  if (members.length > 0) {
    const x = members.reduce((sum, point) => sum + point.x, 0) / members.length - face.cx;
    const y = members.reduce((sum, point) => sum + point.y, 0) / members.length - face.cy;
    if (Math.hypot(x, y) > 0.5) {
      // offset from straight toward the port, in (-π, π]
      let offset = Math.atan2(y, x) - toward;
      offset = Math.atan2(Math.sin(offset), Math.cos(offset));
      angle = toward + Math.max(-PIGTAIL_SPREAD, Math.min(PIGTAIL_SPREAD, offset));
    }
  }
  const r = face.jacket.r;
  return { x: face.cx + Math.cos(angle) * r, y: face.cy + Math.sin(angle) * r };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/** One edge: the joints it draws and the two handles it joins. */
export interface Link {
  joints: number[];
  source: { instance: string; handle: string };
  target: { instance: string; handle: string };
  /** the port this edge leaves, when it leaves one */
  port?: BreakoutPort;
  /** a ground bundle leaving a wire drawn as rows: its member count */
  rowBundle?: number;
  /**
   * Where the bend ends, when not at the target's own entry: every edge of
   * one port column bends to the column's nearest entry and runs straight on
   * from there, so edges to parts at different depths keep their order too.
   */
  targetEntryX?: number;
  sourceAnchor?: Anchor;
  targetAnchor?: Anchor;
  /**
   * A docked connector's own pin to one of its board's cable-side terminals
   * (a mini-DIN's shell to `GND`): the connector sits on the board,
   * so the edge is a short stub to that terminal's pad nearest the pin, not a
   * run out and round the whole node.
   */
  stub?: boolean;
}

export interface BreakoutInput {
  design: CableDesign;
  /** every node, placed, with its unturned art */
  nodes: ReadonlyMap<string, PlacedNode>;
  /** the art of a segment turned to `rotation` */
  artFor: (instanceId: string, rotation: Record<WireEnd, number>) => WireArt | undefined;
  /** joint indices currently selected */
  selected?: ReadonlySet<number> | undefined;
}

export interface BreakoutPlan {
  /** per segment id: its turned art and its breakouts */
  wires: Map<string, { art: WireArt; breakout: WireBreakout }>;
  links: Link[];
}

const GROUND_ROLES = new Set<WireHandleArt['role']>(['shield', 'drain']);

function wireHandle(node: PlacedNode | undefined, key: string): WireHandleArt | undefined {
  if (node?.data.kind !== 'segment' || node.data.wire === undefined) return undefined;
  const direct = node.data.wire.handles.find((handle) => handle.id === key);
  if (direct !== undefined) return direct;
  //: a joint straight onto a folded bonded screen (not
  // through a pigtail) has no handle of its own — it routes to the same
  // point its set's representative draws at ("the drain stands for the mass")
  const alias = node.data.wire.foldedAliases[key];
  return alias === undefined ? undefined : node.data.wire.handles.find((handle) => handle.id === alias);
}

/** A shield or drain on a wire drawn as element rows. */
function groundRow(node: PlacedNode | undefined, key: string): WireHandleArt['role'] | undefined {
  if (node?.data.kind !== 'segment' || node.data.wire !== undefined) return undefined;
  const element = node.data.elements.find((row) => row.a.key === key || row.b.key === key);
  const role = element?.role;
  return role === 'shield' || role === 'drain' ? role : undefined;
}

/**
 * The members of a pigtail's port: its `members`, or — a mass pigtail — every
 * shield and drain the node draws at that end.
 */
function pigtailPortMembers(
  node: PlacedNode | undefined,
  instance: string,
  end: WireEnd,
  members: readonly string[] | undefined,
): PortMember[] {
  if (node?.data.kind !== 'segment') return [];
  const roleOf = (key: string): WireHandleArt['role'] | undefined =>
    wireHandle(node, key)?.role ?? groundRow(node, key);
  if (members !== undefined) {
    return members.map((path) => {
      const key = `${instance}:${path}@${end}`;
      return { key, terminal: path, role: roleOf(key) ?? 'shield' };
    });
  }
  const out: PortMember[] = [];
  if (node.data.wire !== undefined) {
    for (const handle of node.data.wire.handles) {
      if (!handle.id.endsWith(`@${end}`) || !GROUND_ROLES.has(handle.role)) continue;
      const terminal = handle.id.slice(instance.length + 1, -2);
      const label = node.data.elements.find((row) => row.path === terminal)?.label;
      out.push({ key: handle.id, terminal, role: handle.role, ...(label === undefined ? {} : { label }) });
    }
  } else {
    for (const row of node.data.elements) {
      if (row.role !== 'shield' && row.role !== 'drain') continue;
      out.push({ key: row[end].key, terminal: row.path, role: row.role, ...(row.label === undefined ? {} : { label: row.label }) });
    }
  }
  return out;
}

/**
 * The handle an edge falls back to when its end has no port: the terminal's
 * own — except a pigtail, which has no handle of its own and borrows its
 * first member's.
 */
function fallbackHandle(
  design: CableDesign,
  ref: TerminalRef,
  padHandle: (ref: TerminalRef) => string,
): string {
  const pigtail = pigtailOfTerminal(design, ref.instance, ref.terminal, ref.end);
  const first = pigtail?.members?.[0];
  if (pigtail === undefined || ref.end === undefined) return padHandle(ref);
  return first === undefined ? terminalKey(ref) : `${ref.instance}:${first}@${ref.end}`;
}

/**
 * The member row a row-drawn bundle leaves from: the one that puts its edge
 * out of order with the fewest other edges leaving that end (`others`: row
 * height → destination height), then the one nearest its destination.
 */
function bundleRow(
  group: Group,
  node: PlacedNode | undefined,
  others: readonly { y: number; target: number }[],
): string {
  let best = group.members[0]?.key ?? '';
  if (node === undefined || group.target === undefined) return best;
  const target = group.target.y;
  let score = Infinity;
  for (const member of group.members) {
    const at = anchorOf(node, member.key);
    if (at === undefined) continue;
    let crossings = 0;
    for (const other of others) {
      if ((other.y - at.y) * (other.target - target) < 0) crossings += 1;
    }
    const value = crossings * 1e6 + Math.abs(at.y - target);
    if (value < score - 1e-9) {
      score = value;
      best = member.key;
    }
  }
  return best;
}

/**
 * The breakouts of every wire drawn as its faces, and the edges of the whole
 * design — one per distinct pair of handles, so a ground bundle's joints
 * share one edge.
 */
export function planBreakouts(input: BreakoutInput): BreakoutPlan {
  const { design, nodes } = input;
  const selected = input.selected ?? new Set<number>();

  // the board handle a terminal ref lands on: its named pad's own, when the
  // board draws that pad (e5c.25 — every edge honours `pad`, not only the
  // docked stub), else the terminal's primary handle
  const padHandle = (ref: TerminalRef): string => {
    const key = terminalKey(ref);
    if (ref.pad === undefined) return key;
    const node = nodes.get(ref.instance);
    if (node?.data.kind !== 'pcba' || node.data.board === undefined) return key;
    return node.data.board.handles.find((handle) => handle.key === key && handle.ref === ref.pad)?.id ?? key;
  };

  // 1. group every joint side that lands on a face into its port
  const groups = new Map<string, Group>();
  const sideGroups = new Map<string, Group[]>(); // `${joint}:${a|b}` → its group(s)
  design.joints.forEach((joint, index) => {
    for (const [side, mine, other] of [
      ['a', joint.a, joint.b],
      ['b', joint.b, joint.a],
    ] as const) {
      if (mine.end === undefined) continue;
      const key = terminalKey(mine);
      const node = nodes.get(mine.instance);
      const pigtail = pigtailOfTerminal(design, mine.instance, mine.terminal, mine.end);
      if (pigtail !== undefined) {
        const otherKey = padHandle(other);
        const otherNode = nodes.get(other.instance);
        if (otherNode === undefined || anchorOf(otherNode, otherKey) === undefined) continue;
        const members = pigtailPortMembers(node, mine.instance, mine.end, pigtail.members);
        if (members.length === 0) continue;
        // one group — one port, one stub, one edge — per member braid
        const info: Pigtail = {
          id: pigtail.id,
          key,
          landing: `${terminalKey(other)}${other.pad === undefined ? '' : ` · ${other.pad}`}`,
          members,
        };
        const list: Group[] = [];
        for (const member of members) {
          const id = `${mine.instance}@${mine.end}|${key}|${member.key}|${otherKey}`;
          let group = groups.get(id);
          if (group === undefined) {
            group = {
              instance: mine.instance,
              end: mine.end,
              kind: 'ground',
              members: [member],
              joints: [],
              other: otherKey,
              pigtail: info,
              ...(node?.data.kind === 'segment' && node.data.wire === undefined ? { rows: true } : {}),
            };
            groups.set(id, group);
          }
          if (!group.joints.includes(index)) group.joints.push(index);
          list.push(group);
        }
        sideGroups.set(`${index}:${side}`, list);
        continue;
      }
      const handle = wireHandle(node, key);
      // a wire drawn as rows has no ports, but its grounds still bundle
      const rowRole = handle === undefined ? groundRow(node, key) : undefined;
      if (handle === undefined && rowRole === undefined) continue;
      const role = handle?.role ?? rowRole ?? 'shield';
      const otherKey = padHandle(other);
      const otherNode = nodes.get(other.instance);
      // a destination with no geometry keeps today's direct edge
      if (otherNode === undefined || anchorOf(otherNode, otherKey) === undefined) continue;
      const ground = GROUND_ROLES.has(role);
      // a screen jointed on its own keeps its own port: bundling is the
      // design's pigtails, never a guess from a shared pad
      const id = `${mine.instance}@${mine.end}|${key}|${otherKey}`;
      let group = groups.get(id);
      if (group === undefined) {
        group = {
          instance: mine.instance,
          end: mine.end,
          kind: ground ? 'ground' : 'conductor',
          members: [],
          joints: [],
          other: otherKey,
          ...(handle === undefined ? { rows: true } : {}),
          ...(ground || handle?.colorName === undefined ? {} : { colorName: handle.colorName }),
        };
        groups.set(id, group);
      }
      if (!group.members.some((member) => member.key === key)) {
        group.members.push({ key, terminal: mine.terminal, role });
      }
      if (!group.joints.includes(index)) group.joints.push(index);
      sideGroups.set(`${index}:${side}`, [group]);
    }
  });

  // 2. where each group's destination sits (another face: its element, unturned)
  for (const group of groups.values()) {
    const at = group.other.indexOf(':');
    const node = nodes.get(group.other.slice(0, at));
    if (node !== undefined) {
      const anchor = anchorOf(node, group.other);
      if (anchor !== undefined) group.target = anchor;
    }
  }

  // 3. per wire end: order, turn, place
  const byEnd = new Map<string, Group[]>();
  for (const group of groups.values()) {
    if (group.rows === true) continue;
    const id = `${group.instance}@${group.end}`;
    const list = byEnd.get(id);
    if (list === undefined) byEnd.set(id, [group]);
    else list.push(group);
  }

  const wires = new Map<string, { art: WireArt; breakout: WireBreakout }>();
  const portOfGroup = new Map<Group, BreakoutPort>();
  for (const [id, node] of nodes) {
    if (node.data.kind !== 'segment' || node.data.wire === undefined) continue;
    const flat = node.data.wire;
    const ordered: Partial<Record<WireEnd, { groups: Group[]; ys: number[] }>> = {};
    const choice: Partial<Record<WireEnd, RotationChoice>> = {};
    for (const end of ['a', 'b'] as const) {
      const list = byEnd.get(`${id}@${end}`);
      if (list === undefined || list.length === 0) continue;
      const unturned = turnedHandles(flat, end, 0);
      const firstY = (group: Group): number =>
        Math.min(...group.members.map((member) => unturned.get(member.key)?.y ?? 0));
      // a destination level with the wire (its own column) cannot be reached
      // by a bend out and across: its port goes to the end of the column
      // nearer it, so its edge peels off without cutting the others
      const facing = endFacing(end, flat.flipped);
      const portX =
        node.position.x +
        BOX.border +
        (facing === 'left' ? BREAKOUT_LAYOUT.portInset : flat.width - BREAKOUT_LAYOUT.portInset);
      const middle = node.position.y + BOX.border + WIRE_LAYOUT.head + flat.height / 2;
      const rank = (group: Group): number => {
        const target = group.target;
        if (target === undefined) return 0;
        const ahead = ((target.entryX ?? target.x) - portX) * sign(facing);
        if (ahead > BREAKOUT_LAYOUT.minBend * 2) return routeY(target);
        return routeY(target) >= middle ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
      };
      const sorted = [...list].sort(
        (p, q) =>
          rank(p) - rank(q) ||
          (p.target === undefined ? 0 : routeY(p.target)) - (q.target === undefined ? 0 : routeY(q.target)) ||
          (p.target?.x ?? 0) - (q.target?.x ?? 0) ||
          firstY(p) - firstY(q) ||
          (p.other < q.other ? -1 : p.other > q.other ? 1 : 0),
      );
      const ys = portYs(flat, end, sorted.length);
      ordered[end] = { groups: sorted, ys };
      choice[end] = chooseRotation(flat, end, sorted, ys);
    }
    const rotation = { a: choice.a?.deg ?? 0, b: choice.b?.deg ?? 0 };
    const art =
      rotation.a === 0 && rotation.b === 0 ? flat : (input.artFor(id, rotation) ?? flat);
    const handles = new Map(art.handles.map((handle) => [handle.id, handle]));
    const ends: EndBreakout[] = [];
    for (const end of ['a', 'b'] as const) {
      const column = ordered[end];
      const chosen = choice[end];
      if (column === undefined || chosen === undefined) continue;
      const facing = endFacing(end, art.flipped);
      const x =
        facing === 'left' ? BREAKOUT_LAYOUT.portInset : art.width - BREAKOUT_LAYOUT.portInset;
      const portIds = stablePortIds(column.groups, `${id}:?@${end}`);
      const ports = column.groups.map((group, index): BreakoutPort => {
        const y = column.ys[index] ?? 0;
        const pigtail = group.pigtail;
        const port: BreakoutPort = {
          id: portIds[index] ?? `${id}:?@${end}${PORT_SUFFIX}${index}`,
          end,
          kind: group.kind,
          x,
          y,
          facing,
          members: group.members,
          joints: group.joints,
          target: group.other,
          stubs: group.members.flatMap((member) => {
            const handle = handles.get(member.key);
            return handle === undefined
              ? []
              : [{ key: member.key, role: member.role, d: stubPath(handle, { x, y }, facing) }];
          }),
          ...(pigtail === undefined ? {} : { pigtail }),
          selected: group.joints.some((joint) => selected.has(joint)),
          ...(group.colorName === undefined ? {} : { colorName: group.colorName }),
        };
        portOfGroup.set(group, port);
        return port;
      });
      ends.push({
        end,
        rotationDeg: chosen.deg,
        inversions: chosen.inversions,
        inversionsAtZero: chosen.inversionsAtZero,
        ports,
      });
    }
    wires.set(id, { art, breakout: { rotation, ends } });
  }

  // 4. edges: one per distinct pair of handles
  const placedWith = (instance: string): PlacedNode | undefined => {
    const node = nodes.get(instance);
    const wire = wires.get(instance);
    if (node === undefined || wire === undefined || node.data.kind !== 'segment') return node;
    return { ...node, data: { ...node.data, wire: wire.art, breakout: wire.breakout } };
  };
  // the other edges leaving a row-drawn wire's end, for placing its bundles
  const rowNeighbours = (group: Group): { y: number; target: number }[] => {
    const node = nodes.get(group.instance);
    if (node === undefined) return [];
    const out: { y: number; target: number }[] = [];
    design.joints.forEach((joint, index) => {
      for (const [side, mine, other] of [
        ['a', joint.a, joint.b],
        ['b', joint.b, joint.a],
      ] as const) {
        if (mine.instance !== group.instance || mine.end !== group.end) continue;
        const theirs = sideGroups.get(`${index}:${side}`)?.[0];
        if (theirs?.pigtail !== undefined) continue;
        const at = anchorOf(node, terminalKey(mine));
        const far = nodes.get(other.instance);
        const to = far === undefined ? undefined : anchorOf(far, terminalKey(other));
        if (at !== undefined && to !== undefined) out.push({ y: at.y, target: to.y });
      }
    });
    return out;
  };
  const links = new Map<string, Link>();
  /**
   * The board pad a docked connector's pin stubs to: the joint's `pad` when
   * it names one, else the terminal's pad nearest the pin.
   */
  const dockStub = (
    mine: TerminalRef,
    other: TerminalRef,
  ): { handle: string } | undefined => {
    const node = nodes.get(mine.instance);
    if (node?.data.kind !== 'connector' || node.data.dock?.board !== other.instance) return undefined;
    // the connector's own pin pads: drawn docked — but a pin wired to another
    // of the board's own pads (a carrier's slot pad, e5c.36) stubs to it
    const prefixes = node.data.dock.prefixes;
    if (other.terminal.includes('.') && (prefixes === undefined || prefixes.some((prefix) => other.terminal.startsWith(`${prefix}.`)))) {
      return undefined;
    }
    const board = nodes.get(other.instance);
    if (board?.data.kind !== 'pcba' || board.data.board === undefined) return undefined;
    const pin = anchorOf(node, terminalKey(mine));
    const key = terminalKey(other);
    let best: { handle: string; distance: number } | undefined;
    for (const handle of board.data.board.handles) {
      if (handle.key !== key) continue;
      if (other.pad !== undefined && handle.ref !== undefined && handle.ref !== other.pad) continue;
      const at = anchorOf(board, handle.id);
      if (at === undefined || pin === undefined) continue;
      const distance = Math.hypot(at.x - pin.x, at.y - pin.y);
      if (best === undefined || distance < best.distance - 1e-9) best = { handle: handle.id, distance };
    }
    return best === undefined ? undefined : { handle: best.handle };
  };
  design.joints.forEach((joint, index) => {
    const stub = dockStub(joint.a, joint.b) ?? dockStub(joint.b, joint.a);
    if (stub !== undefined) {
      const [pin, pad] = nodes.get(joint.a.instance)?.data.kind === 'connector' ? [joint.a, joint.b] : [joint.b, joint.a];
      const id = `stub\u0000${terminalKey(pin)}\u0000${stub.handle}`;
      const link = links.get(id) ?? {
        joints: [],
        source: { instance: pin.instance, handle: terminalKey(pin) },
        target: { instance: pad.instance, handle: stub.handle },
        stub: true,
      };
      link.joints.push(index);
      links.set(id, link);
      return;
    }
    const endOf = (side: 'a' | 'b', group: Group | undefined) => {
      const ref: TerminalRef = side === 'a' ? joint.a : joint.b;
      const port = group === undefined ? undefined : portOfGroup.get(group);
      const row =
        group?.rows === true && group.pigtail !== undefined
          ? bundleRow(group, nodes.get(group.instance), rowNeighbours(group))
          : undefined;
      return {
        ref,
        port,
        handle: port?.id ?? row ?? fallbackHandle(design, ref, padHandle),
        bundle: row === undefined ? undefined : group,
      };
    };
    // a pigtail fans out: one edge per member braid, all to its one pad
    for (const groupA of sideGroups.get(`${index}:a`) ?? [undefined]) {
      for (const groupB of sideGroups.get(`${index}:b`) ?? [undefined]) {
        const a = endOf('a', groupA);
        const b = endOf('b', groupB);
        // an edge leaves its port (or its bundle's row): that side is the source
        const leaves = (end: typeof a): boolean => end.port !== undefined || end.bundle !== undefined;
        const [source, target] = !leaves(a) && leaves(b) ? [b, a] : [a, b];
        const id = `${source.ref.instance}\u0000${source.handle}\u0000${target.ref.instance}\u0000${target.handle}`;
        let link = links.get(id);
        if (link === undefined) {
          const sourceNode = placedWith(source.ref.instance);
          const targetNode = placedWith(target.ref.instance);
          const sourceAnchor = sourceNode === undefined ? undefined : anchorOf(sourceNode, source.handle);
          const targetAnchor = targetNode === undefined ? undefined : anchorOf(targetNode, target.handle);
          link = {
            joints: [],
            source: { instance: source.ref.instance, handle: source.handle },
            target: { instance: target.ref.instance, handle: target.handle },
            ...(source.port === undefined ? {} : { port: source.port }),
            ...(source.bundle === undefined ? {} : { rowBundle: source.bundle.members.length }),
            ...(sourceAnchor === undefined ? {} : { sourceAnchor }),
            ...(targetAnchor === undefined ? {} : { targetAnchor }),
          };
          links.set(id, link);
        }
        if (!link.joints.includes(index)) link.joints.push(index);
      }
    }
  });

  // 5. one bend per port column: to the nearest entry on its side
  const columns = new Map<string, Link[]>();
  for (const link of links.values()) {
    if (link.port === undefined || link.targetAnchor === undefined || link.sourceAnchor === undefined) continue;
    const id = `${link.source.instance}@${link.port.end}`;
    const list = columns.get(id);
    if (list === undefined) columns.set(id, [link]);
    else list.push(link);
  }
  for (const list of columns.values()) {
    const ahead = (link: Link): number => {
      const entry = link.targetAnchor?.entryX ?? link.targetAnchor?.x ?? 0;
      return (entry - (link.sourceAnchor?.x ?? 0)) * sign(link.sourceAnchor?.facing ?? 'left');
    };
    // a part level with the wire (in its own column) keeps its own bend — and
    // so does a docked pin's own stray edge (`targetAnchor.entryY`): its
    // `entryX` is the dock bay's own outer edge, paired with `entryY` to route
    // it clear of the whole board; aligning it to some
    // other target's entry here would send it straight across the board
    // instead, since the two numbers stop describing the same point.
    const onSide = list.filter(
      (link) => link.targetAnchor?.entryY === undefined && ahead(link) > BREAKOUT_LAYOUT.minBend * 2,
    );
    if (onSide.length < 2) continue;
    const nearest = onSide.reduce((best, link) => (ahead(link) < ahead(best) ? link : best));
    const common = nearest.targetAnchor?.entryX ?? nearest.targetAnchor?.x;
    if (common === undefined) continue;
    for (const link of onSide) link.targetEntryX = common;
  }

  return { wires, links: [...links.values()] };
}
