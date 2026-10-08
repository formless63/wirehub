/**
 * Connector artwork on the canvas: a connector drawn as itself, from its
 * definition (spec: ui-redesign, Canvas v2 item 5).
 *
 * The geometry itself — every family's mating face or side profile, and the
 * point each pin sits on — lives in `@wirehub/layout`
 * (`layout/src/connector-art.ts`), so the SVG schematic draws exactly the
 * connector the canvas does; it reaches this package
 * through `@wirehub/render-svg`, like the rest of layout's geometry the
 * canvas shares. The node (`nodes/ConnectorNode.tsx`) only paints it, and
 * `layout-size.ts` reserves exactly its size. What stays here is the canvas's
 * own frame around the drawing: padding, the docked caption.
 */

import type { ConnectorArt } from '@wirehub/render-svg';

export { BODY_DRAWINGS, bodyDrawing, connectorArt } from '@wirehub/render-svg';
export type {
  ArtLabel,
  ArtShape,
  ArtTone,
  ArtView,
  BodyDrawing,
  ConnectorArt,
  ConnectorArtInput,
  ConnectorPinArt,
  PinForm,
} from '@wirehub/render-svg';


/* ------------------------------------------------------------------ *
 * The node around the drawing
 * ------------------------------------------------------------------ */

/** Every constant the connector art node is drawn with, in CSS pixels. */
export const CONNECTOR_LAYOUT = {
  /** clear air left and right of the drawing, at least */
  padX: 14,
  /** above and below the drawing */
  padY: 10,
  /** a docked connector: air around its drawing */
  dockPad: 4,
  /** a docked connector: its caption row under the drawing */
  caption: 14,
} as const;

/** Where a drawing sits in its node's art area, and how big that area is. */
export interface ConnectorArtLayout {
  art: ConnectorArt;
  /** the art area — under the header, or the whole node when docked */
  width: number;
  height: number;
  /** the drawing's top-left corner inside the art area */
  ox: number;
  oy: number;
}

/** The caption under a docked drawing: `j1 DB-23`, or the short name alone. */
export function dockCaption(art: ConnectorArt, instanceId?: string): string {
  return instanceId === undefined ? art.short : `${instanceId} ${art.short}`;
}

/** The caption's width: 9px monospace (`.cs-dock-caption`), a little slack. */
function captionWidth(caption: string): number {
  return [...caption].length * 9 * 0.62 + 4;
}

/** The box a docked connector takes on its board: drawing, air, caption. */
export function dockSize(art: ConnectorArt, caption: string): { width: number; height: number } {
  return {
    width: Math.ceil(Math.max(art.width + CONNECTOR_LAYOUT.dockPad * 2, captionWidth(caption))),
    height: Math.ceil(art.height + CONNECTOR_LAYOUT.dockPad + CONNECTOR_LAYOUT.caption),
  };
}

/** A docked connector's layout: the node is its dock, the drawing centred in it. */
export function dockedLayout(art: ConnectorArt, caption: string): ConnectorArtLayout {
  const size = dockSize(art, caption);
  return { art, ...size, ox: Math.round(((size.width - art.width) / 2) * 100) / 100, oy: CONNECTOR_LAYOUT.dockPad };
}


/* ------------------------------------------------------------------ *
 * Dense faces
 * ------------------------------------------------------------------ */

/** The smallest centre-to-centre distance a pin target may have on the canvas, px. */
export const MIN_PIN_PITCH = 16;

/** The most a face is enlarged to give its pins room. */
const MAX_FACE_SCALE = 3;

/** The closest two pin centres are, in art units; `undefined` with fewer than two pins. */
export function closestPins(art: ConnectorArt): number | undefined {
  const pins = art.pins.filter((pin) => pin.form !== 'shell');
  let least: number | undefined;
  for (let i = 0; i < pins.length; i += 1) {
    for (let j = i + 1; j < pins.length; j += 1) {
      const d = Math.hypot((pins[i] as { x: number }).x - (pins[j] as { x: number }).x, (pins[i] as { y: number }).y - (pins[j] as { y: number }).y);
      if (d > 0 && (least === undefined || d < least)) least = d;
    }
  }
  return least;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** An SVG path with every coordinate multiplied by `k` (arc flags and rotation left alone). */
export function scalePath(d: string, k: number): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let command = '';
  let slot = 0;
  for (const token of tokens) {
    if (/^[a-zA-Z]$/.test(token)) {
      command = token;
      slot = 0;
      out.push(token);
      continue;
    }
    const n = Number(token);
    let keep = false;
    if (command.toLowerCase() === 'a') {
      // rx ry rotation large-arc sweep x y: the rotation and the two flags are not lengths
      keep = slot % 7 === 2 || slot % 7 === 3 || slot % 7 === 4;
    }
    out.push(String(keep ? n : round2(n * k)));
    slot += 1;
  }
  return out.join(' ');
}

/**
 * The face enlarged so no two pins are closer than `MIN_PIN_PITCH` px: a dense face (HD15) gives each
 * pin a 16 px target. A face already roomy enough is returned as it is. Pure; the drawing, the pin
 * handles and the labels all move together.
 */
export function denseFace(art: ConnectorArt, minPitch = MIN_PIN_PITCH): ConnectorArt {
  const closest = closestPins(art);
  if (closest === undefined || closest >= minPitch) return art;
  const k = Math.min(MAX_FACE_SCALE, minPitch / closest);
  return {
    ...art,
    width: round2(art.width * k),
    height: round2(art.height * k),
    shapes: art.shapes.map((shape) =>
      shape.el === 'path'
        ? { ...shape, d: scalePath(shape.d, k) }
        : shape.el === 'circle'
          ? { ...shape, cx: round2(shape.cx * k), cy: round2(shape.cy * k), r: round2(shape.r * k) }
          : { ...shape, x: round2(shape.x * k), y: round2(shape.y * k), width: round2(shape.width * k), height: round2(shape.height * k), ...(shape.rx === undefined ? {} : { rx: round2(shape.rx * k) }) },
    ),
    pins: art.pins.map((pin) => ({
      ...pin,
      x: round2(pin.x * k),
      y: round2(pin.y * k),
      ...(pin.r === undefined ? {} : { r: round2(pin.r * k) }),
      ...(pin.width === undefined ? {} : { width: round2(pin.width * k) }),
      ...(pin.height === undefined ? {} : { height: round2(pin.height * k) }),
    })),
    labels: art.labels.map((label) => ({ ...label, x: round2(label.x * k), y: round2(label.y * k) })),
  };
}
