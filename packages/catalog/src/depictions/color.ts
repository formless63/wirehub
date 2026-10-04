/**
 * Board colour: the owner noticed every board renders
 * green even though the production boards are fabricated in several solder
 * mask / silkscreen colours (KiCad's `(stackup …)` on most boards; the
 * README.md fab-order sheet on the few whose `.kicad_pcb` was never given a
 * stackup colour — the bare-SCART boards and others, one of which has
 * no `.kicad_pcb` at all).
 *
 * This module is the deterministic half: a small, reviewed palette (KiCad's
 * own colour-name vocabulary → a representative swatch hex) and the pure
 * substitution that recolours a tracespace board render. tracespace paints
 * every board in four fixed colours (see `gerber-pipeline.ts` / the
 * `@tracespace/core` renderer): the FR4 substrate (`#666`, left alone — a
 * house style choice, not board data: fibreglass looks the same regardless of
 * solder mask colour), copper (`color="#c93"`, recoloured only when the board
 * states a copper finish — most say `copper_finish "None"`, the fab default,
 * and keep tracespace's colour), the solder mask ink (`fill="#004200"`,
 * opacity 0.8) and the silkscreen (`color="#fff"`). Recolouring is a plain
 * hex substitution on the raw tracespace SVG text, before
 * `normalizeBoardSvg` — the same one-pass, deterministic shape as the rest of
 * the gerber tier.
 */

import type { BoardColor } from './model.ts';

export type { BoardColor } from './model.ts';

/** tracespace's fixed default hexes (the ones a board's own colour replaces). */
export const TRACESPACE_DEFAULT_MASK_HEX = '#004200';
export const TRACESPACE_DEFAULT_SILK_HEX = '#fff';
export const TRACESPACE_DEFAULT_COPPER_HEX = '#c93';

/** KiCad's own solder-mask colour names → a representative fab swatch hex. */
export const MASK_COLOR_HEX: Readonly<Record<string, string>> = {
  Green: '#0f4d2e',
  Red: '#8c1b23',
  Yellow: '#d9b400',
  Blue: '#0b3d78',
  Black: '#0d0d0d',
  White: '#e6e6e6',
  Purple: '#4a1f6e',
};

/**
 * KiCad's own silkscreen colour names → hex. `White` matches tracespace's own
 * default (`#fff`) exactly, so a white-silk board's render — the overwhelming
 * majority — is untouched by `recolorBoardSvg`.
 */
export const SILK_COLOR_HEX: Readonly<Record<string, string>> = {
  White: TRACESPACE_DEFAULT_SILK_HEX,
  Black: '#0d0d0d',
  Yellow: '#d9b400',
};

/** `copper_finish` values actually seen on the production boards → hex. */
export const COPPER_FINISH_HEX: Readonly<Record<string, string>> = {
  'HAL SnPb': '#c8c8c8', // HASL (tin/lead solder levelling): dull silver-grey
  ENIG: '#d4af6a', // electroless nickel immersion gold
};

/** Resolve a KiCad colour name to its swatch, falling back to the default hex when the name is unrecognised (never guessed silently — the caller's `src` still names the raw value). */
export function maskHexOf(name: string): string {
  return MASK_COLOR_HEX[name] ?? TRACESPACE_DEFAULT_MASK_HEX;
}

export function silkHexOf(name: string): string {
  return SILK_COLOR_HEX[name] ?? TRACESPACE_DEFAULT_SILK_HEX;
}

/**
 * Recolour one tracespace board SVG (top or bottom, before
 * `normalizeBoardSvg`) to `color`'s hexes. A colour absent from the palette
 * (or matching tracespace's own default) leaves that layer untouched — no-op
 * on the common boards (mask/silk defaults already equal tracespace's).
 */
export function recolorBoardSvg(svg: string, color: BoardColor): string {
  let out = svg;
  if (color.maskHex !== TRACESPACE_DEFAULT_MASK_HEX) {
    out = out.split(`fill="${TRACESPACE_DEFAULT_MASK_HEX}"`).join(`fill="${color.maskHex}"`);
  }
  if (color.silkHex !== TRACESPACE_DEFAULT_SILK_HEX) {
    out = out.split(`color="${TRACESPACE_DEFAULT_SILK_HEX}"`).join(`color="${color.silkHex}"`);
  }
  if (color.copperHex !== undefined && color.copperHex !== TRACESPACE_DEFAULT_COPPER_HEX) {
    out = out.split(`color="${TRACESPACE_DEFAULT_COPPER_HEX}"`).join(`color="${color.copperHex}"`);
  }
  return out;
}
