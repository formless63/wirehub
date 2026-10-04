/**
 * House-style SVG emitter.
 *
 * Deliberately tiny and dependency-free: a handful of primitives that all
 * generated artwork goes through, so every asset comes out with the same
 * stroke weights, the same monochrome palette, and the same number formatting.
 *
 * Rules the emitter enforces (from `specs/depictions.md`):
 *
 *  - **Self-contained**: no external references, no fonts beyond the generic
 *    `sans-serif` stack, no scripts.
 *  - **Monochrome-safe**: everything paints with `currentColor`, so the
 *    renderer's own theme drives the ink and the art works on paper.
 *  - **mm-true**: the viewBox is in millimetres, `mmPerUnit` is 1.
 *  - **Deterministic**: fixed rounding, fixed ordering, no timestamps.
 */

import { HOUSE_STYLE, round } from './model.ts';

/** Shortest stable decimal for a rounded number. */
export function num(value: number): string {
  return String(round(value));
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Collapse newlines/runs of whitespace so silkscreen text stays on one line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export interface SvgDocumentOptions {
  widthMm: number;
  heightMm: number;
  title: string;
  description: string;
}

/**
 * Wrap body elements in the house document frame. Paint defaults live on the
 * root `<g>` so individual elements only ever override what differs.
 */
export function svgDocument(options: SvgDocumentOptions, body: string[]): string {
  const width = num(options.widthMm);
  const height = num(options.heightMm);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}mm" height="${height}mm">`,
    `  <title>${escapeXml(options.title)}</title>`,
    `  <desc>${escapeXml(options.description)}</desc>`,
    `  <g fill="none" stroke="currentColor" stroke-width="${num(HOUSE_STYLE.strokePad)}" stroke-linecap="round" stroke-linejoin="round">`,
    ...body.map((line) => `    ${line}`),
    '  </g>',
    '</svg>',
  ];
  return `${lines.join('\n')}\n`;
}

export interface RectOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth?: number;
  radius?: number;
  dashed?: boolean;
}

export function rect(options: RectOptions): string {
  const attrs = [
    `x="${num(options.x)}"`,
    `y="${num(options.y)}"`,
    `width="${num(options.width)}"`,
    `height="${num(options.height)}"`,
  ];
  if (options.radius !== undefined) attrs.push(`rx="${num(options.radius)}"`);
  if (options.strokeWidth !== undefined) attrs.push(`stroke-width="${num(options.strokeWidth)}"`);
  if (options.dashed === true) attrs.push(`stroke-dasharray="${num(0.5)} ${num(0.35)}"`);
  return `<rect ${attrs.join(' ')}/>`;
}

export interface CircleOptions {
  cx: number;
  cy: number;
  r: number;
  strokeWidth?: number;
  dashed?: boolean;
}

export function circle(options: CircleOptions): string {
  const attrs = [
    `cx="${num(options.cx)}"`,
    `cy="${num(options.cy)}"`,
    `r="${num(options.r)}"`,
  ];
  if (options.strokeWidth !== undefined) attrs.push(`stroke-width="${num(options.strokeWidth)}"`);
  if (options.dashed === true) attrs.push(`stroke-dasharray="${num(0.5)} ${num(0.35)}"`);
  return `<circle ${attrs.join(' ')}/>`;
}

export interface TextOptions {
  x: number;
  y: number;
  text: string;
  size?: number;
  anchor?: 'start' | 'middle' | 'end';
  weight?: 'normal' | 'bold';
}

export function text(options: TextOptions): string {
  const attrs = [
    `x="${num(options.x)}"`,
    `y="${num(options.y)}"`,
    `font-family="sans-serif"`,
    `font-size="${num(options.size ?? HOUSE_STYLE.fontSize)}"`,
    `text-anchor="${options.anchor ?? 'middle'}"`,
    'fill="currentColor"',
    'stroke="none"',
  ];
  if (options.weight === 'bold') attrs.push('font-weight="bold"');
  return `<text ${attrs.join(' ')}>${escapeXml(oneLine(options.text))}</text>`;
}

export function line(x1: number, y1: number, x2: number, y2: number, strokeWidth?: number): string {
  const attrs = [
    `x1="${num(x1)}"`,
    `y1="${num(y1)}"`,
    `x2="${num(x2)}"`,
    `y2="${num(y2)}"`,
  ];
  if (strokeWidth !== undefined) attrs.push(`stroke-width="${num(strokeWidth)}"`);
  return `<line ${attrs.join(' ')}/>`;
}

/** A labelled section break in the emitted source, so the files stay readable. */
export function comment(value: string): string {
  return `<!-- ${value.replace(/--+/g, '-')} -->`;
}
