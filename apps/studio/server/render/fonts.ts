/**
 * The bundled Liberation Sans faces (`packages/docs/fonts`), loaded once for
 * the vector PDF to embed: the same two files the raster path draws with, so
 * a printed sheet's text is the same glyphs on every viewer and printer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registeredBrandFont } from '@wirehub/docs';

import { loadTrueType, type TrueTypeFont } from './ttf.ts';

export type Face = 'regular' | 'bold';

const FILES: Readonly<Record<Face, string>> = { regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf' };

const loaded = new Map<Face, TrueTypeFont>();

export function liberation(face: Face): TrueTypeFont {
  let font = loaded.get(face);
  if (font === undefined) {
    font = loadTrueType(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../packages/docs/fonts/${FILES[face]}`, import.meta.url)))));
    loaded.set(face, font);
  }
  return font;
}

/** A font as the PDF embeds it: the TrueType program, and the name its subset takes. */
export interface PdfFont {
  font: TrueTypeFont;
  /** a PostScript-safe base name (`LiberationSans`, `AcmeSans`), without the style */
  name: string;
}

const brandFonts = new Map<string, TrueTypeFont>();

/**
 * The font the vector PDF sets text in for a face: the hub's own typeface when branding registered one the
 * PDF can embed (a bold the brand lacks stays the bundled bold), else Liberation Sans. Call it while the
 * branding is registered (`withBranding`); the page records what it chose.
 */
export function pdfFont(face: Face): PdfFont {
  const brand = registeredBrandFont();
  const chosen = face === 'bold' ? brand?.bold : brand?.regular;
  if (chosen !== undefined && chosen.embeddable) {
    const base64 = chosen.pdfBase64 ?? chosen.base64;
    let font = brandFonts.get(base64);
    if (font === undefined) {
      font = loadTrueType(new Uint8Array(Buffer.from(base64, 'base64')));
      if (brandFonts.size > 8) brandFonts.clear();
      brandFonts.set(base64, font);
    }
    return { font, name: chosen.family.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'BrandFont' };
  }
  return { font: liberation(face), name: 'LiberationSans' };
}
