/**
 * Which order a band's tracks run in.
 *
 * The band is the schematic's abstraction of the cable, so the order of its
 * tracks top to bottom is free — nothing physical fixes it. What *is* fixed is
 * where the wires land at each end: a depicted board's pads sit where the
 * board file puts them. So the band takes whichever order makes the fans at
 * its two ends cross least:
 *
 *  - a track **unit** is what has to stay together: a coax (centre + braid,
 *    bracketed as one group) or a single conductor/screen;
 *  - a landing is **fixed** when it is a pad on depicted artwork (its y is the
 *    board's, not ours); anything else (a pin row of an abstract block, a
 *    component lead) follows the track order afterwards and costs nothing;
 *  - the cost is the number of pairs of fixed landings at one end whose order
 *    along the band disagrees with their order at the pads (each is one
 *    unavoidable crossing in the fan), plus a smaller charge for every track a
 *    pigtail's bracket has to reach across that is not one of its members
 *    (members kept side by side gather into one short bracket).
 *
 * The search is small (a cable has at most a dozen units) and deterministic:
 * a few seeds, then first-improvement moves of one unit to another slot until
 * nothing improves. Ties keep the catalog's structure order.
 */

/** One landing at one end of the band, as the optimiser sees it. */
export interface TrackLanding {
  /** track element paths whose band position the landing leaves from (a pigtail: its members) */
  paths: readonly string[];
  /** fixed y of the far end, or `undefined` when it follows the band */
  y?: number;
  /** the landing is a pigtail's: charge for non-members inside its bracket */
  pigtail?: boolean;
  /** net id, so two landings on one copper never count as a crossing */
  net?: string;
}

/** Per-crossing cost is 1; each foreign track inside a pigtail bracket costs this. */
export const PIGTAIL_SPAN_COST = 0.6;

/** Units (lists of element paths, each kept together in order), in structure order. */
export type TrackUnits = readonly (readonly string[])[];

function positions(order: readonly number[], units: TrackUnits): Map<string, number> {
  const out = new Map<string, number>();
  let cursor = 0;
  for (const unit of order) {
    for (const path of units[unit] ?? []) {
      out.set(path, cursor);
      cursor += 1;
    }
  }
  return out;
}

/** A landing's position along the band: the mean of its paths' positions. */
function landingPosition(landing: TrackLanding, at: ReadonlyMap<string, number>): number | undefined {
  const known = landing.paths.map((path) => at.get(path)).filter((p): p is number => p !== undefined);
  if (known.length === 0) return undefined;
  return known.reduce((sum, p) => sum + p, 0) / known.length;
}

/** Total cost of one unit order against the landings at both ends. */
export function orderCost(
  order: readonly number[],
  units: TrackUnits,
  ends: readonly (readonly TrackLanding[])[],
): number {
  const at = positions(order, units);
  let cost = 0;
  for (const landings of ends) {
    const fixed: { p: number; y: number; net?: string }[] = [];
    for (const landing of landings) {
      const p = landingPosition(landing, at);
      if (p === undefined) continue;
      if (landing.y !== undefined) {
        fixed.push({ p, y: landing.y, ...(landing.net === undefined ? {} : { net: landing.net }) });
      }
      if (landing.pigtail === true && landing.paths.length > 1) {
        const members = landing.paths.map((path) => at.get(path)).filter((q): q is number => q !== undefined);
        const low = Math.min(...members);
        const high = Math.max(...members);
        cost += PIGTAIL_SPAN_COST * (high - low + 1 - members.length);
      }
    }
    for (let i = 0; i < fixed.length; i += 1) {
      for (let j = i + 1; j < fixed.length; j += 1) {
        const a = fixed[i]!;
        const b = fixed[j]!;
        if (a.net !== undefined && a.net === b.net) continue;
        if ((a.p - b.p) * (a.y - b.y) < 0) cost += 1;
      }
    }
  }
  return cost;
}

/** Units sorted by the mean fixed y they land at (units landing nowhere fixed keep their place). */
function seedBy(units: TrackUnits, ends: readonly (readonly TrackLanding[])[]): number[] {
  const unitOf = new Map<string, number>();
  units.forEach((unit, index) => unit.forEach((path) => unitOf.set(path, index)));
  const sum = new Map<number, { total: number; count: number }>();
  for (const landings of ends) {
    for (const landing of landings) {
      if (landing.y === undefined || landing.pigtail === true) continue;
      for (const path of landing.paths) {
        const unit = unitOf.get(path);
        if (unit === undefined) continue;
        const entry = sum.get(unit) ?? { total: 0, count: 0 };
        entry.total += landing.y;
        entry.count += 1;
        sum.set(unit, entry);
      }
    }
  }
  const keyed = units.map((_unit, index) => {
    const entry = sum.get(index);
    return { index, key: entry === undefined ? undefined : entry.total / entry.count };
  });
  // units with a key sort among themselves into the slots keyed units held
  const slots = keyed.filter((item) => item.key !== undefined).map((item) => item.index);
  const sorted = keyed
    .filter((item) => item.key !== undefined)
    .sort((a, b) => (a.key! === b.key! ? a.index - b.index : a.key! - b.key!))
    .map((item) => item.index);
  const out = units.map((_unit, index) => index);
  slots.forEach((slot, position) => {
    out[slot] = sorted[position]!;
  });
  return out;
}

/**
 * The unit order with the fewest crossings, as a permutation of unit indices.
 * `ends` holds the landings at each end of the band (any number of ends).
 */
export function optimiseTrackOrder(
  units: TrackUnits,
  ends: readonly (readonly TrackLanding[])[],
): { order: number[]; cost: number } {
  const identity = units.map((_unit, index) => index);
  if (units.length < 2) return { order: identity, cost: orderCost(identity, units, ends) };

  const seeds = [identity, seedBy(units, ends), ...ends.map((landings) => seedBy(units, [landings]))];
  let best = identity;
  let bestCost = orderCost(identity, units, ends);
  for (const seed of seeds) {
    const cost = orderCost(seed, units, ends);
    if (cost < bestCost - 1e-9) {
      best = seed;
      bestCost = cost;
    }
  }

  // first-improvement local search: move one unit to another slot
  for (let pass = 0; pass < 50; pass += 1) {
    let improved = false;
    for (let from = 0; from < best.length; from += 1) {
      for (let to = 0; to < best.length; to += 1) {
        if (to === from) continue;
        const candidate = [...best];
        const [unit] = candidate.splice(from, 1);
        candidate.splice(to, 0, unit!);
        const cost = orderCost(candidate, units, ends);
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { order: best, cost: bestCost };
}
