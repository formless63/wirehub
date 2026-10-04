/**
 * Minimal SVG string primitives.
 *
 * No DOM, no serializer library — the renderer builds text. Two rules keep the
 * output byte-stable: coordinates always go through `fmt` (fixed 0.01 mm
 * precision, no `-0`), and attributes are emitted in the order the caller
 * lists them.
 */

export type AttrValue = string | number | undefined | false;
export type Attrs = Record<string, AttrValue>;

/** Round to 0.01 and print without exponent notation or a signed zero. */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return String(normalized);
}

/** XML text/attribute escaping — the only escaping the renderer needs. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrs(map: Attrs): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (value === undefined || value === false) continue;
    parts.push(` ${name}="${esc(typeof value === 'number' ? fmt(value) : value)}"`);
  }
  return parts.join('');
}

/** `<name …/>` */
export function leaf(name: string, map: Attrs): string {
  return `<${name}${attrs(map)}/>`;
}

/** `<name …>children</name>` */
export function node(name: string, map: Attrs, children: string): string {
  return `<${name}${attrs(map)}>${children}</${name}>`;
}

export function text(content: string, map: Attrs): string {
  return node('text', map, esc(content));
}

/** A `<title>` child makes the note a tooltip without printing it. */
export function tooltip(content: string | undefined): string {
  return content === undefined ? '' : node('title', {}, esc(content));
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Orthogonal polyline as a path `d`. Consecutive duplicate points (a route
 * whose two anchors happen to share a row) collapse, so a straight run never
 * emits a zero-length segment.
 *
 * "Duplicate" is judged on the **printed** coordinates, not on the raw ones:
 * two points that round to the same pair are the same point in the file, and
 * nothing else may be dropped. A near-miss threshold would be the routing-
 * tolerance bug all over again — collapse `(x, y)` into `(x, y + 0.004)` and
 * the run either side of it becomes a shallow diagonal in the output even
 * though every routed segment was exactly axis-aligned.
 */
export function pathData(points: readonly Pt[], radius = 0): string {
  if (radius > 0) return roundedPathData(points, radius);
  const parts: string[] = [];
  let previous: string | undefined;
  for (const point of points) {
    const printed = `${fmt(point.x)} ${fmt(point.y)}`;
    if (printed === previous) continue;
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${printed}`);
    previous = printed;
  }
  return parts.join(' ');
}

const axial = (p: Pt, q: Pt): boolean => Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6;

/**
 * `pathData`, with every corner that joins an oblique segment (an angled
 * pad's lead, an entry-guide slot's run in) rounded by a
 * tangent arc of `radius` — held to half of either segment it joins. Corners
 * between two axis-aligned segments (the Manhattan route itself) stay square.
 */
export function roundedPathData(points: readonly Pt[], radius: number): string {
  const pts: Pt[] = [];
  for (const point of points) {
    const last = pts[pts.length - 1];
    if (last === undefined || fmt(last.x) !== fmt(point.x) || fmt(last.y) !== fmt(point.y)) pts.push(point);
  }
  if (pts.length === 0) return '';
  const parts = [`M${fmt(pts[0]!.x)} ${fmt(pts[0]!.y)}`];
  for (let i = 1; i < pts.length; i += 1) {
    const corner = pts[i]!;
    const prev = pts[i - 1]!;
    const next = pts[i + 1];
    if (next === undefined || (axial(prev, corner) && axial(corner, next))) {
      parts.push(`L${fmt(corner.x)} ${fmt(corner.y)}`);
      continue;
    }
    const la = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const lb = Math.hypot(next.x - corner.x, next.y - corner.y);
    const a = { x: (corner.x - prev.x) / la, y: (corner.y - prev.y) / la };
    const b = { x: (next.x - corner.x) / lb, y: (next.y - corner.y) / lb };
    const turn = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));
    if (turn < Math.PI / 180 || turn > (175 * Math.PI) / 180) {
      parts.push(`L${fmt(corner.x)} ${fmt(corner.y)}`);
      continue;
    }
    const tan = Math.tan(turn / 2);
    const t = Math.min(radius * tan, la / 2, lb / 2);
    const r = t / tan;
    const sweep = a.x * b.y - a.y * b.x > 0 ? 1 : 0;
    parts.push(`L${fmt(corner.x - a.x * t)} ${fmt(corner.y - a.y * t)}`);
    parts.push(`A${fmt(r)} ${fmt(r)} 0 0 ${sweep} ${fmt(corner.x + b.x * t)} ${fmt(corner.y + b.y * t)}`);
  }
  return parts.join(' ');
}
