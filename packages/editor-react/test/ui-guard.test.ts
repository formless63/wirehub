/**
 * UI guard: a grep test in the style of the repo's privacy and skills tests. In TSX and CSS
 * (outside `tokens.css` and the generated `theme.css`) it rejects
 *
 *   - raw font sizes:        `text-[13px]`, `font-size: 13px`        -> use a type step (`text-sm`, `var(--fs-sm)`)
 *   - raw hex colours:       `#a4531c`                               -> use a token (`var(--accent)`, `bg-panel`)
 *   - native `<select>`                                              -> use `Select` from `src/ui`
 *   - `confirm(` / `prompt(`                                         -> use `ConfirmDialog` / a Dialog with a Field
 *
 * Today's violations are an explicit allow-list (`ui-guard.allowlist.json`: file -> rule -> count, and `reasons`: file -> why it stays).
 * The list may only SHRINK:
 *
 *   - a file or rule that is not listed must have zero violations;
 *   - a file may not exceed its listed count (a new violation fails the test);
 *   - a file that now has FEWER than listed also fails, until you lower the number, so progress is
 *     locked in. Do that with
 *         UI_GUARD_UPDATE=1 pnpm --filter @wirehub/editor-react test -- ui-guard
 *     which rewrites the allow-list with the current (lower or equal) counts and removes cleared
 *     files. It refuses to raise a count: fix the new violation instead.
 *
 * Doc-comment text is ignored (`/* ... *\/` blocks and whole-line `//` comments).
 * Documents (drawings, sheets, PDFs) keep their own print scale; those files are not allow-listed
 * by an exemption but counted like any other, until DOC-1 moves them onto tokens or into data.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ALLOW_URL = new URL('./ui-guard.allowlist.json', import.meta.url);

export const RULES = {
  'raw-font-size': { re: /font-size:\s*\d+(?:\.\d+)?px|text-\[\d+(?:\.\d+)?px\]/g, files: /\.(tsx|css)$/ },
  'raw-hex': { re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g, files: /\.(tsx|css)$/ },
  'native-select': { re: /<select\b/g, files: /\.tsx$/ },
  'confirm-prompt': { re: /(?<![\w.])(?:window\.)?(?:confirm|prompt)\(/g, files: /\.tsx$/ },
} as const;
type Rule = keyof typeof RULES;
type Counts = Partial<Record<Rule, number>>;

function sourceRoots(): string[] {
  const roots = ['apps/studio/src'];
  for (const group of ['packages', 'modules']) {
    for (const name of readdirSync(join(REPO, group))) roots.push(`${group}/${name}/src`);
  }
  return roots;
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx|css)$/.test(e) && !/\.test\./.test(e) && !/^(tokens|theme)\.css$/.test(e)) yield p;
  }
}

export function scan(): Record<string, Counts> {
  const found: Record<string, Counts> = {};
  for (const root of sourceRoots()) {
    for (const file of walk(join(REPO, root))) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const counts: Counts = {};
      for (const [rule, { re, files }] of Object.entries(RULES) as [Rule, (typeof RULES)[Rule]][]) {
        if (!files.test(file)) continue;
        const n = (text.match(re) ?? []).length;
        if (n > 0) counts[rule] = n;
      }
      if (Object.keys(counts).length > 0) found[relative(REPO, file)] = counts;
    }
  }
  return found;
}

function readRaw(): { files: Record<string, Counts>; reasons?: Record<string, string> } {
  return JSON.parse(readFileSync(ALLOW_URL, 'utf8')) as { files: Record<string, Counts>; reasons?: Record<string, string> };
}
function readAllow(): Record<string, Counts> {
  return readRaw().files;
}

const DOC = 'Violations of the UI guard (packages/editor-react/test/ui-guard.test.ts) that exist today. This list may only shrink: lower a count when you fix a violation (UI_GUARD_UPDATE=1 pnpm --filter @wirehub/editor-react test -- ui-guard does it), never raise one.';

describe('ui guard', () => {
  const found = scan();

  if (process.env.UI_GUARD_UPDATE) {
    it('rewrites the allow-list with the current counts (never raising one)', () => {
      const allow = readAllow();
      const next: Record<string, Counts> = {};
      for (const [file, counts] of Object.entries(found)) {
        for (const [rule, n] of Object.entries(counts) as [Rule, number][]) {
          const cap = allow[file]?.[rule] ?? 0;
          if (Object.keys(allow).length > 0) expect(n, `${file}: ${n} ${rule} but only ${cap} allowed; fix the new violation instead of raising the list`).toBeLessThanOrEqual(cap);
        }
        next[file] = counts;
      }
      const kept = Object.fromEntries(Object.entries(readRaw().reasons ?? {}).filter(([file]) => file in next).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(ALLOW_URL, JSON.stringify({ _doc: DOC, files: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), reasons: kept }, null, 2) + '\n');
    });
    return;
  }

  const allow = readAllow();
  const files = [...new Set([...Object.keys(found), ...Object.keys(allow)])].sort();

  it('no new violations: nothing exceeds the allow-list', () => {
    const over: string[] = [];
    for (const f of files) {
      for (const rule of Object.keys(RULES) as Rule[]) {
        const n = found[f]?.[rule] ?? 0;
        const cap = allow[f]?.[rule] ?? 0;
        if (n > cap) over.push(`${f}: ${n} ${rule} (allowed ${cap})`);
      }
    }
    expect(over, 'use tokens, Select and ConfirmDialog from src/ui instead').toEqual([]);
  });

  it('the allow-list is tight: every count is exactly today\'s count', () => {
    const slack: string[] = [];
    for (const f of files) {
      for (const rule of Object.keys(RULES) as Rule[]) {
        const n = found[f]?.[rule] ?? 0;
        const cap = allow[f]?.[rule] ?? 0;
        if (n < cap) slack.push(`${f}: ${rule} is down to ${n} (listed ${cap})`);
      }
    }
    expect(slack, 'lower the numbers: UI_GUARD_UPDATE=1 pnpm --filter @wirehub/editor-react test -- ui-guard').toEqual([]);
  });

  it('every file still on the list says why', () => {
    const reasons = readRaw().reasons ?? {};
    expect(Object.keys(allow).filter((f) => (reasons[f] ?? '').trim() === ''), 'add a reason for the file under "reasons" in ui-guard.allowlist.json').toEqual([]);
  });

  it('the rules catch what they claim to', () => {
    const hit = (rule: Rule, s: string) => (s.match(RULES[rule].re) ?? []).length;
    expect(hit('raw-font-size', 'class="text-[11px] x"; a { font-size: 12.5px }')).toBe(2);
    expect(hit('raw-font-size', 'font-size: var(--fs-sm); text-sm')).toBe(0);
    expect(hit('raw-hex', 'color: #fff; fill="#a4531c"; border: 1px solid #0008')).toBe(3);
    expect(hit('raw-hex', 'href="#section"; var(--accent)')).toBe(0);
    expect(hit('native-select', '<select value={x}>')).toBe(1);
    expect(hit('confirm-prompt', 'if (confirm("x")) window.prompt("y")')).toBe(2);
    expect(hit('confirm-prompt', 'onConfirm(x); dialog.confirm(); ConfirmDialog')).toBe(0);
  });
});
