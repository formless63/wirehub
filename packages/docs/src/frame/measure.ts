/**
 * Text measure for the frame and the drawing sheet: IBM Plex's own advance
 * widths (`plex.generated.ts`), so a width computed here is the width that
 * prints wherever the face is embedded. A glyph Plex lacks (an arrow, an
 * ohm sign) falls back to the Liberation Sans table the sheets already carry,
 * which is what the browser falls through to as well.
 *
 * Sizes are in whatever unit the caller works in (the frame works in pt); the
 * width comes back in the same unit, so a width limit must be in that unit too.
 */

import { brandWidth } from '../drawing/brand-font.ts';
import { sans as liberation, sansBold as liberationBold } from '../drawing/fonts.generated.ts';
import { mono, monoMedium, sans, sansSemi, type PlexFace } from './plex.generated.ts';

export type PlexKind = 'sans' | 'semi' | 'mono' | 'monoMedium';

const FACES: Readonly<Record<PlexKind, PlexFace>> = { sans, semi: sansSemi, mono, monoMedium };

export const PLEX_SANS_STACK = "'IBM Plex Sans','CS Sans',Helvetica,Arial,sans-serif";
export const PLEX_MONO_STACK = "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** Advance width of one character, 1/1000 em. */
function advance(ch: string, kind: PlexKind): number {
  // the hub's own typeface, when branding set one, is set first and measured first
  if (kind === 'sans' || kind === 'semi') {
    const branded = brandWidth(ch, kind === 'semi');
    if (branded !== undefined) return branded;
  }
  const own = FACES[kind].widths[ch];
  if (own !== undefined) return own;
  // not in the Latin subset: the fallback face's width (monospace glyphs stay on the monospace grid)
  if (kind === 'mono' || kind === 'monoMedium') return FACES[kind].widths['0'] ?? 600;
  return (kind === 'semi' ? liberationBold : liberation).widths[ch] ?? 556;
}

/** Width of `text` set at `size`, with a hair of headroom for kerning and rounding (2 % by default). */
export function plexWidth(text: string, size: number, kind: PlexKind = 'sans', tracking = 0, headroom = 1.02): number {
  let units = 0;
  let count = 0;
  for (const ch of text) {
    units += advance(ch, kind);
    count += 1;
  }
  return ((units / 1000) * size + count * tracking * size) * headroom;
}

/** `text`, cut with an ellipsis until it is at most `width` wide. */
export function ellipsize(text: string, width: number, size: number, kind: PlexKind = 'sans'): string {
  if (plexWidth(text, size, kind) <= width) return text;
  const chars = [...text];
  while (chars.length > 1 && plexWidth(`${chars.join('').trimEnd()}…`, size, kind) > width) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/** Break `text` at spaces into lines no wider than `width`; a single word wider than that stays whole (the caller shrinks or cuts it). */
export function wrapLines(text: string, width: number, size: number, kind: PlexKind = 'sans'): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && plexWidth(candidate, size, kind) > width) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line !== '') lines.push(line);
  return lines;
}

export interface FittedText {
  lines: string[];
  size: number;
}

/**
 * Text fitted into a box: at `size` on up to `maxLines` lines; a line still too
 * wide shrinks the whole text down to 80 % of `size`, and what still does not
 * fit is cut with an ellipsis. The result always measures within `width`.
 */
export function fitText(text: string, width: number, size: number, kind: PlexKind = 'sans', maxLines = 1): FittedText {
  const value = text.replace(/\s+/g, ' ').trim();
  for (const scale of [1, 0.92, 0.85, 0.8]) {
    const s = size * scale;
    const lines = maxLines === 1 ? [value] : wrapLines(value, width, s, kind);
    if (lines.length <= maxLines && lines.every((l) => plexWidth(l, s, kind) <= width)) return { lines, size: s };
  }
  const s = size * 0.8;
  const wrapped = maxLines === 1 ? [value] : wrapLines(value, width, s, kind);
  const kept = wrapped.slice(0, maxLines);
  const last = wrapped.length > maxLines ? `${kept[maxLines - 1]} ${wrapped.slice(maxLines).join(' ')}` : (kept[kept.length - 1] ?? '');
  const lines = [...kept.slice(0, -1), ellipsize(last, width, s, kind)].map((l) => ellipsize(l, width, s, kind));
  return { lines, size: s };
}

/** The `@font-face` rules of the four embedded faces, ready for a `<style>`. */
export function plexFontFaceCss(): string {
  return (Object.values(FACES) as PlexFace[])
    .map((f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};src:url(data:font/woff2;base64,${f.woff2}) format('woff2')}`)
    .join('');
}
