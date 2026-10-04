/**
 * Same-part bridges drawn as a quiet ground bus.
 *
 * A joint between two terminals of one part — the HD15's 6 ↔ 5/7/8/10
 * returns bridged in the head, a SCART's commoned ground returns, a DB-23's
 * 16 ↔ 17 strap, two ground pads of one board — is not a wire run anywhere:
 * it is solder or a short link inside the part. The owner (2026-09-28): "They
 * also don't need to be rendered like wires on top of everything. Couldn't
 * they just be a grid-like structure, a tad faint, behind the other bits that
 * connect the relevant ground pads on that design that need to be?"
 *
 * So the canvas draws no edge for them (`derive.ts` keeps their edge hidden,
 * unselectable and undeletable), and the part draws this instead: per group
 * of commoned terminals, one straight trunk in the channel between the pin
 * rows the group sits on, and a straight stub from each terminal to it —
 * rectilinear, thin, faint, under the pins, leads and labels, and never a
 * pointer target. Hovering or selecting the part brings it up; the Part tab
 * of the Inspector lists the bridges and adds or removes one.
 *
 * Pure geometry: points in, SVG path data out, in whatever coordinates the
 * caller's points are in.
 */

import type { XY } from './derive.ts';

/** One same-part joint, as the part's own node carries it. */
export interface Bridge {
  /** terminal keys of the two ends (`j1:6`, `j1:5`) */
  a: string;
  b: string;
  /** index into `design.joints` */
  index: number;
  /** the joint is (part of) the current selection */
  selected: boolean;
  /** the joint's note, for the Inspector's list */
  note?: string;
}

/** One connected group of bridged terminals, drawn as one trunk and its stubs. */
export interface BusPath {
  /** SVG path data: the trunk, then one stub per terminal */
  d: string;
  /** the terminal keys the group joins, sorted */
  keys: string[];
  /** the joints it stands for */
  joints: number[];
  selected: boolean;
}

export interface BusOptions {
  /**
   * Where a group whose terminals all sit on one line puts its trunk: this
   * far off that line, toward `toward` (default 4).
   */
  gap?: number;
  /** a point inside the part — a one-line group's trunk moves toward it */
  toward?: XY;
}

/** Terminal groups joined by `bridges` (union-find), each with its joints. */
export function bridgeGroups(bridges: readonly Bridge[]): { keys: string[]; bridges: Bridge[] }[] {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  for (const bridge of bridges) {
    if (!parent.has(bridge.a)) parent.set(bridge.a, bridge.a);
    if (!parent.has(bridge.b)) parent.set(bridge.b, bridge.b);
    const [ra, rb] = [find(bridge.a), find(bridge.b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, { keys: Set<string>; bridges: Bridge[] }>();
  for (const bridge of bridges) {
    const root = find(bridge.a);
    const group = groups.get(root) ?? { keys: new Set<string>(), bridges: [] };
    group.keys.add(bridge.a);
    group.keys.add(bridge.b);
    group.bridges.push(bridge);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((group) => ({ keys: [...group.keys].sort(), bridges: group.bridges }))
    .sort((p, q) => (p.keys[0] ?? '').localeCompare(q.keys[0] ?? ''));
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Distinct values, clustered within `tolerance`, ascending. */
function levels(values: readonly number[], tolerance: number): number[] {
  const sorted = [...values].sort((p, q) => p - q);
  const out: number[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || value - last > tolerance) out.push(value);
  }
  return out;
}

/**
 * Where the trunk runs across `across` (the coordinate the stubs travel in):
 * a group on several rows gets the channel between two neighbouring rows
 * that keeps the stubs shortest; a group on one row gets a line `gap` off it,
 * toward `toward`.
 */
function trunkAt(across: readonly number[], gap: number, toward: number | undefined): number {
  const rows = levels(across, 1.5);
  if (rows.length === 1) {
    const row = rows[0]!;
    const sign = toward === undefined || toward >= row ? 1 : -1;
    return row + sign * gap;
  }
  let best = (rows[0]! + rows[1]!) / 2;
  let cost = Infinity;
  for (let k = 0; k + 1 < rows.length; k += 1) {
    const channel = (rows[k]! + rows[k + 1]!) / 2;
    const total = across.reduce((sum, value) => sum + Math.abs(value - channel), 0);
    if (total < cost - 1e-6) {
      cost = total;
      best = channel;
    }
  }
  return best;
}

/**
 * The bus of each bridged group whose terminals all have a point. The trunk
 * runs along the group's longer spread (horizontal for a face's pin rows,
 * vertical for a column of pads), stubs square to it.
 */
export function busPaths(points: ReadonlyMap<string, XY>, bridges: readonly Bridge[], options: BusOptions = {}): BusPath[] {
  const gap = options.gap ?? 4;
  const out: BusPath[] = [];
  for (const group of bridgeGroups(bridges)) {
    const at = group.keys.map((key) => points.get(key));
    if (at.some((point) => point === undefined) || at.length < 2) continue;
    const pts = at as XY[];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    const parts: string[] = [];
    if (spreadX >= spreadY) {
      const y = round(trunkAt(ys, gap, options.toward?.y));
      parts.push(`M${round(Math.min(...xs))} ${y}H${round(Math.max(...xs))}`);
      for (const p of pts) if (Math.abs(p.y - y) > 0.01) parts.push(`M${round(p.x)} ${round(p.y)}V${y}`);
    } else {
      const x = round(trunkAt(xs, gap, options.toward?.x));
      parts.push(`M${x} ${round(Math.min(...ys))}V${round(Math.max(...ys))}`);
      for (const p of pts) if (Math.abs(p.x - x) > 0.01) parts.push(`M${round(p.x)} ${round(p.y)}H${x}`);
    }
    out.push({
      d: parts.join(''),
      keys: group.keys,
      joints: group.bridges.map((bridge) => bridge.index).sort((p, q) => p - q),
      selected: group.bridges.some((bridge) => bridge.selected),
    });
  }
  return out;
}
