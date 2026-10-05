/**
 * The wire stock spec sheet without a browser (cs-5k1.22): `html` is the
 * browser's own render (`renderWireSpecSheet`); `svg` and `pdf` set the same
 * sheet's text as plain pages (`layout.ts`) — headings, the facts, the
 * colour and signal map, the notes — without the cross-section figure and the
 * page styling, because laying out HTML needs a browser engine the WireHub
 * image does not ship (the same trade the text sheets of a design make,
 * `render/index.ts`). With a browser PDF engine configured the documents
 * route prints the `html` sheet instead (`browser-pdf.ts`, `documents.ts`).
 */

import { renderWireSpecSheet, wireSpecFileStem, type WireSpecOptions } from '@wirehub/docs';
import type { WireDefinition } from '@wirehub/model';

import { layoutMarkdown, PAPER } from './layout.ts';
import { pagesToPdf, type PdfPage } from './pdf.ts';
import { pagesToSvg } from './svg.ts';

export const WIRE_SPEC_FORMATS = ['html', 'svg', 'pdf'] as const;
export type WireSpecFormat = (typeof WIRE_SPEC_FORMATS)[number];

export const isWireSpecFormat = (value: string): value is WireSpecFormat => (WIRE_SPEC_FORMATS as readonly string[]).includes(value);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sheet's fragment as markdown: headings, definition facts, lists and pipe tables, in document order. */
export function wireSpecMarkdown(fragment: string): string {
  const body = fragment.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '');
  const out: string[] = [];
  const blocks = /<(h[1-3]|p|li|table|dl)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of body.matchAll(blocks)) {
    const tag = (match[1] as string).toLowerCase();
    const inner = match[2] as string;
    if (tag === 'h1') out.push(`# ${text(inner)}`);
    else if (tag === 'h2') out.push(`## ${text(inner)}`);
    else if (tag === 'h3') out.push(`### ${text(inner)}`);
    else if (tag === 'p') {
      const t = text(inner);
      if (t !== '') out.push(t);
    } else if (tag === 'li') {
      const t = text(inner);
      if (t !== '') out.push(`- ${t}`);
    } else if (tag === 'dl') {
      for (const pair of inner.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) out.push(`- ${text(pair[1] as string)}: ${text(pair[2] as string)}`);
    } else {
      const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) => [...(tr[1] as string).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => text(c[1] as string).replace(/\|/g, '/')));
      if (rows.length === 0) continue;
      const hasHeader = /<th\b/i.test((inner.match(/<tr[^>]*>[\s\S]*?<\/tr>/i) ?? [''])[0]) && /<thead/i.test(inner);
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]): string[] => [...r, ...Array.from({ length: width - r.length }, () => '')];
      // a two-column key/value table (th = key) reads as a list, not a grid
      if (!hasHeader && rows.every((r) => r.length === 2)) {
        for (const [k = '', v = ''] of rows) out.push(`- ${k}: ${v}`);
        continue;
      }
      const [head, ...rest] = hasHeader ? rows : [Array.from({ length: width }, () => ''), ...rows];
      out.push([`| ${pad(head as string[]).join(' | ')} |`, `| ${pad(head as string[]).map(() => '---').join(' | ')} |`, ...rest.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n'));
    }
  }
  return `${out.join('\n\n')}\n`;
}

export interface WireSpecFile {
  mimeType: string;
  fileName: string;
  body: string | Uint8Array;
}

/** One stock's spec sheet in `format`, named `<WIRE_SPEC_FILE_PREFIX><doc number>.<ext>`. */
export function renderWireSpec(wire: WireDefinition, format: WireSpecFormat, options: Omit<WireSpecOptions, 'paper'> & { paper?: 'A4' | 'letter' } = {}): WireSpecFile {
  const { paper = 'A4', ...sheet } = options;
  const stem = wireSpecFileStem(wire, sheet.filePrefix);
  if (format === 'html') return { mimeType: 'text/html; charset=utf-8', fileName: `${stem}.html`, body: renderWireSpecSheet(wire, { ...sheet, paper: paper === 'letter' ? 'Letter' : 'A4' }) };
  const markdown = wireSpecMarkdown(renderWireSpecSheet(wire, { ...sheet, fragment: true }));
  const pages = layoutMarkdown(markdown, { paper: PAPER[paper], footer: stem });
  if (format === 'svg') return { mimeType: 'image/svg+xml', fileName: `${stem}.svg`, body: pagesToSvg(pages) };
  return { mimeType: 'application/pdf', fileName: `${stem}.pdf`, body: pagesToPdf(pages.map((page): PdfPage => ({ kind: 'ops', page })), `${wire.label} — spec sheet`) };
}
