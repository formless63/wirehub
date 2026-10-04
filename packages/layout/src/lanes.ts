/**
 * Lane order in a routing corridor.
 *
 * Every joint that crosses a corridor (the fan between a block column and a
 * band, the dock gap between a board and the connector mounted on it) runs
 * in, along its entry row, to a vertical **lane**, down or up it, and out along
 * its exit row. Two such runs cross exactly when one's entry or exit row
 * passes through the other's lane — which depends only on which lane is left
 * of which. So the corridor picks the left-to-right lane order with the fewest
 * crossings:
 *
 *   i left of j crosses  [ j's entry row inside i's span ] + [ i's exit row inside j's span ]
 *
 * (spans open at both ends: a run that merely touches another's end shares a
 * joint, not a crossing). For runs that keep their order across the corridor —
 * the whole point of sorting tracks by their pads — this order is crossing
 * free: downward runs step leftwards as they go down, upward ones rightwards.
 * Runs on one net (a pigtail and the pad it shares) never count against each
 * other. Deterministic: a stable seed, then first-improvement moves.
 */

export interface LaneRun {
  /** y where the run enters the corridor (its left end) */
  yIn: number;
  /** y where it leaves (its right end) */
  yOut: number;
  /** runs on one net may cross freely — they are one copper */
  net?: string;
  /** stable tie-break (the joint index) */
  tie: number;
}

const EPS = 1e-6;

function inside(y: number, a: number, b: number): boolean {
  return y > Math.min(a, b) + EPS && y < Math.max(a, b) - EPS;
}

/** Crossings when `i`'s lane is left of `j`'s. */
export function crossingsLeftOf(i: LaneRun, j: LaneRun): number {
  if (i.net !== undefined && i.net === j.net) return 0;
  return (inside(j.yIn, i.yIn, i.yOut) ? 1 : 0) + (inside(i.yOut, j.yIn, j.yOut) ? 1 : 0);
}

/**
 * Worse than a crossing: `i` leaves on the very row `j` comes in on, and
 * with `i`'s lane left of `j`'s the two share that row between their lanes —
 * two nets drawn as one wire, which reads as a connection
 *. With `j`'s lane on the left, `j` has left the row
 * before `i` arrives on it.
 */
const SHARED_ROW = 3;

/** Rows closer than this print as one line (every wire stroke is wider). */
const SAME_ROW = 0.5;

/** What it costs to put `i`'s lane left of `j`'s: crossings, and a shared row. */
export function costLeftOf(i: LaneRun, j: LaneRun): number {
  if (i.net !== undefined && i.net === j.net) return 0;
  return crossingsLeftOf(i, j) + (Math.abs(i.yOut - j.yIn) < SAME_ROW ? SHARED_ROW : 0);
}

function total(order: readonly number[], runs: readonly LaneRun[]): number {
  let sum = 0;
  for (let a = 0; a < order.length; a += 1) {
    for (let b = a + 1; b < order.length; b += 1) {
      sum += costLeftOf(runs[order[a]!]!, runs[order[b]!]!);
    }
  }
  return sum;
}

/**
 * The lane order (indices into `runs`, left to right) with the fewest
 * crossings. The seed puts downward runs right-to-left by entry row and upward
 * runs left-to-right — already optimal for order-keeping fans — and the
 * improvement pass handles whatever the pads force out of order.
 */
export function orderLanes(runs: readonly LaneRun[]): number[] {
  const seed = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const key = (run: LaneRun): number => (run.yOut >= run.yIn ? -run.yIn : run.yIn);
      const down = (run: LaneRun): number => (run.yOut >= run.yIn ? 0 : 1);
      if (down(a.run) !== down(b.run)) return down(a.run) - down(b.run);
      const ka = key(a.run);
      const kb = key(b.run);
      if (ka !== kb) return ka - kb;
      if (a.run.yOut !== b.run.yOut) return a.run.yOut - b.run.yOut;
      return a.run.tie - b.run.tie;
    })
    .map((item) => item.index);
  if (seed.length < 3) {
    // two runs: just take the better of the two orders
    if (seed.length === 2) {
      const [a, b] = seed as [number, number];
      const ab = costLeftOf(runs[a]!, runs[b]!);
      const ba = costLeftOf(runs[b]!, runs[a]!);
      return ba < ab ? [b, a] : [a, b];
    }
    return seed;
  }
  let best = seed;
  let bestCost = total(best, runs);
  for (let pass = 0; pass < 30 && bestCost > 0; pass += 1) {
    let improved = false;
    for (let from = 0; from < best.length; from += 1) {
      for (let to = 0; to < best.length; to += 1) {
        if (to === from) continue;
        const candidate = [...best];
        const [moved] = candidate.splice(from, 1);
        candidate.splice(to, 0, moved!);
        const cost = total(candidate, runs);
        if (cost < bestCost) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}
