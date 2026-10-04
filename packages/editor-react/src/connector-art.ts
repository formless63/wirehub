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
