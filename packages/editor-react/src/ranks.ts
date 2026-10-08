/**
 * Which column each part of a design belongs in, left to right.
 *
 * The rule the canvas reads by: a wire's end `a` (the console / source side)
 * is on the left and end `b` on the right — for the **main** wire (the one
 * with the most joints). Everything else follows from where things physically
 * are, not from which instance happens to be listed first:
 *
 * - a part soldered to a wire end sits on the side that end faces;
 * - a wire soldered to a part sits on that part's cable side (a board's pads
 *   are all on one edge, so a second wire on a board lies beside the first —
 *   an audio whip on the console board runs alongside the trunk, turned so
 *   its `b` end faces the board);
 * - of two parts joined directly (a resistor and the connector it feeds, a
 *   board and a connector on its far edge), the one nearer the wire —
 *   component, then board, then connector — is nearer it on the canvas.
 *
 * Those give a set of "left of" constraints; the columns are their longest
 * path layering, with a source that has only far successors pulled up next to
 * them. Deterministic: ties go to design order, cycles (a design that loops
 * back on itself) are broken at the node design order lists first.
 */

import { designInstances, type CableDesign, type InstanceKind, type TerminalRef } from '@wirehub/model';

export interface Ranks {
  /** the column each instance belongs in, from 0 */
  columns: Record<string, number>;
  /** instance ids, column by column in the order they were reached */
  order: string[];
  /** every "left of" constraint, `[left, right]`, in a fixed order */
  constraints: [string, string][];
}

/** How far a part sits from the wire it hangs off: nearer parts sit nearer. */
const DISTANCE: Record<InstanceKind, number> = { segment: 0, component: 1, pcba: 2, connector: 3, subassembly: 3 };

type Dir = 1 | -1;

interface Link {
  /** the joint's two sides, own instance first */
  mine: TerminalRef;
  other: TerminalRef;
}

/**
 * The columns of `design`. `alias` folds an instance into another (a docked
 * connector into its board): its joints count as the board's, and it takes
 * the board's column.
 */
export function designRanks(
  design: CableDesign,
  alias: ReadonlyMap<string, string> = new Map(),
  /**
   * Parts wires pass *through* (a breakout mould, `moulds.ts`): what joins
   * them on an `out:` terminal lies on their far side, not their cable side.
   */
  passThrough: ReadonlySet<string> = new Set(),
): Ranks {
  const own = (id: string): string => alias.get(id) ?? id;
  const kinds = new Map<string, InstanceKind>();
  for (const instance of designInstances(design)) {
    // a folded instance is its target's
    if (!alias.has(instance.id)) kinds.set(instance.id, instance.kind);
  }
  const ids = [...kinds.keys()];
  const index = new Map(ids.map((id, at) => [id, at]));
  const isSegment = (id: string): boolean => kinds.get(id) === 'segment';

  // every joint between two distinct nodes, from each side
  const links = new Map<string, Link[]>();
  for (const id of ids) links.set(id, []);
  for (const joint of design.joints) {
    const a = { ...joint.a, instance: own(joint.a.instance) };
    const b = { ...joint.b, instance: own(joint.b.instance) };
    if (a.instance === b.instance) continue;
    links.get(a.instance)?.push({ mine: a, other: b });
    links.get(b.instance)?.push({ mine: b, other: a });
  }
  const neighbours = (id: string): string[] => {
    const out: string[] = [];
    for (const link of links.get(id) ?? []) if (!out.includes(link.other.instance)) out.push(link.other.instance);
    return out;
  };
  const firstLink = (from: string, to: string): Link | undefined =>
    links.get(from)?.find((link) => link.other.instance === to);

  /* 1 · orientation: which way each wire's end `a` faces, which side each part's wire is on */
  const aDir = new Map<string, Dir>(); // segment → the side its end `a` faces
  const toward = new Map<string, Dir>(); // part → the side its wire is on
  const visit: string[] = [];
  const endDir = (segment: string, end: 'a' | 'b'): Dir => {
    const dir = aDir.get(segment) ?? -1;
    return end === 'a' ? dir : ((-dir) as Dir);
  };
  const oriented = (id: string): boolean => aDir.has(id) || toward.has(id);

  const orient = (from: string, to: string): boolean => {
    const link = firstLink(from, to);
    if (link === undefined) return false;
    const fromSegment = isSegment(from);
    const toSegment = isSegment(to);
    if (!fromSegment && toSegment) {
      // the wire lies on the part's cable side, its end facing back at the part —
      // or, leaving a mould, on its far side
      const out = passThrough.has(from) && link.mine.terminal.startsWith('out:');
      const t = ((toward.get(from) ?? 1) * (out ? -1 : 1)) as Dir;
      const end = link.other.end ?? 'a';
      aDir.set(to, (end === 'a' ? -t : t) as Dir);
    } else if (fromSegment && !toSegment) {
      const side = endDir(from, link.mine.end ?? 'a');
      toward.set(to, (-side) as Dir);
    } else if (fromSegment && toSegment) {
      const side = endDir(from, link.mine.end ?? 'a');
      const end = link.other.end ?? 'a';
      // its end faces back at `from`: the opposite way to `from`'s end
      aDir.set(to, (end === 'a' ? -side : side) as Dir);
    } else {
      // a part beyond a part: further out, the same way round
      toward.set(to, toward.get(from) ?? 1);
    }
    return true;
  };

  const spread = (seeds: string[], throughWires: boolean): void => {
    const queue = [...seeds];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const next of neighbours(id)) {
        if (oriented(next)) continue;
        // wire-to-wire joints (shields bonded at a shared pad) say little
        // about where a wire lies; they only orient a wire nothing else reaches
        if (!throughWires && isSegment(id) && isSegment(next)) continue;
        if (!orient(id, next)) continue;
        visit.push(next);
        queue.push(next);
      }
    }
  };

  const jointCount = (id: string): number => links.get(id)?.length ?? 0;
  const segments = ids.filter(isSegment);
  const main = segments.reduce<string | undefined>(
    (best, id) => (best === undefined || jointCount(id) > jointCount(best) ? id : best),
    undefined,
  );
  if (main !== undefined) {
    // the source: the part on the main wire's end `a` with the most joints there
    const counts = new Map<string, number>();
    for (const link of links.get(main) ?? []) {
      if (link.mine.end !== 'a' || isSegment(link.other.instance)) continue;
      counts.set(link.other.instance, (counts.get(link.other.instance) ?? 0) + 1);
    }
    let root: string | undefined;
    for (const [id, count] of counts) if (root === undefined || count > (counts.get(root) ?? 0)) root = id;
    if (root === undefined) aDir.set(main, -1);
    else toward.set(root, 1);
    visit.push(root ?? main);
    spread([root ?? main], false);
  }
  // then whatever only wire-to-wire joints reach, then whatever nothing reaches
  for (;;) {
    const before = visit.length;
    spread([...visit], true);
    const loose = ids.find((id) => !oriented(id));
    if (loose === undefined) break;
    if (visit.length === before) {
      if (isSegment(loose)) aDir.set(loose, -1);
      else toward.set(loose, 1);
      visit.push(loose);
      spread([loose], false);
    }
  }

  /* 2 · constraints: `u` left of `v` */
  const after = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const left = (u: string, v: string): void => {
    if (u !== v) after.get(u)?.add(v);
  };
  const segmentJoints = (id: string): number =>
    (links.get(id) ?? []).filter((link) => isSegment(link.other.instance)).length;
  for (const id of ids) {
    for (const link of links.get(id) ?? []) {
      const other = link.other.instance;
      // each pair is seen from both sides; decide it from the lower index
      if ((index.get(id) ?? 0) > (index.get(other) ?? 0)) continue;
      if (isSegment(id) || isSegment(other)) {
        const votes: [string, string][] = [];
        for (const [segment, part, end] of [
          [id, other, link.mine.end],
          [other, id, link.other.end],
        ] as const) {
          if (!isSegment(segment) || end === undefined) continue;
          votes.push(endDir(segment, end) > 0 ? [segment, part] : [part, segment]);
        }
        const [first, second] = votes;
        if (first === undefined) continue;
        if (second !== undefined && (second[0] !== first[0] || second[1] !== first[1])) continue;
        left(first[0], first[1]);
        continue;
      }
      // two parts joined directly: the nearer one nearer the wire
      const dk = DISTANCE[kinds.get(id) ?? 'connector'] - DISTANCE[kinds.get(other) ?? 'connector'];
      const dj = segmentJoints(id) - segmentJoints(other);
      const [near, far] =
        dk < 0 || (dk === 0 && dj > 0) ? [id, other] : dk > 0 || (dk === 0 && dj < 0) ? [other, id] : [];
      if (near === undefined || far === undefined) continue;
      const t = toward.get(near) ?? toward.get(far) ?? 1;
      if (t > 0) left(far, near);
      else left(near, far);
    }
  }

  /* 3 · longest-path layering, cycles broken at the first node design order lists */
  const columns: Record<string, number> = {};
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const targets of after.values()) for (const v of targets) indegree.set(v, (indegree.get(v) ?? 0) + 1);
  const done = new Set<string>();
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const topo: string[] = [];
  while (done.size < ids.length) {
    let next = ids.find((id) => !done.has(id) && (indegree.get(id) ?? 0) === 0);
    if (next === undefined) next = ids.find((id) => !done.has(id)) as string;
    done.add(next);
    topo.push(next);
    for (const v of after.get(next) ?? []) {
      if (done.has(v)) continue;
      indegree.set(v, (indegree.get(v) ?? 0) - 1);
      rank.set(v, Math.max(rank.get(v) ?? 0, (rank.get(next) ?? 0) + 1));
    }
  }
  // a source with only far successors sits beside the nearest of them
  const before = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const targets of after.values()) for (const v of targets) before.set(v, (before.get(v) ?? 0) + 1);
  for (const id of [...topo].reverse()) {
    const successors = [...(after.get(id) ?? [])].filter((v) => done.has(v));
    if ((before.get(id) ?? 0) !== 0 || successors.length === 0) continue;
    const nearest = Math.min(...successors.map((v) => rank.get(v) ?? 0));
    rank.set(id, Math.max(rank.get(id) ?? 0, nearest - 1));
  }
  // parts nothing is soldered to yet (a design opened with its ends left open) flank the main
  // wire instead of piling onto it: the ends of a cable stand on the outside, the wire between
  if (main !== undefined) {
    const middle = rank.get(main) ?? 0;
    const loose = ids.filter((id) => !isSegment(id) && jointCount(id) === 0 && kinds.get(id) !== 'component');
    let onLeft = ids.filter((id) => !loose.includes(id) && (rank.get(id) ?? 0) < middle).length;
    let onRight = ids.filter((id) => !loose.includes(id) && (rank.get(id) ?? 0) > middle).length;
    for (const id of loose) {
      // end `a` (the first listed) goes left, the next right, whichever side has fewer
      if (onLeft <= onRight) {
        rank.set(id, middle - 1);
        left(id, main);
        onLeft += 1;
      } else {
        rank.set(id, middle + 1);
        left(main, id);
        onRight += 1;
      }
    }
  }
  const least = Math.min(0, ...[...rank.values()]);
  for (const id of ids) columns[id] = (rank.get(id) ?? 0) - least;

  const reached = new Map(visit.map((id, at) => [id, at]));
  const order = [...ids].sort(
    (p, q) =>
      (columns[p] ?? 0) - (columns[q] ?? 0) ||
      (reached.get(p) ?? Infinity) - (reached.get(q) ?? Infinity) ||
      (index.get(p) ?? 0) - (index.get(q) ?? 0),
  );
  for (const [from, to] of alias) {
    const column = columns[to];
    if (column !== undefined) columns[from] = column;
  }
  const constraints: [string, string][] = [];
  for (const id of ids) for (const v of after.get(id) ?? []) constraints.push([id, v]);
  return { columns, order, constraints };
}

/**
 * Which way a part's pins should face: toward the columns most of its joints
 * go to. Level (or nothing jointed): right in the first column, left anywhere
 * else.
 */
export function facingByColumns(
  design: CableDesign,
  instanceId: string,
  columns: Readonly<Record<string, number>>,
): 'left' | 'right' {
  const own = columns[instanceId] ?? 0;
  let vote = 0;
  for (const joint of design.joints) {
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mine.instance !== instanceId || other.instance === instanceId) continue;
      const column = columns[other.instance];
      if (column === undefined || column === own) continue;
      vote += column > own ? 1 : -1;
    }
  }
  if (vote !== 0) return vote > 0 ? 'right' : 'left';
  return own === 0 ? 'right' : 'left';
}
