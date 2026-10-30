/**
 * Built units and their test results (`src/units.ts`, `docs/inventory.md` § Units and test results):
 *
 *   GET  /api/units?design=<id>      the built units (of one design), newest batch first, each with
 *                                    its latest result per kind and whether it still applies
 *   GET  /api/units/:unit            one unit and every result recorded on it
 *   POST /api/units/:unit/tests      { kind, result, note? } → 201 { test }
 *
 * Units are read from the inventory's design batches; results live in their own append-only store
 * (`store.ts`). Not catalog data: no unit of work or change set. A write raises `inventory.changed`.
 */

import { randomBytes } from 'node:crypto';

import { UNIT_ID, unitTestInputProblems, type BuiltUnit, type UnitTest, type UnitTestInput, type UnitTestKind } from '../../src/units.ts';
import type { ApiResponse } from '../api.ts';
import type { EventHub } from '../events.ts';
import type { InventoryStore } from '../inventory/store.ts';
import { actorName, type StudioUser } from '../me.ts';
import { coverageFor, withApplicability, type CoverageDeps } from './coverage.ts';
import { designBatches, unitsOfBatches, type UnitRow } from './resolve.ts';
import type { UnitTestStore } from './store.ts';

export const UNIT_ROUTES = [
  'GET    /api/units',
  'GET    /api/units/:unit',
  'POST   /api/units/:unit/tests',
] as const;

export interface UnitDeps extends CoverageDeps {
  inventory?: InventoryStore;
  unitTests?: UnitTestStore;
  events?: EventHub;
}

export const isUnitsPath = (path: string): boolean => /^\/api\/units(?:\/|$|\?)/.test(path);

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
async function labelsOf(deps: UnitDeps): Promise<Map<string, string>> {
  return new Map((await deps.designs.list()).map((d) => [d.id, d.label]));
}

/** One built unit by its id; undefined when its batch or place does not exist. */
async function unitById(deps: UnitDeps, id: string): Promise<UnitRow | undefined> {
  if (deps.inventory === undefined || !UNIT_ID.test(id)) return undefined;
  const batch = id.slice(0, id.lastIndexOf('.'));
  const all = await designBatches(deps.inventory);
  const found = all.find((b) => b.id === batch);
  if (found === undefined) return undefined;
  return unitsOfBatches([found], await labelsOf(deps)).find((u) => u.id === id);
}

async function latestOf(deps: UnitDeps, design: string, tests: UnitTest[]): Promise<BuiltUnit['latest']> {
  const newest: UnitTest[] = [];
  const seen = new Set<UnitTestKind>();
  for (const t of tests) {
    if (seen.has(t.kind)) continue;
    seen.add(t.kind);
    newest.push(t);
  }
  const views = await withApplicability(deps, design, newest);
  return Object.fromEntries(views.map((v) => [v.kind, v]));
}

export async function handleUnitsRequest(request: { method: string; path: string; body?: unknown; user?: StudioUser }, deps: UnitDeps, fallbackUser: StudioUser): Promise<ApiResponse> {
  if (deps.inventory === undefined) return fail(501, 'This hub keeps no inventory.', 'Run it with a data directory or a database.');
  const store = deps.unitTests;
  const method = request.method.toUpperCase();
  const [pathPart, queryPart = ''] = request.path.split('?');
  const query = new URLSearchParams(queryPart);
  const [, , id, action, extra] = (pathPart ?? '').split('/').filter((p) => p !== '').map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });

  if (id === undefined) {
    if (method !== 'GET') return fail(405, 'GET only.');
    const design = query.get('design') ?? undefined;
    const units = unitsOfBatches(await designBatches(deps.inventory, design), await labelsOf(deps));
    const tests = store === undefined ? [] : await store.list(design === undefined ? {} : { design });
    const byUnit = new Map<string, UnitTest[]>();
    for (const t of tests) byUnit.set(t.unit, [...(byUnit.get(t.unit) ?? []), t]);
    const out: BuiltUnit[] = [];
    for (const u of units) {
      const mine = byUnit.get(u.id) ?? [];
      out.push({ ...u, latest: mine.length === 0 ? {} : await latestOf(deps, u.design, mine), tests: mine.length });
    }
    return { status: 200, body: { units: out, ...(design === undefined ? {} : { design }) } };
  }

  const unit = await unitById(deps, id);
  if (unit === undefined) return fail(404, `There is no built unit '${id}'.`, 'GET /api/units lists them.');

  if (action === undefined) {
    if (method !== 'GET') return fail(405, 'GET only; record a result with POST …/tests.');
    const tests = store === undefined ? [] : await store.list({ unit: unit.id });
    const views = await withApplicability(deps, unit.design, tests);
    return { status: 200, body: { unit: { ...unit, latest: tests.length === 0 ? {} : await latestOf(deps, unit.design, tests), tests: tests.length }, tests: views } };
  }

  if (action === 'tests' && extra === undefined) {
    if (method !== 'POST') return fail(405, 'POST only.');
    if (store === undefined) return fail(501, 'This hub keeps no test results.');
    const problems = unitTestInputProblems(request.body);
    if (problems.length > 0) return { status: 400, body: { error: 'The result cannot be saved.', problems } };
    const input = request.body as UnitTestInput;
    const user = request.user ?? fallbackUser;
    const coverage = await coverageFor(deps, unit.design, unit.rev, input.kind);
    const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : undefined;
    const test: UnitTest = {
      id: `ut-${randomBytes(5).toString('hex')}`,
      unit: unit.id,
      design: unit.design,
      kind: input.kind,
      result: input.result,
      ...(note === undefined ? {} : { note }),
      ...(coverage === undefined ? {} : { coverage }),
      at: new Date().toISOString(),
      by: actorName(user) ?? user.email ?? 'unknown',
    };
    await store.add(test);
    deps.events?.publish({ type: 'inventory' });
    const [view] = await withApplicability(deps, unit.design, [test]);
    return {
      status: 201,
      body: { test: view ?? test },
      events: [{ type: 'inventory.changed', subject: { kind: 'batch', id: unit.batch }, summary: { action: 'unit-tested', unit: unit.id, kind: test.kind, result: test.result } }],
    };
  }
  return fail(404, `${request.path} is not a units address.`);
}
