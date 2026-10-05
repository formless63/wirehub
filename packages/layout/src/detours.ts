/**
 * Keep-outs and the lanes that go round them.
 *
 * A component symbol stands in the fan corridor at a y derived from the
 * anchors it bridges, and a deliberate cut end's glyph stands just past the
 * band's edge, so lane discipline alone cannot keep a run out of them: the
 * router projects a blocked lane out of each keep-out (`clearLaneX`), settles
 * all lanes so no two nets share a line (`settleLanes`), and re-cuts a
 * finished route round whatever it still runs through (`avoidObstacles`).
 * Pure geometry, deterministic, no layout state.
 */

import { METRICS as M } from './metrics.ts';
import type { DiagramComponent, DiagramCutEnd, Point } from './model.ts';
import { textWidth } from './text.ts';

/**
 * A rectangle the router may not run through: one component symbol and its
 * designator, grown by a clearance, or (lanes only) a cut end's glyph.
 *
 * Blocks and bands are kept clear by construction (a route may not turn until
 * it has left its block, and both columns are flush on their cable side), but
 * a component sits *in* the fan corridor at a y derived from the anchors it
 * bridges, so no amount of lane discipline moves it out of another run's way.
 * It has to be routed around — see `avoidObstacles`.
 */
export interface Obstacle {
  /** owning instance: a joint attached to it is allowed to run into it */
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /**
   * Keeps vertical lanes out only (`clearLaneX`); horizontal runs pass it.
   * A cut end's glyph sits on its own track's row, level with its
   * neighbours' exits — a horizontal detour round it would jog every one.
   */
  laneOnly?: true;
  /** the face a lane is always moved to (+1 `x1`, -1 `x0`), not the nearer one */
  push?: -1 | 1;
}

/** Comparison of two coordinates below which the router calls them equal. */
export const OBSTACLE_EPS = 0.02;

/**
 * How many times a route may be re-cut before the router gives up.
 *
 * A detour is placed exactly on the keep-out's face, so it never re-enters the
 * obstacle that caused it, and each pass therefore has to find a *different*
 * obstacle to react to. The catalog's deepest route needs one pass; the bound
 * is here so that a pathological arrangement fails visibly in the audit rather
 * than spinning.
 */
export const MAX_DETOUR_PASSES = 12;

/** `value` strictly between the two, by more than the comparison epsilon. */
export function strictlyBetween(value: number, low: number, high: number): boolean {
  return value > low + OBSTACLE_EPS && value < high - OBSTACLE_EPS;
}

/** Do `[a0,a1]` and `[b0,b1]` share more than an epsilon of overlap? */
export function spansOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.min(a1, b1) - Math.max(a0, b0) > OBSTACLE_EPS;
}

/** The keep-out of one drawn component symbol, clearance included. */
export function componentObstacle(component: DiagramComponent): Obstacle {
  const { rect } = component;
  // a capacitor is drawn as two plates that stand proud of the body rect
  const overhang =
    component.symbol === 'capacitor' || component.symbol === 'capacitor-polarized'
      ? M.componentPlateOverhang
      : 0;
  // the designator printed over it: a lane down through
  // "r1 · 470 Ω" strikes the value out just as surely as one through the body
  // hides the wire. Its box reaches cap height above the baseline, and it is
  // centred on the body, so it may be wider than the body.
  const labelHalf = textWidth(component.label, M.fontComponentLabel, 'bold') / 2;
  const labelTop = component.labelY - M.fontComponentLabel * 0.72;
  return {
    id: component.id,
    x0: Math.min(rect.x, component.labelX - labelHalf) - M.componentClearance,
    y0: Math.min(rect.y - overhang - M.componentClearance, labelTop - LABEL_CLEARANCE),
    x1: Math.max(rect.x + rect.w, component.labelX + labelHalf) + M.componentClearance,
    y1: rect.y + rect.h + overhang + M.componentClearance,
  };
}

/** What a lane keeps from a label's cap height — less than from a body: type is lighter than a wire. */
export const LABEL_CLEARANCE = 0.4;

/**
 * The lane keep-out of a deliberate cut end: its glyph and note ref, which
 * stand in the fan corridor just past the band's edge (`renderCutEnds` draws
 * the glyph 2.2 mm out, the ref 2.4 mm past that). A lane is always moved
 * outward past it, never back toward the band.
 */
export function cutEndObstacle(cut: DiagramCutEnd): Obstacle {
  const refWidth = cut.noteRef === undefined ? 0 : textWidth(String(cut.noteRef), M.fontCutRef, 'bold');
  const reach = 2.2 + 1.4 + (cut.noteRef === undefined ? 0 : 1 + refWidth) + LABEL_CLEARANCE;
  const top = cut.noteRef === undefined ? cut.y - 1.9 : Math.min(cut.y - 1.9, cut.y - 1.4 - M.fontCutRef * 0.72);
  return {
    id: `cut:${cut.key}`,
    x0: cut.dir === 1 ? cut.x : cut.x - reach,
    x1: cut.dir === 1 ? cut.x + reach : cut.x,
    y0: top - LABEL_CLEARANCE,
    y1: cut.y + 1.9 + LABEL_CLEARANCE,
    laneOnly: true,
    push: cut.dir,
  };
}

/**
 * Slide a vertical lane sideways until it misses every obstacle it would
 * otherwise run down through, to the **nearer** face of whatever it hit.
 *
 * Doing this before the route is cut, rather than patching the finished
 * polyline, is what keeps the corner where the lane meets its horizontal run
 * out of a component body: a corner *inside* an obstacle has nowhere to detour
 * to, and every obstacle standing in the horizontal run's way also stands in
 * the lane's way, because the run's y is one end of the lane's span.
 */
export function clearLaneX(
  candidate: number,
  yFrom: number,
  yTo: number,
  obstacles: readonly Obstacle[],
): { x: number; face?: LaneFace } {
  const low = Math.min(yFrom, yTo);
  const high = Math.max(yFrom, yTo);
  let x = candidate;
  let face: LaneFace | undefined;
  for (let pass = 0; pass < MAX_DETOUR_PASSES; pass += 1) {
    const hit = obstacles.find(
      (item) =>
        spansOverlap(low, high, item.y0, item.y1) && strictlyBetween(x, item.x0, item.x1),
    );
    if (hit === undefined) break;
    const side = hit.push ?? (x - hit.x0 <= hit.x1 - x ? -1 : 1);
    x = side === -1 ? hit.x0 : hit.x1;
    face = { key: `${hit.id}:${side}`, x, outward: side };
  }
  return face === undefined ? { x } : { x, face };
}

/** The keep-out face a lane was projected onto: where the spread starts from. */
export interface LaneFace {
  /** `<obstacle id>:<side>` */
  key: string;
  x: number;
  /** the direction away from the keep-out */
  outward: -1 | 1;
}

/** One vertical lane of one route, as `settleLanes` sees it. */
export interface LanePlan {
  /** `<joint index>:<leg>`; leg -1 is a same-column run's single lane */
  id: string;
  /** where the lane stands after `clearLaneX` */
  x: number;
  /** the keep-out face it was projected onto, when it was */
  face?: LaneFace;
  /** the lane's x before projection, for keeping the runs' order */
  candidate: number;
  y0: number;
  y1: number;
  /** the x range the lane may move in without leaving its own corridor */
  lo: number;
  hi: number;
  net?: string;
  tie: number;
  /** the keep-outs this lane's own run has to miss */
  obstacles: readonly Obstacle[];
}

/** Half a lane pitch: the step a lane takes to get off a line, and off a face. */
export const LANE_TOUCH = M.lanePitchMin / 2;

/**
 * Two runs of different nets whose centre lines are closer than this, over a
 * shared stretch, are drawn as one line — the thinnest stroke on the sheet is
 * wider. Runs merely *near* each other are the corridor's business (its lane
 * pitch), not this pass's: moving those would reshuffle every fan for no
 * reading gain.
 */
export const COINCIDENT = 0.5;

/**
 * Settle every route's vertical lanes so no two nets draw on top of each
 * other.
 *
 * **Spread after projection.** Every blocked lane is moved to the nearer face
 * of what blocked it, so two runs held up by the same keep-out land on the
 * same x, and where their spans overlap their verticals draw one on top of
 * the other — which on a schematic reads as a connection. So the lanes on
 * each face are re-spaced **outward**, never back into the keep-out: the
 * first stands half a pitch off the face (where a horizontal run detouring
 * round the same keep-out turns), each next a lane pitch further out, only
 * as far as it needs to clear the lanes already placed whose spans it
 * shares. Their order is the one the corridor gave them before projection
 * (the lane nearest the face stays nearest), so the spread adds no crossing
 * among them.
 *
 * **Coincident lanes.** Lanes are chosen per corridor, and a same-column
 * bracket's lane and a forward run's lane through the same stretch are
 * chosen by different rules, so two of them can still land on one x. The
 * later run (by joint) steps aside to the nearest free x within its own
 * corridor — a projected lane only outward.
 *
 * A lane with nowhere to go stays where it is; the audit then says so.
 */
export function settleLanes(lanes: readonly LanePlan[]): Map<string, number> {
  const x = new Map(lanes.map((lane) => [lane.id, lane.x] as const));
  const free = (lane: LanePlan, at: number): boolean =>
    at >= lane.lo - OBSTACLE_EPS &&
    at <= lane.hi + OBSTACLE_EPS &&
    !lane.obstacles.some(
      (item) => spansOverlap(lane.y0, lane.y1, item.y0, item.y1) && strictlyBetween(at, item.x0, item.x1),
    );

  const byFace = new Map<string, LanePlan[]>();
  for (const lane of lanes) {
    if (lane.face === undefined) continue;
    const list = byFace.get(lane.face.key);
    if (list === undefined) byFace.set(lane.face.key, [lane]);
    else list.push(lane);
  }
  for (const list of byFace.values()) {
    const outward = list[0]!.face!.outward;
    // nearest the face first: the one whose own lane was nearest it
    list.sort((p, q) =>
      p.candidate !== q.candidate ? (q.candidate - p.candidate) * -outward : p.tie - q.tie,
    );
    const placed: { x: number; y0: number; y1: number }[] = [];
    for (const lane of list) {
      const face = lane.face!.x;
      let chosen = face;
      // never on the face itself: that is where a horizontal run that
      // detours round the same keep-out turns (`detourSegment`)
      for (let step = 0; step < MAX_DETOUR_PASSES; step += 1) {
        const at = face + outward * (LANE_TOUCH + step * M.lanePitchMin);
        const clash = placed.some(
          (other) =>
            Math.abs(other.x - at) < M.lanePitchMin - OBSTACLE_EPS &&
            spansOverlap(lane.y0, lane.y1, other.y0, other.y1),
        );
        if (clash || !free(lane, at)) continue;
        chosen = at;
        break;
      }
      placed.push({ x: chosen, y0: lane.y0, y1: lane.y1 });
      x.set(lane.id, chosen);
    }
  }

  const placed: { x: number; y0: number; y1: number; net: string | undefined }[] = [];
  const clashes = (lane: LanePlan, at: number): boolean =>
    placed.some(
      (other) =>
        (other.net === undefined || other.net !== lane.net) &&
        Math.abs(other.x - at) < COINCIDENT &&
        spansOverlap(lane.y0, lane.y1, other.y0, other.y1),
    );
  const ordered = [...lanes].sort((p, q) => (p.tie !== q.tie ? p.tie - q.tie : p.id.localeCompare(q.id)));
  for (const lane of ordered) {
    let at = x.get(lane.id)!;
    if (clashes(lane, at)) {
      const directions: (-1 | 1)[] = lane.face === undefined ? [1, -1] : [lane.face.outward];
      search: for (let step = 1; step <= 2 * MAX_DETOUR_PASSES; step += 1) {
        for (const direction of directions) {
          const next = at + direction * step * LANE_TOUCH;
          if (free(lane, next) && !clashes(lane, next)) {
            at = next;
            break search;
          }
        }
      }
      x.set(lane.id, at);
    }
    placed.push({ x: at, y0: lane.y0, y1: lane.y1, net: lane.net });
  }

  const out = new Map<string, number>();
  for (const lane of lanes) {
    const settled = x.get(lane.id)!;
    if (settled !== lane.x) out.set(lane.id, settled);
  }
  return out;
}

/**
 * The four points that carry one segment around one obstacle, or `undefined`
 * when the segment is already clear of every one of them.
 *
 * A **horizontal** run always detours *below* the body. That is not a coin
 * toss dressed up as a rule: a component's designator sits directly above its
 * symbol (`labelY = rect.y - 1.6`), so the shorter way over the top is exactly
 * where the part number is printed, and a wire drawn through "c2 · 100 nF" is
 * a worse drawing than a wire that dips 6 mm. A **vertical** run has no such
 * asymmetry and takes the nearer side.
 *
 * A segment whose own endpoint lies inside the keep-out is left alone: there
 * is no jog that helps, and the audit says so out loud rather than the router
 * quietly folding the wire back on itself.
 *
 * `ring` is how far out this route's detour round `item` stands: every other
 * net already detouring round the same keep-out has taken the ring inside
 * it, so two hops round one component nest instead of sharing a line.
 */
export function detourSegment(
  a: Point,
  b: Point,
  obstacles: readonly Obstacle[],
  ring: (item: Obstacle) => number = () => 0,
): { points: Point[]; item: Obstacle } | undefined {
  if (a.y === b.y && a.x !== b.x) {
    const low = Math.min(a.x, b.x);
    const high = Math.max(a.x, b.x);
    const forward = b.x > a.x;
    let best: { entry: number; exit: number; at: number; distance: number; item: Obstacle } | undefined;
    for (const item of obstacles) {
      if (!strictlyBetween(a.y, item.y0, item.y1)) continue;
      if (Math.min(high, item.x1) - Math.max(low, item.x0) <= OBSTACLE_EPS) continue;
      if (
        strictlyBetween(a.x, item.x0, item.x1) ||
        strictlyBetween(b.x, item.x0, item.x1)
      ) {
        continue;
      }
      const out = ring(item);
      // an outer ring never starts behind the run's own start or ends past
      // its end: it drops straight off the lane it came in on instead
      const entry = forward ? Math.max(a.x, item.x0 - out) : Math.min(a.x, item.x1 + out);
      const exit = forward ? Math.min(b.x, item.x1 + out) : Math.max(b.x, item.x0 - out);
      const distance = Math.abs((forward ? item.x0 : item.x1) - a.x);
      if (best !== undefined && distance >= best.distance) continue;
      best = { entry, exit, at: item.y1 + out, distance, item };
    }
    if (best === undefined) return undefined;
    return {
      item: best.item,
      points: [
        { x: best.entry, y: a.y },
        { x: best.entry, y: best.at },
        { x: best.exit, y: best.at },
        { x: best.exit, y: a.y },
      ],
    };
  }

  if (a.x === b.x && a.y !== b.y) {
    const low = Math.min(a.y, b.y);
    const high = Math.max(a.y, b.y);
    const downward = b.y > a.y;
    let best: { entry: number; exit: number; at: number; distance: number; item: Obstacle } | undefined;
    for (const item of obstacles) {
      if (!strictlyBetween(a.x, item.x0, item.x1)) continue;
      if (Math.min(high, item.y1) - Math.max(low, item.y0) <= OBSTACLE_EPS) continue;
      if (
        strictlyBetween(a.y, item.y0, item.y1) ||
        strictlyBetween(b.y, item.y0, item.y1)
      ) {
        continue;
      }
      const out = ring(item);
      const entry = downward ? Math.max(a.y, item.y0 - out) : Math.min(a.y, item.y1 + out);
      const distance = Math.abs((downward ? item.y0 : item.y1) - a.y);
      if (best !== undefined && distance >= best.distance) continue;
      best = {
        entry,
        exit: downward ? Math.min(b.y, item.y1 + out) : Math.max(b.y, item.y0 - out),
        at: a.x - item.x0 <= item.x1 - a.x ? item.x0 - out : item.x1 + out,
        distance,
        item,
      };
    }
    if (best === undefined) return undefined;
    return {
      item: best.item,
      points: [
        { x: a.x, y: best.entry },
        { x: best.at, y: best.entry },
        { x: best.at, y: best.exit },
        { x: a.x, y: best.exit },
      ],
    };
  }

  return undefined;
}

/** Drop repeated points, and any point its two neighbours draw straight past. */
export function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === point.x && last.y === point.y) continue;
    out.push(point);
  }
  for (let index = 1; index < out.length - 1; ) {
    const before = out[index - 1]!;
    const here = out[index]!;
    const after = out[index + 1]!;
    const collinear =
      (before.x === here.x && here.x === after.x) ||
      (before.y === here.y && here.y === after.y);
    if (!collinear) {
      index += 1;
      continue;
    }
    out.splice(index, 1);
    // the join it just made may itself be a straight-through or a spur
    if (index > 1) index -= 1;
  }
  return out;
}

/**
 * Re-cut a finished route around every obstacle it runs through, one obstacle
 * at a time, earliest violation along the path first.
 *
 * Deterministic end to end: the obstacle list is in a fixed order, "earliest
 * along the path" is a total order over (segment index, distance from the
 * segment's start), and the side each detour takes is fixed by geometry, not
 * by which route happened to be routed first. Nothing here reads a clock, a
 * hash or an insertion order.
 */
export function avoidObstacles(
  points: Point[],
  obstacles: readonly Obstacle[],
  rings?: DetourRings,
  net?: string,
): Point[] {
  if (obstacles.length === 0) return points;
  let current = points;
  let cut = false;
  const ring = (item: Obstacle): number => {
    const nets = rings?.get(item.id) ?? [];
    const at = net === undefined ? -1 : nets.indexOf(net);
    return (at === -1 ? nets.length : at) * M.lanePitchMin;
  };
  for (let pass = 0; pass < MAX_DETOUR_PASSES; pass += 1) {
    let spliced = false;
    for (let index = 1; index < current.length; index += 1) {
      const detour = detourSegment(current[index - 1]!, current[index]!, obstacles, ring);
      if (detour === undefined) continue;
      if (rings !== undefined) {
        const nets = rings.get(detour.item.id) ?? [];
        rings.set(detour.item.id, nets);
        // a run with no net takes a ring of its own
        if (net === undefined || !nets.includes(net)) nets.push(net ?? `?${nets.length}`);
      }
      current = [...current.slice(0, index), ...detour.points, ...current.slice(index)];
      spliced = true;
      cut = true;
      break;
    }
    if (!spliced) break;
  }
  // an untouched route keeps the exact point list it has always had, so a
  // design with nothing in the way sees no churn at all
  return cut ? simplify(current) : current;
}

/** keep-out id → the nets already detouring round it, innermost ring first */
export type DetourRings = Map<string, (string | undefined)[]>;

/** One finished route, as `separateRoutes` sees it. */
export interface FinishedRoute {
  points: readonly Point[];
  net?: string;
  /** every keep-out the route has to miss, lane-only ones included */
  obstacles: readonly Obstacle[];
}

/**
 * Shortest shared stretch that counts as two runs drawn as one — a hair under
 * the audit's 0.3 mm, so a stretch that rounds to it on the page is caught here.
 */
const SHARED_RUN = 0.25;

interface Stretch {
  vertical: boolean;
  at: number;
  lo: number;
  hi: number;
  net: string | undefined;
}

function stretchOf(a: Point, b: Point, net: string | undefined): Stretch | undefined {
  if (a.x === b.x && a.y !== b.y) {
    return { vertical: true, at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), net };
  }
  if (a.y === b.y && a.x !== b.x) {
    return { vertical: false, at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), net };
  }
  return undefined;
}

function stretchesOf(points: readonly Point[], net: string | undefined): Stretch[] {
  const out: Stretch[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const stretch = stretchOf(points[index - 1]!, points[index]!, net);
    if (stretch !== undefined) out.push(stretch);
  }
  return out;
}

function shares(first: Stretch, second: Stretch): boolean {
  return (
    first.vertical === second.vertical &&
    (first.net === undefined || first.net !== second.net) &&
    Math.abs(first.at - second.at) < COINCIDENT &&
    Math.min(first.hi, second.hi) - Math.max(first.lo, second.lo) > SHARED_RUN
  );
}

function runsThrough(points: readonly Point[], obstacles: readonly Obstacle[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    for (const item of obstacles) {
      if (a.x === b.x) {
        if (
          strictlyBetween(a.x, item.x0, item.x1) &&
          spansOverlap(Math.min(a.y, b.y), Math.max(a.y, b.y), item.y0, item.y1)
        ) {
          return true;
        }
      } else if (a.y === b.y && item.laneOnly === undefined) {
        if (
          strictlyBetween(a.y, item.y0, item.y1) &&
          spansOverlap(Math.min(a.x, b.x), Math.max(a.x, b.x), item.x0, item.x1)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * The backstop: no two nets drawn along one line.
 *
 * `settleLanes` keeps the corridor lanes apart, but a detour's legs are cut
 * after it, on the faces of the keep-out they go round, and may land on
 * another run's lane. So once every route is finished, each route in turn —
 * the earlier ones stay put — moves any inner stretch that shares a line with
 * an earlier route's run of another net sideways by the smallest step that
 * clears it: its two neighbouring stretches keep their direction, it runs
 * through no keep-out, and the route ends up sharing fewer lines than it
 * did. A route's first and last stretches land on anchors and never move
 * sideways; the lane beside one moves instead, and the end stretch with it —
 * and when that cannot help, the earlier run steps aside instead, if the
 * stretch it shares is an inner one.
 */
export function separateRoutes(routes: readonly FinishedRoute[]): Point[][] {
  const out: Point[][] = [];
  const nets = routes.map((route) => route.net);

  /** every stretch drawn so far, but route `skip`'s, plus `extra` */
  const others = (skip: number, extra: readonly Stretch[] = []): Stretch[] => [
    ...out.flatMap((points, at) => (at === skip ? [] : stretchesOf(points, nets[at]))),
    ...extra,
  ];
  const clashCount = (points: readonly Point[], net: string | undefined, against: readonly Stretch[]): number =>
    stretchesOf(points, net).filter((stretch) => against.some((other) => shares(stretch, other))).length;

  /**
   * `points` with stretch `index` moved sideways by the smallest step that
   * lowers its route's clashes against `against`, or undefined.
   */
  const shift = (
    points: readonly Point[],
    index: number,
    net: string | undefined,
    obstacles: readonly Obstacle[],
    against: readonly Stretch[],
  ): Point[] | undefined => {
    if (index < 1 || index + 2 >= points.length) return undefined;
    const stretch = stretchOf(points[index]!, points[index + 1]!, net);
    if (stretch === undefined) return undefined;
    const before = clashCount(points, net, against);
    const axis = stretch.vertical ? 'x' : 'y';
    for (let step = 1; step <= 2 * MAX_DETOUR_PASSES; step += 1) {
      for (const direction of [1, -1]) {
        const at = stretch.at + direction * step * LANE_TOUCH;
        const moved = points.map((point) => ({ ...point }));
        const p = moved[index]!;
        const q = moved[index + 1]!;
        const prev = moved[index - 1]!;
        const next = moved[index + 2]!;
        // the stretches either side keep their direction, and some length
        if (Math.sign(at - prev[axis]) !== Math.sign(p[axis] - prev[axis]) || at === prev[axis]) continue;
        if (Math.sign(next[axis] - at) !== Math.sign(next[axis] - q[axis]) || at === next[axis]) continue;
        p[axis] = at;
        q[axis] = at;
        if (runsThrough(moved.slice(index - 1, index + 3), obstacles)) continue;
        if (clashCount(moved, net, against) >= before) continue;
        return moved;
      }
    }
    return undefined;
  };

  routes.forEach((route) => {
    let points = route.points.map((point) => ({ ...point }));
    for (let at0 = 0; at0 + 1 < points.length; at0 += 1) {
      const hit = stretchOf(points[at0]!, points[at0 + 1]!, route.net);
      if (hit === undefined) continue;
      const earlier = others(-1);
      if (!earlier.some((other) => shares(hit, other))) continue;
      // an end stretch is pinned to its anchor: move the lane next to it,
      // which slides where the end stretch stops instead
      const index = at0 === 0 ? 1 : at0 + 2 === points.length ? at0 - 1 : at0;
      const moved = shift(points, index, route.net, route.obstacles, earlier);
      if (moved !== undefined) {
        points = moved;
        continue;
      }
      // this route cannot get off the line: the earlier run it shares with
      // may, if its own stretch there is an inner one
      out.forEach((theirs, at) => {
        const hitNow = stretchOf(points[at0]!, points[at0 + 1]!, route.net);
        if (hitNow === undefined) return;
        for (let index2 = 1; index2 + 2 < theirs.length; index2 += 1) {
          const stretch = stretchOf(theirs[index2]!, theirs[index2 + 1]!, nets[at]);
          if (stretch === undefined || !shares(stretch, hitNow)) continue;
          const against = others(at, stretchesOf(points, route.net));
          const shifted = shift(theirs, index2, nets[at], routes[at]!.obstacles, against);
          if (shifted !== undefined) out[at] = shifted;
          return;
        }
      });
    }
    out.push(points);
  });
  dogLegEnds(out, routes);
  return out;
}

/**
 * How far past the last shared stretch a dog-legged run drops back onto its
 * anchor's line: a lane, plus the approach lead the renderer may draw on past
 * the pad that stretch lands on.
 */
const DOG_LEG_CLEAR = M.approachLead + M.lanePitchMin;

/** The shortest landing a dog-leg leaves between its drop and the anchor. */
const DOG_LEG_LANDING = 1;

/**
 * The end stretches `separateRoutes` cannot move.
 *
 * Several pads, slots or pins in one row (a board's pad row, an entry guide's
 * slots, a connector's far row) are fixed where they land, and a run to the
 * far one arrives along the row straight over the near one's run. Such a run
 * takes a short **dog-leg** instead: it comes in on a row a lane off its
 * anchor's line, drops back onto that line just past the last stretch it
 * shared, and lands. Its lane (the stretch before the end one) is extended or
 * shortened to meet the new row, so the route stays orthogonal. Offsets try
 * the nearest free row first, either side; a dog-leg that runs through a
 * keep-out or does not lower the route's clashes is not taken. Mutates `out`.
 */
function dogLegEnds(out: Point[][], routes: readonly FinishedRoute[]): void {
  const nets = routes.map((route) => route.net);
  const others = (skip: number): Stretch[] =>
    out.flatMap((points, at) => (at === skip ? [] : stretchesOf(points, nets[at])));
  /** every (own stretch, other stretch) pair drawn along one line */
  const clashCount = (points: readonly Point[], net: string | undefined, against: readonly Stretch[]): number =>
    stretchesOf(points, net).reduce((sum, stretch) => sum + against.filter((other) => shares(stretch, other)).length, 0);

  /** route `at` dog-legged at its `end`, if that helps; true when it moved */
  const dogLeg = (at: number, end: 'first' | 'last'): boolean => {
    const net = nets[at];
    const points = out[at]!;
    if (points.length < 3) return false;
    // work on the route as if `end` were its last point
    const walk = end === 'last' ? points : [...points].reverse();
    const n = walk.length;
    const anchor = walk[n - 1]!;
    const q = walk[n - 2]!;
    const p = walk[n - 3]!;
    const landing = stretchOf(q, anchor, net);
    const lane = stretchOf(p, q, net);
    if (landing === undefined || lane === undefined || lane.vertical === landing.vertical) return false;
    const against = others(at);
    const shared = against.filter((other) => shares(landing, other));
    if (shared.length === 0) return false;

    const u: 'x' | 'y' = landing.vertical ? 'y' : 'x';
    const v: 'x' | 'y' = landing.vertical ? 'x' : 'y';
    const toward = Math.sign(anchor[u] - q[u]);
    // the far edge (toward the anchor) of everything shared on the line
    const reach = shared.reduce(
      (edge, other) => (toward > 0 ? Math.max(edge, other.hi) : Math.min(edge, other.lo)),
      toward > 0 ? -Infinity : Infinity,
    );
    const drop = reach + toward * DOG_LEG_CLEAR;
    // a run shared past the anchor itself, or right up to it, cannot be left
    if (toward * (anchor[u] - drop) < DOG_LEG_LANDING) return false;
    if (toward * (drop - q[u]) <= 0) return false;

    const before = clashCount(walk, net, against);
    let best: Point[] | undefined;
    // a lane and a half off the line at least: clear of the copper ring of the
    // pad it passes (half a lane reads as the same wire, blurred)
    for (let step = 3; step <= 2 * MAX_DETOUR_PASSES && best === undefined; step += 1) {
      for (const direction of [1, -1]) {
        const offset = anchor[v] + direction * step * LANE_TOUCH;
        const qMoved = { ...q, [v]: offset };
        if (qMoved[v] === p[v] && qMoved[u] === p[u]) continue;
        const legIn = { [u]: drop, [v]: offset } as unknown as Point;
        const legOut = { [u]: drop, [v]: anchor[v] } as unknown as Point;
        const candidate = simplify([...walk.slice(0, n - 2), qMoved, legIn, legOut, anchor]);
        if (runsThrough(candidate.slice(Math.max(0, n - 3)), routes[at]!.obstacles)) continue;
        if (clashCount(candidate, net, against) >= before) continue;
        best = candidate;
        break;
      }
    }
    if (best === undefined) return false;
    out[at] = end === 'last' ? best : best.reverse();
    return true;
  };

  // a run that leaves a line frees it for the next: settle in a few passes
  for (let pass = 0; pass < 3; pass += 1) {
    let moved = false;
    for (let at = 0; at < out.length; at += 1) {
      if (dogLeg(at, 'last')) moved = true;
      if (dogLeg(at, 'first')) moved = true;
    }
    if (!moved) break;
  }
}
