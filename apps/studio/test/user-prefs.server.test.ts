/**
 * Per-person UI preferences (cs-74m4): `GET`/`PUT /api/me/prefs`, the stores behind them, and the
 * rule that a viewer may write their own.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { filePrefsStore, memoryPrefsStore, prefsUserKey, type UserPrefsStore } from '../server/user-prefs.ts';
import type { StudioUser } from '../server/me.ts';

const ada: StudioUser = { name: 'Ada', email: 'Ada@example.com', source: 'session', role: 'viewer' };
const bob: StudioUser = { name: 'Bob', email: 'bob@example.com', source: 'session', role: 'editor' };

const depsOf = (userPrefs?: UserPrefsStore): WorkbenchDeps => ({ ...(userPrefs === undefined ? {} : { userPrefs }) }) as unknown as WorkbenchDeps;
const call = (deps: WorkbenchDeps, method: string, user: StudioUser, body?: unknown) => handleWorkbenchRequest({ method, path: '/api/me/prefs', user, ...(body === undefined ? {} : { body }) }, deps);

describe('/api/me/prefs', () => {
  it('stores a viewer\'s own preferences, merges patches, clears a key with null, and keeps people apart', async () => {
    const deps = depsOf(memoryPrefsStore());
    expect((await call(deps, 'GET', ada)).body).toEqual({ prefs: {} });
    expect((await call(deps, 'PUT', ada, { prefs: { theme: 'dark', 'slot-pins': ['library-detail/a'] } })).body).toEqual({ prefs: { theme: 'dark', 'slot-pins': ['library-detail/a'] } });
    expect((await call(deps, 'PUT', ada, { prefs: { theme: null, 'cols.designs': ['updated'] } })).body).toEqual({ prefs: { 'slot-pins': ['library-detail/a'], 'cols.designs': ['updated'] } });
    expect((await call(deps, 'GET', bob)).body).toEqual({ prefs: {} });
    expect(((await call(deps, 'GET', { ...ada, email: 'ADA@example.com' })).body as { prefs: Record<string, unknown> }).prefs['slot-pins']).toEqual(['library-detail/a']);
  });

  it('refuses bad names, oversize values and other methods; answers 404 when the hub keeps none', async () => {
    const deps = depsOf(memoryPrefsStore());
    expect((await call(deps, 'PUT', ada, { prefs: { 'Bad Key': 1 } })).status).toBe(400);
    expect((await call(deps, 'PUT', ada, { prefs: { big: 'x'.repeat(20_000) } })).status).toBe(400);
    expect((await call(deps, 'PUT', ada, [1])).status).toBe(400);
    expect((await call(deps, 'DELETE', ada)).status).toBe(405);
    expect((await call(depsOf(), 'GET', ada)).status).toBe(404);
  });
});

describe('file prefs store', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('persists across store instances, one file per person, no account name in a path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-prefs-'));
    dirs.push(dir);
    const key = prefsUserKey(ada);
    expect(key).toBe('email:ada@example.com');
    await filePrefsStore(dir).merge(key, { theme: 'light' });
    await filePrefsStore(dir).merge(prefsUserKey(bob), { theme: 'dark' });
    expect(await filePrefsStore(dir).get(key)).toEqual({ theme: 'light' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(files.join(' ')).not.toMatch(/ada|bob/);
  });
});
