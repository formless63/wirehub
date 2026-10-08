/**
 * The drawing sheet on paper, landscape, on any paper size (`frame/paper.ts`):
 * the shared WireHub frame (border, title block, revision table, state stamp:
 * `frame/`) cut to the paper, and the composition — BOM table, cable and
 * connector faces, wire table, remarks — drawn on one fixed grid and fitted
 * uniformly into what the frame leaves, so the sheet reads the same on A4,
 * Letter or A3. The grid is the owner's Illustrator layout (measured off
 * `racc/sample-schematics`): the BOM table, wire-table rows and remark column
 * sit where the hand-drawn ones do.
 *
 * Set in IBM Plex: Sans for words, Mono for identifiers (designators, pin
 * names, the part number), 0.5 pt hairlines for tables.
 *
 * Same house rules as the rest of the package: deterministic string output,
 * no external resources (the logo and the cutaway are inlined), no script.
 */

import type { CableDesign, Db } from '@wirehub/model';

import { escapeHtml } from '../text.ts';
import { registeredTitleBlock } from './assets.ts';
import { cutawayFor } from './cutaway.ts';
import { brandFontFaces, brandStack, brandWidth } from './brand-font.ts';
import { gothic, sans, sansBold } from './fonts.generated.ts';
import { framedSvg, frameSpecFor, framePage, pageSizeCss, PLEX_MONO_STACK, PLEX_SANS_STACK, fitText, plexFontFaceCss, plexWidth, type FrameExtras, type PaperId, type RevisionRow, type TitleBlockStandard } from '../frame/index.ts';
import { faceEdgeTop, faceEdgeX, type FaceArt, type FacePin } from './faces.ts';
import {
  GROUND_FILL,
  UNUSED_FILL,
  deriveDrawing,
  type Drawing,
  type Breakout,
  type DrawingFace,
  type DrawingMeta,
  type FaceBridge,
  type DrawingPlug,
  type PinState,
  type WireRow,
} from './model.ts';

/** the composition's own grid, pt: the sheet it was measured on (US Letter landscape) */
export const SHEET_WIDTH = 792;
export const SHEET_HEIGHT = 612;

/** the stacks, with the hub's own typeface first when branding set one */
const fontStack = (): string => brandStack(PLEX_SANS_STACK);
const monoStack = (): string => PLEX_MONO_STACK;

/* ------------------------------------------------------------------ *
 * Text metrics — the embedded faces' own advance widths
 *
 * The sheet carries its fonts (`fonts.generated.ts`: Liberation Sans, metric-
 * compatible with Helvetica, and TeX Gyre Adventor for the BOM table), so the
 * widths used to centre, right-align and wrap here are the widths of the face
 * that actually prints — on any machine, with or without Helvetica.
 * ------------------------------------------------------------------ */

type Face = 'sans' | 'mono';

/**
 * Width of `text` at `size` in the bundled Liberation faces (the hub's typeface first when branding
 * set one): the faces the formboard's vector PDF embeds, so the formboard measures with these.
 * The drawing sheet is set in IBM Plex and measures with `plexMeasure`.
 */
export function textWidth(text: string, size: number, bold = false, face: 'sans' | 'gothic' = 'sans'): number {
  const widths = face === 'gothic' ? gothic.widths : bold ? sansBold.widths : sans.widths;
  let units = 0;
  for (const ch of text) units += brandWidth(ch, bold) ?? widths[ch] ?? 556;
  return (units / 1000) * size;
}

/** Width of `text` at `size` in IBM Plex (the hub's typeface first when branding set one), without headroom. */
function plexMeasure(text: string, size: number, bold = false, face: Face = 'sans'): number {
  return plexWidth(text, size, face === 'mono' ? 'mono' : bold ? 'semi' : 'sans', 0, 1);
}

/** A hair of headroom for kerning and rasterisation, nothing more. */
function roomy(text: string, size: number, bold = false, face: Face = 'sans'): number {
  return plexMeasure(text, size, bold, face) * 1.02;
}

function fontFaces(): string {
  // Plex first; the Liberation faces stay as the fallback for glyphs Plex's Latin subset lacks (arrows, the ohm sign)
  return (
    brandFontFaces() +
    plexFontFaceCss() +
    [sans, sansBold]
      .map(
        (face) =>
          `@font-face{font-family:'${face.family}';font-weight:${face.weight};font-style:normal;src:url(data:font/woff2;base64,${face.woff2}) format('woff2')}`,
      )
      .join('')
  );
}

function wrap(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && roomy(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/* ------------------------------------------------------------------ *
 * SVG helpers
 * ------------------------------------------------------------------ */

function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function esc(value: string): string {
  return escapeHtml(value);
}

type Anchor = 'start' | 'middle' | 'end';

/** The rights line as the title block's three centred rows: broken at spaces so each row fits, the rest dropped never (the last row takes it). */
function rightsRows(line: string | undefined): string[] {
  const rows = ['', '', ''];
  if (line === undefined) return rows;
  let at = 0;
  for (const word of line.split(/\s+/).filter((w) => w !== '')) {
    const next = rows[at] === '' ? word : `${rows[at]} ${word}`;
    if (next.length > 34 && at < 2 && rows[at] !== '') {
      at += 1;
      rows[at] = word;
    } else rows[at] = next;
  }
  return rows;
}

function text(x: number, y: number, value: string, size: number, options: { anchor?: Anchor; bold?: boolean; family?: string; fill?: string; fit?: number; mono?: boolean } = {}): string {
  const anchor = options.anchor ?? 'start';
  const face: Face = options.mono === true ? 'mono' : 'sans';
  let fontSize = size;
  if (options.fit !== undefined) {
    const width = roomy(value, size, options.bold, face);
    if (width > options.fit) fontSize = Math.max(6, (size * options.fit) / width);
  }
  const family = options.mono === true ? monoStack() : options.family;
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-size="${n(fontSize)}"`,
    ...(anchor === 'start' ? [] : [`text-anchor="${anchor}"`]),
    ...(options.bold === true ? ['font-weight="600"'] : []),
    ...(family === undefined ? [] : [`font-family="${esc(family)}"`]),
    ...(options.fill === undefined ? [] : [`fill="${options.fill}"`]),
  ];
  return `<text ${attrs.join(' ')}>${esc(value)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, width = 0.5, extra = ''): string {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#000" stroke-width="${n(width)}"${extra}/>`;
}

const DASH: Readonly<Record<WireRow['line'], string>> = {
  shielded: '12.15 3.04',
  plain: '3 3',
};

/* ------------------------------------------------------------------ *
 * The composition's box (pt): everything the sheet draws sits inside it; the
 * shared frame (`frame/`) owns the border, the title block and the stamp
 * ------------------------------------------------------------------ */

const FRAME = { x: 13.4, y: 10.5, right: 780, bottom: 601.1 };
/** the composition's own bottom edge: where the title block began on the grid it was measured on */
const TB = { top: 508.9 };

/* ------------------------------------------------------------------ *
 * BOM table (top right)
 * ------------------------------------------------------------------ */

const BOM_COLS = [449.7, 477.3, 579.3, 745.5, 780];
const BOM_TOP = 10.5;
const BOM_HEADER = 15;
const BOM_ROW = 17.3;
const BOM_TEXT = 9;
const BOM_PITCH = BOM_TEXT * 1.2;
const BOM_PAD = 5;

/**
 * The BOM table. Each cell is set at its own size and wraps to the lines it
 * needs (a long material wraps, up to three lines, and only then shrinks), so
 * no text is squeezed or runs out of its cell; the row grows to hold them.
 */
function bomTable(drawing: Drawing): { svg: string; bottom: number } {
  const out: string[] = [];
  const [c0, c1, c2, c3, c4] = BOM_COLS as [number, number, number, number, number];
  const cell = (value: string, width: number, kind: 'sans' | 'mono', lines: number) => fitText(value, width - 2 * BOM_PAD, BOM_TEXT, kind, lines);
  const rows = drawing.bom.map((row) => {
    const ref = cell(row.reference, c2 - c1, 'mono', 2);
    const material = cell(row.material, c3 - c2, 'sans', 3);
    const count = Math.max(ref.lines.length, material.lines.length);
    return { row, ref, material, height: Math.max(BOM_ROW, BOM_PAD * 1.6 + count * BOM_PITCH) };
  });
  const bottom = BOM_TOP + BOM_HEADER + rows.reduce((sum, r) => sum + r.height, 0);
  out.push(`<rect x="${n(c0)}" y="${n(BOM_TOP)}" width="${n(c4 - c0)}" height="${n(bottom - BOM_TOP)}" fill="#fff" stroke="none"/>`);
  for (const cx of BOM_COLS) out.push(line(cx, BOM_TOP, cx, bottom, 0.5));
  out.push(line(c0, BOM_TOP, c4, BOM_TOP, 0.5));
  let y = BOM_TOP + BOM_HEADER;
  out.push(line(c0, y, c4, y, 0.5));
  const head = { bold: true, anchor: 'middle' as const };
  const hy = BOM_TOP + BOM_HEADER - 4.6;
  out.push(text((c0 + c1) / 2, hy, '#', 8.5, head));
  out.push(text((c1 + c2) / 2, hy, 'Reference', 8.5, head));
  out.push(text((c2 + c3) / 2, hy, 'Material', 8.5, head));
  out.push(text((c3 + c4) / 2, hy, 'QTY.', 8.5, head));
  for (const { row, ref, material, height } of rows) {
    const base = y + BOM_PAD + BOM_TEXT * 0.8;
    out.push(text((c0 + c1) / 2, base, String(row.n), BOM_TEXT, { mono: true, anchor: 'middle' }));
    ref.lines.forEach((l, i) => out.push(text(c1 + BOM_PAD, base + i * BOM_PITCH, l, ref.size, { mono: true })));
    material.lines.forEach((l, i) => out.push(text(c2 + BOM_PAD, base + i * BOM_PITCH, l, material.size)));
    out.push(text((c3 + c4) / 2, base, row.qty, BOM_TEXT, { mono: true, anchor: 'middle' }));
    y += height;
    out.push(line(c0, y, c4, y, 0.5));
  }
  return { svg: `<g class="ra-bom">${out.join('')}</g>`, bottom };
}

/* ------------------------------------------------------------------ *
 * Faces and the cable between them
 * ------------------------------------------------------------------ */

const CABLE_Y = 320.5;
const CABLE_HALF = 15;

interface Placed {
  x: number;
  y: number;
  face: DrawingFace;
}

function placeFace(face: DrawingFace, side: 'a' | 'b'): Placed {
  const { width, height, labels } = face.face;
  const y = CABLE_Y - height / 2;
  // corner pin numbers can hang outside the artwork (the PS "12"); keep them
  // inside the frame
  const overhangLeft = Math.max(0, ...labels.map((l) => roomy(l.text, 10) / 2 - l.x));
  const overhangRight = Math.max(0, ...labels.map((l) => l.x + roomy(l.text, 10) / 2 - width));
  if (side === 'a') {
    const x = width < 100 ? 89 - width / 2 : 25;
    return { x: Math.max(x, FRAME.x + 6 + overhangLeft), y, face };
  }
  const x = width < 100 ? 690 - width / 2 : 752 - width;
  return { x: Math.min(x, FRAME.right - 6 - overhangRight - width), y, face };
}

function artPath(path: FaceArt['art'][number], override?: { fill?: string; stroke?: string }): string {
  const fill = override?.fill ?? path.fill ?? 'none';
  const stroke = override?.stroke ?? path.stroke ?? 'none';
  const attrs = [
    `d="${path.d}"`,
    `fill="${fill}"`,
    ...(path.evenOdd === true ? ['fill-rule="evenodd"'] : []),
    `stroke="${stroke}"`,
    ...(stroke === 'none' ? [] : [`stroke-width="${n(path.width ?? 1)}"`]),
  ];
  return `<path ${attrs.join(' ')}/>`;
}

/**
 * A part fitted by hand across two pins (the bare SCART's 180 Ω, 8 → 16):
 * leads rise from each pin's top edge to a run above the face, with the part
 * on the run and its designator and value over it. Drawn in face coordinates.
 */
function bridgeSvg(art: FaceArt, bridge: FaceBridge): string {
  const a = art.pins.find((p) => p.id === bridge.from);
  const b = art.pins.find((p) => p.id === bridge.to);
  if (a === undefined || b === undefined) return '';
  const topOf = (pin: FacePin): number => pin.y - pin.h / 2;
  const runY = Math.min(topOf(a), topOf(b), 0) - 12;
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const mid = (left.x + right.x) / 2;
  const bodyW = Math.min(18, Math.max(10, (right.x - left.x) * 0.45));
  const bodyH = 6;
  const out: string[] = [];
  out.push(
    `<path d="M${n(left.x)} ${n(topOf(left))}V${n(runY)}H${n(mid - bodyW / 2)}M${n(mid + bodyW / 2)} ${n(runY)}H${n(right.x)}V${n(topOf(right))}" fill="none" stroke="#000" stroke-width="0.9"/>`,
  );
  for (const pin of [left, right]) out.push(`<circle cx="${n(pin.x)}" cy="${n(topOf(pin))}" r="1.3" fill="#000"/>`);
  if (bridge.kind === 'capacitor') {
    out.push(`<path d="M${n(mid - 1.5)} ${n(runY - 5)}V${n(runY + 5)}M${n(mid + 1.5)} ${n(runY - 5)}V${n(runY + 5)}" stroke="#000" stroke-width="1.2"/>`);
    out.push(`<path d="M${n(mid - bodyW / 2)} ${n(runY)}H${n(mid - 1.5)}M${n(mid + 1.5)} ${n(runY)}H${n(mid + bodyW / 2)}" stroke="#000" stroke-width="0.9"/>`);
  } else {
    // IEC resistor: a plain rectangle
    out.push(`<rect x="${n(mid - bodyW / 2)}" y="${n(runY - bodyH / 2)}" width="${n(bodyW)}" height="${n(bodyH)}" fill="#fff" stroke="#000" stroke-width="0.9"/>`);
  }
  out.push(text(mid, runY - bodyH / 2 - 2.5, bridge.label, 7.5, { anchor: 'middle' }));
  return `<g class="ra-bridge">${out.join('')}</g>`;
}

function pinFill(state: PinState | undefined): string {
  if (state === undefined) return UNUSED_FILL;
  return state.kind === 'signal' ? state.color : state.kind === 'ground' ? GROUND_FILL : UNUSED_FILL;
}

/** one pin, filled by what lands on it, in face coordinates */
function pinSvg(pin: FacePin, fill: string): string {
  if (pin.shape === 'circle') {
    return `<circle cx="${n(pin.x)}" cy="${n(pin.y)}" r="${n(Math.min(pin.w, pin.h) / 2 - 0.5)}" fill="${fill}" stroke="#070606" stroke-width="1"/>`;
  }
  if (pin.shape === 'ring') {
    // a sleeve end-on: the band between two circles, both outlined
    const ro = Math.min(pin.w, pin.h) / 2 - 0.5;
    const ri = (pin.inner ?? 0) / 2 + 0.5;
    const circle = (r: number): string =>
      `M${n(pin.x - r)} ${n(pin.y)}a${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0Z`;
    return `<path d="${circle(ro)}${circle(ri)}" fill="${fill}" fill-rule="evenodd" stroke="#070606" stroke-width="1"/>`;
  }
  return `<rect x="${n(pin.x - pin.w / 2 + 0.5)}" y="${n(pin.y - pin.h / 2 + 0.5)}" width="${n(pin.w - 1)}" height="${n(pin.h - 1)}" fill="${fill}" stroke="#000" stroke-width="1"/>`;
}

/** Room under a face for its designator, subtitle and any approximation note. */
function faceFooter(art: FaceArt): number {
  return art.approximate === undefined ? 28 : 45;
}

function faceSvg(placed: Placed): string {
  const { face, x, y } = placed;
  const art = face.face;
  const out: string[] = [];
  out.push(`<g class="ra-face" transform="translate(${n(x)} ${n(y)})">`);
  // an opaque backing in the silhouette of the outline, so the cable lines
  // that run in to the face's centre disappear under it
  const outline = art.art[0];
  if (outline !== undefined) out.push(artPath(outline, { fill: '#fff', stroke: 'none' }));
  for (const path of art.art) out.push(artPath(path));
  for (const pin of art.pins) out.push(pinSvg(pin, pinFill(face.pins[pin.id])));
  for (const label of art.labels) out.push(text(label.x, label.y, label.text, face.traced ? 10 : 6.5, { anchor: 'middle' }));
  for (const bridge of face.bridges) out.push(bridgeSvg(art, bridge));
  const cx = art.width / 2;
  out.push(text(cx, art.height + 15, face.port.designator, 14, { mono: true, anchor: 'middle' }));
  out.push(text(cx, art.height + 25.5, art.subtitle ?? 'Solder Side', 8, { anchor: 'middle' }));
  // the face is the family's general shape, not a mechanical drawing
  if (art.approximate !== undefined) {
    out.push(`<g class="ra-approximate">${text(cx, art.height + 33.5, art.approximate, 6.5, { anchor: 'middle', fill: '#444' })}</g>`);
  }
  out.push('</g>');
  return out.join('');
}

/**
 * A face's own artwork — outline, pins filled by what lands on them, corner
 * pin numbers, hand-fitted bridges — in the face's own coordinates, with no
 * designator underneath. The bench build sheet draws it large and puts its
 * numbered landings over it.
 */
export function faceArtMarkup(art: FaceArt, pins: Readonly<Record<string, PinState>>, traced: boolean, bridges: readonly FaceBridge[] = []): string {
  const out: string[] = [];
  const outline = art.art[0];
  if (outline !== undefined) out.push(artPath(outline, { fill: '#fff', stroke: 'none' }));
  for (const path of art.art) out.push(artPath(path));
  for (const pin of art.pins) out.push(pinSvg(pin, pinFill(pins[pin.id])));
  for (const label of art.labels) out.push(text(label.x, label.y, label.text, traced ? 10 : 6.5, { anchor: 'middle' }));
  for (const bridge of bridges) out.push(bridgeSvg(art, bridge));
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * Secondary plugs, in side view
 *
 * Each traced plug says which way its business end points and where its lead
 * leaves it. On the sheet a plug always points *away* from the cable — left on
 * the P1 side, right on the far side — so the art is mirrored where it points
 * the other way (the RCA is traced pointing right). Its letters (T R S) are
 * set upright either way.
 * ------------------------------------------------------------------ */

interface Oriented {
  art: FaceArt;
  mirror: boolean;
  /** drawn at this scale (a tall stack of whips shrinks to keep the cutaway clear) */
  k: number;
  /** drawn size, pt */
  width: number;
  height: number;
  /** where the lead leaves, in the drawn (mirrored, scaled) frame */
  exit: { x: number; y: number; dir: 'left' | 'right' | 'down' };
}

function orient(art: FaceArt, side: 'a' | 'b', k = 1): Oriented {
  const geometry = art.plug ?? { tip: 'left' as const, lead: { x: art.width, y: art.height / 2, dir: 'right' as const } };
  const mirror = (side === 'a' && geometry.tip === 'right') || (side === 'b' && geometry.tip === 'left');
  const { lead } = geometry;
  const dir = !mirror || lead.dir === 'down' ? lead.dir : lead.dir === 'left' ? 'right' : 'left';
  return {
    art,
    mirror,
    k,
    width: art.width * k,
    height: art.height * k,
    exit: { x: (mirror ? art.width - lead.x : lead.x) * k, y: lead.y * k, dir },
  };
}

/** The plug's art at (x, y): its paths (a pin-tagged one in its wire's colour) and its letters. */
function plugArtSvg(plug: DrawingPlug, o: Oriented, x: number, y: number): string {
  const { art } = o;
  const out: string[] = [];
  const scale = o.k === 1 ? '' : ` scale(${n(o.k)})`;
  const flip = o.mirror ? ` scale(-1 1) translate(${n(-art.width)} 0)` : '';
  out.push(`<g class="ra-plug" data-ref="${esc(plug.port.designator)}" transform="translate(${n(x)} ${n(y)})${scale}${flip}">`);
  const outline = art.art.find((path) => path.stroke !== undefined && path.stroke !== null && path.fill === undefined);
  if (outline !== undefined) out.push(artPath(outline, { fill: '#fff', stroke: 'none' }));
  for (const path of art.art) {
    const pin = path.pin === undefined ? undefined : plug.pins[path.pin];
    out.push(pin === undefined || pin.kind === 'unused' ? artPath(path) : artPath(path, { fill: pinFill(pin) }));
  }
  out.push('</g>');
  // the letters stay upright and full size
  for (const label of art.labels) {
    out.push(text(x + (o.mirror ? art.width - label.x : label.x) * o.k, y + label.y * o.k, label.text, 10, { anchor: 'middle' }));
  }
  return out.join('');
}

/** Two parallel lines — a lead's outline — as one path, from a list of runs. */
function leadPath(runs: string[]): string {
  return `<path d="${runs.join('')}" fill="none" stroke="#000" stroke-width="1"/>`;
}

const LEAD_HALF = 7;

/** Clear air under a whip plug: its designator, and its T R S letters over the next one down. */
function plugGap(o: Oriented): number {
  return o.art.labels.length > 0 ? 34 : 24;
}

/**
 * The lowest the cutaway can end (top-left, at its smallest), plus air: a
 * stack of plugs taller than the room under it — or, on the far side, under
 * the BOM table — is drawn smaller.
 */
const CUTAWAY_FLOOR = 45 + 131 * 0.6 + 10;

function ceilingOf(side: 'a' | 'b', bomBottom: number): number {
  return side === 'a' ? CUTAWAY_FLOOR : Math.max(CUTAWAY_FLOOR, bomBottom + 10);
}

interface PlugLayout {
  svg: string;
  /** the top of everything drawn (letters included) */
  top: number;
}

/**
 * Whips: plugs on leads into their side's face, as the owner's HD15 and
 * the source device 1 sheets draw them — the plug above the face, its lead leaving the
 * plug's back and turning down into the hood, the lead length beside it.
 * Plugs on one lead (a 2×RCA whip) stack, their tails joining the lead.
 */
function whipsSvg(plugs: DrawingPlug[], side: 'a' | 'b', anchor: Placed, ceiling: number): PlugLayout {
  const out: string[] = [];
  const face = anchor.face.face;
  const faceTop = (x: number): number => anchor.y + faceEdgeTop(face, x - anchor.x);
  const dirOut = side === 'a' ? 1 : -1; // toward the cable's middle
  // plugs on one lead are one group; groups stack upward from the face
  const groups: DrawingPlug[][] = [];
  for (const plug of plugs.filter((p) => p.mounted !== true)) {
    const key = plug.port.leadSegment;
    const group = key === undefined ? undefined : groups.find((g) => g[0]?.port.leadSegment === key);
    if (group === undefined) groups.push([plug]);
    else group.push(plug);
  }
  // shrink the lot when the stack would not fit under the cutaway
  const natural = groups.flat().reduce((sum, plug) => {
    const o = orient(plug.art, side);
    return sum + o.height + plugGap(o);
  }, 0);
  const room = anchor.y - 36 - ceiling + 24;
  const k = natural <= room ? 1 : Math.max(0.7, room / natural);

  let top = Infinity;
  let floor = anchor.y - 36;
  groups.forEach((group, g) => {
    const oriented = group.map((plug) => orient(plug.art, side, k));
    const leadMm = group[0]?.port.leadMm;
    const label = leadMm === undefined ? '' : `${leadMm} MM`;
    const labelRoom = label === '' ? 0 : 6 + roomy(label, 14);
    const down = oriented.every((o) => o.exit.dir === 'down');
    // the lead column lands on the face's inner part, clear of the frame
    let column = down
      ? side === 'a'
        ? anchor.x + face.width * 0.62
        : anchor.x + face.width * 0.38
      : side === 'a'
        ? anchor.x + face.width * 0.62 + 22 + g * 22
        : anchor.x + face.width * 0.38 - 22 - g * 22;
    // a plug too wide for the room beside the frame pushes the column inward
    if (!down) {
      for (const o of oriented) {
        column =
          side === 'a' ? Math.max(column, FRAME.x + 8 + o.exit.x + 22) : Math.min(column, FRAME.right - 8 - (o.width - o.exit.x) - 22);
      }
    }
    column =
      side === 'a'
        ? Math.min(column, FRAME.right - 8 - labelRoom - LEAD_HALF)
        : Math.max(column, FRAME.x + 8 + labelRoom + LEAD_HALF);
    // stack the group's plugs upward, bottom plug first
    const placed: { plug: DrawingPlug; o: Oriented; x: number; y: number }[] = [];
    let bottom = floor;
    for (let i = group.length - 1; i >= 0; i -= 1) {
      const plug = group[i]!;
      const o = oriented[i]!;
      const y = bottom - o.height;
      const x = down ? column - o.exit.x : side === 'a' ? column - 22 - o.exit.x : column + 22 - o.exit.x;
      placed.unshift({ plug, o, x, y });
      bottom = y - plugGap(o);
    }
    const runs: string[] = [];
    if (down) {
      for (const { o, x, y } of placed) {
        const ex = x + o.exit.x;
        const ey = y + o.exit.y;
        runs.push(`M${n(ex - LEAD_HALF)} ${n(ey)}V${n(faceTop(ex - LEAD_HALF))}M${n(ex + LEAD_HALF)} ${n(ey)}V${n(faceTop(ex + LEAD_HALF))}`);
      }
    } else {
      // outer line: from the top plug's upper edge round the corner and down;
      // inner line: stepping down past each plug's tail
      const inner = column - dirOut * LEAD_HALF;
      const outer = column + dirOut * LEAD_HALF;
      placed.forEach(({ o, x, y }, j) => {
        const ex = x + o.exit.x;
        const ey = y + o.exit.y;
        if (j === 0) runs.push(`M${n(ex)} ${n(ey - LEAD_HALF)}H${n(outer)}V${n(faceTop(outer))}`);
        else runs.push(`M${n(ex)} ${n(ey - LEAD_HALF)}H${n(inner)}`);
        runs.push(`M${n(ex)} ${n(ey + LEAD_HALF)}H${n(inner)}`);
        const next = placed[j + 1];
        const to = next === undefined ? faceTop(inner) : next.y + next.o.exit.y - LEAD_HALF;
        runs.push(`M${n(inner)} ${n(ey + LEAD_HALF)}V${n(to)}`);
      });
    }
    out.push(leadPath(runs));
    for (const { plug, o, x, y } of placed) {
      out.push(plugArtSvg(plug, o, x, y));
      // the designator under the plug, towards its business end
      const tipward = side === 'a' ? 0.62 : 0.38;
      out.push(text(x + o.width * tipward, y + o.height + 15, plug.port.designator, 14, { mono: true, anchor: 'middle' }));
      top = Math.min(top, y - (o.art.labels.length > 0 ? 12 : 2));
    }
    const first = placed[0];
    if (first !== undefined && label !== '') {
      const ex = down ? first.x + first.o.exit.x : column;
      const ly = down ? (first.y + first.o.exit.y + faceTop(ex)) / 2 + 5 : first.y + first.o.exit.y + 5;
      out.push(text(ex + dirOut * (LEAD_HALF + 6), ly, label, 14, { anchor: side === 'a' ? 'start' : 'end' }));
    }
    const highest = placed[0];
    if (highest !== undefined) floor = highest.y - plugGap(highest.o) - 8;
  });
  // jacks in the hood (the light-gun leg): end-on, sitting on the face's shoulder
  plugs
    .filter((p) => p.mounted === true)
    .forEach((plug, i) => {
      const art = plug.art;
      const cx = side === 'a' ? anchor.x + face.width * 0.82 - i * (art.width + 30) : anchor.x + face.width * 0.18 + i * (art.width + 30);
      const x = cx - art.width / 2;
      const y = faceTop(cx) - art.height - 4;
      const g: string[] = [`<g class="ra-jack" data-ref="${esc(plug.port.designator)}" transform="translate(${n(x)} ${n(y)})">`];
      for (const path of art.art) g.push(artPath(path));
      for (const pin of art.pins) g.push(pinSvg(pin, pinFill(plug.pins[pin.id])));
      g.push('</g>');
      out.push(g.join(''));
      const tx = side === 'a' ? x + art.width + 4 : x - 4;
      const anchorText = side === 'a' ? 'start' : 'end';
      out.push(text(tx, y + art.height / 2 + 2, plug.port.designator, 14, { mono: true, anchor: anchorText }));
      out.push(text(tx, y + art.height / 2 + 12, 'Board-Mounted Jack', 8, { anchor: anchorText }));
      top = Math.min(top, y);
    });
  return { svg: `<g class="ra-lead">${out.join('')}</g>`, top };
}

/** The overmould box of a breakout, as the owner's BNC sheets place it (side b; mirrored for a). */
const BREAKOUT = { right: 590, width: 110, half: 21, stub: 36 };

function mirrorX(x: number, side: 'a' | 'b'): number {
  return side === 'b' ? x : FRAME.x + FRAME.right - x;
}

/**
 * A breakout end (the owner's HD15/SCART to BNC sheets): the trunk runs into
 * an overmould — "Overmold Breakout", with the embedded jack drawn in it — a
 * short broken-off lead leaves it, and the plugs stand in a row beside it,
 * each numbered, with the lead length to each written under them.
 */
function breakoutSvg(breakout: Breakout, side: 'a' | 'b', ceiling: number): { svg: string; inner: number; top: number; bottom: number } {
  const out: string[] = [];
  const outerEdge = mirrorX(BREAKOUT.right, side);
  const innerEdge = mirrorX(BREAKOUT.right - BREAKOUT.width, side);
  const dir = side === 'b' ? 1 : -1; // away from the cable's middle
  const boxX = Math.min(outerEdge, innerEdge);
  const top = CABLE_Y - BREAKOUT.half;
  out.push(`<rect class="ra-overmold" x="${n(boxX)}" y="${n(top)}" width="${BREAKOUT.width}" height="${BREAKOUT.half * 2}" fill="#fff" stroke="#000" stroke-width="1"/>`);
  const mid = boxX + BREAKOUT.width / 2;
  const kind = breakout.overmold ? 'Overmold Breakout' : 'Breakout';
  if (breakout.jack === undefined) {
    out.push(text(mid, top - 5, kind, 9.6, { anchor: 'middle' }));
  } else {
    out.push(text(mid, top - 14.6, kind, 9.6, { anchor: 'middle' }));
    out.push(text(mid, top - 5, `With Embedded ${breakout.jack.label} Jack`, 9.6, { anchor: 'middle' }));
    const jx = mid + dir * 20;
    out.push(`<circle cx="${n(jx)}" cy="${n(top + 13)}" r="9.7" fill="#fff" stroke="#000" stroke-width="1"/>`);
    if (breakout.jack.designator !== undefined) out.push(text(jx, top + 37, breakout.jack.designator, 14, { mono: true, anchor: 'middle' }));
  }
  // the lead leaving the far end, broken off
  const s0 = outerEdge;
  const s1 = outerEdge + dir * BREAKOUT.stub;
  const h = LEAD_HALF;
  out.push(
    `<path d="M${n(s0)} ${n(CABLE_Y - h)}H${n(s1)}C${n(s1 + dir * 3)} ${n(CABLE_Y - h + 3)} ${n(s1 - dir * 3)} ${n(CABLE_Y + h - 3)} ${n(s1)} ${n(CABLE_Y + h)}H${n(s0)}" fill="none" stroke="#000" stroke-width="1"/>`,
  );
  // the plugs: standing in a row (BNC), or stacked (plugs drawn lying down)
  let highest = top - (breakout.jack === undefined ? 14 : 24);
  const plugs = breakout.plugs;
  const upright = plugs.every((p) => p.art.plug?.tip === 'up');
  const noun = shortName(plugs[0]?.art.material ?? '');
  const caption = `${breakout.leadMm === undefined ? '' : `${breakout.leadMm} mm `}Breakout To Each ${noun}`.trim();
  if (upright) {
    const width = Math.max(...plugs.map((p) => p.art.width));
    const room = Math.abs(mirrorX(FRAME.right - 8, side) - (s1 + dir * 8));
    const pitch = plugs.length <= 1 ? 0 : Math.min(36, (room - width) / (plugs.length - 1));
    const rowWidth = (plugs.length - 1) * pitch + width;
    const start = side === 'b' ? Math.min(s1 + 8, FRAME.right - 8 - rowWidth) : Math.max(s1 - 8 - rowWidth, FRAME.x + 8);
    plugs.forEach((plug, i) => {
      const o = orient(plug.art, side);
      const x = start + i * pitch + (width - o.art.width) / 2;
      const y = CABLE_Y - 30 - o.art.height;
      out.push(plugArtSvg(plug, o, x, y));
      out.push(text(x + o.art.width / 2, CABLE_Y - 10.5, plug.port.designator, 14, { mono: true, anchor: 'middle' }));
      highest = Math.min(highest, y);
    });
    out.push(text(side === 'b' ? start : start + rowWidth, CABLE_Y + 9, caption, 9.6, { anchor: side === 'b' ? 'start' : 'end' }));
    // premade moulded plugs, fitted by the contract manufacturer
    if (plugs.length > 0 && plugs.every((p) => p.port.moulded === true)) {
      out.push(text(side === 'b' ? start : start + rowWidth, CABLE_Y + 20.5, `Moulded ${noun}s, CM Installed`, 9.6, { anchor: side === 'b' ? 'start' : 'end' }));
    }
  } else {
    // stacked at the sheet's edge, as the owner's S-Video sheets stack RCAs;
    // smaller when the stack would run up into what is above
    const natural = plugs.reduce((sum, plug) => sum + plug.art.height + 18, 0);
    const k = Math.min(1, Math.max(0.5, (CABLE_Y - 18 - ceiling) / natural));
    let bottom = CABLE_Y - 18;
    [...plugs].reverse().forEach((plug) => {
      const o = orient(plug.art, side, k);
      const x = side === 'b' ? FRAME.right - 8 - o.width : FRAME.x + 8;
      const y = bottom - o.height;
      out.push(plugArtSvg(plug, o, x, y));
      out.push(text(side === 'b' ? x + o.width - 14 : x + 14, y + o.height + 13, plug.port.designator, 14, { mono: true, anchor: 'middle' }));
      bottom = y - 18;
      highest = Math.min(highest, y);
    });
    out.push(text(side === 'b' ? s1 + 8 : s1 - 8, CABLE_Y + 22, caption, 9.6, { anchor: side === 'b' ? 'start' : 'end' }));
    if (plugs.length > 0 && plugs.every((p) => p.port.moulded === true)) {
      out.push(text(side === 'b' ? s1 + 8 : s1 - 8, CABLE_Y + 33.5, `Moulded ${noun}s, CM Installed`, 9.6, { anchor: side === 'b' ? 'start' : 'end' }));
    }
  }
  return { svg: `<g class="ra-breakout">${out.join('')}</g>`, inner: innerEdge, top: highest, bottom: CABLE_Y + BREAKOUT.half + 28 };
}

/** "Male BNC" → "BNC", "Male 3.5 MM TRS, 90°" → "3.5 MM TRS" */
function shortName(material: string): string {
  return material.replace(/^(Male|Female)\s+/i, '').replace(/,.*$/, '');
}

/** Top of the stacked length callouts over the cable (their cap height included). */
function lengthsTop(drawing: Drawing): number {
  return CABLE_Y - CABLE_HALF - 6.7 - Math.max(0, drawing.lengths.length - 1) * 16.8 - 11;
}

/** Where a stripped end's break sits, as on the owner's Stripped sheets. */
const STRIP_A = 176;
const STRIP_B = 616;

/**
 * The break symbol for a cable supplied stripped: a leaf-shaped loop at the
 * top and an S-curve down to the bottom line, with "Stripped / Per Photo"
 * beside it (`dir` 1 for the left end, -1 for the right).
 */
function strippedEnd(x0: number, dir: 1 | -1): string {
  const top = CABLE_Y - CABLE_HALF;
  const bottom = CABLE_Y + CABLE_HALF;
  const x = (dx: number): number => x0 - dir * dx;
  const d = [
    `M${n(x0)} ${n(top)}C${n(x(6))} ${n(top + 5)} ${n(x(6))} ${n(top + 12)} ${n(x(3))} ${n(top + 16)}`,
    `M${n(x0)} ${n(top)}C${n(x(-3))} ${n(top + 5)} ${n(x(-3))} ${n(top + 10)} ${n(x(3))} ${n(top + 16)}`,
    `C${n(x(7))} ${n(top + 20)} ${n(x(6))} ${n(top + 26)} ${n(x0)} ${n(bottom)}`,
  ].join('');
  const tx = x0 - dir * 15;
  const anchor = dir === 1 ? 'end' : 'start';
  return (
    `<path class="ra-stripped" d="${d}" fill="none" stroke="#000" stroke-width="1"/>` +
    text(tx, CABLE_Y - 0.1, 'Stripped', 10, { anchor }) +
    text(tx, CABLE_Y + 11.9, 'Per Photo', 10, { anchor })
  );
}

function cableAndFaces(drawing: Drawing, bomBottom: number): { svg: string; lowest: number; highest: number } {
  const out: string[] = [];
  const a = drawing.faces.a === undefined ? undefined : placeFace(drawing.faces.a, 'a');
  const b = drawing.faces.b === undefined ? undefined : placeFace(drawing.faces.b, 'b');
  const breakA = drawing.breakouts.a === undefined ? undefined : breakoutSvg(drawing.breakouts.a, 'a', ceilingOf('a', bomBottom));
  const breakB = drawing.breakouts.b === undefined ? undefined : breakoutSvg(drawing.breakouts.b, 'b', ceilingOf('b', bomBottom));
  // each outline line stops where it meets the face's own edge, as on the
  // owner's sheets — never at the face's centre
  const startAt = (y: number): number =>
    a === undefined ? (breakA?.inner ?? (drawing.stripped.a ? STRIP_A : 60)) : a.x + faceEdgeX(a.face.face, y - a.y, 'right');
  const endAt = (y: number): number =>
    b === undefined ? (breakB?.inner ?? (drawing.stripped.b ? STRIP_B : 732)) : b.x + faceEdgeX(b.face.face, y - b.y, 'left');
  if (drawing.stripped.a) out.push(strippedEnd(STRIP_A, 1));
  if (drawing.stripped.b) out.push(strippedEnd(STRIP_B, -1));
  for (const y of [CABLE_Y - CABLE_HALF, CABLE_Y + CABLE_HALF]) out.push(line(startAt(y), y, endAt(y), y, 1));
  const startX = startAt(CABLE_Y);
  const endX = endAt(CABLE_Y);
  if (a === undefined && breakA === undefined && !drawing.stripped.a) out.push(text(52, CABLE_Y + 4, 'NC', 10, { anchor: 'end' }));
  if (b === undefined && breakB === undefined && !drawing.stripped.b) out.push(text(740, CABLE_Y + 4, 'NC', 10));
  if (breakA !== undefined) out.push(breakA.svg);
  if (breakB !== undefined) out.push(breakB.svg);

  // length callouts, stacked so the last one sits just above the cable
  const lengths = drawing.lengths.map((v) =>
    v.suffix === ''
      ? `${v.mm} MM`
      : `${v.suffix} = ${v.overallMm === undefined ? `${v.mm} MM` : `${v.mm} (${v.overallMm} MM Overall)`}`,
  );
  const leftEdge = a === undefined ? startX : a.x + a.face.face.width;
  const rightEdge = b === undefined ? endX : b.x;
  const widest = Math.max(0, ...lengths.map((l) => plexMeasure(l, 14, false, 'mono')));
  const lx = (leftEdge + rightEdge) / 2 - widest / 2;
  lengths.forEach((l, i) => out.push(text(lx, CABLE_Y - CABLE_HALF - 6.7 - (lengths.length - 1 - i) * 16.8, l, 14, { mono: true })));

  const lowest = Math.max(
    a === undefined ? 0 : a.y + a.face.face.height + faceFooter(a.face.face),
    b === undefined ? 0 : b.y + b.face.face.height + faceFooter(b.face.face),
    breakA?.bottom ?? 0,
    breakB?.bottom ?? 0,
  );
  // plugs on leads first, so the lead runs in under the face outline
  const tops: number[] = [breakA?.top ?? Infinity, breakB?.top ?? Infinity];
  for (const side of ['a', 'b'] as const) {
    const anchor = side === 'a' ? a : b;
    const plugs = drawing.plugs.filter((plug) => plug.port.side === side);
    if (anchor === undefined || plugs.length === 0) continue;
    const layout = whipsSvg(plugs, side, anchor, ceilingOf(side, bomBottom));
    out.push(layout.svg);
    tops.push(layout.top);
  }
  if (a !== undefined) out.push(faceSvg(a));
  if (b !== undefined) out.push(faceSvg(b));
  // the top of the tallest thing drawn above the cable (a plug on its lead,
  // with its T R S letters), so the cutaway can keep clear of it
  const highest = Math.min(...tops);
  return { svg: `<g class="ra-cable">${out.join('')}</g>`, lowest, highest };
}

/* ------------------------------------------------------------------ *
 * Wire table and remarks
 * ------------------------------------------------------------------ */

const ROWS_TOP = 380.8;
const ROWS_BOTTOM = 497;
const ROW_PITCH = 16.5;

function wireTable(drawing: Drawing, top: number): string {
  const out: string[] = [];
  const count = drawing.rows.length;
  const start = Math.max(ROWS_TOP, top);
  const pitch = count <= 1 ? ROW_PITCH : Math.min(ROW_PITCH, (ROWS_BOTTOM - start) / (count - 1));
  drawing.rows.forEach((row, i) => {
    const y = start + i * pitch;
    out.push(text(198, y + 3.4, row.left, 10, { anchor: 'end', fit: 178, mono: true }));
    out.push(line(206, y, 516, y, 1, ` stroke-dasharray="${DASH[row.line]}"`));
    out.push(text(364, y - 4.3, row.name, 8, { anchor: 'middle' }));
    out.push(text(528, y + 3.4, row.right, 10, { fit: 100, mono: true }));
  });
  return `<g class="ra-wires">${out.join('')}</g>`;
}

function remarks(drawing: Drawing): string {
  const out: string[] = [];
  const size = 8.1;
  const lead = 9.6;
  const x = 633.1;
  const indent = 651.1;
  const width = FRAME.right - indent - 4;
  const lines: { number?: string; text?: string; sample?: WireRow['line'] }[] = [];
  drawing.remarks.forEach((remark, i) => {
    wrap(remark.text, size, width).forEach((t, j) => lines.push({ ...(j === 0 ? { number: `${i + 1}.` } : {}), text: t }));
    if (remark.line !== undefined) lines.push({ text: 'Line Type:', sample: remark.line });
  });
  const top = TB.top - 5.9 - lines.length * lead;
  out.push(text(x, top, 'REMARKS:', size));
  lines.forEach((l, i) => {
    const y = top + (i + 1) * lead;
    if (l.number !== undefined) out.push(text(x, y, l.number, size));
    if (l.text !== undefined) out.push(text(indent, y, l.text, size));
    if (l.sample !== undefined) {
      const sx = indent + roomy('Line Type: ', size);
      out.push(line(sx, y - 2.6, FRAME.right - 12, y - 2.6, 1, ` stroke-dasharray="${DASH[l.sample]}"`));
    }
  });
  return `<g class="ra-remarks">${out.join('')}</g>`;
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

export interface DrawingSvgOptions {
  /** a product photo for the top-left, as a data URI (png/jpeg) */
  photo?: string;
  /** the paper (default: the organisation's, else A4); the sheet is landscape */
  paper?: PaperId;
  /** the title-block layout (default: the organisation's, else the paper's convention) */
  titleBlock?: TitleBlockStandard;
  /** `RELEASED`, `UNRELEASED`, … (the title block's state, and the corner stamp) */
  state?: string;
  /** who checked it (the approver, when approvals are on) */
  checked?: string;
  /** the issuing organisation, when it is not the registered one */
  org?: string;
  /** the revision table: oldest first */
  revisions?: readonly RevisionRow[];
}

function cutaway(drawing: Drawing, bomBottom: number, hasPhoto: boolean, floor: number): string {
  if (drawing.trunkWire === undefined) return '';
  const art = cutawayFor(drawing.trunkWire, drawing.cutawayStyle);
  // where the sheets put it: right of the photo, under a short BOM — or top
  // left when there is no photo and the BOM runs long (the HD15/BNC sheets)
  const [x, y] = !hasPhoto && bomBottom > 91 ? [20, 45] : [240, Math.max(95, bomBottom + 4)];
  // shrink it when it would run in under the BOM table
  const overlapsBom = y < bomBottom;
  const room = BOM_COLS[0]! - 10 - x;
  // never run down into the length callouts over the cable
  const byWidth = overlapsBom && art.width > room ? room / art.width : 1;
  const byHeight = floor - y < art.height ? Math.max(0.6, (floor - y) / art.height) : 1;
  const scale = Math.min(byWidth, byHeight);
  return (
    `<clipPath id="ra-cutaway-clip"><rect width="${n(art.width)}" height="${n(art.height)}"/></clipPath>` +
    `<g class="ra-cutaway" data-source="${art.source}" transform="translate(${n(x)} ${n(y)})${scale === 1 ? '' : ` scale(${Math.round(scale * 1000) / 1000})`}" clip-path="url(#ra-cutaway-clip)">${art.body}</g>`
  );
}

/** The composition's own size on its grid, pt. */
const COMPOSITION = { width: FRAME.right - FRAME.x, height: TB.top - FRAME.y };

/** The title block's facts for a drawing: the drawing sidecar's, the sheet's state, the registered wording. */
function frameFor(drawing: Drawing, options: DrawingSvgOptions): Parameters<typeof frameSpecFor>[0] {
  const registered = registeredTitleBlock();
  const designer = drawing.designer === '' ? (registered.designer ?? '') : drawing.designer;
  const notes = registered.notes ?? ['ALL DIMENSIONS ARE', 'IN MM UNLESS', 'OTHERWISE SPECIFIED'];
  const extras: FrameExtras = {
    material: drawing.material === '' ? 'See BOM' : drawing.material,
    notes: [...notes, ...(registered.rights === undefined ? [] : [registered.rights])],
    tolerances: registered.tolerances ?? [
      ['x.xx', '± 0.1'],
      ['x.xxx', '± 0.03'],
      ['x.xxx', '± 0.005'],
      ['FRACTIONAL', '± 1/16'],
      ['ANGLE', '± 1°'],
    ],
  };
  return {
    kind: 'Drawing',
    title: drawing.title,
    orientation: 'landscape',
    ...(options.paper === undefined ? {} : { paper: options.paper }),
    ...(options.titleBlock === undefined ? {} : { standard: options.titleBlock }),
    ...(options.org === undefined ? {} : { org: options.org }),
    pn: drawing.partNumber,
    rev: drawing.revision,
    ...(options.state === undefined ? {} : { state: options.state }),
    drawn: designer,
    ...(options.checked === undefined ? {} : { checked: options.checked }),
    date: drawing.date,
    sheet: '1 of 1',
    ...(options.revisions === undefined || options.revisions.length === 0 ? {} : { revisions: options.revisions }),
    extras,
  };
}

export function drawingToSvg(drawing: Drawing, options: DrawingSvgOptions = {}): string {
  const bom = bomTable(drawing);
  const cable = cableAndFaces(drawing, bom.bottom);
  const composition = [
    options.photo === undefined
      ? ''
      : `<image x="19" y="15" width="207" height="206" preserveAspectRatio="xMinYMin meet" href="${esc(options.photo)}"/>`,
    cutaway(drawing, bom.bottom, options.photo !== undefined, Math.min(lengthsTop(drawing), cable.highest) - 4),
    bom.svg,
    cable.svg,
    wireTable(drawing, cable.lowest > 380 ? cable.lowest : ROWS_TOP),
    remarks(drawing),
  ].join('');
  const spec = frameSpecFor(frameFor(drawing, options));
  const sheet = framedSvg(
    spec,
    {
      markup: `<g class="ra-drawing" font-family="${esc(fontStack())}"><g transform="translate(${n(-FRAME.x)} ${n(-FRAME.y)})">${composition}</g></g>`,
      width: COMPOSITION.width,
      height: COMPOSITION.height,
    },
    { fonts: false, head: `<style>${fontFaces()}</style>` },
  );
  return sheet;
}

export interface DrawingSheetOptions extends DrawingSvgOptions {
  meta?: DrawingMeta;
  /** emit only the `<svg>` */
  fragment?: boolean;
}

/**
 * The drawing as a standalone, print-exact HTML document: the paper's landscape
 * page with no page margin, because the frame *is* the margin. On screen the
 * sheet scales to the width of the window, keeping the paper's proportion.
 */
export function renderDrawingSheet(design: CableDesign, db: Db, options: DrawingSheetOptions = {}): string {
  const drawing = deriveDrawing(design, db, options.meta);
  const svgOptions: DrawingSvgOptions = {
    ...options,
    ...(options.state === undefined && options.meta?.sheet?.status !== undefined ? { state: options.meta.sheet.status } : {}),
    ...(options.paper === undefined && options.meta?.sheet?.paper !== undefined ? { paper: options.meta.sheet.paper } : {}),
  };
  const svg = drawingToSvg(drawing, svgOptions);
  if (options.fragment === true) return svg;
  const spec = frameSpecFor(frameFor(drawing, svgOptions));
  const size = pageSizeCss(spec.paper, spec.orientation);
  const page = framePage(spec);
  const title = `${drawing.partNumber === '' ? design.id : drawing.partNumber} — ${drawing.title}`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    `@page{size:${size};margin:0}`,
    'html,body{margin:0;padding:0;background:#e9e9e9}',
    `.ra-page{max-width:${Math.round(page.width * 3.7795)}px;margin:0 auto;box-shadow:0 1px 6px rgba(0,0,0,.25);background:#fff;line-height:0}`,
    '.ra-page svg{width:100%;height:auto;display:block}',
    `@media print{html,body{background:#fff}.ra-page{max-width:none;margin:0;box-shadow:none}.ra-page svg{width:${page.width}mm;height:${page.height}mm}}`,
    '</style>',
    '</head>',
    '<body>',
    `<div class="ra-page">${svg}</div>`,
    '</body>',
    '</html>',
  ].join('');
}
