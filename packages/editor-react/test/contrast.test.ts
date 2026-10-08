import { describe, expect, it } from 'vitest';
import { SEMANTIC_TOKENS, type SemanticTokens, type ThemeName } from '../src/tokens.js';

type RGB = [number, number, number];
/** #rrggbb or rgba(r, g, b, a) -> RGB + alpha */
function parse(c: string): { rgb: RGB; a: number } {
  if (c.startsWith('#')) return { rgb: [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as RGB, a: 1 };
  const m = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(c);
  if (!m) throw new Error(`cannot parse ${c}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) };
}
/** `fg` painted over opaque `bg` */
function over(fg: string, bg: string): RGB {
  const f = parse(fg);
  const b = parse(bg).rgb;
  return f.rgb.map((v, i) => Math.round(v * f.a + b[i]! * (1 - f.a))) as RGB;
}
/** WCAG 2.x relative luminance of an sRGB triple */
function lum(rgb: RGB): number {
  const c = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
export function contrast(a: string, b: string): number {
  return ratio(parse(a).rgb, parse(b).rgb);
}

type K = keyof SemanticTokens;
const SURFACES: K[] = ['bg', 'panel', 'raised'];
const STATUS: K[] = ['ok', 'warn', 'err', 'info'];
/** text on surfaces: 4.5:1 (WCAG 1.4.3) */
const TEXT: [K, K[]][] = [
  ['ink', SURFACES],
  ['dim', SURFACES],
  ['faint', SURFACES],
  ['accent', ['bg', 'panel']],
  ['focus', SURFACES],
  ...STATUS.map((s): [K, K[]] => [s, SURFACES]),
];
/** UI boundaries and indicators: 3:1 (WCAG 1.4.11) */
const UI: [K, K[]][] = [
  ['lineField', ['bg', 'panel']],
  ['focus', ['bg', 'panel', 'raised']],
];

describe.each(['light', 'dark'] as ThemeName[])('contrast (%s)', (theme) => {
  const t = SEMANTIC_TOKENS[theme];
  for (const [fg, bgs] of TEXT) for (const bg of bgs) {
    it(`${fg} on ${bg} >= 4.5`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5));
  }
  for (const [fg, bgs] of UI) for (const bg of bgs) {
    it(`${fg} on ${bg} >= 3`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3));
  }
  it('accent-ink on accent >= 4.5', () => expect(contrast(t.accentInk, t.accent)).toBeGreaterThanOrEqual(4.5));
  it('err-ink on err >= 4.5 (danger button)', () => expect(contrast(t.errInk, t.err)).toBeGreaterThanOrEqual(4.5));
  // chips and callouts: status text on its own tint, the tint laid over each surface
  for (const s of STATUS) for (const surface of SURFACES) {
    it(`${s} on ${s}-soft over ${surface} >= 4.5`, () => {
      const tint = over(t[`${s}Soft` as K], t[surface]);
      expect(ratio(parse(t[s]).rgb, tint)).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const surface of SURFACES) {
    it(`ink on selected over ${surface} >= 4.5`, () => expect(ratio(parse(t.ink).rgb, over(t.selected, t[surface]))).toBeGreaterThanOrEqual(4.5));
    it(`ink on accent-soft over ${surface} >= 4.5`, () => expect(ratio(parse(t.ink).rgb, over(t.accentSoft, t[surface]))).toBeGreaterThanOrEqual(4.5));
  }
  it('board-kind on panel >= 3 (glyph)', () => expect(contrast(t.boardKind, t.panel)).toBeGreaterThanOrEqual(3));
});
