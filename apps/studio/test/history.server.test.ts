/**
 * Change history on the file backend (cs-5k1.4): the real file stores over a
 * temporary copy of the starter catalog in its own git repository
 * (`WIREHUB_CATALOG_DIR`), each save committed as the git export would —
 * by the person who saved, with the studio's message. The same scripted
 * session runs on Postgres (`pg/history.server.test.ts`).
 *
 * Also: the pure pieces — the field diff, the timeline, the restore's commit
 * message, the lock a restore takes — and a catalog outside git, which keeps
 * no history and says so.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { commitAuthor, commitMessage, describeSave } from '../server/backup/commit-message.ts';
import { stateAfter, stepsByChangeSet, type PartRow } from '../server/history/timeline.ts';
import { fieldDiff } from '../src/history/diff.ts';
import { known, parseSubject, UNKNOWN } from '../src/history/types.ts';
import { recordsOfWrite } from '../src/locks/records.ts';
import type { ApiRequest } from '../server/api.ts';
import type { StudioUser } from '../server/me.ts';
import { historyScenario, photoScenario, renameAndListScenario } from './history-scenario.ts';

const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const work = mkdtempSync(join(tmpdir(), 'wirehub-history-files-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
const git = (cwd: string, args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...process.env, ...ISOLATED, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const as = (name: string, email: string): Record<string, string> => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'WireHub', GIT_COMMITTER_EMAIL: 'studio@localhost' });
git(work, ['init', '-q', '-b', 'main']);
git(work, ['add', '-A']);
git(work, ['commit', '-q', '-m', 'The starter catalog'], as('Setup', 'setup@example.com'));
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

describe('change history on the file backend (git)', () => {
  it('lists, diffs, filters and restores through the git log', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const deps = defaultWorkbenchDeps();
    const caps = await deps.history!.capabilities();
    expect(caps.backend).toBe('git');
    const backend = {
      deps,
      // the git export's commit: exactly as the backup would make it, by the person who saved
      afterSave: (user: StudioUser, _response: unknown, request: ApiRequest) => {
        const author = commitAuthor(user);
        git(work, ['add', '-A']);
        git(work, ['commit', '-q', '--allow-empty', '-m', commitMessage({ method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: request.body }) })], as(author.name, author.email));
      },
    };
    await historyScenario(backend);
    const last = git(work, ['log', '-1', '--format=%s']).trim();
    await photoScenario(backend);
    await renameAndListScenario(backend);
    // history was never rewritten: every commit is still there, the restores on top
    const subjects = git(work, ['log', '--format=%an %s']).trim().split('\n');
    expect(last).toMatch(/^studio: restore component r-120 to change [0-9a-f]{12}$/);
    expect(subjects[0]).toMatch(/^Carol Example studio: restore list families to change [0-9a-f]{12}$/);
    expect(subjects[subjects.length - 1]).toBe('Setup The starter catalog');
  }, 60_000);

  it('a legacy per-design photo file comes back from git history (cs-7xb)', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const deps = defaultWorkbenchDeps();
    const id = 'dc-y-splitter';
    const subject = `design:${id}`;
    const user: StudioUser = { name: 'Dana Example', email: 'dana@example.com', source: 'session' };
    const commit = (message: string): string => {
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '--allow-empty', '-m', message], as(user.name, 'dana@example.com'));
      return git(work, ['rev-parse', 'HEAD']).trim();
    };
    const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text), Buffer.from([0xff, 0x00, 0xfe, 0x80])]);
    const legacy = join(work, 'data', 'drawings', `${id}.photo.png`);
    // a photo only as a file in git (as before the shared asset store), then a photo set the current way
    const bytes = png('legacy photo');
    writeFileSync(legacy, bytes);
    const atLegacy = commit('studio: legacy photo file');
    rmSync(legacy);
    const sheet = await handleWorkbenchRequest({ method: 'GET', path: `/api/drawings/${id}` }, deps);
    const current = `data:image/png;base64,${png('current photo').toString('base64')}`;
    const put = await handleWorkbenchRequest({ method: 'PUT', path: `/api/drawings/${id}/photo`, body: { photo: current }, headers: { 'if-match': sheet.headers?.ETag as string }, user }, deps);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    commit('studio: photo set');

    const detail = await handleWorkbenchRequest({ method: 'GET', path: `/api/history/entries/${atLegacy}?subject=${encodeURIComponent(subject)}` }, deps);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const restored = await handleWorkbenchRequest({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: atLegacy, current: (detail.body as { current: unknown }).current }, user }, deps);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((restored.body as { restored: { parts: string[] }; skipped?: string[] }).restored.parts).toContain('photo');
    expect((restored.body as { skipped?: string[] }).skipped).toBeUndefined();
    const after = (await handleWorkbenchRequest({ method: 'GET', path: `/api/drawings/${id}` }, deps)).body as { photo?: string };
    expect(Buffer.from(after.photo!.split(',')[1]!, 'base64').equals(bytes)).toBe(true);
  }, 60_000);

  it('a legacy photo file that is not an image says why it was not brought back (cs-7xb)', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const deps = defaultWorkbenchDeps();
    const id = 'de9-crossover';
    const subject = `design:${id}`;
    const user: StudioUser = { name: 'Dana Example', email: 'dana@example.com', source: 'session' };
    const legacy = join(work, 'data', 'drawings', `${id}.photo.png`);
    writeFileSync(legacy, 'version https://git-lfs.github.com/spec/v1\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'studio: pointer file'], as(user.name, 'dana@example.com'));
    const at = git(work, ['rev-parse', 'HEAD']).trim();
    rmSync(legacy);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'studio: gone'], as(user.name, 'dana@example.com'));
    const detail = await handleWorkbenchRequest({ method: 'GET', path: `/api/history/entries/${at}?subject=${encodeURIComponent(subject)}` }, deps);
    const restored = await handleWorkbenchRequest({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: at, current: (detail.body as { current: unknown }).current }, user }, deps);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((restored.body as { skipped?: string[] }).skipped?.[0]).toMatch(/not a readable PNG or JPEG/);
  }, 60_000);

  it('a catalog outside git keeps no history, and says so', async () => {
    const { gitHistorySource } = await import('../server/history/git.ts');
    const plain = mkdtempSync(join(tmpdir(), 'wirehub-history-plain-'));
    try {
      const source = gitHistorySource({ dataDir: plain });
      const caps = await source.capabilities();
      expect(caps.backend).toBe('none');
      expect(caps.restore).toBe(false);
      expect(caps.note).toMatch(/git export/);
      expect((await source.list({ limit: 10 })).entries).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('over HTTP', () => {
  it('the standalone server hands the history its query string', async () => {
    const { Hono } = await import('hono');
    const { mountWorkbenchApi } = await import('../server/hono-adapter.ts');
    const { noHistorySource } = await import('../server/history/source.ts');
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const seen: unknown[] = [];
    const source = { ...noHistorySource(), list: async (query: unknown) => (seen.push(query), { entries: [] }) };
    const app = new Hono();
    mountWorkbenchApi(app, { ...defaultWorkbenchDeps(), history: source });
    const response = await app.request('/api/history?person=alice&kind=design&from=2026-10-01');
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ person: 'alice', kind: 'design', from: '2026-10-01' });
  });
});

describe('the field diff', () => {
  it('compares objects by key, id-keyed arrays by id, other arrays as multisets', () => {
    const before = { label: 'A', instances: { connectors: [{ id: 'j1', def: 'x' }, { id: 'j2', def: 'y' }] }, joints: [{ a: 1 }, { a: 2 }], notes: ['n'] };
    const after = { label: 'B', instances: { connectors: [{ id: 'j2', def: 'y' }, { id: 'j3', def: 'z' }] }, joints: [{ a: 2 }, { a: 3 }], notes: ['n'] };
    expect(fieldDiff(before, after)).toEqual([
      { path: 'label', op: 'changed', before: 'A', after: 'B' },
      { path: 'instances.connectors[j1]', op: 'removed', before: { id: 'j1', def: 'x' } },
      { path: 'instances.connectors[j3]', op: 'added', after: { id: 'j3', def: 'z' } },
      { path: 'joints[−]', op: 'removed', before: { a: 1 } },
      { path: 'joints[+]', op: 'added', after: { a: 3 } },
    ]);
    expect(fieldDiff({ notes: ['a', 'b'] }, { notes: ['b', 'a'] })).toEqual([{ path: 'notes', op: 'reordered' }]);
    expect(fieldDiff(undefined, { id: 'x' })).toEqual([{ path: '(whole record)', op: 'added', after: { id: 'x' } }]);
    expect(fieldDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe('the timeline', () => {
  const row = (cs: string, before: PartRow['before'], after: PartRow['after'], part = 'design'): PartRow => ({ cs, seq: 0, part, before, after });

  it('fills a missing before from the previous after, and leaves out what did not change', () => {
    const steps = stepsByChangeSet([row('2', UNKNOWN, known({ v: 1 })), row('5', UNKNOWN, known({ v: 2 })), row('7', known({ v: 2 }), known({ v: 2 }))]);
    expect([...steps.keys()]).toEqual(['2', '5']);
    expect(steps.get('2')?.[0]?.before).toEqual(UNKNOWN);
    expect(steps.get('5')?.[0]?.before).toEqual(known({ v: 1 }));
  });

  it('the state after an entry: its own after, else the next change\'s before, else the current record', () => {
    const rows = [row('2', known(undefined), known({ v: 1 })), row('5', known({ v: 1 }), known({ v: 2 }))];
    expect(stateAfter(rows, '2', 'design')).toEqual(known({ v: 1 }));
    expect(stateAfter(rows, '3', 'design')).toEqual(known({ v: 1 }));
    expect(stateAfter(rows, '1', 'design')).toEqual(known(undefined));
    expect(stateAfter(rows, '9', 'design')).toEqual(known({ v: 2 }));
    expect(stateAfter([], '9', 'design')).toBe('current');
    expect(stateAfter([row('5', UNKNOWN, known({ v: 2 }))], '3', 'design')).toEqual(UNKNOWN);
  });
});

describe('restores: the subject, the lock and the message', () => {
  it('names a subject as an edit lock names a record', () => {
    expect(parseSubject('design:dc-led-lead')).toEqual({ type: 'design', id: 'dc-led-lead' });
    expect(parseSubject('definition:components:r-120')).toEqual({ type: 'definition', kind: 'components', id: 'r-120' });
    expect(parseSubject('definition:nonsense:r-120')).toBeUndefined();
    expect(parseSubject('design:../x')).toBeUndefined();
  });

  it('a restore is an edit of its record: the lock gate checks it', () => {
    expect(recordsOfWrite('POST', '/api/history/records/design%3Adc-led-lead/restore')).toEqual(['design:dc-led-lead']);
    expect(recordsOfWrite('POST', '/api/history/records/definition%3Acomponents%3Ar-120/restore')).toEqual(['definition:components:r-120']);
    expect(recordsOfWrite('GET', '/api/history/records/design%3Adc-led-lead')).toEqual([]);
  });

  it('says what was restored, and to which change', () => {
    expect(describeSave({ method: 'POST', path: '/api/history/records/design%3Adc-led-lead/restore', body: { entry: '42' } })).toBe('restore design dc-led-lead to change 42');
    expect(describeSave({ method: 'POST', path: '/api/history/records/definition%3Aconnectors%3Ade9-male/restore', body: { entry: 'a'.repeat(40) } })).toBe(`restore connector de9-male to change ${'a'.repeat(12)}`);
  });
});

describe('restoring a board build file (cs-5k1.25)', () => {
  it('is one PUT of the file as it was, quoting its current version', async () => {
    const { handleHistoryRequest } = await import('../server/history/api.ts');
    const { contentETag } = await import('../server/etag.ts');
    const was = { board: 'PCA-1', label: 'Board', end: 'source', builds: [{ key: 'a', build: 'x', src: 's' }] };
    const now = { ...was, label: 'Board (edited)' };
    const calls: { method: string; path: string; body: unknown; ifMatch: string | undefined }[] = [];
    const caps = { backend: 'database', note: '', perRecord: true, diff: true, restore: true, filters: { person: true, date: true, kind: true } } as const;
    const deps = {
      builds: { read: async () => now },
      history: { capabilities: async () => caps, stateAt: async () => ({ parts: { record: known(was) } }) },
    } as never;
    const route = async (request: { method: string; path: string; body?: unknown; headers?: Record<string, string> }) => {
      calls.push({ method: request.method, path: request.path, body: request.body, ifMatch: request.headers?.['if-match'] });
      return { status: 200, body: {} };
    };
    const answer = await handleHistoryRequest({ method: 'POST', path: '/api/history/records/build%3Apca-1/restore', body: { entry: '7', current: { record: contentETag(now) } } }, deps, route as never);
    expect(answer?.status).toBe(200);
    expect(calls).toEqual([{ method: 'PUT', path: '/api/builds/pca-1', body: { file: was }, ifMatch: contentETag(now) }]);
  });
});
