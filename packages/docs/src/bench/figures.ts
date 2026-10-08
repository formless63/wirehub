/**
 * The bench build sheet's drawings: every one a picture
 * of something on the bench, never a box with lines in it.
 *
 * - `boardFigure` — a board's real faces (the gerber art and the build's
 *   parts, the same artwork the canvas and schematic draw, turned so the
 *   cable row faces the wire), each landing drawn as a wire in its own colour
 *   from the pad out to a numbered label, in soldering order; jumpers ringed
 *   with their state.
 * - `faceFigure` — a connector's solder-side face (the drawing sheet's
 *   traced/drawn faces) with the same numbered landings on its pins.
 * - `stripFigure` — one end of one segment as it leaves the jacket: every
 *   core to its number, every braid twist to its pad, what is cut back.
 *
 * All output is SVG in millimetres (1 unit = 1 mm on paper), deterministic,
 * self-contained. Wires are drawn only between two real points — a pad and
 * its label — so nothing on these sheets connects nothing.
 */

import { endName } from '@wirehub/model';
import {
  boardFaces,
  resolveDepiction,
  rotationTransform,
  type DepictionSource,
  type FacePad,
  type FacePlan,
} from '@wirehub/layout';
import { DEPICTION_STYLESHEET, conductorPaint, inlineVectorAsset, renderBoardParts } from '@wirehub/render-svg';
import type { BoardPart } from '@wirehub/catalog';

import { faceArtMarkup } from '../drawing/render.ts';
import type { FaceArt, FaceBridge, PinState } from '../drawing/index.ts';
import { escapeHtml } from '../text.ts';
import type { BoardFace, Landing, SegmentEnd, StripRow, Termination } from './model.ts';

/* ------------------------------------------------------------------ *
 * SVG plumbing
 * ------------------------------------------------------------------ */

const r2 = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

const INK = '#14181d';
const MUTED = '#5b6570';
const SCREEN = '#7c848c';
const ACCENT = '#c2602a';
const LIGHT = new Set(['white', 'yellow']);

function txt(x: number, y: number, value: string, size: number, opts: { anchor?: 'start' | 'middle' | 'end'; bold?: boolean; fill?: string; cls?: string } = {}): string {
  return `<text x="${r2(x)}" y="${r2(y)}" font-size="${r2(size)}"${opts.anchor === undefined || opts.anchor === 'start' ? '' : ` text-anchor="${opts.anchor}"`}${
    opts.bold === true ? ' font-weight="700"' : ''
  }${opts.fill === undefined ? '' : ` fill="${opts.fill}"`}${opts.cls === undefined ? '' : ` class="${opts.cls}"`}>${escapeHtml(value)}</text>`;
}

/** Every rule of a flat stylesheet under `.cs-svg`, so an inline drawing cannot restyle its host. */
function scopeCss(css: string): string {
  return css
    .split('}')
    .map((rule) => rule.trim())
    .filter((rule) => rule !== '')
    .map((rule) => {
      const brace = rule.indexOf('{');
      const selector = rule.slice(0, brace).trim();
      return `${selector
        .split(',')
        .map((part) => `.cs-svg ${part.trim()}`)
        .join(',')}{${rule.slice(brace + 1)}}`;
    })
    .join('');
}

const FIGURE_CSS = scopeCss(
  '.bf-t{font-family:Helvetica,Arial,sans-serif;fill:#14181d}' +
    '.bf-num{font-family:Helvetica,Arial,sans-serif;font-weight:700;dominant-baseline:central;text-anchor:middle}' +
    DEPICTION_STYLESHEET,
);

function svgDoc(width: number, height: number, body: string, cls: string, label: string): string {
  const style = FIGURE_CSS;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="cs-svg ${cls}" viewBox="0 0 ${r2(width)} ${r2(height)}" width="${r2(width)}mm" height="${r2(height)}mm" role="img" aria-label="${escapeHtml(label)}"><style>${style}</style><g class="bf-t">${body}</g></svg>`;
}

/** A numbered landing marker: open at the pad, solid at the label. */
export function marker(x: number, y: number, n: number, solid: boolean, r = 2): string {
  return `<g class="bf-marker" data-n="${n}"><circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(r)}" fill="${solid ? INK : '#ffffff'}" stroke="${INK}" stroke-width="0.35"/>${txt(x, y + 0.05, String(n), r * 1.15, {
    cls: 'bf-num',
    fill: solid ? '#ffffff' : INK,
  })}</g>`;
}

/** A wire in its conductor colour (pale ones haloed), or a braid twist in screen grey. */
function wirePath(d: string, landing: Pick<Landing, 'element'>): string {
  const el = landing.element;
  if (el.kind === 'core') {
    const paint = conductorPaint(el.colour);
    const halo = el.colour !== undefined && LIGHT.has(el.colour.toLowerCase());
    return `${halo ? `<path d="${d}" fill="none" stroke="#3a4048" stroke-width="1.05" stroke-linejoin="round"/>` : ''}<path d="${d}" fill="none" stroke="${paint}" stroke-width="${halo ? 0.7 : 0.8}" stroke-linejoin="round"/>`;
  }
  // screens: a twisted grey bundle — two offset dashes read as a twist
  return `<path d="${d}" fill="none" stroke="${SCREEN}" stroke-width="1.3" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#c9cdd2" stroke-width="0.5" stroke-dasharray="0.9 0.9" stroke-linejoin="round"/>`;
}

/** What a landing label says: `Red → R`, `R, G, B braids + drain → GND (H9)`. */
export function landingWords(landing: Landing): { head: string; sub: string } {
  const el = landing.element;
  const t = landing.target;
  const where =
    t.kind === 'pcba'
      ? `${t.terminal}${t.pad !== undefined && t.pad !== t.terminal && (el.kind !== 'core' || /^(GND|H)\d/i.test(t.pad)) ? ` (${t.pad})` : ''}`
      : t.kind === 'connector'
        ? `${t.instance} pin ${t.terminal}`
        : `${t.instance}.${t.terminal}`;
  const head = `${el.name} → ${where}`;
  const sub =
    el.kind === 'core'
      ? [t.label !== undefined && t.label !== t.terminal ? t.label : undefined, el.label].filter((s) => s !== undefined).join(' · ')
      : el.kind === 'pigtail'
        ? el.mass
          ? 'one ground connection from the whole copper mass'
          : 'braids trimmed ~80 %, twisted together'
        : 'braid, on its own';
  return { head, sub };
}

/* ------------------------------------------------------------------ *
 * Lanes: labels in pad order, never overlapping
 * ------------------------------------------------------------------ */

function spreadLanes(ys: readonly number[], pitch: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = new Array<number>(ys.length).fill(0);
  let last = -Infinity;
  const placed: number[] = [];
  for (const { y } of order) {
    const at = Math.max(y, last + pitch, min);
    placed.push(at);
    last = at;
  }
  // pull the stack back up if it ran off the bottom
  const over = (placed[placed.length - 1] ?? 0) - max;
  if (over > 0) for (let i = 0; i < placed.length; i += 1) placed[i] = Math.max(min + i * pitch, (placed[i] as number) - over);
  order.forEach(({ i }, k) => {
    out[i] = placed[k] as number;
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Board figure
 * ------------------------------------------------------------------ */

export interface BoardFigure {
  svg: string;
  /** the landings drawn on the art (the rest go in the text list) */
  drawn: Set<number>;
  jumpers: { ref: string; state: string }[];
  fitted: { ref: string; label?: string }[];
}

const FIG_W = 180;
const LABEL_W = 70;
const LANE = 4.9;

interface Placed {
  landing: Landing;
  pad: { x: number; y: number };
  slot?: { x: number; y: number };
}

/**
 * One board, both faces stacked, landings numbered. `cableSide` is where the
 * wire comes from on the page (the source end's board sits left of its
 * cable, the destination's right of it — the way the owner's sheets read).
 */
export function boardFigure(term: Termination, source: DepictionSource | undefined, cableSide: 'left' | 'right'): BoardFigure | undefined {
  if (source === undefined || term.kind !== 'pcba') return undefined;
  const resolution = resolveDepiction(source, 'pcba', term.def, []);
  const dep = resolution.depiction;
  if (dep === undefined) return undefined;
  const onBoard = term.landings.filter((l) => l.target.kind === 'pcba' && l.target.connectorSide !== true);

  if (dep.board === undefined) return singleViewFigure(term, source, dep, onBoard, cableSide);

  const board = dep.board;
  const terminals = new Set(Object.keys(board.pads));
  const { faces, pads } = boardFaces(board, cableSide, terminals);
  const order: BoardFace[] = [];
  for (const l of onBoard) if (l.face !== undefined && !order.includes(l.face)) order.push(l.face);
  for (const side of ['top', 'bottom'] as const) if (!order.includes(side)) order.push(side);

  const maxW = Math.max(faces.top.size.width, faces.bottom.size.width);
  const maxH = Math.max(faces.top.size.height, faces.bottom.size.height);
  const artW = FIG_W - LABEL_W - 24;
  const k = Math.min(artW / maxW, 50 / maxH, 7.5);
  const boardX = cableSide === 'right' ? 6 + (artW - maxW * k) / 2 : LABEL_W + 18 + (artW - maxW * k) / 2;
  const labelX = cableSide === 'right' ? FIG_W - LABEL_W : 0;

  const body: string[] = [];
  const drawn = new Set<number>();
  const jumpers: { ref: string; state: string }[] = [];
  const fitted: { ref: string; label?: string }[] = [];
  let y = 2;

  for (const side of order) {
    const plan = faces[side];
    const landings = onBoard.filter((l) => (l.face ?? 'top') === side);
    const rowsNeeded = Math.max(landings.length * LANE, plan.size.height * k) + 8;
    const top = y + 6;
    const ox = boardX + ((maxW - plan.size.width) * k) / 2;
    const oy = top;
    const caption = side === 'top' ? 'TOP' : 'BOTTOM · seen from below';
    body.push(txt(cableSide === 'right' ? boardX : boardX + maxW * k, y + 3, caption, 2.6, { bold: true, fill: MUTED, anchor: cableSide === 'right' ? 'start' : 'end' }));
    body.push(faceArt(term, source, dep.defId, plan, board.frame, ox, oy, k));

    // jumpers ringed, with their state
    for (const part of plan.parts) {
      if (part.kind === 'jumper') {
        if (!jumpers.some((j) => j.ref === part.ref)) jumpers.push({ ref: part.ref, state: part.state === 'bridged' ? 'bridged' : part.state === 'open' ? 'open' : 'unset' });
        body.push(jumperRing(part, ox, oy, k));
      } else if (!fitted.some((f) => f.ref === part.ref)) {
        fitted.push({ ref: part.ref, ...(part.label === undefined ? {} : { label: part.label }) });
      }
    }

    const placed: Placed[] = [];
    for (const landing of landings) {
      const pad = findPad(pads, landing, side);
      if (pad === undefined) continue;
      placed.push({
        landing,
        pad: { x: ox + pad.x * k, y: oy + pad.y * k },
        ...(pad.slot === undefined ? {} : { slot: { x: ox + pad.slot.x * k, y: oy + pad.slot.y * k } }),
      });
    }
    const lanes = spreadLanes(
      placed.map((p) => (p.slot ?? p.pad).y),
      LANE,
      top + 2,
      top + rowsNeeded - 6,
    );
    const boardEdge = cableSide === 'right' ? ox + plan.size.width * k : ox;
    const dir = cableSide === 'right' ? 1 : -1;
    placed.forEach((p, i) => {
      const lane = lanes[i] as number;
      const from = p.slot ?? p.pad;
      const bend1 = boardEdge + dir * (4 + i * 0.9);
      const bend2 = cableSide === 'right' ? labelX - 8 : labelX + LABEL_W + 8;
      const end = cableSide === 'right' ? labelX - 3 : labelX + LABEL_W + 3;
      const x1 = cableSide === 'right' ? Math.max(bend1, from.x + 2) : Math.min(bend1, from.x - 2);
      const d = [
        `M${r2(p.pad.x)} ${r2(p.pad.y)}`,
        ...(p.slot === undefined ? [] : [`L${r2(p.slot.x)} ${r2(p.slot.y)}`]),
        `L${r2(x1)} ${r2(from.y)}`,
        `L${r2(bend2)} ${r2(lane)}`,
        `L${r2(end)} ${r2(lane)}`,
      ].join('');
      body.push(`<g class="bf-landing" data-n="${p.landing.n}" data-face="${side}">${wirePath(d, p.landing)}${marker(p.pad.x, p.pad.y, p.landing.n, false, 1.5)}</g>`);
      body.push(labelAt(p.landing, labelX, lane, cableSide));
      drawn.add(p.landing.n);
    });
    y = top + rowsNeeded;
  }
  const height = y + 2;
  return {
    svg: svgDoc(FIG_W, height, body.join(''), 'cs-bench-fig', `${term.label}: landings`),
    drawn,
    jumpers: jumpers.sort((a, b) => a.ref.localeCompare(b.ref, 'en')),
    fitted,
  };
}

function findPad(pads: readonly FacePad[], landing: Landing, side: BoardFace): FacePad | undefined {
  const mine = pads.filter((p) => p.terminal === landing.target.terminal && p.side === side);
  if (landing.target.pad !== undefined) {
    const exact = mine.find((p) => p.ref === landing.target.pad);
    if (exact !== undefined) return exact;
  }
  return mine.find((p) => p.index === 0) ?? mine[0];
}

function faceArt(term: Termination, source: DepictionSource, defId: string, plan: FacePlan, frame: { width: number; height: number }, ox: number, oy: number, k: number): string {
  const artwork = source.artwork(defId, plan.view);
  if (artwork?.kind !== 'vector' || artwork.source === undefined) return '';
  const inner = inlineVectorAsset(artwork.source, `dep-bs-${term.instance}-${plan.side}-`);
  const turn = rotationTransform(frame, plan.rotation);
  const parts = renderBoardParts(plan.parts, { labels: true, labelSize: Math.round((1.5 / k) * 1000) / 1000 });
  return (
    `<g class="depiction" transform="translate(${r2(ox)} ${r2(oy)}) scale(${r2(k)})${turn === '' ? '' : ` ${turn}`}">${inner}</g>` +
    (parts === '' ? '' : `<g class="depiction" transform="translate(${r2(ox)} ${r2(oy)}) scale(${r2(k)})">${parts}</g>`)
  );
}

function jumperRing(part: BoardPart, ox: number, oy: number, k: number): string {
  const xs = part.outline.map((p) => ox + p[0] * k);
  const ys = part.outline.map((p) => oy + p[1] * k);
  const x0 = Math.min(...xs) - 1.2;
  const y0 = Math.min(...ys) - 1.2;
  const w = Math.max(...xs) - Math.min(...xs) + 2.4;
  const h = Math.max(...ys) - Math.min(...ys) + 2.4;
  const state = part.state === 'bridged' ? 'bridged' : part.state === 'open' ? 'open' : 'unset';
  return `<g class="bf-jumper" data-ref="${escapeHtml(part.ref)}" data-state="${state}"><rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(w)}" height="${r2(h)}" rx="1" fill="none" stroke="${ACCENT}" stroke-width="0.45"${
    state === 'bridged' ? '' : ' stroke-dasharray="1 0.7"'
  }/></g>`;
}

function labelAt(landing: Landing, labelX: number, lane: number, cableSide: 'left' | 'right'): string {
  const { head, sub } = landingWords(landing);
  const mx = cableSide === 'right' ? labelX + 1 : labelX + LABEL_W - 1;
  const tx = cableSide === 'right' ? labelX + 4.4 : labelX + LABEL_W - 4.4;
  const anchor = cableSide === 'right' ? 'start' : 'end';
  return `<g class="bf-label" data-n="${landing.n}">${marker(mx, lane, landing.n, true, 2)}${txt(tx, lane + 0.1, head, 2.5, { bold: true, anchor })}${
    sub === '' ? '' : txt(tx, lane + 2.5, sub, 1.9, { fill: MUTED, anchor })
  }</g>`;
}

/** A board whose artwork is one view (no gerber pair): the view, its anchors, the same numbered landings. */
function singleViewFigure(
  term: Termination,
  source: DepictionSource,
  dep: NonNullable<ReturnType<typeof resolveDepiction>['depiction']>,
  onBoard: readonly Landing[],
  cableSide: 'left' | 'right',
): BoardFigure | undefined {
  const artwork = source.artwork(dep.defId, dep.view);
  if (artwork === undefined) return undefined;
  const w = dep.widthUnits * dep.mmPerUnit;
  const h = dep.heightUnits * dep.mmPerUnit;
  const artW = FIG_W - LABEL_W - 24;
  const k = Math.min(artW / w, 80 / h, 7.5) * dep.mmPerUnit;
  const ox = cableSide === 'right' ? 6 : LABEL_W + 18;
  const oy = 6;
  const inner =
    artwork.kind === 'raster'
      ? artwork.dataUri === undefined
        ? ''
        : `<image href="${artwork.dataUri}" x="0" y="0" width="${r2(dep.widthUnits)}" height="${r2(dep.heightUnits)}" preserveAspectRatio="none"/>`
      : inlineVectorAsset(artwork.source ?? '', `dep-bs-${term.instance}-`);
  const body: string[] = [`<g class="depiction" transform="translate(${r2(ox)} ${r2(oy)}) scale(${r2(k)})">${inner}</g>`];
  const labelX = cableSide === 'right' ? FIG_W - LABEL_W : 0;
  const placed = onBoard
    .map((landing) => ({ landing, anchor: dep.anchors[landing.target.terminal] }))
    .filter((p): p is { landing: Landing; anchor: NonNullable<typeof p.anchor> } => p.anchor !== undefined);
  const lanes = spreadLanes(placed.map((p) => oy + p.anchor.y * k), LANE, oy, Math.max(oy + h * k, oy + placed.length * LANE));
  const drawn = new Set<number>();
  placed.forEach((p, i) => {
    const px = ox + p.anchor.x * k;
    const py = oy + p.anchor.y * k;
    const lane = lanes[i] as number;
    const edge = cableSide === 'right' ? ox + w * k + 4 + i * 0.9 : ox - 4 - i * 0.9;
    const end = cableSide === 'right' ? labelX - 3 : labelX + LABEL_W + 3;
    const d = `M${r2(px)} ${r2(py)}L${r2(edge)} ${r2(py)}L${r2(edge + (cableSide === 'right' ? 6 : -6))} ${r2(lane)}L${r2(end)} ${r2(lane)}`;
    body.push(`<g class="bf-landing" data-n="${p.landing.n}">${wirePath(d, p.landing)}${marker(px, py, p.landing.n, false, 1.5)}</g>`);
    body.push(labelAt(p.landing, labelX, lane, cableSide));
    drawn.add(p.landing.n);
  });
  const height = Math.max(oy + h * k, (lanes[lanes.length - 1] ?? 0) + 4) + 4;
  return { svg: svgDoc(FIG_W, height, body.join(''), 'cs-bench-fig', `${term.label}: landings`), drawn, jumpers: [], fitted: [] };
}

/* ------------------------------------------------------------------ *
 * Connector face figure
 * ------------------------------------------------------------------ */

/** Points (the drawing sheet's unit) to millimetres. */
const PT = 25.4 / 72;

export interface FaceSource {
  art: FaceArt;
  pins: Readonly<Record<string, PinState>>;
  traced: boolean;
  bridges?: readonly FaceBridge[];
  /** printed under the face: `Solder side` */
  caption: string;
}

/**
 * A connector's face (solder side) drawn large, with a numbered landing on
 * each pin a wire reaches and a label column on the cable side.
 */
export function faceFigure(term: Termination, face: FaceSource, cableSide: 'left' | 'right', maxHeight = 70): BoardFigure {
  const art = face.art;
  const artW = FIG_W - LABEL_W - 24;
  const k = Math.min(artW / art.width, maxHeight / art.height, 1.9 * PT);
  const w = art.width * k;
  const h = art.height * k;
  const ox = cableSide === 'right' ? 6 + (artW - w) / 2 : LABEL_W + 18 + (artW - w) / 2;
  const oy = 8;
  const body: string[] = [
    `<g class="bf-face" transform="translate(${r2(ox)} ${r2(oy)}) scale(${r2(k)})">${faceArtMarkup(art, face.pins, face.traced, face.bridges ?? [])}</g>`,
    txt(ox + w / 2, oy + h + 5, face.caption, 2.6, { anchor: 'middle', fill: MUTED, bold: true }),
  ];
  const labelX = cableSide === 'right' ? FIG_W - LABEL_W : 0;
  const placed = term.landings
    .map((landing) => ({ landing, pin: art.pins.find((p) => p.id === landing.target.terminal) }))
    .filter((p): p is { landing: Landing; pin: NonNullable<typeof p.pin> } => p.pin !== undefined);
  const lanes = spreadLanes(placed.map((p) => oy + p.pin.y * k), LANE, 3, Math.max(oy + h, 3 + placed.length * LANE));
  const drawn = new Set<number>();
  placed.forEach((p, i) => {
    const px = ox + p.pin.x * k;
    const py = oy + p.pin.y * k;
    const lane = lanes[i] as number;
    const edge = cableSide === 'right' ? ox + w + 3 + i * 0.8 : ox - 3 - i * 0.8;
    const end = cableSide === 'right' ? labelX - 3 : labelX + LABEL_W + 3;
    const d = `M${r2(px)} ${r2(py)}L${r2(edge)} ${r2(lane)}L${r2(end)} ${r2(lane)}`;
    body.push(`<g class="bf-landing" data-n="${p.landing.n}">${wirePath(d, p.landing)}${marker(px, py, p.landing.n, false, 1.5)}</g>`);
    body.push(labelAt(p.landing, labelX, lane, cableSide));
    drawn.add(p.landing.n);
  });
  const height = Math.max(oy + h + 8, (lanes[lanes.length - 1] ?? 0) + 5);
  return { svg: svgDoc(FIG_W, height, body.join(''), 'cs-bench-fig', `${term.label}: landings`), drawn, jumpers: [], fitted: [] };
}

/* ------------------------------------------------------------------ *
 * Strip figure — one segment end as it leaves the jacket
 * ------------------------------------------------------------------ */

const STRIP_W = 112;
const STRIP_ROW = 5;

function stripRowsOrdered(end: SegmentEnd): { row: StripRow; group?: { n?: number; pigtail: string; rows: StripRow[] } }[] {
  const landed = end.rows.filter((r) => r.treatment.kind === 'land').sort((a, b) => (a.treatment as { n: number }).n - (b.treatment as { n: number }).n);
  const twists = new Map<string, StripRow[]>();
  for (const row of end.rows) {
    if (row.treatment.kind === 'twist') twists.set(row.treatment.pigtail, [...(twists.get(row.treatment.pigtail) ?? []), row]);
  }
  const cut = end.rows.filter((r) => r.treatment.kind === 'cut');
  const through = end.rows.filter((r) => r.treatment.kind === 'through');
  const out: { row: StripRow; group?: { n?: number; pigtail: string; rows: StripRow[] } }[] = [...landed, ...through].map((row) => ({ row }));
  const groups = [...twists.entries()].sort((a, b) => ((a[1][0]?.treatment as { n?: number }).n ?? 999) - ((b[1][0]?.treatment as { n?: number }).n ?? 999));
  for (const [pigtail, rows] of groups) {
    const n = (rows[0]?.treatment as { n?: number }).n;
    out.push({ row: rows[0] as StripRow, group: { ...(n === undefined ? {} : { n }), pigtail, rows } });
  }
  for (const row of cut) out.push({ row });
  return out;
}

function cutGlyph(x: number, y: number): string {
  return `<path d="M${r2(x - 0.9)} ${r2(y - 1.6)}L${r2(x + 0.3)} ${r2(y + 1.6)}M${r2(x + 0.3)} ${r2(y - 1.6)}L${r2(x + 1.5)} ${r2(y + 1.6)}" stroke="#8f1d1d" stroke-width="0.35" fill="none"/>`;
}

/**
 * One segment end: the jacket on the cable side, each core leaving it in its
 * colour to its landing number, each braid twist as one grey bundle, cut-back
 * elements stubbed with a cut mark. `cableSide` matches the board figure.
 */
export function stripFigure(end: SegmentEnd, cableSide: 'left' | 'right'): string {
  const rows = stripRowsOrdered(end);
  const top = 7;
  const height = top + rows.length * STRIP_ROW + 3;
  const jacketX = cableSide === 'right' ? STRIP_W - 14 : 0;
  const jacketEdge = cableSide === 'right' ? jacketX : 14;
  const dir = cableSide === 'right' ? -1 : 1;
  const body: string[] = [];
  body.push(`<rect x="${r2(jacketX)}" y="${r2(top - 2)}" width="14" height="${r2(rows.length * STRIP_ROW + 2)}" rx="2" fill="#1e2126"/>`);
  body.push(txt(jacketX + 7, top - 3.2, 'jacket', 2.1, { anchor: 'middle', fill: MUTED }));
  rows.forEach(({ row, group }, i) => {
    const y = top + i * STRIP_ROW + STRIP_ROW / 2 - 1;
    const el = row.element;
    const t = row.treatment;
    const stubEnd = jacketEdge + dir * (t.kind === 'cut' ? 5 : 26);
    const labelX = jacketEdge + dir * 29.5;
    const anchor = cableSide === 'right' ? 'end' : 'start';
    if (group !== undefined) {
      const d = `M${r2(jacketEdge)} ${r2(y)}L${r2(stubEnd)} ${r2(y)}`;
      body.push(wirePath(d, { element: { kind: 'pigtail', id: group.pigtail, members: [], mass: row.mass !== undefined, name: '' } }));
      const braids = group.rows.filter((r) => r.element.kind !== 'drain').map((r) => r.element.name.replace(/ braid$/, ''));
      const drain = group.rows.some((r) => r.element.kind === 'drain');
      const words = row.mass !== undefined ? `Shield mass (${row.mass} copper screens)` : `${braids.join(', ')} braid${braids.length === 1 ? '' : 's'}${drain ? ' + drain' : ''}`;
      if (group.n !== undefined) body.push(marker(stubEnd, y, group.n, true, 1.9));
      body.push(txt(labelX, y + 1, `${words} — twist`, 2.9, { anchor }));
      return;
    }
    if (t.kind === 'through') {
      // uncut: the conductor carries straight on through the mould
      const paint = el.kind === 'core' ? conductorPaint(el.colour) : SCREEN;
      body.push(`<path d="M${r2(jacketEdge)} ${r2(y)}L${r2(stubEnd)} ${r2(y)}" stroke="${paint}" stroke-width="0.8"${el.kind === 'core' ? '' : ' stroke-dasharray="1 0.6"'}/>`);
      body.push(txt(labelX, y + 1, `${el.name} — through the mould, uncut → ${t.to}`, 2.6, { anchor }));
      return;
    }
    if (t.kind === 'cut') {
      const paint = el.kind === 'core' ? conductorPaint(el.colour) : SCREEN;
      body.push(`<path d="M${r2(jacketEdge)} ${r2(y)}L${r2(stubEnd)} ${r2(y)}" stroke="${paint}" stroke-width="0.8"${el.kind === 'drain' ? ' stroke-dasharray="0.8 0.5"' : ''}/>`);
      body.push(cutGlyph(stubEnd + dir * 1, y));
      body.push(txt(labelX, y + 1, `${el.name} — cut back: ${t.why}`, 2.6, { anchor, fill: MUTED }));
      return;
    }
    // a landed core (or a screen landed on its own)
    const landing = { element: el.kind === 'core' ? { kind: 'core' as const, path: el.path, name: el.name, ...(el.colour === undefined ? {} : { colour: el.colour }), shielded: el.shielded } : { kind: 'screen' as const, path: el.path, name: el.name } };
    body.push(wirePath(`M${r2(jacketEdge)} ${r2(y)}L${r2(stubEnd)} ${r2(y)}`, landing));
    if (el.kind === 'core' && el.shielded) {
      // the coax's own jacket and trimmed braid, then the stripped dielectric
      const bx = jacketEdge + dir * 3;
      body.push(`<rect x="${r2(Math.min(bx, bx + dir * 4))}" y="${r2(y - 0.8)}" width="4" height="1.6" fill="none" stroke="${SCREEN}" stroke-width="0.3" stroke-dasharray="0.4 0.3"/>`);
      const dx = jacketEdge + dir * 17;
      body.push(`<rect x="${r2(Math.min(dx, dx + dir * 5))}" y="${r2(y - 0.55)}" width="5" height="1.1" fill="#f4f4f0" stroke="#b9bcc0" stroke-width="0.2"/>`);
    }
    if (t.kind === 'land') body.push(marker(stubEnd, y, t.n, true, 1.9));
    body.push(txt(labelX, y + 1, el.name, 2.9, { anchor }));
  });
  return svgDoc(STRIP_W, height, body.join(''), 'cs-bench-strip', `${end.segment} ${endName(end.end)}: strip plan`);
}

/* ------------------------------------------------------------------ *
 * Breakout figure — a trunk end that splits into single-signal plugs
 * ------------------------------------------------------------------ */

export interface BreakoutPlug {
  term: Termination;
  /** a premade plug fitted by the contract manufacturer: the line only passes through the mould */
  moulded: boolean;
  /** `jr Video R BNC` */
  name: string;
}

/**
 * The owner's breakout drawing, bench-side: the trunk into the overmould, a
 * lead out to each plug. Plugs the contract manufacturer moulds on are
 * **pass-through** (the core and its braid run out to the plug); a jack set in
 * the mould is **terminated** inside it — each with its landings.
 */
export function breakoutFigure(plugs: readonly BreakoutPlug[], jack: BreakoutPlug | undefined, cableSide: 'left' | 'right'): string {
  const lead = 9.5;
  const top = 8;
  const mouldH = Math.max(plugs.length * lead + 6, 28);
  const mouldW = 34;
  const mouldX = cableSide === 'right' ? FIG_W - 30 - mouldW : 30;
  const body: string[] = [];
  const dirOut = cableSide === 'right' ? -1 : 1;
  const inEdge = cableSide === 'right' ? mouldX + mouldW : mouldX;
  const outEdge = cableSide === 'right' ? mouldX : mouldX + mouldW;
  const cy = top + mouldH / 2;
  body.push(`<rect x="${r2(cableSide === 'right' ? inEdge : inEdge - 26)}" y="${r2(cy - 4)}" width="26" height="8" rx="2" fill="#1e2126"/>`);
  body.push(txt(cableSide === 'right' ? inEdge + 13 : inEdge - 13, cy + 7.5, 'trunk', 2.2, { anchor: 'middle', fill: MUTED }));
  body.push(`<rect x="${r2(mouldX)}" y="${r2(top)}" width="${mouldW}" height="${r2(mouldH)}" rx="3" fill="#3a3f46" stroke="#14181d" stroke-width="0.4"/>`);
  body.push(txt(mouldX + mouldW / 2, top - 2, 'overmould', 2.4, { anchor: 'middle', bold: true, fill: MUTED }));
  plugs.forEach((plug, i) => {
    const y = top + 3 + i * lead + lead / 2;
    const core = plug.term.landings.find((l) => l.element.kind === 'core');
    const x2 = outEdge + dirOut * 24;
    const d = `M${r2(outEdge)} ${r2(y)}L${r2(x2)} ${r2(y)}`;
    body.push(core === undefined ? `<path d="${d}" stroke="${SCREEN}" stroke-width="1.2"/>` : wirePath(d, core));
    const px = cableSide === 'right' ? x2 - 9 : x2;
    body.push(`<rect x="${r2(px)}" y="${r2(y - 2.4)}" width="9" height="4.8" rx="1" fill="#d7dade" stroke="#14181d" stroke-width="0.35"/>`);
    const labelX = cableSide === 'right' ? x2 - 11 : x2 + 11;
    const anchor = cableSide === 'right' ? 'end' : 'start';
    const what = plug.term.landings.map((l) => `${l.n} ${l.element.name} → ${l.target.terminal}`).join(' · ');
    body.push(txt(labelX, y - 0.3, `${plug.name}${plug.moulded ? ' — pass-through, moulded plug' : ''}`, 2.4, { anchor, bold: true }));
    body.push(txt(labelX, y + 2.4, what, 1.9, { anchor, fill: MUTED }));
    const n = plug.term.landings[0]?.n;
    if (n !== undefined) body.push(marker(cableSide === 'right' ? x2 - 4.5 : x2 + 4.5, y, n, true, 1.6));
  });
  if (jack !== undefined) {
    const jy = top + mouldH - 6;
    const jx = mouldX + mouldW / 2;
    body.push(`<circle cx="${r2(jx)}" cy="${r2(jy)}" r="3.2" fill="#ffffff" stroke="#14181d" stroke-width="0.4"/><circle cx="${r2(jx)}" cy="${r2(jy)}" r="1.2" fill="#14181d"/>`);
    const words = jack.term.landings.map((l) => `${l.n} ${l.element.name} → ${l.target.terminal}`).join(' · ');
    body.push(txt(jx, top + mouldH + 4.5, `${jack.name} — terminated in the mould`, 2.4, { anchor: 'middle', bold: true }));
    body.push(txt(jx, top + mouldH + 7.4, words, 1.9, { anchor: 'middle', fill: MUTED }));
  }
  const height = top + mouldH + (jack === undefined ? 4 : 10);
  return svgDoc(FIG_W, height, body.join(''), 'cs-bench-fig', 'breakout');
}
