/**
 * Board artwork on the canvas: where a PCBA's two sides draw inside its node,
 * and where each pad's handle sits on them.
 *
 * Pure geometry — no React, no DOM. `derive.ts` calls `boardArt` for every
 * `pcba` instance whose definition has a **gerber** depiction (`sourceKind:
 * 'gerber'`, y1u.2); the node renders exactly what this returns and
 * `layout-size.ts` reserves exactly its size, so the drawn board, its handles
 * and the box auto-arrange keeps clear are one set of numbers.
 *
 * ## Frames
 *
 * The depiction's `board-top` view is the anchor frame (mm, KiCad's frame,
 * Y down, origin at the board's corner); `board-bottom` is `mirrorOf:
 * board-top` about `x`, so a pad seen from below reflects with it — the same
 * arithmetic `catalog`'s `sideAnchors` performs (this package does not depend
 * on the catalog; `artwork.ts` explains why, and a test holds the two equal).
 *
 * ## Rotation
 *
 * Each view is turned by a quarter-turn (counter-clockwise on screen) so the
 * edge the cable solders to **faces the wire** and the edge the connector
 * mounts on faces away from it (spec: ui-redesign, Canvas v2 item 1):
 *
 *  - the direction is *derived from the depiction*: the face's straight cable
 *    row, pointed off the board (the commonest pad `approach`, layout's
 *    `cableRowOutward`) — so a row on an edge beside the
 *    connector (PCA-00117, PCA-00112) still turns its own edge to the wire;
 *    with no straight row (none oriented, a tie, or the SCART family's angled
 *    one), terminals whose id carries a connector prefix (`j.3`, `j1.5`,
 *    `scart.15`) are connector-side, the rest are cable pads, and the
 *    quarter-turn that points (cable centroid − connector centroid) closest
 *    to the wire's side wins;
 *  - which side the wire is on comes from the design: a board soldered to a
 *    segment's `a` end has the wire on its right (segments draw `a` on the
 *    left), one soldered to a `b` end has it on its left;
 *  - the bottom view is mirrored, so it gets its own turn by the same rule;
 *  - a board with only one kind of terminal has no direction to derive and
 *    takes the mockup's fixed 90° CCW; `ORIENTATION_OVERRIDES` is the reviewed
 *    per-board escape hatch (empty: every converted board derives cleanly).
 *
 * ## Docks
 *
 * A connector mounted on the board (one the design solders to its
 * connector-side terminals, or one the definition says it is sold with) is
 * drawn in a **dock bay** on the edge away from the wire: the art widens by
 * the bay, and each dock is centred on the pads its pins land on
 * (`BoardArtInput.docks`, placed in `BoardArt.docks`). What draws in a dock is
 * `connector-art.ts`'s business; this module only makes the room.
 */

import { boardOutlineFromSvg, cableRowOutward, copperPads, exitSlot, guideSlots, partBodyShapes, wireDirection, type DepictionSource, type GuideSlot, type PartDetailShape } from '@cable-studio/render-svg';

import type { DepictionMeta } from './artwork.ts';

export interface XY {
  x: number;
  y: number;
}

/** Counter-clockwise, in degrees, as the eye sees the screen. */
export type QuarterTurn = 0 | 90 | 180 | 270;

export type BoardSide = 'top' | 'bottom';

/** Which way a thing points out of the node: toward the wire, or away. */
export type Facing = 'left' | 'right';

/** Every constant the board node is drawn with, in CSS pixels. */
export const BOARD_LAYOUT = {
  /** pixels per millimetre never drop below this — small pads stay grabbable */
  minScale: 4.6,
  /** …nor rise above this — a tiny board does not become a poster */
  maxScale: 10,
  /** the board's long side aims for this many pixels */
  longSide: 160,
  /** clear air left and right of the widest view */
  padX: 14,
  /** above the first label */
  padTop: 6,
  /** under the last view */
  padBottom: 12,
  /** a `TOP` / `BOTTOM` caption row */
  label: 14,
  /** between one view's bottom and the next caption */
  viewGap: 10,
  /** the node header (`.cs-board-head`), rule included */
  head: 31,
  /** the node never draws narrower than this */
  minWidth: 176,
  /** between a dock bay and the board views */
  dockGap: 6,
  /** between two docks stacked in one bay */
  dockStack: 10,
} as const;

/**
 * Reviewed per-board orientation overrides, keyed by definition id. Add an
 * entry only when the derived rotation is wrong for a board, with the reason.
 */
export const ORIENTATION_OVERRIDES: Readonly<Record<string, Partial<Record<BoardSide, QuarterTurn>>>> =
  {};

/** The quarter-turn the mockup uses when nothing else decides. */
export const DEFAULT_TURN: QuarterTurn = 90;

/**
 * How far (mm) an angled pad's straight lead-in runs before the bend starts
 * — a production "finger" wire-landing pad runs about
 * 6 mm (PCA-00101's coax-core pads; `Custom_Pads:Pad_Coax_Core_Finger`), so a
 * lead this long clears a neighbour's pad and the wire soldered to it before
 * curving away, whatever the row's actual pitch.
 */
export const APPROACH_LEAD_MM = 2;

/** One side of the board, placed inside the node's art area. */
export interface BoardViewArt {
  side: BoardSide;
  view: 'board-top' | 'board-bottom';
  /** the asset's own SVG text (inlined, id-prefixed, by the node) */
  source: string;
  /** the asset frame, in its own units (mm), before rotation */
  frame: { width: number; height: number };
  rotation: QuarterTurn;
  /** pixels per asset unit */
  scale: number;
  /** caption row, relative to the art area */
  label: { x: number; y: number };
  /** where the rotated, scaled view draws, relative to the art area */
  box: { x: number; y: number; width: number; height: number };
  /** SVG transform taking asset units into the box's own pixel frame */
  transform: string;
  /** the build's mounted parts on this side, in the box's own pixel frame */
  parts: BoardPartArt[];
}

/**
 * One shape of a part's top-down solid-model drawing,
 * already turned/mirrored/scaled into the view box's pixel frame — ready to
 * paint with no further transform, the same as `BoardPartArt.points`.
 */
export type BoardPartDetail =
  | { shape: 'polygon'; tone: string; points: string }
  | { shape: 'circle'; tone: string; cx: number; cy: number; r: number }
  | { shape: 'text'; tone: string; cx: number; cy: number; value: string }
  | { shape: 'multi'; tone: string; d: string };

/**
 * One mounted part on one face, already turned and
 * scaled into its view box's pixel frame — so labels stay upright whatever
 * the board's quarter-turn, and a part draws at the size the board does.
 */
export interface BoardPartArt {
  ref: string;
  kind: string;
  /** `fitted`, or a solder jumper's `bridged` / `open` / `unset` */
  state: string;
  /** the body outline, as SVG `points` — the fallback box when `detail` is empty */
  points: string;
  /** body centre */
  x: number;
  y: number;
  /** pin 1 / the positive pad, when the part has one that matters */
  pin1?: XY;
  /**
   * The part's real top-down body: chip/MLCC/tantalum/
   * electrolytic/IC/diode shapes, or a bridged/open solder jumper. Empty for
   * an unrecognised package or an unset jumper — the node draws `points` (the
   * plain outlined box) instead, never nothing.
   */
  detail: BoardPartDetail[];
  /** the printed label (`R203 180R`, `JP201 0R`, `U201`) — absent when it would collide */
  text?: { value: string; x: number; y: number };
  /** the full description, for the hover title */
  title: string;
}

/** Label metrics for the part overlay, in CSS pixels (mono, 9px). */
export const PART_LABEL = {
  fontSize: 9,
  /** IBM Plex Mono's advance at 9px, rounded up */
  charWidth: 5.5,
  height: 10,
  /** clear air kept between two labels */
  gap: 1,
  /** the longest value printed beside a ref */
  maxValue: 10,
} as const;

/** One handle: one pad of one terminal on one side. */
export interface BoardHandleArt {
  /** React Flow handle id — the terminal key for the primary pad, suffixed otherwise */
  id: string;
  /** the terminal key every handle of this terminal resolves to */
  key: string;
  terminal: string;
  side: BoardSide;
  /** footprint reference and pad number, when the depiction names them */
  ref?: string;
  pad?: string;
  /** the handle the design's edges attach to (one per terminal) */
  primary: boolean;
  /** centre of the pad, relative to the art area */
  x: number;
  y: number;
  /** the side of the node an edge leaves this handle toward */
  facing: Facing;
  /** cable pad (true) or connector-side pin (false) */
  cableSide: boolean;
  /**
   * The direction a wire physically comes in to this pad:
   * degrees, standard math convention, in the node's own screen space (the
   * catalog's `approach` after the board's own quarter-turn and the bottom
   * face's mirror — the same composition `handles[].x`/`.y` already went
   * through). Absent for a straight-in pad the KiCad file gave no angle for,
   * or a row that comes out cardinal (0/90/180/270): the edge keeps today's
   * plain horizontal lead-in either way, so this only changes anything for a
   * genuinely angled row.
   */
  approach?: number;
  /**
   * How far an edge's straight lead-in along `approach` must run before it
   * clears this pad's neighbours (px, this board's own scale) — long enough
   * that the following bend never has to cut back over a neighbouring pad.
   */
  approachLead?: number;
  /**
   * The pad's slot on its row's human-set entry guide,
   * as an offset from the pad itself (px, this node's own frame — turned and,
   * for the bottom face, mirrored like `x`/`y`). A wire reaches the slot off
   * the board, then runs straight in to the pad. Supersedes `approach`;
   * absent on every pad no guide serves, which then routes exactly as before.
   */
  slot?: { dx: number; dy: number };
}

/**
 * A connector drawn against the board's connector edge (the side away from
 * the wire): one the design mounts on it, or one the board is sold with.
 */
export interface BoardDockRequest {
  /** the connector instance id, or the integrated connector's terminal prefix */
  id: string;
  /** board terminal prefixes its pins land on (`j`, `j1`, `scart`) */
  prefixes: readonly string[];
  width: number;
  height: number;
}

/** A dock, placed: relative to the art area. */
export interface BoardDockArt {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardArt {
  defId: string;
  /** the art area, in pixels (the node header is not included) */
  width: number;
  height: number;
  /** the side of the node the wire is on */
  cableFacing: Facing;
  views: BoardViewArt[];
  handles: BoardHandleArt[];
  /** connectors docked on the connector edge, top to bottom */
  docks: BoardDockArt[];
}

/* ------------------------------------------------------------------ *
 * Handle ids
 * ------------------------------------------------------------------ */

/**
 * The separator between a terminal key and a secondary pad's suffix. Terminal
 * keys are `instance:terminal[@end]` with kebab/dotted ids — never a `~`.
 */
export const PAD_HANDLE_SEPARATOR = '~';

/**
 * The terminal key a handle id stands for. A board terminal with several pads
 * (GND on both faces) draws one handle per pad; the primary one *is* the
 * terminal key and the rest append `~<side>:<ref>.<pad>`, so a connection
 * dragged from any of them resolves to the same terminal.
 */
export function terminalKeyOfHandle(handleId: string): string {
  const at = handleId.indexOf(PAD_HANDLE_SEPARATOR);
  return at === -1 ? handleId : handleId.slice(0, at);
}

/* ------------------------------------------------------------------ *
 * Rotation
 * ------------------------------------------------------------------ */

const R = (value: number): number => Math.round(value * 100) / 100;

/** The frame's size once turned. */
export function rotatedSize(
  frame: { width: number; height: number },
  rotation: QuarterTurn,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

/** A point in the asset frame, turned counter-clockwise into the rotated frame. */
export function rotatePoint(
  point: XY,
  frame: { width: number; height: number },
  rotation: QuarterTurn,
): XY {
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

/** A direction (no translation) turned the same way. */
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

/** The SVG transform equal to `rotatePoint` (asset units → rotated units). */
export function rotationTransform(
  frame: { width: number; height: number },
  rotation: QuarterTurn,
): string {
  switch (rotation) {
    case 0:
      return '';
    case 90:
      return `translate(0 ${R(frame.width)}) rotate(-90)`;
    case 180:
      return `translate(${R(frame.width)} ${R(frame.height)}) rotate(180)`;
    case 270:
      return `translate(${R(frame.height)} 0) rotate(90)`;
  }
}

/** Tie-break order: the mockup's turn first, then the other tall one. */
const TURNS: readonly QuarterTurn[] = [90, 270, 0, 180];

/**
 * The quarter-turn that points `direction` (connector → cable) toward
 * `facing`. No direction → the default turn.
 */
export function turnToward(direction: XY | undefined, facing: Facing): QuarterTurn {
  if (direction === undefined || (direction.x === 0 && direction.y === 0)) return DEFAULT_TURN;
  const want = facing === 'right' ? 1 : -1;
  let best: QuarterTurn = DEFAULT_TURN;
  let score = -Infinity;
  for (const turn of TURNS) {
    const turned = rotateDirection(direction, turn);
    const value = turned.x * want;
    if (value > score + 1e-9) {
      best = turn;
      score = value;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Pads per side
 * ------------------------------------------------------------------ */

type Meta = DepictionMeta;
type Anchor = Meta['pinAnchors'][string];

/** One physical pad, resolved to `side`'s own frame — exported for the Artwork
 * tab's read-only gerber display, which plots the same pads the canvas does. */
export interface Pad {
  x: number;
  y: number;
  side?: 'top' | 'bottom' | 'both';
  ref?: string;
  pad?: string;
  /** See the catalog's `PinAnchor.approach` — this pad's own wire-approach direction, anchor-frame degrees. */
  approach?: number;
}

function padsOf(anchor: Anchor): Pad[] {
  if (anchor.pads !== undefined && anchor.pads.length > 0) return anchor.pads.map((pad) => ({ ...pad }));
  return [
    {
      x: anchor.x,
      y: anchor.y,
      ...(anchor.side === undefined ? {} : { side: anchor.side }),
      ...(anchor.approach === undefined ? {} : { approach: anchor.approach }),
    },
  ];
}

/**
 * A direction's angle (degrees) reflected across `axis` — this package does
 * not depend on the catalog (see the module doc), so this mirrors the exact
 * arithmetic `@cable-studio/catalog`'s `anchors.ts` (`reflectAngle`) applies
 * to a `PinAnchor.approach`; a test holds the two equal.
 */
function reflectApproach(deg: number, axis: 'x' | 'y'): number {
  const rad = (deg * Math.PI) / 180;
  const dx = axis === 'x' ? -Math.cos(rad) : Math.cos(rad);
  const dy = axis === 'y' ? -Math.sin(rad) : Math.sin(rad);
  const out = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((out % 360) + 360) % 360;
}

/**
 * A direction's angle turned the same quarter-turn `rotatePoint`/
 * `rotateDirection` apply to a point: each of the four turns is an exact
 * rotation, so the angle itself just shifts by the turn (no trig, no drift) —
 * verified against `rotateDirection` for every quadrant.
 */
export function rotateApproach(deg: number, rotation: QuarterTurn): number {
  return ((deg - rotation) % 360 + 360) % 360;
}

/**
 * How far an approach angle may sit from a facing's own natural direction (0°
 * = +x for a pad whose edge leaves to the right, 180° for one leaving left)
 * and still count as "straight in" — a pad this close to the facing's own
 * axis draws exactly as it always has (`edgeRoute`'s plain horizontal lead),
 * so a board whose KiCad pads resolve to a cardinal angle stays pixel-for-
 * pixel unchanged.
 * Only a pad whose row sits at a real angle to the board edge — wider than
 * this — gets the new angled lead-in.
 */
const NATURAL_APPROACH_EPSILON = 20;

function angleDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Is `approach` close enough to `facing`'s own natural (horizontal) direction to need no special lead-in? */
export function isNaturalApproach(approach: number, facing: Facing): boolean {
  return angleDistance(approach, facing === 'right' ? 0 : 180) <= NATURAL_APPROACH_EPSILON;
}

function visibleFrom(pad: Pad, side: BoardSide): boolean {
  return pad.side === undefined ? side === 'top' : pad.side === side || pad.side === 'both';
}

/** The view a pad's primary handle belongs on: its own side, top for `both`. */
function primarySide(pad: Pad): BoardSide {
  return pad.side === 'bottom' ? 'bottom' : 'top';
}

/**
 * A connector-side terminal: one the board carries for the connector it is
 * mounted on (`j.3`, `j1.5`, `scart.15`) rather than a cable pad (`R`, `GND`).
 */
export function isConnectorTerminal(terminal: string): boolean {
  return terminal.includes('.');
}

/** A gerber-tier board depiction with both faces — the only kind drawn as art. */
export function isGerberBoard(meta: Meta | undefined): meta is Meta {
  if (meta === undefined) return false;
  const top = meta.views['board-top'];
  const bottom = meta.views['board-bottom'];
  return (
    top !== undefined &&
    bottom !== undefined &&
    top.sourceKind === 'gerber' &&
    top.kind === 'vector' &&
    bottom.kind === 'vector' &&
    meta.anchorFrame === 'board-top' &&
    bottom.mirrorOf === 'board-top' &&
    top.widthUnits !== undefined &&
    top.heightUnits !== undefined
  );
}

/**
 * The whole anchor set's pads, reflected into `side`'s own frame — every
 * terminal that has at least one pad visible from `side`, primary pad first.
 * `frame` is always the *anchor* frame's size (`board-top`'s), the same one
 * `boardArt` passes for both sides, since `pinAnchors` and the mirror
 * reflection are both expressed in it. Exported so the Artwork tab's
 * read-only gerber display plots the same pads the canvas does, without
 * duplicating the reflection arithmetic.
 */
export function padsOnSide(
  meta: Meta,
  side: BoardSide,
  frame: { width: number; height: number },
): Map<string, { pad: Pad; primary: boolean }[]> {
  const axis = meta.views['board-bottom']?.mirrorAxis ?? 'x';
  const out = new Map<string, { pad: Pad; primary: boolean }[]>();
  for (const terminal of Object.keys(meta.pinAnchors).sort()) {
    const anchor = meta.pinAnchors[terminal];
    if (anchor === undefined) continue;
    const pads = padsOf(anchor);
    const first = pads[0];
    const list: { pad: Pad; primary: boolean }[] = [];
    pads.forEach((pad, index) => {
      if (!visibleFrom(pad, side)) return;
      const placed =
        side === 'top'
          ? pad
          : {
              ...pad,
              x: axis === 'x' ? frame.width - pad.x : pad.x,
              y: axis === 'y' ? frame.height - pad.y : pad.y,
              ...(pad.approach === undefined ? {} : { approach: reflectApproach(pad.approach, axis) }),
            };
      const primary = index === 0 && first !== undefined && primarySide(first) === side;
      list.push({ pad: placed, primary });
    });
    if (list.length > 0) out.set(terminal, list);
  }
  return out;
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

/** Connector → cable, in the top frame, from the anchors' primary positions. */
function cableDirection(meta: Meta, terminals: ReadonlySet<string>): XY | undefined {
  const cable: XY[] = [];
  const connector: XY[] = [];
  for (const [terminal, anchor] of Object.entries(meta.pinAnchors)) {
    if (!terminals.has(terminal)) continue;
    (isConnectorTerminal(terminal) ? connector : cable).push({ x: anchor.x, y: anchor.y });
  }
  const from = centroid(connector);
  const to = centroid(cable);
  if (from === undefined || to === undefined) return undefined;
  return { x: to.x - from.x, y: to.y - from.y };
}

/* ------------------------------------------------------------------ *
 * Mounted parts
 * ------------------------------------------------------------------ */

type Part = NonNullable<Meta['components']>['parts'][number];

function partTitle(part: Part): string {
  const value = part.value ?? part.label;
  const state = part.state === 'fitted' ? '' : ` · ${part.state}`;
  return `${part.ref}${value === undefined ? '' : ` ${value}`} · ${part.kind}${state} · ${part.side}`;
}

interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** One subpath per group (`M…Z`), all in one `<path>` — a lead comb in one element. */
function multiPathD(groups: readonly XY[][]): string {
  return groups.map((group) => `M${group.map((p) => `${p.x} ${p.y}`).join('L')}Z`).join(' ');
}

/**
 * `partBodyShapes`' shapes, still in the depiction's
 * own units, turned into this view's pixel frame through the exact same
 * `place()` a part's outline/pin1 already go through — a circle's radius is
 * the one thing `place()` does not cover (rotation and reflection preserve
 * it, but not the scale), so it is multiplied by `scale` here to match.
 */
function placeDetail(shapes: readonly PartDetailShape[], place: (x: number, y: number) => XY, scale: number): BoardPartDetail[] {
  return shapes.map((s): BoardPartDetail => {
    switch (s.shape) {
      case 'polygon':
        return { shape: 'polygon', tone: s.tone, points: s.points.map(([x, y]) => place(x, y)).map((p) => `${p.x},${p.y}`).join(' ') };
      case 'circle': {
        const c = place(s.cx, s.cy);
        return { shape: 'circle', tone: s.tone, cx: c.x, cy: c.y, r: R(s.r * scale) };
      }
      case 'text': {
        const c = place(s.cx, s.cy);
        return { shape: 'text', tone: s.tone, cx: c.x, cy: c.y, value: s.value };
      }
      case 'multi':
        return { shape: 'multi', tone: s.tone, d: multiPathD(s.groups.map((group) => group.map(([x, y]) => place(x, y)))) };
    }
  });
}

/**
 * The parts of the build mounted on `side`, reflected into that side's frame
 * (bottom parts mirror with `board-bottom`, the arithmetic `padsOnSide` does
 * for pads), then turned and scaled into the view box's pixel frame.
 *
 * Labels are placed greedily, largest body first, never overlapping another
 * label: the full `ref value`, else the ref alone, centred on the body, else
 * just above or below it; a label that fits nowhere is left to the hover
 * title. Deterministic: the same board lays out the same labels.
 */
export function partsOnSide(
  meta: Meta,
  side: BoardSide,
  frame: { width: number; height: number },
  rotation: QuarterTurn,
  scale: number,
): BoardPartArt[] {
  const parts = meta.components?.parts ?? [];
  const axis = meta.views['board-bottom']?.mirrorAxis ?? 'x';
  const place = (x: number, y: number): XY => {
    const own =
      side === 'top'
        ? { x, y }
        : { x: axis === 'x' ? frame.width - x : x, y: axis === 'y' ? frame.height - y : y };
    const turned = rotatePoint(own, frame, rotation);
    return { x: R(turned.x * scale), y: R(turned.y * scale) };
  };
  const drawn = parts
    .filter((part) => part.side === side)
    .map((part) => {
      const corners = part.outline.map(([x, y]) => place(x, y));
      const centre = place(part.x, part.y);
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      return { part, corners, centre, box, area: (box.x1 - box.x0) * (box.y1 - box.y0) };
    });

  const taken: LabelBox[] = [];
  const texts = new Map<Part, BoardPartArt['text']>();
  const order = [...drawn].sort((a, b) => b.area - a.area || (a.part.ref < b.part.ref ? -1 : 1));
  for (const { part, centre, box } of order) {
    // a long part number (SN74AHCT1G125DBVR) would bury the board: ref only,
    // the full value is in the hover title
    const candidates = [
      ...(part.label === undefined || part.label.length > PART_LABEL.maxValue ? [] : [`${part.ref} ${part.label}`]),
      part.ref,
    ];
    const spots = [
      centre.y,
      box.y0 - PART_LABEL.height / 2 - PART_LABEL.gap,
      box.y1 + PART_LABEL.height / 2 + PART_LABEL.gap,
    ];
    let found: BoardPartArt['text'];
    for (const value of candidates) {
      const half = (value.length * PART_LABEL.charWidth) / 2;
      for (const y of spots) {
        const label = {
          x0: centre.x - half - PART_LABEL.gap,
          x1: centre.x + half + PART_LABEL.gap,
          y0: y - PART_LABEL.height / 2,
          y1: y + PART_LABEL.height / 2,
        };
        if (taken.some((other) => overlaps(label, other))) continue;
        taken.push(label);
        found = { value, x: centre.x, y: R(y) };
        break;
      }
      if (found !== undefined) break;
    }
    texts.set(part, found);
  }

  return drawn.map(({ part, corners, centre }) => {
    const text = texts.get(part);
    return {
      ref: part.ref,
      kind: part.kind,
      state: part.state,
      points: corners.map((c) => `${c.x},${c.y}`).join(' '),
      x: centre.x,
      y: centre.y,
      ...(part.pin1 === undefined ? {} : { pin1: place(part.pin1[0], part.pin1[1]) }),
      detail: placeDetail(partBodyShapes(part), place, scale),
      ...(text === undefined ? {} : { text }),
      title: partTitle(part),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

export interface BoardArtInput {
  instanceId: string;
  defId: string;
  /** every terminal the definition declares (pads and integrated pins) */
  terminals: readonly string[];
  /** the side of the node the wire is on */
  cableFacing: Facing;
  depictions: DepictionSource;
  /** connectors to dock on the edge away from the wire, each beside its pads */
  docks?: readonly BoardDockRequest[];
  /**
   * A connector-side terminal's own facing, where the design says which way
   * its joints go: a carrier board between a plug and
   * the next board (the DIN-8 perfboard) takes the plug's pins on the plug's
   * side and hands its slot pads on toward the next board, rather than
   * facing both away from a wire it does not have. Absent: away from the wire.
   */
  facings?: ReadonlyMap<string, Facing>;
}

/** Pixels per millimetre for a board of this frame. */
export function boardScale(frame: { width: number; height: number }): number {
  const long = Math.max(frame.width, frame.height);
  if (long <= 0) return BOARD_LAYOUT.minScale;
  const wanted = BOARD_LAYOUT.longSide / long;
  return R(Math.min(BOARD_LAYOUT.maxScale, Math.max(BOARD_LAYOUT.minScale, wanted)));
}

/**
 * Both faces of a board, stacked top over bottom, with a handle on every pad
 * a declared terminal lands on — or `undefined` when the definition has no
 * gerber depiction, or its artwork is missing, in which case the node keeps
 * its pin-list form.
 */
export function boardArt(input: BoardArtInput): BoardArt | undefined {
  const meta = input.depictions.meta(input.defId);
  if (!isGerberBoard(meta)) return undefined;
  const top = meta.views['board-top'];
  if (top?.widthUnits === undefined || top.heightUnits === undefined) return undefined;
  const frame = { width: top.widthUnits, height: top.heightUnits };

  const sources: Partial<Record<BoardSide, string>> = {};
  for (const side of ['top', 'bottom'] as const) {
    const artwork = input.depictions.artwork(input.defId, side === 'top' ? 'board-top' : 'board-bottom');
    if (artwork?.kind !== 'vector' || artwork.source === undefined || artwork.source === '') {
      return undefined;
    }
    sources[side] = artwork.source;
  }

  const terminals = new Set(input.terminals);
  const direction = cableDirection(meta, terminals);
  const axis = meta.views['board-bottom']?.mirrorAxis ?? 'x';
  const mirrored =
    direction === undefined
      ? undefined
      : axis === 'x'
        ? { x: -direction.x, y: direction.y }
        : { x: direction.x, y: -direction.y };
  const override = ORIENTATION_OVERRIDES[input.defId] ?? {};
  // each face's cable row, pointed off the board, faces the wire when the
  // row is a straight one (e5c.29); else the connector → cable centroid rule
  const outward = (side: BoardSide): XY | undefined =>
    cableRowOutward(
      Object.entries(meta.pinAnchors).flatMap(([terminal, anchor]) => {
        const primary = padsOf(anchor)[0];
        if (!terminals.has(terminal) || isConnectorTerminal(terminal) || primary?.approach === undefined) return [];
        if (!visibleFrom(primary, side)) return [];
        return [side === 'top' ? primary.approach : reflectApproach(primary.approach, axis)];
      }),
    );
  const turns: Record<BoardSide, QuarterTurn> = {
    top: override.top ?? turnToward(outward('top') ?? direction, input.cableFacing),
    bottom: override.bottom ?? turnToward(outward('bottom') ?? mirrored, input.cableFacing),
  };

  const scale = boardScale(frame);
  const sizes = {
    top: rotatedSize(frame, turns.top),
    bottom: rotatedSize(frame, turns.bottom),
  };
  const innerWidth = Math.max(sizes.top.width, sizes.bottom.width) * scale;
  const requests = input.docks ?? [];
  // the dock bay: as wide as its widest connector, on the side away from the wire
  const bay = requests.length === 0 ? 0 : Math.max(...requests.map((dock) => dock.width)) + BOARD_LAYOUT.dockGap;
  const bayLeft = input.cableFacing === 'right';
  const viewsWidth = Math.ceil(innerWidth + BOARD_LAYOUT.padX * 2);
  const width = viewsWidth + Math.ceil(bay);
  const viewsX = bayLeft ? Math.ceil(bay) : 0;

  const views: BoardViewArt[] = [];
  const handles: BoardHandleArt[] = [];
  const outline = boardOutlineFromSvg(sources.top ?? '');
  const copper = { top: copperPads(meta, 'top'), bottom: copperPads(meta, 'bottom') };
  const opposite: Facing = input.cableFacing === 'right' ? 'left' : 'right';
  let y: number = BOARD_LAYOUT.padTop;

  for (const side of ['top', 'bottom'] as const) {
    const rotation = turns[side];
    const size = sizes[side];
    const boxWidth = R(size.width * scale);
    const boxHeight = R(size.height * scale);
    const boxX = R(viewsX + (viewsWidth - boxWidth) / 2);
    const labelY = y;
    const boxY = R(y + BOARD_LAYOUT.label);
    views.push({
      side,
      view: side === 'top' ? 'board-top' : 'board-bottom',
      source: sources[side] ?? '',
      frame,
      rotation,
      scale,
      label: { x: boxX, y: labelY },
      box: { x: boxX, y: boxY, width: boxWidth, height: boxHeight },
      transform: [`scale(${scale})`, rotationTransform(frame, rotation)]
        .filter((part) => part !== '')
        .join(' '),
      parts: partsOnSide(meta, side, frame, rotation, scale),
    });

    // the human-set entry guides' slots on this face, by pad ref (e5c.28)
    const slots = new Map<string, GuideSlot>();
    for (const guide of meta.entryGuides ?? []) {
      if (guide.side !== side) continue;
      for (const slot of guideSlots(meta, guide)) slots.set(slot.ref, slot);
    }
    const toView = (point: XY): XY => {
      const own = side === 'top' ? point : { x: axis === 'x' ? frame.width - point.x : point.x, y: axis === 'y' ? frame.height - point.y : point.y };
      const turned = rotatePoint(own, frame, rotation);
      return { x: boxX + turned.x * scale, y: boxY + turned.y * scale };
    };

    // a pad of this face back in the anchor frame (its mirror undone)
    const anchorPoint = (p: Pad): { x: number; y: number; approach?: number } =>
      side === 'top'
        ? p
        : {
            x: axis === 'x' ? frame.width - p.x : p.x,
            y: axis === 'y' ? frame.height - p.y : p.y,
            ...(p.approach === undefined ? {} : { approach: reflectApproach(p.approach, axis) }),
          };

    for (const [terminal, pads] of padsOnSide(meta, side, frame)) {
      if (!terminals.has(terminal)) continue;
      const key = `${input.instanceId}:${terminal}`;
      pads.forEach(({ pad, primary }, index) => {
        const turned = rotatePoint(pad, frame, rotation);
        const suffix =
          pad.ref === undefined ? `${side}.${index}` : `${side}:${pad.ref}.${pad.pad ?? index}`;
        const cableSide = !isConnectorTerminal(terminal);
        const facing = cableSide ? input.cableFacing : (input.facings?.get(terminal) ?? opposite);
        const turnedApproach = pad.approach === undefined ? undefined : rotateApproach(pad.approach, rotation);
        const guided = cableSide && pad.ref !== undefined ? slots.get(pad.ref) : undefined;
        // an unguided cable pad that cannot run straight in leaves the board
        // off its own end first — a guide's slot without the guide (e5c.29)
        // a connector-side pad the design faces toward a neighbour (a carrier's
        // plug pins, e5c.35) leaves the same way when its straight run in
        // would cross another pad
        const turnedToward = cableSide || input.facings?.has(terminal) === true;
        const exit =
          guided !== undefined || !turnedToward
            ? undefined
            : exitSlot(copper[side], anchorPoint(pad), wireDirection(facing, rotation, side, axis), outline);
        const approach =
          guided !== undefined || exit !== undefined || turnedApproach === undefined || isNaturalApproach(turnedApproach, facing)
            ? undefined
            : turnedApproach;
        const x = R(boxX + turned.x * scale);
        const y = R(boxY + turned.y * scale);
        const slotAt = guided !== undefined ? toView(guided.slot) : exit === undefined ? undefined : toView(exit);
        handles.push({
          id: primary ? key : `${key}${PAD_HANDLE_SEPARATOR}${suffix}`,
          key,
          terminal,
          side,
          primary,
          x,
          y,
          facing,
          cableSide,
          ...(pad.ref === undefined ? {} : { ref: pad.ref }),
          ...(pad.pad === undefined ? {} : { pad: pad.pad }),
          ...(approach === undefined
            ? {}
            : { approach, approachLead: R(APPROACH_LEAD_MM * scale) }),
          ...(slotAt === undefined ? {} : { slot: { dx: R(slotAt.x - x), dy: R(slotAt.y - y) } }),
        });
      });
    }
    y = boxY + boxHeight + BOARD_LAYOUT.viewGap;
  }

  // a terminal whose only pads are secondary (its primary pad's side cannot
  // see it — a legacy anchor, say) still needs one handle for edges to land on
  const primaries = new Set(handles.filter((handle) => handle.primary).map((handle) => handle.key));
  for (const handle of handles) {
    if (primaries.has(handle.key)) continue;
    handle.primary = true;
    handle.id = handle.key;
    primaries.add(handle.key);
  }

  if (input.facings !== undefined && input.facings.size > 0) {
    sidestep(
      handles.filter((handle) => !handle.cableSide && input.facings?.has(handle.terminal) === true),
      handles,
      SIDESTEP_CLEAR_MM * scale,
    );
  }

  const viewsHeight = Math.ceil(y - BOARD_LAYOUT.viewGap + BOARD_LAYOUT.padBottom);
  const docks = placeDocks(requests, handles, {
    x: bayLeft ? BOARD_LAYOUT.padX / 2 : viewsWidth + BOARD_LAYOUT.dockGap - BOARD_LAYOUT.padX / 2,
    width: Math.ceil(bay) - BOARD_LAYOUT.dockGap,
    top: BOARD_LAYOUT.padTop,
  });
  const docksBottom = Math.max(0, ...docks.map((dock) => dock.y + dock.height + BOARD_LAYOUT.padBottom));

  return {
    defId: input.defId,
    width,
    height: Math.ceil(Math.max(viewsHeight, docksBottom)),
    cableFacing: input.cableFacing,
    views,
    handles,
    docks,
  };
}

/** How far (mm) a pad's lead keeps from another pad's centre before it sidesteps it. */
const SIDESTEP_CLEAR_MM = 1.1;

function nearSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A pad deep in a footprint (a carrier's plug pins)
 * whose straight run in from its node's edge would pass over another pad —
 * the DIN-8 perfboard's pin 2 behind pin 8 — steps aside: its edge runs in
 * level with a slot just off the pad, clear of every other pad and of every
 * other run's height, then takes a short straight lead to the pad. Never
 * two runs on one line, never a run drawn through a pad it does not land on.
 * A pad with no clear sidestep keeps its straight run. Mutates `movable`.
 */
function sidestep(movable: BoardHandleArt[], all: readonly BoardHandleArt[], clear: number): void {
  const runY = (handle: BoardHandleArt): number => handle.y + (handle.slot?.dy ?? 0);
  // nearest the edge first: a pad further in steps round the ones before it
  const order = [...movable].sort((p, q) => (p.facing === 'left' ? p.x - q.x : q.x - p.x) || p.y - q.y);
  for (const handle of order) {
    if (handle.slot !== undefined || handle.approach !== undefined) continue;
    const dir = handle.facing === 'left' ? -1 : 1;
    const others = all.filter((other) => other.side === handle.side && other !== handle && (other.x !== handle.x || other.y !== handle.y));
    const ahead = (y: number, fromX: number): boolean =>
      others.some((other) => (other.x - fromX) * dir > 0 && Math.abs(other.y - y) < clear);
    if (!ahead(handle.y, handle.x)) continue;
    const taken = all.filter((other) => other !== handle && other.facing === handle.facing && other.side === handle.side).map(runY);
    for (const step of [1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5]) {
      const slot = { x: handle.x + dir * clear * 1.25, y: handle.y + step * clear };
      if (ahead(slot.y, slot.x - dir * clear)) continue;
      if (others.some((other) => nearSegment(other, slot, handle) < clear * 0.8)) continue;
      if (taken.some((y) => Math.abs(y - slot.y) < clear * 0.5)) continue;
      handle.slot = { dx: R(slot.x - handle.x), dy: R(slot.y - handle.y) };
      break;
    }
  }
}

/**
 * Each dock centred on the pads its pins land on (so a connector straddling
 * the edge sits between the two faces), then pushed apart top to bottom so
 * two docks never overlap.
 */
function placeDocks(
  requests: readonly BoardDockRequest[],
  handles: readonly BoardHandleArt[],
  bay: { x: number; width: number; top: number },
): BoardDockArt[] {
  const all = handles.filter((handle) => !handle.cableSide);
  const wanted = requests.map((request, order) => {
    const mine = all.filter((handle) =>
      request.prefixes.some((prefix) => handle.terminal.startsWith(`${prefix}.`)),
    );
    const pads = mine.length > 0 ? mine : all;
    const ys = pads.map((handle) => handle.y);
    const centre = ys.length === 0 ? bay.top + request.height / 2 : (Math.min(...ys) + Math.max(...ys)) / 2;
    return { request, order, top: centre - request.height / 2 };
  });
  wanted.sort((p, q) => p.top - q.top || p.order - q.order);
  const out: BoardDockArt[] = [];
  let floor: number = bay.top;
  for (const { request, top } of wanted) {
    const y = Math.max(top, floor);
    out.push({
      id: request.id,
      x: R(bay.x + (bay.width - request.width) / 2),
      y: R(y),
      width: request.width,
      height: request.height,
    });
    floor = y + request.height + BOARD_LAYOUT.dockStack;
  }
  return out;
}

/** The terminals that have a handle on the art. */
export function placedTerminals(art: BoardArt): Set<string> {
  return new Set(art.handles.map((handle) => handle.terminal));
}

/**
 * Asset markup ready to sit inside the node's `<g>`: the render-svg inliner's
 * output (ids prefixed per instance and side, so two copies of one board do
 * not share masks), minus the `<title>` / `<desc>` that would otherwise pop a
 * tooltip over every pad.
 */
export function stripSvgCaptions(markup: string): string {
  return markup
    .replace(/<title\b[\s\S]*?<\/title\s*>/gi, '')
    .replace(/<desc\b[\s\S]*?<\/desc\s*>/gi, '');
}

/** The id prefix for one instance's one side. */
export function boardIdPrefix(instanceId: string, side: BoardSide): string {
  return `cs-board-${instanceId.replace(/[^A-Za-z0-9_-]/g, '_')}-${side}-`;
}
