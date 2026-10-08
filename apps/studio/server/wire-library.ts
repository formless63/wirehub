/**
 * The wire builder's endpoints — the parts library and
 * the stock recipes, request in, response out, no IO (the store is below).
 *
 *   GET  /api/wire-library               parts + recipes
 *   POST /api/wire-library/parts         add a part to the library
 *   PUT  /api/wire-library/stocks/:id    save a stock from its recipe
 *                                        (body `{ recipe, create? }`)
 *
 * A stock save compiles the recipe (`compileWire`) and writes **both** the
 * recipe (`wire-recipes.json`) and the compiled `WireDefinition`
 * (`wires.json`, the record every other document reads), after the same
 * whole-library gate the definition editors use: the candidate library and
 * every design are validated, and only what this save *introduced* refuses
 * it. `src` is required on every part and every recipe.
 */

import { existsSync, readFileSync } from 'node:fs';

import { dataPath } from '@wirehub/catalog';
import {
  compileWire,
  errors,
  validateWireParts,
  WIRE_PART_KINDS,
  type CableDesign,
  type Db,
  type Issue,
  type WireDefinition,
  type StripPractice,
  type WireLibrary,
  type WirePart,
  type WireRecipe,
} from '@wirehub/model';

import type { ApiResponse } from './api.ts';
import { readAllDesigns, type DesignStore } from './designs.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { isDefinitionId, libraryIssues } from './definitions.ts';
import { writeFileAtomic } from './atomic-write.ts';
import { localValueFor, readCatalogJson } from './catalog-files.ts';
import { patchJsonText } from './json-text.ts';
import type { Awaitable } from './storage/change-set.ts';

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

export interface WireLibraryStore {
  read(): Awaitable<WireLibrary>;
  writeParts(parts: WirePart[]): Awaitable<void>;
  writeRecipes(recipes: WireRecipe[]): Awaitable<void>;
  /** the stocks on file, `wires.json` */
  wires(): Awaitable<WireDefinition[]>;
  /** replace (same id) or append a stock in `wires.json` */
  putWire(wire: WireDefinition): Awaitable<void>;
  /** the bench's strip steps, `strip-practice.json` — read-only here */
  practice?(): Awaitable<StripPractice[]>;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The catalog files, each written atomically (`atomic-write.ts`). A stock is
 * put by parsing `wires.json`, replacing or appending the record, and
 * serializing through `patchJsonText`, which leaves every untouched record's
 * hand formatting byte-for-byte alone.
 */
export function fileWireLibraryStore(): WireLibraryStore {
  // parts, recipes and strip practice: the catalog's own with the installed packs' under them (`catalog-files.ts`), as on pg
  const read = <T>(name: string): T[] => readCatalogJson<T[]>(name) ?? [];
  // a pack's records stay in the pack; only local and edited ones are stored here
  const writeLocal = (name: string, merged: unknown[]): void => {
    const next = localValueFor(name, merged);
    if (next !== undefined) writeFileAtomic(dataPath(name), json(next), 'utf8');
  };
  return {
    read: () => ({ parts: read<WirePart>('wire-parts.json'), recipes: read<WireRecipe>('wire-recipes.json') }),
    writeParts: (parts) => writeLocal('wire-parts.json', parts),
    writeRecipes: (recipes) => writeLocal('wire-recipes.json', recipes),
    // stocks: the catalog's own with the installed packs' under them
    wires: () => readCatalogJson<WireDefinition[]>('wires.json') ?? [],
    practice: () => read<StripPractice>('strip-practice.json'),
    putWire: (wire) => {
      const path = dataPath('wires.json');
      const text = existsSync(path) ? readFileSync(path, 'utf8') : '[]\n';
      const stocks = readCatalogJson<WireDefinition[]>('wires.json') ?? [];
      const at = stocks.findIndex((stock) => stock.id === wire.id);
      const merged = at === -1 ? [...stocks, wire] : stocks.map((stock, i) => (i === at ? wire : stock));
      // a pack's stocks stay in the pack; only local and edited ones are stored here
      const next = localValueFor('wires.json', merged);
      if (next === undefined) return;
      // parse → edit → serialize; untouched stocks keep their bytes (json-text.ts)
      writeFileAtomic(path, patchJsonText(text, next), 'utf8');
    },
  };
}

/** An in-memory store, for tests. */
export function memoryWireLibraryStore(initial: WireLibrary, wires: WireDefinition[], practice?: StripPractice[]): WireLibraryStore {
  let library = structuredClone(initial);
  let stocks = structuredClone(wires);
  return {
    ...(practice === undefined ? {} : { practice: () => structuredClone(practice) }),
    read: () => structuredClone(library),
    writeParts: (parts) => {
      library = { ...library, parts: structuredClone(parts) };
    },
    writeRecipes: (recipes) => {
      library = { ...library, recipes: structuredClone(recipes) };
    },
    wires: () => structuredClone(stocks),
    putWire: (wire) => {
      const at = stocks.findIndex((stock) => stock.id === wire.id);
      stocks = at === -1 ? [...stocks, wire] : stocks.map((stock, i) => (i === at ? wire : stock));
    },
  };
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

export interface WireLibraryDeps {
  wireLibrary?: WireLibraryStore;
  designs: DesignStore;
  loadDb: () => Awaitable<Db>;
}

export const WIRE_LIBRARY_ROUTES = [
  'GET    /api/wire-library',
  'POST   /api/wire-library/parts',
  'PUT    /api/wire-library/stocks/:id',
  'GET    /api/wire-library/strip-practice',
] as const;

function fail(status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }), ...(issues === undefined ? {} : { issues }) } };
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): ApiResponse {
  return { status, body, ...(headers === undefined ? {} : { headers }) };
}

/**
 * One version for the parts library and the recipes together: what `GET`
 * hands out and what a stock edit must quote back as `If-Match`.
 */
async function libraryTag(store: WireLibraryStore): Promise<Record<string, string>> {
  return { ETag: contentETag(await store.read()) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

const ID_RULE = 'Ids are lowercase words joined by hyphens, like `c-tc-11x010-generic`.';

async function postPart(store: WireLibraryStore, body: unknown): Promise<ApiResponse> {
  const part = isObject(body) && isObject(body['part']) ? body['part'] : body;
  if (!isObject(part)) return fail(400, 'That is not a wire part.', 'Send one part record.');
  if (!(WIRE_PART_KINDS as readonly unknown[]).includes(part['kind'])) {
    return fail(400, `${JSON.stringify(String(part['kind']))} is not a kind of wire part.`, `Pick one of: ${WIRE_PART_KINDS.join(', ')}.`);
  }
  if (!isDefinitionId(part['id'])) return fail(400, `${JSON.stringify(String(part['id']))} cannot be used as a part id.`, ID_RULE);
  if (!filled(part['label'])) return fail(400, 'This part has no name.', 'Give it a label — what the picker will list it as.');
  if (!filled(part['src'])) {
    return fail(400, 'This part does not say where its values come from.', 'Cite the vendor sheet, a measurement, or say the values are inferred.');
  }
  const library = await store.read();
  if (library.parts.some((existing) => existing.id === part['id'])) {
    return fail(409, `The parts library already has '${String(part['id'])}'.`, 'Choose a different id.');
  }
  const next = [...library.parts, part as unknown as WirePart];
  const problems = errors(validateWireParts(next)).filter((issue) => issue.where === `wire-parts/${String(part['id'])}`);
  if (problems.length > 0) {
    return fail(422, 'That part could not be added.', 'Nothing was written.', problems);
  }
  await store.writeParts(next);
  return ok(part, 201, await libraryTag(store));
}

async function everyDesign(deps: WireLibraryDeps): Promise<CableDesign[]> {
  return readAllDesigns(deps.designs);
}

function issueKey(issue: Issue): string {
  return `${issue.code} ${issue.where ?? ''} ${issue.message}`;
}

async function putStock(deps: WireLibraryDeps, store: WireLibraryStore, id: string, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  if (!isDefinitionId(id)) return fail(400, `${JSON.stringify(id)} cannot be used as a wire stock id.`, ID_RULE);
  if (!isObject(body) || !isObject(body['recipe'])) return fail(400, 'That is not a stock recipe.', 'Send `{ recipe }`.');
  const recipe = body['recipe'] as unknown as WireRecipe;
  const create = body['create'] === true;
  if (recipe.id !== id) return fail(400, `This save is for '${id}', but the recipe says '${String(recipe.id)}'.`, 'Save it under its own id.');
  if (!filled(recipe.label)) return fail(400, 'This stock has no name.', 'Give it a label — what a builder calls the reel.');
  if (!filled(recipe.src)) {
    return fail(400, 'This stock does not say where its information comes from.', 'Cite the vendor sheet or say it is inferred.');
  }
  if (!Array.isArray(recipe.cores) || recipe.cores.length === 0) return fail(400, 'This stock has no cores.', 'Add at least one core.');

  const library = await store.read();
  // editing an existing stock: it must say which library version it was made from
  if (!create) {
    const guard = checkIfMatch(ifMatch, contentETag(library), 'wire stock', id);
    if (guard !== undefined) return guard;
  }
  const compiled = compileWire(recipe, library.parts);
  const compileErrors = errors(compiled.issues);
  if (compileErrors.length > 0) {
    return fail(422, 'This stock does not compile from its parts.', 'Nothing was written.', compileErrors);
  }

  const db = await deps.loadDb();
  const exists = db.wires.some((wire) => wire.id === id);
  if (create) {
    const taken = [...db.connectors, ...db.components, ...db.wires, ...db.pcbas, ...(db.mechanicals ?? [])].some(
      (record) => record.id === id,
    );
    if (taken) return fail(409, `Something in the library is already called '${id}'.`, 'Choose a different id.');
  } else if (!exists) {
    return fail(404, `There is no wire stock called '${id}'.`, 'Create it instead.');
  }

  const wires = exists ? db.wires.map((wire) => (wire.id === id ? compiled.wire : wire)) : [...db.wires, compiled.wire];
  const designs = await everyDesign(deps);
  const introduced = errors(libraryIssues({ ...db, wires }, designs));
  if (introduced.length > 0) {
    const before = new Set(errors(libraryIssues(db, designs)).map(issueKey));
    const blocking = introduced.filter((issue) => !before.has(issueKey(issue)));
    if (blocking.length > 0) {
      return fail(
        422,
        blocking.length === 1 ? 'Saving this stock would break something.' : `Saving this stock would break ${blocking.length} things.`,
        'Nothing was written — the catalog is untouched.',
        blocking,
      );
    }
  }

  await store.putWire(compiled.wire);
  const recipes = library.recipes.some((r) => r.id === id)
    ? library.recipes.map((r) => (r.id === id ? recipe : r))
    : [...library.recipes, recipe];
  await store.writeRecipes(recipes);
  return ok({ wire: compiled.wire, recipe, derived: compiled.derived, issues: compiled.issues }, create ? 201 : 200, await libraryTag(store));
}

/**
 * Everything under `/api/wire-library`; `undefined` for any other path, so
 * `api.ts` offers it every request and carries on when it is not this one's.
 */
export async function handleWireLibraryRequest(
  method: string,
  parts: string[],
  body: unknown,
  deps: WireLibraryDeps,
  ifMatch?: string,
): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'wire-library') return undefined;
  const store = deps.wireLibrary;
  if (store === undefined) {
    return fail(501, 'This hub does not keep a wire parts library.', 'The stocks still load; building one from parts needs a full WireHub server.');
  }
  const [, , section, id, ...rest] = parts;
  if (rest.length > 0) return undefined;
  if (section === undefined) {
    return method === 'GET' ? ok(await store.read(), 200, await libraryTag(store)) : fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
  }
  if (section === 'strip-practice' && id === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return ok(store.practice === undefined ? [] : await store.practice());
  }
  if (section === 'parts' && id === undefined) {
    return method === 'POST' ? await postPart(store, body) : fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
  }
  if (section === 'stocks' && id !== undefined) {
    return method === 'PUT' ? await putStock(deps, store, id, body, ifMatch) : fail(405, `${method} is not something this address accepts.`, 'It answers PUT.');
  }
  return undefined;
}
