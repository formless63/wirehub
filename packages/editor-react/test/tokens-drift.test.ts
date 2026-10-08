import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generate, parseTokens } from '../scripts/gen-tokens.mjs';

const read = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const css = read('tokens.css');

describe('tokens.css is the single source', () => {
  const out: Record<string, string> = generate(css);
  for (const name of ['tokens.ts', 'theme.css']) {
    it(`${name} is what gen:tokens produces (run: pnpm --filter @wirehub/editor-react gen:tokens)`, () => {
      expect(read(name)).toBe(out[name]);
    });
  }

  it('the prefers-color-scheme fallback equals the [data-theme=light] block', () => {
    const { base, light, fallback } = parseTokens(css);
    expect(fallback).toEqual(light);
    // light only overrides: every key exists in the dark base
    for (const k of Object.keys(light)) expect(base).toHaveProperty([k]);
  });

  it('motion tokens drop to zero under prefers-reduced-motion', () => {
    const m = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(m?.[1]).toMatch(/--dur-fast: 0ms/);
    expect(m?.[1]).toMatch(/--dur-base: 0ms/);
  });

  it('carries the plan scales', () => {
    const { base } = parseTokens(css);
    expect(['2xs', 'xs', 'sm', 'md', 'lg', 'xl'].map((k) => base[`fs-${k}`])).toEqual(['11px', '12px', '13px', '14px', '16px', '20px']);
    expect(['xs', 'sm', 'md', 'lg'].map((k) => base[`r-${k}`])).toEqual(['2px', '4px', '6px', '8px']);
    expect(['sm', 'md', 'lg'].map((k) => base[`control-${k}`])).toEqual(['22px', '26px', '30px']);
    expect([base['dur-fast'], base['dur-base']]).toEqual(['120ms', '180ms']);
    expect(['elev-1', 'elev-2', 'elev-3'].every((k) => base[k])).toBe(true);
  });
});
