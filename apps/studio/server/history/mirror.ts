/**
 * The git mirror (cs-5k1.4): an opt-in worker job on the database backend
 * that writes every change set as one git commit — to a local repository
 * (`WIREHUB_GIT_MIRROR_PATH`) or to a remote (`WIREHUB_GIT_MIRROR_URL`) — for
 * hubs that want an off-site, diffable trail beside the database.
 *
 * - **What a commit holds.** The catalog's text files exactly as the export
 *   writes them (`data/…`, `depictions/…`, `GET /api/export`); binary files
 *   (uploads, artwork, photos) are named in `.wirehub-blobs.json` by content
 *   address, not copied.
 * - **Who.** The change set's person is the commit's author (its name and
 *   email; `studio@localhost` for a save with the login off), at the change
 *   set's time; WireHub is the committer. The message is the change set's,
 *   with the trailers `WireHub-Change-Set` and `WireHub-Catalog-Version`.
 * - **How.** The mirror's newest commit says which catalog version it holds.
 *   Each later change set is replayed onto that tree through the same
 *   `commitChangeSet` the database commit applies (`pg/commit.ts`), its
 *   bytes fetched from the blob store — so each commit is the catalog as that
 *   change set left it. A first run, and any change set that cannot be
 *   replayed (one saved before the database kept what replay needs), commit
 *   the catalog at the current version instead and say so; a run that catches
 *   up checks its tree against the export and resyncs the same way if they
 *   ever differ.
 * - **Never force.** A push the remote refuses (someone else's commits on
 *   the branch) fails the job and alerts; nothing is overwritten. Secrets come
 *   from the environment (`*_FILE`): an SSH key, or an HTTPS token handed to
 *   git through `GIT_ASKPASS` — never in a URL, a remote's config or a log.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { isBlobRef, type BlobRef } from '@wirehub/catalog/src/codec/index.ts';
import { sql } from 'kysely';
import type { ModuleRegistry } from '@wirehub/modules';

import { STUDIO_COMMITTER } from '../backup/commit-message.ts';
import { execGit, type GitResult, type GitRunner } from '../backup/git.ts';
import type { BlobStore } from '../blobs.ts';
import type { JobContext, JobOutcome } from '../jobs/types.ts';
import { inOrg, type Db } from '../pg/db.ts';
import { blobObjectKey } from '../pg/keys.ts';
import type { SnapshotCache } from '../pg/snapshot.ts';
import { CatalogTree, treeWorkbenchDeps } from '../pg/tree.ts';
import type { ChangeSet, RecordChange, RecordKind } from '../storage/change-set.ts';
import { commitChangeSet } from '../storage/unit-of-work.ts';

export const BLOB_MANIFEST = '.wirehub-blobs.json';
const VERSION_TRAILER = 'WireHub-Catalog-Version';
const SET_TRAILER = 'WireHub-Change-Set';
/** At most this many change sets per run; the next run carries on. */
const PER_RUN = 500;

export interface GitMirrorConfig {
  /** a remote to push to, or a local repository to commit in */
  target: { url: string } | { path: string };
  branch: string;
  /** the working clone (a remote target), or the repository itself (a path target) */
  dir: string;
  sshKey?: string;
  knownHosts?: string;
  token?: string;
  user: string;
  cron: string;
}

export class GitMirrorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitMirrorConfigError';
  }
}

/** `WIREHUB_GIT_MIRROR_*` → the mirror's configuration; undefined when it is off. */
export function gitMirrorConfigFromEnv(env: Readonly<Record<string, string | undefined>>): GitMirrorConfig | undefined {
  const value = (name: string): string | undefined => {
    const v = env[`WIREHUB_GIT_MIRROR_${name}`]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const url = value('URL');
  const path = value('PATH');
  if (url === undefined && path === undefined) return undefined;
  if (url !== undefined && path !== undefined) throw new GitMirrorConfigError('Set WIREHUB_GIT_MIRROR_URL or WIREHUB_GIT_MIRROR_PATH, not both.');
  if (url !== undefined && /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url)) {
    throw new GitMirrorConfigError('WIREHUB_GIT_MIRROR_URL carries a password; put the token in WIREHUB_GIT_MIRROR_TOKEN_FILE instead.');
  }
  const branch = value('BRANCH') ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch) || branch.includes('..')) throw new GitMirrorConfigError(`WIREHUB_GIT_MIRROR_BRANCH: ${JSON.stringify(branch)} is not a branch name.`);
  const sshKey = env['WIREHUB_GIT_MIRROR_SSH_KEY'];
  const knownHosts = env['WIREHUB_GIT_MIRROR_KNOWN_HOSTS'];
  const token = env['WIREHUB_GIT_MIRROR_TOKEN'];
  return {
    target: url !== undefined ? { url } : { path: path as string },
    branch,
    dir: url !== undefined ? (value('DIR') ?? join(tmpdir(), 'wirehub-git-mirror')) : (path as string),
    ...(sshKey === undefined || sshKey.trim() === '' ? {} : { sshKey: sshKey.endsWith('\n') ? sshKey : `${sshKey}\n` }),
    ...(knownHosts === undefined || knownHosts.trim() === '' ? {} : { knownHosts: knownHosts.endsWith('\n') ? knownHosts : `${knownHosts}\n` }),
    ...(token === undefined || token.trim() === '' ? {} : { token: token.trim() }),
    user: value('USER') ?? 'wirehub',
    cron: value('CRON') ?? '*/5 * * * *',
  };
}

/** Where the mirror goes, for a log line (a URL's credentials are never in it — the config refuses them). */
export function describeMirror(config: GitMirrorConfig): string {
  return 'url' in config.target ? `${config.target.url} (${config.branch})` : `${config.target.path} (${config.branch})`;
}

export interface GitMirrorOptions {
  db: Db;
  orgId: string;
  cache: SnapshotCache;
  blobs?: BlobStore;
  modules?: ModuleRegistry;
  config: GitMirrorConfig;
  git?: GitRunner;
}

interface SetRow {
  id: string;
  version: string;
  at: Date;
  name: string;
  email: string | null;
  message: string;
  method: string | null;
  path: string | null;
  source: string;
}

interface ChangeRow {
  cs: string;
  seq: number;
  kind: string;
  key: string;
  op: 'put' | 'delete' | 'move';
  to_key: string | null;
  after_etag: string | null;
  after_text: string | null;
}

class CannotReplay extends Error {}

/** The catalog files a tree holds: text to write, binary files as blob references for the manifest. */
function splitTree(tree: CatalogTree): { text: Map<string, string>; blobs: Record<string, BlobRef> } {
  const text = new Map<string, string>();
  const blobs: Record<string, BlobRef> = {};
  for (const [path, content] of tree.contents()) {
    if (typeof content === 'string') text.set(path, content);
    else if (isBlobRef(content)) blobs[path] = { blob: content.blob, size: content.size };
  }
  return { text, blobs };
}

const SAFE_PATH = /^(data|depictions)\/[A-Za-z0-9._+\/-]+$/;

/** The catalog's files in the working tree (under `data/` and `depictions/`), relative to `dir`; anything else (a README) is left alone. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  for (const top of ['data', 'depictions']) if (existsSync(join(dir, top))) walk(join(dir, top));
  return out.sort();
}

/** The tree the mirror's working directory holds. */
function readTree(dir: string): CatalogTree {
  const entries: [string, string | BlobRef][] = [];
  for (const path of listFiles(dir)) if (SAFE_PATH.test(path)) entries.push([path, readFileSync(join(dir, path), 'utf8')]);
  const manifest = join(dir, BLOB_MANIFEST);
  if (existsSync(manifest)) {
    for (const [path, ref] of Object.entries(JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, BlobRef>)) if (SAFE_PATH.test(path)) entries.push([path, ref]);
  }
  return new CatalogTree(entries);
}

/** Make the working directory hold exactly `tree` (text files and the blob manifest). */
function writeTree(dir: string, tree: CatalogTree): void {
  const { text, blobs } = splitTree(tree);
  for (const path of listFiles(dir)) if (!text.has(path)) rmSync(join(dir, path), { force: true });
  for (const [path, content] of text) {
    if (!SAFE_PATH.test(path) || path.includes('..')) throw new Error(`refusing to write ${JSON.stringify(path)}`);
    const target = join(dir, path);
    if (existsSync(target) && readFileSync(target, 'utf8') === content) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const sorted = Object.fromEntries(Object.entries(blobs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(dir, BLOB_MANIFEST), `${JSON.stringify(sorted, null, 2)}\n`);
  // directories a removal emptied
  const prune = (at: string): boolean => {
    let empty = true;
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory() && prune(full)) rmSync(full, { recursive: true, force: true });
      else empty = false;
    }
    return empty;
  };
  for (const top of ['data', 'depictions']) if (existsSync(join(dir, top)) && prune(join(dir, top))) rmSync(join(dir, top), { recursive: true, force: true });
}

function sameTree(a: CatalogTree, b: CatalogTree): boolean {
  const x = splitTree(a);
  const y = splitTree(b);
  if (x.text.size !== y.text.size) return false;
  for (const [path, content] of x.text) if (y.text.get(path) !== content) return false;
  return JSON.stringify(Object.entries(x.blobs).sort()) === JSON.stringify(Object.entries(y.blobs).sort());
}

function lastLine(result: GitResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('hint:'));
  return lines[lines.length - 1] ?? `git exited with code ${result.code}`;
}

/** Run the mirror once: everything committed since the last run, one commit per change set, then the push. */
export async function runGitMirrorJob(context: JobContext, options: GitMirrorOptions): Promise<JobOutcome> {
  const { config, db, orgId, cache } = options;
  const git = options.git ?? execGit;
  const dir = config.dir;
  const authDir = `${dir.replace(/\/+$/, '')}.auth`;
  const authEnv: Record<string, string> = {};
  if (config.sshKey !== undefined) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'key'), config.sshKey, { mode: 0o600 });
    const hosts = config.knownHosts === undefined ? ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(authDir, 'known_hosts')}`] : ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(authDir, 'known_hosts')}`];
    if (config.knownHosts !== undefined) writeFileSync(join(authDir, 'known_hosts'), config.knownHosts, { mode: 0o600 });
    authEnv['GIT_SSH_COMMAND'] = ['ssh', '-i', join(authDir, 'key'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', ...hosts].join(' ');
  }
  if (config.token !== undefined) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    // the script reads the token from the environment git is run with: it is never written to disk
    writeFileSync(join(authDir, 'askpass.sh'), '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' "$WIREHUB_GIT_MIRROR_USER" ;;\n  *) printf \'%s\\n\' "$WIREHUB_GIT_MIRROR_TOKEN" ;;\nesac\n', { mode: 0o700 });
    authEnv['GIT_ASKPASS'] = join(authDir, 'askpass.sh');
    authEnv['WIREHUB_GIT_MIRROR_TOKEN'] = config.token;
    authEnv['WIREHUB_GIT_MIRROR_USER'] = config.user;
  }
  const run = (args: readonly string[], env: Record<string, string> = {}): Promise<GitResult> => git(args, { cwd: dir, env: { ...authEnv, ...env } });
  const must = async (args: readonly string[], what: string, env: Record<string, string> = {}): Promise<GitResult> => {
    const out = await run(args, env);
    if (out.code !== 0) throw new Error(`${what}: ${lastLine(out)}`);
    return out;
  };

  // 1. the repository, on the mirror's branch
  mkdirSync(dir, { recursive: true });
  const isRepo = (await run(['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true' && (await run(['rev-parse', '--show-toplevel'])).stdout.trim() !== '' && existsSync(join(dir, '.git'));
  if (!isRepo) {
    if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty and not a git repository; point the mirror at an empty directory or a repository.`);
    await must(['init', '-q', '-b', config.branch], 'git init');
  }
  const remote = 'url' in config.target;
  if (remote) {
    const url = (config.target as { url: string }).url;
    const has = (await run(['remote', 'get-url', 'origin'])).code === 0;
    await must(has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url], 'git remote');
    await must(['fetch', '-q', 'origin'], 'git fetch');
  }
  const head = await run(['symbolic-ref', '--short', 'HEAD']);
  if (head.stdout.trim() !== config.branch) {
    const exists = (await run(['rev-parse', '--verify', '-q', `refs/heads/${config.branch}`])).code === 0;
    const remoteHas = remote && (await run(['rev-parse', '--verify', '-q', `refs/remotes/origin/${config.branch}`])).code === 0;
    if ((await run(['status', '--porcelain'])).stdout.trim() !== '') throw new Error(`The mirror repository has uncommitted changes and is not on ${config.branch}; clean it up first.`);
    await must(exists ? ['checkout', '-q', config.branch] : remoteHas ? ['checkout', '-q', '-b', config.branch, `origin/${config.branch}`] : ['checkout', '-q', '--orphan', config.branch], 'git checkout');
  }
  if (remote && (await run(['rev-parse', '--verify', '-q', `refs/remotes/origin/${config.branch}`])).code === 0) {
    const hasHead = (await run(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    if (!hasHead) await must(['reset', '-q', '--hard', `origin/${config.branch}`], 'git reset (an empty working clone)');
    else if ((await run(['merge-base', '--is-ancestor', `origin/${config.branch}`, 'HEAD'])).code !== 0) {
      // the remote moved on: take it when we have nothing of our own on top, else stop
      if ((await run(['merge-base', '--is-ancestor', 'HEAD', `origin/${config.branch}`])).code === 0) await must(['merge', '-q', '--ff-only', `origin/${config.branch}`], 'git merge --ff-only');
      else throw new Error(`origin/${config.branch} has commits the mirror did not make, and the mirror has commits it lacks. Nothing was pushed; reconcile the branch by hand.`);
    }
  }
  if ((await run(['status', '--porcelain'])).stdout.trim() !== '') throw new Error('The mirror repository has uncommitted changes; commit or discard them there first.');

  // 2. where the mirror is: the newest commit it made (a hand edit on top of the branch is kept, not counted)
  const last = await run(['log', '-1', '--format=%B', '-E', `--grep=^${VERSION_TRAILER}: [0-9]+$`]);
  const mirrored = last.code === 0 ? new RegExp(`^${VERSION_TRAILER}: (\\d+)$`, 'm').exec(last.stdout)?.[1] : undefined;

  const commitAs = async (message: string, author: { name: string; email: string; at: string }): Promise<void> => {
    await must(['add', '-A', '--', '.'], 'git add');
    await must(['commit', '-q', '--allow-empty', '--no-verify', '-m', message], 'git commit', {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: author.at,
      GIT_COMMITTER_NAME: STUDIO_COMMITTER.name,
      GIT_COMMITTER_EMAIL: STUDIO_COMMITTER.email,
    });
  };
  const snapshotCommit = async (why: string): Promise<string> => {
    cache.discard();
    const snapshot = await cache.get();
    writeTree(dir, CatalogTree.fromSnapshot(snapshot));
    await commitAs(`${why}\n\n${VERSION_TRAILER}: ${snapshot.version}`, { name: STUDIO_COMMITTER.name, email: STUDIO_COMMITTER.email, at: new Date().toISOString() });
    return snapshot.version;
  };

  let committed = 0;
  let version = mirrored;
  let resynced: string | undefined;
  if (version === undefined) {
    version = await snapshotCommit('WireHub: the catalog as the mirror found it');
    resynced = 'first run';
    await context.step(`started the mirror at catalog version ${version}`);
  } else {
    // 3. every later change set, replayed onto the tree
    const sets = await inOrg(db, orgId, async (tx) =>
      (
        await sql<SetRow>`
          SELECT s.id::text AS id, s.catalog_version::text AS version, s.created_at AS at, s.actor_label AS name, p.email, s.message, s.method, s.path, s.source
            FROM studio.change_set s LEFT JOIN studio.person p ON p.id = s.actor_id
           WHERE s.catalog_version > ${version}::bigint
           ORDER BY s.catalog_version
           LIMIT ${PER_RUN}`.execute(tx)
      ).rows,
    );
    const tree = readTree(dir);
    for (const set of sets) {
      try {
        const changes = await inOrg(db, orgId, async (tx) =>
          (
            await sql<ChangeRow>`
              SELECT c.change_set_id::text AS cs, c.seq, c.kind, c.key, c.op, c.to_key, c.after_etag, c.after_body::text AS after_text
                FROM studio.change c WHERE c.change_set_id = ${set.id}::bigint AND c.kind NOT IN ('derived', 'blob') ORDER BY c.seq`.execute(tx)
          ).rows,
        );
        await replay(tree, set, changes, options);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        version = await snapshotCommit(`WireHub: the catalog at the current version (change set ${set.id}, version ${set.version}, and those after it up to now could not be replayed one by one: ${reason})`);
        resynced = reason;
        await context.step(`resynced at version ${version}: ${reason}`);
        break;
      }
      writeTree(dir, tree);
      await commitAs(`${set.message}\n\n${SET_TRAILER}: ${set.id}\n${VERSION_TRAILER}: ${set.version}`, {
        name: set.name,
        email: set.email ?? STUDIO_COMMITTER.email,
        at: set.at.toISOString(),
      });
      version = set.version;
      committed += 1;
    }
    // 4. caught up: the tree must be the export, byte for byte
    if (resynced === undefined && sets.length > 0) {
      cache.discard();
      const snapshot = await cache.get();
      if (snapshot.version === version && !sameTree(readTree(dir), CatalogTree.fromSnapshot(snapshot))) {
        version = await snapshotCommit('WireHub: resync — the replayed catalog differed from the database');
        resynced = 'the replay differed from the database';
        await context.step('resynced: the replayed tree differed from the export');
      }
    }
    if (committed > 0) await context.step(`committed ${committed} change set(s), up to catalog version ${version}`);
  }

  // 5. push
  let pushed = false;
  if (remote) {
    const ahead = await run(['rev-list', '--count', `origin/${config.branch}..HEAD`]);
    const remoteHas = (await run(['rev-parse', '--verify', '-q', `refs/remotes/origin/${config.branch}`])).code === 0;
    if (!remoteHas || Number(ahead.stdout.trim()) > 0) {
      await must(['push', '-q', 'origin', `HEAD:refs/heads/${config.branch}`], 'git push');
      pushed = true;
      await context.step(`pushed to ${describeMirror(config)}`);
    }
  }
  return { result: { target: describeMirror(config), version: version ?? null, committed, pushed, ...(resynced === undefined ? {} : { resynced }) } };
}

/** Apply one change set's rows to the tree, as the database commit applied them. */
async function replay(tree: CatalogTree, set: SetRow, rows: readonly ChangeRow[], options: GitMirrorOptions): Promise<void> {
  const changes: RecordChange[] = [];
  for (const r of rows) {
    const change: RecordChange = { kind: r.kind as RecordKind, key: r.key, op: r.op };
    if (r.op === 'move') {
      if (r.to_key === null) throw new CannotReplay(`a move of ${r.kind} ${r.key} names no target`);
      change.to = r.to_key;
    }
    if (r.op === 'put') {
      if (r.after_text !== null) change.value = JSON.parse(r.after_text) as unknown;
      const sha = /^"sha256:([0-9a-f]{64})"$/.exec(r.after_etag ?? '')?.[1];
      if (sha !== undefined) {
        const bytes = options.blobs === undefined ? undefined : await options.blobs.get(blobObjectKey(options.orgId, sha));
        if (bytes === undefined) throw new CannotReplay(`the bytes of ${r.kind} ${r.key} are not in the blob store`);
        change.bytes = new Uint8Array(bytes);
      }
      if (change.value === undefined && change.bytes === undefined) throw new CannotReplay(`${r.kind} ${r.key} was saved before the database kept what a replay needs`);
      if ((r.kind === 'asset' || r.kind === 'drawing-photo') && change.value === undefined) throw new CannotReplay(`${r.kind} ${r.key} was saved before the database kept its details`);
    }
    changes.push(change);
  }
  const deps = treeWorkbenchDeps(tree, { orgId: options.orgId, ...(options.blobs === undefined ? {} : { blobs: options.blobs }), ...(options.modules === undefined ? {} : { modules: options.modules }) });
  const changeSet: ChangeSet = { changes, context: { method: set.method ?? 'POST', path: set.path ?? '/api/git-mirror' } };
  // a set the worker made with nothing but derived records (the derive repair) recomputes them here too
  const extra = changes.length === 0 && set.source === 'worker' ? new Set(['tags'] as const) : new Set<never>();
  await commitChangeSet(deps, changeSet, extra);
}
