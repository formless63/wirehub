/**
 * The wire cross-section cutaway, drawn.
 *
 * `renderCrossSection(wire)` is a standalone SVG document — build sheets embed
 * the cutaway on its own, with no schematic around it — and
 * `renderCrossSectionPanel(cs)` is the same drawing as a fragment, which the
 * schematic page uses for its inset.
 *
 * The visual language follows the vendor sheets' cutaways: core sheaths filled in the
 * conductor's own colour (the same palette the band tracks use), shields
 * hatched by construction — crossed strokes for braid, leaning strokes for a
 * spiral serve, circumferential dashes for tape, smooth metal for foil —
 * numbered callouts running out past the jacket in lay order, a key naming
 * every core with its signal role, an OD dimension and a real millimetre
 * ruler. Colour stays additive: every core carries its lay number and its key
 * line, so a monochrome print loses nothing.
 *
 * Determinism is the same deal as the rest of the renderer: pure string
 * building, every coordinate through `fmt`, no external resources — the hatch
 * is explicit geometry rather than an SVG `<pattern>`, which also keeps the
 * file free of `url(...)` references.
 */

import { stripMakerSuffix, type WireDefinition } from '@wirehub/model';
import {
  crossSectionLayout,
  METRICS as M,
  type CrossSection,
  type CrossSectionCore,
  type CrossSectionRing,
} from '@wirehub/layout';

import { esc, fmt, leaf, node, text, tooltip } from './svg.ts';
import { conductorPaint, INK, STYLESHEET } from './theme.ts';

export interface CrossSectionOptions {
  /** paper mm per cable mm (default `METRICS.crossSectionScale`) */
  scale?: number;
  /** override the panel heading (defaults to the stock label) */
  title?: string;
}

/* ------------------------------------------------------------------ *
 * Paint
 * ------------------------------------------------------------------ */

const COPPER = '#b8763a';
const SHIELD_METAL = '#a7aeb5';
const PLAIN_INSULATION = '#e9edf1';

/**
 * Fill for one ring of the cutaway. Core sheaths take the same paint as the
 * band track of the core they belong to, so a reader moves between the two
 * drawings without re-learning the colours. The outer jacket is the exception:
 * black PVC painted dead black swallows the drawing, and the print language
 * already carries a jacket ink for exactly this.
 */
export function ringPaint(ring: CrossSectionRing, isJacket = false): string {
  switch (ring.kind) {
    case 'conductor':
      return COPPER;
    case 'shield':
      return SHIELD_METAL;
    case 'insulation':
      if (isJacket) return INK.jacket;
      return ring.colorName === undefined ? PLAIN_INSULATION : conductorPaint(ring.colorName);
  }
}

/* ------------------------------------------------------------------ *
 * Rings
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

function at(cx: number, cy: number, radius: number, angleDeg: number): string {
  return `${fmt(cx + radius * Math.cos(angleDeg * DEG))} ${fmt(cy - radius * Math.sin(angleDeg * DEG))}`;
}

/**
 * Shield hatching, as one path of explicit strokes — how many marks fit is a
 * function of the ring's own circumference, so a big overall shield and a
 * small core shield read at the same density.
 */
function hatchPath(ring: CrossSectionRing): string {
  const construction = ring.construction;
  if (construction === undefined || construction === 'foil') return '';
  const mid = (ring.r + ring.rInner) / 2;
  const wall = Math.max(0.3, ring.r - ring.rInner);
  const inner = mid - wall / 2;
  const outer = mid + wall / 2;
  const count = Math.min(48, Math.max(8, Math.round((2 * Math.PI * mid) / 1.8)));
  const step = 360 / count;
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = index * step;
    if (construction === 'braid') {
      const lean = step * 0.42;
      parts.push(
        `M${at(ring.cx, ring.cy, inner, angle - lean)} L${at(ring.cx, ring.cy, outer, angle + lean)}`,
        `M${at(ring.cx, ring.cy, inner, angle + lean)} L${at(ring.cx, ring.cy, outer, angle - lean)}`,
      );
    } else if (construction === 'spiral') {
      const lean = step * 0.45;
      parts.push(
        `M${at(ring.cx, ring.cy, inner, angle - lean)} L${at(ring.cx, ring.cy, outer, angle + lean)}`,
      );
    } else {
      // tape: circumferential wraps with a gap between them
      parts.push(
        `M${at(ring.cx, ring.cy, inner + wall * 0.2, angle)} L${at(ring.cx, ring.cy, outer - wall * 0.2, angle + step * 0.62)}`,
      );
    }
  }
  return parts.join(' ');
}

/** One element seen end-on: a filled disc or annulus, plus any hatching. */
function renderRing(ring: CrossSectionRing, isJacket = false): string {
  const paint = ringPaint(ring, isJacket || ring.jacket === true);
  const parts: string[] = [];
  if (ring.rInner <= 0.01) {
    parts.push(
      leaf('circle', { class: 'xs-fill', cx: ring.cx, cy: ring.cy, r: ring.r, fill: paint }),
    );
  } else {
    parts.push(
      leaf('circle', {
        class: 'xs-fill',
        cx: ring.cx,
        cy: ring.cy,
        r: (ring.r + ring.rInner) / 2,
        fill: 'none',
        stroke: paint,
        'stroke-width': ring.r - ring.rInner,
      }),
    );
  }
  const hatch = hatchPath(ring);
  if (hatch !== '') parts.push(leaf('path', { class: 'xs-hatch', d: hatch }));
  parts.push(
    leaf('circle', { class: 'xs-outline', cx: ring.cx, cy: ring.cy, r: ring.r }),
  );
  if (ring.rInner > 0.01) {
    parts.push(
      leaf('circle', { class: 'xs-outline', cx: ring.cx, cy: ring.cy, r: ring.rInner }),
    );
  }
  return node(
    'g',
    {
      class: `xs-ring xs-ring-${ring.kind}`,
      'data-element': ring.elementPath,
      'data-kind': ring.kind,
      ...(ring.construction === undefined ? {} : { 'data-construction': ring.construction }),
      'data-od': ring.odMm,
    },
    // a foil is drawn as the cable's real geometry, never labelled — not
    // even as a tooltip (: "the foil doesn't typically get
    // any indication on our drawings")
    (ring.construction === 'foil' || ring.construction === 'tape'
      ? ''
      : tooltip(`${ring.label} — Ø ${ring.odMm.toFixed(2)} mm`)) + parts.join(''),
  );
}

function renderCore(core: CrossSectionCore): string {
  const parts = core.rings.map((ring) => renderRing(ring));
  return node(
    'g',
    {
      class: 'xs-core',
      'data-core': core.elementPath,
      'data-tag': core.tag,
      'data-lay': core.layIndex,
      'data-angle': core.angleDeg,
    },
    tooltip(core.label) + parts.join(''),
  );
}

/** The numbered callout: a radial leader out past the jacket, then the tag. */
function renderCallout(core: CrossSectionCore): string {
  const from = core.leader[0];
  const to = core.leader[core.leader.length - 1];
  if (from === undefined || to === undefined) return '';
  const line = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  return node(
    'g',
    { class: 'xs-callout', 'data-core': core.elementPath, 'data-tag': core.tag },
    [
      leaf('line', { class: 'xs-leader-halo', ...line }),
      leaf('line', { class: 'xs-leader', ...line }),
      text(core.tag, {
        class: 'xs-tag',
        x: core.tagX,
        y: core.tagY,
        'text-anchor': core.tagAnchor,
      }),
    ].join(''),
  );
}

/**
 * A figure-8's jackets and web as one filled outline:
 * two joined circles, never one round jacket. The legs' own jacket rings
 * draw over it with their cores.
 */
function renderOutline(cs: CrossSection): string {
  const outline = cs.outline!;
  return node(
    'g',
    {
      class: 'xs-ring xs-ring-insulation xs-outline-figure8',
      'data-element': cs.jacket.elementPath,
      'data-kind': 'insulation',
      'data-shape': outline.shape,
      'data-width': outline.widthMm,
      'data-height': outline.heightMm,
    },
    tooltip(`${cs.jacket.label} — ${outline.widthMm.toFixed(2)} × ${outline.heightMm.toFixed(2)} mm`) +
      leaf('path', { class: 'xs-fill', d: outline.d, fill: INK.jacket }) +
      leaf('path', { class: 'xs-outline', d: outline.d }),
  );
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/** The cutaway as a fragment, positioned where its layout put it. */
export function renderCrossSectionPanel(cs: CrossSection): string {
  const parts: string[] = [
    leaf('rect', {
      class: 'xs-panel',
      x: cs.rect.x,
      y: cs.rect.y,
      width: cs.rect.w,
      height: cs.rect.h,
      rx: 1.6,
    }),
    text(cs.title, { class: 'xs-title', x: cs.titleX, y: cs.titleY }),
    text(cs.subtitle, { class: 'xs-sub', x: cs.titleX, y: cs.subtitleY }),
    cs.outline === undefined ? renderRing(cs.jacket, true) : renderOutline(cs),
  ];
  if (cs.overallShield !== undefined) parts.push(renderRing(cs.overallShield));
  for (const core of cs.cores) parts.push(renderCore(core));
  for (const core of cs.cores) parts.push(renderCallout(core));

  /* OD dimension line, with the usual end ticks */
  const { dimension: dim } = cs;
  parts.push(
    node(
      'g',
      { class: 'xs-dimension' },
      [
        leaf('line', { class: 'xs-dim', x1: dim.x1, y1: dim.y, x2: dim.x2, y2: dim.y }),
        leaf('line', {
          class: 'xs-dim',
          x1: dim.x1,
          y1: dim.y - 1.2,
          x2: dim.x1,
          y2: dim.y + 1.2,
        }),
        leaf('line', {
          class: 'xs-dim',
          x1: dim.x2,
          y1: dim.y - 1.2,
          x2: dim.x2,
          y2: dim.y + 1.2,
        }),
        text(dim.label, {
          class: 'xs-dim-text',
          x: dim.labelX,
          y: dim.labelY,
          'text-anchor': 'middle',
        }),
      ].join(''),
    ),
  );

  /* the millimetre ruler */
  const { ruler } = cs;
  const rulerParts: string[] = [
    leaf('line', {
      class: 'xs-rule',
      x1: ruler.x,
      y1: ruler.y,
      x2: ruler.x + ruler.length,
      y2: ruler.y,
    }),
  ];
  ruler.ticks.forEach((tick, index) => {
    const tall = index === 0 || index === ruler.ticks.length - 1;
    rulerParts.push(
      leaf('line', {
        class: 'xs-rule',
        x1: tick,
        y1: ruler.y,
        x2: tick,
        y2: ruler.y - (tall ? 1.8 : 1),
      }),
    );
  });
  rulerParts.push(
    text(ruler.label, { class: 'xs-rule-text', x: ruler.labelX, y: ruler.labelY }),
  );
  parts.push(node('g', { class: 'xs-ruler', 'data-span-mm': ruler.spanMm }, rulerParts.join('')));

  /* the key */
  const keyParts: string[] = [];
  for (const entry of cs.key) {
    const swatch =
      entry.kind === 'shield'
        ? leaf('circle', {
            class: 'xs-swatch',
            cx: entry.swatchX,
            cy: entry.swatchY,
            r: entry.swatchR,
            fill: SHIELD_METAL,
          })
        : leaf('circle', {
            class: 'xs-swatch',
            cx: entry.swatchX,
            cy: entry.swatchY,
            r: entry.swatchR,
            fill:
              entry.kind === 'jacket'
                ? INK.jacket
                : entry.colorName === undefined
                  ? PLAIN_INSULATION
                  : conductorPaint(entry.colorName),
          });
    keyParts.push(
      node(
        'g',
        {
          class: 'xs-key-row',
          'data-tag': entry.tag,
          ...(entry.construction === undefined
            ? {}
            : { 'data-construction': entry.construction }),
        },
        [
          swatch,
          entry.tag === ''
            ? ''
            : text(entry.tag, {
                class: 'xs-key-tag',
                x: entry.tagX,
                y: entry.textY,
              }),
          text(entry.text, { class: 'xs-key', x: entry.textX, y: entry.textY }),
        ].join(''),
      ),
    );
  }
  parts.push(node('g', { class: 'xs-key-list' }, keyParts.join('')));

  return node(
    'g',
    {
      class: 'cross-section',
      'data-wire': cs.wire,
      'data-arrangement': cs.arrangement,
      'data-direction': cs.direction,
      'data-scale': cs.scale,
    },
    parts.join(''),
  );
}

/* ------------------------------------------------------------------ *
 * Standalone document
 * ------------------------------------------------------------------ */

/**
 * The cutaway on its own — a complete, self-contained SVG document a build
 * sheet can embed without any schematic around it.
 *
 * Stocks whose geometry the catalog does not document (no jacket diameter)
 * render a stated placeholder rather than a guessed drawing.
 */
export function renderCrossSection(
  wire: WireDefinition,
  options: CrossSectionOptions = {},
): string {
  const cs = crossSectionLayout(wire, {
    ...(options.scale === undefined ? {} : { scale: options.scale }),
    ...(options.title === undefined ? {} : { title: options.title }),
  });
  const title = options.title ?? stripMakerSuffix(wire.label, wire.manufacturer);

  if (cs === undefined) {
    const width = Math.max(70, M.crossSectionPad * 2 + title.length * 1.9);
    const height = 16;
    return svgDocument(
      width,
      height,
      title,
      `Cross-section of ${wire.id}: geometry not documented.`,
      wire.id,
      [
        leaf('rect', {
          class: 'xs-panel',
          x: 0.3,
          y: 0.3,
          width: width - 0.6,
          height: height - 0.6,
          rx: 1.6,
        }),
        text(title, { class: 'xs-title', x: M.crossSectionPad, y: 6.4 }),
        text('no cross-section: this stock has no documented diameters', {
          class: 'xs-sub',
          x: M.crossSectionPad,
          y: 11,
        }),
      ].join(''),
    );
  }

  const description = [
    `Cross-section of ${stripMakerSuffix(wire.label, wire.manufacturer)}${wire.partNumber === undefined ? '' : ` (${wire.partNumber})`}.`,
    cs.outline === undefined
      ? `Ø ${cs.odMm.toFixed(2)} mm over the jacket, drawn at ${cs.scale}:1.`
      : `Figure-8, ${cs.outline.widthMm.toFixed(2)} × ${cs.outline.heightMm.toFixed(2)} mm over the jackets, drawn at ${cs.scale}:1.`,
    cs.outline === undefined ? `Lay order ${cs.direction.toUpperCase()} from 12 o'clock:` : 'Legs left to right:',
    `${cs.cores
      .filter((core) => core.layIndex >= 0)
      .map((core) => `${core.tag} ${core.elementPath}`)
      .join(', ')}.`,
  ].join(' ');

  return svgDocument(cs.rect.w, cs.rect.h, title, description, wire.id, renderCrossSectionPanel(cs));
}

function svgDocument(
  width: number,
  height: number,
  title: string,
  description: string,
  wireId: string,
  body: string,
): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}"`,
    ` width="${fmt(width)}mm" height="${fmt(height)}mm"`,
    ` role="img" aria-label="${esc(title)}" data-wire="${esc(wireId)}">`,
    node('title', {}, esc(title)),
    node('desc', {}, esc(description)),
    node('style', {}, STYLESHEET),
    leaf('rect', { class: 'page', x: 0, y: 0, width, height }),
    body,
    '</svg>',
  ].join('');
}
