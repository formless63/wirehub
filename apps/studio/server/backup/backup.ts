/**
 * Studio backup: every save becomes a git commit by
 * the person who made it, and the commits are pushed to the configured remote so
 * the catalog is never only on this disk.
 *
 * - **One serial queue.** A mutating request's handler runs inside the queue,
 *   and its commit is the next thing the queue does — so a second save cannot
 *   write until the first is committed (exact attribution), and a pull never
 *   runs while a save is writing.
 * - **Only what the request wrote.** The stores report their paths
 *   (`write-journal.ts`); those, and nothing else, are staged and committed
 *   (`git commit -- <paths>`), never `git add -A`.
 * - **Push, debounced.** 20 s after the last commit: `git pull --rebase`, then
 *   `git push <remote> <branch>`. A rebase conflict is aborted (`git rebase
 *   --abort`), pushing stops, commits keep landing locally, and the state is
 *   `blocked` until someone resolves it and presses Retry. Network errors
 *   retry with backoff (`offline`). Never force, never reset, never discard.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { envVar } from '../env.ts';
import type { StudioUser } from '../me.ts';
import { commitAuthor, commitMessage, STUDIO_COMMITTER, type GitIdentity, type SaveRequest } from './commit-message.ts';
import { execGit, type GitResult, type GitRunner } from './git.ts';
import type { BackupCommitInfo, BackupControl, BackupState, BackupStatus } from './status.ts';

export { BACKUP_DISABLED, type BackupCommitInfo, type BackupState, type BackupStatus } from './status.ts';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BackupOptions {
  /** the repository root (the live checkout) */
  repoDir: string;
  remote?: string;
  branch?: string;
  git?: GitRunner;
  /** push this long after the last commit (default 20 s) */
  pushDelayMs?: number;
  /** first network retry delay, doubled per failure up to `retryMaxMs` */
  retryBaseMs?: number;
  retryMaxMs?: number;
  timers?: Timers;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What a finished save hands the queue to commit. */
export interface SaveCommit {
  /** absolute paths the request wrote, moved or removed */
  paths: readonly string[];
  author: GitIdentity;
  message: string;
}

export interface StudioBackup extends BackupControl {
  readonly enabled: true;
  /** the git export answers at once */
  status(): BackupStatus;
  /** pull --rebase (and push anything pending) — run before serving */
  start(): Promise<void>;
  /**
   * Run a mutating request's handler in the queue. `run` reports what it
   * wrote; `commitFor` says what to commit (undefined: nothing, e.g. a 4xx).
   * Resolves with the handler's result as soon as it returns; its commit
   * holds the queue, not the response.
   */
  withSave<T>(run: () => { result: T; paths: string[] } | Promise<{ result: T; paths: string[] }>, commitFor: (result: T) => Omit<SaveCommit, 'paths'> | undefined): Promise<T>;
  /** resolves once everything queued so far has run (tests, shutdown) */
  idle(): Promise<void>;
  /** cancel timers */
  close(): void;
}

const NETWORK = /could not read from remote repository|connection (refused|timed out|reset|closed)|could not resolve host|network is unreachable|no route to host|unable to access|timed out|early eof|remote end hung up|operation timed out|ssh: connect to host/i;
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs|stale info/i;

function lastLine(result: GitResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('hint:'));
  return lines[lines.length - 1] ?? `git exited with code ${result.code}`;
}

/** The request half of a commit: author from the user, message from the route. */
export function saveCommitFor(request: SaveRequest, user: StudioUser | undefined): Omit<SaveCommit, 'paths'> {
  return { author: commitAuthor(user), message: commitMessage(request) };
}

export function createStudioBackup(options: BackupOptions): StudioBackup {
  const repoDir = resolve(options.repoDir);
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'master';
  const git = options.git ?? execGit;
  const pushDelayMs = options.pushDelayMs ?? 20_000;
  const retryBaseMs = options.retryBaseMs ?? 10_000;
  const retryMaxMs = options.retryMaxMs ?? 10 * 60_000;
  const timers = options.timers ?? realTimers;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(`[backup] ${line}`));

  let state: BackupState = 'ok';
  let message = '';
  let blocked = false;
  let lastCommit: BackupCommitInfo | null = null;
  let lastPush: { sha: string; at: string } | null = null;
  let pendingCommits = 0;
  let failures = 0;
  let timer: unknown;
  let nextAttemptAt: Date | null = null;
  let closed = false;

  let tail: Promise<void> = Promise.resolve();
  /** append a task; the queue carries on whatever the task does */
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = tail.then(task).catch((error: unknown) => {
      log(`unexpected: ${(error as Error).message}`);
    });
    tail = next;
    return next;
  };

  const run = (args: readonly string[], env?: Record<string, string>): Promise<GitResult> =>
    git(args, { cwd: repoDir, ...(env === undefined ? {} : { env }) });

  const block = (why: string): void => {
    blocked = true;
    state = 'blocked';
    message = why;
    cancelTimer();
    log(`blocked: ${why}`);
  };

  function cancelTimer(): void {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    nextAttemptAt = null;
  }

  const schedule = (ms: number): void => {
    if (closed || blocked) return;
    cancelTimer();
    nextAttemptAt = new Date(now().getTime() + ms);
    timer = timers.set(() => {
      timer = undefined;
      nextAttemptAt = null;
      void enqueue(sync);
    }, ms);
  };

  const scheduleRetry = (why: string): void => {
    failures += 1;
    state = 'offline';
    message = why;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1));
    log(`offline (${why}); retry in ${Math.round(delay / 1000)} s`);
    schedule(delay);
  };

  const countPending = async (): Promise<void> => {
    const out = await run(['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`]);
    if (out.code === 0) pendingCommits = Number(out.stdout.trim()) || 0;
  };

  const rebaseInProgress = async (): Promise<boolean> => {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const out = await run(['rev-parse', '--git-path', name]);
      if (out.code === 0 && existsSync(resolve(repoDir, out.stdout.trim()))) return true;
    }
    return false;
  };

  /** pull --rebase, then push what is pending. Never forces, resets or discards. */
  async function sync(): Promise<void> {
    if (blocked || closed) return;
    state = 'pushing';
    message = '';

    if (await rebaseInProgress()) {
      block('A rebase is in progress in the live checkout. Finish or abort it there (git rebase --continue / --abort), then Retry.');
      return;
    }
    const head = await run(['symbolic-ref', '--short', 'HEAD']);
    if (head.code !== 0 || head.stdout.trim() !== branch) {
      block(`The live checkout is on '${head.stdout.trim() || 'a detached HEAD'}', not '${branch}'. Check out ${branch} there, then Retry.`);
      return;
    }
    const dirty = await run(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.code === 0 && dirty.stdout.trim() !== '') {
      const files = dirty.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => l.slice(3)).slice(0, 5).join(', ');
      block(`Uncommitted changes in the live checkout (${files}). Commit or restore them there, then Retry.`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // a rebase rewrites our commits, so git needs a committer identity even on a host with no git config
      const pull = await run(['pull', '--rebase', '--no-autostash', remote, branch], {
        GIT_COMMITTER_NAME: STUDIO_COMMITTER.name,
        GIT_COMMITTER_EMAIL: STUDIO_COMMITTER.email,
      });
      if (pull.code !== 0) {
        if (await rebaseInProgress()) {
          const conflicted = await run(['diff', '--name-only', '--diff-filter=U']);
          const files = conflicted.stdout.trim().split('\n').filter((f) => f !== '').join(', ');
          const abort = await run(['rebase', '--abort']);
          const aborted = abort.code === 0 ? 'The rebase was aborted; local commits are kept.' : `git rebase --abort failed too: ${lastLine(abort)}.`;
          block(`${remote}/${branch} has changes that conflict with studio saves${files === '' ? '' : ` (${files})`}. ${aborted} Resolve in the live checkout, then Retry.`);
          return;
        }
        const why = lastLine(pull);
        if (NETWORK.test(`${pull.stderr}${pull.stdout}`) || pull.code === -1) scheduleRetry(`pull failed: ${why}`);
        else block(`git pull --rebase failed: ${why}`);
        return;
      }
      await countPending();
      if (pendingCommits === 0) break;
      const push = await run(['push', remote, branch]);
      if (push.code === 0) break;
      const why = lastLine(push);
      if (REJECTED.test(push.stderr) && attempt < 3) continue; // the remote moved on: pull again
      if (NETWORK.test(`${push.stderr}${push.stdout}`) || push.code === -1 || REJECTED.test(push.stderr)) scheduleRetry(`push failed: ${why}`);
      else block(`git push failed: ${why}`);
      return;
    }

    await countPending();
    const sha = await run(['rev-parse', 'HEAD']);
    lastPush = { sha: sha.stdout.trim(), at: now().toISOString() };
    failures = 0;
    state = 'ok';
    message = '';
  }

  /** Stage exactly `paths` and commit them — nothing else in the index goes with them. */
  async function commit(save: SaveCommit): Promise<void> {
    const inRepo = [
      ...new Set(
        save.paths
          .map((p) => relative(repoDir, resolve(p)))
          .filter((p) => p !== '' && !p.startsWith('..') && !isAbsolute(p))
          .map((p) => p.split('\\').join('/')),
      ),
    ].sort();
    if (inRepo.length === 0) return;

    // gitignored paths are not catalog truth (and `git add` refuses them)
    const ignored = await run(['check-ignore', '--', ...inRepo]);
    const skip = new Set(ignored.code === 0 ? ignored.stdout.split('\n').map((l) => l.trim()) : []);
    const paths = inRepo.filter((p) => !skip.has(p));
    if (paths.length === 0) return;

    const present = paths.filter((p) => existsSync(resolve(repoDir, p)));
    const gone = paths.filter((p) => !existsSync(resolve(repoDir, p)));
    if (present.length > 0) {
      const add = await run(['add', '-A', '--', ...present]);
      if (add.code !== 0) return failCommit(`git add failed: ${lastLine(add)}`);
    }
    if (gone.length > 0) {
      const rm = await run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...gone]);
      if (rm.code !== 0) return failCommit(`git rm failed: ${lastLine(rm)}`);
    }
    const staged = await run(['diff', '--cached', '--name-only', '--no-renames', '--', ...paths]);
    const changed = staged.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (changed.length === 0) return; // the save rewrote identical bytes

    const env = {
      GIT_AUTHOR_NAME: save.author.name,
      GIT_AUTHOR_EMAIL: save.author.email,
      GIT_COMMITTER_NAME: STUDIO_COMMITTER.name,
      GIT_COMMITTER_EMAIL: STUDIO_COMMITTER.email,
    };
    const done = await run(['commit', '-q', '--no-verify', '-m', save.message, '--', ...changed], env);
    if (done.code !== 0) return failCommit(`git commit failed: ${lastLine(done)}`);
    const sha = await run(['rev-parse', 'HEAD']);
    lastCommit = {
      sha: sha.stdout.trim(),
      at: now().toISOString(),
      author: `${save.author.name} <${save.author.email}>`,
      subject: save.message.split('\n')[0] ?? '',
    };
    pendingCommits += 1;
    log(`committed ${lastCommit.sha.slice(0, 8)} ${lastCommit.subject} (${changed.length} file${changed.length === 1 ? '' : 's'}, ${lastCommit.author})`);
    if (!blocked) {
      if (state === 'ok') message = '';
      schedule(pushDelayMs);
    }
  }

  function failCommit(why: string): void {
    block(`${why}. The save is on disk but not committed.`);
  }

  return {
    enabled: true,
    status: () => ({
      enabled: true,
      state,
      message,
      lastCommit,
      lastPush,
      pendingCommits,
      remote,
      branch,
      nextAttemptAt: nextAttemptAt === null ? null : nextAttemptAt.toISOString(),
    }),
    start: () => enqueue(sync),
    withSave<T>(runSave: () => { result: T; paths: string[] } | Promise<{ result: T; paths: string[] }>, commitFor: (result: T) => Omit<SaveCommit, 'paths'> | undefined): Promise<T> {
      return new Promise<T>((resolveResult, rejectResult) => {
        void enqueue(async () => {
          let out: { result: T; paths: string[] };
          try {
            out = await runSave();
          } catch (error) {
            rejectResult(error);
            return;
          }
          resolveResult(out.result);
          const what = commitFor(out.result);
          if (what !== undefined && out.paths.length > 0) await commit({ ...what, paths: out.paths });
        });
      });
    },
    retry() {
      if (closed) return;
      blocked = false;
      failures = 0;
      cancelTimer();
      state = 'pushing';
      message = '';
      void enqueue(sync);
    },
    idle: async () => {
      // tasks may enqueue more tasks; wait until the tail stops moving
      let seen: Promise<void> | undefined;
      while (seen !== tail) {
        seen = tail;
        await seen;
      }
    },
    close() {
      closed = true;
      cancelTimer();
    },
  };
}

/** `WIREHUB_GIT_AUTOCOMMIT=true` → a backup for `repoDir`; anything else → undefined. */
export function studioBackupFromEnv(env: Readonly<Record<string, string | undefined>>, repoDir: string): StudioBackup | undefined {
  if (envVar('GIT_AUTOCOMMIT', env)?.trim().toLowerCase() !== 'true') return undefined;
  const remote = envVar('GIT_REMOTE', env)?.trim() || 'origin';
  const branch = envVar('GIT_BRANCH', env)?.trim() || 'master';
  return createStudioBackup({ repoDir, remote, branch });
}
