/** Pages of drawing operations (`layout.ts`) as one SVG, the pages stacked with a gap. */

import type { Page } from './layout.ts';

const GAP = 14;
const n = (v: number): string => String(Math.round(v * 100) / 100);
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function pagesToSvg(pages: readonly Page[]): string {
  const width = Math.max(...pages.map((p) => p.width));
  const height = pages.reduce((sum, p) => sum + p.height, 0) + GAP * (pages.length - 1);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" font-family="Helvetica, Arial, Liberation Sans, sans-serif" data-pages="${pages.length}">`,
    `<rect width="${n(width)}" height="${n(height)}" fill="#e6e6e6"/>`,
  ];
  let top = 0;
  for (const page of pages) {
    out.push(`<g transform="translate(0 ${n(top)})"><rect width="${n(page.width)}" height="${n(page.height)}" fill="#ffffff"/>`);
    for (const op of page.ops) {
      if (op.t === 'text') {
        out.push(`<text x="${n(op.x)}" y="${n(op.y)}" font-size="${n(op.size)}"${op.bold ? ' font-weight="bold"' : ''} fill="${op.grey === true ? '#737373' : '#000000'}" xml:space="preserve">${esc(op.text)}</text>`);
      } else if (op.t === 'line') {
        out.push(`<line x1="${n(op.x1)}" y1="${n(op.y1)}" x2="${n(op.x2)}" y2="${n(op.y2)}" stroke="#8c8c8c" stroke-width="${n(op.w)}"/>`);
      } else {
        out.push(`<rect x="${n(op.x)}" y="${n(op.y)}" width="${n(op.w)}" height="${n(op.h)}" fill="rgb(${Math.round(op.fill * 255)},${Math.round(op.fill * 255)},${Math.round(op.fill * 255)})"/>`);
      }
    }
    out.push('</g>');
    top += page.height + GAP;
  }
  out.push('</svg>');
  return out.join('');
}
