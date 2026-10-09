/**
 * The bundled Liberation Sans faces (`packages/docs/fonts`), loaded once for
 * the vector PDF to embed: the same two files the raster path draws with, so
 * a printed sheet's text is the same glyphs on every viewer and printer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { plexFaces, registeredBrandFont, type PlexKind } from '@wirehub/docs';

import { loadTrueType, type TrueTypeFont } from './ttf.ts';
import { decompressWoff2 } from './woff2.ts';

/** `regular`/`bold`: Liberation Sans (or the brand's); the `plex*` faces are the IBM Plex subsets the sheet frame is set in. */
export type Face = 'regular' | 'bold' | 'plexSans' | 'plexSemi' | 'plexMono' | 'plexMonoMedium';

export const FACES: readonly Face[] = ['regular', 'bold', 'plexSans', 'plexSemi', 'plexMono', 'plexMonoMedium'];

/** The PDF resource name of each face's embedded font. */
export const FACE_RESOURCE: Readonly<Record<Face, string>> = { regular: 'E1', bold: 'E2', plexSans: 'E3', plexSemi: 'E4', plexMono: 'E5', plexMonoMedium: 'E6' };

const PLEX_KIND: Readonly<Partial<Record<Face, PlexKind>>> = { plexSans: 'sans', plexSemi: 'semi', plexMono: 'mono', plexMonoMedium: 'monoMedium' };
const PLEX_NAME: Readonly<Partial<Record<Face, string>>> = { plexSans: 'IBMPlexSans', plexSemi: 'IBMPlexSans-SemiBold', plexMono: 'IBMPlexMono', plexMonoMedium: 'IBMPlexMono-Medium' };

/** The PostScript name a face's subset carries (without the six-letter tag). */
export function faceName(face: Face, fontName: string | undefined): string {
  return PLEX_NAME[face] ?? `${fontName ?? 'LiberationSans'}${face === 'bold' ? '-Bold' : ''}`;
}

const plexLoaded = new Map<Face, TrueTypeFont>();

/** One of the embedded IBM Plex faces as TrueType (the WOFF2 unpacked once). */
export function plexTrueType(face: Face): TrueTypeFont {
  let font = plexLoaded.get(face);
  if (font === undefined) {
    const kind = PLEX_KIND[face];
    if (kind === undefined) throw new Error(`'${face}' is not a Plex face`);
    font = loadTrueType(decompressWoff2(new Uint8Array(Buffer.from(plexFaces()[kind].woff2, 'base64')), 2 * 1024 * 1024));
    plexLoaded.set(face, font);
  }
  return font;
}

/** The unpacked IBM Plex TrueType programs, for the rasteriser (it reads font files). */
export function plexTrueTypeBytes(): { family: string; weight: number; bytes: Uint8Array }[] {
  const out: { family: string; weight: number; bytes: Uint8Array }[] = [];
  for (const kind of Object.keys(plexFaces()) as PlexKind[]) {
    const f = plexFaces()[kind];
    out.push({ family: f.family, weight: f.weight, bytes: decompressWoff2(new Uint8Array(Buffer.from(f.woff2, 'base64')), 2 * 1024 * 1024) });
  }
  return out;
}

const FILES: Readonly<Record<'regular' | 'bold', string>> = { regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf' };

const loaded = new Map<'regular' | 'bold', TrueTypeFont>();

export function liberation(face: 'regular' | 'bold'): TrueTypeFont {
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
  if (face !== 'regular' && face !== 'bold') return { font: plexTrueType(face), name: faceName(face, undefined) };
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
