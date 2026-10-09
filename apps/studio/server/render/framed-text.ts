/**
 * The headless text pages on the sheet frame (cs-dcuk). Without a browser PDF
 * engine the build sheet, BOM, continuity spec and wire spec are a plain page
 * layout of their text (`layout.ts`); this puts those pages on the same frame
 * as every other sheet: the border, the full title block on the first page,
 * the one-row strip with "n of N" on the pages after it, and the state stamp.
 * The frame's geometry (`frameGeometry`, millimetres) decides the text area,
 * so the headless sheet measures like the printed HTML one.
 *
 * A page is one SVG in millimetres; `pagesToSvg` stacks them and
 * `svgToVectorPdfPage` turns each into a PDF page (the text stays text: the
 * body in Liberation Sans, the frame in the embedded IBM Plex subsets).
 */

import { FRAME_METRICS, frameFontStyle, frameGeometry, frameSvgGroup, type SheetFrameSpec } from '@wirehub/docs';

import { layoutMarkdown, type Op } from './layout.ts';
import type { PdfPage } from './pdf.ts';
import { svgToVectorPdfPage } from './vector.ts';

const MM_PT = 72 / 25.4;
const PT_MM = 25.4 / 72;
const n = (v: number): string => String(Math.round(v * 1000) / 1000);
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface FramedPage {
  /** the page as an SVG document, millimetres */
  svg: string;
  /** the page's inner markup, for stacking */
  inner: string;
  widthMm: number;
  heightMm: number;
}

function opSvg(op: Op): string {
  if (op.t === 'text') {
    return `<text x="${n(op.x * PT_MM)}" y="${n(op.y * PT_MM)}" font-size="${n(op.size * PT_MM)}"${op.bold ? ' font-weight="bold"' : ''} fill="${op.grey === true ? '#737373' : '#000000'}" xml:space="preserve">${esc(op.text)}</text>`;
  }
  if (op.t === 'line') return `<line x1="${n(op.x1 * PT_MM)}" y1="${n(op.y1 * PT_MM)}" x2="${n(op.x2 * PT_MM)}" y2="${n(op.y2 * PT_MM)}" stroke="#8c8c8c" stroke-width="${n(op.w * PT_MM)}"/>`;
  const g = Math.round(op.fill * 255).toString(16).padStart(2, '0');
  return `<rect x="${n(op.x * PT_MM)}" y="${n(op.y * PT_MM)}" width="${n(op.w * PT_MM)}" height="${n(op.h * PT_MM)}" fill="#${g}${g}${g}"/>`;
}

/**
 * Lay `markdown` out inside `spec`'s frame: the text area is the frame's content
 * area less the frame's padding, on the first page (full block) and on the
 * pages after (strip). The logo is left out of the headless frame (the PDF
 * writer draws no images here); the browser engine's PDF carries it.
 */
export function framedTextPages(markdown: string, spec: SheetFrameSpec): FramedPage[] {
  const { logo: _logo, ...bare } = spec;
  const first = frameGeometry({ ...bare, variant: 'full' });
  const rest = frameGeometry({ ...bare, variant: 'strip' });
  const pad = FRAME_METRICS.pad;
  const { width, height } = first.page;
  const x = first.border.x + pad;
  const top = Math.min(first.content.y, rest.content.y) + pad - 1;
  const layout = layoutMarkdown(markdown, {
    paper: { width: width * MM_PT, height: height * MM_PT },
    frame: {
      x: x * MM_PT,
      w: (first.border.w - 2 * pad) * MM_PT,
      top: top * MM_PT,
      firstBottom: (first.content.y + first.content.h - 2) * MM_PT,
      restBottom: (rest.content.y + rest.content.h - 2) * MM_PT,
    },
  });
  return layout.map((page, i) => {
    const pageSpec: SheetFrameSpec = { ...bare, variant: i === 0 ? 'full' : 'strip', sheet: `${i + 1} of ${layout.length}` };
    const inner =
      `<rect width="${n(width)}" height="${n(height)}" fill="#ffffff"/>` +
      page.ops.map(opSvg).join('') +
      frameSvgGroup(frameGeometry(pageSpec));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}mm" height="${n(height)}mm" font-family="Helvetica, Arial, Liberation Sans, sans-serif" class="wh-sheet" data-paper="${spec.paper}" data-orientation="${spec.orientation}">${inner}</svg>`;
    return { svg, inner, widthMm: width, heightMm: height };
  });
}

/** The pages as one SVG document (a page each, stacked with a gap), the frame's faces inlined. */
export function framedPagesToSvg(pages: readonly FramedPage[]): string {
  const gap = 5;
  const width = Math.max(...pages.map((p) => p.widthMm));
  const height = pages.reduce((s, p) => s + p.heightMm, 0) + gap * (pages.length - 1);
  let top = 0;
  const body = pages.map((p) => {
    const g = `<g transform="translate(0 ${n(top)})">${p.inner}</g>`;
    top += p.heightMm + gap;
    return g;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}mm" height="${n(height)}mm" font-family="Helvetica, Arial, Liberation Sans, sans-serif" class="wh-sheet" data-pages="${pages.length}">${frameFontStyle()}<rect width="${n(width)}" height="${n(height)}" fill="#e6e6e6"/>${body.join('')}</svg>`;
}

/** The pages as vector PDF pages. */
export function framedPagesToPdf(pages: readonly FramedPage[]): PdfPage[] {
  return pages.map((p) => svgToVectorPdfPage(p.svg, { width: p.widthMm * MM_PT, height: p.heightMm * MM_PT }));
}
