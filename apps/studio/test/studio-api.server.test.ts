/**
 * `studio-api` (plan §4.5): pull into a directory, edit JSON, dry-run, push as one
 * batch — against a mounted app over the in-memory commit tree, the same endpoints
 * a pg studio serves.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { ApiClient, ApiClientError, configFromEnv, formatResult, META_FILE, planPush, pull, push, tokenEnvOf, type FetchLike } from '../scripts/studio-api-lib.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

// assembled, so no token-shaped string sits in the source (the secret scan)
const TOKEN = ['cst', 'dev', '0123456789ab', 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst'].join('_');
const BASE = 'http://studio.test';

let app: Hono;
let dir: string;
let seen: { method: string; url: string; authorization: string | undefined }[];

const fetchViaApp: FetchLike = async (url, init) => {
  seen.push({ method: init.method, url, authorization: init.headers['authorization'] });
  const res = await app.request(url, { method: init.method, headers: { ...init.headers, origin: BASE }, ...(init.body === undefined ? {} : { body: init.body }) });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};
const client = (env: 'dev' | 'prod' | undefined = undefined): ApiClient => new ApiClient({ url: BASE, token: TOKEN, ...(env === undefined ? {} : { env }) }, fetchViaApp, async () => undefined);
// the in-memory backend's export version is a constant: compare what it holds
const exportVersion = async (): Promise<string> => createHash('sha256').update(JSON.stringify(((await (await app.request(`${BASE}/api/export`)).json()) as { files: unknown }).files)).digest('hex');
const edit = (path: string, change: (value: any) => void): void => {
  const value = JSON.parse(readFileSync(join(dir, path), 'utf8'));
  change(value);
  writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
};

beforeEach(() => {
  const backend = memoryWriteBackend();
  app = new Hono();
  mountWorkbenchApi(app, backend.deps, backend.depictionDeps);
  dir = mkdtempSync(join(tmpdir(), 'studio-api-'));
  seen = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('configuration', () => {
  it('reads the token from the environment only, and refuses nonsense', () => {
    expect(configFromEnv({ WIREHUB_API_URL: `${BASE}/`, WIREHUB_API_TOKEN: TOKEN })).toEqual({ url: BASE, token: TOKEN });
    expect(() => configFromEnv({ WIREHUB_API_TOKEN: TOKEN })).toThrow(/WIREHUB_API_URL/);
    expect(() => configFromEnv({ WIREHUB_API_URL: BASE })).toThrow(/WIREHUB_API_TOKEN/);
    expect(() => configFromEnv({ WIREHUB_API_URL: BASE, WIREHUB_API_TOKEN: 'abc' })).toThrow(/does not look like/);
    expect(tokenEnvOf('cst_prod_x')).toBe('prod');
  });

  it('refuses a prod token against a server configured as dev, and the other way round', async () => {
    await expect(client('dev').checkEnvironment()).resolves.toBeDefined();
    await expect(new ApiClient({ url: BASE, token: TOKEN.replace('cst_dev', 'cst_prod'), env: 'dev' }, fetchViaApp).checkEnvironment()).rejects.toThrow(/never works on the other environment/);
    await expect(new ApiClient({ url: BASE, token: TOKEN, env: 'prod' }, fetchViaApp).checkEnvironment()).rejects.toThrow(ApiClientError);
    // nothing but the environment check was ever sent
    expect(seen).toHaveLength(1);
  });
});

describe('pull, edit, dry-run, push', () => {
  it('pulls the catalog with the ETags, and an untouched directory has nothing to push', async () => {
    const result = await pull(client(), dir);
    expect(result.files).toBeGreaterThan(10);
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as { url: string; version: string; etags: Record<string, string> };
    expect(meta).toMatchObject({ url: BASE, version: result.version });
    expect(Object.keys(meta.etags).some((k) => k.startsWith('design:'))).toBe(true);
    expect(Object.keys(meta.etags).some((k) => k.startsWith('definition:connectors/'))).toBe(true);
    // the token is in no file the client wrote
    expect(readFileSync(join(dir, META_FILE), 'utf8')).not.toContain('cst_');
    expect(planPush(dir)).toEqual({ requests: [], unsupported: [] });
    expect((await push(client(), dir, { dryRun: true })).changes).toEqual([]);
    // every request carried the token as a bearer
    expect(seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('a dry run shows the diff and writes nothing; the real push is one change set', async () => {
    await pull(client(), dir);
    const designFile = Object.keys(JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')).hashes).find((k) => k.startsWith('design:')) as string;
    const id = designFile.slice('design:'.length);
    edit(`data/designs/${id}.json`, (d) => (d.label = `${d.label} (edited)`));
    edit('data/wires.json', (list) => (list[0].label = `${list[0].label} (edited)`));
    edit('data/connectors.json', (list) => (list[0].label = `${list[0].label} (edited)`));
    const before = await exportVersion();

    const dry = await push(client(), dir, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.committed).toBe(false);
    expect(dry.changes.map((c) => c.kind).sort()).toEqual(['definitions', 'definitions', 'design']);
    expect(dry.changes.some((c) => (c.diff ?? []).some((l) => l.includes('(edited)')))).toBe(true);
    expect(formatResult(dry, true).at(-1)).toMatch(/Dry run: 3 record/);
    expect(await exportVersion()).toBe(before);

    const real = await push(client(), dir, { dryRun: false, message: 'Edit three records' });
    expect(real.ok).toBe(true);
    expect(real.committed).toBe(true);
    expect(await exportVersion()).not.toBe(before);
    // a second pull sees them
    const again = mkdtempSync(join(tmpdir(), 'studio-api-2-'));
    try {
      await pull(client(), again);
      expect(JSON.parse(readFileSync(join(again, `data/designs/${id}.json`), 'utf8')).label).toContain('(edited)');
      expect(JSON.parse(readFileSync(join(again, 'data/connectors.json'), 'utf8'))[0].label).toContain('(edited)');
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  });

  it('a record that changed since the pull fails its If-Match: the whole batch is refused and nothing is retried', async () => {
    await pull(client(), dir);
    const other = mkdtempSync(join(tmpdir(), 'studio-api-3-'));
    try {
      await pull(client(), other);
      for (const d of [dir, other]) {
        const list = JSON.parse(readFileSync(join(d, 'data/wires.json'), 'utf8'));
        list[0].label = `edited in ${d === dir ? 'first' : 'second'}`;
        writeFileSync(join(d, 'data/wires.json'), `${JSON.stringify(list, null, 2)}\n`);
      }
      expect((await push(client(), other, { dryRun: false, message: 'second' })).ok).toBe(true);
      edit('data/connectors.json', (c) => (c[0].label = 'also edited'));
      const before = await exportVersion();
      seen = [];
      const stale = await push(client(), dir, { dryRun: false, message: 'first' });
      expect(stale.ok).toBe(false);
      expect(stale.failed?.status).toBe(409);
      expect(stale.failed?.message).toMatch(/Pull again/);
      expect(await exportVersion()).toBe(before);
      // one batch, never repeated
      expect(seen.filter((s) => s.url.endsWith('/api/batch'))).toHaveLength(1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('adds and removes designs, and refuses a changed file that has no write route', async () => {
    await pull(client(), dir);
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as { hashes: Record<string, string> };
    const ids = Object.keys(meta.hashes).filter((k) => k.startsWith('design:')).map((k) => k.slice(7));
    const [first, second] = ids as [string, string];
    cpSync(join(dir, `data/designs/${first}.json`), join(dir, 'data/designs/a-new-copy.json'));
    edit('data/designs/a-new-copy.json', (d) => ((d.id = 'a-new-copy'), (d.label = 'A new copy')));
    rmSync(join(dir, `data/designs/${second}.json`));
    const plan = planPush(dir);
    expect(plan.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/designs', `DELETE /api/designs/${second}`]);
    const dry = await push(client(), dir, { dryRun: true });
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    expect(new Set(dry.changes.map((c) => c.op))).toEqual(new Set(['delete', 'put']));

    const art = Object.keys(JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')).hashes).find((k) => k.startsWith('file:'));
    if (art !== undefined) {
      writeFileSync(join(dir, art.slice(5)), 'changed');
      await expect(push(client(), dir, { dryRun: true })).rejects.toThrow(/no write route/);
    }
  });

  it('refuses to pull into a directory it did not make, and needs a pull before a push', async () => {
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    await expect(pull(client(), dir)).rejects.toThrow(/not empty/);
    expect(existsSync(join(dir, META_FILE))).toBe(false);
    expect(() => planPush(dir)).toThrow(/run studio-api pull first/);
  });
});
