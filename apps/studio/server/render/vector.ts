/**
 * SVG to PDF drawing operators: the vector path for the documents whose SVG
 * is a printed artefact at a known scale (the formboard's nail-board tiles),
 * where a raster page loses the 1:1 crispness. It reads only the subset the
 * formboard emits (`svg`, `g`, `rect`, `line`, `circle`, `text`, `clipPath`;
 * `translate`/`rotate` transforms; fill, stroke, width, dash, cap, opacity,
 * text-anchor, bold) and refuses an element outside it, so a drawing that
 * grows a new primitive fails a test instead of printing without it.
 * Text is set in the PDF's standard Helvetica faces. Pure and deterministic.
 */

import { textWidth } from '@wirehub/docs';

import { latin } from './layout.ts';
import { pdfString, type PdfPage } from './pdf.ts';

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  dash: number[];
  cap: 0 | 1 | 2;
  bold: boolean;
  anchor: 'start' | 'middle' | 'end';
}

type Attrs = Record<string, string>;

const NAMED: Readonly<Record<string, string>> = { white: '#ffffff', black: '#000000' };

function colour(value: string): string {
  const v = NAMED[value] ?? value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (v === 'none') return 'none';
  throw new Error(`vector pdf: colour '${value}' is outside the supported subset`);
}

function rgb(hex: string): string {
  return [1, 3, 5].map((i) => n(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');
}

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] as string);
}

function parseAttrs(source: string): Attrs {
  const out: Attrs = {};
  for (const m of source.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1] as string] = unescape(m[2] as string);
  return out;
}

const num = (attrs: Attrs, key: string, fallback = 0): number => (attrs[key] === undefined ? fallback : Number(attrs[key]));

/** `translate(x y)` / `rotate(a [cx cy])` lists, as PDF `cm` operands in order. */
function transformOps(value: string): string[] {
  const ops: string[] = [];
  for (const m of value.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const args = (m[2] as string).split(/[\s,]+/).filter((s) => s !== '').map(Number);
    if (m[1] === 'translate') ops.push(`1 0 0 1 ${n(args[0] ?? 0)} ${n(args[1] ?? 0)} cm`);
    else if (m[1] === 'rotate') {
      const a = ((args[0] ?? 0) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const [cx, cy] = [args[1] ?? 0, args[2] ?? 0];
      if (cx !== 0 || cy !== 0) ops.push(`1 0 0 1 ${n(cx)} ${n(cy)} cm`);
      ops.push(`${n(c)} ${n(s)} ${n(-s)} ${n(c)} 0 0 cm`);
      if (cx !== 0 || cy !== 0) ops.push(`1 0 0 1 ${n(-cx)} ${n(-cy)} cm`);
    } else throw new Error(`vector pdf: transform '${m[1]}' is outside the supported subset`);
  }
  return ops;
}

function inherit(parent: Style, attrs: Attrs): Style {
  const dash = attrs['stroke-dasharray'];
  return {
    fill: attrs['fill'] === undefined ? parent.fill : colour(attrs['fill']),
    stroke: attrs['stroke'] === undefined ? parent.stroke : colour(attrs['stroke']),
    strokeWidth: attrs['stroke-width'] === undefined ? parent.strokeWidth : Number(attrs['stroke-width']),
    fillOpacity: attrs['fill-opacity'] === undefined ? parent.fillOpacity : Number(attrs['fill-opacity']),
    strokeOpacity: attrs['stroke-opacity'] === undefined ? parent.strokeOpacity : Number(attrs['stroke-opacity']),
    dash: dash === undefined ? parent.dash : dash === 'none' ? [] : dash.split(/[\s,]+/).map(Number),
    cap: attrs['stroke-linecap'] === undefined ? parent.cap : attrs['stroke-linecap'] === 'round' ? 1 : attrs['stroke-linecap'] === 'square' ? 2 : 0,
    bold: attrs['font-weight'] === undefined ? parent.bold : attrs['font-weight'] === 'bold',
    anchor: attrs['text-anchor'] === undefined ? parent.anchor : (attrs['text-anchor'] as Style['anchor']),
  };
}

export function svgToVectorPdfPage(svg: string, page: { width: number; height: number }): Extract<PdfPage, { kind: 'vector' }> {
  const root = /<svg\b([^>]*)>/.exec(svg);
  if (!root) throw new Error('vector pdf: not an svg');
  const vb = (parseAttrs(root[1] as string)['viewBox'] ?? '').split(/\s+/).map(Number);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v))) throw new Error('vector pdf: the svg has no viewBox');
  const alphas = new Map<string, [number, number]>();
  const clips = new Map<string, { x: number; y: number; w: number; h: number }>();
  const out: string[] = [];
  const sx = page.width / (vb[2] as number);
  const sy = page.height / (vb[3] as number);
  out.push(`${n(sx)} 0 0 ${n(-sy)} ${n(-(vb[0] as number) * sx)} ${n(page.height + (vb[1] as number) * sy)} cm`);

  const alphaOp = (fill: number, stroke: number): void => {
    const key = `G${Math.round(fill * 1000)}_${Math.round(stroke * 1000)}`;
    alphas.set(key, [fill, stroke]);
    out.push(`/${key} gs`);
  };
  const paint = (style: Style, geometry: () => void): void => {
    const doFill = style.fill !== 'none' && style.fillOpacity > 0;
    const doStroke = style.stroke !== 'none' && style.strokeWidth > 0 && style.strokeOpacity > 0;
    if (!doFill && !doStroke) return;
    out.push('q');
    if (style.fillOpacity !== 1 || style.strokeOpacity !== 1) alphaOp(style.fillOpacity, style.strokeOpacity);
    if (doFill) out.push(`${rgb(style.fill)} rg`);
    if (doStroke) {
      out.push(`${rgb(style.stroke)} RG ${n(style.strokeWidth)} w ${style.cap} J [${style.dash.map(n).join(' ')}] 0 d`);
    }
    geometry();
    out.push(doFill && doStroke ? 'B' : doFill ? 'f' : 'S');
    out.push('Q');
  };

  const K = 0.5522847498;
  const rrect = (x: number, y: number, w: number, h: number, r: number): void => {
    if (r <= 0) {
      out.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`);
      return;
    }
    const k = r * K;
    out.push(
      `${n(x + r)} ${n(y)} m ${n(x + w - r)} ${n(y)} l ${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c`,
      `${n(x + w)} ${n(y + h - r)} l ${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`,
      `${n(x + r)} ${n(y + h)} l ${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c`,
      `${n(x)} ${n(y + r)} l ${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c h`,
    );
  };

  const base: Style = { fill: '#000000', stroke: 'none', strokeWidth: 1, fillOpacity: 1, strokeOpacity: 1, dash: [], cap: 0, bold: false, anchor: 'start' };
  const styles: Style[] = [inherit(base, parseAttrs(root[1] as string))];
  /** one entry per open element that did a `q` */
  const opened: boolean[] = [];
  let inClip: string | undefined;

  let pendingText: { attrs: Attrs; style: Style; body: string } | undefined;
  return walk();

  function walk(): Extract<PdfPage, { kind: 'vector' }> {
    const body = svg.slice((root as RegExpExecArray).index + (root as RegExpExecArray)[0].length);
    const re = /<(\/)?([a-zA-Z][\w-]*)\b([^>]*?)(\/)?>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const closing = m[1] !== undefined;
      const name = m[2];
      const attrs = parseAttrs(m[3] ?? '');
      const selfClose = m[4] !== undefined;
      if (m[5] !== undefined) {
        if (pendingText) pendingText.body += m[5];
        continue;
      }
      if (name === 'svg' || name === 'title' || name === 'desc') continue;
      if (name === 'clipPath') {
        inClip = closing ? undefined : (attrs['id'] as string);
        continue;
      }
      const style = styles[styles.length - 1] as Style;
      if (inClip !== undefined) {
        if (name === 'rect' && !closing) clips.set(inClip, { x: num(attrs, 'x'), y: num(attrs, 'y'), w: num(attrs, 'width'), h: num(attrs, 'height') });
        else if (!closing) throw new Error(`vector pdf: <${name}> inside a clipPath is outside the supported subset`);
        continue;
      }
      if (name === 'g') {
        if (closing) {
          styles.pop();
          if (opened.pop()) out.push('Q');
          continue;
        }
        out.push('q');
        const clipRef = /url\(#([^)]+)\)/.exec(attrs['clip-path'] ?? '');
        if (clipRef) {
          const c = clips.get(clipRef[1] as string);
          if (!c) throw new Error(`vector pdf: clip '${clipRef[1]}' is not defined`);
          out.push(`${n(c.x)} ${n(c.y)} ${n(c.w)} ${n(c.h)} re W n`);
        }
        if (attrs['transform'] !== undefined) out.push(...transformOps(attrs['transform']));
        styles.push(inherit(style, attrs));
        opened.push(true);
        if (selfClose) {
          styles.pop();
          opened.pop();
          out.push('Q');
        }
        continue;
      }
      if (name === 'text') {
        if (closing) {
          const t = pendingText as NonNullable<typeof pendingText>;
          pendingText = undefined;
          emitText(t.attrs, t.style, unescape(t.body));
        } else pendingText = { attrs, style: inherit(style, attrs), body: '' };
        continue;
      }
      if (closing) continue;
      const own = inherit(style, attrs);
      out.push('q');
      if (attrs['transform'] !== undefined) out.push(...transformOps(attrs['transform']));
      if (name === 'rect') {
        const w = num(attrs, 'width');
        const h = num(attrs, 'height');
        paint(own, () => rrect(num(attrs, 'x'), num(attrs, 'y'), w, h, Math.min(num(attrs, 'rx'), w / 2, h / 2)));
      } else if (name === 'line') {
        const noFill = { ...own, fill: 'none' };
        paint(noFill, () => out.push(`${n(num(attrs, 'x1'))} ${n(num(attrs, 'y1'))} m ${n(num(attrs, 'x2'))} ${n(num(attrs, 'y2'))} l`));
      } else if (name === 'circle') {
        const [cx, cy, r] = [num(attrs, 'cx'), num(attrs, 'cy'), num(attrs, 'r')];
        const k = r * K;
        paint(own, () =>
          out.push(
            `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
            `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c`,
            `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
            `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h`,
          ),
        );
      } else throw new Error(`vector pdf: <${name}> is outside the supported subset`);
      out.push('Q');
    }
    return { kind: 'vector', width: page.width, height: page.height, content: out.join('\n'), alphas: [...alphas].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, [ca, CA]]) => ({ key, ca, CA })) };
  }

  function emitText(attrs: Attrs, style: Style, raw: string): void {
    if (style.fill === 'none' || style.fillOpacity === 0) return;
    const body = latin(raw);
    const size = num(attrs, 'font-size', 16);
    const width = textWidth(body, size, style.bold);
    const x = num(attrs, 'x') - (style.anchor === 'middle' ? width / 2 : style.anchor === 'end' ? width : 0);
    const y = num(attrs, 'y') + (attrs['dominant-baseline'] === 'middle' ? size * 0.35 : 0);
    out.push('q');
    if (style.fillOpacity !== 1) alphaOp(style.fillOpacity, 1);
    if (attrs['transform'] !== undefined) out.push(...transformOps(attrs['transform']));
    out.push(`${rgb(style.fill)} rg BT /${style.bold ? 'F2' : 'F1'} ${n(size)} Tf 1 0 0 -1 ${n(x)} ${n(y)} Tm ${pdfString(body)} Tj ET`, 'Q');
  }
}
