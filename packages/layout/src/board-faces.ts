/**
 * Both faces of a board in the schematic.
 *
 * The canvas build view draws a gerber-tier board as its two real faces,
 * stacked, each turned a quarter so the edge the cable solders to faces the
 * wire (`editor-react/src/board-art.ts`); the schematic now does the same.
 * This module is the pure geometry of that: which quarter-turn each face
 * takes, where every pad of every terminal lands in a turned face, and the
 * build's mounted parts carried into the same frame (upright, so their labels
 * read level whatever the turn).
 *
 * Frames: `board-top` is the anchor frame (mm, KiCad's, +y down); the bottom
 * face is `board-top` mirrored about `mirrorAxis` (`board-bottom`, seen from
 * below) — the arithmetic `catalog`'s `sideAnchors` performs. A face's
 * **turned** frame is its own frame rotated counter-clockwise on the page by
 * its quarter-turn; `rotatePoint` maps into it and `rotationTransform` is the
 * same map as an SVG transform, so a face drawn with it puts every pad exactly
 * where `rotatePoint` says.
 */

import type { BoardPart, PadPosition } from '@wirehub/catalog';

import { copperFromPads, exitSlot } from './entry-guides.ts';

export type QuarterTurn = 0 | 90 | 180 | 270;
export type BoardFaceSide = 'top' | 'bottom';

export interface FrameSize {
  width: number;
  height: number;
}

export interface XY {
  x: number;
  y: number;
}

/** The frame's size once turned. */
export function rotatedSize(frame: FrameSize, rotation: QuarterTurn): FrameSize {
  return rotation === 90 || rotation === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

/** A point in a face's own frame, turned counter-clockwise (on the page) into its turned frame. */
export function rotatePoint(point: XY, frame: FrameSize, rotation: QuarterTurn): XY {
  switch (rotation) {
    case 0:
      return { x: point.x, y: point.y };
    case 90:
      return { x: point.y, y: frame.width - point.x };
    case 180:
      return { x: frame.width - point.x, y: frame.height - point.y };
    case 270:
      return { x: frame.height - point.y, y: point.x };
  }
}

function rotateDirection(d: XY, rotation: QuarterTurn): XY {
  switch (rotation) {
    case 0:
      return d;
    case 90:
      return { x: d.y, y: -d.x };
    case 180:
      return { x: -d.x, y: -d.y };
    case 270:
      return { x: -d.y, y: d.x };
  }
}

/**
 * A direction's angle (degrees) turned the same quarter-turn `rotatePoint`/
 * `rotateDirection` apply to a point — matches editor-react's `board-art.ts`
 * `rotateApproach` exactly (a test holds the two equal); each turn is an
 * exact rotation, so the angle itself just shifts by it, no trig involved.
 */
export function rotateApproach(deg: number, rotation: QuarterTurn): number {
  return ((deg - rotation) % 360 + 360) % 360;
}

/**
 * A direction's angle reflected across `axis` — matches editor-react's
 * `board-art.ts` `reflectApproach` exactly (same reflection `ownFramePoint`
 * applies to a point, applied to a vector instead).
 */
export function reflectApproach(deg: number, axis: 'x' | 'y'): number {
  const rad = (deg * Math.PI) / 180;
  const dx = axis === 'x' ? -Math.cos(rad) : Math.cos(rad);
  const dy = axis === 'y' ? -Math.sin(rad) : Math.sin(rad);
  const out = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((out % 360) + 360) % 360;
}

/**
 * How far an approach angle may sit from a side's own natural direction (0°
 * = +x, a pad whose row leaves rightward; 180° for one leaving left) and
 * still count as "straight in" — matches editor-react's `board-art.ts`
 * `isNaturalApproach`/`NATURAL_APPROACH_EPSILON` exactly, so the schematic
 * and the canvas agree on which pads are angled enough to draw specially
 *.
 */
const NATURAL_APPROACH_EPSILON = 20;

function angleDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export function isNaturalApproach(approach: number, side: 'left' | 'right'): boolean {
  return angleDistance(approach, side === 'right' ? 0 : 180) <= NATURAL_APPROACH_EPSILON;
}

const r2 = (value: number): number => Math.round(value * 100) / 100;

/** The SVG transform equal to `rotatePoint`, in the face's own units. */
export function rotationTransform(frame: FrameSize, rotation: QuarterTurn): string {
  switch (rotation) {
    case 0:
      return '';
    case 90:
      return `translate(0 ${r2(frame.width)}) rotate(-90)`;
    case 180:
      return `translate(${r2(frame.width)} ${r2(frame.height)}) rotate(180)`;
    case 270:
      return `translate(${r2(frame.height)} 0) rotate(90)`;
  }
}

/** Tie-break order: the canvas mockup's turn first, then the other tall one. */
const TURNS: readonly QuarterTurn[] = [90, 270, 0, 180];

/** The quarter-turn that points `direction` (connector → cable pads) toward the wire. */
export function turnToward(direction: XY | undefined, cableSide: 'left' | 'right'): QuarterTurn {
  if (direction === undefined || (direction.x === 0 && direction.y === 0)) return 90;
  const want = cableSide === 'right' ? 1 : -1;
  let best: QuarterTurn = 90;
  let score = -Infinity;
  for (const turn of TURNS) {
    const value = rotateDirection(direction, turn).x * want;
    if (value > score + 1e-9) {
      best = turn;
      score = value;
    }
  }
  return best;
}

/** An angle within this of a multiple of 90° counts as a straight (cardinal) row. */
const CARDINAL_EPSILON = 5;

/**
 * The way a face's cable row points off the board: the
 * commonest `approach` among the face's cable pads (angles in the face's own,
 * unturned frame — the bottom face's already mirrored), as a unit vector —
 * when that commonest angle is a straight (cardinal) one and no other angle
 * ties it. The face is then turned so this direction faces the wire, which is
 * what "the edge the cable solders to faces the wire" means for a board whose
 * cable row sits on an edge *beside* its connector rather than opposite it
 * (PCA-00117 the source device, PCA-00112 the source device 1: an L with the connector on
 * the left and the cable row on the arm's lower edge) — there the connector
 * → cable centroid rule turned the row's edge away from the wire, and every
 * wire ran in across the board and over its neighbours' pads.
 *
 * `undefined` — keep the centroid rule — for a face with no oriented cable
 * pad, a tie, or an angled row (the SCART family's chamfered row: its own
 * entry guides, e5c.28, are set against the centroid rule's turn).
 */
export function cableRowOutward(approaches: readonly number[]): XY | undefined {
  const counts = new Map<number, number>();
  for (const deg of approaches) {
    const key = ((Math.round(deg) % 360) + 360) % 360;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  const [best, second] = ranked;
  if (best === undefined || (second !== undefined && second[1] === best[1])) return undefined;
  const off = best[0] % 90;
  if (off > CARDINAL_EPSILON && off < 90 - CARDINAL_EPSILON) return undefined;
  const rad = (best[0] * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/**
 * The direction, in the anchor frame (`board-top`, unmirrored, unturned), the
 * wire lies in from a face turned by `rotation` whose wire is on `cableSide`
 * — the page's ±x undone through the turn and (bottom face) the mirror. What
 * `exitSlot` measures a pad's own axis against.
 */
export function wireDirection(
  cableSide: 'left' | 'right',
  rotation: QuarterTurn,
  side: BoardFaceSide,
  mirrorAxis: 'x' | 'y',
): XY {
  const own = rotateDirection({ x: cableSide === 'right' ? 1 : -1, y: 0 }, ((360 - rotation) % 360) as QuarterTurn);
  if (side === 'top') return own;
  return mirrorAxis === 'x' ? { x: -own.x, y: own.y } : { x: own.x, y: -own.y };
}

/**
 * A connector-side terminal: one the board carries for the connector mounted
 * on it (`j.3`, `scart.15`) rather than a cable pad (`R`, `GND`). The same
 * rule the canvas uses (`board-art.ts` `isConnectorTerminal`).
 */
export function isConnectorSideTerminal(terminal: string): boolean {
  return terminal.includes('.');
}

/* ------------------------------------------------------------------ *
 * The two faces
 * ------------------------------------------------------------------ */

/** Everything the schematic needs about a two-faced (gerber) board. */
export interface BoardFacesSource {
  /** `board-top`'s frame, the anchor frame */
  frame: FrameSize;
  mirrorAxis: 'x' | 'y';
  /** every pad of every terminal, anchor frame, primary first */
  pads: Record<string, PadPosition[]>;
  /** the build's parts per face, each in that face's own (unturned) view frame */
  parts: Record<BoardFaceSide, BoardPart[]>;
  /**
   * Entry-guide slots: per face, pad ref → where its
   * wire meets the row's guide, anchor frame. Absent on an unguided board.
   */
  slots?: Record<BoardFaceSide, Record<string, XY>>;
  /**
   * The board's Edge.Cuts outline, anchor frame (`boardOutlineFromSvg` of
   * `board-top`): an unguided pad that cannot run straight in leaves the
   * board over it (`exitSlot`). Absent: straight in.
   */
  outline?: XY[];
}

/** One face, turned for its column. */
export interface FacePlan {
  side: BoardFaceSide;
  view: 'board-top' | 'board-bottom';
  rotation: QuarterTurn;
  /** the turned frame, in artwork units */
  size: FrameSize;
  /** the build's parts on this face, in the turned frame (upright) */
  parts: BoardPart[];
}

/** One physical pad as a face shows it, in that face's turned frame. */
export interface FacePad {
  terminal: string;
  side: BoardFaceSide;
  /** index into the terminal's pad list (0 = primary) */
  index: number;
  ref?: string;
  pad?: string;
  /** the copper side the pad itself is on (`both` = through-hole) */
  copper?: 'top' | 'bottom' | 'both';
  x: number;
  y: number;
  /**
   * The direction a wire physically comes in to this pad,
   * degrees, standard math convention, in this face's own turned frame —
   * already mirrored (bottom face) and turned the same way `x`/`y` are.
   * Absent for a pad the KiCad file gave no orientation for.
   */
  approach?: number;
  /**
   * The pad's slot on its row's entry guide, in this
   * face's turned frame — a wire lands here from outside the board, then
   * runs straight in. Cable-side pads of a guided row only.
   */
  slot?: XY;
}

function visibleFrom(pad: PadPosition, side: BoardFaceSide): boolean {
  return pad.side === undefined ? side === 'top' : pad.side === side || pad.side === 'both';
}

/** A point of the anchor frame, as `side`'s own (unturned) view frame shows it. */
export function ownFramePoint(point: XY, side: BoardFaceSide, source: BoardFacesSource): XY {
  if (side === 'top') return point;
  return {
    x: source.mirrorAxis === 'x' ? source.frame.width - point.x : point.x,
    y: source.mirrorAxis === 'y' ? source.frame.height - point.y : point.y,
  };
}

function centroid(points: readonly XY[]): XY | undefined {
  if (points.length === 0) return undefined;
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** A part's outline, centre and pin 1, carried into the turned frame. */
function turnPart(part: BoardPart, frame: FrameSize, rotation: QuarterTurn): BoardPart {
  const map = ([x, y]: readonly [number, number]): [number, number] => {
    const turned = rotatePoint({ x, y }, frame, rotation);
    return [r2(turned.x), r2(turned.y)];
  };
  const [x, y] = map([part.x, part.y]);
  return {
    ...part,
    x,
    y,
    outline: part.outline.map(map),
    ...(part.pin1 === undefined ? {} : { pin1: map(part.pin1) }),
  };
}

/**
 * Both faces of a board for a column whose wire is on `cableSide`, and every
 * pad each face shows (of the terminals in `terminals`).
 *
 * Each face gets the quarter-turn that points its cable row's outward
 * direction (`cableRowOutward`) at the wire — else, with no straight row to
 * go by, (cable pads − connector pins) — derived per face since the bottom
 * one is mirrored: the rule the canvas's board node follows, so the two
 * views agree on which edge is which.
 */
export function boardFaces(
  source: BoardFacesSource,
  cableSide: 'left' | 'right',
  terminals: ReadonlySet<string>,
): { faces: Record<BoardFaceSide, FacePlan>; pads: FacePad[] } {
  const cable: XY[] = [];
  const connector: XY[] = [];
  for (const [terminal, pads] of Object.entries(source.pads)) {
    if (!terminals.has(terminal)) continue;
    const primary = pads[0];
    if (primary === undefined) continue;
    (isConnectorSideTerminal(terminal) ? connector : cable).push(primary);
  }
  const from = centroid(connector);
  const to = centroid(cable);
  const direction =
    from === undefined || to === undefined ? undefined : { x: to.x - from.x, y: to.y - from.y };
  const mirrored =
    direction === undefined
      ? undefined
      : source.mirrorAxis === 'x'
        ? { x: -direction.x, y: direction.y }
        : { x: direction.x, y: -direction.y };

  const faces = {} as Record<BoardFaceSide, FacePlan>;
  for (const side of ['top', 'bottom'] as const) {
    const outward = cableRowOutward(
      Object.entries(source.pads).flatMap(([terminal, pads]) => {
        const primary = pads[0];
        if (!terminals.has(terminal) || isConnectorSideTerminal(terminal) || primary?.approach === undefined) return [];
        if (!visibleFrom(primary, side)) return [];
        return [side === 'top' ? primary.approach : reflectApproach(primary.approach, source.mirrorAxis)];
      }),
    );
    const rotation = turnToward(outward ?? (side === 'top' ? direction : mirrored), cableSide);
    faces[side] = {
      side,
      view: side === 'top' ? 'board-top' : 'board-bottom',
      rotation,
      size: rotatedSize(source.frame, rotation),
      parts: source.parts[side].map((part) => turnPart(part, source.frame, rotation)),
    };
  }

  const copper = { top: copperFromPads(source.pads, 'top'), bottom: copperFromPads(source.pads, 'bottom') };
  const pads: FacePad[] = [];
  for (const terminal of Object.keys(source.pads).sort()) {
    if (!terminals.has(terminal)) continue;
    (source.pads[terminal] ?? []).forEach((pad, index) => {
      for (const side of ['top', 'bottom'] as const) {
        if (!visibleFrom(pad, side)) continue;
        const own = ownFramePoint(pad, side, source);
        const turned = rotatePoint(own, source.frame, faces[side].rotation);
        const ownApproach =
          pad.approach === undefined ? undefined : side === 'top' ? pad.approach : reflectApproach(pad.approach, source.mirrorAxis);
        const approach = ownApproach === undefined ? undefined : rotateApproach(ownApproach, faces[side].rotation);
        const guided =
          isConnectorSideTerminal(terminal) || pad.ref === undefined ? undefined : source.slots?.[side]?.[pad.ref];
        // an unguided cable pad that cannot run straight in leaves the board
        // off its own end first (e5c.29) — the same slot a guide would give
        const exit =
          guided !== undefined || isConnectorSideTerminal(terminal)
            ? undefined
            : exitSlot(
                copper[side],
                pad,
                wireDirection(cableSide, faces[side].rotation, side, source.mirrorAxis),
                source.outline,
              );
        const anchorSlot = guided ?? exit;
        const slot =
          anchorSlot === undefined
            ? undefined
            : rotatePoint(ownFramePoint(anchorSlot, side, source), source.frame, faces[side].rotation);
        pads.push({
          terminal,
          side,
          index,
          ...(pad.ref === undefined ? {} : { ref: pad.ref }),
          ...(pad.pad === undefined ? {} : { pad: pad.pad }),
          ...(pad.side === undefined ? {} : { copper: pad.side }),
          x: turned.x,
          y: turned.y,
          ...(approach === undefined ? {} : { approach }),
          ...(slot === undefined ? {} : { slot }),
        });
      }
    });
  }
  return { faces, pads };
}

/** Where a point of the anchor frame falls on `side`'s turned face — pads on the other copper side included. */
export function facePoint(
  point: XY,
  side: BoardFaceSide,
  source: BoardFacesSource,
  face: FacePlan,
): XY {
  return rotatePoint(ownFramePoint(point, side, source), source.frame, face.rotation);
}
