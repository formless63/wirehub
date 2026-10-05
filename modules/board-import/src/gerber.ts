/**
 * Gerber (RS-274X, with X2 attributes) and Excellon drill files, plotted into
 * SVG fragments. Zero dependencies, deterministic, pure.
 *
 * What is read: the format and unit statements (`%FS…%`, `%MO…%`, G70/G71),
 * standard apertures (C, R, O, P) and aperture macros (primitives 1, 4, 5, 7,
 * 20, 21, 22, with `$n` variables and arithmetic), linear and circular
 * interpolation (G01/G02/G03, G74/G75), flashes, regions (G36/G37), polarity
 * (`%LPD%`/`%LPC%`), file attributes (`%TF…%`), step-and-repeat (`%SR`, a
 * panel's copies of the block) and the aperture mirroring, rotation and
 * scaling statements (`%LM`, `%LR`, `%LS`, which move a flash, not a stroke or
 * a region). Macro bodies are in the file's units, like the rest of an inch
 * file; Excellon routed slots (G85, and G00/M15/G01/M16 routs) are slots.
 *
 * Output coordinates are millimetres with **y pointing down** (Gerber's y is
 * negated), the frame the KiCad board file uses — so the board art and the
 * `.kicad_pcb`'s pads share one frame up to the outline's corner.
 */

import { n } from './art.ts';
import type { Point } from './kicad.ts';

/** One drawn element, already SVG: dark (adds) or clear (erases) in its layer. */
export interface PlotElement {
  dark: boolean;
  /** an SVG element with no paint of its own: `fill`/`stroke` are set by the caller (`{{paint}}` placeholder) */
  svg: string;
}

/** A flashed pad's extent, for checking an anchor sits on copper. */
export interface Flash {
  x: number;
  y: number;
  /** half extents of the aperture's bounding box */
  hw: number;
  hh: number;
}

export interface LayerPlot {
  elements: PlotElement[];
  flashes: Flash[];
  /** every stroke as a polyline (arcs sampled): what an outline layer's loops are chained from */
  strokes: Point[][];
  bounds?: { x0: number; y0: number; x1: number; y1: number };
  /** `%TF.FileFunction` and friends, as written */
  attributes: Record<string, string>;
  warnings: string[];
}

export const PAINT = '{{paint}}';

interface Aperture {
  kind: 'C' | 'R' | 'O' | 'P' | 'macro';
  params: number[];
  macro?: string;
  /** a macro's length unit: mm per file unit where it was defined (its body is in file units) */
  unit?: number;
}

type Expr = (vars: Map<number, number>) => number;

interface MacroPrimitive {
  code: number;
  args: Expr[];
}

interface MacroStatement {
  assign?: { variable: number; value: Expr };
  primitive?: MacroPrimitive;
}

/* ------------------------------------------------------------------ *
 * Macro arithmetic: + - x / ( ) $n
 * ------------------------------------------------------------------ */

export function parseExpr(text: string): Expr {
  const tokens = text.replace(/\s+/g, '').match(/\$\d+|\d*\.?\d+(?:[eE][-+]?\d+)?|[-+xX/()]/g) ?? [];
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const primary = (): Expr => {
    const t = tokens[i++];
    if (t === undefined) return () => 0;
    if (t === '(') {
      const inner = sum();
      i += 1; // ')'
      return inner;
    }
    if (t === '-') {
      const v = primary();
      return (vars) => -v(vars);
    }
    if (t === '+') return primary();
    if (t.startsWith('$')) {
      const index = Number(t.slice(1));
      return (vars) => vars.get(index) ?? 0;
    }
    const value = Number(t);
    return () => value;
  };
  const product = (): Expr => {
    let left = primary();
    while (peek() === 'x' || peek() === 'X' || peek() === '/') {
      const op = tokens[i++];
      const right = primary();
      const l = left;
      left = op === '/' ? (vars) => l(vars) / right(vars) : (vars) => l(vars) * right(vars);
    }
    return left;
  };
  const sum = (): Expr => {
    let left = product();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++];
      const right = product();
      const l = left;
      left = op === '-' ? (vars) => l(vars) - right(vars) : (vars) => l(vars) + right(vars);
    }
    return left;
  };
  return sum();
}

function parseMacro(blocks: readonly string[]): MacroStatement[] {
  const out: MacroStatement[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (block === '' || block.startsWith('0 ') || block === '0') continue;
    const assign = /^\$(\d+)=(.+)$/.exec(block);
    if (assign !== null) {
      out.push({ assign: { variable: Number(assign[1]), value: parseExpr(assign[2]!) } });
      continue;
    }
    const parts = block.split(',');
    out.push({ primitive: { code: Number(parts[0]), args: parts.slice(1).map(parseExpr) } });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Geometry helpers (gerber frame: y up; output frame: y down)
 * ------------------------------------------------------------------ */

function rot(p: Point, deg: number): Point {
  if (deg === 0) return p;
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** gerber (y up) → output (y down) */
function out(p: Point): Point {
  return { x: p.x, y: -p.y };
}

function polygonPath(points: readonly Point[]): string {
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(out(p).x)} ${n(out(p).y)}`).join('')}Z`;
}

function circlePath(c: Point, r: number): string {
  const o = out(c);
  return `M${n(o.x - r)} ${n(o.y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
}

function regularPolygon(c: Point, diameter: number, vertices: number, rotation: number): Point[] {
  const pts: Point[] = [];
  const count = Math.max(3, Math.round(vertices));
  for (let k = 0; k < count; k++) {
    const t = ((rotation + (360 * k) / count) * Math.PI) / 180;
    pts.push({ x: c.x + (diameter / 2) * Math.cos(t), y: c.y + (diameter / 2) * Math.sin(t) });
  }
  return pts;
}

function obroundPath(c: Point, w: number, h: number): string {
  if (Math.abs(w - h) < 1e-9) return circlePath(c, w / 2);
  const r = Math.min(w, h) / 2;
  const o = out(c);
  if (w > h) {
    const dx = w / 2 - r;
    return `M${n(o.x - dx)} ${n(o.y - r)}H${n(o.x + dx)}a${n(r)} ${n(r)} 0 0 1 0 ${n(2 * r)}H${n(o.x - dx)}a${n(r)} ${n(r)} 0 0 1 0 ${n(-2 * r)}Z`;
  }
  const dy = h / 2 - r;
  return `M${n(o.x + r)} ${n(o.y - dy)}V${n(o.y + dy)}a${n(r)} ${n(r)} 0 0 1 ${n(-2 * r)} 0V${n(o.y - dy)}a${n(r)} ${n(r)} 0 0 1 ${n(2 * r)} 0Z`;
}

/** Convex hull (monotone chain), for a rectangle swept along a line. */
function hull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/* ------------------------------------------------------------------ *
 * The plotter
 * ------------------------------------------------------------------ */

interface ArcSegment {
  start: Point;
  end: Point;
  center: Point;
  clockwise: boolean;
}

function arcSweep(a: ArcSegment): number {
  const ts = Math.atan2(a.start.y - a.center.y, a.start.x - a.center.x);
  const te = Math.atan2(a.end.y - a.center.y, a.end.x - a.center.x);
  let sweep = a.clockwise ? ts - te : te - ts;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  return sweep;
}

/** The SVG path commands (after a moveto to `start`) that draw the arc. */
function arcCommands(a: ArcSegment): string {
  const r = Math.hypot(a.start.x - a.center.x, a.start.y - a.center.y);
  const sweep = arcSweep(a);
  // in y-down, a clockwise (y-up) arc is drawn counter-clockwise: sweep-flag 0
  const flag = a.clockwise ? 0 : 1;
  const e = out(a.end);
  if (sweep >= 2 * Math.PI - 1e-6) {
    const opposite = out({ x: 2 * a.center.x - a.start.x, y: 2 * a.center.y - a.start.y });
    return `A${n(r)} ${n(r)} 0 0 ${flag} ${n(opposite.x)} ${n(opposite.y)}A${n(r)} ${n(r)} 0 0 ${flag} ${n(e.x)} ${n(e.y)}`;
  }
  return `A${n(r)} ${n(r)} 0 ${sweep > Math.PI ? 1 : 0} ${flag} ${n(e.x)} ${n(e.y)}`;
}

function arcPoints(a: ArcSegment): Point[] {
  const r = Math.hypot(a.start.x - a.center.x, a.start.y - a.center.y);
  const sweep = arcSweep(a);
  const t0 = Math.atan2(a.start.y - a.center.y, a.start.x - a.center.x);
  const steps = Math.max(4, Math.ceil(sweep / (Math.PI / 24)));
  const pts: Point[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = t0 + (a.clockwise ? -1 : 1) * (sweep * k) / steps;
    pts.push(k === 0 ? a.start : k === steps ? a.end : { x: a.center.x + r * Math.cos(t), y: a.center.y + r * Math.sin(t) });
  }
  return pts;
}

export function plotGerber(text: string): LayerPlot {
  const plot: LayerPlot = { elements: [], flashes: [], strokes: [], attributes: {}, warnings: [] };
  const apertures = new Map<number, Aperture>();
  const macros = new Map<string, MacroStatement[]>();
  let scale = 1; // mm per unit
  let intDigits = 2;
  let decDigits = 6;
  let trailing = false;
  let incremental = false;
  let current: Aperture | undefined;
  let interp: 'G01' | 'G02' | 'G03' = 'G01';
  let multiQuadrant = true;
  let dark = true;
  let region = false;
  let contour: string[] = [];
  let contourStart: Point | undefined;
  let lastOp = 'D02';
  let pos: Point = { x: 0, y: 0 };
  // aperture transformation (`%LM%`, `%LR%`, `%LS%`) and the open step-and-repeat block (`%SR%`)
  const tf = { mx: 1, my: 1, rot: 0, ls: 1 };
  interface StepRepeat {
    nx: number;
    ny: number;
    /** step distances, mm */
    dx: number;
    dy: number;
    el: number;
    fl: number;
    st: number;
    bounds?: { x0: number; y0: number; x1: number; y1: number };
  }
  let sr: StepRepeat | undefined;
  const warned = new Set<string>();
  const warn = (w: string): void => {
    if (!warned.has(w)) {
      warned.add(w);
      plot.warnings.push(w);
    }
  };
  const grow = (x: number, y: number, r = 0): void => {
    const b = plot.bounds;
    const yy = -y;
    if (b === undefined) plot.bounds = { x0: x - r, y0: yy - r, x1: x + r, y1: yy + r };
    else {
      b.x0 = Math.min(b.x0, x - r);
      b.y0 = Math.min(b.y0, yy - r);
      b.x1 = Math.max(b.x1, x + r);
      b.y1 = Math.max(b.y1, yy + r);
    }
    if (sr !== undefined) {
      const q = sr.bounds;
      if (q === undefined) sr.bounds = { x0: x - r, y0: yy - r, x1: x + r, y1: yy + r };
      else {
        q.x0 = Math.min(q.x0, x - r);
        q.y0 = Math.min(q.y0, yy - r);
        q.x1 = Math.max(q.x1, x + r);
        q.y1 = Math.max(q.y1, yy + r);
      }
    }
  };
  /** end the step-and-repeat block: the copies of what it drew, one per step */
  const closeStepRepeat = (): void => {
    const block = sr;
    sr = undefined;
    if (block === undefined) return;
    const elements = plot.elements.slice(block.el);
    const flashes = plot.flashes.slice(block.fl);
    const strokes = plot.strokes.slice(block.st);
    for (let ix = 0; ix < block.nx; ix++) {
      for (let iy = 0; iy < block.ny; iy++) {
        if (ix === 0 && iy === 0) continue;
        const ox = ix * block.dx;
        // gerber y is up, the output's is down
        const oy = -iy * block.dy;
        for (const e of elements) plot.elements.push({ dark: e.dark, svg: `<g transform="translate(${n(ox)} ${n(oy)})">${e.svg}</g>` });
        for (const f of flashes) plot.flashes.push({ ...f, x: f.x + ox, y: f.y + oy });
        for (const line of strokes) plot.strokes.push(line.map((q) => ({ x: q.x + ox, y: q.y + oy })));
        const q = block.bounds;
        if (q !== undefined && plot.bounds !== undefined) {
          plot.bounds.x0 = Math.min(plot.bounds.x0, q.x0 + ox);
          plot.bounds.x1 = Math.max(plot.bounds.x1, q.x1 + ox);
          plot.bounds.y0 = Math.min(plot.bounds.y0, q.y0 + oy);
          plot.bounds.y1 = Math.max(plot.bounds.y1, q.y1 + oy);
        }
      }
    }
  };
  const coord = (raw: string): number => {
    if (raw.includes('.')) return Number(raw) * scale;
    const negative = raw.startsWith('-');
    let digits = raw.replace(/^[+-]/, '');
    if (trailing) digits = digits.padEnd(intDigits + decDigits, '0');
    const value = Number(digits) / 10 ** decDigits;
    return (negative ? -value : value) * scale;
  };
  const emit = (svg: string): void => {
    plot.elements.push({ dark, svg });
  };
  const flashPlain = (ap: Aperture, at: Point, polarity: boolean): void => {
    const add = (svg: string, d = polarity): void => {
      plot.elements.push({ dark: d, svg });
    };
    const [a = 0, b = 0, c = 0] = ap.params;
    switch (ap.kind) {
      case 'C':
        add(`<path d="${circlePath(at, a / 2)}" fill="${PAINT}"/>`);
        plot.flashes.push({ x: at.x, y: -at.y, hw: a / 2, hh: a / 2 });
        grow(at.x, at.y, a / 2);
        break;
      case 'R': {
        add(`<path d="${polygonPath([
          { x: at.x - a / 2, y: at.y - b / 2 },
          { x: at.x + a / 2, y: at.y - b / 2 },
          { x: at.x + a / 2, y: at.y + b / 2 },
          { x: at.x - a / 2, y: at.y + b / 2 },
        ])}" fill="${PAINT}"/>`);
        plot.flashes.push({ x: at.x, y: -at.y, hw: a / 2, hh: b / 2 });
        grow(at.x, at.y, Math.max(a, b) / 2);
        break;
      }
      case 'O':
        add(`<path d="${obroundPath(at, a, b)}" fill="${PAINT}"/>`);
        plot.flashes.push({ x: at.x, y: -at.y, hw: a / 2, hh: b / 2 });
        grow(at.x, at.y, Math.max(a, b) / 2);
        break;
      case 'P':
        add(`<path d="${polygonPath(regularPolygon(at, a, b, c))}" fill="${PAINT}"/>`);
        plot.flashes.push({ x: at.x, y: -at.y, hw: a / 2, hh: a / 2 });
        grow(at.x, at.y, a / 2);
        break;
      case 'macro':
        flashMacro(ap, at, polarity);
        break;
    }
  };
  /** a flash with the aperture transformation (mirror, then rotate, then scale, about the flash) applied */
  const flashAperture = (ap: Aperture, at: Point, polarity: boolean): void => {
    const e0 = plot.elements.length;
    const f0 = plot.flashes.length;
    flashPlain(ap, at, polarity);
    if (tf.mx === 1 && tf.my === 1 && tf.rot === 0 && tf.ls === 1) return;
    const o = out(at);
    const transform = `translate(${n(o.x)} ${n(o.y)}) scale(${n(tf.ls)}) rotate(${n(-tf.rot)}) scale(${tf.mx} ${tf.my}) translate(${n(-o.x)} ${n(-o.y)})`;
    for (let k = e0; k < plot.elements.length; k++) plot.elements[k] = { ...plot.elements[k]!, svg: `<g transform="${transform}">${plot.elements[k]!.svg}</g>` };
    const quarter = Math.abs(tf.rot % 90) < 1e-9;
    const swap = quarter && Math.abs(Math.round(tf.rot / 90)) % 2 === 1;
    for (let k = f0; k < plot.flashes.length; k++) {
      const f = plot.flashes[k]!;
      const [hw, hh] = quarter ? (swap ? [f.hh, f.hw] : [f.hw, f.hh]) : [Math.hypot(f.hw, f.hh), Math.hypot(f.hw, f.hh)];
      plot.flashes[k] = { ...f, hw: hw * tf.ls, hh: hh * tf.ls };
      grow(f.x, -f.y, Math.max(hw, hh) * tf.ls);
    }
  };
  const flashMacro = (ap: Aperture, at: Point, polarity: boolean): void => {
    const body = macros.get(ap.macro ?? '');
    if (body === undefined) {
      warn(`aperture macro ${ap.macro} is not defined`);
      return;
    }
    const vars = new Map<number, number>(ap.params.map((v, i) => [i + 1, v]));
    let extent = 0;
    for (const statement of body) {
      if (statement.assign !== undefined) {
        vars.set(statement.assign.variable, statement.assign.value(vars));
        continue;
      }
      const p = statement.primitive!;
      const v = p.args.map((e) => e(vars));
      // lengths are in the file's units: millimetres from here on (rotations, vertex counts and exposure are not lengths)
      const unit = ap.unit ?? 1;
      if (unit !== 1) {
        const lengths: number[] =
          p.code === 1 ? [1, 2, 3] : p.code === 2 || p.code === 20 ? [1, 2, 3, 4, 5] : p.code === 21 || p.code === 22 ? [1, 2, 3, 4] : p.code === 5 ? [2, 3, 4] : p.code === 7 ? [0, 1, 2, 3, 4] : [];
        if (p.code === 4) for (let k = 2; k < 2 + 2 * (Math.round(v[1] ?? 0) + 1); k++) lengths.push(k);
        for (const k of lengths) if (v[k] !== undefined) v[k] = v[k]! * unit;
      }
      // the thermal (7) has no exposure argument: it is always dark
      const exposure = p.code === 7 || (v[0] ?? 1) !== 0;
      const add = (svg: string): void => {
        plot.elements.push({ dark: exposure ? polarity : !polarity, svg });
      };
      const place = (q: Point, rotation: number): Point => {
        const r = rot(q, rotation);
        return { x: at.x + r.x, y: at.y + r.y };
      };
      switch (p.code) {
        case 1: {
          const [, d = 0, cx = 0, cy = 0, rotation = 0] = v;
          add(`<path d="${circlePath(place({ x: cx, y: cy }, rotation), d / 2)}" fill="${PAINT}"/>`);
          extent = Math.max(extent, Math.hypot(cx, cy) + d / 2);
          break;
        }
        case 2:
        case 20: {
          const [, w = 0, sx = 0, sy = 0, ex = 0, ey = 0, rotation = 0] = v;
          const len = Math.hypot(ex - sx, ey - sy) || 1;
          const nx = (-(ey - sy) / len) * (w / 2);
          const ny = ((ex - sx) / len) * (w / 2);
          const pts = [
            { x: sx + nx, y: sy + ny },
            { x: ex + nx, y: ey + ny },
            { x: ex - nx, y: ey - ny },
            { x: sx - nx, y: sy - ny },
          ].map((q) => place(q, rotation));
          add(`<path d="${polygonPath(pts)}" fill="${PAINT}"/>`);
          extent = Math.max(extent, Math.hypot(sx, sy) + w, Math.hypot(ex, ey) + w);
          break;
        }
        case 21:
        case 22: {
          const [, w = 0, h = 0, cx = 0, cy = 0, rotation = 0] = v;
          const x0 = p.code === 21 ? cx - w / 2 : cx;
          const y0 = p.code === 21 ? cy - h / 2 : cy;
          const pts = [
            { x: x0, y: y0 },
            { x: x0 + w, y: y0 },
            { x: x0 + w, y: y0 + h },
            { x: x0, y: y0 + h },
          ].map((q) => place(q, rotation));
          add(`<path d="${polygonPath(pts)}" fill="${PAINT}"/>`);
          extent = Math.max(extent, Math.hypot(Math.abs(cx) + w, Math.abs(cy) + h));
          break;
        }
        case 4: {
          const count = Math.round(v[1] ?? 0);
          const pts: Point[] = [];
          for (let k = 0; k <= count; k++) pts.push({ x: v[2 + 2 * k] ?? 0, y: v[3 + 2 * k] ?? 0 });
          const rotation = v[2 + 2 * (count + 1)] ?? 0;
          add(`<path d="${polygonPath(pts.slice(0, -1).map((q) => place(q, rotation)))}" fill="${PAINT}"/>`);
          for (const q of pts) extent = Math.max(extent, Math.hypot(q.x, q.y));
          break;
        }
        case 5: {
          const [, vertices = 3, cx = 0, cy = 0, d = 0, rotation = 0] = v;
          const pts = regularPolygon({ x: cx, y: cy }, d, vertices, 0).map((q) => place(q, rotation));
          add(`<path d="${polygonPath(pts)}" fill="${PAINT}"/>`);
          extent = Math.max(extent, Math.hypot(cx, cy) + d / 2);
          break;
        }
        case 7: {
          // thermal: drawn as its ring (the gaps are left out)
          const [cx = 0, cy = 0, outer = 0, inner = 0, , rotation = 0] = v;
          const c = place({ x: cx, y: cy }, rotation);
          plot.elements.push({ dark: polarity, svg: `<path d="${circlePath(c, outer / 2)}${circlePath(c, inner / 2)}" fill="${PAINT}" fill-rule="evenodd"/>` });
          extent = Math.max(extent, Math.hypot(cx, cy) + outer / 2);
          break;
        }
        default:
          warn(`aperture macro primitive ${p.code} is not drawn`);
      }
    }
    plot.flashes.push({ x: at.x, y: -at.y, hw: extent, hh: extent });
    grow(at.x, at.y, extent);
  };
  const strokeWidth = (ap: Aperture | undefined): number => {
    if (ap === undefined) return 0;
    if (ap.kind === 'C') return ap.params[0] ?? 0;
    if (ap.kind === 'R' || ap.kind === 'O') return Math.min(ap.params[0] ?? 0, ap.params[1] ?? 0);
    if (ap.kind === 'P') return ap.params[0] ?? 0;
    return 0;
  };
  const drawLinear = (from: Point, to: Point): void => {
    plot.strokes.push([out(from), out(to)]);
    const ap = current;
    if (ap?.kind === 'R') {
      const [w = 0, h = 0] = ap.params;
      const corners = (c: Point): Point[] => [
        { x: c.x - w / 2, y: c.y - h / 2 },
        { x: c.x + w / 2, y: c.y - h / 2 },
        { x: c.x + w / 2, y: c.y + h / 2 },
        { x: c.x - w / 2, y: c.y + h / 2 },
      ];
      emit(`<path d="${polygonPath(hull([...corners(from), ...corners(to)]))}" fill="${PAINT}"/>`);
      grow(from.x, from.y, Math.max(w, h));
      grow(to.x, to.y, Math.max(w, h));
      return;
    }
    if (ap !== undefined && ap.kind !== 'C') warn(`strokes with ${ap.kind === 'macro' ? 'macro' : ap.kind} apertures are drawn round`);
    const w = strokeWidth(ap);
    const a = out(from);
    const b = out(to);
    emit(`<path d="M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}" fill="none" stroke="${PAINT}" stroke-width="${n(w)}" stroke-linecap="round"/>`);
    grow(from.x, from.y, w / 2);
    grow(to.x, to.y, w / 2);
  };
  const drawArc = (arc: ArcSegment): void => {
    plot.strokes.push(arcPoints(arc).map(out));
    const w = strokeWidth(current);
    const a = out(arc.start);
    emit(`<path d="M${n(a.x)} ${n(a.y)}${arcCommands(arc)}" fill="none" stroke="${PAINT}" stroke-width="${n(w)}" stroke-linecap="round"/>`);
    const r = Math.hypot(arc.start.x - arc.center.x, arc.start.y - arc.center.y);
    grow(arc.center.x, arc.center.y, r + w / 2);
  };
  const arcCenter = (from: Point, to: Point, i: number, j: number, clockwise: boolean): Point => {
    if (multiQuadrant) return { x: from.x + i, y: from.y + j };
    // single quadrant: the signs are not given; pick the centre whose sweep is at most 90° and radii agree
    let best: Point = { x: from.x + i, y: from.y + j };
    let score = Infinity;
    for (const [si, sj] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const c = { x: from.x + si * Math.abs(i), y: from.y + sj * Math.abs(j) };
      const sweep = arcSweep({ start: from, end: to, center: c, clockwise });
      if (sweep > Math.PI / 2 + 1e-6) continue;
      const diff = Math.abs(Math.hypot(from.x - c.x, from.y - c.y) - Math.hypot(to.x - c.x, to.y - c.y));
      if (diff < score) {
        score = diff;
        best = c;
      }
    }
    return best;
  };
  const closeContour = (): void => {
    if (contour.length > 0) emit(`<path d="${contour.join('')}Z" fill="${PAINT}"/>`);
    contour = [];
    contourStart = undefined;
  };

  // statements: %…% extended blocks, and *-terminated words
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i]!;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i += 1;
      continue;
    }
    if (c === '%') {
      const end = text.indexOf('%', i + 1);
      if (end < 0) break;
      const blocks = text
        .slice(i + 1, end)
        .split('*')
        .map((b) => b.replace(/[\r\n]/g, ''))
        .filter((b) => b.trim() !== '');
      i = end + 1;
      const first = blocks[0] ?? '';
      if (first.startsWith('FS')) {
        const m = /FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/.exec(first);
        if (m !== null) {
          trailing = m[1] === 'T';
          incremental = m[2] === 'I';
          intDigits = Number(m[3]);
          decDigits = Number(m[4]);
        }
        if (incremental) warn('incremental coordinates are read as absolute');
      } else if (first.startsWith('MO')) {
        scale = first.startsWith('MOIN') ? 25.4 : 1;
      } else if (first.startsWith('AD')) {
        const m = /^ADD(\d+)([A-Za-z_.$][\w.$-]*)(?:,(.*))?$/.exec(first);
        if (m !== null) {
          const params = (m[3] ?? '').split('X').filter((p) => p !== '').map((p) => Number(p) * 1);
          const name = m[2]!;
          const standard = name === 'C' || name === 'R' || name === 'O' || name === 'P';
          // apertures' sizes are in file units; polygon vertex counts and rotations are not
          const scaled = standard ? params.map((p, k) => (name === 'P' && k > 0 ? p : p * scale)) : params.map((p) => p);
          apertures.set(Number(m[1]), standard ? { kind: name as Aperture['kind'], params: scaled } : { kind: 'macro', params: params.map((p) => p), macro: name, unit: scale });
        }
      } else if (first.startsWith('AM')) {
        macros.set(first.slice(2), parseMacro(blocks.slice(1)));
      } else if (first.startsWith('LP')) {
        dark = first !== 'LPC';
      } else if (first.startsWith('TF')) {
        const [key, ...rest] = first.slice(2).split(',');
        if (key !== undefined) plot.attributes[key] = rest.join(',');
      } else if (first.startsWith('SR')) {
        closeStepRepeat();
        const m = /^SR(?:X(\d+))?(?:Y(\d+))?(?:I([-+]?[\d.]+))?(?:J([-+]?[\d.]+))?$/.exec(first);
        if (m === null) warn(`%${first}% is not understood`);
        else {
          const nx = Number(m[1] ?? 1);
          const ny = Number(m[2] ?? 1);
          if (nx * ny > 100_000) warn(`step-and-repeat of ${nx} x ${ny} is too large and is not applied`);
          else if (nx * ny > 1) sr = { nx, ny, dx: Number(m[3] ?? 0) * scale, dy: Number(m[4] ?? 0) * scale, el: plot.elements.length, fl: plot.flashes.length, st: plot.strokes.length };
        }
      } else if (first.startsWith('LM')) {
        const m = /^LM(N|X|Y|XY)$/.exec(first);
        if (m === null) warn(`%${first}% is not understood`);
        else {
          tf.mx = m[1] === 'X' || m[1] === 'XY' ? -1 : 1;
          tf.my = m[1] === 'Y' || m[1] === 'XY' ? -1 : 1;
        }
      } else if (first.startsWith('LR')) {
        tf.rot = Number(first.slice(2)) || 0;
      } else if (first.startsWith('LS')) {
        const v = Number(first.slice(2));
        tf.ls = v > 0 ? v : 1;
      }
      continue;
    }
    const end = text.indexOf('*', i);
    if (end < 0) break;
    const word = text.slice(i, end).replace(/[\r\n\s]/g, '');
    i = end + 1;
    if (word === '' || word.startsWith('G04') || word.startsWith('G4 ')) continue;
    if (word === 'M02' || word === 'M00' || word === 'M2') break;
    for (const g of word.matchAll(/G0?(\d+)/g)) {
      const code = Number(g[1]);
      if (code === 1) interp = 'G01';
      else if (code === 2) interp = 'G02';
      else if (code === 3) interp = 'G03';
      else if (code === 36) {
        region = true;
        contour = [];
      } else if (code === 37) {
        closeContour();
        region = false;
      } else if (code === 74) multiQuadrant = false;
      else if (code === 75) multiQuadrant = true;
      else if (code === 70) scale = 25.4;
      else if (code === 71) scale = 1;
    }
    const x = /X([+-]?[\d.]+)/.exec(word);
    const y = /Y([+-]?[\d.]+)/.exec(word);
    const iOff = /I([+-]?[\d.]+)/.exec(word);
    const jOff = /J([+-]?[\d.]+)/.exec(word);
    const d = /D0*(\d+)$/.exec(word);
    const dCode = d === null ? undefined : Number(d[1]);
    if (dCode !== undefined && dCode >= 10) {
      current = apertures.get(dCode);
      if (current === undefined) warn(`aperture D${dCode} is used but not defined`);
      continue;
    }
    if (x === null && y === null && iOff === null && jOff === null && dCode === undefined) continue;
    const op = dCode === undefined ? lastOp : `D0${dCode}`;
    lastOp = op;
    const target: Point = { x: x === null ? pos.x : coord(x[1]!), y: y === null ? pos.y : coord(y[1]!) };
    if (op === 'D02') {
      if (region) {
        closeContour();
      }
      pos = target;
      continue;
    }
    if (op === 'D03') {
      if (current !== undefined) flashAperture(current, target, dark);
      pos = target;
      continue;
    }
    if (op !== 'D01') {
      pos = target;
      continue;
    }
    // D01: interpolate
    if (interp === 'G01') {
      if (region) {
        if (contourStart === undefined) {
          contourStart = pos;
          contour.push(`M${n(out(pos).x)} ${n(out(pos).y)}`);
        }
        contour.push(`L${n(out(target).x)} ${n(out(target).y)}`);
        grow(target.x, target.y);
        grow(pos.x, pos.y);
      } else drawLinear(pos, target);
    } else {
      const ci = iOff === null ? 0 : coord(iOff[1]!);
      const cj = jOff === null ? 0 : coord(jOff[1]!);
      const arc: ArcSegment = { start: pos, end: target, center: arcCenter(pos, target, ci, cj, interp === 'G02'), clockwise: interp === 'G02' };
      if (region) {
        if (contourStart === undefined) {
          contourStart = pos;
          contour.push(`M${n(out(pos).x)} ${n(out(pos).y)}`);
        }
        contour.push(arcCommands(arc));
        for (const p of arcPoints(arc)) grow(p.x, p.y);
      } else drawArc(arc);
    }
    pos = target;
  }
  if (region) closeContour();
  closeStepRepeat();
  return plot;
}

/* ------------------------------------------------------------------ *
 * Excellon drills
 * ------------------------------------------------------------------ */

export interface Drill {
  x: number;
  /** output frame: y down */
  y: number;
  diameter: number;
  plated?: boolean;
  /** a routed slot (G85, or a rout between M15 and M16): the other end, output frame; the slot is `diameter` wide */
  to?: { x: number; y: number };
}

export function isExcellon(text: string): boolean {
  return /^\s*(;.*\n\s*)*M48\b/m.test(text.slice(0, 4096)) || /^\s*M48\s*$/m.test(text.slice(0, 4096));
}

export function parseExcellon(text: string): { drills: Drill[]; warnings: string[]; plated?: boolean } {
  const warnings: string[] = [];
  const tools = new Map<number, number>();
  const drills: Drill[] = [];
  let scale = 1;
  let inch = false;
  let header = false;
  let tool: number | undefined;
  let plated: boolean | undefined;
  let last: Point = { x: 0, y: 0 };
  let leadingZeros = true;
  let toolDown = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith(';')) {
      if (/TYPE=NON_PLATED|NPTH/i.test(line)) plated = false;
      else if (/TYPE=PLATED|\bPTH\b/i.test(line)) plated = true;
      continue;
    }
    if (line === 'M48') {
      header = true;
      continue;
    }
    if (line === '%' || line === 'M95') {
      header = false;
      continue;
    }
    if (/^(METRIC|M71)/.test(line)) {
      inch = false;
      scale = 1;
      if (/TZ/.test(line)) leadingZeros = false;
      continue;
    }
    if (/^(INCH|M72)/.test(line)) {
      inch = true;
      scale = 25.4;
      if (/TZ/.test(line)) leadingZeros = false;
      continue;
    }
    const def = /^T0*(\d+)(?:F\d+)?(?:S\d+)?C([\d.]+)/.exec(line);
    if (def !== null) {
      tools.set(Number(def[1]), Number(def[2]) * scale);
      if (!header) tool = Number(def[1]);
      continue;
    }
    const select = /^T0*(\d+)$/.exec(line);
    if (select !== null) {
      tool = Number(select[1]);
      continue;
    }
    if (line === 'M15') {
      toolDown = true;
      continue;
    }
    if (line === 'M16' || line === 'M17') {
      toolDown = false;
      continue;
    }
    if (header) continue;
    const parsed = /^(?:G0*(\d+))?((?:X[+-]?[\d.]+)?(?:Y[+-]?[\d.]+)?)(?:(?:A|I|J)[+-]?[\d.]+)*(?:G85((?:X[+-]?[\d.]+)?(?:Y[+-]?[\d.]+)?))?$/.exec(line);
    if (parsed === null) continue;
    const [, gText, from, slotEnd] = parsed;
    const g = gText === undefined ? undefined : Number(gText);
    if (from === '' && slotEnd === undefined) continue;
    const value = (s: string | undefined, prev: number): number => {
      if (s === undefined) return prev;
      if (s.includes('.')) return Number(s) * scale;
      // no decimal point: metric 3.3, inch 2.4
      const decimals = inch ? 4 : 3;
      const digits = s.replace(/^[+-]/, '');
      const sign = s.startsWith('-') ? -1 : 1;
      const v = leadingZeros ? Number(digits) / 10 ** decimals : Number(digits.padEnd((inch ? 2 : 3) + decimals, '0')) / 10 ** decimals;
      return sign * v * scale;
    };
    const at = (text: string): Point => ({ x: value(/X([+-]?[\d.]+)/.exec(text)?.[1], last.x), y: value(/Y([+-]?[\d.]+)/.exec(text)?.[1], last.y) });
    const diameter = tool === undefined ? undefined : tools.get(tool);
    const slot = (a: Point, b: Point): void => {
      if (diameter === undefined) return;
      drills.push({ x: a.x, y: -a.y, diameter, to: { x: b.x, y: -b.y }, ...(plated === undefined ? {} : { plated }) });
    };
    if (slotEnd !== undefined) {
      // `X…Y…G85X…Y…`: a slot from the first position to the second
      const start = at(from!);
      last = at(slotEnd);
      slot(start, last);
      continue;
    }
    if (g === 85) {
      // `G85X…Y…` on its own line: from where the last position was
      const start = last;
      last = at(from!);
      slot(start, last);
      continue;
    }
    const target = at(from!);
    if (g === 0) {
      // a rapid move: the start of a rout, not a hole
      last = target;
      continue;
    }
    if (g === 1 || g === 2 || g === 3) {
      if ((g === 2 || g === 3) && !warnings.includes('routed arcs are drawn as straight slots')) warnings.push('routed arcs are drawn as straight slots');
      if (toolDown) slot(last, target);
      last = target;
      continue;
    }
    last = target;
    if (diameter === undefined) continue;
    drills.push({ x: last.x, y: -last.y, diameter, ...(plated === undefined ? {} : { plated }) });
  }
  return { drills, warnings, ...(plated === undefined ? {} : { plated }) };
}
