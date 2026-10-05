/**
 * The agent skills (`.agents/skills/*`, also reached as `.claude/skills`) must
 * not rot: each one's frontmatter parses, every repository path, package
 * filter and environment variable a skill names is real, the module skill
 * mentions every extension point of `WireHubModule`, and the pack verifier the
 * skills point at runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const skillsRoot = join(root, '.agents/skills');

const EXPECTED = ['wirehub-catalog-data', 'wirehub-catalog-pack', 'wirehub-contribute', 'wirehub-import-public-data', 'wirehub-module'];

const skillDirs = (): string[] => readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

/** `---\nname: x\ndescription: y\n---`: single-line `key: value` pairs only. */
export function parseFrontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return undefined;
  const out: Record<string, string> = {};
  for (const line of (match[1] as string).split('\n')) {
    const pair = /^([a-z][a-z-]*):\s*(.+)$/.exec(line);
    if (pair === null) return undefined;
    out[pair[1] as string] = (pair[2] as string).replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const REPO_ROOTS = ['.agents', '.claude', '.githooks', '.github', 'apps', 'packages', 'modules', 'docs', 'specs', 'scripts', 'site', 'docker'];
const ROOT_FILES = ['AGENTS.md', 'CONTRIBUTING.md', 'SPEC.md', 'MODULE-EXCEPTION.md', 'CHANGELOG.md', 'NOTICE', 'LICENSE', 'compose.yaml', '.env.example', 'pnpm-workspace.yaml', 'release-please-config.json'];

/** Every inline code span and every word of a fenced block. */
function candidates(text: string): string[] {
  const out: string[] = [];
  for (const fence of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(...(fence[1] as string).split(/\s+/));
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const span of prose.matchAll(/`([^`\n]+)`/g)) out.push(...(span[1] as string).split(/\s+/));
  return out;
}

/** The repo path a token names, cut before its first placeholder segment; undefined when it is not one. */
function repoPath(token: string): string | undefined {
  const word = token.replace(/^['"(]+|['",.;:)]+$/g, '');
  if (word.startsWith('/') || word.includes('$') || word.startsWith('data/')) return undefined;
  const top = word.split('/')[0] as string;
  if (!(ROOT_FILES.includes(word) || REPO_ROOTS.includes(top))) return undefined;
  if (top === word && !ROOT_FILES.includes(word)) return undefined;
  const segments: string[] = [];
  for (const segment of word.split('/')) {
    if (/[<>*{}]|\.\.\./.test(segment)) break;
    segments.push(segment);
  }
  return segments.join('/');
}

describe('the skills', () => {
  it('are the five expected folders, each with a SKILL.md', () => {
    expect(skillDirs()).toEqual(EXPECTED);
    for (const name of EXPECTED) expect(existsSync(join(skillsRoot, name, 'SKILL.md')), name).toBe(true);
  });

  it('are reached from .claude/skills through a relative symlink', () => {
    const link = join(root, '.claude/skills');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../.agents/skills');
    expect(existsSync(join(link, 'wirehub-module/SKILL.md'))).toBe(true);
  });

  for (const name of EXPECTED) {
    it(`${name}: frontmatter parses, names the folder and says when to load it`, () => {
      const front = parseFrontmatter(readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8'));
      expect(front, 'frontmatter').toBeDefined();
      expect(Object.keys(front ?? {}).sort()).toEqual(['description', 'name']);
      expect(front?.['name']).toBe(name);
      const description = front?.['description'] ?? '';
      expect(description.length).toBeGreaterThanOrEqual(120);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(description).toMatch(/\bLoad (when|before)\b/);
    });
  }

  it('the frontmatter parser rejects a file without it', () => {
    expect(parseFrontmatter('# no frontmatter\n')).toBeUndefined();
    expect(parseFrontmatter('---\nname: x\nbroken line\n---\nbody\n')).toBeUndefined();
    expect(parseFrontmatter('---\nname: "x"\ndescription: y z\n---\nbody\n')).toEqual({ name: 'x', description: 'y z' });
  });

  it('name only repository paths that exist (relative `references/` paths are checked in the skill)', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const name of EXPECTED) {
      for (const file of markdownFiles(join(skillsRoot, name))) {
        for (const token of candidates(readFileSync(file, 'utf8'))) {
          const word = token.replace(/^['"(]+|['",.;:)]+$/g, '');
          const target = word.startsWith('references/') ? join(skillsRoot, name, word) : (() => { const p = repoPath(token); return p === undefined || p === '' ? undefined : join(root, p); })();
          if (target === undefined) continue;
          checked += 1;
          if (!existsSync(target)) missing.push(`${name}: ${token}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('name only workspace packages that exist in `pnpm --filter` commands', () => {
    const names = new Set<string>();
    for (const dir of ['packages', 'apps', 'modules']) {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const manifest = join(root, dir, entry.name, 'package.json');
        if (entry.isDirectory() && existsSync(manifest)) names.add((JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name);
      }
    }
    names.add((JSON.parse(readFileSync(join(root, 'site/package.json'), 'utf8')) as { name: string }).name);
    const unknown: string[] = [];
    for (const name of EXPECTED) {
      for (const file of markdownFiles(join(skillsRoot, name))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/pnpm --filter (\S+)/g)) {
          const filter = (m[1] as string).replace(/[`'",.;:)]+$/g, '');
          if (!filter.includes('<') && !names.has(filter)) unknown.push(`${name}: ${filter}`);
        }
      }
    }
    expect(names.has('studio') && names.has('@wirehub/module-example')).toBe(true);
    expect(unknown).toEqual([]);
  });

  it('name only WIREHUB_* environment variables the repository reads', () => {
    const skip = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
    const haystack: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs|yaml|yml|sh|md)$/.test(entry.name) || entry.name === '.env.example') haystack.push(readFileSync(path, 'utf8'));
      }
    };
    for (const dir of ['apps', 'packages', 'modules', 'site', 'docker', 'docs', 'scripts']) walk(join(root, dir));
    haystack.push(readFileSync(join(root, 'compose.yaml'), 'utf8'), readFileSync(join(root, '.env.example'), 'utf8'));
    const text = haystack.join('\n');
    const unknown: string[] = [];
    for (const name of EXPECTED) {
      for (const file of markdownFiles(join(skillsRoot, name))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/\bWIREHUB_[A-Z0-9_]+\b/g)) if (!text.includes(m[0])) unknown.push(`${name}: ${m[0]}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('the module skill covers every extension point of WireHubModule', () => {
    const source = readFileSync(join(root, 'packages/modules/src/index.ts'), 'utf8');
    const body = /export interface WireHubModule \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const members = [...body.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1] as string);
    expect(members.length).toBeGreaterThanOrEqual(15);
    const skill = readFileSync(join(skillsRoot, 'wirehub-module/SKILL.md'), 'utf8');
    for (const member of members) expect(skill, member).toContain(member);
  });

  it('the pack verifier runs, and accepts the example pack', () => {
    const script = join(skillsRoot, 'wirehub-catalog-pack/scripts/verify-pack.mjs');
    const output = execFileSync('node', [script, join(root, 'modules/example/pack')], { encoding: 'utf8', cwd: dirname(root) });
    expect(output).toContain('verified');
  }, 60_000);
});
