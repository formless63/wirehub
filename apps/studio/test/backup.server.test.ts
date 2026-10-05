/**
 * Studio backup: every save a commit by its author,
 * pushed on a debounce, blocked (never forced) on a conflict.
 *
 * Runs real git against a throwaway bare repo plus clones, all inside this
 * test's own temp dir — never the real remote. Timers are manual, so the
 * 20 s debounce and the backoff are asserted, not waited for.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDb, loadDesign } from '@wirehub/catalog';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { writeFileAtomic } from '../server/atomic-write.ts';
import { createStudioBackup, saveCommitFor, type StudioBackup, type Timers } from '../server/backup/backup.ts';
import { commitAuthor, commitMessage, describeSave, LOCAL_AUTHOR } from '../server/backup/commit-message.ts';
import { execGit, type GitRunner } from '../server/backup/git.ts';
import { BACKUP_DISABLED } from '../server/backup/status.ts';
import type { DesignStore } from '../server/designs.ts';
import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { collectWrites, recordWrite } from '../server/write-journal.ts';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// user.useConfigOnly: like a fresh CI runner or server, git may not guess an identity from the hostname
const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' };
const SETUP_ID = {
  ...ISOLATED,
  GIT_AUTHOR_NAME: 'Setup',
  GIT_AUTHOR_EMAIL: 'setup@test',
  GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 'setup@test',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, ...SETUP_ID },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** every git argv the backup ran, across the whole file */
const allCalls: string[][] = [];
const recording: GitRunner = (args, call) => {
  allCalls.push([...args]);
  return execGit(args, { ...call, env: { ...ISOLATED, ...(call.env ?? {}) } });
};

class ManualTimers implements Timers {
  pending: { fn: () => void; ms: number; id: number }[] = [];
  private next = 0;
  set(fn: () => void, ms: number): unknown {
    const id = (this.next += 1);
    this.pending.push({ fn, ms, id });
    return id;
  }
  clear(handle: unknown): void {
    this.pending = this.pending.filter((t) => t.id !== handle);
  }
  fire(): void {
    const all = this.pending;
    this.pending = [];
    for (const t of all) t.fn();
  }
}

let root: string;
let remote: string;
let live: string;
let timers: ManualTimers;
let backup: StudioBackup;

function makeBackup(): StudioBackup {
  return createStudioBackup({ repoDir: live, remote: 'origin', branch: 'master', git: recording, timers, log: () => undefined, retryBaseMs: 10_000 });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'studio-backup-test-'));
  remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  live = join(root, 'live');
  git(root, 'init', '-q', '--bare', '-b', 'master', remote);
  git(root, 'init', '-q', '-b', 'master', seed);
  mkdirSync(join(seed, 'data'), { recursive: true });
  writeFileSync(join(seed, 'data', 'a.json'), '{"a":1}\n');
  writeFileSync(join(seed, 'data', 'b.json'), '{"b":1}\n');
  writeFileSync(join(seed, '.gitignore'), 'data/auth/\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'master');
  git(root, 'clone', '-q', remote, live);
  timers = new ManualTimers();
  backup = makeBackup();
});

afterEach(async () => {
  backup.close();
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  // the whole file: nothing ever forced, reset or discarded
  expect(allCalls.length).toBeGreaterThan(0);
  for (const args of allCalls) {
    expect(args).not.toContain('--force');
    expect(args).not.toContain('-f');
    expect(args.some((a) => a.startsWith('--force'))).toBe(false);
    expect(args.some((a) => a.startsWith('+'))).toBe(false);
    expect(args[0]).not.toBe('reset');
    expect(args[0]).not.toBe('clean');
    expect(args[0]).not.toBe('checkout');
  }
});

/** A save that writes `files` (relative to the live checkout) through the stores' own writer. */
function save(files: Record<string, string | null>, request = { method: 'PUT', path: '/api/designs/a' }, user?: Parameters<typeof commitAuthor>[0]): Promise<{ status: number }> {
  return backup.withSave(
    () =>
      collectWrites(() => {
        for (const [rel, text] of Object.entries(files)) {
          const path = join(live, rel);
          if (text === null) {
            unlinkSync(path);
            recordWrite(path);
          } else {
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileAtomic(path, text);
          }
        }
        return { status: 200 };
      }),
    (response) => (response.status < 400 ? saveCommitFor(request, user) : undefined),
  );
}

const log = (repo: string, format: string, ref = 'HEAD'): string[] => git(repo, 'log', `--format=${format}`, ref).trim().split('\n');

/* ------------------------------------------------------------------ *
 * Commit messages and authors
 * ------------------------------------------------------------------ */

describe('commit message and author', () => {
  it('names the action, the record kind and the id', async () => {
    expect(describeSave({ method: 'PUT', path: '/api/designs/dc-led-lead' })).toBe('update design dc-led-lead');
    expect(describeSave({ method: 'DELETE', path: '/api/designs/x' })).toBe('delete design x');
    expect(describeSave({ method: 'POST', path: '/api/designs', body: { id: 'new-cable' } })).toBe('create design new-cable');
    expect(describeSave({ method: 'POST', path: '/api/designs/a/rename', body: { newId: 'b' } })).toBe('rename design a → b');
    expect(describeSave({ method: 'PUT', path: '/api/definitions/connectors/din-8' })).toBe('update connector din-8');
    expect(describeSave({ method: 'POST', path: '/api/definitions/pcbas', body: { id: 'board-1' } })).toBe('create pcba board-1');
    expect(describeSave({ method: 'POST', path: '/api/designs/a/versions', body: { note: 'first release' } })).toBe('save version a');
    expect(describeSave({ method: 'POST', path: '/api/designs/a/versions/2/unlock', body: { reason: 'fix' } })).toBe('unlock version a rev 2');
  });

  it('carries the version note and the request trailer', async () => {
    expect(commitMessage({ method: 'POST', path: '/api/designs/a/versions', body: { note: 'first\nrelease' } })).toBe(
      'studio: save version a\n\nfirst release\n\nStudio-Request: POST /api/designs/a/versions',
    );
    // a vocab entry's `note` is data, not a version note
    expect(commitMessage({ method: 'POST', path: '/api/vocab/brands?x=1', body: { note: 'n', label: 'L' } })).toBe(
      'studio: create vocab brands\n\nStudio-Request: POST /api/vocab/brands',
    );
  });

  it('lists what a design save changed between the subject and the trailer', async () => {
    expect(
      commitMessage({
        method: 'PUT',
        path: '/api/designs/de9-crossover',
        changes: ['~ moved w1:pair-1.a@b from j2:2 to j2:3 (note was: "old\nnote")', '− joint j1:7 — j1:8'],
      }),
    ).toBe(
      'studio: update design de9-crossover\n\n~ moved w1:pair-1.a@b from j2:2 to j2:3 (note was: "old note")\n− joint j1:7 — j1:8\n\nStudio-Request: PUT /api/designs/de9-crossover',
    );
    const many = Array.from({ length: 45 }, (_, i) => `+ joint j1:${i} — w1:x@b`);
    const text = commitMessage({ method: 'PUT', path: '/api/designs/a', changes: many });
    expect(text).toContain('… and 5 more');
    expect(text.split('\n').filter((line) => line.startsWith('+ joint'))).toHaveLength(40);
  });

  it('authors as the signed-in person, else the fixed local identity', async () => {
    expect(commitAuthor({ name: 'Alex', email: 'alex@example.com', source: 'session' })).toEqual({ name: 'Alex', email: 'alex@example.com' });
    expect(commitAuthor(undefined)).toEqual(LOCAL_AUTHOR);
    expect(commitAuthor({ name: 'local-user', source: 'local' })).toEqual({ name: 'WireHub (local)', email: 'studio@localhost' });
  });
});

/* ------------------------------------------------------------------ *
 * The commit queue
 * ------------------------------------------------------------------ */

describe('auto-commit', () => {
  it('commits exactly the files the request wrote, as its author, committed by the studio', async () => {
    writeFileSync(join(live, 'data', 'b.json'), '{"b":"hand edit"}\n'); // someone else's change: not ours
    await save({ 'data/a.json': '{"a":2}\n' }, { method: 'PUT', path: '/api/designs/a' }, { name: 'Alex', email: 'alex@example.com', source: 'session' });
    await backup.idle();

    expect(git(live, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('data/a.json');
    expect(log(live, '%an <%ae>|%cn <%ce>')[0]).toBe('Alex <alex@example.com>|WireHub <studio@localhost>');
    expect(log(live, '%B')[0]).toBe('studio: update design a');
    expect(git(live, 'log', '-1', '--format=%B').trim()).toBe('studio: update design a\n\nStudio-Request: PUT /api/designs/a');
    // the hand edit is neither committed nor staged
    expect(git(live, 'status', '--porcelain')).toBe(' M data/b.json\n');
    expect(backup.status()).toMatchObject({ enabled: true, pendingCommits: 1, lastCommit: { author: 'Alex <alex@example.com>' } });
  });

  it('with the login off, commits as WireHub (local)', async () => {
    await save({ 'data/a.json': '{"a":3}\n' });
    await backup.idle();
    expect(log(live, '%an <%ae>')[0]).toBe('WireHub (local) <studio@localhost>');
  });

  it('commits new files and removals, and skips gitignored ones', async () => {
    await save({ 'data/new.json': '{}\n', 'data/b.json': null, 'data/auth/saves.jsonl': 'x\n' }, { method: 'POST', path: '/api/designs' });
    await backup.idle();
    expect(git(live, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['A\tdata/new.json', 'D\tdata/b.json']);
    expect(git(live, 'status', '--porcelain')).toBe('');
  });

  it('makes no commit for a save that rewrote identical bytes, or a refused one', async () => {
    await save({ 'data/a.json': '{"a":1}\n' });
    await backup.withSave(
      () => collectWrites(() => ({ status: 409 })),
      (response) => (response.status < 400 ? saveCommitFor({ method: 'PUT', path: '/api/designs/a' }, undefined) : undefined),
    );
    await backup.idle();
    expect(log(live, '%s')).toEqual(['seed']);
    expect(timers.pending).toHaveLength(0);
  });

  it('runs saves one at a time: each commit holds exactly its own save', async () => {
    const alex = { name: 'Alex', email: 'alex@example.com', source: 'session' as const };
    const will = { name: 'Will', email: 'will@example.com', source: 'session' as const };
    // fired together, both writing the same file
    await Promise.all([
      save({ 'data/a.json': '{"a":"alex"}\n' }, { method: 'PUT', path: '/api/designs/a' }, alex),
      save({ 'data/a.json': '{"a":"will"}\n' }, { method: 'PUT', path: '/api/designs/a' }, will),
    ]);
    await backup.idle();
    expect(log(live, '%an')).toEqual(['Will', 'Alex', 'Setup']);
    expect(git(live, 'show', 'HEAD~1:data/a.json')).toBe('{"a":"alex"}\n');
    expect(git(live, 'show', 'HEAD:data/a.json')).toBe('{"a":"will"}\n');
  });

  it('keeps files other than the save staged or not exactly as they were', async () => {
    writeFileSync(join(live, 'data', 'b.json'), '{"b":"staged by hand"}\n');
    git(live, 'add', 'data/b.json');
    await save({ 'data/a.json': '{"a":4}\n' });
    await backup.idle();
    expect(git(live, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('data/a.json');
    expect(git(live, 'status', '--porcelain')).toBe('M  data/b.json\n');
  });
});

/* ------------------------------------------------------------------ *
 * Push: debounce, conflict, offline
 * ------------------------------------------------------------------ */

describe('push', () => {
  it('pushes once, 20 s after the last commit', async () => {
    await save({ 'data/a.json': '{"a":5}\n' });
    await backup.idle();
    expect(timers.pending.map((t) => t.ms)).toEqual([20_000]);
    await save({ 'data/a.json': '{"a":6}\n' });
    await backup.idle();
    // the second commit restarted the wait: still one timer
    expect(timers.pending.map((t) => t.ms)).toEqual([20_000]);
    expect(allCalls.some((a) => a[0] === 'push')).toBe(false);
    expect(backup.status().pendingCommits).toBe(2);

    const pushesBefore = allCalls.filter((a) => a[0] === 'push').length;
    timers.fire();
    await backup.idle();
    expect(allCalls.filter((a) => a[0] === 'push')).toHaveLength(pushesBefore + 1);
    expect(allCalls.filter((a) => a[0] === 'push').at(-1)).toEqual(['push', 'origin', 'master']);
    expect(git(remote, 'rev-parse', 'master').trim()).toBe(git(live, 'rev-parse', 'HEAD').trim());
    expect(backup.status()).toMatchObject({ state: 'ok', pendingCommits: 0, lastPush: { sha: git(live, 'rev-parse', 'HEAD').trim() } });
  });

  it('pulls --rebase first, so others’ pushes are kept', async () => {
    const other = join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    writeFileSync(join(other, 'data', 'b.json'), '{"b":"other"}\n');
    git(other, 'commit', '-q', '-am', 'other change');
    git(other, 'push', '-q', 'origin', 'master');

    await save({ 'data/a.json': '{"a":7}\n' });
    await backup.idle();
    timers.fire();
    await backup.idle();
    expect(log(remote, '%s', 'master')).toEqual(['studio: update design a', 'other change', 'seed']);
    expect(backup.status().state).toBe('ok');
  });

  it('on a rebase conflict: aborts, stops pushing, keeps committing locally, says blocked', async () => {
    const other = join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    writeFileSync(join(other, 'data', 'a.json'), '{"a":"theirs"}\n');
    git(other, 'commit', '-q', '-am', 'their edit');
    git(other, 'push', '-q', 'origin', 'master');
    const remoteHead = git(remote, 'rev-parse', 'master').trim();

    await save({ 'data/a.json': '{"a":"ours"}\n' });
    await backup.idle();
    timers.fire();
    await backup.idle();

    const status = backup.status();
    expect(status.state).toBe('blocked');
    expect(status.message).toContain('conflict');
    expect(status.message).toContain('data/a.json');
    // aborted: no rebase left half-done, our commit and file intact, the remote untouched
    expect(existsSync(join(live, '.git', 'rebase-merge'))).toBe(false);
    expect(log(live, '%s')[0]).toBe('studio: update design a');
    expect(readFileSync(join(live, 'data', 'a.json'), 'utf8')).toBe('{"a":"ours"}\n');
    expect(git(remote, 'rev-parse', 'master').trim()).toBe(remoteHead);
    expect(timers.pending).toHaveLength(0);

    // later saves still commit, but nothing is scheduled to push
    await save({ 'data/b.json': '{"b":"later"}\n' });
    await backup.idle();
    expect(log(live, '%s')[0]).toBe('studio: update design a');
    expect(backup.status()).toMatchObject({ state: 'blocked', pendingCommits: 2 });
    expect(timers.pending).toHaveLength(0);
    expect(git(remote, 'rev-parse', 'master').trim()).toBe(remoteHead);
  });

  it('on a network error: offline, retried with backoff', async () => {
    git(live, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'));
    await save({ 'data/a.json': '{"a":8}\n' });
    await backup.idle();
    timers.fire();
    await backup.idle();
    expect(backup.status().state).toBe('offline');
    expect(backup.status().nextAttemptAt).not.toBeNull();
    expect(timers.pending.map((t) => t.ms)).toEqual([10_000]);
    timers.fire();
    await backup.idle();
    expect(timers.pending.map((t) => t.ms)).toEqual([20_000]);

    // the network comes back
    git(live, 'remote', 'set-url', 'origin', remote);
    timers.fire();
    await backup.idle();
    expect(backup.status()).toMatchObject({ state: 'ok', pendingCommits: 0 });
  });

  it('start() pulls before serving and pushes what an earlier run left', async () => {
    writeFileSync(join(live, 'data', 'a.json'), '{"a":"left over"}\n');
    git(live, 'commit', '-q', '-am', 'from an earlier run');
    await backup.start();
    expect(git(remote, 'rev-parse', 'master').trim()).toBe(git(live, 'rev-parse', 'HEAD').trim());
    expect(backup.status()).toMatchObject({ state: 'ok', pendingCommits: 0 });
  });

  it('refuses to pull over uncommitted changes and says so', async () => {
    writeFileSync(join(live, 'data', 'b.json'), '{"b":"dirty"}\n');
    await backup.start();
    expect(backup.status().state).toBe('blocked');
    expect(backup.status().message).toContain('data/b.json');
    expect(readFileSync(join(live, 'data', 'b.json'), 'utf8')).toBe('{"b":"dirty"}\n');
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/backup, and the Hono host end to end
 * ------------------------------------------------------------------ */

describe('/api/backup', () => {
  const base: WorkbenchDeps = { designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined }, loadDb: () => ({}) as never };

  it('answers "off" without a backup', async () => {
    const response = await handleWorkbenchRequest({ method: 'GET', path: '/api/backup' }, base);
    expect(response).toEqual({ status: 200, body: BACKUP_DISABLED });
  });

  it('answers the live status, every field', async () => {
    await save({ 'data/a.json': '{"a":9}\n' });
    await backup.idle();
    const response = await handleWorkbenchRequest({ method: 'GET', path: '/api/backup' }, { ...base, backup });
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['branch', 'enabled', 'lastCommit', 'lastPush', 'message', 'nextAttemptAt', 'pendingCommits', 'remote', 'state']);
    expect(body).toMatchObject({ enabled: true, state: 'ok', pendingCommits: 1, remote: 'origin', branch: 'master', lastPush: null });
    expect(body.lastCommit).toMatchObject({ subject: 'studio: update design a', author: 'WireHub (local) <studio@localhost>' });
    expect(typeof body.nextAttemptAt).toBe('string');
  });

  it('a PUT through the Hono host commits the design file it wrote', async () => {
    const designFile = (id: string): string => join(live, 'data', 'designs', `${id}.json`);
    const real = loadDesign('de9-terminal-board');
    const designs: DesignStore = {
      list: () => [],
      has: (id) => id === real.id || existsSync(designFile(id)),
      read: (id) => (existsSync(designFile(id)) ? JSON.parse(readFileSync(designFile(id), 'utf8')) : id === real.id ? structuredClone(real) : undefined),
      write: (id, design) => {
        mkdirSync(join(live, 'data', 'designs'), { recursive: true });
        writeFileAtomic(designFile(id), `${JSON.stringify(design, null, 2)}\n`);
        return { changed: true };
      },
      remove: () => undefined,
    };
    const app = new Hono();
    const db = loadDb();
    mountWorkbenchApi(
      app,
      { ...base, designs, loadDb: () => db, backup },
      { store: { listDefIds: () => [], readMeta: () => undefined, writeMeta: () => undefined, readAsset: () => undefined, writeAsset: () => undefined, dirFor: () => undefined }, loadDb: () => db },
      backup,
    );
    // a request that fails writes nothing and commits nothing
    const refused = await app.request('/api/designs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(400);
    await backup.idle();
    expect(log(live, '%s')).toEqual(['seed']);

    const put = await app.request(`/api/designs/${real.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '*' },
      body: JSON.stringify({ ...real, label: 'Relabelled' }),
    });
    expect(put.status).toBe(200);
    await backup.idle();
    expect(log(live, '%s|%an')[0]).toBe(`studio: update design ${real.id}|WireHub (local)`);
    expect(git(live, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(`data/designs/${real.id}.json`);

    const status = await app.request('/api/backup');
    expect(((await status.json()) as { enabled: boolean }).enabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Hygiene: generated files only commit when they change (review concern 9)
 * ------------------------------------------------------------------ */

describe('generated tag files', () => {
  it('a regenerate that changes nothing reports no writes, so a save commits none of them', async () => {
    const { fileTagStore } = await import('../server/vocab-store.ts');
    const { result, paths } = collectWrites(() => fileTagStore().regenerate());
    expect(result).toBe(false);
    expect(paths).toEqual([]);
  });
});

describe('the indicator on the database backend', () => {
  it('says Saved, with the last change set', async () => {
    const { backupLabel } = await import('../src/backup.browser.ts');
    const now = new Date('2026-10-05T12:10:00Z');
    const base = { enabled: true, state: 'database' as const, message: '', lastCommit: null, lastPush: null, pendingCommits: 0, remote: '', branch: '', nextAttemptAt: null };
    expect(backupLabel({ ...base, lastChangeSet: null }, now)).toEqual({ text: 'Saved', tone: 'ok' });
    expect(backupLabel({ ...base, lastChangeSet: { version: '7', at: '2026-10-05T12:00:00Z', by: 'Ada' } }, now)).toEqual({ text: 'Saved 10 min ago', tone: 'ok' });
  });
});
