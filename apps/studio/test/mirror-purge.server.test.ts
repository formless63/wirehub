/**
 * The mirror-history purge (cs-r2k): a repository made before v0.2.0 holds the owner-only settings
 * documents in its older commits. `inspect` is the dry run and changes nothing; `rewrite` drops the
 * paths from every commit with plain git, keeps everything else (messages, authors, dates, other
 * files), prunes the commits that only touched them, moves branches and tags, and leaves no
 * reachable object that holds them.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OWNER_ONLY_SETTINGS_PATHS } from '../server/runtime-settings.ts';
import { confirmationWord, describeInspection, inspect, OWNER_ONLY_PATHS, PurgeError, rewrite } from '../server/history/purge-paths.ts';

let dir = '';
let repo = '';
const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (args: string[], cwd = repo, env: Record<string, string> = {}): string =>
  execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, ...env } });

let tick = 0;
function commit(files: Record<string, string | null>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    if (body === null) rmSync(full, { force: true });
    else {
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
  }
  git(['add', '-A']);
  tick += 1;
  // a fixed, valid date per commit (the counter restarts for every test, see beforeEach)
  const when = `2026-01-${String(tick).padStart(2, '0')} 10:00:00 +0000`;
  git(['commit', '-q', '-m', message], repo, { GIT_AUTHOR_NAME: 'Ann Author', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: 'WireHub', GIT_COMMITTER_EMAIL: 'wirehub@example.com', GIT_COMMITTER_DATE: when });
  return git(['rev-parse', 'HEAD']).trim();
}

beforeEach(() => {
  tick = 0;
  dir = mkdtempSync(join(tmpdir(), 'wirehub-purge-test-'));
  repo = join(dir, 'catalog-mirror');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  tick = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** history: 1 catalog + settings, 2 settings only (vanishes), 3 catalog edit + settings edit, a side branch merged, an annotated tag */
function seed(): void {
  commit({ 'data/connectors.json': '[]', 'data/settings/sign-in.json': '{"values":{"auth.allowedEmails":["boss@example.com"]}}' }, 'first');
  commit({ 'data/settings/integrations.json': '{"values":{"mirror.url":"ssh://git.example/x.git"}}' }, 'settings only');
  git(['checkout', '-q', '-b', 'side']);
  commit({ 'data/wires.json': '[1]' }, 'side change');
  git(['checkout', '-q', 'main']);
  commit({ 'data/connectors.json': '[1]', 'data/settings/sign-in.json': '{"values":{}}' }, 'main change');
  git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], repo, { GIT_AUTHOR_NAME: 'Ann Author', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'WireHub', GIT_COMMITTER_EMAIL: 'wirehub@example.com' });
  commit({ 'data/designs/a.json': '{}', 'data/settings/jobs.json': '{"values":{}}' }, 'later');
  git(['tag', '-a', 'v1', '-m', 'release one', 'HEAD~1'], repo, { GIT_COMMITTER_NAME: 'Tagger', GIT_COMMITTER_EMAIL: 'tag@example.com' });
  git(['tag', 'light', 'HEAD']);
}

const reachableWith = (path: string): string[] => git(['log', '--all', '--format=%H', '--', path]).split('\n').filter((l) => l !== '');

describe('the default paths', () => {
  it('are the owner-only settings documents the studio keeps out of the mirror', () => {
    expect(OWNER_ONLY_PATHS.filter((p) => p.startsWith('data/')).sort()).toEqual([...OWNER_ONLY_SETTINGS_PATHS].sort());
    expect(OWNER_ONLY_PATHS).toContain('settings/sign-in.json');
    // jobs are editor-level and never dropped
    expect(OWNER_ONLY_PATHS.join(' ')).not.toContain('jobs');
  });
});

describe('the dry run', () => {
  it('counts what would go and changes nothing', () => {
    seed();
    const before = git(['rev-parse', '--all']);
    const plan = inspect(repo);
    expect(plan).toMatchObject({ bare: false, commits: 6, holding: 6, vanishing: 1, found: ['data/settings/integrations.json', 'data/settings/sign-in.json'], dirty: false });
    expect(plan.refs.sort()).toEqual(['refs/heads/main', 'refs/heads/side', 'refs/tags/light', 'refs/tags/v1']);
    expect(describeInspection(plan).join('\n')).toMatch(/1 of them change nothing else and would disappear/);
    expect(git(['rev-parse', '--all'])).toBe(before);
  });

  it('says so when there is nothing to drop, and refuses what is not a repository root', () => {
    commit({ 'data/connectors.json': '[]' }, 'clean');
    expect(describeInspection(inspect(repo)).join('\n')).toMatch(/Nothing to remove/);
    mkdirSync(join(repo, 'sub'));
    expect(() => inspect(join(repo, 'sub'))).toThrow(PurgeError);
    expect(() => inspect(join(dir, 'missing'))).toThrow(/not a folder/);
    expect(() => inspect(repo, { paths: ['../escape'] })).toThrow(/not a path inside/);
  });
});

describe('the rewrite', () => {
  it('drops the paths from every commit and keeps everything else', () => {
    seed();
    const messages = git(['log', '--format=%s', '--topo-order', '--reverse']).split('\n').filter((l) => l !== '');
    const result = rewrite(repo);
    expect(result.rewritten).toBeGreaterThan(0);
    expect(result.dropped).toBe(1);
    expect(result.remaining).toEqual([]);
    for (const path of OWNER_ONLY_PATHS) expect(reachableWith(path), path).toEqual([]);
    // the other settings document and the catalog files are untouched in the tip
    expect(readFileSync(join(repo, 'data/settings/jobs.json'), 'utf8')).toBe('{"values":{}}');
    expect(readFileSync(join(repo, 'data/connectors.json'), 'utf8')).toBe('[1]');
    // the working tree lost the dropped files with their history
    expect(() => readFileSync(join(repo, 'data/settings/sign-in.json'), 'utf8')).toThrow();
    // messages in order, minus the commit that only touched settings
    expect(git(['log', '--format=%s', '--topo-order', '--reverse']).split('\n').filter((l) => l !== '')).toEqual(messages.filter((m) => m !== 'settings only'));
    // authorship and dates survive
    expect(git(['log', '--format=%an|%ae|%cn|%ce|%aI', '--reverse', '-1', '--grep=first'])).toBe('Ann Author|ann@example.com|WireHub|wirehub@example.com|2026-01-01T10:00:00+00:00\n');
    // the merge is still a merge, the branch still exists, the repository is sound
    expect(git(['log', '--merges', '--format=%s'])).toBe('merge side\n');
    expect(git(['fsck', '--no-dangling', '--strict'])).toBe('');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('moves annotated and lightweight tags, keeping the annotation', () => {
    seed();
    rewrite(repo);
    expect(git(['for-each-ref', '--format=%(objecttype)', 'refs/tags/v1']).trim()).toBe('tag');
    expect(git(['tag', '-l', '--format=%(contents:subject)|%(taggername)', 'v1']).trim()).toBe('release one|Tagger');
    expect(git(['log', '-1', '--format=%s', 'v1']).trim()).toBe('merge side');
    expect(git(['rev-parse', 'light']).trim()).toBe(git(['rev-parse', 'main']).trim());
  });

  it('removes remote-tracking refs so the old objects are collected, and does not touch the remote setting', () => {
    seed();
    const old = git(['rev-parse', 'HEAD']).trim();
    git(['update-ref', 'refs/remotes/origin/main', old]);
    git(['remote', 'add', 'origin', 'ssh://git.example.invalid/mirror.git']);
    expect(inspect(repo).otherRefs).toEqual(['refs/remotes/origin/main']);
    rewrite(repo);
    expect(git(['for-each-ref', 'refs/remotes'])).toBe('');
    expect(git(['config', 'remote.origin.url']).trim()).toBe('ssh://git.example.invalid/mirror.git');
    expect(() => git(['cat-file', '-e', old])).toThrow();
  });

  it('refuses a dirty working tree, and reports a path some other ref still holds', () => {
    seed();
    writeFileSync(join(repo, 'data/connectors.json'), 'edited');
    expect(() => rewrite(repo)).toThrow(/uncommitted/);
    git(['checkout', '-q', '--', '.']);
    // a stash keeps the old commit reachable
    writeFileSync(join(repo, 'data/connectors.json'), 'stashed');
    git(['stash', '-q']);
    expect(rewrite(repo).remaining.length).toBeGreaterThan(0);
  });

  it('works on a bare repository, with an extra path, and a second run finds nothing', () => {
    seed();
    const bare = join(dir, 'bare.git');
    git(['clone', '-q', '--bare', repo, bare], dir);
    const result = rewrite(bare, { paths: [...OWNER_ONLY_PATHS, 'data/wires.json'] });
    expect(result.remaining).toEqual([]);
    expect(git(['log', '--all', '--format=%s', '--', 'data/wires.json'], bare)).toBe('');
    expect(inspect(bare).holding).toBe(0);
    // the original is a different repository and was not touched
    expect(reachableWith('data/settings/sign-in.json').length).toBeGreaterThan(0);
  });

  it('drops a root commit that held only the paths', () => {
    commit({ 'data/settings/sign-in.json': '{}' }, 'settings first');
    commit({ 'data/connectors.json': '[]' }, 'catalog');
    const result = rewrite(repo);
    expect(result.dropped).toBe(1);
    expect(git(['log', '--format=%s'])).toBe('catalog\n');
    expect(git(['rev-list', '--max-parents=0', 'HEAD']).trim()).toBe(git(['rev-parse', 'HEAD']).trim());
  });
});

describe('the command line', () => {
  const script = fileURLToPath(new URL('../scripts/mirror-purge.ts', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV }, stdin: 'ignore' } as never);

  it('does a dry run only on request, and refuses to rewrite without the folder name', () => {
    seed();
    const head = git(['rev-parse', 'HEAD']).trim();
    const dry = run([repo, '--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/Dry run — nothing is changed/);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(head);

    const refused = run([repo]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/--confirm catalog-mirror/);
    const wrong = run([repo, '--confirm', 'something-else']);
    expect(wrong.status).toBe(1);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(run(['ssh://git@example.invalid/x.git']).stderr).toMatch(/local folder only/);

    const done = run([repo, '--confirm', confirmationWord(repo)]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toMatch(/No reachable commit holds those paths now/);
    expect(reachableWith('data/settings/sign-in.json')).toEqual([]);
  });
});
