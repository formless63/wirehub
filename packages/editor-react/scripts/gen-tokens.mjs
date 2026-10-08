#!/usr/bin/env node
/**
 * Generates `src/tokens.ts` and `src/theme.css` from `src/tokens.css` (the single source of
 * truth). Run `pnpm --filter @wirehub/editor-react gen:tokens`; `test/tokens-drift.test.ts`
 * imports `generate()` and fails when the committed files differ from its output.
 * No dependencies; deterministic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);

/** top-level rules of a stylesheet (comments stripped); `@media` bodies are not read. */
export function parseTokens(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const base = {};
  const light = {};
  const fallback = {};
  let i = 0;
  const block = (open) => {
    let depth = 0;
    for (let j = open; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) return j;
    }
    throw new Error('unbalanced braces in tokens.css');
  };
  const decls = (body, into) => {
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) into[m[1].slice(2)] = m[2].trim().replace(/\s+/g, ' ');
  };
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const sel = text.slice(i, open).trim();
    const close = block(open);
    const body = text.slice(open + 1, close);
    if (/^:root(,\s*\[data-theme='dark'\])?$/.test(sel)) decls(body, base);
    else if (sel === "[data-theme='light']") decls(body, light);
    else if (sel.startsWith('@media (prefers-color-scheme: light)')) {
      const inner = body.indexOf('{');
      decls(body.slice(inner + 1, body.lastIndexOf('}')), fallback);
    }
    i = close + 1;
  }
  return { base, light, fallback };
}

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const SCALE_GROUPS = ['font', 'fs', 'space', 'r', 'control', 'dur', 'ease'];
const isScale = (n) => SCALE_GROUPS.some((g) => n === g || n.startsWith(g + '-'));
const isCond = (n) => n.startsWith('cond-');

/** a TS object literal with single-quoted strings and trailing commas */
function literal(v, depth) {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const pad = '  '.repeat(depth + 1);
  const entries = Object.entries(v).map(([k, x]) => `${pad}${/^[A-Za-z_]\w*$/.test(k) ? k : `'${k}'`}: ${literal(x, depth + 1)},`);
  return `{\n${entries.join('\n')}\n${'  '.repeat(depth)}}`;
}

function resolve(map, v, depth = 0) {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  if (!m) return v;
  if (depth > 5 || map[m[1]] === undefined) throw new Error(`cannot resolve ${v}`);
  return resolve(map, map[m[1]], depth + 1);
}

export function generate(css) {
  const { base, light } = parseTokens(css);
  const themes = { dark: base, light: { ...base, ...light } };
  const scalesRaw = Object.fromEntries(Object.entries(base).filter(([n]) => isScale(n)));
  const semKeys = Object.keys(base).filter((n) => !isScale(n) && !isCond(n));
  const condKeys = Object.keys(base).filter(isCond);

  const scales = {};
  for (const [n, v] of Object.entries(scalesRaw)) {
    const [g, ...rest] = n.split('-');
    const group = g === 'dur' || g === 'ease' ? 'motion' : g === 'fs' ? 'text' : g === 'r' ? 'radius' : g;
    const key = g === 'ease' ? 'ease' : g === 'dur' ? rest.join('-') : rest.join('-') || 'value';
    (scales[group] ??= {})[key] = v;
  }

  let ts = `/**
 * GENERATED from \`tokens.css\` by \`scripts/gen-tokens.mjs\` -- do not edit by hand.
 * Run \`pnpm --filter @wirehub/editor-react gen:tokens\`; \`test/tokens-drift.test.ts\` fails on drift.
 *
 * Semantic design tokens for call sites that need a value in JavaScript (a React Flow prop that
 * only takes a string, a canvas paint). Prefer the CSS custom properties (\`var(--panel)\`) or the
 * Tailwind utilities they back (\`bg-panel\`, \`cs:bg-panel\`): only the CSS follows a theme change.
 */

export type ThemeName = 'light' | 'dark';

`;
  ts += `export interface SemanticTokens {\n${semKeys.map((k) => `  ${camel(k)}: string;`).join('\n')}\n}\n\n`;
  ts += 'export const SEMANTIC_TOKENS: Record<ThemeName, SemanticTokens> = {\n';
  for (const t of ['dark', 'light']) {
    ts += `  ${t}: {\n${semKeys.map((k) => `    ${camel(k)}: ${JSON.stringify(resolve(themes[t], themes[t][k]))},`).join('\n')}\n  },\n`;
  }
  ts += '};\n\n';
  ts += `/** theme-independent scales: type steps, the 4 px space grid, radii, control heights, motion (px / ms strings) */\nexport const SCALES = ${literal(scales, 0)} as const;\n\n`;
  const condNames = condKeys.map((k) => k.slice(5));
  ts += `/**
 * Conductor colours: the domain palette (wire jackets, cores, drains), not UI chrome. Identical in
 * both themes except \`white\` and \`black\`, which get an outline stroke when drawn (see
 * \`OUTLINED_CONDUCTORS\`) because a bare fill in either colour disappears against one of the canvases.
 */
export type ConductorColorName = ${condNames.map((n) => `'${n}'`).join(' | ')};\n\n`;
  ts += 'export const CONDUCTOR_COLORS: Record<ThemeName, Record<ConductorColorName, string>> = {\n';
  for (const t of ['dark', 'light']) ts += `  ${t}: {\n${condKeys.map((k) => `    ${k.slice(5)}: '${themes[t][k]}',`).join('\n')}\n  },\n`;
  ts += '};\n\n/** conductor colours that need an outline stroke to read against the canvas */\nexport const OUTLINED_CONDUCTORS: ReadonlySet<ConductorColorName> = new Set([\'white\', \'black\']);\n';

  // Tailwind 4 map, shared by the prefixed editor sheet and the unprefixed app sheet
  const isColour = (k) => !/^(shadow|elev-)/.test(k);
  let th = `/* GENERATED from tokens.css by scripts/gen-tokens.mjs -- do not edit by hand.\n   Imported by editor.css (prefix cs) and apps/studio/src/studio.css (no prefix), so every\n   token is a utility in both worlds: bg-panel / cs:bg-panel, text-sm / cs:text-sm, ... */\n\n@theme inline {\n`;
  for (const k of semKeys.filter(isColour)) th += `  --color-${k}: var(--${k});\n`;
  for (const k of condKeys) th += `  --color-${k}: var(--${k});\n`;
  th += `\n  --font-sans: ${base['font-sans']};\n  --font-mono: ${base['font-mono']};\n\n`;
  for (const k of Object.keys(scalesRaw).filter((n) => n.startsWith('fs-'))) th += `  --text-${k.slice(3)}: var(--${k});\n`;
  th += '\n  --spacing: var(--space-unit);\n\n';
  for (const k of Object.keys(scalesRaw).filter((n) => n.startsWith('r-'))) th += `  --radius-${k.slice(2)}: var(--${k});\n`;
  th += '\n  --shadow-sm: var(--elev-1);\n  --shadow-md: var(--elev-2);\n  --shadow-lg: var(--elev-3);\n\n';
  th += '  --default-transition-duration: var(--dur-fast);\n  --default-transition-timing-function: var(--ease);\n  --ease-standard: var(--ease);\n}\n\n';
  th += '/* control heights: h-control-sm 22, h-control-md 26, h-control-lg 30 */\n';
  for (const s of ['sm', 'md', 'lg']) th += `@utility h-control-${s} {\n  height: var(--control-${s});\n}\n`;
  return { 'tokens.ts': ts, 'theme.css': th };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = generate(readFileSync(new URL('tokens.css', SRC), 'utf8'));
  for (const [name, text] of Object.entries(out)) writeFileSync(new URL(name, SRC), text);
  console.log('wrote src/tokens.ts and src/theme.css');
}
