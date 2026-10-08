/**
 * How big a node draws.
 *
 * `autoLayout` used to place nodes from a row *count* and a fixed width per
 * kind, which is not what the browser draws: a header grows a line when the
 * part has a subtitle or a meta line, a board draws its two sides side by side
 * under a caption row, and a two-lead component draws its terminals on one
 * line, not two. Placement computed from a different geometry than the one on
 * screen is placement that overlaps, and it did.
 *
 * So this module owns **one** answer to "how big is this node", derived from
 * the node's own data, and both sides use it:
 *
 *   - `NodeShell` renders the node at `estimateNodeSize(data).width`, so the
 *     width is not an estimate at all — it is the number the DOM is given.
 *   - `autoLayout` packs columns with `estimateNodeSize(data)`, so the boxes it
 *     keeps apart are the boxes that get drawn.
 *
 * Heights are still an estimate (the browser owns text layout), so every
 * constant here is the CSS rule it comes from, rounded **up**, plus a small
 * slack — an over-estimate leaves a gap, an under-estimate collides.
 *
 * Deterministic by construction: a static advance-width table, no DOM, no
 * measurement, no randomness — the same design always lays out the same way.
 * The table is the same technique `@wirehub/layout`'s `text.ts` uses for
 * the schematic renderer; it is repeated rather than imported because these are
 * *CSS* metrics (system-ui at 9/10px, plus a monospace column) and that one is
 * calibrated for the SVG face.
 */

import type {
  ComponentNodeData,
  ConnectorNodeData,
  EditorNodeData,
  PcbaNodeData,
  SegmentNodeData,
  TerminalRow,
} from './derive.ts';
import { BOARD_LAYOUT } from './board-art.ts';
import { CONNECTOR_LAYOUT, type ConnectorArt, type ConnectorArtLayout } from './connector-art.ts';
import { WIRE_LAYOUT } from './wire-art.ts';
import type { MouldNodeData } from './moulds.ts';

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/** Advance widths in 1/1000 em for a generic sans face (Helvetica metrics). */
const ADVANCE: Readonly<Record<string, number>> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
  '·': 333, '×': 584, 'Ω': 768, 'µ': 556, '–': 556, '—': 1000, '→': 1000,
  '“': 333, '”': 333, '‘': 222, '’': 222, '…': 1000, '±': 584, '°': 400,
};

const DEFAULT_ADVANCE = 600;

/** Slack so an estimate never comes out narrower than the real glyphs. */
const SAFETY = 1.04;

/** Estimated width of proportional text (the node's system-ui face). */
export function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) units += ADVANCE[char] ?? DEFAULT_ADVANCE;
  return (units / 1000) * fontSize * SAFETY;
}

/** Estimated width of monospace text — pin ids, element paths, instance ids. */
export function monoWidth(text: string, fontSize: number): number {
  return [...text].length * fontSize * 0.62;
}

/* ------------------------------------------------------------------ *
 * The CSS, as numbers
 * ------------------------------------------------------------------ */

/**
 * Every constant names the rule in `editor.css` it was read off. Change one
 * there and change it here; the layout test will not catch a 2px drift, but
 * `estimateNodeSize` is the only place that has to be told.
 */
export const BOX = {
  /** `.cs-node` border */
  border: 1,
  /** `.react-flow__node` font-size, and the row/title face */
  font: 10,
  /** `.cs-subtitle` / `.cs-meta` / `.cs-endpoint` */
  fontSmall: 9,
  /** `.cs-badge` / `.cs-side-label` */
  fontTiny: 8,
  /** a 10px line at line-height 1.45, rounded up */
  line: 15,
  /** a 9px line */
  lineSmall: 14,
  /** a 8px line */
  lineTiny: 12,
  /** `.cs-node-head` padding */
  headPadX: 7,
  headPadY: 4,
  /** `.cs-node-head` gap */
  headGapX: 5,
  headGapY: 1,
  /** `.cs-node-head` border-bottom */
  headRule: 1,
  /** `.cs-badge` padding */
  badgePadX: 4,
  badgePadY: 1,
  /** `.cs-node-body` padding */
  bodyPadY: 5,
  /** `.cs-row` / `.cs-element` height */
  row: 19,
  /** `.cs-row` / `.cs-element` padding */
  rowPadX: 9,
  /** `.cs-part .cs-row` padding */
  partRowPadX: 6,
  /** `.cs-row` / `.cs-element` gap */
  rowGapX: 5,
  /** `.cs-pin` min-width */
  pinMin: 18,
  /** `.cs-side-label`, including its 2px padding-bottom */
  sideLabel: 14,
  /** `.cs-conductor` swatch */
  conductor: 16,
  /** `.cs-endpoint` padding */
  endpointPadX: 2,
  /** slack on the total height, for the difference between this table and the
   *  reader's actual font stack */
  slack: 6,
} as const;

/** The width a node of each kind starts at — never narrower than this. */
export const NODE_BASE_WIDTH = {
  connector: 200,
  segment: 268,
  component: 168,
  pcba: 250,
  /** a breakout mould (`moulds.ts`): compact */
  breakout: 180,
  /** another design placed as a sub-assembly: its ports, grouped */
  subassembly: 230,
} as const;

/** …and never wider than `base × this`: past it, titles ellipsise instead. */
export const WIDTH_HEADROOM = 1.8;

export interface NodeSize {
  width: number;
  height: number;
}

export interface Rect extends NodeSize {
  x: number;
  y: number;
}

export interface NodeRect extends Rect {
  id: string;
}

/* ------------------------------------------------------------------ *
 * The header, as both sides read it
 * ------------------------------------------------------------------ */

export interface NodeHeading {
  /** the kind chip, and the class suffix */
  badge: EditorNodeData['kind'];
  title: string;
  subtitle: string;
  /** the third header line, when the part has one */
  meta?: string;
}

/**
 * What the header shows. `NodeShell` renders exactly this and the estimator
 * measures exactly this, so the header can never grow a line the layout did
 * not budget for.
 */
export function nodeHeading(data: EditorNodeData): NodeHeading {
  switch (data.kind) {
    case 'connector':
      return {
        badge: 'connector',
        title: data.title,
        subtitle: data.subtitle,
        ...(data.role === undefined ? {} : { meta: data.role }),
      };
    case 'segment': {
      const length = data.lengthMm === undefined ? 'no length set' : `${data.lengthMm} mm`;
      return {
        badge: 'segment',
        title: data.title,
        subtitle: data.subtitle,
        meta: [length, data.role].filter((part) => part !== undefined).join(' · '),
      };
    }
    case 'component':
      return {
        badge: 'component',
        title: data.value ?? data.title,
        subtitle: data.componentKind,
        meta: data.def,
      };
    case 'pcba':
      return { badge: 'pcba', title: data.title, subtitle: data.subtitle };
    case 'breakout':
      return { badge: 'breakout', title: data.title, subtitle: data.subtitle };
    case 'subassembly':
      return {
        badge: 'subassembly',
        title: data.title,
        subtitle: [data.partNumber, data.subtitle].filter((part) => part !== undefined).join(' · '),
        meta: [data.def, data.role].filter((part) => part !== undefined).join(' · '),
      };
  }
}

/* ------------------------------------------------------------------ *
 * Size
 * ------------------------------------------------------------------ */

function headHeight(heading: NodeHeading): number {
  const badge = BOX.lineTiny + BOX.badgePadY * 2;
  let height = BOX.headPadY * 2 + Math.max(BOX.line, badge);
  if (heading.subtitle !== '') height += BOX.headGapY + BOX.lineSmall;
  if (heading.meta !== undefined && heading.meta !== '') height += BOX.headGapY + BOX.lineSmall;
  return height + BOX.headRule;
}

/**
 * Where a row node's first row starts, below the node's top edge: border,
 * header, body padding. With `BOX.row`, where each row's handle sits — the
 * estimate the breakout router orders ports by (`breakout.ts`).
 */
export function rowsTop(data: EditorNodeData): number {
  return BOX.border + headHeight(nodeHeading(data)) + BOX.bodyPadY;
}

function headWidth(heading: NodeHeading, instanceId: string): number {
  const badge = textWidth(heading.badge, BOX.fontTiny) + BOX.badgePadX * 2;
  return (
    BOX.headPadX * 2 +
    badge +
    BOX.headGapX +
    monoWidth(instanceId, BOX.font) +
    BOX.headGapX +
    textWidth(heading.title, BOX.font)
  );
}

/** `.cs-row`: pin number, optional end letter, label — the pin-row width. */
function pinRowWidth(row: TerminalRow, padX: number): number {
  let width = padX * 2 + Math.max(BOX.pinMin, monoWidth(row.terminal, BOX.font));
  if (row.end !== undefined) width += BOX.rowGapX + monoWidth(row.end, BOX.font);
  if (row.label !== undefined && row.label !== '') {
    width += BOX.rowGapX + textWidth(row.label, BOX.font);
  }
  if (row.dir !== undefined) width += BOX.rowGapX + 16;
  return width;
}

function widest(values: number[]): number {
  let out = 0;
  for (const value of values) out = Math.max(out, value);
  return out;
}

function connectorBody(data: ConnectorNodeData): NodeSize {
  return {
    width: widest(data.rows.map((row) => pinRowWidth(row, BOX.rowPadX))),
    height: BOX.bodyPadY * 2 + data.rows.length * BOX.row,
  };
}

/** `.cs-part` is one flex line: two leads sit *beside* each other, not under. */
function componentBody(data: ComponentNodeData): NodeSize {
  let width = 0;
  for (const row of data.rows) width += pinRowWidth(row, BOX.partRowPadX);
  return {
    width,
    height: BOX.bodyPadY * 2 + (data.rows.length === 0 ? 0 : BOX.row),
  };
}

/** `.cs-element`: `a` handle, colour swatch, element path, `b` handle. */
function segmentBody(data: SegmentNodeData): NodeSize {
  const end = monoWidth('a', BOX.fontSmall) + BOX.endpointPadX * 2;
  const width = widest(
    data.elements.map(
      (element) =>
        BOX.rowPadX * 2 +
        end +
        BOX.rowGapX +
        BOX.conductor +
        BOX.rowGapX +
        monoWidth(element.path, BOX.font) +
        BOX.rowGapX +
        end,
    ),
  );
  return { width, height: BOX.bodyPadY * 2 + data.elements.length * BOX.row };
}

/** `.cs-board` is a two-column grid, each column captioned. */
function pcbaBody(data: PcbaNodeData): NodeSize {
  const side = (rows: TerminalRow[]): number =>
    widest(rows.map((row) => pinRowWidth(row, BOX.rowPadX)));
  const rows = Math.max(data.pads.length, data.integrated.length);
  return {
    // 1fr 1fr: both columns are as wide as the hungrier one
    width: Math.max(side(data.pads), side(data.integrated)) * 2,
    height: BOX.bodyPadY * 2 + (rows === 0 ? 0 : BOX.sideLabel + rows * BOX.row),
  };
}

/**
 * A mould: one row per conductor of the trunk end, its leg notes under them,
 * then any connector it houses — drawn here, so the box
 * grows to hold it rather than the canvas placing it on a lead elsewhere
 * (`nodes/MouldNode.tsx`).
 */
function mouldBody(data: MouldNodeData): NodeSize {
  const housedHeight = data.housed.reduce((sum, h) => sum + (h.layout === undefined ? 0 : h.layout.height + BOX.bodyPadY), 0);
  const housedWidth = Math.max(0, ...data.housed.map((h) => (h.layout === undefined ? 0 : h.layout.width + BOX.rowPadX * 2)));
  return {
    width: Math.max(NODE_BASE_WIDTH.breakout, housedWidth),
    height: BOX.bodyPadY * 2 + data.rows.length * BOX.row + data.legNotes.length * BOX.lineSmall + housedHeight,
  };
}

function bodySize(data: EditorNodeData): NodeSize {
  switch (data.kind) {
    case 'connector':
      return connectorBody(data);
    case 'segment':
      return segmentBody(data);
    case 'component':
      return componentBody(data);
    case 'pcba':
      return pcbaBody(data);
    case 'breakout':
      return mouldBody(data);
    case 'subassembly':
      return { width: Math.max(NODE_BASE_WIDTH.subassembly, widest(data.rows.map((row) => pinRowWidth(row, BOX.rowPadX)))), height: BOX.bodyPadY * 2 + data.rows.length * BOX.row + data.groups.length * BOX.sideLabel };
  }
}

/* ------------------------------------------------------------------ *
 * The board node (real artwork)
 * ------------------------------------------------------------------ */

/** `.cs-board-head`, as numbers: one row — chip, id, part number, revision. */
export const BOARD_HEAD = {
  padLeft: 8,
  padRight: 9,
  chip: 16,
  gap: 7,
  /** `.cs-board-head .cs-instance` */
  idFont: 10.5,
  /** `.cs-board-head .cs-title` (semibold: a little wider than regular) */
  titleFont: 11.5,
  semibold: 1.06,
  /** `.cs-board-head .cs-meta` */
  metaFont: 10,
} as const;

/** What the board header prints on its right: the revision. */
export function boardHeadMeta(data: PcbaNodeData): string {
  return data.revision ?? '';
}

/** What the wire header prints on its right: the cut length. */
export function wireHeadMeta(data: Pick<SegmentNodeData, 'lengthMm'>): string {
  return data.lengthMm === undefined ? '' : `${data.lengthMm} mm`;
}

/**
 * The width an artwork header (board or wire: chip, id, title, meta — the
 * `.cs-board-head` rules) needs to show its title whole.
 */
export function artHeadWidth(instanceId: string, title: string, meta: string): number {
  return (
    BOARD_HEAD.padLeft +
    BOARD_HEAD.chip +
    BOARD_HEAD.gap +
    monoWidth(instanceId, BOARD_HEAD.idFont) +
    BOARD_HEAD.gap +
    textWidth(title, BOARD_HEAD.titleFont) * BOARD_HEAD.semibold +
    (meta === '' ? 0 : BOARD_HEAD.gap * 2 + monoWidth(meta, BOARD_HEAD.metaFont)) +
    BOARD_HEAD.padRight
  );
}

function boardHeadWidth(data: PcbaNodeData): number {
  return artHeadWidth(data.instanceId, data.title, boardHeadMeta(data));
}

/**
 * A wire node drawn as its two cut ends. Exact: the art is at least as wide
 * as the header (`derive` asks `wireArt` for that), the shell is given the
 * width, header and art area fixed heights.
 */
function wireNodeSize(art: NonNullable<SegmentNodeData['wire']>): NodeSize {
  return {
    width: Math.ceil((art.width + BOX.border * 2) / 2) * 2,
    height: Math.ceil(BOX.border * 2 + WIRE_LAYOUT.head + art.height),
  };
}

/**
 * A board node drawn as its artwork. Both numbers are exact: the shell is
 * given the width, the header and art area fixed heights.
 */
function boardNodeSize(data: PcbaNodeData & { board: NonNullable<PcbaNodeData['board']> }): NodeSize {
  const wanted = Math.max(BOARD_LAYOUT.minWidth, boardHeadWidth(data), data.board.width);
  return {
    width: Math.ceil(wanted / 2) * 2,
    height: Math.ceil(BOX.border * 2 + BOARD_LAYOUT.head + data.board.height),
  };
}

/**
 * A free-standing connector drawn as itself: the art header, then the drawing
 * centred in an area at least `NODE_BASE_WIDTH.connector` wide. Exact, like
 * the board's: the shell is given both numbers.
 */
export function connectorArtLayout(instanceId: string, title: string, art: ConnectorArt): ConnectorArtLayout {
  const base = NODE_BASE_WIDTH.connector;
  const wanted = Math.max(base, artHeadWidth(instanceId, title, ''), art.width + CONNECTOR_LAYOUT.padX * 2);
  const node = Math.ceil(Math.min(wanted, base * WIDTH_HEADROOM) / 2) * 2;
  const width = node - BOX.border * 2;
  return {
    art,
    width,
    height: Math.ceil(art.height + CONNECTOR_LAYOUT.padY * 2),
    // a face is centred; a profile sits against the side its lugs face
    ox:
      art.view === 'profile'
        ? art.facing === 'right'
          ? width - art.width - CONNECTOR_LAYOUT.padX
          : CONNECTOR_LAYOUT.padX
        : Math.round(((width - art.width) / 2) * 100) / 100,
    oy: CONNECTOR_LAYOUT.padY,
  };
}

/** The header thumbnail of a connector's face and its toggle (`.cs-conn-thumb`), in px. */
export const CONNECTOR_THUMB = { width: 54, height: 22, toggle: 18 } as const;

/** A connector drawn as itself: its dock, or header plus art area. */
function connectorArtNodeSize(data: ConnectorNodeData & { art: ConnectorArtLayout }): NodeSize {
  if (data.dock !== undefined) return { width: data.art.width, height: data.art.height };
  return {
    width: data.art.width + BOX.border * 2,
    height: Math.ceil(BOX.border * 2 + BOARD_LAYOUT.head + data.art.height),
  };
}

/**
 * The box this node draws as, in flow units — width exact (the shell is given
 * it), height estimated a hair generously.
 *
 * Widths are clamped into `[base, base × WIDTH_HEADROOM]`: a part whose pin
 * labels are prose does not get to be a 900px node, it gets ellipses, which is
 * what the CSS already promises.
 */
export function estimateNodeSize(data: EditorNodeData): NodeSize {
  if (data.kind === 'pcba' && data.board !== undefined) {
    return boardNodeSize({ ...data, board: data.board });
  }
  if (data.kind === 'segment' && data.wire !== undefined) return wireNodeSize(data.wire);
  if (data.kind === 'connector' && data.art !== undefined && (data.dock !== undefined || data.face === true)) return connectorArtNodeSize({ ...data, art: data.art });
  const heading = nodeHeading(data);
  const body = bodySize(data);
  const base = NODE_BASE_WIDTH[data.kind];
  // a connector's header also holds its face thumbnail and the face toggle
  const thumb = data.kind === 'connector' && data.art !== undefined ? CONNECTOR_THUMB.width + CONNECTOR_THUMB.toggle + BOX.headGapX * 2 : 0;
  const wanted = Math.max(base, headWidth(heading, data.instanceId) + thumb, body.width);
  return {
    width: Math.ceil(Math.min(wanted, base * WIDTH_HEADROOM) / 2) * 2,
    height: Math.ceil(BOX.border * 2 + headHeight(heading) + body.height + BOX.slack),
  };
}

/* ------------------------------------------------------------------ *
 * Rectangles — what the layout keeps apart, and what its test checks
 * ------------------------------------------------------------------ */

export function nodeRect(id: string, position: { x: number; y: number }, data: EditorNodeData): NodeRect {
  const size = estimateNodeSize(data);
  return { id, x: position.x, y: position.y, ...size };
}

/** Do two boxes share any area? Touching edges do not count as overlapping. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Every pair of boxes that collide — empty is the whole point. */
export function overlappingPairs(rects: readonly NodeRect[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a !== undefined && b !== undefined && rectsOverlap(a, b)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
