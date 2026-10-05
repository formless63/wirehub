/**
 * The hub's own typeface on the sheets (`BrandFont`, `assets.ts`): the `@font-face` rules that carry it
 * inline (an HTML sheet, a drawing's SVG and a browser-engine PDF all print from the same text),
 * the font stacks that put it first, and its glyph widths for layout.
 *
 * Nothing here runs unless branding registered a font: every function answers as the bundled
 * sans did (`undefined` or the stack unchanged), so a sheet without one is byte for byte what it was.
 * Glyphs the brand font lacks fall through to the rest of the stack, as in any browser.
 */

import { registeredBrandFont, type BrandFace } from './assets.ts';

/** the alias the sheets declare the brand font under */
export const BRAND_FAMILY = 'CS Brand';

const FORMAT: Record<BrandFace['mime'], string> = { 'font/ttf': 'truetype', 'font/otf': 'opentype', 'font/woff2': 'woff2' };

/** `@font-face` rules for the registered brand font (regular 400, bold 700); empty when none is registered. */
export function brandFontFaces(): string {
  const font = registeredBrandFont();
  if (font === undefined) return '';
  const rule = (face: BrandFace, weight: 400 | 700): string => `@font-face{font-family:'${BRAND_FAMILY}';font-style:normal;font-weight:${weight};src:url(data:${face.mime};base64,${face.base64}) format('${FORMAT[face.mime]}')}`;
  return rule(font.regular, 400) + (font.bold === undefined ? '' : rule(font.bold, 700));
}

/** A font stack with the brand font first when one is registered. */
export function brandStack(stack: string): string {
  return registeredBrandFont() === undefined ? stack : `'${BRAND_FAMILY}',${stack}`;
}

/** The advance width of one character in the brand font (1/1000 em), or `undefined` when none is registered or it lacks the glyph. */
export function brandWidth(ch: string, bold: boolean): number | undefined {
  const font = registeredBrandFont();
  if (font === undefined) return undefined;
  const face = bold && font.bold !== undefined ? font.bold : font.regular;
  return face.widths[ch];
}

/**
 * Style for an HTML sheet: the brand font inline and the sheets' font stacks pointing at it. Empty
 * when none is registered. The sheets read `--cs-font` (`.cs-root`) and the wire spec names its stack on `.cs-ws`.
 */
export function brandSheetCss(): string {
  if (registeredBrandFont() === undefined) return '';
  const stack = `'${BRAND_FAMILY}',ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;
  return `${brandFontFaces()}.cs-root{--cs-font:${stack}}.cs-ws{font-family:${stack}}`;
}
