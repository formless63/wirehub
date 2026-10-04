/**
 * Hand-drawn artwork for the drawing sheet, keyed by definition id: traced
 * connector faces, side views of secondary plugs, a stock's cutaway art and
 * the title block's logo.
 *
 * The base ships none — every face, plug and cutaway is drawn from the
 * definitions (`drawn-faces.ts`, `cutaway.ts`), and the title block has no
 * logo. A deployment's branding module may supply its own (`docs/modules.md`,
 * extension point "documents"); these tables are where it lands.
 */

import type { FaceArt } from './faces.ts';

export const TRACED_FACES: Readonly<Record<string, FaceArt>> = {};

export const TRACED_PLUGS: Readonly<Record<string, FaceArt>> = {};

/** Cutaway art per wire id: an SVG document and its frame size. */
export const CUTAWAY_ART: Readonly<Record<string, { svg: string; width: number; height: number }>> = {};

/** The title block's logo: a PNG (base64) and the box it is fitted into, in points. */
export const LOGO: { pngBase64: string; box: readonly [number, number, number, number] } | undefined = undefined;
