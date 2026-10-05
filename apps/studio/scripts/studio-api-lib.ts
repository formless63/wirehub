/**
 * `studio-api`'s library (`specs/postgres-backend.md` §4.5): scripts and agents
 * work on JSON files, the studio's own API does the writing.
 *
 *   pull <dir>          `GET /api/export` into <dir> + `.studio-api.json` (the
 *                       server, its catalog version, every record's ETag);
 *   push <dir>          the changed files, mapped to the write routes, as ONE
 *                       `POST /api/batch` (`--dry-run`: the would-be diff only);
 *   call <method> <path> [body]    a single route.
 *
 * The token comes from `WIREHUB_API_TOKEN` and nowhere else (never a flag, never a
 * file this writes); the server from `WIREHUB_API_URL`. A token of one
 * environment (`cst_prod_…`, `cst_dev_…`) is refused against a server of the other,
 * whether `WIREHUB_API_ENV` says so or the server's `GET /api/me` does.
 *
 * A stale record fails its If-Match and the whole batch is refused (`409`); this
 * client never retries a 409, it stops and reports.
 *
 * What maps to a route: designs (`data/designs/<id>.json`), the definition lists
 * (`connectors`, `components`, `wires`, `pcbas`, `bodies`, `interfaces`,
 * `mechanicals`, `kits`) record by record, the documents a module declares
 * (`PUT /api/docs/<path>`), and — compared with the copy a pull took (`base` in
 * the meta file) — the controlled vocabularies (`data/vocab/<list>.json`: new
 * entries, and a changed label, more aliases or a note), the tag corrections
 * (`data/tags/review.json`), the wire parts library (`data/wire-parts.json`:
 * new parts; `data/wire-recipes.json`: stock recipes), the board build files
 * (`data/builds/<name>.json`) and the drawing details
 * (`data/drawings/<id>.json`). Connectors are pulled in the composed form the
 * API takes (the server stores them decomposed). Any other changed file — and a
 * change in those files the routes cannot express (removing a vocabulary entry,
 * changing an existing wire part) — is reported and stops the push.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { contentETag } from '../server/etag.ts';
import { HEARTBEAT_MS, recordsOfWrite, LOCK_HEADER } from '../src/locks/records.ts';

export const META_FILE = '.studio-api.json';
export const DEFINITION_KINDS = ['connectors', 'components', 'wires', 'pcbas', 'bodies', 'interfaces', 'mechanicals', 'kits'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export class ApiClientError extends Error {}

/* ------------------------------------------------------------------ *
 * Configuration and the HTTP client
 * ------------------------------------------------------------------ */

export interface ApiConfig {
  url: string;
  token: string;
  /** `WIREHUB_API_ENV`: what the server at `url` is, when the caller says */
  env?: 'dev' | 'prod';
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/** The environment a token's prefix claims. */
export function tokenEnvOf(token: string): 'dev' | 'prod' | undefined {
  const match = /^cst_(dev|prod)_/.exec(token);
  return match === null ? undefined : (match[1] as 'dev' | 'prod');
}

export function configFromEnv(env: EnvLike): ApiConfig {
  const url = (env['WIREHUB_API_URL'] ?? '').trim().replace(/\/+$/, '');
  const token = (env['WIREHUB_API_TOKEN'] ?? '').trim();
  if (url === '') throw new ApiClientError('Set WIREHUB_API_URL to the studio, like https://wirehub.example.com.');
  if (!/^https?:\/\//.test(url)) throw new ApiClientError('WIREHUB_API_URL must be an http(s) address.');
  if (token === '') throw new ApiClientError('Set WIREHUB_API_TOKEN to a personal API token (Account, API tokens). It is read from the environment only.');
  if (tokenEnvOf(token) === undefined) throw new ApiClientError('WIREHUB_API_TOKEN does not look like a WireHub token (cst_dev_… or cst_prod_…).');
  const declared = (env['WIREHUB_API_ENV'] ?? '').trim();
  if (declared !== '' && declared !== 'dev' && declared !== 'prod') throw new ApiClientError("WIREHUB_API_ENV must be 'dev' or 'prod'.");
  return { url, token, ...(declared === '' ? {} : { env: declared as 'dev' | 'prod' }) };
}

export interface ApiAnswer {
  status: number;
  body: unknown;
  etag: string | undefined;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class ApiClient {
  readonly config: ApiConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(config: ApiConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike, sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  /** One request. A 429 is waited out once (up to a minute); nothing else is retried — least of all a 409. */
  async request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiAnswer> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.fetchImpl(`${this.config.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get('retry-after') ?? '');
        if (Number.isFinite(wait) && wait > 0 && wait <= 60) {
          await this.sleep(wait * 1000);
          continue;
        }
      }
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        // not JSON: keep the text
      }
      return { status: res.status, body, etag: res.headers.get('etag') ?? undefined };
    }
  }

  /** Refuse a token of the other environment than the server's, before anything is sent that matters. */
  async checkEnvironment(): Promise<{ user?: { name?: string; email?: string } }> {
    const tokenEnv = tokenEnvOf(this.config.token);
    if (this.config.env !== undefined && tokenEnv !== this.config.env) {
      throw new ApiClientError(`The token is for ${tokenEnv}, but WIREHUB_API_ENV says this server is ${this.config.env}. A token never works on the other environment.`);
    }
    const me = await this.request('GET', '/api/me');
    if (me.status === 401) throw new ApiClientError('The server refused the token (invalid or expired).');
    if (me.status >= 400) throw new ApiClientError(`GET /api/me answered ${me.status}.`);
    const body = me.body as { user?: { name?: string; email?: string }; instance?: { env?: string } } | undefined;
    const serverEnv = body?.instance?.env;
    if ((serverEnv === 'dev' || serverEnv === 'prod') && serverEnv !== tokenEnv) {
      throw new ApiClientError(`The token is for ${tokenEnv}, but this server is ${serverEnv}.`);
    }
    return body?.user === undefined ? {} : { user: body.user };
  }
}

/* ------------------------------------------------------------------ *
 * The pulled directory
 * ------------------------------------------------------------------ */

export interface PullMeta {
  format: 'studio-api-pull';
  url: string;
  /** the catalog version pulled */
  version: string;
  /** `design:<id>`, `definition:<kind>/<id>`, `doc:<path>` → the ETag the server held */
  etags: Record<string, string>;
  /** the same keys → a hash of the record as pulled, to see what an edit changed */
  hashes: Record<string, string>;
  /** every file written, relative to the directory */
  files: string[];
  /** the files with their own routes (vocab, tags, wire library, builds, drawings), as pulled: edits are compared with these */
  base?: Record<string, unknown>;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);
const hashOf = (value: unknown): string => sha(JSON.stringify(value));
const prettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface Exported {
  version: string;
  files: Record<string, string>;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, base);
    return [relative(base, path).split(sep).join('/')];
  });
}

/** The records of a list file and their keys: `definition:<kind>/<id>` → the record. */
function recordsOf(kind: DefinitionKind, text: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new ApiClientError(`data/${kind}.json must be a JSON array.`);
  for (const record of parsed) {
    const id = (record as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') throw new ApiClientError(`A record in data/${kind}.json has no id.`);
    out.set(`definition:${kind}/${id}`, record);
  }
  return out;
}

type Classified =
  | { type: 'design'; id: string }
  | { type: 'definitions'; kind: DefinitionKind }
  | { type: 'vocab'; list: string }
  | { type: 'wire-parts' }
  | { type: 'wire-recipes' }
  | { type: 'build'; name: string }
  | { type: 'drawing'; id: string }
  | { type: 'tag-review' }
  | { type: 'doc' }
  | { type: 'other' };

/** Which kind of file a path under the pulled directory is. */
function classify(path: string): Classified {
  const vocab = /^data\/vocab\/([a-z0-9][a-z0-9-]*)\.json$/.exec(path);
  if (vocab !== null) return { type: 'vocab', list: vocab[1] as string };
  if (path === 'data/wire-parts.json') return { type: 'wire-parts' };
  if (path === 'data/wire-recipes.json') return { type: 'wire-recipes' };
  if (path === 'data/tags/review.json') return { type: 'tag-review' };
  const build = /^data\/builds\/([a-z0-9][a-z0-9-]*)\.json$/.exec(path);
  if (build !== null) return { type: 'build', name: build[1] as string };
  const drawing = /^data\/drawings\/([a-z0-9][a-z0-9-]*)\.json$/.exec(path);
  if (drawing !== null) return { type: 'drawing', id: drawing[1] as string };
  const design = /^data\/designs\/([a-z0-9][a-z0-9-]*)\.json$/.exec(path);
  if (design !== null) return { type: 'design', id: design[1] as string };
  const list = /^data\/([a-z]+)\.json$/.exec(path);
  if (list !== null && (DEFINITION_KINDS as readonly string[]).includes(list[1] as string)) return { type: 'definitions', kind: list[1] as DefinitionKind };
  // a catalog document the docs route could name: text under data/
  if (/^data\/.+\.(json|md|txt)$/.test(path) && !path.startsWith('data/designs/')) return { type: 'doc' };
  return { type: 'other' };
}

const docValue = (path: string, text: string): unknown => (path.endsWith('.json') ? (JSON.parse(text) as unknown) : text);

export interface PullResult {
  dir: string;
  version: string;
  files: number;
}

/** `studio-api pull <dir>` */
export async function pull(client: ApiClient, dir: string): Promise<PullResult> {
  await client.checkEnvironment();
  const metaPath = join(dir, META_FILE);
  const previous = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as PullMeta) : undefined;
  if (existsSync(dir) && previous === undefined && readdirSync(dir).length > 0) {
    throw new ApiClientError(`${dir} is not empty and was not pulled by studio-api; pull into an empty directory.`);
  }
  const exported = await client.request('GET', '/api/export');
  if (exported.status !== 200) throw new ApiClientError(`GET /api/export answered ${exported.status}${exported.status === 403 ? ' (the catalog export is for owners and editors)' : ''}.`);
  const catalog = exported.body as Exported;
  const files = new Map<string, string>(Object.entries(catalog.files));
  const etags: Record<string, string> = {};
  const hashes: Record<string, string> = {};

  // definitions: the API's own records and ETags (a connector is stored decomposed; the API composes it)
  for (const kind of DEFINITION_KINDS) {
    const answer = await client.request('GET', `/api/definitions/${kind}`);
    if (answer.status !== 200) throw new ApiClientError(`GET /api/definitions/${kind} answered ${answer.status}.`);
    const body = answer.body as { records: { id: string }[]; etags: Record<string, string> };
    if (kind === 'connectors') files.set('data/connectors.json', prettyJson(body.records));
    for (const record of body.records) etags[`definition:${kind}/${record.id}`] = body.etags[record.id] as string;
  }
  // what an edit changed is judged against the records as the files hold them
  for (const kind of DEFINITION_KINDS) {
    const text = files.get(`data/${kind}.json`);
    if (text !== undefined) for (const [key, record] of recordsOf(kind, text)) hashes[key] = hashOf(record);
  }
  for (const [path, text] of files) {
    const what = classify(path);
    if (what.type === 'design') {
      const value = JSON.parse(text) as unknown;
      etags[`design:${what.id}`] = contentETag(value);
      hashes[`design:${what.id}`] = hashOf(value);
    } else if (what.type === 'doc') {
      etags[`doc:${path}`] = contentETag(docValue(path, text));
      hashes[`doc:${path}`] = sha(text);
    } else if (what.type === 'other') hashes[`file:${path}`] = sha(text);
  }

  // the files with their own routes: kept as pulled, with the versions the API holds them at
  const base: Record<string, unknown> = {};
  const etagOf = async (path: string, what: string): Promise<string> => {
    const answer = await client.request('GET', path);
    if (answer.status !== 200 || answer.etag === undefined) throw new ApiClientError(`GET ${path} answered ${answer.status}${answer.etag === undefined && answer.status === 200 ? ' without a version' : ''} (${what}).`);
    return answer.etag;
  };
  let wireLibrary = false;
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const what = classify(path);
    if (what.type === 'vocab' || what.type === 'wire-parts' || what.type === 'wire-recipes' || what.type === 'build' || what.type === 'drawing' || what.type === 'tag-review') {
      base[path] = JSON.parse(text) as unknown;
      delete hashes[`file:${path}`];
      delete hashes[`doc:${path}`];
      delete etags[`doc:${path}`];
    }
    // a list and a build file are stored as the text exported, so their versions are the hash of it (as designs and documents are)
    if (what.type === 'vocab') etags[`vocab:${what.list}`] = contentETag(base[path]);
    else if (what.type === 'build') etags[`build:${what.name}`] = contentETag(base[path]);
    // drawing details are versioned together with their photo: ask
    else if (what.type === 'drawing') etags[`drawing:${what.id}`] = await etagOf(`/api/drawings/${what.id}`, 'drawing details');
    else if ((what.type === 'wire-parts' || what.type === 'wire-recipes') && !wireLibrary) {
      wireLibrary = true;
      etags['wire-library'] = await etagOf('/api/wire-library', 'wire parts library');
    }
  }

  // a re-pull replaces what the last one wrote
  for (const old of previous?.files ?? []) if (!files.has(old)) rmSync(join(dir, old), { force: true });
  for (const [path, text] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const meta: PullMeta = { format: 'studio-api-pull', url: client.config.url, version: catalog.version, etags, hashes, files: [...files.keys()].sort(), base };
  writeFileSync(metaPath, prettyJson(meta));
  return { dir, version: catalog.version, files: files.size };
}

/* ------------------------------------------------------------------ *
 * Planning a push
 * ------------------------------------------------------------------ */

export interface PlannedRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  ifMatch?: string;
  body?: unknown;
  /** a person's words for the summary */
  label: string;
}

export interface PushPlan {
  requests: PlannedRequest[];
  /** changed files with no write route */
  unsupported: string[];
}

function readMeta(dir: string): PullMeta {
  const metaPath = join(dir, META_FILE);
  if (!existsSync(metaPath)) throw new ApiClientError(`${dir} has no ${META_FILE}; run studio-api pull first.`);
  return JSON.parse(readFileSync(metaPath, 'utf8')) as PullMeta;
}

/** What the directory holds now, by file path (text only; the pulled files and any added). */
function readCurrent(dir: string, pulled: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of walk(dir)) {
    if (path === META_FILE || path.split('/').some((p) => p.startsWith('.'))) continue;
    if (!/\.(json|md|txt)$/.test(path) && !pulled.has(path)) continue;
    out.set(path, readFileSync(join(dir, path), 'utf8'));
  }
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The entries of a list file by id. */
function byId(value: unknown, path: string): Map<string, Record<string, unknown>> {
  const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value['entries']) ? (value['entries'] as unknown[]) : undefined;
  if (list === undefined) throw new ApiClientError(`${path} must be a JSON list of records (or a list with entries).`);
  const out = new Map<string, Record<string, unknown>>();
  for (const record of list) {
    if (!isObject(record) || typeof record['id'] !== 'string') throw new ApiClientError(`A record in ${path} has no id.`);
    out.set(record['id'], record);
  }
  return out;
}

interface Planned {
  /** requests, by the order they must run in */
  vocabPatches: PlannedRequest[];
  vocabPosts: PlannedRequest[];
  wireParts: PlannedRequest[];
  wireStocks: PlannedRequest[];
  builds: PlannedRequest[];
  drawings: PlannedRequest[];
  tags: PlannedRequest[];
  unsupported: string[];
}

/** A vocabulary list: new entries are added, an entry may get a new label, more aliases or a note; nothing else has a route. */
function planVocab(path: string, list: string, base: unknown, now: unknown, etag: string | undefined, out: Planned): void {
  if (!isObject(base) || !isObject(now)) {
    out.unsupported.push(`${path} (a vocabulary list is a JSON object with entries)`);
    return;
  }
  const { entries: _b, ...baseRest } = base;
  const { entries: _n, ...nowRest } = now;
  if (!same(baseRest, nowRest)) out.unsupported.push(`${path}: the list's own fields (label, source …) have no route`);
  const before = byId(base, path);
  const after = byId(now, path);
  let patched = 0;
  for (const [id, entry] of after) {
    const old = before.get(id);
    if (old === undefined) {
      out.vocabPosts.push({ method: 'POST', path: `/api/vocab/${list}`, body: entry, label: `add ${list} entry ${id}` });
      continue;
    }
    if (same(old, entry)) continue;
    const body: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const key of new Set([...Object.keys(old), ...Object.keys(entry)])) {
      if (same(old[key], entry[key])) continue;
      if (key === 'label' && typeof entry[key] === 'string') body['label'] = entry[key];
      else if (key === 'note' && typeof entry[key] === 'string' && (entry[key] as string).trim() !== '') body['note'] = entry[key];
      else if (key === 'aliases' && Array.isArray(entry[key])) {
        const had = new Set(Array.isArray(old[key]) ? (old[key] as unknown[]) : []);
        const next = entry[key] as unknown[];
        if ([...had].some((a) => !next.includes(a))) problems.push('an alias cannot be removed through the API');
        else body['aliases'] = next.filter((a) => !had.has(a));
      } else problems.push(`${key} cannot be changed through the API`);
    }
    if (problems.length > 0) {
      out.unsupported.push(`${path}: entry ${id}: ${[...new Set(problems)].join('; ')} (only the label, more aliases and a note can change)`);
      continue;
    }
    // the first edit quotes the list as pulled; the batch is one atomic unit, so the rest ride on it
    out.vocabPatches.push({ method: 'PATCH', path: `/api/vocab/${list}/${id}`, ifMatch: patched === 0 ? (etag ?? '*') : '*', body, label: `change ${list} entry ${id}` });
    patched += 1;
  }
  for (const id of before.keys()) if (!after.has(id)) out.unsupported.push(`${path}: entry ${id} was removed, and no route removes a vocabulary entry`);
}

/** Tag corrections: each changed correction is a `PUT /api/tags/<kind>/<id>`; removing one has no route. */
function planTagReview(path: string, base: unknown, now: unknown, out: Planned): void {
  if (!isObject(base) || !isObject(now)) {
    out.unsupported.push(`${path} (the tag review is a JSON object)`);
    return;
  }
  if (!same(base['src'], now['src'])) out.unsupported.push(`${path}: src has no route`);
  if (!same(base['slots'], now['slots'])) out.unsupported.push(`${path}: slot corrections have no route`);
  const at = (value: Record<string, unknown>, kind: string): Record<string, unknown> => (isObject(value[kind]) ? (value[kind] as Record<string, unknown>) : {});
  const put = (kind: 'connectors' | 'pcbas' | 'wires', id: string, tags: unknown, why: unknown, label: string): void => {
    out.tags.push({ method: 'PUT', path: `/api/tags/${kind}/${id}`, body: { tags, ...(typeof why === 'string' && why.trim() !== '' ? { why } : {}) }, label });
  };
  for (const kind of ['connectors', 'pcbas'] as const) {
    const was = at(base, kind);
    const is = at(now, kind);
    for (const id of new Set([...Object.keys(was), ...Object.keys(is)])) {
      const wasRecord = isObject(was[id]) ? (was[id] as Record<string, unknown>) : {};
      const isRecord = isObject(is[id]) ? (is[id] as Record<string, unknown>) : {};
      for (const part of new Set([...Object.keys(wasRecord), ...Object.keys(isRecord)])) {
        if (same(wasRecord[part], isRecord[part])) continue;
        const fix = isRecord[part];
        if (!isObject(fix)) {
          out.unsupported.push(`${path}: the correction for ${kind}/${id}/${part} was removed, and no route removes one`);
          continue;
        }
        const { why, ...fields } = fix;
        put(kind, id, { [part]: kind === 'connectors' ? (fields['signal'] ?? null) : fields }, why, `correct ${kind.replace(/s$/, '')} ${id} ${part}`);
      }
    }
  }
  const wasWires = at(base, 'wires');
  const isWires = at(now, 'wires');
  for (const id of new Set([...Object.keys(wasWires), ...Object.keys(isWires)])) {
    if (same(wasWires[id], isWires[id])) continue;
    const fix = isWires[id];
    if (!isObject(fix)) {
      out.unsupported.push(`${path}: the correction for wires/${id} was removed, and no route removes one`);
      continue;
    }
    const { why, ...fields } = fix;
    put('wires', id, fields, why, `correct wire ${id}`);
  }
}

/** New wire parts are added; a stock recipe is created or replaced; changing or removing a part, or removing a recipe, has no route. */
function planWireLibrary(wire: { parts?: { path: string; now: unknown }; recipes?: { path: string; now: unknown } }, baseOf: (path: string) => unknown, etag: string | undefined, out: Planned): void {
  let newParts = 0;
  if (wire.parts !== undefined) {
    const before = byId(baseOf(wire.parts.path), wire.parts.path);
    const after = byId(wire.parts.now, wire.parts.path);
    for (const [id, part] of after) {
      const old = before.get(id);
      if (old === undefined) {
        out.wireParts.push({ method: 'POST', path: '/api/wire-library/parts', body: { part }, label: `add wire part ${id}` });
        newParts += 1;
      } else if (!same(old, part)) out.unsupported.push(`${wire.parts.path}: part ${id} changed, and no route changes a wire part (add a new one)`);
    }
    for (const id of before.keys()) if (!after.has(id)) out.unsupported.push(`${wire.parts.path}: part ${id} was removed, and no route removes one`);
  }
  if (wire.recipes !== undefined) {
    const before = byId(baseOf(wire.recipes.path), wire.recipes.path);
    const after = byId(wire.recipes.now, wire.recipes.path);
    // a stock edit quotes the library as pulled — unless a new part already moved it inside this batch
    let guard: string | undefined = newParts === 0 ? (etag ?? '*') : '*';
    const creates: PlannedRequest[] = [];
    for (const [id, recipe] of after) {
      const old = before.get(id);
      if (old === undefined) creates.push({ method: 'PUT', path: `/api/wire-library/stocks/${id}`, body: { recipe, create: true }, label: `add wire stock ${id}` });
      else if (!same(old, recipe)) {
        out.wireStocks.push({ method: 'PUT', path: `/api/wire-library/stocks/${id}`, ifMatch: guard ?? '*', body: { recipe }, label: `change wire stock ${id}` });
        guard = '*';
      }
    }
    out.wireStocks.push(...creates);
    for (const id of before.keys()) if (!after.has(id)) out.unsupported.push(`${wire.recipes.path}: recipe ${id} was removed, and no route removes one`);
  }
}

/** Map the directory's edits to write requests. Pure over the files; reads the directory and its meta only. */
export function planPush(dir: string): PushPlan {
  const meta = readMeta(dir);
  const current = readCurrent(dir, new Set(meta.files));
  const creates: PlannedRequest[] = [];
  const updates: PlannedRequest[] = [];
  const designs: PlannedRequest[] = [];
  const docs: PlannedRequest[] = [];
  const deletes: PlannedRequest[] = [];
  const unsupported: string[] = [];
  const seen = new Set<string>();
  const planned: Planned = { vocabPatches: [], vocabPosts: [], wireParts: [], wireStocks: [], builds: [], drawings: [], tags: [], unsupported };
  const base = meta.base ?? {};
  // a wire library file the catalog did not have when pulled (none in the starter catalog) starts empty
  const baseOf = (path: string): unknown => (path in base ? base[path] : []);
  // wire parts and recipes, planned together: new parts first, and the library's version moves with every write
  const wire: { parts?: { path: string; now: unknown }; recipes?: { path: string; now: unknown } } = {};

  const diffRecord = (key: string, value: unknown, route: { create: string; update: string }, label: string, bucket: 'design' | 'def'): void => {
    seen.add(key);
    const before = meta.hashes[key];
    if (before === undefined) (bucket === 'design' ? designs : creates).push({ method: 'POST', path: route.create, body: value, label: `add ${label}` });
    else if (before !== hashOf(value)) (bucket === 'design' ? designs : updates).push({ method: 'PUT', path: route.update, ifMatch: meta.etags[key] as string, body: value, label: `change ${label}` });
  };

  for (const [path, text] of current) {
    const what = classify(path);
    if (what.type === 'design') {
      const value = JSON.parse(text) as { id?: unknown };
      if (value.id !== what.id) throw new ApiClientError(`${path}: the design's id is '${String(value.id)}', but the file is named '${what.id}'.`);
      diffRecord(`design:${what.id}`, value, { create: '/api/designs', update: `/api/designs/${what.id}` }, `design ${what.id}`, 'design');
    } else if (what.type === 'definitions') {
      const present = recordsOf(what.kind, text);
      for (const [key, record] of present) {
        const id = key.split('/')[1] as string;
        diffRecord(key, record, { create: `/api/definitions/${what.kind}`, update: `/api/definitions/${what.kind}/${id}` }, `${what.kind.replace(/s$/, '')} ${id}`, 'def');
      }
    } else if (what.type === 'vocab') {
      if (path in base) planVocab(path, what.list, base[path], JSON.parse(text), meta.etags[`vocab:${what.list}`], planned);
      else unsupported.push(`${path} (a new vocabulary list has no route)`);
    } else if (what.type === 'tag-review') {
      if (path in base) planTagReview(path, base[path], JSON.parse(text), planned);
      else unsupported.push(`${path} (not in the pull this directory holds; pull again)`);
    } else if (what.type === 'wire-parts') wire.parts = { path, now: JSON.parse(text) };
    else if (what.type === 'wire-recipes') wire.recipes = { path, now: JSON.parse(text) };
    else if (what.type === 'build') {
      const now = JSON.parse(text) as unknown;
      const was = base[path];
      if (!(path in base)) planned.builds.push({ method: 'PUT', path: `/api/builds/${what.name}`, body: { file: now }, label: `add build file ${what.name}` });
      else if (!same(was, now)) planned.builds.push({ method: 'PUT', path: `/api/builds/${what.name}`, ifMatch: meta.etags[`build:${what.name}`] ?? '*', body: { file: now }, label: `change build file ${what.name}` });
    } else if (what.type === 'drawing') {
      const now = JSON.parse(text) as unknown;
      if (!(path in base)) planned.drawings.push({ method: 'PUT', path: `/api/drawings/${what.id}`, ifMatch: '*', body: now, label: `add drawing details ${what.id}` });
      else if (!same(base[path], now)) planned.drawings.push({ method: 'PUT', path: `/api/drawings/${what.id}`, ifMatch: meta.etags[`drawing:${what.id}`] ?? '*', body: now, label: `change drawing details ${what.id}` });
    } else if (what.type === 'doc') {
      const key = `doc:${path}`;
      seen.add(key);
      const before = meta.hashes[key];
      if (before === sha(text)) continue;
      docs.push({
        method: 'PUT',
        path: `/api/docs/${path}`,
        ifMatch: before === undefined ? contentETag(null) : (meta.etags[key] as string),
        body: docValue(path, text),
        label: `${before === undefined ? 'add' : 'change'} document ${path}`,
      });
    } else {
      const key = `file:${path}`;
      seen.add(key);
      if (meta.hashes[key] !== sha(text)) unsupported.push(path);
    }
  }
  // the wire parts library
  if (wire.parts !== undefined || wire.recipes !== undefined) planWireLibrary(wire, baseOf, meta.etags['wire-library'], planned);
  const present = new Set([...current.keys()]);
  // files with their own routes that were pulled and are gone now: only a deleted design takes its drawing details with it
  for (const path of Object.keys(base)) {
    if (present.has(path)) continue;
    const what = classify(path);
    if (what.type === 'drawing' && !present.has(`data/designs/${what.id}.json`)) continue;
    unsupported.push(`${path} was removed, and no route removes it`);
  }
  // records and files that were pulled and are gone now
  for (const key of Object.keys(meta.hashes)) {
    if (seen.has(key)) continue;
    if (key.startsWith('design:')) {
      const id = key.slice('design:'.length);
      if (!present.has(`data/designs/${id}.json`)) deletes.push({ method: 'DELETE', path: `/api/designs/${id}`, body: { confirm: id }, label: `delete design ${id}` });
    } else if (key.startsWith('definition:')) {
      const [kind, id] = key.slice('definition:'.length).split('/') as [DefinitionKind, string];
      // a record missing from a list that still exists, or from a list file that is gone
      deletes.push({ method: 'DELETE', path: `/api/definitions/${kind}/${id}`, body: { confirm: id }, label: `delete ${kind.replace(/s$/, '')} ${id}` });
    } else if (key.startsWith('doc:')) {
      const path = key.slice('doc:'.length);
      if (!present.has(path)) deletes.push({ method: 'DELETE', path: `/api/docs/${path}`, ifMatch: meta.etags[key] as string, label: `delete document ${path}` });
    }
  }
  // vocabulary and wire parts first (records use them), definitions next, then what builds on them, deletions last
  return {
    requests: [
      ...planned.vocabPatches,
      ...planned.vocabPosts,
      ...planned.wireParts,
      ...planned.wireStocks,
      ...creates,
      ...updates,
      ...designs,
      ...planned.drawings,
      ...planned.builds,
      ...planned.tags,
      ...docs,
      ...deletes,
    ],
    unsupported,
  };
}

/* ------------------------------------------------------------------ *
 * Pushing
 * ------------------------------------------------------------------ */

export interface PushOptions {
  dryRun: boolean;
  message?: string;
  /** hold edit leases on the records for the length of the push (`--lock`) */
  lock?: boolean;
  log?: (line: string) => void;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** the server's would-be (dry run) or made change set, as it answered */
  changes: { kind: string; key: string; op: string; diff?: string[] }[];
  failed?: { index: number; label: string; status: number; message: string };
  committed: boolean;
}

/** `studio-api push <dir>` */
export async function push(client: ApiClient, dir: string, options: PushOptions): Promise<PushResult> {
  const log = options.log ?? (() => {});
  const identity = await client.checkEnvironment();
  const plan = planPush(dir);
  if (plan.unsupported.length > 0) {
    throw new ApiClientError(`These changed files have no write route and cannot be pushed:\n  ${plan.unsupported.join('\n  ')}\nRevert them, or make the change in the studio.`);
  }
  if (plan.requests.length === 0) {
    log('Nothing to push: no file differs from what was pulled.');
    return { ok: true, status: 200, changes: [], committed: false };
  }
  if (plan.requests.length > 200) throw new ApiClientError(`${plan.requests.length} changes are more than one batch holds (200). Split the work into smaller pushes.`);
  const body = {
    ...(options.message === undefined ? {} : { message: options.message }),
    dryRun: options.dryRun,
    requests: plan.requests.map((r) => ({ method: r.method, path: r.path, ...(r.ifMatch === undefined ? {} : { ifMatch: r.ifMatch }), ...(r.body === undefined ? {} : { body: r.body }) })),
  };
  let leases: Leases | undefined;
  const headers: Record<string, string> = {};
  try {
    if (options.lock === true && !options.dryRun) {
      leases = await takeLeases(client, plan.requests, identity.user?.name ?? 'API client');
      if (leases.refused !== undefined) throw new ApiClientError(leases.refused);
      headers[LOCK_HEADER] = leases.header();
    }
    const answer = await client.request('POST', '/api/batch', { body, headers });
    const result = answer.body as {
      committed?: boolean;
      dryRun?: boolean;
      failed?: number;
      error?: string;
      results?: { status: number; body: unknown }[];
      changes?: PushResult['changes'];
    };
    if (answer.status >= 400) {
      const index = typeof result?.failed === 'number' ? result.failed : -1;
      const failedResult = index >= 0 ? result.results?.[index] : undefined;
      const message = describeFailure(answer.status, result, failedResult);
      return {
        ok: false,
        status: answer.status,
        changes: [],
        committed: false,
        failed: { index, label: index >= 0 ? (plan.requests[index]?.label ?? '') : '', status: failedResult?.status ?? answer.status, message },
      };
    }
    return { ok: true, status: answer.status, changes: result.changes ?? [], committed: result.committed === true };
  } finally {
    await leases?.release();
  }
}

function describeFailure(status: number, result: { error?: string } | undefined, failed: { status: number; body: unknown } | undefined): string {
  const inner = failed?.body as { error?: string; hint?: string } | undefined;
  if (failed?.status === 409 || status === 409) return `${inner?.error ?? result?.error ?? 'A record changed since the pull.'} Pull again, reapply your edits, and push; nothing was written.`;
  if (failed?.status === 423 || status === 423) return `${inner?.error ?? result?.error ?? 'A record is being edited by someone else.'} Nothing was written.`;
  return [inner?.error ?? result?.error ?? `The server answered ${status}.`, inner?.hint].filter((s) => s !== undefined && s !== '').join(' ');
}

/** The lines `studio-api` prints for a result. */
export function formatResult(result: PushResult, dryRun: boolean): string[] {
  if (!result.ok) return [`Refused${result.failed === undefined || result.failed.index < 0 ? '' : ` at ${result.failed.label}`}: ${result.failed?.message ?? `status ${result.status}`}`, 'Nothing was written.'];
  const lines: string[] = [];
  for (const change of result.changes) {
    lines.push(`${change.op.padEnd(6)} ${change.kind} ${change.key}`);
    for (const line of change.diff ?? []) lines.push(`  ${line}`);
  }
  lines.push(dryRun ? `Dry run: ${result.changes.length} record(s) would change; nothing was written.` : `Pushed: ${result.changes.length} record(s) in one change set.`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Leases for a long batch (`push --lock`)
 * ------------------------------------------------------------------ */

interface Leases {
  refused?: string;
  header(): string;
  release(): Promise<void>;
}

async function takeLeases(client: ApiClient, requests: readonly PlannedRequest[], person: string): Promise<Leases> {
  const id12 = (/^cst_(?:dev|prod)_([0-9a-f]{12})_/.exec(client.config.token)?.[1]) ?? 'unknown00000';
  // one run id for this process: leases are this run's
  const tabId = `run-${createHash('sha256').update(`${id12}:${requests.map((r) => r.path).join(',')}:${process.pid}`).digest('hex').slice(0, 12)}`;
  const holder = { name: person, clientId: `api:${id12}`, tabId };
  const records = [...new Set(requests.flatMap((r) => recordsOfWrite(r.method, r.path, r.body)))];
  const held = new Map<string, string>();
  const release = async (): Promise<void> => {
    clearInterval(timer);
    for (const [record, token] of held) await client.request('POST', '/api/locks/release', { body: { record, token } }).catch(() => undefined);
    held.clear();
  };
  const timer = setInterval(() => {
    for (const [record, token] of held) void client.request('POST', '/api/locks/heartbeat', { body: { record, token, holder } }).catch(() => undefined);
  }, HEARTBEAT_MS);
  timer.unref();
  for (const record of records) {
    const answer = await client.request('POST', '/api/locks/acquire', { body: { record, holder } });
    if (answer.status !== 200) {
      const lock = (answer.body as { lock?: { holder?: { name?: string } }; error?: string } | undefined);
      await release();
      return { refused: `${record} is held${lock?.lock?.holder?.name === undefined ? '' : ` by ${lock.lock.holder.name}`}; nothing was written.`, header: () => '', release: async () => undefined };
    }
    held.set(record, (answer.body as { token: string }).token);
  }
  return { header: () => [...held.values()].join(', '), release };
}

/** For a test or a caller that wants the bytes of a pulled file. */
export function pulledFile(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf8');
}

export function isPulledDir(dir: string): boolean {
  return existsSync(join(dir, META_FILE)) && statSync(dir).isDirectory();
}
