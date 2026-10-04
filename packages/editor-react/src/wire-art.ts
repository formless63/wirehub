/**
 * Wire artwork on the canvas: a segment drawn as its two cut ends — end `a`
 * (source) on the left, end `b` (destination) on the right — joined by a
 * jacket run, with a handle on every electrical element of each face.
 *
 * Pure geometry — no React, no DOM. The faces themselves come from
 * `@wirehub/layout`'s `endFaceLayout` (through render-svg's re-export),
 * which is the documents' cross-section with each end's chirality applied:
 * the destination end reads the ring clockwise, the source end
 * counter-clockwise (owner, 2026-09-23). This module only scales the two faces
 * into the node and names the handles. `derive.ts` attaches the result to the
 * segment's node data, `nodes/WireNode.tsx` paints exactly it and
 * `layout-size.ts` reserves exactly its size.
 *
 * ## Handles
 *
 * One per element per end, id = the terminal key the reducer and every joint
 * already use (`w1:core-red.center@a`), so a design authored against the old
 * row node attaches to the faces with no migration. Edges leave `a` handles to
 * the left and `b` handles to the right.
 *
 * ## Rotation
 *
 * Free: the builder can turn the cable. `wireArt` takes a rotation per end
 * (degrees, counter-clockwise on screen, default 0) and passes it to the face
 * geometry; choosing it (to minimise crossings) is `breakout.ts`'s business.
 *
 * ## Flip
 *
 * `flip: true` draws end `b` on the left and `a` on the right — for a segment
 * whose `b` end is soldered to parts left of it (an audio whip hanging off the
 * console board). The faces are not mirrored (chirality is a fact of each
 * end); only where they sit, which way their edges leave, and the side a
 * shield is picked up on change.
 *
 * A stock without a documented face (no lay order, no viewed-from end, no
 * diameters) has no art (`undefined`): the node keeps its element rows.
 */

import { terminalKey, type WireDefinition } from '@wirehub/model';
import {
  bondedRepresentative,
  endFaceLayout,
  figure8Path,
  type EndFace,
  type EndFaceTerminalRole,
} from '@wirehub/render-svg';

import type { Facing } from './board-art.ts';

export type WireEnd = 'a' | 'b';

/** Every constant the wire node is drawn with, in CSS pixels. */
export const WIRE_LAYOUT = {
  /** the node header (`.cs-wire-head`), rule included */
  head: 31,
  /** radius the jacket draws at, whatever the stock's diameter */
  faceR: 46,
  /** a face's centre sits this far in from its side of the node */
  faceInset: 106,
  /** the node never draws narrower than this */
  minWidth: 352,
  /** above the captions */
  padTop: 10,
  /** a `source · CCW` caption row */
  caption: 12,
  /** caption to the top of the face */
  captionGap: 8,
  /** height of the jacket run between the faces */
  run: 34,
  /** face bottom to the length line */
  labelGap: 12,
  /** the length line */
  label: 14,
  /** under the length line */
  padBottom: 10,
  /** a conductor dot never draws smaller than this radius */
  minDot: 3.2,
  /** …nor a drain */
  minDrain: 2.6,
} as const;

/** One ring of a core, in pixels, relative to the core's centre. */
export interface WireRingArt {
  path: string;
  kind: 'conductor' | 'insulation' | 'shield';
  r: number;
  rInner: number;
  colorName?: string;
  bare?: boolean;
  construction?: 'braid' | 'spiral' | 'foil' | 'tape';
}

/** A core (or the drain) on a face, centre relative to the art area. */
export interface WireCoreArt {
  path: string;
  /** 0-based on the pitch circle, -1 centre / inner, -2 drain */
  layIndex: number;
  x: number;
  y: number;
  r: number;
  colorName?: string;
  rings: WireRingArt[];
  /** the terminal keys of this core's electrical elements, at this end */
  keys: string[];
}

/** One handle: one element at one end. */
export interface WireHandleArt {
  /** React Flow handle id — the terminal key */
  id: string;
  /** element path (the wire's terminal id) */
  terminal: string;
  end: WireEnd;
  role: EndFaceTerminalRole;
  colorName?: string;
  /** the core it belongs to, when inside one */
  core?: string;
  /** centre of the element, relative to the art area */
  x: number;
  y: number;
  /** the side an edge leaves this handle toward */
  facing: Facing;
}

export interface WireFaceArt {
  end: WireEnd;
  endRole: 'source' | 'destination';
  /** the way the ring reads round this face */
  reading: 'cw' | 'ccw';
  rotationDeg: number;
  /** `source · CCW` */
  caption: string;
  captionX: number;
  captionY: number;
  cx: number;
  cy: number;
  /** pixels per cable millimetre */
  scale: number;
  jacket: { r: number; rInner: number };
  /**
   * A figure-8 stock's jacket outline, an SVG path in
   * the node's pixels: two joined circles — draw it instead of the jacket
   * circle. The cores (and so every handle) are placed exactly as before.
   */
  outline?: string;
  overallShield?: { path: string; r: number; rInner: number; construction?: string };
  cores: WireCoreArt[];
}

export interface WireArt {
  wire: string;
  /** the art area, in pixels (the node header is not included) */
  width: number;
  height: number;
  faces: [WireFaceArt, WireFaceArt];
  /** the jacket between the faces */
  run: { x: number; y: number; width: number; height: number };
  /** `1830 mm · 6 ft 0 in · 6-around-2 lay` */
  label: string;
  labelX: number;
  labelY: number;
  handles: WireHandleArt[];
  /**
   * A bonded screen other than its set's representative (* "the drain stands for the bonded mass") has no handle of its own — it
   * gets no separate port. A joint that still names it directly (not through
   * a pigtail) needs *somewhere* to route to, so this maps its terminal key
   * to the representative's, which does have a handle in `handles`.
   */
  foldedAliases: Record<string, string>;
  /** end `b` is drawn on the left */
  flipped: boolean;
}

export interface WireArtInput {
  instanceId: string;
  wire: WireDefinition;
  lengthMm?: number | undefined;
  /** per-end face rotation, degrees counter-clockwise on screen (default 0) */
  rotation?: Partial<Record<WireEnd, number>> | undefined;
  /** the art area is at least this wide (the header may need more) */
  minWidth?: number | undefined;
  /** draw end `b` on the left and `a` on the right */
  flip?: boolean | undefined;
}

/** `6 ft 0 in` — under two feet, inches alone (`18 in`), the way the shop says it. */
export function feetAndInches(lengthMm: number): string {
  const inches = Math.round(lengthMm / 25.4);
  if (inches < 24) return `${inches} in`;
  return `${Math.floor(inches / 12)} ft ${inches % 12} in`;
}

/** The line under the jacket run. */
export function runLabel(lengthMm: number | undefined, arrangement: string): string {
  const length =
    lengthMm === undefined ? ['no length set'] : [`${lengthMm} mm`, feetAndInches(lengthMm)];
  return [...length, `${arrangement} lay`].join(' · ');
}

/** The side of the node an end's edges leave toward. */
export function endFacing(end: WireEnd, flip: boolean | undefined): Facing {
  return (end === 'a') !== (flip === true) ? 'left' : 'right';
}

function scaleFace(
  face: EndFace,
  instanceId: string,
  cx: number,
  cy: number,
  flip: boolean,
): { art: WireFaceArt; handles: WireHandleArt[] } {
  const k = WIRE_LAYOUT.faceR / face.jacket.r;
  const keyOf = (path: string): string =>
    terminalKey({ instance: instanceId, terminal: path, end: face.end });
  const facing = endFacing(face.end, flip);
  const coreAt = new Map(face.cores.map((core) => [core.elementPath, core]));
  // the layout picks a shield up on the side its end leaves toward (a left,
  // b right); flipped, that side is the other one
  const pickX = (terminal: EndFace['terminals'][number]): number => {
    if (!flip || terminal.role !== 'shield') return terminal.x;
    const core = terminal.core === undefined ? undefined : coreAt.get(terminal.core);
    return core === undefined ? -terminal.x : 2 * core.x - terminal.x;
  };
  const handles: WireHandleArt[] = face.terminals.map((terminal) => ({
    id: keyOf(terminal.path),
    terminal: terminal.path,
    end: face.end,
    role: terminal.role,
    x: cx + pickX(terminal) * k,
    y: cy + terminal.y * k,
    facing,
    ...(terminal.colorName === undefined ? {} : { colorName: terminal.colorName }),
    ...(terminal.core === undefined ? {} : { core: terminal.core }),
  }));
  const cores: WireCoreArt[] = face.cores.map((core) => ({
    path: core.elementPath,
    layIndex: core.layIndex,
    x: cx + core.x * k,
    y: cy + core.y * k,
    r: core.r * k,
    ...(core.colorName === undefined ? {} : { colorName: core.colorName }),
    rings: core.rings.map((ring) => ({
      path: ring.elementPath,
      kind: ring.kind,
      r: ring.r * k,
      rInner: ring.rInner * k,
      ...(ring.colorName === undefined ? {} : { colorName: ring.colorName }),
      ...(ring.bare === undefined ? {} : { bare: ring.bare }),
      ...(ring.construction === undefined ? {} : { construction: ring.construction }),
    })),
    keys: face.terminals
      .filter((terminal) => terminal.core === core.elementPath)
      .map((terminal) => keyOf(terminal.path)),
  }));
  const top = cy - WIRE_LAYOUT.faceR - WIRE_LAYOUT.captionGap;
  return {
    art: {
      end: face.end,
      endRole: face.endRole,
      reading: face.reading,
      rotationDeg: face.rotationDeg,
      caption: `${face.endRole} · ${face.reading.toUpperCase()}`,
      captionX: cx,
      captionY: top - WIRE_LAYOUT.caption,
      cx,
      cy,
      scale: k,
      jacket: { r: face.jacket.r * k, rInner: face.jacket.rInner * k },
      ...(face.outline === undefined || face.outline.lobes.length !== 2
        ? {}
        : {
            outline: figure8Path(
              { x: cx + face.outline.lobes[0]!.x * k, y: cy + face.outline.lobes[0]!.y * k },
              { x: cx + face.outline.lobes[1]!.x * k, y: cy + face.outline.lobes[1]!.y * k },
              face.outline.lobes[0]!.r * k,
              face.outline.webHalf * k,
            ),
          }),
      ...(face.overallShield === undefined
        ? {}
        : {
            overallShield: {
              path: face.overallShield.elementPath,
              r: face.overallShield.r * k,
              rInner: face.overallShield.rInner * k,
              ...(face.overallShield.construction === undefined
                ? {}
                : { construction: face.overallShield.construction }),
            },
          }),
      cores,
    },
    handles,
  };
}

/**
 * The wire node's art, or `undefined` when the stock has no documented face
 * at either end (the node then keeps its element rows).
 */
export function wireArt(input: WireArtInput): WireArt | undefined {
  const a = endFaceLayout(input.wire, 'a', { rotationDeg: input.rotation?.a ?? 0 });
  const b = endFaceLayout(input.wire, 'b', { rotationDeg: input.rotation?.b ?? 0 });
  if (a === undefined || b === undefined) return undefined;

  const L = WIRE_LAYOUT;
  const width = Math.max(L.minWidth, input.minWidth ?? 0);
  const cy = L.padTop + L.caption + L.captionGap + L.faceR;
  const flip = input.flip === true;
  const left = L.faceInset;
  const right = width - L.faceInset;
  const faceA = scaleFace(a, input.instanceId, flip ? right : left, cy, flip);
  const faceB = scaleFace(b, input.instanceId, flip ? left : right, cy, flip);
  const labelTop = cy + L.faceR + L.labelGap;
  const height = labelTop + L.label + L.padBottom;
  const runX = left + L.faceR;
  //: a joint straight onto a folded bonded screen (not
  // through a pigtail) still resolves — to the representative's handle
  const foldedAliases: Record<string, string> = {};
  for (const set of input.wire.bonded ?? []) {
    const rep = bondedRepresentative(input.wire, set);
    for (const end of ['a', 'b'] as const) {
      const repKey = terminalKey({ instance: input.instanceId, terminal: rep, end });
      for (const member of set.members) {
        if (member !== rep) foldedAliases[terminalKey({ instance: input.instanceId, terminal: member, end })] = repKey;
      }
    }
  }
  return {
    wire: input.wire.id,
    width,
    height,
    faces: [faceA.art, faceB.art],
    run: {
      x: runX,
      y: cy - L.run / 2,
      width: right - L.faceR - runX,
      height: L.run,
    },
    label: runLabel(input.lengthMm, a.arrangement),
    labelX: width / 2,
    labelY: labelTop,
    handles: [...faceA.handles, ...faceB.handles],
    foldedAliases,
    flipped: flip,
  };
}
