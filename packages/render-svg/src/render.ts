/**
 * `renderSchematic(design, db, opts?) => string`
 *
 * A deterministic, print-first SVG wiring schematic drawn straight from the
 * canonical model. Pure string building: no DOM, no React, no browser APIs,
 * no external resources of any kind (no `<image>`, no `<foreignObject>`, no
 * webfonts) — the file is self-contained and prints as it looks.
 *
 * The visual language, in one paragraph: the drawing reads left → right,
 * source → destination. Connector and PCBA blocks are pinout tables whose
 * rows are ports; the wire bundle between them is the hero, drawn as a band
 * of tracks — one per electrical element, stroked in the conductor's colour,
 * labelled once, with coax centre/shield pairs bracketed. Joints are filled
 * dots. Components sit inline on their path as IEC symbols. Everything that
 * colour says, a label also says.
 */

import type { CableDesign, Db } from '@wirehub/model';
import {
  catalogDepictions,
  layoutSchematic,
  METRICS as M,
  rotationTransform,
  textWidth,
  type DepictionDiagnostic,
  type DepictionSource,
  type Diagram,
  type DiagramBand,
  type DiagramBlock,
  type DiagramBreakout,
  type DiagramComponent,
  type DiagramMouldJack,
  type DiagramPort,
  type DiagramTrack,
} from '@wirehub/layout';

import { renderBoardParts } from './board-parts.ts';
import { renderConnectorArt, renderMouldJack } from './connector-art.ts';
import { renderCrossSectionPanel } from './cross-section.ts';
import { inlineVectorAsset, usesXlink } from './depiction.ts';
import { esc, fmt, leaf, node, pathData, text, tooltip, type Pt } from './svg.ts';
import {
  BREAKOUT_STYLESHEET,
  CONNECTOR_ART_STYLESHEET,
  DEPICTION_STYLESHEET,
  INK,
  jointStyle,
  STYLESHEET,
  trackStyle,
} from './theme.ts';

export interface RenderOptions {
  /** override the drawing title (defaults to `design.label`) */
  title?: string;
  /** override the line under the title */
  subtitle?: string;
  /**
   * Draw the trunk stock's cross-section cutaway as an inset (default `true`).
   * Sheets that carry the cutaway separately turn it off and call
   * `renderCrossSection` instead.
   */
  crossSection?: boolean;
  /**
   * Draw blocks whose definition has usable artwork as depicted blocks
   * (default `true`); `false` renders every block as the abstract pin-row
   * table, byte-for-byte as it drew before depictions existed.
   *
   * A `DepictionSource` draws from somewhere other than the catalog's
   * committed tree. `renderDiagram` must be given the **same** source the
   * layout used, since the diagram model carries only the identity of an
   * asset, never its bytes.
   */
  depictions?: boolean | DepictionSource;
  /**
   * Print each populated board's parts' ref/value over the artwork
   *. Default `false`: a printed build sheet's BOM
   * already lists every part, so a document renders this way unless it asks
   * otherwise; the studio's own schematic panel passes its "Part labels"
   * toggle through here. Every part still carries a `<title>` tooltip with
   * the same facts regardless of this option.
   */
  partLabels?: boolean;
}

/** The artwork source a render pass should read, or `undefined` when off. */
function depictionSourceFor(options: RenderOptions): DepictionSource | undefined {
  const option = options.depictions ?? true;
  if (option === false) return undefined;
  return option === true ? catalogDepictions() : option;
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

export function renderSchematic(
  design: CableDesign,
  db: Db,
  options: RenderOptions = {},
): string {
  return renderDiagram(
    layoutSchematic(design, db, {
      ...(options.crossSection === undefined ? {} : { crossSection: options.crossSection }),
      ...(options.depictions === undefined ? {} : { depictions: options.depictions }),
    }),
    options,
  );
}

/**
 * What became of each block's artwork on this design's schematic
 * — the layout's own `DepictionDiagnostic`s, which
 * `renderSchematic` otherwise drops with the rest of the diagram. An editor
 * shows the ones that are wrong (artwork exists but could not be used) beside
 * the validator's issues, so an author learns why a board drew abstract.
 */
export function depictionDiagnostics(
  design: CableDesign,
  db: Db,
  options: Pick<RenderOptions, 'depictions'> = {},
): DepictionDiagnostic[] {
  return layoutSchematic(design, db, {
    crossSection: false,
    ...(options.depictions === undefined ? {} : { depictions: options.depictions }),
  }).depictions;
}

export function renderDiagram(diagram: Diagram, options: RenderOptions = {}): string {
  const title = options.title ?? diagram.title;
  const subtitle = options.subtitle ?? diagram.subtitle;

  const tracksByKey = new Map<string, DiagramTrack>();
  for (const band of diagram.bands) {
    for (const track of band.tracks) tracksByKey.set(track.key, track);
    // a pigtail's landing is drawn in the style of the screens it gathers
    for (const pigtail of band.pigtails) {
      const first = pigtail.members[0];
      const track = first === undefined ? undefined : tracksByKey.get(first);
      if (track !== undefined) tracksByKey.set(pigtail.key.slice(0, pigtail.key.lastIndexOf('@')), track);
    }
  }
  const trackFor = (terminalKey: string): DiagramTrack | undefined => {
    const at = terminalKey.lastIndexOf('@');
    return tracksByKey.get(at === -1 ? terminalKey : terminalKey.slice(0, at));
  };

  const depicted = diagram.blocks.some((block) => block.depiction !== undefined);
  const housedArt = (diagram.breakouts ?? []).some((mould) => mould.jacks.some((jack) => jack.connectorArt !== undefined));
  const drawnConnectors = housedArt || diagram.blocks.some((block) => block.connectorArt !== undefined);
  const artSource = depicted ? depictionSourceFor(options) : undefined;
  /** a profile's grip band takes the colour of the conductor on its terminal */
  const bandPaint = (block: DiagramBlock, terminal: string): string | undefined => {
    const key = `${block.id}:${terminal}`;
    for (const edge of diagram.edges) {
      const other = edge.a === key ? edge.b : edge.b === key ? edge.a : undefined;
      const track = other === undefined ? undefined : trackFor(other);
      if (track !== undefined && track.role !== 'shield' && track.role !== 'overall-shield') return trackStyle(track).stroke;
    }
    return undefined;
  };
  const partLabels = options.partLabels === true;

  const body = [
    leaf('rect', { class: 'page', x: 0, y: 0, width: diagram.width, height: diagram.height }),
    renderHeader(diagram, title, subtitle),
    // artwork sits *under* the wiring: a conductor that lands on a pad in the
    // middle of a board has to read as one unbroken run across it
    renderArtwork(diagram, artSource, partLabels),
    drawnConnectors ? renderConnectorArtLayer(diagram, bandPaint) : '',
    renderMoulds(diagram),
    renderEdges(diagram, trackFor),
    renderBands(diagram),
    renderBreakoutWires(diagram),
    diagram.crossSection === undefined
      ? ''
      : renderCrossSectionPanel(diagram.crossSection),
    renderBlocks(diagram),
    renderComponents(diagram),
    renderJointDots(diagram),
    renderCutEnds(diagram),
    renderNotes(diagram),
  ].join('');

  const description = [
    `Wiring schematic for ${diagram.designId}.`,
    ...diagram.issues.map((issue) => `${issue.severity}: ${issue.code} ${issue.message}`),
  ].join(' ');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(diagram.width)} ${fmt(diagram.height)}"`,
    ` width="${fmt(diagram.width)}mm" height="${fmt(diagram.height)}mm"`,
    ` role="img" aria-label="${esc(title)}" data-design="${esc(diagram.designId)}">`,
    node('title', {}, esc(title)),
    node('desc', {}, esc(description)),
    node(
      'style',
      {},
      (depicted || drawnConnectors ? STYLESHEET + DEPICTION_STYLESHEET : STYLESHEET) +
        (drawnConnectors ? CONNECTOR_ART_STYLESHEET : '') +
        ((diagram.breakouts ?? []).length > 0 ? BREAKOUT_STYLESHEET : ''),
    ),
    body,
    '</svg>',
  ].join('');
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function renderHeader(diagram: Diagram, title: string, subtitle: string): string {
  const parts: string[] = [
    text(title, { class: 'title', x: M.margin, y: M.margin + 5 }),
    text(subtitle, { class: 'subtitle', x: M.margin, y: M.margin + 10 }),
  ];

  const errors = diagram.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    parts.push(
      text(`${errors.length} validation error(s) — see <desc>`, {
        class: 'issue',
        x: M.margin,
        y: M.margin + 14,
      }),
    );
  }

  const { direction, legend } = diagram;
  parts.push(
    text(direction.leftLabel, { class: 'direction', x: direction.x1, y: direction.y }),
    text(direction.rightLabel, {
      class: 'direction',
      x: direction.x2,
      y: direction.y,
      'text-anchor': 'end',
    }),
    leaf('line', {
      class: 'rule',
      x1: direction.x1,
      y1: direction.y + 2.4,
      x2: direction.x2 - 2.4,
      y2: direction.y + 2.4,
    }),
    leaf('path', {
      class: 'rule',
      fill: INK.rule,
      d: `M${fmt(direction.x2)} ${fmt(direction.y + 2.4)} L${fmt(direction.x2 - 2.6)} ${fmt(direction.y + 1.3)} L${fmt(direction.x2 - 2.6)} ${fmt(direction.y + 3.5)} Z`,
    }),
    renderLegend(
      legend.x1,
      legend.y,
      diagram.bands.some((band) => band.tracks.some((track) => track.role === 'overall-shield')),
    ),
  );

  return node('g', { class: 'header' }, parts.join(''));
}

interface LegendItem {
  label: string;
  draw: (x: number, y: number) => string;
}

function sampleLine(
  x: number,
  y: number,
  stroke: string,
  width: number,
  dash?: string,
): string {
  return leaf('line', {
    x1: x,
    y1: y,
    x2: x + 8,
    y2: y,
    stroke,
    'stroke-width': width,
    ...(dash === undefined ? {} : { 'stroke-dasharray': dash }),
  });
}

/**
 * The line-style key. "overall shield" is keyed only when a band draws one: a
 * foil is never drawn or keyed, so on
 * most sheets there is none — only a copper overall screen (an audio lead's
 * spiral) keeps the row.
 */
function renderLegend(x0: number, y: number, overallShield: boolean): string {
  const items: LegendItem[] = [
    { label: 'conductor (colour = core)', draw: (x, yy) => sampleLine(x, yy, '#cc2b2b', 1.4) },
    { label: 'core shield', draw: (x, yy) => sampleLine(x, yy, INK.shield, 0.75, '2 1.2') },
    ...(overallShield
      ? [
          {
            label: 'overall shield',
            draw: (x: number, yy: number) => sampleLine(x, yy, INK.overallShield, 1.1, '4 1.6'),
          },
        ]
      : []),
    { label: 'drain (bare)', draw: (x, yy) => sampleLine(x, yy, INK.drain, 1, '2.4 1 0.6 1') },
    {
      label: 'joint',
      draw: (x, yy) => leaf('circle', { class: 'joint-dot', cx: x + 4, cy: yy, r: 0.9 }),
    },
    {
      label: 'PCBA internal link',
      draw: (x, yy) => sampleLine(x, yy, INK.muted, 0.35, '1.6 1.2'),
    },
    { label: 'deliberate cut end', draw: (x, yy) => cutGlyph(x + 4, yy, 1) },
  ];

  const parts: string[] = [];
  let cursor = x0;
  for (const item of items) {
    parts.push(item.draw(cursor, y));
    parts.push(text(item.label, { class: 'legend-text', x: cursor + 10, y: y + 0.8 }));
    cursor += 10 + textWidth(item.label, M.fontLegend) + 5;
  }
  return node('g', { class: 'legend' }, parts.join(''));
}

/* ------------------------------------------------------------------ *
 * Joint routing
 * ------------------------------------------------------------------ */

/**
 * How far (page mm) a schematic edge's approach lead runs before joining the
 * rest of its route — short: this is a landing on a
 * pad the board's own artwork already draws life-size, not a long cable run.
 */
const SCHEMATIC_APPROACH_LEAD_MM = M.approachLead;

/**
 * The radius (page mm) of the tangent arc that rounds a landing's corner —
 * where an angled lead or an entry-guide slot's run in meets the orthogonal
 * route. Tight: the corner softens, the route does not
 * move. Square Manhattan corners elsewhere stay square.
 */
const SCHEMATIC_LEAD_FILLET_MM = 1;

/** A unit direction from a standard-math-convention angle (degrees). */
function approachVector(deg: number): Pt {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** Squared distance — only ever compared, never needs the root. */
function dist2(p: Pt, q: Pt): number {
  return (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
}

/**
 * `edge.points`, with the run right at whichever end (`a`/`b`) lands on a pad
 * with its own approach angle (`DiagramPort.approach`)
 * replaced by a short diagonal lead plus one elbow back to axis-aligned: the
 * pad's own point stays exactly where the layout put it and every point
 * beyond the elbow is untouched (nothing about the route itself changes —
 * the whole track/lane ordering this edge came from is unaffected), so the
 * schematic keeps its orthogonal-routing convention everywhere except the
 * one short stretch that now arrives at the pad's real angle instead of
 * square to it. The elbow reuses whichever axis the original (straight,
 * orthogonal) first segment already shared with the pad, so it always
 * resolves — a segment out of an orthogonal route always shares one.
 * A pad with no approach (straight-in, or too close to natural to bother —
 * `isNaturalApproach`) leaves the edge exactly as drawn today.
 */
function withApproachLeads(
  edge: { a: string; b: string; points: readonly Pt[] },
  ports: ReadonlyMap<string, DiagramPort>,
  slotted: readonly DiagramPort[] = [],
): Pt[] {
  let points = edge.points as Pt[];
  if (points.length < 2) return points;
  //: an end on a guided row's pad was routed to its slot
  // on the entry guide, off the board — one straight lead on to the pad
  // (matched by position: a multi-pad terminal's ports share one key)
  if (slotted.length > 0) {
    const onSlot = (point: Pt): DiagramPort | undefined =>
      slotted.find((port) => dist2(point, port.slot!) <= 0.01);
    // a connector drawn as itself: the wire's own run
    // on from its row, across the drawing, to the pin
    const head = onSlot(points[0]!);
    if (head !== undefined) points = [{ x: head.x, y: head.y }, ...[...(head.lead ?? [])].reverse(), ...points];
    const tail = onSlot(points[points.length - 1]!);
    if (tail !== undefined) points = [...points, ...(tail.lead ?? []), { x: tail.x, y: tail.y }];
  }
  const withApproach = [ports.get(edge.a), ports.get(edge.b)].filter(
    (p): p is DiagramPort => p?.approach !== undefined,
  );
  if (withApproach.length === 0) return points;
  // the route's own layout may put either endpoint first (`cutRoute` orders
  // by geometric left/right, not by `a`/`b`) — match each port to whichever
  // original end of the polyline actually sits on its pad, never assume.
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let out = points;
  for (const port of withApproach) {
    const onFirst = dist2(first, port) <= dist2(last, port);
    const anchor = onFirst ? first : last;
    if (dist2(anchor, port) > 0.01) continue; // defensive: not actually this pad
    const neighbor = onFirst ? out[1] : out[out.length - 2];
    const dir = approachVector(port.approach!);
    const lead: Pt = { x: anchor.x + dir.x * SCHEMATIC_APPROACH_LEAD_MM, y: anchor.y + dir.y * SCHEMATIC_APPROACH_LEAD_MM };
    // the elbow: shares the lead's x (or y) with whichever axis the pad's
    // own original segment ran on, and the other with `neighbor` — so both
    // segments either side of it are axis-aligned again.
    const elbow: Pt | undefined =
      neighbor === undefined
        ? undefined
        : anchor.y === neighbor.y
          ? { x: lead.x, y: neighbor.y }
          : anchor.x === neighbor.x
            ? { x: neighbor.x, y: lead.y }
            : undefined;
    const insert = elbow === undefined ? [lead] : [lead, elbow];
    out = onFirst ? [out[0]!, ...insert, ...out.slice(1)] : [...out.slice(0, -1), ...insert.reverse(), out[out.length - 1]!];
  }
  return out;
}

function renderEdges(
  diagram: Diagram,
  trackFor: (key: string) => DiagramTrack | undefined,
): string {
  const ports = new Map<string, DiagramPort>();
  for (const block of diagram.blocks) for (const port of block.ports) ports.set(port.key, port);
  const slotted = diagram.blocks.flatMap((block) => block.ports.filter((port) => port.slot !== undefined));
  const parts: string[] = [];
  for (const edge of diagram.edges) {
    const track = trackFor(edge.a) ?? trackFor(edge.b);
    const style = jointStyle(track);
    const d = pathData(withApproachLeads(edge, ports, slotted), SCHEMATIC_LEAD_FILLET_MM);
    const strokes: string[] = [];
    if (style.halo) {
      strokes.push(leaf('path', { class: 'halo', d, 'stroke-width': style.width + 0.7 }));
    }
    strokes.push(
      leaf('path', {
        class: 'edge',
        d,
        stroke: style.stroke,
        'stroke-width': style.width,
        ...(style.dash === undefined ? {} : { 'stroke-dasharray': style.dash }),
      }),
    );
    parts.push(
      node(
        'g',
        {
          class: 'joint',
          'data-joint': edge.index,
          'data-a': edge.a,
          'data-b': edge.b,
          'data-net': edge.net,
        },
        tooltip(edge.note) + strokes.join(''),
      ),
    );
  }
  return node('g', { class: 'joints-wiring' }, parts.join(''));
}

/* ------------------------------------------------------------------ *
 * Breakout moulds
 * ------------------------------------------------------------------ */

/**
 * A jack's own grip band takes the colour of whatever it terminates
 * — the same rule a block's profile follows
 * (`bandPaint` above), read off the mould's own rows and the jack's leads
 * rather than `diagram.edges` (the joint never routes: it is drawn here).
 */
function jackBandPaint(mould: DiagramBreakout, jack: DiagramMouldJack) {
  return (terminal: string): string | undefined => {
    const lead = jack.leads.find((item) => item.terminal === terminal);
    if (lead === undefined) return undefined;
    const row = mould.rows.find((item) => item.key === lead.from);
    if (row === undefined || row.role === 'shield' || row.role === 'overall-shield') return undefined;
    const look = { role: row.role, bare: row.bare, ...(row.colorName === undefined ? {} : { colorName: row.colorName }) } as DiagramTrack;
    return trackStyle(look).stroke;
  };
}

/**
 * The mould outline and its label, under the wiring: the trunk's end sits
 * inside it, and so does any connector it houses —
 * drawn as itself, its opening facing the way the legs run, never as a block
 * on a lead.
 */
function renderMoulds(diagram: Diagram): string {
  const parts = (diagram.breakouts ?? []).map((mould) =>
    node(
      'g',
      { class: 'breakout', 'data-breakout': mould.id },
      leaf('rect', { class: 'mould', x: mould.rect.x, y: mould.rect.y, width: mould.rect.w, height: mould.rect.h, rx: 3 }) +
        text(mould.label, { class: 'mould-label', x: mould.rect.x, y: mould.rect.y - 1.2 }) +
        (mould.sublabelLines ?? []).map((line, index) =>
          text(line, { class: 'mould-sub', x: mould.rect.x, y: mould.rect.y + mould.rect.h + (index + 1) * M.mouldSubLineHeight }),
        ).join('') +
        mould.jacks.map((jack) => renderMouldJack(jack, jackBandPaint(mould, jack))).join(''),
    ),
  );
  return parts.length === 0 ? '' : node('g', { class: 'breakouts' }, parts.join(''));
}

/**
 * Over the bands: a conductor passing through uncut is one unbroken line
 * across the mould and on to its leg; a terminated one ends inside it (its
 * solder dot is the joint's); an NC one is cut back in it, marked NC.
 */
function renderBreakoutWires(diagram: Diagram): string {
  const parts: string[] = [];
  for (const mould of diagram.breakouts ?? []) {
    const outer = mould.dir === 1 ? mould.rect.x + mould.rect.w : mould.rect.x;
    for (const row of mould.rows) {
      const look = { role: row.role, bare: row.bare, ...(row.colorName === undefined ? {} : { colorName: row.colorName }) } as DiagramTrack;
      const style = trackStyle(look);
      if (row.fate === 'through') {
        parts.push(
          node(
            'g',
            { class: 'breakout-row breakout-through', 'data-row': row.key, 'data-net': row.net },
            leaf('line', {
              class: 'track-line',
              x1: mould.edgeX,
              y1: row.y,
              x2: outer,
              y2: row.y,
              stroke: style.stroke,
              'stroke-width': style.width,
              ...(style.dash === undefined ? {} : { 'stroke-dasharray': style.dash }),
            }),
          ),
        );
      } else if (row.fate === 'nc') {
        parts.push(
          node(
            'g',
            { class: 'breakout-row breakout-nc', 'data-row': row.key },
            tooltip(row.reason) +
              text('NC', {
                class: 'mould-nc',
                x: (row.x ?? mould.edgeX) + (row.dir ?? mould.dir) * 2.2,
                y: row.y + 0.6,
                ...((row.dir ?? mould.dir) === -1 ? { 'text-anchor': 'end' } : {}),
              }),
          ),
        );
      }
    }
    for (const run of mould.throughs) {
      const look = { role: run.role, bare: run.bare, ...(run.colorName === undefined ? {} : { colorName: run.colorName }) } as DiagramTrack;
      const style = trackStyle(look);
      const d = pathData(run.points, SCHEMATIC_LEAD_FILLET_MM);
      parts.push(
        node(
          'g',
          { class: 'breakout-through-run', 'data-a': run.from, 'data-b': run.to, 'data-net': run.net },
          (style.halo ? leaf('path', { class: 'halo', d, 'stroke-width': style.width + 0.7 }) : '') +
            leaf('path', {
              class: 'edge',
              d,
              stroke: style.stroke,
              'stroke-width': style.width,
              ...(style.dash === undefined ? {} : { 'stroke-dasharray': style.dash }),
            }),
        ),
      );
    }
    // a connector this mould houses: a short stub from
    // each terminated row's dot to the jack's own pin, entirely inside the
    // mould — never a lead reaching outside it
    for (const jack of mould.jacks) {
      for (const lead of jack.leads) {
        const row = mould.rows.find((item) => item.key === lead.from);
        const look = (row === undefined
          ? { role: 'shield', bare: false }
          : { role: row.role, bare: row.bare, ...(row.colorName === undefined ? {} : { colorName: row.colorName }) }) as DiagramTrack;
        const style = trackStyle(look);
        const d = pathData(lead.points, SCHEMATIC_LEAD_FILLET_MM);
        parts.push(
          node(
            'g',
            {
              class: 'breakout-housed-lead',
              'data-a': lead.from,
              'data-b': `${jack.instanceId}:${lead.terminal}`,
              ...(row?.net === undefined ? {} : { 'data-net': row.net }),
            },
            (style.halo ? leaf('path', { class: 'halo', d, 'stroke-width': style.width + 0.7 }) : '') +
              leaf('path', {
                class: 'edge',
                d,
                stroke: style.stroke,
                'stroke-width': style.width,
                ...(style.dash === undefined ? {} : { 'stroke-dasharray': style.dash }),
              }),
          ),
        );
      }
    }
  }
  return parts.length === 0 ? '' : node('g', { class: 'breakout-wiring' }, parts.join(''));
}

/* ------------------------------------------------------------------ *
 * Bands
 * ------------------------------------------------------------------ */

function renderBands(diagram: Diagram): string {
  return node(
    'g',
    { class: 'bands' },
    diagram.bands.map((band) => renderBand(band)).join(''),
  );
}

function renderBand(band: DiagramBand): string {
  const parts: string[] = [
    leaf('rect', {
      class: 'band-outline',
      x: band.rect.x,
      y: band.rect.y,
      width: band.rect.w,
      height: band.rect.h,
      rx: 2,
    }),
    node(
      'text',
      { class: 'band-label', x: band.labelX, y: band.labelY },
      tooltip(band.fullLabel) + esc(band.label),
    ),
  ];

  for (const group of band.groups) {
    parts.push(
      leaf('path', {
        class: 'bracket',
        d: `M${fmt(group.x + M.bracketWidth)} ${fmt(group.y1 - 2)} L${fmt(group.x)} ${fmt(group.y1 - 2)} L${fmt(group.x)} ${fmt(group.y2 + 2)} L${fmt(group.x + M.bracketWidth)} ${fmt(group.y2 + 2)}`,
      }),
      text(group.label, {
        class: 'group-label',
        x: group.labelX,
        y: group.labelY,
        'data-group': `${band.segment}:${group.id}`,
      }),
    );
  }

  for (const track of band.tracks) {
    const style = trackStyle(track);
    const strokes: string[] = [];
    if (style.halo) {
      strokes.push(
        leaf('line', {
          class: 'halo',
          x1: track.x1,
          y1: track.y,
          x2: track.x2,
          y2: track.y,
          'stroke-width': style.width + 0.8,
        }),
      );
    }
    strokes.push(
      leaf('line', {
        class: 'track-line',
        x1: track.x1,
        y1: track.y,
        x2: track.x2,
        y2: track.y,
        stroke: style.stroke,
        'stroke-width': style.width,
        ...(style.dash === undefined ? {} : { 'stroke-dasharray': style.dash }),
      }),
    );
    parts.push(
      node(
        'g',
        {
          class: `track track-${track.role}`,
          'data-track': track.key,
          'data-segment': track.segment,
          'data-element': track.elementPath,
          'data-kind': track.kind,
          'data-net': track.net,
        },
        strokes.join('') +
          text(track.label, {
            class: 'track-label',
            x: band.trackLabelX,
            y: track.y - 1.3,
          }),
      ),
    );
  }

  for (const pigtail of band.pigtails) {
    const first = band.tracks.find((track) => track.key === pigtail.members[0]);
    const style = first === undefined ? undefined : trackStyle(first);
    const stroke = style?.stroke ?? INK.ink;
    const d = [
      ...pigtail.memberYs.map((y) => `M${fmt(pigtail.edgeX)} ${fmt(y)} L${fmt(pigtail.x)} ${fmt(y)}`),
      `M${fmt(pigtail.x)} ${fmt(pigtail.y1)} L${fmt(pigtail.x)} ${fmt(pigtail.y2)}`,
      `M${fmt(pigtail.x)} ${fmt(pigtail.anchor.y)} L${fmt(pigtail.anchor.x)} ${fmt(pigtail.anchor.y)}`,
    ].join(' ');
    parts.push(
      node(
        'g',
        {
          class: 'pigtail',
          'data-pigtail': pigtail.key,
          'data-members': pigtail.members.join(' '),
          'data-net': pigtail.net,
        },
        tooltip(pigtail.note) +
          leaf('path', {
            class: 'pigtail-line',
            d,
            stroke,
            'stroke-width': 0.6,
            fill: 'none',
          }),
      ),
    );
  }

  return node(
    'g',
    {
      class: `band band-${band.zone}`,
      'data-segment': band.segment,
      'data-left-end': band.leftEnd,
    },
    parts.join(''),
  );
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

function renderBlocks(diagram: Diagram): string {
  return node(
    'g',
    { class: 'blocks' },
    diagram.blocks.map((block) => renderBlock(block)).join(''),
  );
}

/** Every depicted block's artwork, in block order, as one layer. */
function renderArtwork(diagram: Diagram, source: DepictionSource | undefined, partLabels: boolean): string {
  if (source === undefined) return '';
  const parts = diagram.blocks
    .filter((block) => block.depiction !== undefined)
    .map((block) => renderBlockArt(block, source, partLabels));
  if (parts.every((part) => part === '')) return '';
  return node('g', { class: 'artwork' }, parts.join(''));
}

/** Every connector drawn as itself, under the wiring like other artwork. */
function renderConnectorArtLayer(
  diagram: Diagram,
  bandPaint: (block: DiagramBlock, terminal: string) => string | undefined,
): string {
  const parts = diagram.blocks
    .filter((block) => block.connectorArt !== undefined)
    .map((block) => renderConnectorArt(block, (terminal) => bandPaint(block, terminal)));
  return node('g', { class: 'connector-artwork' }, parts.join(''));
}

/**
 * One block's artwork, transformed into its frame.
 *
 * Vector art is inlined as a group (ids prefixed per block instance, so two
 * depicted blocks on one page never collide); raster art is embedded as a
 * `data:` URI, which keeps the "no external resources" promise intact. The
 * asset's own units survive the transform, so its `stroke-width`s scale with
 * the picture and a board magnified 2× reads at 2× the line weight.
 */
function renderBlockArt(block: DiagramBlock, source: DepictionSource | undefined, partLabels: boolean): string {
  const art = block.depiction;
  if (art === undefined || source === undefined) return '';
  if (art.faces !== undefined) return renderBoardFaces(block, source, partLabels);
  const artwork = source.artwork(art.defId, art.view);
  if (artwork === undefined) return '';
  const inner =
    artwork.kind === 'raster'
      ? artwork.dataUri === undefined
        ? ''
        : leaf('image', {
            href: artwork.dataUri,
            x: 0,
            y: 0,
            width: art.widthUnits,
            height: art.heightUnits,
            preserveAspectRatio: 'none',
          })
      : inlineVectorAsset(artwork.source ?? '', `dep-${block.id}-`);
  if (inner === '') return '';
  return node(
    'g',
    {
      class: 'depiction',
      'data-instance': block.id,
      'data-depiction': `${art.defId}/${art.view}`,
      // the wrapper inherits the SVG namespace, but an asset that still uses
      // the `xlink:` prefix needs it declared or the document is not XML
      ...(usesXlink(inner) ? { 'xmlns:xlink': 'http://www.w3.org/1999/xlink' } : {}),
      transform: `translate(${fmt(art.rect.x)} ${fmt(art.rect.y)}) scale(${fmt(art.scale)})`,
    },
    inner + renderBoardParts(art.parts, { labels: partLabels }),
  );
}

/** A board part's `ref value` label on a two-faced board, page mm — whatever the board's magnification. */
const PART_LABEL_PAGE = 1.7;

/**
 * A two-faced board: each face's artwork turned into
 * its box, and the build's parts on that face drawn upright over it — a
 * separate group without the turn, so their labels read level. Both are
 * artwork (`.depiction`): the audit measures neither's interior.
 */
function renderBoardFaces(block: DiagramBlock, source: DepictionSource, partLabels: boolean): string {
  const art = block.depiction!;
  const parts: string[] = [];
  for (const face of art.faces ?? []) {
    const artwork = source.artwork(art.defId, face.view);
    if (artwork?.kind !== 'vector' || artwork.source === undefined) continue;
    const inner = inlineVectorAsset(artwork.source, `dep-${block.id}-${face.side}-`);
    const turn = rotationTransform(face.frame, face.rotation);
    parts.push(
      node(
        'g',
        {
          class: 'depiction board-face',
          'data-instance': block.id,
          'data-face': face.side,
          'data-depiction': `${art.defId}/${face.view}`,
          ...(usesXlink(inner) ? { 'xmlns:xlink': 'http://www.w3.org/1999/xlink' } : {}),
          transform: `translate(${fmt(face.rect.x)} ${fmt(face.rect.y)}) scale(${fmt(face.scale)})${turn === '' ? '' : ` ${turn}`}`,
        },
        inner,
      ),
    );
    const layer = renderBoardParts(face.parts, {
      // the part names print at the drawing's own small size, whatever the
      // board's magnification
      labelSize: Math.round((PART_LABEL_PAGE / face.scale) * 1000) / 1000,
      labels: partLabels,
      ...(art.partNets === undefined ? {} : { partNets: art.partNets }),
    });
    if (layer !== '') {
      parts.push(
        node(
          'g',
          {
            class: 'depiction board-face-parts',
            'data-instance': block.id,
            'data-face': face.side,
            transform: `translate(${fmt(face.rect.x)} ${fmt(face.rect.y)}) scale(${fmt(face.scale)})`,
          },
          layer,
        ),
      );
    }
  }
  return parts.join('');
}

/** How far a drawn connector's row text sits above its wire (baseline), mm. */
const ROW_TEXT_LIFT = 1.2;

function renderBlock(block: DiagramBlock): string {
  const { rect } = block;
  const drawn = block.connectorArt !== undefined;
  const depicted = block.depiction !== undefined || drawn;
  const parts: string[] = [];

  const rows = depicted
    ? 0
    : Math.max(
        block.ports.filter((port) => port.column === 'cable').length,
        block.ports.filter((port) => port.column === 'integrated').length,
      );
  for (let index = 1; index < rows; index += 2) {
    parts.push(
      leaf('rect', {
        class: 'zebra',
        x: rect.x + 0.6,
        y: rect.y + block.headerHeight + index * M.portPitch,
        width: rect.w - 1.2,
        height: M.portPitch,
      }),
    );
  }

  parts.push(
    leaf('rect', {
      // a depicted block is see-through: its wires land on pads *inside* the
      // outline, and they are drawn before it
      class: depicted ? 'block-outline block-outline-art' : 'block-outline',
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      rx: 1.2,
    }),
    text(block.title, { class: 'block-title', x: rect.x + M.blockPad, y: rect.y + 4.4 }),
  );
  if (block.subtitle !== undefined) {
    parts.push(
      text(block.subtitle, { class: 'block-sub', x: rect.x + M.blockPad, y: rect.y + 8.4 }),
    );
  }
  if (block.captions !== undefined) {
    const capY = rect.y + block.headerHeight - 1.2;
    const cableRight = block.cableSide === 'right';
    if (block.captions.cable !== undefined) {
      parts.push(
        text(block.captions.cable, {
          class: 'block-caption',
          x: cableRight ? rect.x + rect.w - M.blockPad : rect.x + M.blockPad,
          y: capY,
          'text-anchor': cableRight ? 'end' : 'start',
        }),
      );
    }
    if (block.captions.integrated !== undefined) {
      parts.push(
        text(block.captions.integrated, {
          class: 'block-caption',
          x: cableRight ? rect.x + M.blockPad : rect.x + rect.w - M.blockPad,
          y: capY,
          'text-anchor': cableRight ? 'start' : 'end',
        }),
      );
    }
  }
  parts.push(
    leaf('line', {
      class: 'rule',
      x1: rect.x,
      y1: rect.y + block.headerHeight,
      x2: rect.x + rect.w,
      y2: rect.y + block.headerHeight,
    }),
  );
  if (block.connectorArt !== undefined) {
    const caption = block.connectorArt.caption;
    parts.push(text(caption.text, { class: 'face-caption', x: caption.x, y: caption.y, 'text-anchor': 'middle' }));
  }
  for (const face of block.depiction?.faces ?? []) {
    parts.push(
      text(face.caption.text, {
        class: 'face-caption',
        x: face.caption.x,
        y: face.caption.y,
        'text-anchor': face.caption.anchor,
        'data-face': face.side,
      }),
    );
  }

  for (const link of block.internalLinks) {
    const linkParts = [
      // a `via` said by the part it runs through keeps its words as a tooltip
      link.via !== undefined && link.annotation.length === 0 ? tooltip(link.via) : '',
      leaf('path', {
        class: 'internal-link',
        d: pathData(link.points as readonly Pt[]),
        ...(link.via === undefined ? {} : { 'stroke-dasharray': '1.6 1.2' }),
      }),
      ...(link.ghosts ?? []).map((ghost) =>
        leaf('circle', { class: 'link-ghost', cx: ghost.x, cy: ghost.y, r: 0.7 }),
      ),
    ];
    link.annotation.forEach((line, index) => {
      linkParts.push(
        text(line, {
          class: 'annot',
          x: link.annotX,
          y: link.annotY + index * M.fontAnnot * 1.15,
          'text-anchor': link.annotAnchor,
          'data-annotation': 'via',
        }),
      );
    });
    parts.push(
      node(
        'g',
        {
          class: 'pcba-link',
          'data-from': link.from,
          'data-to': link.to,
          'data-net': link.nets?.join(' '),
          'data-parts': link.parts?.join(' '),
          'data-face': link.face,
        },
        linkParts.join(''),
      ),
    );
  }

  for (const port of block.ports) {
    // A depicted port sits on its real pad, so its text moves to the gutter
    // and a leader ties the two together. The label still prints either way:
    // artwork augments the textual truth, it never replaces it.
    const body =
      port.callout === undefined && port.face !== undefined
        ? '' // a board pad its docked connector's own row already names
        : port.callout?.kind === 'pad'
          ? (port.callout.leader.length === 0
              ? ''
              : leaf('path', { class: 'callout-leader', d: pathData(port.callout.leader as readonly Pt[]) })) +
            text(port.callout.text, {
              class: 'pad-label',
              x: port.callout.x,
              y: port.callout.y,
              'text-anchor': port.callout.anchor,
            })
          : port.callout === undefined
        ? text(port.terminal, {
            class: 'pin-id',
            x: port.idX,
            // a drawn connector's row prints over its own wire
            y: port.lead === undefined ? port.y + 0.95 : (port.slot?.y ?? port.y) - ROW_TEXT_LIFT,
            'text-anchor': port.textAnchor,
          }) +
          text(port.label, {
            class: 'pin-label',
            x: port.labelX,
            y: port.lead === undefined ? port.y + 0.95 : (port.slot?.y ?? port.y) - ROW_TEXT_LIFT,
            'text-anchor': port.textAnchor,
          })
        : leaf('path', {
            class: 'callout-leader',
            d: pathData(port.callout.leader as readonly Pt[]),
          }) +
          text(port.callout.text, {
            class: 'callout',
            x: port.callout.x,
            y: port.callout.y,
            'text-anchor': port.callout.anchor,
          });
    parts.push(
      node(
        'g',
        {
          class: `port port-${port.column}`,
          'data-terminal': port.key,
          'data-pin': port.terminal,
          'data-pad': port.pad,
          'data-face': port.face,
          'data-net': port.net,
        },
        tooltip(port.note) + body,
      ),
    );
  }

  block.footnoteLines.forEach((line, index) => {
    parts.push(
      text(line, {
        class: 'block-foot',
        x: rect.x,
        y: rect.y + rect.h + 3.2 + index * M.footnoteLineHeight,
      }),
    );
  });

  return node(
    'g',
    {
      class: `block block-${block.kind}${depicted ? ' block-depicted' : ''}${drawn ? ' block-drawn' : ''}`,
      'data-instance': block.id,
      'data-kind': block.kind,
      'data-zone': block.zone,
      ...(block.depiction === undefined
        ? {}
        : { 'data-depiction': `${block.depiction.defId}/${block.depiction.view}` }),
      ...(block.connectorArt === undefined
        ? {}
        : {
            'data-depiction': `${block.connectorArt.defId}/${block.connectorArt.view === 'profile' ? 'side-profile' : 'mating-face'}`,
          }),
    },
    tooltip(block.note) + parts.join(''),
  );
}

/* ------------------------------------------------------------------ *
 * Component symbols (IEC, print-friendly)
 * ------------------------------------------------------------------ */

function renderComponents(diagram: Diagram): string {
  return node(
    'g',
    { class: 'components' },
    diagram.components.map((component) => renderComponent(component)).join(''),
  );
}

function renderComponent(component: DiagramComponent): string {
  const { rect } = component;
  const cy = rect.y + rect.h / 2;
  const cx = rect.x + rect.w / 2;
  const parts: string[] = [];

  if (component.symbol === 'resistor' || component.symbol === 'generic') {
    parts.push(
      leaf('rect', {
        class: 'symbol',
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        rx: 0.4,
      }),
    );
  } else {
    const gap = 1.1;
    // the plates stand proud of the body rect; the router keeps out of the
    // same overhang, so both read the one constant
    const plateHalf = rect.h / 2 + M.componentPlateOverhang;
    const positive = component.terminals.find((terminal) => terminal.polarity === '+');
    const positiveOnLeft = positive === undefined ? true : positive.dir === -1;
    parts.push(
      leaf('line', { class: 'symbol-line', x1: rect.x, y1: cy, x2: cx - gap, y2: cy }),
      leaf('line', { class: 'symbol-line', x1: cx + gap, y1: cy, x2: rect.x + rect.w, y2: cy }),
    );
    const straightX = positiveOnLeft ? cx - gap : cx + gap;
    const curvedX = positiveOnLeft ? cx + gap : cx - gap;
    parts.push(
      leaf('line', {
        class: 'symbol-line',
        x1: straightX,
        y1: cy - plateHalf,
        x2: straightX,
        y2: cy + plateHalf,
      }),
    );
    if (component.symbol === 'capacitor-polarized') {
      const bulge = positiveOnLeft ? 1.3 : -1.3;
      parts.push(
        leaf('path', {
          class: 'symbol-line',
          d: `M${fmt(curvedX + bulge)} ${fmt(cy - plateHalf)} Q${fmt(curvedX - bulge * 0.4)} ${fmt(cy)} ${fmt(curvedX + bulge)} ${fmt(cy + plateHalf)}`,
        }),
        // beside the positive plate and just clear of the lead, the way a
        // polarised cap is marked on a board. Above the plate it would print
        // on top of the designator/value label, which sits directly over the
        // symbol and is centred on the same x.
        text('+', {
          class: 'polarity',
          x: straightX + (positiveOnLeft ? -1.7 : 1.7),
          y: cy - 0.9,
        }),
      );
    } else {
      parts.push(
        leaf('line', {
          class: 'symbol-line',
          x1: curvedX,
          y1: cy - plateHalf,
          x2: curvedX,
          y2: cy + plateHalf,
        }),
      );
    }
  }

  parts.push(
    text(component.label, {
      class: 'comp-label',
      x: component.labelX,
      y: component.labelY,
    }),
  );

  return node(
    'g',
    {
      class: `component component-${component.symbol}`,
      'data-instance': component.id,
      'data-def': component.def,
      ...(component.location === undefined ? {} : { 'data-location': component.location }),
      'data-net': component.nets?.join(' '),
    },
    tooltip(component.note) + parts.join(''),
  );
}

/* ------------------------------------------------------------------ *
 * Joint dots and cut ends
 * ------------------------------------------------------------------ */

function renderJointDots(diagram: Diagram): string {
  // a guided pad's route ends at its entry-guide slot (e5c.28): its joint
  // dot still marks the pad itself
  const slotted = diagram.blocks.flatMap((block) => block.ports.filter((port) => port.slot !== undefined));
  const onPad = (dot: { x: number; y: number }): { x: number; y: number } =>
    slotted.find((port) => dist2(dot, port.slot!) <= 0.01) ?? dot;
  const parts = diagram.jointDots.map((dot) =>
    leaf('circle', {
      class: 'joint-dot',
      'data-terminal': dot.key,
      'data-pad': dot.pad,
      'data-net': dot.net,
      'data-degree': dot.degree,
      cx: onPad(dot).x,
      cy: onPad(dot).y,
      r: Math.min(1.6, 0.9 + (dot.degree - 1) * 0.12),
    }),
  );
  return node('g', { class: 'joint-dots' }, parts.join(''));
}

/** A short bar plus a slash: this end is cut on purpose, not forgotten. */
function cutGlyph(x: number, y: number, dir: -1 | 1): string {
  return [
    leaf('line', { class: 'cut', x1: x, y1: y - 1.7, x2: x, y2: y + 1.7 }),
    leaf('line', {
      class: 'cut',
      x1: x - 1.4 * dir,
      y1: y + 1.9,
      x2: x + 1.4 * dir,
      y2: y - 1.9,
    }),
  ].join('');
}

function renderCutEnds(diagram: Diagram): string {
  const parts = diagram.cutEnds.map((cut) => {
    const gx = cut.x + cut.dir * 2.2;
    const glyph = cutGlyph(gx, cut.y, cut.dir);
    const ref =
      cut.noteRef === undefined
        ? ''
        : text(String(cut.noteRef), {
            class: 'cut-ref',
            x: gx + cut.dir * 2.4,
            y: cut.y - 1.4,
            'text-anchor': cut.dir === 1 ? 'start' : 'end',
          });
    return node(
      'g',
      { class: 'cut-end', 'data-terminal': cut.key, 'data-net': cut.net },
      tooltip('deliberately cut and left unconnected') + glyph + ref,
    );
  });
  return node('g', { class: 'cut-ends' }, parts.join(''));
}

/* ------------------------------------------------------------------ *
 * Footnotes
 * ------------------------------------------------------------------ */

function renderNotes(diagram: Diagram): string {
  if (diagram.notes.length === 0) return '';
  const parts: string[] = [];
  if (diagram.notesHeading !== undefined) {
    parts.push(
      text('NOTES', {
        class: 'notes-heading',
        x: diagram.notesHeading.x,
        y: diagram.notesHeading.y,
      }),
    );
  }
  for (const note of diagram.notes) {
    parts.push(
      text(`${note.index}.`, { class: 'note-num', x: note.x, y: note.y }),
    );
    note.lines.forEach((line, index) => {
      parts.push(
        text(line, {
          class: 'note-text',
          x: note.x + M.footnoteIndent,
          y: note.y + index * M.footnoteLineHeight,
        }),
      );
    });
  }
  return node('g', { class: 'notes' }, parts.join(''));
}
