/**
 * `studio-api` (plan §4.5): pull into a directory, edit JSON, dry-run, push as one
 * batch — against a mounted app over the in-memory commit tree, the same endpoints
 * a pg studio serves.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const all = Object.keys(meta.hashes).filter((k) => k.startsWith('design:')).map((k) => k.slice(7));
    // a design placed as a sub-assembly cannot be deleted: pick two nothing places
    const placed = new Set(all.flatMap((id) => (JSON.parse(readFileSync(join(dir, `data/designs/${id}.json`), 'utf8')) as { instances: { subassemblies?: { def: string }[] } }).instances.subassemblies?.map((s) => s.def) ?? []));
    const ids = all.filter((id) => !placed.has(id));
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

describe('the other files with routes: vocabulary, tag corrections, wire library, builds, drawings', () => {
  const req = (plan: ReturnType<typeof planPush>): string[] => plan.requests.map((r) => `${r.method} ${r.path}`);

  it('maps vocabulary edits: new entries, a relabel, more aliases and a note; the rest is refused with a reason', async () => {
    await pull(client(), dir);
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as { etags: Record<string, string>; base: Record<string, unknown> };
    expect(meta.etags['vocab:signals']).toMatch(/^"/);
    expect(Object.keys(meta.base)).toContain('data/vocab/signals.json');
    expect(planPush(dir)).toEqual({ requests: [], unsupported: [] });

    edit('data/vocab/signals.json', (list) => {
      list.entries[0].label = `${list.entries[0].label} renamed`;
      list.entries[0].note = 'checked on the bench';
      list.entries[1].aliases = [...(list.entries[1].aliases ?? []), 'another-name'];
      list.entries.push({ id: 'test-new-signal', label: 'Test new signal', kind: 'data', src: 'synthetic example: studio-api test' });
    });
    const plan = planPush(dir);
    const first = list(plan, 'data/vocab/signals.json');
    expect(first.unsupported).toEqual([]);
    expect(req(plan)).toEqual([
      expect.stringMatching(/^PATCH \/api\/vocab\/signals\//),
      expect.stringMatching(/^PATCH \/api\/vocab\/signals\//),
      'POST /api/vocab/signals',
    ]);
    // the first edit quotes the list as pulled; the next ride on the same atomic batch
    expect(plan.requests[0]?.ifMatch).toBe(meta.etags['vocab:signals']);
    expect(plan.requests[1]?.ifMatch).toBe('*');
    expect(plan.requests[2]?.ifMatch).toBeUndefined();

    const dry = await push(client(), dir, { dryRun: true });
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    const real = await push(client(), dir, { dryRun: false, message: 'vocab' });
    expect(real.ok, JSON.stringify(real)).toBe(true);
    const stored = (await (await app.request(`${BASE}/api/vocab/signals`)).json()) as { entries: { id: string; label: string; note?: string; aliases?: string[] }[] };
    expect(stored.entries.find((e) => e.id === 'test-new-signal')).toBeDefined();
    expect(stored.entries[0]?.note).toBe('checked on the bench');
    expect(stored.entries[0]?.aliases?.length).toBeGreaterThan(0);

    // what a route cannot express stops the push, with the reason
    await pull(client(), dir);
    edit('data/vocab/signals.json', (l) => {
      l.entries[0].kind = 'other-kind';
      l.entries.splice(1, 1);
    });
    const refused = planPush(dir);
    expect(refused.unsupported.join('\n')).toMatch(/kind cannot be changed through the API/);
    expect(refused.unsupported.join('\n')).toMatch(/was removed, and no route removes a vocabulary entry/);
    await expect(push(client(), dir, { dryRun: true })).rejects.toThrow(/no write route/);
  });

  it('maps tag corrections to PUT /api/tags, and refuses removing one', async () => {
    await pull(client(), dir);
    const connector = JSON.parse(readFileSync(join(dir, 'data/connectors.json'), 'utf8'))[0] as { id: string; pins: { id: string; signal?: unknown }[] };
    const pin = connector.pins.find((p) => p.signal === undefined);
    if (pin === undefined) return;
    edit('data/tags/review.json', (r) => {
      r.connectors[connector.id] = { [pin.id]: { signal: 'gnd', why: 'checked against the datasheet' } };
    });
    const plan = planPush(dir);
    expect(plan.unsupported).toEqual([]);
    expect(plan.requests).toEqual([{ method: 'PUT', path: `/api/tags/connectors/${connector.id}`, body: { tags: { [pin.id]: 'gnd' }, why: 'checked against the datasheet' }, label: `correct connector ${connector.id} ${pin.id}` }]);
    const real = await push(client(), dir, { dryRun: false, message: 'tags' });
    expect(real.ok, JSON.stringify(real)).toBe(true);
    // the next pull has the correction; removing it from the file has no route
    await pull(client(), dir);
    expect(JSON.parse(readFileSync(join(dir, 'data/tags/review.json'), 'utf8')).connectors[connector.id][pin.id].why).toBe('checked against the datasheet');
    edit('data/tags/review.json', (r) => delete r.connectors[connector.id]);
    expect(planPush(dir).unsupported.join('\n')).toMatch(/correction for connectors\/.* was removed/);
  });

  it('maps drawing details and board build files, and a new wire part and stock recipe', async () => {
    await pull(client(), dir);
    const drawing = (await (await app.request(`${BASE}/api/drawings`)).json()) as unknown;
    expect(drawing).toBeDefined();
    const drawingFile = Object.keys((JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as { base: Record<string, unknown> }).base).find((p) => p.startsWith('data/drawings/'));
    if (drawingFile !== undefined) {
      const id = drawingFile.slice('data/drawings/'.length, -'.json'.length);
      edit(drawingFile, (d) => (d.title = `${d.title ?? 'Untitled'} (edited)`));
      const plan = planPush(dir);
      expect(plan.requests).toHaveLength(1);
      expect(plan.requests[0]).toMatchObject({ method: 'PUT', path: `/api/drawings/${id}` });
      expect(plan.requests[0]?.ifMatch).toMatch(/^"/);
      expect((await push(client(), dir, { dryRun: false, message: 'drawing' })).ok).toBe(true);
      expect(((await (await app.request(`${BASE}/api/drawings/${id}`)).json()) as { meta: { title: string } }).meta.title).toContain('(edited)');
    }
    // a file the catalog did not have: a build file and the wire library are created, not compared
    await pull(client(), dir);
    writeFileSync(join(dir, 'data/wire-parts.json'), `${JSON.stringify([{ id: 'part-x', kind: 'conductor', label: 'x', src: 'synthetic' }], null, 2)}\n`);
    writeFileSync(join(dir, 'data/wire-recipes.json'), `${JSON.stringify([{ id: 'stock-x', label: 'x', src: 'synthetic', cores: [] }], null, 2)}\n`);
    const plan = planPush(dir);
    expect(req(plan)).toEqual(['POST /api/wire-library/parts', 'PUT /api/wire-library/stocks/stock-x']);
    expect(plan.requests[1]?.body).toMatchObject({ create: true });
    // a new build file is a PUT of {file}, a changed one quotes the version pulled
    const buildFile = { board: 'PCA-00001', label: 'Test board', end: 'source', builds: [{ key: 'term-on', build: '', src: 'synthetic' }] };
    mkdirSync(join(dir, 'data/builds'), { recursive: true });
    writeFileSync(join(dir, 'data/builds/pca-00001.json'), `${JSON.stringify(buildFile, null, 2)}\n`);
    expect(planPush(dir).requests.filter((r) => r.path.startsWith('/api/builds'))).toEqual([{ method: 'PUT', path: '/api/builds/pca-00001', body: { file: buildFile }, label: 'add build file pca-00001' }]);
    rmSync(join(dir, 'data/builds'), { recursive: true, force: true });
    // the server's own words come back when it refuses (here: a recipe with no cores)
    const answer = await push(client(), dir, { dryRun: true });
    expect(answer.ok).toBe(false);
  });
});

/** the unsupported lines that name a file */
function list(plan: { unsupported: string[] }, path: string): { unsupported: string[] } {
  return { unsupported: plan.unsupported.filter((u) => u.includes(path)) };
}
