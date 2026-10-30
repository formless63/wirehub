/**
 * What a unit test covers, and whether it still applies (the idea of a subject test whose
 * applicability is derived on read, never stored): a result keeps a fingerprint of the content it
 * covered at the design state the unit was built to; on read it is compared with the same
 * fingerprint of the design's latest saved version.
 *
 * - continuity: the derived continuity spec, as the set of checks a meter makes — nets by their
 *   ports, paths by their ends and whether DC reads through, isolation pairs, deliberate opens and
 *   pigtail landings. Wording, labels and net names are not part of it: a renamed pin label does
 *   not make a continuity result stale, a moved wire does.
 * - bench: the whole design (its label aside).
 */

import { createHash } from 'node:crypto';

import { deriveTestSpec, type TestSpec } from '@wirehub/docs';
import { designChangeSummary, stableJson, versionDb, type CableDesign, type Db } from '@wirehub/model';

import type { Applicability, UnitCoverage, UnitTest, UnitTestKind, UnitTestView } from '../../src/units.ts';
import { withDesignLibrary, type AssemblyDeps } from '../assemblies.ts';
import type { Awaitable } from '../storage/change-set.ts';

export interface CoverageDeps extends AssemblyDeps {
  loadDb: () => Awaitable<Db>;
}

interface DesignState {
  design: CableDesign;
  db: Db;
  /** absent: the working copy */
  rev?: number;
}

interface Covered {
  sha: string;
  /** continuity: one line per check */
  lines?: string[];
  design: CableDesign;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The checks of a continuity spec, as words that only change when what a meter does changes. */
export function continuityLines(spec: TestSpec): string[] {
  const pair = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const lines = [
    ...spec.netChecks.map((c) => `net ${c.ports.map((p) => p.key).sort().join(' ')}`),
    ...spec.pathChecks.map((c) => `path ${pair(c.from.key, c.to.key)} ${c.dcContinuous ? 'dc' : 'no-dc'}`),
    ...spec.isolationChecks.map((c) => `isolation ${pair(c.a.key, c.b.key)}${c.violated ? ' violated' : ''}${c.commoned === undefined ? '' : ' commoned'}`),
    ...spec.openChecks.map((c) => `open ${c.openKind} ${c.key}`),
    ...spec.groundLandings.map((c) => `landing ${c.key} ${c.landing} ${c.pad ?? ''}`.trim()),
  ];
  return [...new Set(lines)].sort();
}

function cover(kind: UnitTestKind, state: DesignState): Covered {
  if (kind === 'continuity') {
    const lines = continuityLines(deriveTestSpec(state.design, state.db));
    return { sha: sha256(lines.join('\n')), lines, design: state.design };
  }
  const { label: _label, ...rest } = state.design;
  return { sha: sha256(stableJson(rest)), design: state.design };
}

// saved versions never change: their coverage is kept (bounded) per process
const savedCache = new Map<string, Covered>();
const CACHE_MAX = 500;

async function stateOf(deps: CoverageDeps, id: string, rev: number | undefined): Promise<DesignState | undefined> {
  const live = await deps.loadDb();
  if (rev === undefined) {
    const working = await deps.designs.read(id);
    return working === undefined ? undefined : { design: working, db: await withDesignLibrary(deps, working, live) };
  }
  const file = await deps.versions?.read(id, rev);
  if (file === undefined) return undefined;
  const frozen = { ...file.design, id };
  return { design: frozen, db: await withDesignLibrary(deps, frozen, versionDb(file.definitions, live)), rev };
}

async function covered(deps: CoverageDeps, id: string, rev: number | undefined, kind: UnitTestKind): Promise<Covered | undefined> {
  const key = `${id}@${rev}:${kind}`;
  if (rev !== undefined) {
    const hit = savedCache.get(key);
    if (hit !== undefined) return hit;
  }
  const state = await stateOf(deps, id, rev);
  if (state === undefined) return undefined;
  let out: Covered;
  try {
    out = cover(kind, state);
  } catch {
    return undefined;
  }
  if (rev !== undefined) {
    if (savedCache.size >= CACHE_MAX) savedCache.delete(savedCache.keys().next().value as string);
    savedCache.set(key, out);
  }
  return out;
}

/** The design's latest saved revision, if any. */
export async function latestRev(deps: CoverageDeps, id: string): Promise<number | undefined> {
  const revs = (await deps.versions?.revisions(id)) ?? [];
  return revs[revs.length - 1];
}

/**
 * The coverage a new result records. The unit's revision when its batch names one; otherwise (a
 * unit built from the working copy) today's working copy, credited to the latest saved revision
 * when that covers the same content.
 */
export async function coverageFor(deps: CoverageDeps, design: string, builtRev: number | undefined, kind: UnitTestKind): Promise<UnitCoverage | undefined> {
  const at = await covered(deps, design, builtRev, kind);
  if (at === undefined) return undefined;
  let rev = builtRev;
  if (rev === undefined) {
    const last = await latestRev(deps, design);
    if (last !== undefined && (await covered(deps, design, last, kind))?.sha === at.sha) rev = last;
  }
  return { sha: at.sha, ...(rev === undefined ? {} : { rev }), ...(at.lines === undefined ? {} : { checks: at.lines.length }) };
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Each result with whether it applies to the latest saved state (the working copy when nothing is saved). */
export async function withApplicability(deps: CoverageDeps, design: string, tests: readonly UnitTest[]): Promise<UnitTestView[]> {
  const last = await latestRev(deps, design);
  const now: Partial<Record<UnitTestKind, Covered | null>> = {};
  const out: UnitTestView[] = [];
  for (const t of tests) {
    if (now[t.kind] === undefined) now[t.kind] = (await covered(deps, design, last, t.kind)) ?? null;
    const current = now[t.kind] ?? undefined;
    const against = last === undefined ? {} : { against: last };
    if (t.coverage === undefined || current === undefined) {
      out.push({ ...t, applies: 'unknown', ...against });
      continue;
    }
    if (t.coverage.sha === current.sha) {
      const applies: Applicability = t.coverage.rev !== undefined && last !== undefined && last > t.coverage.rev ? 'carried' : 'current';
      out.push({ ...t, applies, ...against });
      continue;
    }
    out.push({ ...t, applies: 'stale', ...against, change: await changeText(deps, design, t, current, last) });
  }
  return out;
}

async function changeText(deps: CoverageDeps, design: string, t: UnitTest, current: Covered, last: number | undefined): Promise<string> {
  const where = last === undefined ? 'The working copy' : `Rev ${last}`;
  const then = t.coverage?.rev === undefined ? undefined : await covered(deps, design, t.coverage.rev, t.kind);
  if (t.kind === 'continuity') {
    if (then?.lines !== undefined && current.lines !== undefined) {
      const before = new Set(then.lines);
      const after = new Set(current.lines);
      const added = current.lines.filter((l) => !before.has(l)).length;
      const removed = then.lines.filter((l) => !after.has(l)).length;
      return `${where}: ${[added === 0 ? '' : `${plural(added, 'check')} added`, removed === 0 ? '' : `${plural(removed, 'check')} removed`].filter((s) => s !== '').join(', ') || 'checks changed'}`;
    }
    return `${where}: continuity checks changed${t.coverage?.checks === undefined || current.lines === undefined ? '' : ` (${t.coverage.checks} → ${current.lines.length})`}`;
  }
  const summary = then === undefined ? undefined : designChangeSummary(then.design, current.design);
  return `${where}: ${summary ?? 'design changed'}`;
}
