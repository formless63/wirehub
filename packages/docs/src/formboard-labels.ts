/**
 * Label collision avoidance for the formboard: small convex-polygon geometry
 * and a placer that keeps a caption off the glyphs, pegs, ticks, runs and the
 * captions already placed.
 *
 * Everything is in paper millimetres. A caption is a rotated rectangle sized
 * from the face's real glyph widths (`textWidth`); a candidate position is
 * tried in a fixed order and the first that touches nothing wins, so the
 * result is deterministic and a caption whose home position is free stays
 * exactly where it was. A caption that no candidate frees keeps its home
 * position (an overlap is better than a label lost). Pure.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A convex polygon (or, with two points, a segment). */
export type Poly = readonly Pt[];

export interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A rectangle `w` by `h` centred on `c`, turned `angleDeg` about its centre, grown by `pad` on every side. */
export function rotatedRect(c: Pt, w: number, h: number, angleDeg: number, pad = 0): Poly {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hw = w / 2 + pad;
  const hh = h / 2 + pad;
  return ([
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const).map(([x, y]) => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos }));
}

/** A thick line as a rectangle (a run, a tick, a sleeve band). */
export function thickLine(a: Pt, b: Pt, width: number): Poly {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

function axes(poly: Poly): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    if (poly.length === 2 && i === 1) break;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) out.push({ x: -dy / len, y: dx / len });
  }
  return out;
}

function project(poly: Poly, axis: Pt): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** Whether two convex polygons overlap (separating-axis test; touching is not overlap). */
export function overlaps(a: Poly, b: Poly): boolean {
  for (const axis of [...axes(a), ...axes(b)]) {
    const [a0, a1] = project(a, axis);
    const [b0, b1] = project(b, axis);
    if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return false;
  }
  return true;
}

/** What a caption must stay clear of: fixed things first, then each caption as it is placed. */
export class Occupied {
  private readonly polys: Poly[] = [];

  add(poly: Poly): void {
    this.polys.push(poly);
  }

  hits(poly: Poly): boolean {
    return this.polys.some((p) => overlaps(poly, p));
  }
}

/** Whether every corner of `poly` is inside the view (always, without one). */
export function withinView(poly: Poly, view: View | undefined): boolean {
  return view === undefined || poly.every((p) => p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1);
}

/**
 * The first candidate that touches nothing is placed (and recorded); when none is
 * free the first candidate, the caption's home position, is kept.
 */
export function placeFirstFree<T>(occupied: Occupied, candidates: readonly T[], polyOf: (candidate: T) => Poly, view?: View): T {
  // a caption whose home place is on the page is not moved off it
  const home = candidates[0];
  const keep = view !== undefined && home !== undefined && withinView(polyOf(home), view);
  const free = candidates.find((candidate) => (!keep || withinView(polyOf(candidate), view)) && !occupied.hits(polyOf(candidate)));
  const chosen = free ?? (candidates[0] as T);
  occupied.add(polyOf(chosen));
  return chosen;
}

/** The shift along x that brings `[x0, x1]` inside the view, or 0 when it already is or does not fit. */
export function shiftIntoView(x0: number, x1: number, view: View | undefined, inset = 1): number {
  if (view === undefined) return 0;
  const left = view.x0 + inset;
  const right = view.x1 - inset;
  if (x1 - x0 > right - left) return 0;
  if (x0 < left) return left - x0;
  if (x1 > right) return right - x1;
  return 0;
}
