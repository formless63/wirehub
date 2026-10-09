/**
 * A tape label at true geometry (cs-gqbj): the layout of one wire label on a Brother TZe tape,
 * drawn as SVG (the preview, the PNG and the PDF) and written as `.lbx` text objects (`lbx.ts`)
 * from the same numbers, so what the screen shows is what the file asks P-touch Editor for.
 *
 * Everything is millimetres on the tape: x along its length from the leading edge, y across it
 * from one edge. The printable band is the print head's height centred on the tape. Lines come from the
 * label template (`label-templates.ts`); each takes its share of the band, set as large as fits and
 * shrunk to the length when that is fixed. A QR code is placed only when its modules are at least
 * two dots (0.28 mm) square, else it is left out and the layout says why.
 */

import { PLEX_SANS_STACK, frameFontStyle, plexWidth } from '../frame/index.ts';
import { registeredBrandFont, registeredLabelTemplate, registeredTitleBlock } from '../drawing/assets.ts';
import { DEFAULT_TEMPLATE_ID, fillTemplate, type LabelTemplate, type LabelTemplateLine } from './label-templates.ts';
import type { LabelPreset, TapeStock } from './label-presets.ts';
import { qrModules, qrPayload, qrSvg } from './qr.ts';
import type { WireLabel } from './labels.ts';
import { escapeHtml } from '../text.ts';

export const MM_PER_DOT = 25.4 / 180;
export const PT_PER_MM = 72 / 25.4;
/** the printer's unprintable lead-in at each end of a label (2 mm, 5.6 pt) */
export const END_MARGIN_MM = 5.6 / PT_PER_MM;
const LINE_SPACING = 1.15;
const MIN_QR_DOTS = 2;

export interface TapeContent {
  pn?: string;
  rev?: string;
  design?: string;
  qr?: boolean;
  qrUrl?: string;
  /** a template id; absent: the hub's, else the default */
  template?: string;
}

export interface TapeRow {
  text: string;
  /** the font family written for the line: the template's, else the hub typeface's; undefined: the bundled sans (SVG) / Arial (.lbx) */
  family: string | undefined;
  bold: boolean;
  sizePt: number;
  align: 'left' | 'center' | 'right';
  /** the line's box on the tape (mm) */
  top: number;
  height: number;
}

export interface TapeLayout {
  tape: TapeStock;
  template: LabelTemplate;
  lengthMm: number;
  autoLength: boolean;
  /** the band the text sits in: x from `left` to `left + width` (mm) */
  left: number;
  width: number;
  /** the printable band across the tape (mm from the edge) */
  bandTop: number;
  bandHeight: number;
  rows: TapeRow[];
  qr?: { x: number; y: number; size: number; payload: string; modules: number; dark: boolean };
  /** why a QR that was asked for is not on the label */
  qrNote?: string;
}

const luminance = (hex: string): number => {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
/** a tape the ink is lighter than */
export const isDarkTape = (tape: TapeStock): boolean => luminance(tape.inkColor) > luminance(tape.tapeColor);

export function labelTemplateFor(id: string | undefined): LabelTemplate {
  return (id === undefined ? undefined : registeredLabelTemplate(id)) ?? registeredLabelTemplate(registeredTitleBlock().labelTemplate ?? DEFAULT_TEMPLATE_ID) ?? (registeredLabelTemplate(DEFAULT_TEMPLATE_ID) as LabelTemplate);
}

const round = (v: number, places = 3): number => Math.round(v * 10 ** places) / 10 ** places;

export function tapeLayout(label: WireLabel, preset: LabelPreset, content: TapeContent = {}): TapeLayout {
  const tape = preset.tape as TapeStock;
  const template = labelTemplateFor(content.template);
  const bandHeight = tape.width.printableDots * MM_PER_DOT;
  const bandTop = (tape.width.mm - bandHeight) / 2;
  const facts = { lines: label.lines, designation: label.designation, end: label.end, label: label.id, ...(content.pn === undefined ? {} : { pn: content.pn }), ...(content.rev === undefined ? {} : { rev: content.rev }), ...(content.design === undefined ? {} : { design: content.design }) };
  const separator = template.separator ?? ' · ';
  type Active = { line: LabelTemplateLine; text: string };
  let active: Active[] = template.lines
    .filter((l) => (l.minTapeMm === undefined || tape.width.mm >= l.minTapeMm) && (l.maxTapeMm === undefined || tape.width.mm <= l.maxTapeMm))
    .map((line) => ({ line, text: fillTemplate(line.text, facts, separator) }))
    .filter((a) => a.text !== '');
  if (active.length === 0) active = [{ line: { text: '{headline}', weight: 'bold' }, text: fillTemplate('{headline}', facts, separator) }];
  const brand = registeredBrandFont()?.regular.family;
  const shares = active.reduce((sum, a) => sum + (a.line.share ?? 1), 0);
  let cursor = bandTop;
  const rows: TapeRow[] = active.map(({ line, text }) => {
    const height = (bandHeight * (line.share ?? 1)) / shares;
    const fit = height / LINE_SPACING / (1 / PT_PER_MM);
    const row: TapeRow = {
      text,
      family: line.family ?? template.family ?? brand,
      bold: line.weight === 'bold',
      sizePt: round(Math.max(3, Math.min(line.size ?? Infinity, fit)), 2),
      align: line.align ?? template.align ?? 'left',
      top: round(cursor),
      height: round(height),
    };
    cursor += height;
    return row;
  });

  // the QR code: only where its modules print at two dots or more
  let qr: TapeLayout['qr'];
  let qrNote: string | undefined;
  if (content.qr === true) {
    const payload = qrPayload({ ...(content.pn === undefined ? {} : { pn: content.pn }), ...(content.rev === undefined ? {} : { rev: content.rev }), ...(content.design === undefined ? {} : { design: content.design }), label: label.id }, content.qrUrl);
    const modules = qrModules(payload).length;
    const dark = isDarkTape(tape);
    const cells = modules + (dark ? 2 : 0);
    const dots = Math.floor(tape.width.printableDots / cells);
    if (dots >= MIN_QR_DOTS) {
      const size = round(cells * dots * MM_PER_DOT);
      qr = { x: 0, y: round(bandTop + (bandHeight - size) / 2), size, payload, modules, dark };
    } else qrNote = `QR omitted: ${tape.width.mm} mm tape has ${tape.width.printableDots} printable dots, ${cells} modules need ${cells * MIN_QR_DOTS}.`;
  }

  const pad = END_MARGIN_MM + (template.padding ?? 1);
  const gap = qr === undefined ? 0 : 1.5;
  const qrWidth = qr === undefined ? 0 : qr.size + gap;
  const widest = Math.max(0, ...rows.map((r) => plexWidth(r.text, r.sizePt / PT_PER_MM, r.bold ? 'semi' : 'sans')));
  const lengthSetting = template.length ?? tape.length;
  const autoLength = lengthSetting === 'auto';
  const lengthMm = autoLength ? Math.max(tape.minLengthMm, Math.ceil((2 * pad + widest + qrWidth) * 2) / 2) : (lengthSetting as number);
  const left = pad;
  const width = Math.max(1, lengthMm - 2 * pad - qrWidth);
  // a fixed length shrinks the text that does not fit, as P-touch's shrink-to-fit does
  for (const r of rows) {
    const w = plexWidth(r.text, r.sizePt / PT_PER_MM, r.bold ? 'semi' : 'sans');
    if (w > width) r.sizePt = round(Math.max(3, (r.sizePt * width) / w), 2);
  }
  if (qr !== undefined) qr.x = round(lengthMm - pad - qr.size);
  return { tape, template, lengthMm: round(lengthMm), autoLength, left: round(left), width: round(width), bandTop: round(bandTop), bandHeight: round(bandHeight), rows, ...(qr === undefined ? {} : { qr }), ...(qrNote === undefined ? {} : { qrNote }) };
}

const n3 = (v: number): string => String(round(v));
const q = (family: string | undefined): string => (family === undefined ? PLEX_SANS_STACK : `'${family.replace(/'/g, '')}',${PLEX_SANS_STACK}`);

/** One tape label as SVG in millimetres: the tape's colour, the ink's, the page being the label. */
export function tapeLabelSvg(label: WireLabel, preset: LabelPreset, content: TapeContent = {}, page?: { page: number; pages: number }): string {
  const layout = tapeLayout(label, preset, content);
  const { tape } = layout;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n3(layout.lengthMm)} ${n3(tape.width.mm)}" width="${n3(layout.lengthMm)}mm" height="${n3(tape.width.mm)}mm" data-tape="${escapeHtml(preset.id)}" data-tape-colors="${escapeHtml(tape.colors)}" data-length-mm="${n3(layout.lengthMm)}" data-auto-length="${layout.autoLength}" data-page="${page?.page ?? 1}" data-pages="${page?.pages ?? 1}" font-family="${q(undefined)}">`,
    frameFontStyle(),
    `<rect width="${n3(layout.lengthMm)}" height="${n3(tape.width.mm)}" fill="${tape.tapeColor}"${tape.clear ? ' stroke="#9aa7b0" stroke-width="0.15"' : ''}/>`,
    `<g data-label="${escapeHtml(label.id)}">`,
  ];
  if (layout.qrNote !== undefined) out.push(`<desc data-qr-omitted="true">${escapeHtml(layout.qrNote)}</desc>`);
  for (const r of layout.rows) {
    const size = r.sizePt / PT_PER_MM;
    const x = r.align === 'left' ? layout.left : r.align === 'center' ? layout.left + layout.width / 2 : layout.left + layout.width;
    const baseline = r.top + r.height / 2 + size * 0.35;
    const anchor = r.align === 'left' ? 'start' : r.align === 'center' ? 'middle' : 'end';
    out.push(`<text x="${n3(x)}" y="${n3(baseline)}" font-size="${n3(size)}"${r.bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" font-family="${q(r.family)}" fill="${tape.inkColor}">${escapeHtml(r.text)}</text>`);
  }
  if (layout.qr !== undefined) {
    const { x, y, size, payload, dark } = layout.qr;
    // on dark tape the code is the tape showing through an ink-coloured square, so it scans as a normal code
    const quiet = dark ? size / (layout.qr.modules + 2) : 0;
    if (dark) out.push(`<rect x="${n3(x)}" y="${n3(y)}" width="${n3(size)}" height="${n3(size)}" fill="${tape.inkColor}"/>`);
    out.push(qrSvgColoured(payload, x + quiet, y + quiet, size - 2 * quiet, dark ? tape.tapeColor : tape.inkColor));
  }
  out.push('</g></svg>');
  return out.join('');
}

const qrSvgColoured = (payload: string, x: number, y: number, size: number, fill: string): string => qrSvg(payload, x, y, size).replace('fill="#000000"', `fill="${fill}"`);
