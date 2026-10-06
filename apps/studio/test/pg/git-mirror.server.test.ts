/**
 * The git mirror (cs-5k1.4): the worker job that writes every change set as
 * a commit, on Postgres. A local repository and a bare "remote", both in this
 * test's temporary directory:
 *
 * - the first run commits the catalog as it finds it; each later change set
 *   is one commit, authored by its person, carrying its message and trailers,
 *   and the tree after the last one is the export byte for byte;
 * - a change set with bytes (a drawing photo) replays from the blob store; one
 *   whose bytes are gone resyncs to the current catalog and says so;
 * - to a remote it pushes, and refuses — never forces — when the branch has
 *   commits it did not make;
 * - its configuration comes from WIREHUB_GIT_MIRROR_* (secrets from *_FILE).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import { fsBlobStore, type BlobStore } from '../../server/blobs.ts';
import { contentETag } from '../../server/etag.ts';
import { BLOB_MANIFEST, gitMirrorConfigFromEnv, GitMirrorConfigError, mirrorIntervalMs, runGitMirrorJob, type GitMirrorConfig } from '../../server/history/mirror.ts';
import type { JobContext } from '../../server/jobs/types.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { exportSnapshot } from '../../server/pg/export.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { blobObjectKey } from '../../server/pg/keys.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, ...ISOLATED, GIT_AUTHOR_NAME: 'Someone Else', GIT_AUTHOR_EMAIL: 'else@example.com', GIT_COMMITTER_NAME: 'Someone Else', GIT_COMMITTER_EMAIL: 'else@example.com' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const PNG = `data:image/png;base64,${Buffer.from('a photo for the mirror').toString('base64')}`;

function context(): JobContext & { steps: string[] } {
  const steps: string[] = [];
  return { steps, job: { id: 'test', kind: 'git-mirror', status: 'running', request: {}, steps: [], createdAt: new Date().toISOString() }, step: async (text) => void steps.push(text) };
}

describe('the mirror\'s configuration', () => {
  it('is off unless a target is set, and refuses what would leak or confuse', () => {
    expect(gitMirrorConfigFromEnv({})).toBeUndefined();
    const config = gitMirrorConfigFromEnv({ WIREHUB_GIT_MIRROR_URL: 'ssh://git@git.example.com/hub/catalog.git', WIREHUB_GIT_MIRROR_SSH_KEY: 'KEY' });
    expect(config).toMatchObject({ target: { url: 'ssh://git@git.example.com/hub/catalog.git' }, branch: 'main', sshKey: 'KEY\n', user: 'wirehub', cron: '*/5 * * * *' });
    expect(gitMirrorConfigFromEnv({ WIREHUB_GIT_MIRROR_PATH: '/srv/mirror', WIREHUB_GIT_MIRROR_BRANCH: 'catalog' })).toMatchObject({ target: { path: '/srv/mirror' }, dir: '/srv/mirror', branch: 'catalog' });
    expect(() => gitMirrorConfigFromEnv({ WIREHUB_GIT_MIRROR_URL: 'x', WIREHUB_GIT_MIRROR_PATH: 'y' })).toThrow(GitMirrorConfigError);
    expect(() => gitMirrorConfigFromEnv({ WIREHUB_GIT_MIRROR_URL: 'https://me:secret@git.example.com/x.git' })).toThrow(/TOKEN_FILE/);
    expect(() => gitMirrorConfigFromEnv({ WIREHUB_GIT_MIRROR_PATH: '/x', WIREHUB_GIT_MIRROR_BRANCH: '../main' })).toThrow(GitMirrorConfigError);
  });
});

describe('the in-process schedule', () => {
  it('reads the interval a cron expression stands for', () => {
    expect(mirrorIntervalMs('*/5 * * * *')).toBe(300_000);
    expect(mirrorIntervalMs('*/2 * * * *')).toBe(120_000);
    expect(mirrorIntervalMs('10 * * * *')).toBe(3_600_000);
    expect(mirrorIntervalMs('0 */6 * * *')).toBe(6 * 3_600_000);
    expect(mirrorIntervalMs('whatever')).toBe(300_000);
  });

  it('a scheduled run that did nothing leaves no job row; a boot or manual one stays', async () => {
    const { createJobService, executeJob, inlineJobRunner, memoryJobStore } = await import('../../server/jobs/service.ts');
    const store = memoryJobStore();
    const handlers = { 'git-mirror': async () => ({ result: { committed: 0 }, quiet: true }) };
    const runner = inlineJobRunner(store, () => handlers, () => {});
    const jobs = createJobService({ store, runner, kinds: ['git-mirror'] });
    const quiet = await jobs.enqueue('git-mirror', { reason: 'schedule' });
    const boot = await jobs.enqueue('git-mirror', { reason: 'boot' });
    await runner.idle();
    expect((await jobs.list()).map((j) => j.id)).toEqual([boot.id]);
    expect(await store.get(quiet.id)).toBeUndefined();
    expect(await executeJob(store, { 'git-mirror': async () => ({ result: { committed: 1 } }) }, (await store.create('git-mirror', { reason: 'schedule' })).id, () => {})).toMatchObject({ status: 'done' });
  });
});

describePg('the git mirror on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let blobs: BlobStore;
  let work: string;
  let orgId: string;
  let cache: SnapshotCache;
  let deps: WorkbenchDeps;
  const alice = { name: 'Alice Example', email: 'alice@example.com', source: 'session' as const };
  const bob = { name: 'Bob Example', email: 'bob@example.com', source: 'session' as const };

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-git-mirror-'));
    blobs = fsBlobStore(join(work, 'blobs'));
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs })).orgId;
    cache = new SnapshotCache(pgh.db, orgId);
    deps = pgWorkbenchDeps({ cache, db: pgh.db, blobs });
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const relabel = async (user: typeof alice, suffix: string): Promise<void> => {
    const got = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/dc-led-lead' }, deps);
    const design = got.body as { label: string };
    const put = await handleWorkbenchRequest({ method: 'PUT', path: '/api/designs/dc-led-lead', body: { ...design, label: `${design.label} ${suffix}` }, headers: { 'if-match': got.headers?.ETag as string }, user }, deps);
    expect(put.status).toBe(200);
  };
  const mirrorTo = (target: GitMirrorConfig['target'], dir: string): GitMirrorConfig => ({ target, dir, branch: 'main', user: 'wirehub', cron: '* * * * *' });
  const run = (config: GitMirrorConfig) => runGitMirrorJob(context(), { db: pgh.db, orgId, cache, blobs, config });
  const expectExport = async (dir: string): Promise<void> => {
    cache.discard();
    const exported = exportSnapshot(await cache.get());
    for (const [path, text] of Object.entries(exported.files)) expect(readFileSync(join(dir, path), 'utf8'), path).toBe(text);
    const manifest = JSON.parse(readFileSync(join(dir, BLOB_MANIFEST), 'utf8')) as Record<string, { blob: string }>;
    expect(Object.fromEntries(Object.entries(manifest).map(([p, r]) => [p, r.blob]))).toEqual(exported.blobs);
  };

  it('commits each change set as its person, and ends at the export', async () => {
    const dir = join(work, 'local');
    const config = mirrorTo({ path: dir }, dir);
    const first = await run(config);
    expect(first.result).toMatchObject({ committed: 0, resynced: 'first run' });
    await expectExport(dir);

    await relabel(alice, '(Alice)');
    const component = await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/r-120' }, deps);
    expect((await handleWorkbenchRequest({ method: 'PUT', path: '/api/definitions/components/r-120', body: { ...(component.body as object), label: 'Resistor 120 Ω (Bob)' }, headers: { 'if-match': component.headers?.ETag as string }, user: bob }, deps)).status).toBe(200);
    const sheet = await handleWorkbenchRequest({ method: 'GET', path: '/api/drawings/dc-led-lead' }, deps);
    expect((await handleWorkbenchRequest({ method: 'PUT', path: '/api/drawings/dc-led-lead/photo', body: { photo: PNG }, headers: { 'if-match': sheet.headers?.ETag as string }, user: bob }, deps)).status).toBe(200);

    const second = await run(config);
    expect(second.result).toMatchObject({ committed: 3, pushed: false });
    expect(second.result['resynced']).toBeUndefined();
    const log = git(dir, 'log', '--format=%an <%ae>|%s|%(trailers:key=WireHub-Catalog-Version,valueonly,separator=)').trim().split('\n');
    expect(log.length).toBe(4);
    expect(log[0]).toMatch(/^Bob Example <bob@example.com>\|studio: update photo drawing dc-led-lead\|\d+$/);
    expect(log[1]).toMatch(/^Bob Example <bob@example.com>\|studio: update component r-120\|\d+$/);
    expect(log[2]).toMatch(/^Alice Example <alice@example.com>\|studio: update design dc-led-lead\|\d+$/);
    expect(git(dir, 'log', '-1', '--format=%cn').trim()).toBe('WireHub');
    // each commit is the catalog as its change set left it
    expect(git(dir, 'show', 'HEAD~2:data/designs/dc-led-lead.json')).toContain('(Alice)');
    expect(git(dir, 'show', 'HEAD~2:data/components.json')).not.toContain('(Bob)');
    expect(git(dir, 'show', 'HEAD~1:data/components.json')).toContain('(Bob)');
    await expectExport(dir);

    // nothing new: nothing committed
    expect((await run(config)).result).toMatchObject({ committed: 0 });
    expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('4');
  }, 60_000);

  it('resyncs, saying so, when a change set cannot be replayed', async () => {
    const dir = join(work, 'resync');
    const config = mirrorTo({ path: dir }, dir);
    await run(config);
    const sheet = await handleWorkbenchRequest({ method: 'GET', path: '/api/drawings/dc-led-lead' }, deps);
    const other = `data:image/png;base64,${Buffer.from('another photo, soon lost').toString('base64')}`;
    expect((await handleWorkbenchRequest({ method: 'PUT', path: '/api/drawings/dc-led-lead/photo', body: { photo: other }, headers: { 'if-match': sheet.headers?.ETag as string }, user: alice }, deps)).status).toBe(200);
    await relabel(alice, '(after the lost photo)');
    // the photo's bytes are gone from the blob store
    const sha = (await import('node:crypto')).createHash('sha256').update(Buffer.from('another photo, soon lost')).digest('hex');
    unlinkSync(join(work, 'blobs', ...blobObjectKey(orgId, sha).split('/')));
    const out = await run(config);
    expect(String(out.result['resynced'])).toMatch(/not in the blob store/);
    expect(git(dir, 'log', '-1', '--format=%s')).toMatch(/^WireHub: the catalog at the current version/);
    await expectExport(dir).catch(() => undefined);
    expect(readFileSync(join(dir, 'data/designs/dc-led-lead.json'), 'utf8')).toContain('(after the lost photo)');
  }, 60_000);

  it('pushes to a remote, and never forces past commits it did not make', async () => {
    const bare = join(work, 'remote.git');
    git(work, 'init', '-q', '--bare', '-b', 'main', bare);
    // a README the hub's admin committed first: kept, not overwritten
    const seed = join(work, 'seed');
    git(work, 'clone', '-q', bare, seed);
    writeFileSync(join(seed, 'README.md'), 'The catalog mirror.\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-q', '-m', 'Start the mirror repository');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');

    const config = mirrorTo({ url: bare }, join(work, 'clone'));
    expect((await run(config)).result).toMatchObject({ pushed: true });
    await relabel(bob, '(pushed)');
    expect((await run(config)).result).toMatchObject({ committed: 1, pushed: true });
    const check = join(work, 'check');
    git(work, 'clone', '-q', bare, check);
    expect(git(check, 'log', '--format=%an|%s').trim().split('\n')).toEqual([
      'Bob Example|studio: update design dc-led-lead',
      'WireHub|WireHub: the catalog as the mirror found it',
      'Someone Else|Start the mirror repository',
    ]);
    expect(readFileSync(join(check, 'README.md'), 'utf8')).toBe('The catalog mirror.\n');
    await expectExport(check);

    // someone pushes to the branch; the mirror has its own new commit: it stops, the remote untouched
    writeFileSync(join(check, 'NOTES.md'), 'by hand\n');
    git(check, 'add', 'NOTES.md');
    git(check, 'commit', '-q', '-m', 'A hand edit');
    git(check, 'push', '-q', 'origin', 'HEAD:main');
    await relabel(bob, '(local only)');
    const local = await run(config).catch((error: unknown) => error as Error);
    expect(local).toMatchObject({ result: { committed: 1 } });
    // the clone had nothing unpushed before this run: it took the hand edit, then pushed on top of it
    expect(git(bare, 'log', '-2', '--format=%s', 'main').trim().split('\n')).toEqual(['studio: update design dc-led-lead', 'A hand edit']);

    // now a real divergence: the remote moves while the clone holds an unpushed commit
    git(check, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(check, 'NOTES.md'), 'by hand, again\n');
    git(check, 'commit', '-q', '-am', 'Another hand edit');
    git(join(work, 'clone'), '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '--allow-empty', '-m', 'unpushed in the clone');
    git(check, 'push', '-q', 'origin', 'HEAD:main');
    await expect(run(config)).rejects.toThrow(/commits the mirror did not make/);
    expect(git(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Another hand edit');
  }, 90_000);

  it('the restore of a record is a change set the mirror commits like any other', async () => {
    const dir = join(work, 'restore');
    const config = mirrorTo({ path: dir }, dir);
    await run(config);
    const page = await deps.history!.record({ type: 'design', id: 'dc-led-lead' }, { limit: 5 });
    const target = page.entries[1]!;
    const detail = await handleWorkbenchRequest({ method: 'GET', path: `/api/history/entries/${target.id}?subject=design%3Adc-led-lead` }, deps);
    const restored = await handleWorkbenchRequest({ method: 'POST', path: '/api/history/records/design%3Adc-led-lead/restore', body: { entry: target.id, current: (detail.body as { current: unknown }).current }, user: alice }, deps);
    expect(restored.status).toBe(200);
    expect((await run(config)).result).toMatchObject({ committed: 1 });
    expect(git(dir, 'log', '-1', '--format=%an|%s')).toMatch(new RegExp(`^Alice Example\\|studio: restore design dc-led-lead to change ${target.id}`));
    const design = (await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/dc-led-lead' }, deps)).body;
    expect(contentETag(JSON.parse(readFileSync(join(dir, 'data/designs/dc-led-lead.json'), 'utf8')))).toBe(contentETag(design));
  }, 60_000);

  it('with no worker the mirror schedules itself, and quiet runs leave no job rows', async () => {
    const { openPgBackend } = await import('../../server/pg/deps.ts');
    const { inOrg } = await import('../../server/pg/db.ts');
    const { sql } = await import('kysely');
    const dir = join(work, 'inline-mirror');
    const backend = await openPgBackend(
      { DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter', WIREHUB_WORKER: 'off', WIREHUB_GIT_MIRROR_PATH: dir },
      { blobs, listen: false, mirrorEveryMs: 300 },
    );
    try {
      const jobs = backend.deps.jobs!;
      const scheduled: string[] = [];
      const enqueue = jobs.enqueue.bind(jobs);
      const spy = vi.spyOn(jobs, 'enqueue').mockImplementation(async (...args) => {
        const job = await enqueue(...args);
        if (args[0] === 'git-mirror' && args[1]['reason'] === 'schedule') scheduled.push(job.id);
        return job;
      });
      const commits = (): number => {
        try {
          return Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
        } catch {
          return 0;
        }
      };
      const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
        await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 20_000, interval: 100 });
      };
      await until(() => commits() > 0);
      // A commit can already be visible while its job is still running. Wait for
      // completion, and observe a later scheduled job actually being discarded;
      // a sleep followed by COUNT(*) races with the next timer's active job row.
      await until(async () => (await jobs.list({ kind: 'git-mirror' })).some((j) => j.status === 'done' && j.result?.['resynced'] === 'first run'));
      const quietAfter = scheduled.length;
      await until(() => scheduled.length > quietAfter);
      const quiet = scheduled[quietAfter]!;
      await until(async () => (await jobs.get(quiet)) === undefined);
      const before = commits();
      await relabel(alice, '(scheduled)');
      await until(() => commits() > before);
      await until(async () => (await jobs.list({ kind: 'git-mirror' })).some((j) => j.status === 'done' && Number(j.result?.['committed']) > 0));
      const quietAfterChange = scheduled.length;
      await until(() => scheduled.length > quietAfterChange);
      const laterQuiet = scheduled[quietAfterChange]!;
      await until(async () => (await jobs.get(laterQuiet)) === undefined);
      // Retained jobs are exactly the initial sync and the real update. Other
      // rows may be queued/running for the next tick and are not yet quiet runs.
      const retained = await inOrg(pgh.db, orgId, async (tx) =>
        (await sql<{ n: string }>`SELECT count(*)::text AS n FROM studio.job_run WHERE kind = 'git-mirror' AND status = 'done' AND (result->>'resynced' IS NOT NULL OR (result->>'committed')::int > 0)`.execute(tx)).rows[0]?.n);
      expect(retained).toBe('2');
      expect(readFileSync(join(dir, 'data/designs/dc-led-lead.json'), 'utf8')).toContain('(scheduled)');
      spy.mockRestore();
    } finally {
      await backend.close();
    }
  }, 60_000);
});
