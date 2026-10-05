/**
 * The bundled Liberation Sans faces (`packages/docs/fonts`), loaded once for
 * the vector PDF to embed: the same two files the raster path draws with, so
 * a printed sheet's text is the same glyphs on every viewer and printer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
