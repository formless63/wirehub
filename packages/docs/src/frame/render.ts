/**
 * Draw a `FrameGeometry`: as SVG (millimetres; the drawing, schematic, formboard
 * and label sheets) and as HTML (the flow documents: build sheet, BOM,
 * continuity spec). Both read the same geometry, so a title block measures the
 * same on every sheet. No external resource of any kind: the logo and the
 * faces are inlined.
 */

import { escapeHtml } from '../text.ts';
import { brandStack } from '../drawing/brand-font.ts';
import { FRAME_METRICS, PT_MM, frameGeometry, framePage, stampWidth, type FrameCell, type FrameGeometry, type Rect, type SheetFrameSpec, type Tone } from './layout.ts';
import { PLEX_MONO_STACK, PLEX_SANS_STACK, plexFontFaceCss, type PlexKind } from './measure.ts';
import { pageSizeCss } from './paper.ts';

export const FRAME_INK = '#14181d';
export const FRAME_MUTED = '#5b6570';
export const FRAME_OK = '#1f7a45';
export const FRAME_WARN = '#8f1d1d';

const TONE: Readonly<Record<Tone, string>> = { ink: FRAME_INK, muted: FRAME_MUTED, ok: FRAME_OK, warn: FRAME_WARN };

const round = (v: number): number => Math.round(v * 1000) / 1000;
const n = (v: number): string => String(round(v));

function family(kind: PlexKind): string {
  return kind === 'mono' || kind === 'monoMedium' ? PLEX_MONO_STACK : brandStack(PLEX_SANS_STACK);
}
function weight(kind: PlexKind): number {
  return kind === 'semi' ? 600 : kind === 'monoMedium' ? 500 : 400;
}

/** Baselines of a cell's value lines, mm: stacked up from the cell's bottom edge. */
function valueBaselines(cell: FrameCell): number[] {
  const pitch = cell.value.size * PT_MM * 1.18;
  const last = cell.y + cell.h - 1.2;
  return cell.value.lines.map((_, i) => last - (cell.value.lines.length - 1 - i) * pitch);
}

function captionBaseline(cell: FrameCell): number {
  return cell.y + 0.7 + cell.captionPt * PT_MM * 0.78;
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

function svgCell(cell: FrameCell): string {
  const out: string[] = [];
  const rule = FRAME_METRICS.rule;
  out.push(`<rect x="${n(cell.x)}" y="${n(cell.y)}" width="${n(cell.w)}" height="${n(cell.h)}" fill="none" stroke="${FRAME_INK}" stroke-width="${n(rule)}"/>`);
  if (cell.caption !== '') {
    out.push(
      `<text x="${n(cell.x + FRAME_METRICS.cellX)}" y="${n(captionBaseline(cell))}" font-size="${n(cell.captionPt * PT_MM)}" letter-spacing="${n(cell.captionPt * PT_MM * 0.06)}" fill="${FRAME_MUTED}" font-family="${escapeHtml(family('sans'))}" data-frame-caption="${cell.field}">${escapeHtml(cell.caption)}</text>`,
    );
  }
  const base = valueBaselines(cell);
  cell.value.lines.forEach((line, i) => {
    out.push(
      `<text x="${n(cell.x + cell.inset)}" y="${n(base[i] as number)}" font-size="${n(cell.value.size * PT_MM)}" font-weight="${weight(cell.value.kind)}" fill="${TONE[cell.value.tone]}" font-family="${escapeHtml(family(cell.value.kind))}" data-frame-field="${cell.field}">${escapeHtml(line)}</text>`,
    );
  });
  if (cell.logo !== undefined) {
    out.push(`<image x="${n(cell.logo.x)}" y="${n(cell.logo.y)}" width="${n(cell.logo.w)}" height="${n(cell.logo.h)}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${cell.logo.pngBase64}"/>`);
  }
  return out.join('');
}

/** The state stamp: a small bordered word sitting on the border's top edge at the right, in the margin. */
function stampBox(geo: FrameGeometry): (Rect & { word: string }) | undefined {
  if (geo.stamp === undefined) return undefined;
  const w = stampWidth(geo.stamp);
  // the stamp sits on the border's top edge, in the margin; a frame kept to the page's edge band has no margin to hold it, so it goes just inside
  const outside = geo.border.y >= FRAME_METRICS.stampHeight + 2;
  return { word: geo.stamp, x: geo.border.x + geo.border.w - w - 3, y: outside ? geo.border.y - FRAME_METRICS.stampHeight : geo.border.y + 1.5, w, h: FRAME_METRICS.stampHeight };
}

/**
 * The frame as an SVG `<g>` in millimetres: the border, the title block (or
 * strip), the revision table and the state stamp. No outer `<svg>`: the caller
 * places it. `border: false` leaves the border out (a label sheet keeps its
 * stock's own registration; only the strip and stamp are printed).
 */
export function frameSvgGroup(geo: FrameGeometry, options: { border?: boolean } = {}): string {
  const out: string[] = ['<g class="wh-frame" data-sheet-frame="' + geo.spec.variant + '">'];
  if (options.border !== false) {
    out.push(`<rect class="wh-frame-border" x="${n(geo.border.x)}" y="${n(geo.border.y)}" width="${n(geo.border.w)}" height="${n(geo.border.h)}" fill="none" stroke="${FRAME_INK}" stroke-width="${n(FRAME_METRICS.border)}"/>`);
  }
  out.push('<g class="wh-titleblock">');
  for (const cell of geo.titleCells) out.push(svgCell(cell));
  out.push('</g>');
  if (geo.revision !== undefined) {
    out.push('<g class="wh-revisions">');
    for (const cell of geo.revisionCells) out.push(svgCell(cell));
    out.push('</g>');
  }
  const stamp = stampBox(geo);
  if (stamp !== undefined) {
    out.push(
      `<g class="wh-stamp" data-state-stamp="${escapeHtml(stamp.word)}"><rect x="${n(stamp.x)}" y="${n(stamp.y)}" width="${n(stamp.w)}" height="${n(stamp.h)}" fill="#ffffff" stroke="${FRAME_WARN}" stroke-width="${n(FRAME_METRICS.border)}"/>` +
        `<text x="${n(stamp.x + stamp.w / 2)}" y="${n(stamp.y + stamp.h / 2 + 7 * PT_MM * 0.35)}" text-anchor="middle" font-size="${n(7 * PT_MM)}" font-weight="500" letter-spacing="${n(7 * PT_MM * 0.06)}" fill="${FRAME_WARN}" font-family="${escapeHtml(family('monoMedium'))}">${escapeHtml(stamp.word)}</text></g>`,
    );
  }
  out.push('</g>');
  return out.join('');
}

/** The faces the frame is set in, as a `<style>` for the root of an SVG document. */
export function frameFontStyle(): string {
  return `<style>${plexFontFaceCss()}</style>`;
}

/**
 * A whole sheet as one SVG in millimetres: the page, the frame and `content`
 * fitted (uniformly, centred) into the frame's content area. `content` is an
 * SVG document string with a viewBox, or a size and its markup.
 */
export function framedSvg(
  spec: SheetFrameSpec,
  content: { markup: string; width: number; height: number; /** never enlarge beyond this scale (default: fit) */ maxScale?: number } | undefined,
  options: { border?: boolean; fonts?: boolean; /** markup placed first in the document (a drawing's own faces) */ head?: string } = {},
): string {
  const geo = frameGeometry(spec);
  const { width, height } = geo.page;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}mm" height="${n(height)}mm" class="wh-sheet" data-paper="${spec.paper}" data-orientation="${spec.orientation}">`,
  ];
  if (options.fonts !== false) out.push(frameFontStyle());
  if (options.head !== undefined) out.push(options.head);
  out.push(`<rect width="${n(width)}" height="${n(height)}" fill="#ffffff"/>`);
  if (content !== undefined) {
    const pad = 2;
    const room = { x: geo.content.x + pad, y: geo.content.y + pad, w: geo.content.w - 2 * pad, h: geo.content.h - 2 * pad };
    const s = Math.min(room.w / content.width, room.h / content.height, content.maxScale ?? Infinity);
    const x = room.x + (room.w - content.width * s) / 2;
    const y = room.y + (room.h - content.height * s) / 2;
    out.push(`<g class="wh-content" transform="translate(${n(x)} ${n(y)}) scale(${round(s * 1e4) / 1e4})">${content.markup}</g>`);
  }
  out.push(frameSvgGroup(geo, options.border === undefined ? {} : { border: options.border }));
  out.push('</svg>');
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * HTML (flow documents)
 * ------------------------------------------------------------------ */

function htmlCell(cell: FrameCell, origin: { x: number; y: number }): string {
  const x = cell.x - origin.x;
  const y = cell.y - origin.y;
  const out: string[] = [`<div class="wh-cell" data-frame-cell="${cell.field}" style="left:${n(x)}mm;top:${n(y)}mm;width:${n(cell.w)}mm;height:${n(cell.h)}mm">`];
  if (cell.caption !== '') {
    out.push(`<span class="wh-cap" style="left:${n(FRAME_METRICS.cellX)}mm;top:0.7mm;font-size:${n(cell.captionPt * PT_MM)}mm">${escapeHtml(cell.caption)}</span>`);
  }
  const pitch = cell.value.size * PT_MM * 1.18;
  const last = cell.h - 1.2;
  cell.value.lines.forEach((line, i) => {
    const baseline = last - (cell.value.lines.length - 1 - i) * pitch;
    // the line box is `pitch` tall with the baseline ~0.8 of the way down
    out.push(
      `<span class="wh-val wh-${cell.value.tone} wh-${cell.value.kind}" style="left:${n(cell.inset)}mm;top:${n(baseline - pitch * 0.8)}mm;height:${n(pitch)}mm;line-height:${n(pitch)}mm;font-size:${n(cell.value.size * PT_MM)}mm" data-frame-field="${cell.field}">${escapeHtml(line)}</span>`,
    );
  });
  if (cell.logo !== undefined) {
    out.push(`<img class="wh-logo" alt="" style="left:${n(cell.logo.x - cell.x)}mm;top:${n(cell.logo.y - cell.y)}mm;width:${n(cell.logo.w)}mm;height:${n(cell.logo.h)}mm" src="data:image/png;base64,${cell.logo.pngBase64}">`);
  }
  out.push('</div>');
  return out.join('');
}

function htmlBlock(cls: string, rect: Rect, cells: readonly FrameCell[], extraStyle = ''): string {
  return `<div class="${cls}" style="width:${n(rect.w)}mm;height:${n(rect.h)}mm;${extraStyle}">${cells.map((c) => htmlCell(c, rect)).join('')}</div>`;
}

/**
 * The frame's class rules: cells are absolutely placed boxes, so a title block measures the same
 * in HTML as in SVG. A flow document (`.wh-sheet-col`) is one bordered column; printed
 * (`body.wh-paged`, set by the document shell that also emits `@page`) the border and its
 * padding are cloned onto every page and the strip is fixed to the bottom of each. No `@page`
 * here: that belongs to a whole document (`flowPageCss`).
 */
export function frameCss(spec: Pick<SheetFrameSpec, 'paper' | 'orientation'>): string {
  const sans = brandStack(PLEX_SANS_STACK);
  const { margin, pad, stripHeight, border, rule } = FRAME_METRICS;
  const page = framePage(spec);
  const top = pad + 3;
  const bottom = pad + stripHeight;
  return (
    plexFontFaceCss() +
    `@layer wirehub.frame{` +
    `.wh-tb,.wh-strip,.wh-rev{position:relative;box-sizing:content-box;font-family:${sans};color:${FRAME_INK};break-inside:avoid;border-top:${n(rule)}mm solid ${FRAME_INK};border-left:${n(rule)}mm solid ${FRAME_INK}}` +
    `.wh-cell{position:absolute;box-sizing:border-box;border-right:${n(rule)}mm solid ${FRAME_INK};border-bottom:${n(rule)}mm solid ${FRAME_INK};overflow:hidden}` +
    `.wh-cap{position:absolute;white-space:nowrap;letter-spacing:.06em;color:${FRAME_MUTED};line-height:1.1}` +
    `.wh-val{position:absolute;white-space:nowrap}` +
    `.wh-semi{font-weight:600}.wh-monoMedium{font-weight:500}` +
    `.wh-mono,.wh-monoMedium{font-family:${PLEX_MONO_STACK}}` +
    `.wh-ink{color:${FRAME_INK}}.wh-muted{color:${FRAME_MUTED}}.wh-ok{color:${FRAME_OK}}.wh-warn{color:${FRAME_WARN}}` +
    `.wh-logo{position:absolute;object-fit:contain}` +
    `.wh-stamp{display:inline-block;box-sizing:border-box;border:${n(border)}mm solid ${FRAME_WARN};color:${FRAME_WARN};background:#fff;font:500 7pt/${n(FRAME_METRICS.stampHeight - 0.6)}mm ${PLEX_MONO_STACK};letter-spacing:.06em;text-align:center;height:${n(FRAME_METRICS.stampHeight)}mm;white-space:nowrap}` +
    `.wh-sheet-col{box-sizing:border-box;position:relative;border:${n(border)}mm solid ${FRAME_INK};padding:${n(top)}mm ${n(pad)}mm ${n(bottom)}mm;-webkit-box-decoration-break:clone;box-decoration-break:clone;background:#fff}` +
    // the strip sits on the sheet's bottom edge; the stamp just inside its top-right corner
    `.wh-foot{position:absolute;left:0;right:0;bottom:0;height:${n(stripHeight)}mm}` +
    `.wh-foot .wh-strip{position:absolute;left:${n(-border)}mm;bottom:${n(-border)}mm}` +
    `.wh-sheet-col>.wh-stamp{position:absolute;top:1.5mm;right:3mm}` +
    `@media screen{.wh-sheet-col{width:${n(page.width - 2 * margin)}mm;max-width:100%;margin:${n(margin)}mm auto;min-height:${n(page.height - 2 * margin)}mm}}` +
    `@media print{body.wh-paged .wh-sheet-col{margin:0}` +
    `body.wh-paged .wh-foot{position:fixed}` +
    `body.wh-paged .wh-sheet-col>.wh-stamp{position:fixed}}` +
    `}`
  );
}

/** The full title block as an HTML box (the top of a flow document's first page). */
export function titleBlockHtml(spec: SheetFrameSpec): string {
  // the block is as wide as the column the page's text runs in: inside the border and its padding
  const geo = frameGeometry({ ...spec, variant: 'full', inset: FRAME_METRICS.margin + FRAME_METRICS.pad });
  const body = htmlBlock('wh-tb', geo.title, geo.titleCells, 'margin-left:auto;');
  const rev = geo.revision === undefined ? '' : htmlBlock('wh-rev', geo.revision, geo.revisionCells, 'margin:2mm 0 0 auto;');
  return `<div class="wh-tbwrap" style="width:${n(geo.border.w)}mm;max-width:100%">${body}${rev}</div>`;
}

/**
 * The foot of a flow document, the last children of its column: the frame's strip and, for a
 * state that calls for one, the stamp. On screen they sit on the sheet's bottom edge and its
 * top-right corner; printed in a document shell (`body.wh-paged`) they are fixed to every page.
 */
export function flowFooter(spec: SheetFrameSpec): string {
  const geo = frameGeometry({ ...spec, variant: 'strip' });
  const stamp = stampBox(geo);
  const strip = htmlBlock('wh-strip', geo.title, geo.titleCells);
  return `<div class="wh-foot" aria-hidden="true">${strip}</div>${stamp === undefined ? '' : `<span class="wh-stamp" aria-hidden="true" style="width:${n(stamp.w)}mm">${escapeHtml(stamp.word)}</span>`}`;
}

/** `@page` for a flow document: the paper, the frame's margin, and the page counter just under the border, at the right. */
export function flowPageCss(spec: Pick<SheetFrameSpec, 'paper' | 'orientation'>): string {
  const { margin } = FRAME_METRICS;
  return (
    `@page{size:${pageSizeCss(spec.paper, spec.orientation)};margin:${n(margin)}mm;` +
    `@bottom-right{content:"Sheet " counter(page) " of " counter(pages);font:500 6.4pt ${PLEX_MONO_STACK};color:${FRAME_MUTED};vertical-align:middle;text-align:right;padding:0}}`
  );
}

export { frameGeometry };
