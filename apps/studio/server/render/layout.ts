/**
 * Plain page layout: markdown (headings, paragraphs, lists, pipe tables) into
 * pages of drawing operations, which `pagesToSvg` and `pagesToPdf` both draw.
 * One layout, two back-ends, so the SVG and the PDF of a document agree.
 *
 * Text is set in Helvetica metrics (the embedded Liberation Sans advance
 * widths are the same), transliterated to what a PDF's standard fonts can
 * encode. Deterministic: no clock, no locale.
 */

import { textWidth } from '@wirehub/docs';

export type Op =
  | { t: 'text'; x: number; y: number; size: number; bold: boolean; text: string; grey?: boolean }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: number };

export interface Page {
  width: number;
  height: number;
  ops: Op[];
}

export interface PaperSize {
  width: number;
  height: number;
}

/** Points. */
export const PAPER: Readonly<Record<'A4' | 'letter', PaperSize>> = {
  A4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
};

const SUBSTITUTE: Readonly<Record<string, string>> = {
  '\u2126': 'ohm', '\u03a9': 'ohm', '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u2248': '~', '\u2265': '>=', '\u2264': '<=',
  '\u26a0': '!', '\u2713': 'x', '\u2212': '-', '\u2011': '-', '\u202f': ' ',
};

/** Text a PDF standard font (WinAnsi) can show; anything else becomes `?`. */
export function latin(text: string): string {
  let out = '';
  for (const ch of text) {
    const sub = SUBSTITUTE[ch];
    if (sub !== undefined) out += sub;
    else if (ch === '\t' || ch === '\n') out += ' ';
    else {
      const code = ch.codePointAt(0) as number;
      out += (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA[ch] !== undefined ? ch : '?';
    }
  }
  return out;
}

/** The WinAnsi byte for a character `latin` let through. */
export function winAnsiByte(ch: string): number {
  return WIN_ANSI_EXTRA[ch] ?? ch.codePointAt(0)!;
}

/* ------------------------------------------------------------------ *
 * Markdown blocks
 * ------------------------------------------------------------------ */

type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'p'; text: string; quote: boolean }
  | { kind: 'li'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][]; align: ('left' | 'right')[] };

function inline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').trim();
}

function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c === '\\' && (body[i + 1] === '|' || body[i + 1] === '\\')) {
      cell += body[i + 1];
      i += 1;
    } else if (c === '|') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  out.push(cell);
  return out.map((c) => inline(c));
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: inline(paragraph.join(' ')), quote: false });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: 'h', level: (heading[1] as string).length as 1 | 2 | 3, text: inline(heading[2] as string) });
    } else if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      flush();
      const header = cells(line);
      const align = cells(lines[i + 1] as string).map((c) => (c.trim().endsWith(':') && !c.trim().startsWith(':') ? ('right' as const) : ('left' as const)));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).startsWith('|')) {
        rows.push(cells(lines[i] as string));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'table', header, rows, align });
    } else if (line.startsWith('> ')) {
      flush();
      blocks.push({ kind: 'p', text: inline(line.slice(2)), quote: true });
    } else if (/^[-*] /.test(line)) {
      flush();
      blocks.push({ kind: 'li', text: inline(line.slice(2)) });
    } else if (line.trim() === '') flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

const MARGIN = 40;
const BODY = 9;
const TABLE = 7.6;
const LEAD = 1.28;
const PAD = 3;

/** a hair of slack over the face's advance widths, for renderers that substitute a wider font */
const width = (text: string, size: number, bold = false): number => textWidth(text, size, bold) * 1.04;

/** Greedy word wrap; a word wider than the line is broken by character. */
export function wrap(text: string, size: number, max: number, bold = false): string[] {
  const lines: string[] = [];
  let line = '';
  const push = (): void => {
    lines.push(line);
    line = '';
  };
  for (const word of text.split(' ')) {
    if (word === '' && line === '') continue;
    const candidate = line === '' ? word : `${line} ${word}`;
    if (width(candidate, size, bold) <= max) {
      line = candidate;
      continue;
    }
    if (line !== '') push();
    if (width(word, size, bold) <= max) line = word;
    else {
      for (const ch of word) {
        if (width(line + ch, size, bold) > max && line !== '') push();
        line += ch;
      }
    }
  }
  if (line !== '' || lines.length === 0) push();
  return lines;
}

export interface LayoutOptions {
  paper: PaperSize;
  /** printed at the foot of every page, with the page number */
  footer?: string;
}

/** Column widths: natural width, shrunk toward the longest word until the row fits. */
function columnWidths(header: string[], rows: string[][], size: number, avail: number): number[] {
  const count = header.length;
  const natural: number[] = [];
  const least: number[] = [];
  for (let c = 0; c < count; c += 1) {
    const column = [header[c] as string, ...rows.map((r) => r[c] ?? '')];
    natural.push(Math.max(...column.map((t, i) => width(t, size, i === 0))) + 2 * PAD);
    least.push(Math.min(natural[c] as number, Math.max(...column.flatMap((t) => t.split(' ').map((w) => width(w, size, true)))) + 2 * PAD));
  }
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= avail) return natural;
  const floor = least.reduce((a, b) => a + b, 0);
  if (floor >= avail) return least.map((w) => (w * avail) / floor);
  const f = (avail - floor) / (total - floor);
  return natural.map((n, c) => (least[c] as number) + ((n - (least[c] as number)) * f));
}

export function layoutMarkdown(markdown: string, options: LayoutOptions): Page[] {
  const { width: W, height: H } = options.paper;
  const avail = W - 2 * MARGIN;
  const bottom = H - MARGIN - 14;
  const pages: Page[] = [];
  let page: Page = { width: W, height: H, ops: [] };
  let y = MARGIN;
  const fresh = (): void => {
    pages.push(page);
    page = { width: W, height: H, ops: [] };
    y = MARGIN;
  };
  const ensure = (h: number): void => {
    if (y + h > bottom && y > MARGIN) fresh();
  };
  const text = (x: number, size: number, bold: boolean, t: string, grey = false): void => {
    page.ops.push({ t: 'text', x, y: y + size, size, bold, text: t, ...(grey ? { grey } : {}) });
  };

  for (const block of parseMarkdown(markdown)) {
    if (block.kind === 'h') {
      const size = block.level === 1 ? 16 : block.level === 2 ? 12.5 : 10.2;
      const gap = block.level === 1 ? 4 : 10;
      const lines = wrap(latin(block.text), size, avail, true);
      ensure(gap + lines.length * size * LEAD + 12);
      y += y === MARGIN ? 0 : gap;
      for (const line of lines) {
        text(MARGIN, size, true, line);
        y += size * LEAD;
      }
      y += 3;
    } else if (block.kind === 'p' || block.kind === 'li') {
      const indent = block.kind === 'li' ? 12 : block.quote ? 10 : 0;
      const lines = wrap(latin(block.text), BODY, avail - indent);
      for (const [i, line] of lines.entries()) {
        ensure(BODY * LEAD);
        if (block.kind === 'li' && i === 0) text(MARGIN + 2, BODY, false, '-');
        text(MARGIN + indent, BODY, false, line);
        y += BODY * LEAD;
      }
      y += 4;
    } else {
      const header = block.header.map(latin);
      const rows = block.rows.map((r) => r.map(latin));
      const widths = columnWidths(header, rows, TABLE, avail);
      const xs = widths.reduce<number[]>((acc, w) => [...acc, (acc[acc.length - 1] as number) + w], [MARGIN]);
      const drawRow = (row: string[], head: boolean): number => {
        const wrapped = row.map((t, c) => wrap(t, TABLE, (widths[c] as number) - 2 * PAD, head));
        const h = Math.max(...wrapped.map((l) => l.length)) * TABLE * LEAD + 2 * PAD;
        ensure(h);
        if (head) page.ops.push({ t: 'rect', x: MARGIN, y, w: widths.reduce((a, b) => a + b, 0), h, fill: 0.9 });
        wrapped.forEach((lines, c) => {
          lines.forEach((line, i) => {
            const x = block.align[c] === 'right' ? (xs[c + 1] as number) - PAD - width(line, TABLE, head) : (xs[c] as number) + PAD;
            page.ops.push({ t: 'text', x, y: y + PAD + TABLE * (i * LEAD + 1), size: TABLE, bold: head, text: line });
          });
        });
        page.ops.push({ t: 'line', x1: MARGIN, y1: y + h, x2: xs[xs.length - 1] as number, y2: y + h, w: 0.4 });
        y += h;
        return h;
      };
      const headerHeight = Math.max(...header.map((t, c) => wrap(t, TABLE, (widths[c] as number) - 2 * PAD, true).length)) * TABLE * LEAD + 2 * PAD;
      ensure(headerHeight + TABLE * LEAD + 2 * PAD);
      page.ops.push({ t: 'line', x1: MARGIN, y1: y, x2: xs[xs.length - 1] as number, y2: y, w: 0.4 });
      drawRow(header, true);
      for (const row of rows) {
        const need = Math.max(...row.map((t, c) => wrap(t, TABLE, (widths[c] as number) - 2 * PAD).length)) * TABLE * LEAD + 2 * PAD;
        if (y + need > bottom && y > MARGIN) {
          fresh();
          page.ops.push({ t: 'line', x1: MARGIN, y1: y, x2: xs[xs.length - 1] as number, y2: y, w: 0.4 });
          drawRow(header, true);
        }
        drawRow(row, false);
      }
      y += 6;
    }
  }
  pages.push(page);
  const total = pages.length;
  pages.forEach((p, i) => {
    const label = `${options.footer === undefined ? '' : `${latin(options.footer)}  -  `}page ${i + 1} of ${total}`;
    p.ops.push({ t: 'text', x: MARGIN, y: H - MARGIN + 4, size: 7, bold: false, text: label, grey: true });
  });
  return pages;
}
