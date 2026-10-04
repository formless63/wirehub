/**
 * Deterministic text metrics.
 *
 * Layout owns geometry, so it has to estimate how wide a string will draw.
 * There is no font engine here (and no browser): widths come from static
 * advance-width tables, one per weight, scaled by the font size. The renderer
 * must use the same font sizes (see `METRICS`), the same weights and the same
 * font stack (`FONT_FAMILY`) for the estimate to hold.
 *
 * **Which fonts.** `FONT_FAMILY` names concrete faces, not `system-ui`: an
 * Arial-metric face first (Helvetica on macOS, Arial on Windows, Liberation
 * Sans / Arimo / Nimbus Sans on Linux — all share Helvetica's advances), then
 * DejaVu Sans, the usual Linux fallback when none of those is installed.
 * Nothing is left to a platform UI font, whose widths nobody can table.
 *
 * **The tables** are the per-character *envelope* — the wider of Liberation
 * Sans (standing in for Arial/Helvetica: identical advances) and DejaVu Sans
 * (the widest face the stack can land on) — measured in Chromium by
 * `pnpm --filter @wirehub/render-svg measure-glyphs`.
 * DejaVu is the wider almost everywhere, by ~10 % at regular weight and ~20 %
 * in bold, so on a Helvetica/Arial machine the estimate runs that generous:
 * text never overruns the room reserved for it on any face in the stack.
 * `font-weight: 600` resolves to each family's Bold (neither ships a
 * semibold), hence the separate bold table.
 */

/** The SVG's font stack; every face it can resolve to is covered by the tables below. */
export const FONT_FAMILY =
  'Helvetica,Arial,"Liberation Sans",Arimo,"Nimbus Sans","Nimbus Sans L","DejaVu Sans",sans-serif';

/** `regular` is `font-weight: 400`; `bold` is the stylesheet's `font-weight: 600`. */
export type FontWeight = 'regular' | 'bold';

/** Advance widths in 1/1000 em at weight 400: envelope of Liberation Sans and DejaVu Sans. */
const REGULAR: Readonly<Record<string, number>> = {
  ' ': 318, '!': 401, '"': 460, '#': 838, $: 636, '%': 950, '&': 780, "'": 275,
  '(': 390, ')': 390, '*': 500, '+': 838, ',': 318, '-': 361, '.': 318, '/': 337,
  '0': 636, '1': 636, '2': 636, '3': 636, '4': 636, '5': 636, '6': 636, '7': 636,
  '8': 636, '9': 636, ':': 337, ';': 337, '<': 838, '=': 838, '>': 838, '?': 556,
  '@': 1015,
  A: 684, B: 686, C: 722, D: 770, E: 667, F: 611, G: 778, H: 752, I: 295, J: 500,
  K: 667, L: 557, M: 863, N: 748, O: 787, P: 667, Q: 787, R: 722, S: 667, T: 611,
  U: 732, V: 684, W: 989, X: 685, Y: 667, Z: 685,
  '[': 390, '\\': 337, ']': 390, '^': 838, _: 556, '`': 500,
  a: 613, b: 635, c: 550, d: 635, e: 615, f: 352, g: 635, h: 634, i: 278, j: 278,
  k: 579, l: 278, m: 974, n: 634, o: 612, p: 635, q: 635, r: 411, s: 521, t: 392,
  u: 634, v: 592, w: 818, x: 592, y: 592, z: 525,
  '{': 636, '|': 337, '}': 636, '~': 838,
  // characters the catalog uses (or is likely to) beyond ASCII
  '§': 556, '°': 500, '±': 838, 'µ': 636, '·': 318, '×': 838, 'Ø': 787, 'Ω': 764,
  '–': 556, '—': 1000, '‘': 318, '’': 318, '“': 518, '”': 518, '…': 1000,
  '→': 1000, '↔': 1000, '≠': 838, '⏚': 1000,
};

/** Advance widths in 1/1000 em at weight 600 (each family's Bold): the same envelope. */
const BOLD: Readonly<Record<string, number>> = {
  ' ': 348, '!': 456, '"': 521, '#': 838, $: 696, '%': 1002, '&': 872, "'": 306,
  '(': 457, ')': 457, '*': 523, '+': 838, ',': 380, '-': 415, '.': 380, '/': 365,
  '0': 696, '1': 696, '2': 696, '3': 696, '4': 696, '5': 696, '6': 696, '7': 696,
  '8': 696, '9': 696, ':': 400, ';': 400, '<': 838, '=': 838, '>': 838, '?': 611,
  '@': 1000,
  A: 774, B: 762, C: 734, D: 830, E: 683, F: 683, G: 821, H: 837, I: 372, J: 556,
  K: 775, L: 637, M: 995, N: 837, O: 850, P: 733, Q: 850, R: 770, S: 720, T: 682,
  U: 812, V: 774, W: 1103, X: 771, Y: 724, Z: 725,
  '[': 457, '\\': 365, ']': 457, '^': 838, _: 556, '`': 500,
  a: 675, b: 716, c: 593, d: 716, e: 678, f: 435, g: 716, h: 712, i: 343, j: 343,
  k: 665, l: 343, m: 1042, n: 712, o: 687, p: 716, q: 716, r: 493, s: 595, t: 478,
  u: 712, v: 652, w: 924, x: 645, y: 652, z: 582,
  '{': 712, '|': 365, '}': 712, '~': 838,
  '§': 556, '°': 500, '±': 838, 'µ': 736, '·': 380, '×': 838, 'Ø': 850, 'Ω': 850,
  '–': 556, '—': 1000, '‘': 380, '’': 380, '“': 657, '”': 657, '…': 1000,
  '→': 1000, '↔': 1000, '≠': 838, '⏚': 1000,
};

/** A character neither table knows: a full em, so it can only over-reserve. */
const DEFAULT_ADVANCE = 1000;

/**
 * Slack over the measured envelope for what an advance sum does not see:
 * hinting at small sizes and sub-pixel rounding in the reader's rasteriser.
 */
const SAFETY = 1.02;

/**
 * Estimated rendered width of `text` at `fontSize` (same units as fontSize).
 * `letterSpacing` is the stylesheet's `letter-spacing` in the same units,
 * added after every character as browsers do.
 */
export function textWidth(
  text: string,
  fontSize: number,
  weight: FontWeight = 'regular',
  letterSpacing = 0,
): number {
  const table = weight === 'bold' ? BOLD : REGULAR;
  let units = 0;
  let count = 0;
  for (const char of text) {
    units += table[char] ?? DEFAULT_ADVANCE;
    count += 1;
  }
  return (units / 1000) * fontSize * SAFETY + count * letterSpacing;
}

/** Widest of several strings at one font size and weight. */
export function maxTextWidth(
  texts: readonly string[],
  fontSize: number,
  weight: FontWeight = 'regular',
): number {
  let widest = 0;
  for (const text of texts) widest = Math.max(widest, textWidth(text, fontSize, weight));
  return widest;
}

/**
 * Greedy word wrap to `maxWidth`. Words longer than the line are kept whole
 * (never hyphenated) so part numbers and net names stay searchable.
 */
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  weight: FontWeight = 'regular',
): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && textWidth(candidate, fontSize, weight) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Compress a sorted list of connector pin ids into reader-friendly runs:
 * `['1','2','6','7','8','9','21']` → `'1, 2, 6-9, 21'`. Non-numeric ids
 * (`shell`, `tip`) are listed verbatim after the numeric runs.
 */
export function summarizeIds(ids: readonly string[]): string {
  const numeric: number[] = [];
  const other: string[] = [];
  for (const id of ids) {
    if (/^\d+$/.test(id)) numeric.push(Number(id));
    else other.push(id);
  }
  numeric.sort((x, y) => x - y);
  const runs: string[] = [];
  let index = 0;
  while (index < numeric.length) {
    const start = numeric[index] ?? 0;
    let end = start;
    while (index + 1 < numeric.length && (numeric[index + 1] ?? 0) === end + 1) {
      index += 1;
      end = numeric[index] ?? end;
    }
    runs.push(end - start >= 2 ? `${start}-${end}` : end === start ? `${start}` : `${start}, ${end}`);
    index += 1;
  }
  return [...runs, ...other].join(', ');
}

/**
 * Sort key for terminal ids: numeric ids sort numerically and ahead of named
 * ones (`shell`, `tip`, `GND`), which sort lexicographically.
 */
export function compareTerminalIds(x: string, y: string): number {
  const xNum = /^\d+$/.test(x);
  const yNum = /^\d+$/.test(y);
  if (xNum && yNum) return Number(x) - Number(y);
  if (xNum) return -1;
  if (yNum) return 1;
  return x.localeCompare(y);
}

/**
 * `text` cut to fit `maxWidth` at `fontSize`, ending in an ellipsis when cut.
 * Whole words where possible, so a long band role reads as a clean prefix.
 */
export function fitText(
  text: string,
  fontSize: number,
  maxWidth: number,
  weight: FontWeight = 'regular',
): string {
  if (textWidth(text, fontSize, weight) <= maxWidth) return text;
  const words = text.split(' ');
  let out = '';
  for (const word of words) {
    const next = out === '' ? word : `${out} ${word}`;
    if (textWidth(`${next} …`, fontSize, weight) > maxWidth) break;
    out = next;
  }
  if (out === '') {
    for (const char of text) {
      if (textWidth(`${out}${char}…`, fontSize, weight) > maxWidth) break;
      out += char;
    }
    return `${out}…`;
  }
  return `${out.replace(/[\s·;,(]+$/u, '')} …`;
}
