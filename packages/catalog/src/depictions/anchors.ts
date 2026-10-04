/**
 * Anchor resolution.
 *
 * A depiction carries exactly one hand/tool-authored anchor set, in
 * `anchorFrame`'s coordinates. Every other view derives from it:
 *
 *  - a view sharing the frame (same width/height, no `mirrorOf`) uses it as-is;
 *  - a view declaring `mirrorOf` gets it reflected across the declared axis.
 *
 * That reflection is the whole point of the rule in `specs/depictions.md`:
 * solder-side / board-bottom artwork is never anchored by hand, because a
 * human mirroring a pinout by eye is the classic wiring-error source.
 */

import {
  DEPICTION_VIEWS,
  round,
  type AnchorSide,
  type DepictionAsset,
  type DepictionMeta,
  type DepictionView,
  type PinAnchor,
} from './model.ts';

/**
 * Map an anchor (and every pad it carries) through a point transform, its
 * `approach` angles through an angle transform, and its `size` lengths
 * through a length transform — each defaults to identity, which is right for
 * a mirror or a turn (a length is unchanged by either); only a scale
 * (`anchorsMm`) supplies a real `len`, and never a real `angle` (scaling
 * never rotates a direction).
 */
function mapAnchor(
  anchor: PinAnchor,
  f: (x: number, y: number) => [number, number],
  angle: (deg: number) => number = (deg) => deg,
  len: (v: number) => number = (v) => v,
): PinAnchor {
  const [x, y] = f(anchor.x, anchor.y);
  return {
    x,
    y,
    ...(anchor.note === undefined ? {} : { note: anchor.note }),
    ...(anchor.side === undefined ? {} : { side: anchor.side }),
    ...(anchor.approach === undefined ? {} : { approach: angle(anchor.approach) }),
    ...(anchor.size === undefined ? {} : { size: [len(anchor.size[0]), len(anchor.size[1])] }),
    ...(anchor.pads === undefined
      ? {}
      : {
          pads: anchor.pads.map((pad) => {
            const [px, py] = f(pad.x, pad.y);
            return {
              ...pad,
              x: px,
              y: py,
              ...(pad.approach === undefined ? {} : { approach: angle(pad.approach) }),
              ...(pad.size === undefined ? {} : { size: [len(pad.size[0]), len(pad.size[1])] }),
            };
          }),
        }),
  };
}

/** A direction's angle (degrees) reflected across `axis` — the same reflection `reflect` applies to a point, applied to a vector instead (no translation). */
function reflectAngle(deg: number, axis: 'x' | 'y'): number {
  const rad = (deg * Math.PI) / 180;
  const dx = axis === 'x' ? -Math.cos(rad) : Math.cos(rad);
  const dy = axis === 'y' ? -Math.sin(rad) : Math.sin(rad);
  const out = (Math.atan2(dy, dx) * 180) / Math.PI;
  return round(((out % 360) + 360) % 360);
}

/**
 * Reflect one anchor inside a frame. Side travels unchanged: a bottom pad is
 * still a bottom pad when the board is seen from below — only where it sits in
 * the picture moves. `approach` reflects the same way a
 * direction does: the pad still faces the same physical edge, but that edge's
 * picture is now mirrored.
 */
export function reflect(
  anchor: PinAnchor,
  axis: 'x' | 'y',
  widthUnits: number,
  heightUnits: number,
): PinAnchor {
  return mapAnchor(
    anchor,
    (x, y) => [round(axis === 'x' ? widthUnits - x : x), round(axis === 'y' ? heightUnits - y : y)],
    (deg) => reflectAngle(deg, axis),
  );
}

/** A pad position as `anchorPads` reports it — legacy anchors have no ref or side. */
export interface PadPosition {
  x: number;
  y: number;
  side?: AnchorSide;
  ref?: string;
  pad?: string;
  /** See `PinAnchor.approach`. */
  approach?: number;
  /** See `PinAnchor.size`. */
  size?: readonly [number, number];
}

/**
 * Every pad position of one anchor, primary first. A side-aware anchor lists
 * its `pads`; a legacy (pinmaps-generated) anchor is its single x/y with no
 * side.
 */
export function anchorPads(anchor: PinAnchor): PadPosition[] {
  if (anchor.pads !== undefined && anchor.pads.length > 0) return anchor.pads.map((pad) => ({ ...pad }));
  return [
    {
      x: anchor.x,
      y: anchor.y,
      ...(anchor.side === undefined ? {} : { side: anchor.side }),
      ...(anchor.approach === undefined ? {} : { approach: anchor.approach }),
      ...(anchor.size === undefined ? {} : { size: anchor.size }),
    },
  ];
}

/**
 * The anchor set as it sits in `view`'s frame, or `undefined` when the view is
 * unknown or the depiction cannot place anchors in it (a mirrored view missing
 * its frame size, a mirror of something other than the anchor frame).
 *
 * Never throws: a depiction that fails validation simply yields `undefined`.
 */
export function anchorsFor(
  meta: DepictionMeta,
  view: string,
): Record<string, PinAnchor> | undefined {
  const asset: DepictionAsset | undefined = meta.views[view];
  if (asset === undefined) return undefined;

  if (asset.mirrorOf === undefined) {
    // Only the anchor frame — and views that share its geometry — can use the
    // set unreflected. Anything else has to say so with `mirrorOf`.
    return view === meta.anchorFrame ? { ...meta.pinAnchors } : undefined;
  }

  const source = meta.views[asset.mirrorOf];
  if (source === undefined) return undefined;
  const base =
    asset.mirrorOf === meta.anchorFrame
      ? meta.pinAnchors
      : anchorsFor(meta, asset.mirrorOf);
  if (base === undefined) return undefined;

  const width = asset.widthUnits ?? source.widthUnits;
  const height = asset.heightUnits ?? source.heightUnits;
  if (width === undefined || height === undefined) return undefined;

  const axis = asset.mirrorAxis ?? 'x';
  const out: Record<string, PinAnchor> = {};
  for (const id of Object.keys(base).sort()) {
    const anchor = base[id];
    if (anchor === undefined) continue;
    out[id] = reflect(anchor, axis, width, height);
  }
  return out;
}

/** Anchor positions in millimetres, for a renderer laying out in mm. */
export function anchorsMm(
  meta: DepictionMeta,
  view: string,
): Record<string, PinAnchor> | undefined {
  const anchors = anchorsFor(meta, view);
  const asset = meta.views[view];
  if (anchors === undefined || asset === undefined) return undefined;
  const scale = asset.mmPerUnit;
  const out: Record<string, PinAnchor> = {};
  for (const id of Object.keys(anchors)) {
    const anchor = anchors[id];
    if (anchor === undefined) continue;
    out[id] = mapAnchor(anchor, (x, y) => [round(x * scale), round(y * scale)], undefined, (v) => round(v * scale));
  }
  return out;
}

/** The board view that shows one copper side. */
export const SIDE_VIEW: Readonly<Record<'top' | 'bottom', DepictionView>> = {
  top: 'board-top',
  bottom: 'board-bottom',
};

/**
 * The pads visible from one side of a board, in that side's own view frame
 * (`board-top` for `top`, the mirrored `board-bottom` for `bottom`), keyed by
 * terminal id — what a canvas needs to put a pad's handle on the view of the
 * side it is on.
 *
 *  - a `top` / `bottom` pad appears on its own side only; a `both`
 *    (through-hole) pad appears on both;
 *  - legacy anchors with no side (the pinmaps-generated tier) appear on the
 *    **top** view only, as before side-awareness existed;
 *  - a terminal with no pad on this side is absent from the result.
 *
 * `undefined` when the depiction has no view for that side (or cannot place
 * anchors in it). Never throws.
 */
export function sideAnchors(
  meta: DepictionMeta,
  side: 'top' | 'bottom',
): Record<string, PadPosition[]> | undefined {
  const anchors = anchorsFor(meta, SIDE_VIEW[side]);
  if (anchors === undefined) return undefined;
  const out: Record<string, PadPosition[]> = {};
  for (const id of Object.keys(anchors).sort()) {
    const anchor = anchors[id];
    if (anchor === undefined) continue;
    const pads = anchorPads(anchor).filter((pad) =>
      pad.side === undefined ? side === 'top' : pad.side === side || pad.side === 'both',
    );
    if (pads.length > 0) out[id] = pads;
  }
  return out;
}

/** The views a depiction actually offers, in the canonical vocabulary order. */
export function viewsOf(
  meta: DepictionMeta,
  order: readonly DepictionView[] = DEPICTION_VIEWS,
): string[] {
  const known = order.filter((view) => meta.views[view] !== undefined) as string[];
  const extra = Object.keys(meta.views)
    .filter((view) => !known.includes(view))
    .sort();
  return [...known, ...extra];
}
