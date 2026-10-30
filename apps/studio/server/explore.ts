/**
 * Solution exploration over the API (`@wirehub/model` `explore.ts`, `docs/explore.md`):
 *
 *   GET  /api/explore                 saved explorations (requirement, overrides, what was picked),
 *                                     the enclosure presets in force, the document's ETag
 *   PUT  /api/explore/saved           { exploration: { key?, requirement, overrides, picked? } } — keep one
 *                                     (by its requirement key, If-Match on the document)
 *   DELETE /api/explore/saved?key=    forget one
 *   PUT  /api/explore/presets         { presets: [...] } — this hub's own enclosure presets (If-Match)
 *   POST /api/explore/run             { requirement, overrides? } — the exploration, with the saved overrides
 *                                     for that requirement, firmware projects and inventory availability
 *   POST /api/explore/pick            { requirement, combo, overrides?, id?, label? } — the combination made a
 *                                     draft (a design, or a shell mechanical) through the ordinary create
 *                                     route, and the pick kept on the saved exploration: one change set
 *
 * Saved explorations and presets are catalog documents (`data/explore/saved.json`,
 * `data/explore/presets.json`) written through the unit of work, so both backends keep them.
 * Declined board proposals stay in the proposals feature's one log (`data/proposals.json`).
 */

import { availabilityOf, explore, overrideProblems, pickConnect, pickEnclose, presetsInForce, requirementKey, requirementProblems, BUILT_IN_PRESETS, type EnclosurePreset, type ExploreOverride, type FirmwareCandidate, type NativeBoardFacts, type Requirement } from '@wirehub/model';

import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { buildsDoc, firmwareTargets, PROJECTS_DOC } from './firmware/api.ts';
import { nativeLookupOf } from './enclosures/api.ts';
import { explorePrinters } from './explore-printers.ts';
import type { FirmwareBuild, FirmwareProject } from '../src/firmware.ts';

export const EXPLORE_ROUTES = [
  'GET    /api/explore',
  'PUT    /api/explore/saved',
  'DELETE /api/explore/saved',
  'PUT    /api/explore/presets',
  'POST   /api/explore/run',
  'POST   /api/explore/pick',
] as const;

export const SAVED_DOC = 'data/explore/saved.json';
export const PRESETS_DOC = 'data/explore/presets.json';

export interface SavedExploration {
  key: string;
  label?: string;
  requirement: Requirement;
  overrides: ExploreOverride[];
  /** the combination picked and the record it became */
  picked?: { combo: string; kind: 'designs' | 'mechanicals'; id: string; by?: string; at?: string };
  by?: string;
  at?: string;
}

export const isExplorePath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'explore';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

async function readList<T>(deps: WorkbenchDeps, path: string): Promise<T[]> {
  const v = await deps.docs?.read(path);
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Firmware projects reduced to what exploration reads, with each one's latest build status. */
export async function firmwareCandidates(deps: WorkbenchDeps): Promise<FirmwareCandidate[]> {
  const projects = await readList<FirmwareProject>(deps, PROJECTS_DOC);
  const out: FirmwareCandidate[] = [];
  for (const p of projects) {
    const last = (await readList<FirmwareBuild>(deps, buildsDoc(p.id)))[0];
    out.push({ id: p.id, label: p.label, ...(p.board === undefined ? {} : { board: p.board }), target: p.toolchain.target, ...(last === undefined ? {} : { lastBuild: last.status }) });
  }
  return out;
}

function presetProblems(list: unknown): string[] {
  if (!Array.isArray(list)) return ['presets is a list.'];
  const out: string[] = [];
  const ids = new Set<string>();
  for (const p of list as Partial<EnclosurePreset>[]) {
    if (typeof p?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) { out.push('Each preset has a kebab-case id.'); continue; }
    if (ids.has(p.id)) out.push(`Two presets are called ${p.id}.`);
    ids.add(p.id);
    if (typeof p.label !== 'string' || p.label.trim() === '') out.push(`${p.id}: a label is needed.`);
    if (typeof p.src !== 'string' || p.src.trim() === '') out.push(`${p.id}: say where the values come from (src).`);
    if (typeof p.params !== 'object' || p.params === null || Array.isArray(p.params)) out.push(`${p.id}: params is an object of enclosure parameters.`);
    else for (const [k, v] of Object.entries(p.params)) if (typeof v === 'number' && !(Number.isFinite(v) && v >= 0)) out.push(`${p.id}: ${k} is not a non-negative number.`);
  }
  return out;
}

/** The ordinary router, for a pick's create (validated, permission-checked and staged like any create). */
export type ExploreRoute = (request: ApiRequest, deps: WorkbenchDeps) => Promise<ApiResponse>;

/** One exploration with everything it consults: the library, firmware, inventory, and the board's own source. */
async function runExploration(deps: WorkbenchDeps, requirement: Requirement, overrides: readonly ExploreOverride[], presets: EnclosurePreset[]): Promise<{ exploration: ReturnType<typeof explore>; native: boolean; db: Awaited<ReturnType<WorkbenchDeps['loadDb']>> }> {
  const db = await deps.loadDb();
  let availability: Record<string, number> | undefined;
  if (deps.inventory !== undefined) availability = availabilityOf(await deps.inventory.read((tx) => tx.lots({})));
  // what the board's own KiCad source states (thickness, part heights, edge ports), for facts no enclosure states
  let native: Record<string, NativeBoardFacts> | undefined;
  if (requirement.kind === 'enclose') {
    const found = await nativeLookupOf(deps)(requirement.board);
    if (!('missing' in found)) {
      const f = found.geometry.facts;
      native = { [requirement.board]: {
        ...(f?.thicknessMm === undefined ? {} : { thicknessMm: f.thicknessMm }),
        ...(f?.heightAboveMm === undefined ? {} : { heightAboveMm: f.heightAboveMm }),
        ...(f?.heightBelowMm === undefined ? {} : { heightBelowMm: f.heightBelowMm }),
        ports: found.geometry.suggestedPorts,
      } };
    }
  }
  const exploration = explore(db, requirement, {
    firmware: await firmwareCandidates(deps),
    targets: firmwareTargets().map((t) => ({ id: t.id, label: t.label })),
    presets,
    ...(requirement.kind === 'enclose' ? { printers: await explorePrinters(deps) } : {}),
    ...(availability === undefined ? {} : { availability }),
    ...(native === undefined ? {} : { native }),
  }, overrides);
  return { exploration, native: native !== undefined, db };
}

export async function handleExploreRequest(method: string, parts: string[], path: string, body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined, user?: { name: string }, route?: ExploreRoute, as?: Pick<ApiRequest, 'user'>): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This hub does not keep catalog documents by path.');
  const action = parts[2];
  const req = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const saved = await readList<SavedExploration>(deps, SAVED_DOC);
  const presets = await readList<EnclosurePreset>(deps, PRESETS_DOC);
  const tags = { saved: contentETag(saved.length === 0 ? null : saved), presets: contentETag(presets.length === 0 ? null : presets) };
  const at = deps.now?.() ?? new Date().toISOString();
  const who = user?.name;

  if (action === undefined && method === 'GET') {
    return { status: 200, body: { saved, presets: { builtIn: BUILT_IN_PRESETS, local: presets, inForce: presetsInForce(presets) }, targets: firmwareTargets().map((t) => ({ id: t.id, label: t.label })), etags: tags } };
  }

  if (action === 'saved' && method === 'PUT') {
    const guard = checkIfMatch(ifMatch, tags.saved, 'explore', 'saved');
    if (guard !== undefined) return guard;
    const e = req['exploration'] as Partial<SavedExploration> | undefined;
    const problems = [...requirementProblems(e?.requirement), ...overrideProblems(e?.overrides ?? [])];
    if (problems.length > 0) return fail(422, `That exploration cannot be kept: ${problems[0]}`, 'Nothing was saved.', { problems });
    const requirement = e!.requirement as Requirement;
    const key = requirementKey(requirement);
    const prev = saved.find((s) => s.key === key);
    const overrides = (e!.overrides ?? []).map((o) => ({ ...o, by: o.by ?? who, at: o.at ?? at })).map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as ExploreOverride);
    const next: SavedExploration = {
      key, requirement, overrides,
      ...(typeof e!.label === 'string' && e!.label.trim() !== '' ? { label: e!.label.trim() } : prev?.label === undefined ? {} : { label: prev.label }),
      ...(e!.picked !== undefined ? { picked: { ...e!.picked, ...(who === undefined ? {} : { by: who }), at } } : prev?.picked === undefined ? {} : { picked: prev.picked }),
      ...(who === undefined ? {} : { by: who }), at,
    };
    const list = [...saved.filter((s) => s.key !== key), next].sort((a, b) => a.key.localeCompare(b.key));
    await deps.docs.write(SAVED_DOC, list);
    return { status: 200, body: { saved: list, exploration: next, etags: { ...tags, saved: contentETag(list) } } };
  }

  if (action === 'saved' && method === 'DELETE') {
    const key = new URLSearchParams(path.split('?')[1] ?? '').get('key') ?? '';
    const guard = checkIfMatch(ifMatch, tags.saved, 'explore', 'saved');
    if (guard !== undefined) return guard;
    if (!saved.some((s) => s.key === key)) return fail(404, `No saved exploration '${key}'.`);
    const list = saved.filter((s) => s.key !== key);
    await deps.docs.write(SAVED_DOC, list.length === 0 ? [] : list);
    return { status: 200, body: { saved: list, etags: { ...tags, saved: contentETag(list.length === 0 ? null : list) } } };
  }

  if (action === 'presets' && method === 'PUT') {
    const guard = checkIfMatch(ifMatch, tags.presets, 'explore', 'presets');
    if (guard !== undefined) return guard;
    const problems = presetProblems(req['presets']);
    if (problems.length > 0) return fail(422, `Those presets cannot be saved: ${problems[0]}`, 'Nothing was saved.', { problems });
    const list = [...(req['presets'] as EnclosurePreset[])].sort((a, b) => a.id.localeCompare(b.id));
    await deps.docs.write(PRESETS_DOC, list);
    return { status: 200, body: { presets: { builtIn: BUILT_IN_PRESETS, local: list, inForce: presetsInForce(list) }, etags: { ...tags, presets: contentETag(list.length === 0 ? null : list) } } };
  }

  if (action === 'run' && method === 'POST') {
    const problems = requirementProblems(req['requirement']);
    if (problems.length > 0) return fail(400, problems[0]!, 'Send { requirement: { kind: "connect", source, destination } } or { kind: "enclose", board }.');
    const requirement = req['requirement'] as Requirement;
    const given = req['overrides'];
    if (given !== undefined && overrideProblems(given).length > 0) return fail(400, overrideProblems(given)[0]!);
    const overrides = (given as ExploreOverride[] | undefined) ?? saved.find((s) => s.key === requirementKey(requirement))?.overrides ?? [];
    const { exploration } = await runExploration(deps, requirement, overrides, presets);
    return { status: 200, body: { exploration } };
  }

  // the Use button's server side: the combination becomes a draft, and the pick is kept with the exploration
  if (action === 'pick' && method === 'POST') {
    if (route === undefined) return fail(501, 'This hub cannot make a draft from an exploration here.');
    const problems = requirementProblems(req['requirement']);
    if (problems.length > 0) return fail(400, problems[0]!, 'Send { requirement, combo } — the requirement you explored and the combination id from its answer.');
    const requirement = req['requirement'] as Requirement;
    const given = req['overrides'];
    if (given !== undefined && overrideProblems(given).length > 0) return fail(400, overrideProblems(given)[0]!);
    if (typeof req['combo'] !== 'string' || req['combo'] === '') return fail(400, 'Say which combination to use (combo: its id from the exploration).');
    const key = requirementKey(requirement);
    const prev = saved.find((s) => s.key === key);
    const overrides = (given as ExploreOverride[] | undefined) ?? prev?.overrides ?? [];
    const { exploration, native, db } = await runExploration(deps, requirement, overrides, presets);
    const combo = exploration.combos.find((c) => c.id === req['combo']);
    if (combo === undefined) return fail(404, `The exploration has no combination ${JSON.stringify(req['combo'])} now.`, 'Run it again: the library or the decisions may have changed, and so its combinations.');
    const opts = {
      ...(typeof req['id'] === 'string' && req['id'] !== '' ? { id: req['id'] } : {}),
      ...(typeof req['label'] === 'string' && req['label'].trim() !== '' ? { label: req['label'].trim() } : {}),
    };
    const forward = as?.user === undefined ? {} : { user: as.user };
    let picked: NonNullable<SavedExploration['picked']>;
    let made: ApiResponse;
    if (requirement.kind === 'connect') {
      const out = pickConnect(db, requirement, combo, opts);
      if (!out.ok) return fail(422, out.reason, 'Nothing was created.');
      let design = out.design;
      // a chosen id is the caller's; a derived one steps aside for an existing design
      if (opts.id === undefined) for (let n = 2; await deps.designs.has(design.id); n += 1) design = { ...out.design, id: `${out.design.id}-${n}` };
      made = await route({ method: 'POST', path: '/api/designs', body: design, ...forward }, deps);
      picked = { combo: combo.id, kind: 'designs', id: design.id };
    } else {
      const out = pickEnclose(db, requirement, combo, { ...opts, native });
      if (!out.ok) return fail(422, out.reason, 'Nothing was created.');
      let record = out.record;
      const taken = new Set((await deps.definitions?.list('mechanicals'))?.map((r) => r.id) ?? []);
      if (opts.id === undefined) for (let n = 2; taken.has(record.id); n += 1) record = { ...out.record, id: `${out.record.id}-${n}` };
      made = await route({ method: 'POST', path: '/api/definitions/mechanicals', body: record, ...forward }, deps);
      picked = { combo: combo.id, kind: 'mechanicals', id: record.id };
    }
    if (made.status >= 400) return made;
    const next: SavedExploration = {
      key, requirement, overrides: [...overrides],
      ...(prev?.label === undefined ? {} : { label: prev.label }),
      picked: { ...picked, ...(who === undefined ? {} : { by: who }), at },
      ...(who === undefined ? {} : { by: who }), at,
    };
    const list = [...saved.filter((s) => s.key !== key), next].sort((a, b) => a.key.localeCompare(b.key));
    await deps.docs.write(SAVED_DOC, list);
    return {
      status: 201,
      body: { picked: next.picked, combo: { id: combo.id, verdict: combo.verdict, rank: combo.rank }, created: made.body, uiPath: picked.kind === 'designs' ? `/cables/${picked.id}` : `/library/mechanicals/${picked.id}` },
      ...(made.headers?.ETag === undefined ? {} : { headers: { ETag: made.headers.ETag } }),
    };
  }

  return fail(404, `${method} ${parts.join('/')} is not part of the server API.`, `Try ${EXPLORE_ROUTES.join('; ')}.`);
}
