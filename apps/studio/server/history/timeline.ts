/**
 * A record's timeline from change rows (cs-5k1.4): pure, no IO.
 *
 * The database keeps, per change, the state after it (`after_body`) and —
 * since migration 0017 — the state before it (`before_body`). Rows written
 * earlier, and the import's rows, carry less. The timeline fills each gap
 * from the neighbouring rows of the same part (the state before a change is
 * the state after the previous change of that part) and says `known: false`
 * where nothing recorded it, rather than guessing.
 */

import { canonical } from '../../src/history/diff.ts';
import { known, UNKNOWN, type Known } from '../../src/history/types.ts';

/** One change row of one part of a subject, in commit order. */
export interface PartRow {
  /** the change set id (a bigint, as text) */
  cs: string;
  seq: number;
  part: string;
  before: Known;
  after: Known;
  /** a binary record: bytes changed, nothing to diff */
  binary?: boolean;
}

export interface PartStep {
  part: string;
  before: Known;
  after: Known;
  binary: boolean;
}

const order = (a: PartRow, b: PartRow): number => {
  const x = BigInt(a.cs);
  const y = BigInt(b.cs);
  return x < y ? -1 : x > y ? 1 : a.seq - b.seq;
};

const same = (a: Known, b: Known): boolean => a.known && b.known && canonical(a.value) === canonical(b.value);

/**
 * Per change set, what each part was before and after it. A part whose
 * before and after are known and equal is left out (a definitions list that
 * changed in another record); a set with nothing left is left out.
 */
export function stepsByChangeSet(rows: readonly PartRow[]): Map<string, PartStep[]> {
  const sorted = [...rows].sort(order);
  const state = new Map<string, Known>();
  const out = new Map<string, PartStep[]>();
  let i = 0;
  while (i < sorted.length) {
    const cs = (sorted[i] as PartRow).cs;
    const group: PartRow[] = [];
    while (i < sorted.length && (sorted[i] as PartRow).cs === cs) group.push(sorted[i++] as PartRow);
    const steps: PartStep[] = [];
    for (const part of [...new Set(group.map((r) => r.part))]) {
      const mine = group.filter((r) => r.part === part);
      const first = mine[0] as PartRow;
      const last = mine[mine.length - 1] as PartRow;
      const binary = mine.some((r) => r.binary === true);
      const before = first.before.known ? first.before : (state.get(part) ?? UNKNOWN);
      const after = last.after;
      state.set(part, after);
      if (!binary && same(before, after)) continue;
      steps.push({ part, before: binary ? UNKNOWN : before, after: binary ? UNKNOWN : after, binary });
    }
    if (steps.length > 0) out.set(cs, steps);
  }
  return out;
}

/**
 * A part's state right after change set `cs`: the last recorded state at or
 * before it, else the recorded "before" of the first change after it, else —
 * when nothing changed the part after `cs` — `'current'` (the record as it is
 * now). `known: false` when the rows cannot say.
 */
export function stateAfter(rows: readonly PartRow[], cs: string, part: string): Known | 'current' {
  const mine = rows.filter((r) => r.part === part && r.binary !== true).sort(order);
  const at = BigInt(cs);
  let last: PartRow | undefined;
  let next: PartRow | undefined;
  for (const r of mine) {
    if (BigInt(r.cs) <= at) last = r;
    else if (next === undefined) next = r;
  }
  if (last !== undefined && last.after.known) return last.after;
  if (next === undefined) return 'current';
  return next.before.known ? next.before : UNKNOWN;
}

/** `known(value)` with `undefined` meaning absent, never unknown. */
export const present = <T>(value: T | undefined): Known<T> => known(value);
