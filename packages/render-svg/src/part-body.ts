/**
 * A mounted part's top-down solid-model drawing: the
 * shapes a real chip resistor, MLCC, tantalum or electrolytic capacitor,
 * SOIC/SOT IC, diode/LED or solder jumper would show from directly above,
 * instead of the plain labelled box every part drew before.
 *
 * Pure geometry, computed once from the catalog's `BoardPart` (its `outline`
 * already carries the footprint's rotation; `package` names the family and,
 * for a leaded IC, the real pin count/pitch the importer measured off the
 * board file) — **in the same anchor-frame units as `outline` and `pin1`**.
 * That is the whole trick that lets one function serve both renderers: every
 * point a shape carries is a point `outline` could have carried, so the
 * canvas (`editor-react/board-art.ts`, which mirrors/rotates/scales an
 * arbitrary `(x, y)` through `place()`) and the schematic
 * (`board-parts.ts`, which prints raw depiction-frame coordinates straight
 * into the page) each transform it exactly as they already transform
 * `outline` — no shape-specific code in either renderer, just paint.
 *
 * A part with no recognised `package` (an inductor, a switch, a connector,
 * or an R/C/IC footprint outside the classified families) returns no
 * shapes at all: the caller's plain outlined box is the fallback, the one
 * house style every part has always drawn, never nothing. A solder jumper
 * is handled here too, from `kind`/`state` alone — `unset` also returns no
 * shapes, keeping its existing dotted-box treatment.
 */

import type { BoardPart } from '@wirehub/catalog';

/** A CSS class suffix (`pt-<tone>` / `cs-pt-<tone>`) — see each renderer's stylesheet. */
export type PartTone =
  | 'chip-body'
  | 'chip-end'
  | 'mlcc-body'
  | 'mlcc-end'
  | 'tant-body'
  | 'tant-band'
  | 'elec-body'
  | 'elec-stripe'
  | 'ic-body'
  | 'ic-lead'
  | 'diode-body'
  | 'diode-band'
  | 'led-body'
  | 'led-dome'
  | 'jumper-blob'
  | 'jumper-pad'
  | 'marking';

export type PartDetailShape =
  | { shape: 'polygon'; tone: PartTone; points: [number, number][] }
  | { shape: 'circle'; tone: PartTone; cx: number; cy: number; r: number }
  | { shape: 'text'; tone: PartTone; cx: number; cy: number; value: string }
  /** several disjoint polygons painted as one element (a lead comb) — cheap at the canvas Parts LOD */
  | { shape: 'multi'; tone: PartTone; groups: [number, number][][] };

/* ------------------------------------------------------------------ *
 * Resistor marking: 3-digit (2 significant figures + a power-of-ten
 * multiplier) or, under 10 Ω, the "R" notation in place of a decimal point.
 * ------------------------------------------------------------------ */

function ohmsOf(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)\s*(?:Ω|R|ohm)?$/.exec(value.trim());
  if (m === null) return undefined;
  const mag = Number(m[1]);
  const suffix = m[2] ?? '';
  const mult = suffix.toLowerCase() === 'k' ? 1e3 : suffix === 'M' ? 1e6 : 1;
  return mag * mult;
}

/** The marking a chip resistor's body would print, derived from its value (`180R` → `"181"`, `0R` → `"0"`). */
export function resistorMarking(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ohms = ohmsOf(value);
  if (ohms === undefined || !Number.isFinite(ohms) || ohms < 0) return undefined;
  if (ohms === 0) return '0';
  if (ohms < 10) {
    const whole = Math.floor(ohms);
    const frac = Math.round((ohms - whole) * 10) % 10;
    return frac === 0 ? `${whole}R0` : `${whole}R${frac}`;
  }
  const sig = 2;
  let exp = Math.floor(Math.log10(ohms)) - (sig - 1);
  let mantissa = Math.round(ohms / 10 ** exp);
  if (mantissa >= 10 ** sig) {
    exp += 1;
    mantissa = Math.round(mantissa / 10);
  }
  if (exp < 0 || exp > 9) return undefined; // outside the printable 3-digit range
  return `${mantissa}${exp}`;
}

/* ------------------------------------------------------------------ *
 * The body frame: `outline`'s four corners define a (possibly rotated)
 * rectangle; `pt(u, v)` maps a fraction of its width/height (u, v need not
 * stay within [0, 1] — a lead sticks out past the body edge) back into the
 * same coordinates `outline` is in.
 * ------------------------------------------------------------------ */

interface Frame {
  pt(u: number, v: number): [number, number];
  wu: number;
  wv: number;
  long: 'u' | 'v';
  /** a point's (u, v) — the inverse of `pt` (the outline is a rectangle, its edges orthogonal) */
  uv(p: readonly [number, number]): [number, number];
}

function frameOf(outline: readonly [number, number][]): Frame | undefined {
  const [c0, c1, , c3] = outline;
  if (c0 === undefined || c1 === undefined || c3 === undefined) return undefined;
  const ex: [number, number] = [c1[0] - c0[0], c1[1] - c0[1]];
  const ey: [number, number] = [c3[0] - c0[0], c3[1] - c0[1]];
  const wu = Math.hypot(ex[0], ex[1]);
  const wv = Math.hypot(ey[0], ey[1]);
  const long: 'u' | 'v' = wu >= wv ? 'u' : 'v';
  const eu = ex[0] * ex[0] + ex[1] * ex[1] || 1;
  const ev = ey[0] * ey[0] + ey[1] * ey[1] || 1;
  return {
    pt: (u, v) => [c0[0] + u * ex[0] + v * ey[0], c0[1] + u * ex[1] + v * ey[1]],
    wu,
    wv,
    long,
    uv: (p) => {
      const dx = p[0] - c0[0];
      const dy = p[1] - c0[1];
      return [(dx * ex[0] + dy * ex[1]) / eu, (dx * ey[0] + dy * ey[1]) / ev];
    },
  };
}

/** A pad's position in the body frame. */
interface FramePad {
  pad: string;
  u: number;
  v: number;
}

function framePads(frame: Frame, part: BoardPart): FramePad[] {
  return (part.pads ?? []).map((p) => {
    const [u, v] = frame.uv([p.x, p.y]);
    return { pad: p.pad, u, v };
  });
}

/**
 * The axis the part's pins run along, read off its pads (owner answers batch
 * 10): the one the pads take more distinct positions
 * along (a SOIC's leads spread along it; its two rows sit across it), and for
 * a two-pad part the one the pads lie apart on — never the body's aspect,
 * which a courtyard or fab box drawn around the leads can turn the other way.
 * Without pads, the body's long side (the drawing's old rule).
 */
function pinAxis(frame: Frame, pads: readonly FramePad[]): 'u' | 'v' {
  if (pads.length < 2) return frame.long;
  if (pads.length === 2) {
    const du = Math.abs(pads[0]!.u - pads[1]!.u) * frame.wu;
    const dv = Math.abs(pads[0]!.v - pads[1]!.v) * frame.wv;
    return du >= dv ? 'u' : 'v';
  }
  const distinct = (vs: readonly number[]): number => new Set(vs.map((x) => Math.round(x * 20))).size; // 0.05 mm
  const du = distinct(pads.map((p) => p.u * frame.wu));
  const dv = distinct(pads.map((p) => p.v * frame.wv));
  if (du !== dv) return du > dv ? 'u' : 'v';
  return frame.long;
}

function rectAt(frame: Frame, u0: number, u1: number, v0: number, v1: number, tone: PartTone): PartDetailShape {
  return {
    shape: 'polygon',
    tone,
    points: [frame.pt(u0, v0), frame.pt(u1, v0), frame.pt(u1, v1), frame.pt(u0, v1)],
  };
}

/** Two rects at the near/far ends of `axis`, each `frac` of its length. */
function endsAlong(frame: Frame, frac: number, tone: PartTone, axis: 'u' | 'v' = frame.long): [PartDetailShape, PartDetailShape] {
  return axis === 'u'
    ? [rectAt(frame, 0, frac, 0, 1, tone), rectAt(frame, 1 - frac, 1, 0, 1, tone)]
    : [rectAt(frame, 0, 1, 0, frac, tone), rectAt(frame, 0, 1, 1 - frac, 1, tone)];
}

/** `0` when a polarity point (pin1) sits nearer the near end of `axis`, `1` for the far end. */
function nearOrFar(frame: Frame, pin1: readonly [number, number] | undefined, axis: 'u' | 'v'): 0 | 1 {
  if (pin1 === undefined) return 0;
  const [u, v] = frame.uv(pin1);
  return (axis === 'u' ? u : v) <= 0.5 ? 0 : 1;
}

function opposite(index: 0 | 1): 0 | 1 {
  return index === 0 ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Per-family shapes
 * ------------------------------------------------------------------ */

function chipShapes(frame: Frame, axis: 'u' | 'v', body: PartTone, end: PartTone, marking: string | undefined): PartDetailShape[] {
  const out: PartDetailShape[] = [rectAt(frame, 0, 1, 0, 1, body), ...endsAlong(frame, 0.16, end, axis)];
  if (marking !== undefined) {
    const [cx, cy] = frame.pt(0.5, 0.5);
    out.push({ shape: 'text', tone: 'marking', cx, cy, value: marking });
  }
  return out;
}

function tantalumShapes(frame: Frame, axis: 'u' | 'v', pin1: readonly [number, number] | undefined): PartDetailShape[] {
  const bandIndex = nearOrFar(frame, pin1, axis);
  const band = endsAlong(frame, 0.22, 'tant-band', axis)[bandIndex];
  return [rectAt(frame, 0, 1, 0, 1, 'tant-body'), band];
}

function electrolyticShapes(frame: Frame, axis: 'u' | 'v', pin1: readonly [number, number] | undefined): PartDetailShape[] {
  const [cx, cy] = frame.pt(0.5, 0.5);
  const r = (Math.min(frame.wu, frame.wv) / 2) * 0.94;
  // the stripe marks the NEGATIVE lead — the end opposite pin1 (the positive pad)
  const stripeIndex: 0 | 1 = pin1 === undefined ? 0 : opposite(nearOrFar(frame, pin1, axis));
  const stripe = endsAlong(frame, 0.18, 'elec-stripe', axis)[stripeIndex];
  return [{ shape: 'circle', tone: 'elec-body', cx, cy, r }, stripe];
}

function diodeShapes(frame: Frame, axis: 'u' | 'v', pin1: readonly [number, number] | undefined, led: boolean): PartDetailShape[] {
  const body: PartTone = led ? 'led-body' : 'diode-body';
  const bandIndex = nearOrFar(frame, pin1, axis);
  const band = endsAlong(frame, 0.18, 'diode-band', axis)[bandIndex];
  const out: PartDetailShape[] = [rectAt(frame, 0, 1, 0, 1, body), band];
  if (led) {
    const [cx, cy] = frame.pt(0.5, 0.5);
    out.push({ shape: 'circle', tone: 'led-dome', cx, cy, r: (Math.min(frame.wu, frame.wv) / 2) * 0.55 });
  }
  return out;
}

/** Gull-wing leads with no pads to land on: `pins` split between the two long-axis edges (the old rule). */
function icShapesByOutline(frame: Frame, pins: number | undefined): PartDetailShape[] {
  const out: PartDetailShape[] = [rectAt(frame, 0, 1, 0, 1, 'ic-body')];
  const n = pins ?? 0;
  if (n < 2) return out;
  const perSide: [number, number] = [Math.ceil(n / 2), Math.floor(n / 2)];
  const leadFrac = Math.min(0.12, 1 / (Math.max(...perSide) * 2.2));
  const groups: [number, number][][] = [];
  ([0, 1] as const).forEach((side) => {
    const count = perSide[side];
    for (let i = 0; i < count; i++) {
      const centre = (i + 0.5) / count;
      const lo = centre - leadFrac / 2;
      const hi = centre + leadFrac / 2;
      const rect =
        frame.long === 'u'
          ? side === 0
            ? [frame.pt(lo, -0.32), frame.pt(hi, -0.32), frame.pt(hi, 0.04), frame.pt(lo, 0.04)]
            : [frame.pt(lo, 0.96), frame.pt(hi, 0.96), frame.pt(hi, 1.32), frame.pt(lo, 1.32)]
          : side === 0
            ? [frame.pt(-0.32, lo), frame.pt(-0.32, hi), frame.pt(0.04, hi), frame.pt(0.04, lo)]
            : [frame.pt(0.96, lo), frame.pt(0.96, hi), frame.pt(1.32, hi), frame.pt(1.32, lo)];
      groups.push(rect as [number, number][]);
    }
  });
  out.push({ shape: 'multi', tone: 'ic-lead', groups });
  return out;
}

/**
 * Gull-wing leads landed on the footprint's own pads (owner answers batch 10,
 *): one lead per pad, centred on it, running out from the
 * body's edge across the pin axis; the body spans the outline along the pin
 * axis and sits between the pad rows across it. Orientation and position are
 * the KiCad placement's, whatever the outline's aspect.
 */
function icShapes(frame: Frame, pins: number | undefined, pads: readonly FramePad[]): PartDetailShape[] {
  if (pads.length < 2) return icShapesByOutline(frame, pins);
  const axis = pinAxis(frame, pads);
  const along = (p: FramePad): number => (axis === 'u' ? p.u : p.v);
  const across = (p: FramePad): number => (axis === 'u' ? p.v : p.u);
  const wAlong = axis === 'u' ? frame.wu : frame.wv;
  const wAcross = axis === 'u' ? frame.wv : frame.wu;
  const acrossVals = pads.map(across);
  let lo = Math.min(...acrossVals);
  let hi = Math.max(...acrossVals);
  if (hi - lo < 1e-6) {
    // a single row: the body reaches across the outline beside it
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 1);
  }
  const inset = (hi - lo) * 0.1;
  const bodyLo = lo + inset;
  const bodyHi = hi - inset;
  const positions = [...new Set(pads.map((p) => Math.round(along(p) * wAlong * 100)))].sort((a, b) => a - b);
  const gaps = positions
    .slice(1)
    .map((x, i) => (x - positions[i]!) / 100)
    .filter((g) => g > 0.05);
  const pitchMm = gaps.length === 0 ? wAlong / 4 : Math.min(...gaps);
  const half = Math.min(0.3 * pitchMm, 0.35) / (wAlong || 1); // half a lead's width, as a fraction along
  const out: PartDetailShape[] = [
    axis === 'u' ? rectAt(frame, 0, 1, bodyLo, bodyHi, 'ic-body') : rectAt(frame, bodyLo, bodyHi, 0, 1, 'ic-body'),
  ];
  const groups: [number, number][][] = [];
  const mid = (bodyLo + bodyHi) / 2;
  const minLen = 0.3 / (wAcross || 1);
  for (const p of pads) {
    const a = along(p);
    const c = across(p);
    // from the body's edge on the pad's side out past the pad centre by as much: centred on the pad
    const inner = c <= mid ? bodyLo : bodyHi;
    const outer = 2 * c - inner;
    const [c0, c1] = inner < outer ? [inner, outer] : [outer, inner];
    const [q0, q1] = c1 - c0 < minLen ? [c - minLen / 2, c + minLen / 2] : [c0, c1];
    groups.push(
      axis === 'u'
        ? [frame.pt(a - half, q0), frame.pt(a + half, q0), frame.pt(a + half, q1), frame.pt(a - half, q1)]
        : [frame.pt(q0, a - half), frame.pt(q0, a + half), frame.pt(q1, a + half), frame.pt(q1, a - half)],
    );
  }
  out.push({ shape: 'multi', tone: 'ic-lead', groups });
  return out;
}

function jumperShapes(state: BoardPart['state'], frame: Frame, axis: 'u' | 'v'): PartDetailShape[] {
  if (state === 'bridged') return [rectAt(frame, 0.08, 0.92, 0.08, 0.92, 'jumper-blob')];
  if (state === 'open') return [...endsAlong(frame, 0.36, 'jumper-pad', axis)];
  return []; // unset: the caller's dotted-box fallback
}

/**
 * The shapes a top-down drawing of `part` renders, in `part.outline`'s own
 * coordinates. Empty for anything the importer did not classify (`package`
 * absent) or an unset solder jumper — the caller's plain box is the fallback.
 */
export function partBodyShapes(part: BoardPart): PartDetailShape[] {
  const frame = frameOf(part.outline);
  if (frame === undefined) return [];
  const pads = framePads(frame, part);
  // the pin axis comes from the footprint's pads (the KiCad placement), not the body's aspect
  const axis = pinAxis(frame, pads);
  if (part.kind === 'jumper') return jumperShapes(part.state, frame, axis);
  const pkg = part.package;
  if (pkg === undefined) return [];
  switch (pkg.family) {
    case 'chip-r':
      return chipShapes(frame, axis, 'chip-body', 'chip-end', resistorMarking(part.value));
    case 'chip-c':
      return chipShapes(frame, axis, 'mlcc-body', 'mlcc-end', undefined);
    case 'tantalum':
      return tantalumShapes(frame, axis, part.pin1);
    case 'electrolytic':
      return electrolyticShapes(frame, axis, part.pin1);
    case 'soic':
    case 'sot':
      return icShapes(frame, pkg.pins, pads);
    case 'diode':
      return diodeShapes(frame, axis, part.pin1, false);
    case 'led':
      return diodeShapes(frame, axis, part.pin1, true);
  }
}

/* ------------------------------------------------------------------ *
 * Where the drawing puts the part's pins, and whether that is on its pads
 * (owner answers batch 10: "the sync stripper [is] in the
 * wrong orientation in relation to the pads to land the footprint on").
 * ------------------------------------------------------------------ */

/** A point the drawing puts a pin (or a polarity mark) at, read back off `partBodyShapes`. */
export interface DrawnPinPoint {
  /** `lead`: an IC's gull-wing lead; `end`: a chip's end cap or an open jumper's pad; `polarity`: a band / stripe */
  kind: 'lead' | 'end' | 'polarity';
  x: number;
  y: number;
}

function centroid(points: readonly [number, number][]): [number, number] {
  const n = points.length || 1;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}

/** The pin points `partBodyShapes(part)` draws — read back off the shapes themselves, not re-computed. */
export function drawnPinPoints(part: BoardPart): DrawnPinPoint[] {
  const out: DrawnPinPoint[] = [];
  for (const s of partBodyShapes(part)) {
    if (s.shape === 'multi' && s.tone === 'ic-lead') {
      for (const g of s.groups) {
        const [x, y] = centroid(g);
        out.push({ kind: 'lead', x, y });
      }
    } else if (s.shape === 'polygon' && (s.tone === 'chip-end' || s.tone === 'mlcc-end' || s.tone === 'jumper-pad')) {
      const [x, y] = centroid(s.points);
      out.push({ kind: 'end', x, y });
    } else if (s.shape === 'polygon' && (s.tone === 'tant-band' || s.tone === 'diode-band' || s.tone === 'elec-stripe')) {
      const [x, y] = centroid(s.points);
      out.push({ kind: 'polarity', x, y });
    }
  }
  return out;
}

/** One way a drawn part disagrees with its footprint pads. */
export interface PartPadMismatch {
  ref: string;
  problem: string;
}

/**
 * Does the drawing land `part`'s pins on its footprint pads (`BoardPart.pads`,
 * from the KiCad placement)? Every IC lead within `tolerance` mm of a pad of
 * its own, one lead per pad (orientation and position both follow); a chip's
 * end caps / an open jumper's pads each on a distinct pad; a polarity mark
 * nearer the pad it marks (pin 1 — a diode's cathode band, a tantalum's
 * positive end — or, for an electrolytic's stripe, the negative pad) than the
 * other. A part with no pads or no drawn pins has nothing to check. Pure.
 */
export function partPadMismatches(part: BoardPart, tolerance = 0.5): PartPadMismatch[] {
  const pads = part.pads ?? [];
  if (pads.length === 0) return [];
  const drawn = drawnPinPoints(part);
  const out: PartPadMismatch[] = [];
  const bad = (problem: string): void => {
    out.push({ ref: part.ref, problem });
  };
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }): number => Math.hypot(p.x - q.x, p.y - q.y);
  const onPads = (points: readonly DrawnPinPoint[], what: string): void => {
    if (points.length !== pads.length) bad(`${points.length} ${what}(s) drawn for ${pads.length} pad(s)`);
    const free = new Set(pads.map((_, i) => i));
    for (const p of points) {
      let best = -1;
      let bestD = Infinity;
      for (const i of free) {
        const d = dist(p, pads[i]!);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0 || bestD > tolerance) {
        const near = pads.reduce((m, q) => Math.min(m, dist(p, q)), Infinity);
        bad(`a ${what} drawn at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) is ${near.toFixed(2)} mm from the nearest free pad`);
      } else free.delete(best);
    }
  };
  const leads = drawn.filter((p) => p.kind === 'lead');
  if (leads.length > 0) onPads(leads, 'lead');
  const ends = drawn.filter((p) => p.kind === 'end');
  if (ends.length > 0 && pads.length === 2) onPads(ends, 'end');
  const polarity = drawn.filter((p) => p.kind === 'polarity');
  if (polarity.length > 0 && pads.length === 2) {
    const one = pads.find((p) => p.pad === '1');
    const other = pads.find((p) => p.pad !== '1');
    const marks = part.package?.family === 'electrolytic' ? other : one;
    const not = marks === one ? other : one;
    if (marks !== undefined && not !== undefined) {
      for (const p of polarity) if (dist(p, marks) >= dist(p, not)) bad(`the polarity mark sits on pad ${not.pad}, not pad ${marks.pad}`);
    }
  }
  return out;
}
