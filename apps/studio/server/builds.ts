/**
 * Board builds — `packages/catalog/data/builds/<board>.json` (data model v2
 * §3.2, §9 task 10): the build editor's endpoints.
 *
 *   GET /api/builds          every build file, with the checks core runs on it
 *   GET /api/builds/:name    one file (ETag)
 *   PUT /api/builds/:name    validate, then write  { file }   (If-Match required once the file exists)
 *
 * The rules are the workbench's: **validate before write** — the candidate
 * goes through core's `validateBoardBuilds` together with every other build
 * file and the live definitions, and an error that is the candidate's own
 * refuses the save (422, nothing written); **names are slugs** — the name in
 * the path must be the one the file's board and revision make
 * (`buildsFileName`), so a save can never land on another board's file;
 * **`src` is required** on every build. A save does not regenerate the
 * board's definitions: a new build becomes definitions when the board's
 * import is re-run (the board page says so).
 *
 * Pure: request in, response out; `BuildsStore` is the only door to disk.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { dataPath } from '@wirehub/catalog';
import { buildsFileName, canonicalBuildsFile, errors, validateBoardBuilds, type BoardBuilds, type Db, type Issue } from '@wirehub/model';

import type { ApiError, ApiResponse } from './api.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { writeFileAtomic } from './atomic-write.ts';
import type { Awaitable } from './storage/change-set.ts';

export interface BuildsStore {
  /** every file, by name, in name order */
  list(): Awaitable<{ name: string; file: BoardBuilds }[]>;
  read(name: string): Awaitable<BoardBuilds | undefined>;
  write(name: string, file: BoardBuilds): Awaitable<void>;
}

export interface BuildsDeps {
  builds?: BuildsStore;
  loadDb: () => Awaitable<Db>;
}

export const BUILDS_ROUTES = ['GET    /api/builds', 'GET    /api/builds/:name', 'PUT    /api/builds/:name'] as const;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 2-space JSON with a trailing newline — the form every build file is in. */
function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fileBuildsStore(dir = dataPath('builds')): BuildsStore {
  const path = (name: string): string => `${dir}/${name}.json`;
  return {
    list: () =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ name: f.slice(0, -'.json'.length), file: JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as BoardBuilds })),
    read(name) {
      if (!NAME.test(name) || !existsSync(path(name))) return undefined;
      return JSON.parse(readFileSync(path(name), 'utf8')) as BoardBuilds;
    },
    write(name, file) {
      if (!NAME.test(name)) throw new Error(`'${name}' is not a build file name`);
      const text = formatJson(file);
      if (existsSync(path(name)) && readFileSync(path(name), 'utf8') === text) return;
      writeFileAtomic(path(name), text, 'utf8');
    },
  };
}

function fail(status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse {
  const body: ApiError = { error, ...(hint === undefined ? {} : { hint }) };
  if (issues !== undefined) body.issues = issues;
  return { status, body };
}

function ok(body: unknown, headers?: Record<string, string>): ApiResponse {
  return { status: 200, body, ...(headers === undefined ? {} : { headers }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The shape gate before the validator: is this a build file at all? */
export function readBuildsBody(value: unknown): { ok: true; file: BoardBuilds } | { ok: false; response: ApiResponse } {
  const say = (error: string, hint: string): { ok: false; response: ApiResponse } => ({ ok: false, response: fail(400, error, hint) });
  const file = isObject(value) && isObject(value['file']) ? value['file'] : undefined;
  if (file === undefined) return say('That is not a build file.', 'Send { file: { board, label, end, builds: [ … ] } }.');
  if (!filled(file['board'])) return say('The build file names no board.', 'Give the board part number, as the netlist spells it (PCA-00001).');
  if (file['revision'] !== undefined && !filled(file['revision'])) return say('The revision is blank.', 'Leave it out, or name it (Rev5).');
  if (!filled(file['label'])) return say('The build file has no label.', 'Name the board the way the build sheet does.');
  if (file['end'] !== 'source' && file['end'] !== 'destination' && file['end'] !== 'inline') {
    return say('The board end is not source, destination or inline.', 'Pick which end of the cable the board sits at.');
  }
  if (!Array.isArray(file['builds']) || file['builds'].length === 0) return say('The file has no builds.', 'A board has at least one build.');
  for (const [n, build] of file['builds'].entries()) {
    if (!isObject(build) || !filled(build['key']) || !NAME.test(build['key'])) {
      return say(`Build ${n + 1} has no usable key.`, 'A key is lowercase words joined by hyphens (term-on).');
    }
    if (typeof build['build'] !== 'string') return say(`Build '${build['key']}' does not say what it is.`, 'Fill in the build line the definition carries.');
    if (!filled(build['src'])) return say(`Build '${build['key']}' has no src.`, 'Say where the population comes from — the board designer, a placement file, a datasheet.');
  }
  for (const key of ['settings', 'footprints', 'exclusive', 'hazards'] as const) {
    if (file[key] !== undefined && !Array.isArray(file[key])) return say(`'${key}' is not a list.`, 'Send it as a list, or leave it out.');
  }
  // the committed key order, whatever order a form sent them in
  return { ok: true, file: canonicalBuildsFile(file as unknown as BoardBuilds) };
}

/** Core's checks over every file, with the candidate standing in for its own name. */
async function check(store: BuildsStore, db: Db, name: string, candidate?: BoardBuilds): Promise<Issue[]> {
  const files = (await store.list()).filter((f) => f.name !== name).map((f) => f.file);
  if (candidate !== undefined) files.push(candidate);
  return validateBoardBuilds(files, {
    pcbas: db.pcbas,
    ...(db.interfaces === undefined ? {} : { interfaces: db.interfaces }),
    ...(db.vocab === undefined ? {} : { vocab: db.vocab }),
  });
}

/** The issues that are this file's own: `builds/<key>…`. */
function own(issues: readonly Issue[], file: BoardBuilds): Issue[] {
  const key = file.revision === undefined ? file.board : `${file.board} ${file.revision}`;
  const at = `builds/${key}`;
  return issues.filter((i) => i.where === at || (i.where ?? '').startsWith(`${at}/`));
}

async function putBuilds(deps: BuildsDeps, store: BuildsStore, name: string, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const parsed = readBuildsBody(body);
  if (!parsed.ok) return parsed.response;
  const file = parsed.file;
  const expected = buildsFileName(file);
  if (expected !== name) {
    return fail(400, `This file is for ${file.board}${file.revision === undefined ? '' : ` ${file.revision}`}, which lives in '${expected}', not '${name}'.`, 'Save it under its own name.');
  }
  const current = await store.read(name);
  if (current !== undefined) {
    const guard = checkIfMatch(ifMatch, contentETag(current), 'build file', name);
    if (guard !== undefined) return guard;
  }
  const issues = own(await check(store, await deps.loadDb(), name, file), file);
  const failures = errors(issues);
  if (failures.length > 0) {
    return fail(
      422,
      failures.length === 1 ? `${file.board} has a build problem to fix before it can be saved.` : `${file.board} has ${failures.length} build problems to fix before it can be saved.`,
      'Nothing was written — the build file on disk is untouched.',
      issues,
    );
  }
  await store.write(name, file);
  const stored = await store.read(name) ?? file;
  return ok({ name, file: stored, etag: contentETag(stored), issues, created: current === undefined }, { ETag: contentETag(stored) });
}

/** Everything under `/api/builds`; `undefined` for any other path. */
export async function handleBuildsRequest(method: string, parts: string[], body: unknown, deps: BuildsDeps, ifMatch?: string): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'builds') return undefined;
  const [, , name, ...rest] = parts;
  if (rest.length > 0) return undefined;
  const store = deps.builds;
  if (store === undefined) return fail(501, 'This studio does not keep board build files.', 'The builds are read-only here.');
  if (name === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const db = await deps.loadDb();
    const all = await store.list();
    const issues = await check(store, db, '');
    return ok({ files: all.map((f) => ({ ...f, etag: contentETag(f.file), issues: own(issues, f.file) })) });
  }
  if (!NAME.test(name)) return fail(400, `${JSON.stringify(name)} is not a build file name.`, 'Names are the board part number in lowercase (PCA-00001), with the revision when the file is per revision.');
  if (method === 'GET') {
    const file = await store.read(name);
    if (file === undefined) return fail(404, `There is no build file '${name}'.`, 'Start one from the board page: Builds › New build file.');
    return ok({ name, file, etag: contentETag(file), issues: own(await check(store, await deps.loadDb(), name, file), file) }, { ETag: contentETag(file) });
  }
  if (method === 'PUT') return await putBuilds(deps, store, name, body, ifMatch);
  return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
}
