/**
 * An analytical look at a finished drawing — the check the golden snapshots
 * cannot do.
 *
 * A golden proves the file did not change. It cannot tell you that two labels
 * now sit on top of each other, that a footnote slid off the page, or that a
 * routed wire runs straight through a connector block: all of those produce a
 * perfectly well-formed SVG with every element present, and a golden that has
 * simply been regenerated. So this module reads the rendered drawing back and
 * measures it.
 *
 * **Text metrics.** There is no font engine here and no browser, so the boxes
 * come from `textWidth` in `@wirehub/layout` — the same static advance
 * tables, at the same font sizes and weights, that layout used to *reserve*
 * the space. That makes this an audit of the drawing against its own metrics:
 * it catches "these two boxes were never going to fit". The tables are the
 * envelope of every face the SVG's font stack can land on,
 * and `scripts/raster-check.ts` re-runs the text sweep on real Chromium glyph
 * boxes to hold them to it. Font sizes, weights, letter-spacing and default
 * anchors are read out of the emitted `<style>` element, so a rule that
 * changes there is picked up here rather than drifting.
 *
 * **Artwork.** A depicted block inlines a part's own vector drawing under a
 * `translate/scale`. Its interior is the part's typography, not this drawing's,
 * and it is authored elsewhere — so the sweep does not descend into it. What
 * it does check is that the artwork frame lands inside the block that owns it.
 */

import { textWidth, type FontWeight } from '@wirehub/layout';

import { findAll, hasClass, parseXml, type XmlNode } from './xml.ts';

/* ------------------------------------------------------------------ *
 * Boxes
 * ------------------------------------------------------------------ */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Slack, in millimetres, before two things count as colliding.
 *
 * Text widths are envelope estimates (the widest face in the font stack, per
 * weight, plus 2 %), and adjacent
 * columns are *meant* to sit edge to edge, so a fraction of a millimetre of
 * computed overlap is noise. A third of a millimetre is about a tenth of the
 * smallest type on the page — anything past that is visible.
 */
export const SLACK = 0.35;

/**
 * How far a label's estimated box is pulled in before a wire through it
 * counts: the box carries a width margin and a descender allowance, so a
 * run that only clips that margin does not touch a glyph.
 */
export const TEXT_WIRE_INSET = 0.15;

/** Two different wires may touch end to end, or cross; sharing more than this of a line is drawing one over the other. */
export const OVERLAP_SLACK = 0.3;

/** Two centre lines closer than this print as one line (every wire stroke is wider). */
export const COINCIDENT_LINES = 0.5;

/** Slack for hard geometry (outlines, routed wires), which is exact. */
export const GEOMETRY_SLACK = 0.05;

function overlap(a: Box, b: Box, slack: number): boolean {
  return (
    Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > slack &&
    Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > slack
  );
}

function contains(outer: Box, inner: Box, slack: number): boolean {
  return (
    inner.x0 >= outer.x0 - slack &&
    inner.y0 >= outer.y0 - slack &&
    inner.x1 <= outer.x1 + slack &&
    inner.y1 <= outer.y1 + slack
  );
}

function union(boxes: Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  return boxes.reduce((all, box) => ({
    x0: Math.min(all.x0, box.x0),
    y0: Math.min(all.y0, box.y0),
    x1: Math.max(all.x1, box.x1),
    y1: Math.max(all.y1, box.y1),
  }));
}

const round = (value: number): string => String(Math.round(value * 100) / 100);

export const describeBox = (box: Box): string =>
  `[${round(box.x0)},${round(box.y0)} → ${round(box.x1)},${round(box.y1)}]`;

/* ------------------------------------------------------------------ *
 * The emitted stylesheet
 * ------------------------------------------------------------------ */

export interface TextStyle {
  fontSize?: number;
  textAnchor?: string;
  /** `font-weight` ≥ 600 measures against the bold table */
  weight?: FontWeight;
  letterSpacing?: number;
}

/** `.note-text{font-size:2.5px;fill:#14181d}` → `{ 'note-text': {…} }`. */
export function parseStylesheet(css: string): Map<string, TextStyle> {
  const out = new Map<string, TextStyle>();
  for (const rule of css.matchAll(/\.([A-Za-z0-9_-]+)\{([^}]*)\}/g)) {
    const name = rule[1] ?? '';
    const body = rule[2] ?? '';
    const size = /font-size:\s*([\d.]+)px/.exec(body);
    const anchor = /text-anchor:\s*([A-Za-z-]+)/.exec(body);
    const weight = /font-weight:\s*(\d+)/.exec(body);
    const spacing = /letter-spacing:\s*([\d.]+)px/.exec(body);
    const existing = out.get(name) ?? {};
    out.set(name, {
      ...existing,
      ...(size === null ? {} : { fontSize: Number(size[1]) }),
      ...(anchor === null ? {} : { textAnchor: anchor[1] }),
      ...(weight === null ? {} : { weight: Number(weight[1]) >= 600 ? ('bold' as const) : ('regular' as const) }),
      ...(spacing === null ? {} : { letterSpacing: Number(spacing[1]) }),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

export type FindingKind =
  | 'text-unstyled'
  | 'text-off-page'
  | 'text-overlap'
  | 'region-overlap'
  /* one per region kind, so a caller can hold each to its own standard */
  | 'edge-crosses-block'
  | 'edge-crosses-band'
  | 'edge-crosses-component'
  | 'edge-crosses-panel'
  /* a routed wire drawn through a label */
  | 'edge-crosses-text'
  /* two different nets' wires drawn one on top of the other (nck.13) */
  | 'edge-overlap'
  | 'off-page'
  | 'artwork-outside-block';

export interface Finding {
  kind: FindingKind;
  message: string;
}

export interface PlacedText {
  content: string;
  className: string;
  fontSize: number;
  box: Box;
}

export type RegionKind = 'block' | 'band' | 'component' | 'panel';

export interface Region {
  kind: RegionKind;
  /** design instance / segment id, or `cross-section` for the cutaway panel */
  id: string;
  /** `data-location` of a component, when it declares one */
  location?: string;
  box: Box;
}

export interface Audit {
  width: number;
  height: number;
  texts: PlacedText[];
  regions: Region[];
  findings: Finding[];
}

export function findings(audit: Audit, ...kinds: FindingKind[]): string[] {
  return audit.findings
    .filter((finding) => kinds.includes(finding.kind))
    .map((finding) => `${finding.kind}: ${finding.message}`);
}

/* ------------------------------------------------------------------ *
 * Primitive geometry out of the drawing
 * ------------------------------------------------------------------ */

const num = (node: XmlNode, name: string, fallback = 0): number => {
  const raw = node.attrs[name];
  return raw === undefined ? fallback : Number(raw);
};

/** Every number pair in a path `d`, control points included. */
function pathPoints(d: string): { x: number; y: number }[] {
  // a rounded landing corner (`A rx ry rot large sweep x y`, e5c.30): its end
  // point only — the arc stays inside the corner it rounds
  const flat = d.replace(/A\s*(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+\d+\s+\d\s+\d\s+/g, 'L');
  const numbers = (flat.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const out: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    out.push({ x: numbers[index]!, y: numbers[index + 1]! });
  }
  return out;
}

/** The box a single drawn primitive occupies, ignoring stroke width. */
function primitiveBox(node: XmlNode): Box | undefined {
  switch (node.name) {
    case 'rect': {
      const x = num(node, 'x');
      const y = num(node, 'y');
      return { x0: x, y0: y, x1: x + num(node, 'width'), y1: y + num(node, 'height') };
    }
    case 'line':
      return {
        x0: Math.min(num(node, 'x1'), num(node, 'x2')),
        y0: Math.min(num(node, 'y1'), num(node, 'y2')),
        x1: Math.max(num(node, 'x1'), num(node, 'x2')),
        y1: Math.max(num(node, 'y1'), num(node, 'y2')),
      };
    case 'circle': {
      const r = num(node, 'r');
      return {
        x0: num(node, 'cx') - r,
        y0: num(node, 'cy') - r,
        x1: num(node, 'cx') + r,
        y1: num(node, 'cy') + r,
      };
    }
    case 'path': {
      const points = pathPoints(node.attrs['d'] ?? '');
      return union(points.map((p) => ({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })));
    }
    default:
      return undefined;
  }
}

/** Straight segments of an axis-aligned polyline path. */
function pathSegments(d: string): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const points = pathPoints(d);
  const out: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  for (let index = 1; index < points.length; index += 1) {
    out.push({ a: points[index - 1]!, b: points[index]! });
  }
  return out;
}

/** How much of a segment lies strictly inside a box (Liang–Barsky). */
function segmentInsideLength(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: Box,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  const ok =
    clip(-dx, a.x - box.x0) &&
    clip(dx, box.x1 - a.x) &&
    clip(-dy, a.y - box.y0) &&
    clip(dy, box.y1 - a.y);
  if (!ok || t1 <= t0) return 0;
  return Math.hypot(dx, dy) * (t1 - t0);
}

const shrink = (box: Box, by: number): Box => ({
  x0: box.x0 + by,
  y0: box.y0 + by,
  x1: box.x1 - by,
  y1: box.y1 - by,
});

/** Instance ids a joint is attached to, so its own endpoints are not crossings. */
function jointInstances(node: XmlNode): Set<string> {
  const out = new Set<string>();
  for (const name of ['data-a', 'data-b']) {
    const key = node.attrs[name];
    if (key === undefined) continue;
    out.add(key.slice(0, key.indexOf(':') === -1 ? key.length : key.indexOf(':')));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * auditDrawing
 * ------------------------------------------------------------------ */

/** Nodes inside an inlined artwork asset, which this sweep does not measure. */
function artworkNodes(root: XmlNode): Set<XmlNode> {
  const out = new Set<XmlNode>();
  for (const art of findAll(root, (node) => hasClass(node, 'depiction'))) {
    for (const node of findAll(art, () => true)) out.add(node);
  }
  return out;
}

export function auditDrawing(svg: string): Audit {
  const root = parseXml(svg);
  const [, , width = 0, height = 0] = (root.attrs['viewBox'] ?? '').split(' ').map(Number);
  const page: Box = { x0: 0, y0: 0, x1: width, y1: height };
  const findingList: Finding[] = [];
  const note = (kind: FindingKind, message: string): void => {
    findingList.push({ kind, message });
  };

  const styles = parseStylesheet(
    findAll(root, (node) => node.name === 'style')
      .map((node) => node.text)
      .join(''),
  );
  const inArtwork = artworkNodes(root);

  /* --- text ----------------------------------------------------- */

  const texts: PlacedText[] = [];
  for (const node of findAll(root, (item) => item.name === 'text')) {
    if (inArtwork.has(node)) continue;
    const className = node.attrs['class'] ?? '';
    const style = className
      .split(/\s+/)
      .map((name) => styles.get(name))
      .reduce<TextStyle>((all, item) => ({ ...all, ...item }), {});
    if (style.fontSize === undefined) {
      note(
        'text-unstyled',
        `<text class="${className}"> has no font-size in the stylesheet: "${node.text}"`,
      );
      continue;
    }
    const content = node.text;
    if (content === '') continue;
    const fontSize = style.fontSize;
    const anchor = node.attrs['text-anchor'] ?? style.textAnchor ?? 'start';
    const w = textWidth(content, fontSize, style.weight, style.letterSpacing);
    const x = num(node, 'x');
    const y = num(node, 'y');
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    // `y` is the baseline; the box is cap height above it and descender below
    const box: Box = { x0, y0: y - fontSize * 0.72, x1: x0 + w, y1: y + fontSize * 0.2 };
    texts.push({ content, className, fontSize, box });
    if (!contains(page, box, SLACK)) {
      note(
        'text-off-page',
        `"${content}" (.${className}) at ${describeBox(box)} leaves the ${round(width)}×${round(height)} page`,
      );
    }
  }

  // pairwise, by a sweep over the vertical extents so this stays near-linear
  const ordered = [...texts].sort((a, b) => a.box.y0 - b.box.y0);
  for (let index = 0; index < ordered.length; index += 1) {
    const first = ordered[index]!;
    for (let other = index + 1; other < ordered.length; other += 1) {
      const second = ordered[other]!;
      if (second.box.y0 >= first.box.y1) break;
      if (!overlap(first.box, second.box, SLACK)) continue;
      note(
        'text-overlap',
        `"${first.content}" (.${first.className}) ${describeBox(first.box)} overlaps ` +
          `"${second.content}" (.${second.className}) ${describeBox(second.box)}`,
      );
    }
  }

  /* --- regions -------------------------------------------------- */

  const regions: Region[] = [];
  const outlineBox = (group: XmlNode, className: string): Box | undefined => {
    const outline = findAll(group, (node) => hasClass(node, className))[0];
    return outline === undefined ? undefined : primitiveBox(outline);
  };

  for (const group of findAll(root, (node) => hasClass(node, 'block'))) {
    const box = outlineBox(group, 'block-outline');
    if (box === undefined) continue;
    regions.push({ kind: 'block', id: group.attrs['data-instance'] ?? '?', box });
  }
  for (const group of findAll(root, (node) => hasClass(node, 'band'))) {
    const box = outlineBox(group, 'band-outline');
    if (box === undefined) continue;
    regions.push({ kind: 'band', id: group.attrs['data-segment'] ?? '?', box });
  }
  for (const group of findAll(root, (node) => hasClass(node, 'component'))) {
    // a capacitor is drawn as bare lines, so the symbol's box is the union of
    // whatever it drew, minus its label
    const box = union(
      findAll(group, (node) => node.name !== 'text' && node !== group)
        .map((node) => primitiveBox(node))
        .filter((item): item is Box => item !== undefined),
    );
    if (box === undefined) continue;
    regions.push({
      kind: 'component',
      id: group.attrs['data-instance'] ?? '?',
      ...(group.attrs['data-location'] === undefined
        ? {}
        : { location: group.attrs['data-location'] }),
      box,
    });
  }
  for (const panel of findAll(root, (node) => hasClass(node, 'xs-panel'))) {
    const box = primitiveBox(panel);
    if (box !== undefined) regions.push({ kind: 'panel', id: 'cross-section', box });
  }

  /**
   * An inline component sits *on* the band on purpose — it is a part fitted
   * into the run of the cable, and the drawing says so by drawing it there.
   * Every other pairing is a collision.
   */
  const mayOverlap = (a: Region, b: Region): boolean => {
    const pair = [a, b];
    const component = pair.find((region) => region.kind === 'component');
    const band = pair.find((region) => region.kind === 'band');
    return (
      component !== undefined &&
      band !== undefined &&
      (component.location ?? '').toLowerCase().includes('inline')
    );
  };

  for (let index = 0; index < regions.length; index += 1) {
    for (let other = index + 1; other < regions.length; other += 1) {
      const first = regions[index]!;
      const second = regions[other]!;
      if (!overlap(first.box, second.box, GEOMETRY_SLACK)) continue;
      if (mayOverlap(first, second)) continue;
      note(
        'region-overlap',
        `${first.kind} ${first.id} ${describeBox(first.box)} overlaps ` +
          `${second.kind} ${second.id} ${describeBox(second.box)}`,
      );
    }
  }

  /* --- routed wires against the regions they do not belong to ---- */

  for (const joint of findAll(root, (node) => hasClass(node, 'joint'))) {
    const attached = jointInstances(joint);
    const edge = findAll(joint, (node) => hasClass(node, 'edge'))[0];
    if (edge === undefined) continue;
    for (const segment of pathSegments(edge.attrs['d'] ?? '')) {
      for (const region of regions) {
        if (attached.has(region.id)) continue;
        const inside = segmentInsideLength(
          segment.a,
          segment.b,
          shrink(region.box, GEOMETRY_SLACK),
        );
        if (inside <= GEOMETRY_SLACK) continue;
        note(
          `edge-crosses-${region.kind}` as FindingKind,
          `joint ${joint.attrs['data-joint'] ?? '?'} (${joint.attrs['data-a'] ?? ''} → ` +
            `${joint.attrs['data-b'] ?? ''}) runs ${round(inside)} mm through ` +
            `${region.kind} ${region.id} ${describeBox(region.box)}`,
        );
      }
    }
  }

  /* --- routed wires against the labels they do not belong to ----- */

  /**
   * A wire drawn through a label strikes the words out: the reader loses the
   * text and, worse, may read the stroke as part of it. Labels inside a block
   * the wire lands on are the block's own business (a connector drawn as
   * itself prints each row over its own wire, 7xo.11), so the check is over
   * every other label on the page.
   */
  const regionOf = (id: string): Region[] => regions.filter((region) => region.id === id);
  const centre = (box: Box): Box => {
    const x = (box.x0 + box.x1) / 2;
    const y = (box.y0 + box.y1) / 2;
    return { x0: x, y0: y, x1: x, y1: y };
  };
  const wires = [
    ...findAll(root, (node) => hasClass(node, 'joint')),
    ...findAll(root, (node) => hasClass(node, 'breakout-through-run')),
    // a housed connector's own stub, from a terminated row's dot to its pin,
    // entirely inside the mould
    ...findAll(root, (node) => hasClass(node, 'breakout-housed-lead')),
  ];
  for (const joint of wires) {
    const attached = [...jointInstances(joint)].flatMap(regionOf);
    const edge = findAll(joint, (node) => hasClass(node, 'edge'))[0];
    if (edge === undefined) continue;
    const segments = pathSegments(edge.attrs['d'] ?? '');
    for (const label of texts) {
      if (attached.some((region) => contains(region.box, centre(label.box), 0))) continue;
      const box = shrink(label.box, TEXT_WIRE_INSET);
      if (box.x1 <= box.x0 || box.y1 <= box.y0) continue;
      const inside = segments.reduce((sum, segment) => sum + segmentInsideLength(segment.a, segment.b, box), 0);
      if (inside <= SLACK) continue;
      note(
        'edge-crosses-text',
        `joint ${joint.attrs['data-joint'] ?? '?'} (${joint.attrs['data-a'] ?? ''} → ` +
          `${joint.attrs['data-b'] ?? ''}) runs ${round(inside)} mm through ` +
          `"${label.content}" (.${label.className}) ${describeBox(label.box)}`,
      );
    }
  }

  /* --- two nets' wires, one on top of the other ------------------ */

  /**
   * Two runs of different nets sharing a stretch of the same line read as one
   * wire — as a connection that is not there. Runs on one net may share a
   * line (two screens onto one ground pad are one conductor, drawn twice).
   */
  interface Run {
    wire: string;
    net: string;
    at: number;
    lo: number;
    hi: number;
  }
  const lines = new Map<string, Run[]>();
  wires.forEach((joint, index) => {
    const edge = findAll(joint, (node) => hasClass(node, 'edge'))[0];
    if (edge === undefined) return;
    const net = joint.attrs['data-net'] ?? `?${index}`;
    const wire = `${joint.attrs['data-a'] ?? ''} → ${joint.attrs['data-b'] ?? ''}`;
    for (const { a, b } of pathSegments(edge.attrs['d'] ?? '')) {
      const vertical = Math.abs(a.x - b.x) < 1e-6;
      const horizontal = Math.abs(a.y - b.y) < 1e-6;
      if (vertical === horizontal) continue;
      // near-coincident counts: two centre lines closer than a stroke is wide
      // print as one
      const axis = vertical ? 'x' : 'y';
      const at = vertical ? a.x : a.y;
      const bucket = Math.round(at / COINCIDENT_LINES);
      const [lo, hi] = vertical ? [Math.min(a.y, b.y), Math.max(a.y, b.y)] : [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      for (const near of [bucket - 1, bucket, bucket + 1]) {
        for (const other of lines.get(`${axis}${near}`) ?? []) {
          if (other.net === net || other.wire === wire) continue;
          if (Math.abs(other.at - at) >= COINCIDENT_LINES) continue;
          const shared = Math.min(hi, other.hi) - Math.max(lo, other.lo);
          if (shared <= OVERLAP_SLACK) continue;
          note(
            'edge-overlap',
            `${wire} and ${other.wire} share ${round(shared)} mm of the line ${axis} ≈ ${round(at)}`,
          );
        }
      }
      const key = `${axis}${bucket}`;
      const list = lines.get(key) ?? [];
      lines.set(key, list);
      list.push({ wire, net, at, lo, hi });
    }
  });

  /* --- everything drawn, inside the viewBox ---------------------- */

  for (const node of findAll(root, (item) => item !== root)) {
    if (inArtwork.has(node)) continue;
    if (node.name === 'text') continue; // measured above, with its metrics
    const box = primitiveBox(node);
    if (box === undefined) continue;
    if (contains(page, box, GEOMETRY_SLACK)) continue;
    note(
      'off-page',
      `<${node.name} class="${node.attrs['class'] ?? ''}"> at ${describeBox(box)} leaves the ` +
        `${round(width)}×${round(height)} page`,
    );
  }

  /* --- artwork frames, inside the block that owns them ----------- */

  const blockById = new Map(
    regions.filter((region) => region.kind === 'block').map((region) => [region.id, region]),
  );
  for (const art of findAll(root, (node) => hasClass(node, 'depiction'))) {
    const id = art.attrs['data-instance'] ?? '?';
    const transform = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(art.attrs['transform'] ?? '');
    const block = blockById.get(id);
    if (transform === null || block === undefined) continue;
    const origin: Box = {
      x0: Number(transform[1]),
      y0: Number(transform[2]),
      x1: Number(transform[1]),
      y1: Number(transform[2]),
    };
    if (contains(block.box, origin, GEOMETRY_SLACK)) continue;
    note(
      'artwork-outside-block',
      `artwork of ${id} starts at ${describeBox(origin)}, outside block ${describeBox(block.box)}`,
    );
  }

  return { width, height, texts, regions, findings: findingList };
}
