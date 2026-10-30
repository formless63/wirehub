/**
 * Built units and their test results (`docs/inventory.md` § Units and test results).
 *
 * A built unit is one good unit of a design batch (`server/inventory`): its id is the batch id and
 * its 1-based place in the batch (`bat-0123456789.2`); its serial, when the batch gave one, is how
 * people name it. A test result is recorded against one unit, never changed afterwards (a re-test
 * is a new record), and keeps a fingerprint of what the test covers at the design state the unit
 * was built to. Whether the result still applies is worked out on read, against the design's
 * latest saved version: the same coverage → it still applies; different → stale. Nothing is
 * required: a unit needs no test, a test needs no note.
 *
 * Shared by the server (`server/units/`) and the browser; no runtime dependencies.
 */

export const UNIT_TEST_KINDS = ['continuity', 'bench'] as const;
export type UnitTestKind = (typeof UNIT_TEST_KINDS)[number];
export const UNIT_TEST_KIND_LABEL: Record<UnitTestKind, string> = { continuity: 'Continuity', bench: 'Bench' };
/** what each kind covers, for the hover: continuity follows the derived test spec, bench the whole design */
export const UNIT_TEST_KIND_COVERS: Record<UnitTestKind, string> = {
  continuity: 'Covers the continuity spec: nets, paths, isolation and deliberate opens.',
  bench: 'Covers the whole design.',
};

export const UNIT_TEST_RESULTS = ['pass', 'fail'] as const;
export type UnitTestResult = (typeof UNIT_TEST_RESULTS)[number];

/** `bat-<10 hex>.<n>` */
export const UNIT_ID = /^bat-[0-9a-f]{10}\.[1-9][0-9]{0,4}$/;
export const UNIT_TEST_ID = /^ut-[0-9a-f]{10}$/;

/** What a result covered, at the design state the unit was built to. */
export interface UnitCoverage {
  /** sha256 of the covered content (`server/units/coverage.ts`) */
  sha: string;
  /** the saved revision it was taken from; absent = the working copy at the time */
  rev?: number;
  /** continuity: how many checks the spec held */
  checks?: number;
}

/** One recorded result. Written once. */
export interface UnitTest {
  id: string;
  unit: string;
  design: string;
  kind: UnitTestKind;
  result: UnitTestResult;
  note?: string;
  coverage?: UnitCoverage;
  at: string;
  by: string;
}

/**
 * Whether a result applies to the design as it is saved now.
 * - `current`: taken at the latest saved state (or nothing newer is saved)
 * - `carried`: newer revisions exist, but what the test covers did not change
 * - `stale`: what the test covers changed since; `change` says what in a few words
 * - `unknown`: the coverage could not be worked out (a design that no longer reads)
 */
export type Applicability = 'current' | 'carried' | 'stale' | 'unknown';

export interface UnitTestView extends UnitTest {
  applies: Applicability;
  /** the revision compared against (the latest saved one) */
  against?: number;
  change?: string;
}

/** A built unit as the API lists it. */
export interface BuiltUnit {
  id: string;
  design: string;
  /** the design's label */
  label: string;
  /** the batch it came from */
  batch: string;
  /** its place in the batch, 1-based */
  n: number;
  serial?: string;
  batchCode?: string;
  /** the saved revision it was built to; absent = the working copy at the time */
  rev?: number;
  builtAt: string;
  builtBy: string;
  /** the newest result of each kind, with its applicability */
  latest: Partial<Record<UnitTestKind, UnitTestView>>;
  tests: number;
}

/** How a person names a unit: its serial, else the batch code (or the day it was built) and its place. */
export function unitName(u: Pick<BuiltUnit, 'serial' | 'batchCode' | 'builtAt' | 'n'>): string {
  return u.serial ?? `${u.batchCode ?? u.builtAt.slice(0, 10)} #${u.n}`;
}

/** What `POST /api/units/:id/tests` takes. */
export interface UnitTestInput {
  kind: UnitTestKind;
  result: UnitTestResult;
  note?: string;
}

/** Problems with a test result, in words; empty when it can be recorded. */
export function unitTestInputProblems(input: unknown): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ['Send the result as an object.'];
  const r = input as Partial<Record<keyof UnitTestInput, unknown>>;
  const out: string[] = [];
  if (!UNIT_TEST_KINDS.includes(r.kind as UnitTestKind)) out.push(`kind: one of ${UNIT_TEST_KINDS.join(', ')}.`);
  if (!UNIT_TEST_RESULTS.includes(r.result as UnitTestResult)) out.push(`result: one of ${UNIT_TEST_RESULTS.join(', ')}.`);
  if (r.note !== undefined && r.note !== null && !(typeof r.note === 'string' && r.note.length <= 2000)) out.push('note: text up to 2000.');
  return out;
}
