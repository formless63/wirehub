/**
 * The device resolver over the API (`@wirehub/model` `resolve.ts`, `docs/resolver.md`):
 *
 *   GET  /api/resolver                         devices, conditioning recipes, hazards and the policy in force
 *                                              (local and from packs), their issues, each file's ETag
 *   PUT  /api/resolver/devices|recipes|hazards { <list>: [...] } — replace this hub's own list (If-Match)
 *   PUT  /api/resolver/policy                  { policy } — the ranking policy; { policy: null } removes it
 *   GET  /api/resolver/resolve?source=&sourcePort=&destination=&destinationPort=[&boards=0]
 *                                              the ranked options, the refused ones and why, the stocks that fit each
 *   GET  /api/resolver/derive?…&option=&stock=&lengthMm=&id=&label=
 *                                              the proposed design (not written: POST it to /api/designs)
 *   GET  /api/resolver/designs/:id             a design against its recipe: drift, or the inferred recipe of a
 *                                              hand design; the joints the recipe would add; the re-derived body
 *
 * The lists are catalog documents (`data/devices.json`, `data/conditioning-recipes.json`,
 * `data/hazards.json`, `data/resolver-policy.json`), written through the unit of work like the
 * validation rules, so both backends keep them with the catalog. A data pack ships the same files
 * (merged, or layered under); a record saved here with a pack record's id shadows it.
 */

import {
  BUILT_IN_HAZARDS,
  DEFAULT_RESOLVER_POLICY,
  RANK_CRITERIA,
  deriveCable,
  describeOverride,
  deviceLibraryIssues,
  inferCableRecipe,
  policyInForce,
  recipeDrift,
  recipeJointProposals,
  rederive,
  resolve,
  suggestStocks,
  validateDesign,
  type Db,
  type ResolveQuery,
} from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { withDesignLibrary } from './assemblies.ts';
import { checkIfMatch, contentETag } from './etag.ts';

export const RESOLVER_ROUTES = [
  'GET    /api/resolver',
  'PUT    /api/resolver/devices',
  'PUT    /api/resolver/recipes',
  'PUT    /api/resolver/hazards',
  'PUT    /api/resolver/policy',
  'GET    /api/resolver/resolve',
  'GET    /api/resolver/derive',
  'GET    /api/resolver/designs/:id',
] as const;

export const isResolverPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'resolver';

/** The four documents, by the name the routes use. */
export const RESOLVER_FILES = {
  devices: 'devices.json',
  recipes: 'conditioning-recipes.json',
  hazards: 'hazards.json',
  policy: 'resolver-policy.json',
} as const;

type ListName = 'devices' | 'recipes' | 'hazards';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

const docPath = (name: keyof typeof RESOLVER_FILES): string => `data/${RESOLVER_FILES[name]}`;

async function localList(deps: WorkbenchDeps, name: ListName): Promise<Record<string, unknown>[]> {
  const stored = await deps.docs?.read(docPath(name));
  return Array.isArray(stored) ? (stored as Record<string, unknown>[]) : [];
}

async function localPolicy(deps: WorkbenchDeps): Promise<Record<string, unknown> | undefined> {
  const stored = await deps.docs?.read(docPath('policy'));
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : undefined;
}

/** Which pack ships which record of `file`. */
async function packOwners(deps: WorkbenchDeps, file: string): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const pack of (await deps.installedPacks?.())?.packs ?? []) for (const id of pack.added[file] ?? []) if (!owners.has(id)) owners.set(id, pack.id);
  return owners;
}

/** `db`: the library as a write in this request leaves it (the unit of work commits after the answer). */
async function view(deps: WorkbenchDeps, db?: Db): Promise<{ body: Record<string, unknown>; etags: Record<string, string> }> {
  db ??= await deps.loadDb();
  const origin = async (file: string, records: readonly { id: string }[], local: readonly Record<string, unknown>[]) => {
    // a record a pack's install record lists is the pack's, layered or merged; a local record of the same id shadows (or, merged, edits) it
    const owners = await packOwners(deps, file);
    const localIds = new Set(local.map((r) => String(r['id'])));
    return records.map((r) => {
      const pack = owners.get(r.id);
      return { ...r, origin: pack === undefined ? 'local' : 'pack', ...(pack === undefined ? {} : { pack }), ...(pack !== undefined && localIds.has(r.id) ? { held: true } : {}) };
    });
  };
  const local = { devices: await localList(deps, 'devices'), recipes: await localList(deps, 'recipes'), hazards: await localList(deps, 'hazards'), policy: await localPolicy(deps) };
  const etags = {
    devices: contentETag(local.devices.length === 0 ? null : local.devices),
    recipes: contentETag(local.recipes.length === 0 ? null : local.recipes),
    hazards: contentETag(local.hazards.length === 0 ? null : local.hazards),
    policy: contentETag(local.policy ?? null),
  };
  return {
    etags,
    body: {
      devices: await origin(RESOLVER_FILES.devices, db.devices ?? [], local.devices),
      recipes: await origin(RESOLVER_FILES.recipes, db.conditioningRecipes ?? [], local.recipes),
      hazards: { builtIn: BUILT_IN_HAZARDS, library: await origin(RESOLVER_FILES.hazards, db.hazards ?? [], local.hazards) },
      policy: { inForce: policyInForce(db), local: local.policy ?? null, default: DEFAULT_RESOLVER_POLICY, criteria: RANK_CRITERIA },
      local,
      issues: deviceLibraryIssues(db),
      etags,
    },
  };
}

function queryOf(params: URLSearchParams): ResolveQuery | undefined {
  const source = params.get('source');
  const destination = params.get('destination');
  if (source === null || destination === null || source === '' || destination === '') return undefined;
  const sp = params.get('sourcePort');
  const dp = params.get('destinationPort');
  return {
    source: { device: source, ...(sp === null || sp === '' ? {} : { port: sp }) },
    destination: { device: destination, ...(dp === null || dp === '' ? {} : { port: dp }) },
    ...(params.get('boards') === '0' ? { boards: false } : {}),
  };
}

async function putList(deps: WorkbenchDeps, name: ListName, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const local = await localList(deps, name);
  const guard = checkIfMatch(ifMatch, contentETag(local.length === 0 ? null : local), 'resolver', name);
  if (guard !== undefined) return guard;
  const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
  if (!Array.isArray(list)) return fail(400, `Send { "${name}": [ … ] }: this hub's own ${name}, replacing the ones it has.`, 'An empty list removes them all.');
  if (list.some((r) => typeof r !== 'object' || r === null || Array.isArray(r) || typeof (r as { id?: unknown }).id !== 'string')) {
    return fail(422, `Every entry of ${name} is a record with an id.`, 'Nothing was saved.');
  }
  // the library as it would be: the new local list over the packs' records of other ids
  const db = await deps.loadDb();
  const owners = await packOwners(deps, RESOLVER_FILES[name]);
  const key = name === 'devices' ? 'devices' : name === 'recipes' ? 'conditioningRecipes' : 'hazards';
  const ids = new Set(list.map((r) => (r as { id: string }).id));
  const fromPacks = ((db[key] ?? []) as { id: string }[]).filter((r) => owners.has(r.id) && !ids.has(r.id));
  const next: Db = { ...db, [key]: [...list, ...fromPacks] };
  const errors = deviceLibraryIssues(next).filter((i) => i.severity === 'error');
  if (errors.length > 0) return fail(422, `That ${name} list cannot be used: ${errors[0]!.message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}.`, 'Nothing was saved.', { issues: errors });
  // where a pack was merged into the catalog, its records sit in this document: the ones the body does not mention stay
  const kept = local.filter((r) => owners.has(String(r['id'])) && !ids.has(String(r['id'])));
  const stored = [...list, ...kept];
  if (stored.length === 0) await deps.docs!.remove(docPath(name));
  else await deps.docs!.write(docPath(name), stored);
  const fresh = await view(deps, next);
  return { status: 200, body: fresh.body, headers: { ETag: fresh.etags[name]! } };
}

async function putPolicy(deps: WorkbenchDeps, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const local = await localPolicy(deps);
  const guard = checkIfMatch(ifMatch, contentETag(local ?? null), 'resolver', 'policy');
  if (guard !== undefined) return guard;
  const policy = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { policy?: unknown }).policy : undefined;
  if (policy === null) {
    await deps.docs!.remove(docPath('policy'));
  } else {
    if (typeof policy !== 'object' || policy === undefined || Array.isArray(policy)) return fail(400, 'Send { "policy": { "order": [ … ], "src": "…" } }, or { "policy": null } to use the default.');
    const issues = deviceLibraryIssues({ ...(await deps.loadDb()), resolverPolicy: policy as never }).filter((i) => i.code.startsWith('policy-'));
    if (issues.length > 0) return fail(422, `That policy cannot be used: ${issues[0]!.message}.`, `The criteria are: ${RANK_CRITERIA.join(', ')}.`);
    await deps.docs!.write(docPath('policy'), policy);
  }
  const fresh = await view(deps, { ...(await deps.loadDb()), ...(policy === null ? { resolverPolicy: undefined } : { resolverPolicy: policy as never }) });
  return { status: 200, body: fresh.body, headers: { ETag: fresh.etags['policy']! } };
}

async function designReport(deps: WorkbenchDeps, id: string): Promise<ApiResponse> {
  const stored = await deps.designs.read(id);
  if (stored === undefined) return fail(404, `There is no design called '${id}'.`);
  const db = await withDesignLibrary(deps, stored, await deps.loadDb());
  if (stored.recipe === undefined) {
    const inferred = inferCableRecipe(stored, db);
    return { status: 200, body: { id, recipe: null, inference: inferred } };
  }
  const drift = recipeDrift(stored, db);
  const again = rederive(stored, db);
  return {
    status: 200,
    body: {
      id,
      recipe: stored.recipe,
      drift: { state: drift.state, differences: drift.differences.map((d) => ({ ...d, text: describeOverride(d) })), misses: drift.misses, ...(drift.reason === undefined ? {} : { reason: drift.reason }) },
      proposals: recipeJointProposals(stored, db),
      rederived: again.ok ? again.design : null,
    },
  };
}

export async function handleResolverRequest(method: string, parts: string[], path: string, body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined): Promise<ApiResponse> {
  const sub = parts[2];
  const params = new URLSearchParams(path.split('?')[1] ?? '');
  if (sub === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const v = await view(deps);
    return { status: 200, body: v.body };
  }
  if (sub === 'devices' || sub === 'recipes' || sub === 'hazards' || sub === 'policy') {
    if (parts.length !== 3) return fail(404, `${parts.join('/')} is not part of the workbench API.`, `Try ${RESOLVER_ROUTES.join('; ')}.`);
    if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers PUT; GET /api/resolver reads them.');
    if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'The resolver library is stored with the catalog.');
    return sub === 'policy' ? putPolicy(deps, body, ifMatch) : putList(deps, sub, body, ifMatch);
  }
  if (sub === 'resolve' || sub === 'derive') {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const query = queryOf(params);
    if (query === undefined) return fail(400, 'Name both ends: ?source=<device>&destination=<device> (and sourcePort, destinationPort when a device has several).');
    const db = await deps.loadDb();
    if (sub === 'resolve') {
      const resolution = resolve(db, query);
      return { status: 200, body: { ...resolution, stocks: Object.fromEntries(resolution.options.map((o) => [o.id, suggestStocks(db, o).slice(0, 5)])) } };
    }
    const lengthText = params.get('lengthMm');
    const lengthMm = lengthText === null || lengthText === '' ? undefined : Number(lengthText);
    if (lengthMm !== undefined && !(Number.isFinite(lengthMm) && lengthMm > 0)) return fail(400, 'lengthMm is a length in millimetres, more than zero.');
    const option = params.get('option') ?? undefined;
    const stock = params.get('stock') ?? undefined;
    const id = params.get('id') ?? undefined;
    const label = params.get('label') ?? undefined;
    const derived = deriveCable(db, query, option === '' ? undefined : option, {
      ...(stock === undefined || stock === '' ? {} : { stock }),
      ...(lengthMm === undefined ? {} : { lengthMm }),
      ...(id === undefined || id === '' ? {} : { id }),
      ...(label === undefined || label === '' ? {} : { label }),
    });
    if (!derived.ok) return fail(422, `No design can be derived: ${derived.reason}.`, 'Pick another option or stock, or add what is missing to the library.', { missing: derived.missing });
    const taken = await deps.designs.has(derived.design.id);
    return { status: 200, body: { design: derived.design, option: derived.option, stock: derived.stock, missing: derived.missing, issues: validateDesign(derived.design, db), idTaken: taken } };
  }
  if (sub === 'designs' && parts[3] !== undefined && parts.length === 4) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return designReport(deps, parts[3]);
  }
  return fail(404, `${parts.join('/')} is not part of the workbench API.`, `Try ${RESOLVER_ROUTES.join('; ')}.`);
}
