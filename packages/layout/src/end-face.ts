/**
 * `endFaceLayout(wire, end)` — one cut end of the cable, as the builder sees
 * it when looking into that end.
 *
 * The positions are `crossSectionLayout`'s — the same pitch circle, core
 * rings and drain seat the documents' cutaway draws — re-centred on the cable
 * axis in cable millimetres (y down, like the screen). What this adds is the
 * **chirality of each end**:
 *
 * - `layOrder.direction` describes the cut face of the end named in
 *   `layOrder.viewedFrom`; the other end reads the same ring the opposite way
 *   (owner, 2026-09-23: the destination end reads clockwise, the source end
 *   counter-clockwise). `crossSectionLayout` draws the `viewedFrom` face, so
 *   the other end is that drawing mirrored about the vertical axis.
 * - Wire end `a` is the source, `b` the destination.
 * - `rotationDeg` then turns the face (counter-clockwise on screen). Rotation
 *   is free — the builder can turn the cable — so it is an input, never a
 *   fact of the stock.
 *
 * It also places one **terminal** per electrical element, so a canvas can put
 * a handle on it: a conductor at its core's centre, a shield on its own ring
 * on the side the end's connections leave toward (`a` left, `b` right), the
 * drain where it is seated. A stock whose geometry, lay order or viewed-from
 * end is not documented has no end face (`undefined`): drawing one would
 * invent a chirality or a position.
 *
 * A bonded screen (`WireDefinition.bonded`) other than
 * its set's representative gets no terminal of its own — the canvas gives it
 * no separate port/marker, the representative stands for the mass (see
 * `bond-fold.ts`). Its ring still draws (`cores[]` is untouched — it is the
 * cutaway's real geometry), only the interactive port disappears.
 */

import { elementPaths, isElectricalElement } from '@wirehub/model';
import type { WireDefinition } from '@wirehub/model';

import { bondFoldedPaths } from './bond-fold.ts';
import { crossSectionLayout } from './cross-section.ts';
import type { CrossSectionCore, CrossSectionRing } from './model.ts';

export type WireEnd = 'a' | 'b';

export interface EndFaceOptions {
  /** turn the face counter-clockwise on screen, degrees (default 0) */
  rotationDeg?: number;
}

/** One ring of a core, relative to the core's own centre, radii in mm. */
export interface EndFaceRing {
  elementPath: string;
  kind: 'conductor' | 'insulation' | 'shield';
  r: number;
  rInner: number;
  colorName?: string;
  bare?: boolean;
  construction?: 'braid' | 'spiral' | 'foil' | 'tape';
  /** a figure-8 leg's own jacket — paints like the jacket */
  jacket?: boolean;
}

/** A core (or the drain) on the face, centre relative to the cable axis. */
export interface EndFaceCore {
  elementPath: string;
  /** 0-based on the pitch circle, -1 centre / inner, -2 drain */
  layIndex: number;
  x: number;
  y: number;
  r: number;
  colorName?: string;
  rings: EndFaceRing[];
}

export type EndFaceTerminalRole = 'conductor' | 'shield' | 'drain';

/** Where one electrical element meets the cut face. */
export interface EndFaceTerminal {
  /** the element path — the wire's terminal id */
  path: string;
  role: EndFaceTerminalRole;
  x: number;
  y: number;
  /** the core it belongs to, when it is inside one */
  core?: string;
  colorName?: string;
}

export interface EndFace {
  wire: string;
  end: WireEnd;
  /** which end this is */
  endRole: 'source' | 'destination';
  /** the way `layOrder.ring` reads round this face, looking into it */
  reading: 'cw' | 'ccw';
  /** true when this face is the catalog drawing mirrored (the non-`viewedFrom` end) */
  mirrored: boolean;
  rotationDeg: number;
  arrangement: string;
  /** diameter over the jacket, mm — for a figure-8 the width (the larger dimension) */
  odMm: number;
  /** the jacket circle; for a figure-8 its bounding circle — draw `outline` instead */
  jacket: { r: number; rInner: number; colorName?: string };
  /**
   * A figure-8's outline: the legs' jacket circles, on
   * this face (mirrored and turned like the cores), and the web's half
   * thickness — `figure8Path(lobes[0], lobes[1], r, webHalf)` draws it.
   */
  outline?: { shape: 'figure-8'; lobes: { x: number; y: number; r: number }[]; webHalf: number };
  overallShield?: { elementPath: string; r: number; rInner: number; construction?: string };
  /** ring cores in lay order, then centre / inner cores, then the drain */
  cores: EndFaceCore[];
  /** one per electrical element, in the stock's element order */
  terminals: EndFaceTerminal[];
}

const DEG = Math.PI / 180;

function roleOf(end: WireEnd): 'source' | 'destination' {
  return end === 'a' ? 'source' : 'destination';
}

function flip(direction: 'cw' | 'ccw'): 'cw' | 'ccw' {
  return direction === 'cw' ? 'ccw' : 'cw';
}

function ringOf(ring: CrossSectionRing): EndFaceRing {
  return {
    elementPath: ring.elementPath,
    kind: ring.kind,
    r: ring.r,
    rInner: ring.rInner,
    ...(ring.colorName === undefined ? {} : { colorName: ring.colorName }),
    ...(ring.bare === undefined ? {} : { bare: ring.bare }),
    ...(ring.construction === undefined ? {} : { construction: ring.construction }),
    ...(ring.jacket === true ? { jacket: true } : {}),
  };
}

/**
 * The cut face of `end`, or `undefined` when the stock does not document
 * enough to draw it honestly: no cutaway geometry, no lay order, no
 * viewed-from end, or an electrical element with no place on the face.
 */
export function endFaceLayout(
  wire: WireDefinition,
  end: WireEnd,
  options: EndFaceOptions = {},
): EndFace | undefined {
  const layOrder = wire.layOrder;
  if (layOrder?.viewedFrom === undefined) return undefined;
  const cs = crossSectionLayout(wire, { scale: 1, origin: { x: 0, y: 0 } });
  if (cs === undefined) return undefined;

  const endRole = roleOf(end);
  const mirrored = endRole !== layOrder.viewedFrom;
  const reading = mirrored ? flip(layOrder.direction) : layOrder.direction;
  const rotationDeg = options.rotationDeg ?? 0;
  const cos = Math.cos(rotationDeg * DEG);
  const sin = Math.sin(rotationDeg * DEG);
  // mirror about the vertical axis, then turn counter-clockwise on screen
  // (y runs down, so a CCW turn is x' = x cos + y sin, y' = −x sin + y cos)
  const place = (px: number, py: number): { x: number; y: number } => {
    const x = (mirrored ? -1 : 1) * (px - cs.cx);
    const y = py - cs.cy;
    return { x: x * cos + y * sin, y: -x * sin + y * cos };
  };

  const cores: EndFaceCore[] = cs.cores.map((core: CrossSectionCore) => ({
    elementPath: core.elementPath,
    layIndex: core.layIndex,
    ...place(core.cx, core.cy),
    r: core.r,
    ...(core.colorName === undefined ? {} : { colorName: core.colorName }),
    rings: core.rings.map(ringOf),
  }));

  // the side this end's connections leave toward: shields are picked up there
  const outward = end === 'a' ? -1 : 1;
  const mid = (ring: { r: number; rInner: number }): number => (ring.r + ring.rInner) / 2;

  const dropped = bondFoldedPaths(wire);
  const terminals: EndFaceTerminal[] = [];
  for (const entry of elementPaths(wire.structure)) {
    if (!isElectricalElement(entry.element)) continue;
    const path = entry.path;
    if (dropped.has(path)) continue;
    const element = entry.element;
    const role: EndFaceTerminalRole =
      element.kind === 'shield'
        ? 'shield'
        : element.kind === 'conductor' && element.bare === true
          ? 'drain'
          : 'conductor';
    const colorName = element.kind === 'conductor' ? element.color : undefined;
    const base = { path, role, ...(colorName === undefined ? {} : { colorName }) };

    const core = cores.find(
      (candidate) => path === candidate.elementPath || path.startsWith(`${candidate.elementPath}.`),
    );
    if (core !== undefined) {
      const ring = core.rings.find((candidate) => candidate.elementPath === path);
      if (ring === undefined) return undefined;
      const offset = role === 'shield' ? outward * mid(ring) : 0;
      terminals.push({ ...base, x: core.x + offset, y: core.y, core: core.elementPath });
      continue;
    }
    if (cs.overallShield !== undefined && path === cs.overallShield.elementPath) {
      terminals.push({ ...base, x: outward * mid(cs.overallShield), y: 0 });
      continue;
    }
    // an electrical element the cutaway has no place for: no face
    return undefined;
  }

  return {
    wire: wire.id,
    end,
    endRole,
    reading,
    mirrored,
    rotationDeg,
    arrangement: cs.arrangement,
    odMm: cs.odMm,
    jacket: {
      r: cs.jacket.r,
      rInner: cs.jacket.rInner,
      ...(cs.jacket.colorName === undefined ? {} : { colorName: cs.jacket.colorName }),
    },
    ...(cs.outline === undefined
      ? {}
      : {
          outline: {
            shape: cs.outline.shape,
            lobes: cs.outline.lobes.map((lobe) => ({ ...place(lobe.cx, lobe.cy), r: lobe.r })),
            webHalf: cs.outline.webHalf,
          },
        }),
    ...(cs.overallShield === undefined
      ? {}
      : {
          overallShield: {
            elementPath: cs.overallShield.elementPath,
            r: cs.overallShield.r,
            rInner: cs.overallShield.rInner,
            ...(cs.overallShield.construction === undefined
              ? {}
              : { construction: cs.overallShield.construction }),
          },
        }),
    cores,
    terminals,
  };
}
