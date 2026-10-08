/**
 * Drop paths from a git repository's whole history, with plain git
 * (`docs/self-hosting.md` "Older history of the git mirror"): for the mirror
 * repositories made before v0.2.0, and the file backend's git export, whose
 * earlier commits hold the owner-only settings documents
 * (`data/settings/{sign-in,notifications,integrations}.json`) that the current
 * code no longer commits.
 *
 * It does what `git filter-repo --path … --invert-paths` would, with plumbing
 * only (`read-tree` into a throwaway index, `update-index --force-remove`, `write-tree`,
 * `commit-tree`), so nothing but git is needed:
 *
 * - the repository is a local path the caller named; no remote is ever contacted
 *   or changed, and nothing is pushed;
 * - `inspect` is the dry run: it reads, counts and changes nothing;
 * - `rewrite` rebuilds the commits in order, keeping each one's message,
 *   author, committer and dates (signatures cannot survive and are dropped),
 *   prunes the commits that only touched those paths, moves local branches
 *   and tags to the new commits, removes remote-tracking refs and the reflog
 *   so the old objects are unreachable, and collects them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** The owner-only settings documents, as the mirror and the export lay them out, and as a repository rooted at `data/` would. */
export const OWNER_ONLY_PATHS: readonly string[] = ['sign-in', 'notifications', 'integrations', 'webhooks', 'modules'].flatMap((name) => [`data/settings/${name}.json`, `settings/${name}.json`]);

export class PurgeError extends Error {}

export interface PurgeOptions {
  /** the paths to drop (default `OWNER_ONLY_PATHS`) */
  paths?: readonly string[];
  log?: (line: string) => void;
}

export interface Inspection {
  repo: string;
  bare: boolean;
  paths: string[];
  /** commits reachable from branches and tags */
  commits: number;
  /** of them, holding at least one of the paths in their tree */
  holding: number;
  /** of them, commits that change nothing else (they would disappear) */
  vanishing: number;
  /** the paths found in some commit's tree */
  found: string[];
  /** local branches and tags whose history holds the paths (they would move) */
  refs: string[];
  /** remote-tracking branches and other refs that would be deleted */
  otherRefs: string[];
  /** uncommitted changes in a non-bare repository (the rewrite refuses) */
  dirty: boolean;
}

function git(repo: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
  try {
    return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      input: options.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', ...options.env },
    });
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    throw new PurgeError(`git ${args[0]} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

function checkPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, '');
    if (path === '' || path.startsWith('/') || path.split('/').includes('..') || path === '.git' || path.startsWith('.git/') || /[\0\n]/.test(path)) {
      throw new PurgeError(`'${raw}' is not a path inside the repository.`);
    }
    if (!out.includes(path)) out.push(path);
  }
  if (out.length === 0) throw new PurgeError('No paths to drop.');
  return out;
}

/** The repository at `path`: its top level (never a folder inside one), whether it is bare. */
export function openRepo(path: string): { repo: string; bare: boolean } {
  const repo = resolve(path);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new PurgeError(`${repo} is not a folder.`);
  const bare = git(repo, ['rev-parse', '--is-bare-repository']).trim() === 'true';
  if (bare) {
    const gitDir = resolve(repo, git(repo, ['rev-parse', '--git-dir']).trim());
    if (gitDir !== repo) throw new PurgeError(`${repo} is inside a git repository; name the repository's own folder.`);
  } else {
    const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
    if (resolve(top) !== repo) throw new PurgeError(`${repo} is inside the repository at ${top}; name that folder instead.`);
  }
  return { repo, bare };
}

interface Row {
  sha: string;
  parents: string[];
}

function rows(repo: string): Row[] {
  const out = git(repo, ['rev-list', '--topo-order', '--reverse', '--parents', '--branches', '--tags']).split('\n').filter((l) => l !== '');
  return out.map((line) => {
    const [sha, ...parents] = line.split(' ');
    return { sha: sha as string, parents };
  });
}

const holds = (repo: string, sha: string, paths: readonly string[]): string[] =>
  git(repo, ['ls-tree', '--name-only', sha, '--', ...paths]).split('\n').filter((l) => l !== '');

/** Everything `rewrite` would do, without changing anything (the dry run). */
export function inspect(path: string, options: PurgeOptions = {}): Inspection {
  const paths = checkPaths(options.paths ?? OWNER_ONLY_PATHS);
  const { repo, bare } = openRepo(path);
  if (git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).trim() === '' && rows(repo).length === 0) throw new PurgeError(`${repo} has no commits.`);
  const all = rows(repo);
  const found = new Set<string>();
  let holding = 0;
  let vanishing = 0;
  const holdsCommit = new Set<string>();
  for (const row of all) {
    const here = holds(repo, row.sha, paths);
    if (here.length === 0) continue;
    holding += 1;
    holdsCommit.add(row.sha);
    for (const p of here) found.add(p);
    // a commit that changes only these paths is empty once they are gone
    const changed = git(repo, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-only', '-m', '--first-parent', row.sha]).split('\n').filter((l) => l !== '');
    if (changed.length > 0 && changed.every((c) => paths.includes(c)) && row.parents.length <= 1) vanishing += 1;
  }
  const refs: string[] = [];
  const otherRefs: string[] = [];
  for (const line of git(repo, ['for-each-ref', '--format=%(refname)']).split('\n').filter((l) => l !== '')) {
    if (line.startsWith('refs/heads/') || line.startsWith('refs/tags/')) {
      if (refReaches(repo, line, holdsCommit)) refs.push(line);
    } else if (line.startsWith('refs/remotes/')) otherRefs.push(line);
  }
  const dirty = bare ? false : git(repo, ['status', '--porcelain', '--untracked-files=no']).trim() !== '';
  return { repo, bare, paths, commits: all.length, holding, vanishing, found: [...found].sort(), refs, otherRefs, dirty };
}

function refReaches(repo: string, ref: string, shas: ReadonlySet<string>): boolean {
  const reachable = new Set(git(repo, ['rev-list', ref]).split('\n'));
  for (const sha of shas) if (reachable.has(sha)) return true;
  return false;
}

/** The lines the dry run prints. */
export function describeInspection(i: Inspection): string[] {
  const out = [
    `Repository: ${i.repo}${i.bare ? ' (bare)' : ''}`,
    `Paths to drop: ${i.paths.join(', ')}`,
    `${i.commits} commits on branches and tags; ${i.holding} hold at least one of these paths${i.found.length === 0 ? '' : ` (found: ${i.found.join(', ')})`}.`,
  ];
  if (i.holding === 0) {
    out.push('Nothing to remove: no commit on a branch or tag holds those paths.');
    return out;
  }
  out.push(`${i.vanishing} of them change nothing else and would disappear; the other ${i.holding - i.vanishing} stay, without those files.`);
  out.push(`Every commit after the first affected one gets a new id. Branches and tags that move: ${i.refs.join(', ') || 'none'}.`);
  if (i.otherRefs.length > 0) out.push(`Remote-tracking refs that would be deleted (so the old commits can be collected): ${i.otherRefs.join(', ')}.`);
  out.push('Signatures on rewritten commits are dropped. The reflog is expired and unreachable objects are collected.');
  if (i.dirty) out.push('The working tree has uncommitted changes: the rewrite refuses until it is clean.');
  return out;
}

export interface RewriteResult {
  rewritten: number;
  dropped: number;
  movedRefs: string[];
  deletedRefs: string[];
  /** paths still present in some commit reachable from any ref afterwards (a stash, a worktree's branch …) */
  remaining: string[];
}

interface Header {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function readCommit(repo: string, sha: string): Header {
  const raw = git(repo, ['cat-file', 'commit', sha]);
  const split = raw.indexOf('\n\n');
  const head = (split === -1 ? raw : raw.slice(0, split)).split('\n');
  const message = split === -1 ? '' : raw.slice(split + 2);
  const header: Header = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head) {
    if (line.startsWith('tree ')) header.tree = line.slice(5);
    else if (line.startsWith('parent ')) header.parents.push(line.slice(7));
    else if (line.startsWith('author ')) header.author = line.slice(7);
    else if (line.startsWith('committer ')) header.committer = line.slice(10);
    // gpgsig / mergetag continuation lines and `encoding` are dropped on purpose
  }
  return header;
}

function identity(line: string, who: 'AUTHOR' | 'COMMITTER'): Record<string, string> {
  const m = /^(.*) <(.*)> (\d+ [+-]\d{4})$/.exec(line);
  if (m === null) throw new PurgeError(`Cannot read a commit's ${who.toLowerCase()} line: ${line}`);
  return { [`GIT_${who}_NAME`]: m[1] as string, [`GIT_${who}_EMAIL`]: m[2] as string, [`GIT_${who}_DATE`]: m[3] as string };
}

/**
 * Rewrite the repository's history without `paths`. Refuses a dirty working tree.
 * Run `inspect` first and confirm with the person; this changes the repository for good.
 */
export function rewrite(path: string, options: PurgeOptions = {}): RewriteResult {
  const log = options.log ?? (() => {});
  const plan = inspect(path, options);
  const { repo, bare, paths } = plan;
  if (plan.dirty) throw new PurgeError('The working tree has uncommitted changes; commit or stash them first.');
  const all = rows(repo);
  const scratch = mkdtempSync(join(tmpdir(), 'wirehub-purge-'));
  // a throwaway index and work tree: the plumbing wants a work tree even in a bare repository, and nothing is checked out
  mkdirSync(join(scratch, 'wt'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_WORK_TREE: join(scratch, 'wt') };
  const map = new Map<string, string | undefined>();
  let rewritten = 0;
  let dropped = 0;
  const mapped = (sha: string): string | undefined => (map.has(sha) ? map.get(sha) : sha);
  try {
    for (const [n, row] of all.entries()) {
      const parents = [...new Set(row.parents.map(mapped).filter((p): p is string => p !== undefined))];
      const parentsChanged = parents.length !== row.parents.length || row.parents.some((p, i) => parents[i] !== p);
      const here = holds(repo, row.sha, paths);
      if (here.length === 0 && !parentsChanged) {
        map.set(row.sha, row.sha);
        continue;
      }
      const commit = readCommit(repo, row.sha);
      let tree = commit.tree;
      if (here.length > 0) {
        git(repo, ['read-tree', row.sha], { env });
        git(repo, ['update-index', '--force-remove', '--', ...paths], { env });
        tree = git(repo, ['write-tree'], { env }).trim();
      }
      // a commit that now changes nothing is pruned: its children hang from its parent
      const only = parents.length === 1 ? parents[0] : undefined;
      if (parents.length <= 1 && row.parents.length <= 1) {
        const parentTree = only === undefined ? git(repo, ['hash-object', '-t', 'tree', '/dev/null']).trim() : readCommit(repo, only).tree;
        if (tree === parentTree) {
          map.set(row.sha, only);
          dropped += 1;
          continue;
        }
      }
      const made = git(repo, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])], {
        input: commit.message,
        env: { ...identity(commit.author, 'AUTHOR'), ...identity(commit.committer, 'COMMITTER') },
      }).trim();
      map.set(row.sha, made);
      rewritten += 1;
      if ((n + 1) % 500 === 0) log(`${n + 1} of ${all.length} commits…`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const movedRefs: string[] = [];
  const deletedRefs: string[] = [];
  const refLines = git(repo, ['for-each-ref', '--format=%(refname)\t%(objecttype)\t%(objectname)', 'refs/heads', 'refs/tags']).split('\n').filter((l) => l !== '');
  const head = git(repo, ['symbolic-ref', '-q', 'HEAD']).trim();
  for (const line of refLines) {
    const [ref, type, sha] = line.split('\t') as [string, string, string];
    if (type === 'tag') {
      const target = git(repo, ['rev-parse', `${ref}^{}`]).trim();
      const next = mapped(target);
      if (next === target) continue;
      if (next === undefined) {
        git(repo, ['update-ref', '-d', ref]);
        deletedRefs.push(ref);
        continue;
      }
      // an annotated tag keeps its tagger and message; only the object it names moves
      const raw = git(repo, ['cat-file', 'tag', sha]).replace(/^object [0-9a-f]+$/m, `object ${next}`).replace(/^-----BEGIN [A-Z ]*SIGNATURE-----[\s\S]*$/m, '');
      const made = git(repo, ['mktag'], { input: raw }).trim();
      git(repo, ['update-ref', ref, made, sha]);
      movedRefs.push(ref);
      continue;
    }
    const next = mapped(sha);
    if (next === sha) continue;
    if (next === undefined) {
      if (ref !== head) git(repo, ['update-ref', '-d', ref]);
      deletedRefs.push(ref);
      continue;
    }
    git(repo, ['update-ref', ref, next, sha]);
    movedRefs.push(ref);
  }
  // the old commits stay reachable through remote-tracking refs and the reflog until these go
  for (const line of git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/original']).split('\n').filter((l) => l !== '')) {
    git(repo, ['update-ref', '-d', line]);
    deletedRefs.push(line);
  }
  if (!bare && head === '' && git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).trim() !== '') {
    const next = mapped(git(repo, ['rev-parse', 'HEAD']).trim());
    if (next !== undefined) git(repo, ['update-ref', '--no-deref', 'HEAD', next]);
  }
  if (!bare && git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).trim() !== '') git(repo, ['reset', '--hard', '-q']);
  git(repo, ['reflog', 'expire', '--expire=now', '--all']);
  git(repo, ['gc', '--prune=now', '-q']);

  const remaining = holdsAnywhere(repo, paths);
  return { rewritten, dropped, movedRefs, deletedRefs, remaining };
}

/** The paths still in some commit reachable from any ref (a stash, a linked worktree's branch). */
function holdsAnywhere(repo: string, paths: readonly string[]): string[] {
  const left = new Set<string>();
  for (const sha of git(repo, ['rev-list', '--all']).split('\n').filter((l) => l !== '')) for (const p of holds(repo, sha, paths)) left.add(p);
  return [...left].sort();
}

/** The word the person types to confirm: the repository's folder name. */
export const confirmationWord = (repo: string): string => basename(resolve(repo));
