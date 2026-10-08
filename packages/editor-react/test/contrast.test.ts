import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SEMANTIC_TOKENS, type SemanticTokens, type ThemeName } from '../src/tokens.js';

/** WCAG 2.x relative luminance / contrast ratio for #rrggbb. */
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

type K = keyof SemanticTokens;
const SURFACES: K[] = ['bg', 'panel', 'raised'];
/** text on surfaces: 4.5:1 (WCAG 1.4.3) */
const TEXT: [K, K[]][] = [
  ['ink', SURFACES],
  ['dim', SURFACES],
  ['faint', SURFACES],
  ['accent', ['bg', 'panel']],
  ['ok', ['panel']],
  ['warn', ['panel']],
  ['err', ['panel']],
];
/** UI boundaries: 3:1 (WCAG 1.4.11) */
const UI: [K, K[]][] = [['lineField', ['bg', 'panel']]];

describe.each(['light', 'dark'] as ThemeName[])('contrast (%s)', (theme) => {
  const t = SEMANTIC_TOKENS[theme];
  for (const [fg, bgs] of TEXT) for (const bg of bgs) {
    it(`${fg} on ${bg} >= 4.5`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5));
  }
  for (const [fg, bgs] of UI) for (const bg of bgs) {
    it(`${fg} on ${bg} >= 3`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3));
  }
  it('accent-ink on accent >= 4.5', () => expect(contrast(t.accentInk, t.accent)).toBeGreaterThanOrEqual(4.5));
});

describe('tokens.css mirrors tokens.ts for the contrast-critical tokens', () => {
  const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
  const block = (theme: ThemeName) => (theme === 'dark' ? css.slice(css.indexOf(':root {'), css.indexOf("[data-theme='light'] {")) : css.slice(css.indexOf("[data-theme='light'] {"), css.indexOf('@media')));
  for (const theme of ['light', 'dark'] as ThemeName[]) {
    for (const [name, key] of [['faint', 'faint'], ['line-field', 'lineField'], ['accent', 'accent']] as const) {
      it(`--${name} (${theme})`, () => expect(block(theme)).toContain(`--${name}: ${SEMANTIC_TOKENS[theme][key]};`));
    }
  }
});
