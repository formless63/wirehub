/**
 * Wire identification labels: what to print on the marker at each end of each
 * wire run, and where on the wire to put it.
 *
 * Generated, never authored: the designation of a run is `W<n>`, n counting the
 * design's wire segments in order (the trunk first, as the bench does); an end
 * is `W<n>-A` or `W<n>-B` (`a` = source side, `b` = destination side), and its
 * label also names what the end connects to. Same design, same labels.
 * Runs the contract manufacturer supplies terminated are not labelled here.
 */

import { findWire, resolveElementPath, type CableDesign, type Db } from '@wirehub/model';

import { trunkSegment } from '../drawing/model.ts';
import { suppliedEnds } from '../supplied.ts';
import { compareStrings, escapeHtml, htmlTable } from '../text.ts';
import { PLEX_MONO_STACK, PLEX_SANS_STACK, fitText, frameFontStyle, frameGeometry, frameSvgGroup, type PaperId, type SheetFrameSpec } from '../frame/index.ts';
import { registeredTitleBlock } from '../drawing/assets.ts';
import { LABEL_PRESETS, defaultLabelPreset, labelPresetOf, type LabelPreset } from './label-presets.ts';
import { qrPayload, qrSvg } from './qr.ts';
import { PAPERS } from '../frame/paper.ts';
import type { Table } from './table.ts';

export interface WireLabel {
  /** `trunk/a` */
  id: string;
  segment: string;
  end: 'a' | 'b';
  /** the run's designation: `W1`, or the run's own label */
  designation: string;
  /** a core's conductor path, for a per-core label */
  core?: string;
  /** the label's text lines, top to bottom: `W1-A`, `Source end: J1`, `Destination end: J2` (this end first) */
  lines: string[];
  /** distance from the end of the jacket to the near edge of the marker (mm) */
  offsetMm: number;
  /** the same in words */
  position: string;
  stock?: string;
  lengthMm?: number;
}

const DEFAULT_OFFSET_MM = 40;
const MIN_OFFSET_MM = 10;

/** The words for a wire end: `a` is the source end, `b` the destination end. */
export function endWord(end: 'a' | 'b'): 'Source end' | 'Destination end' {
  return end === 'a' ? 'Source end' : 'Destination end';
}

function designationOf(design: CableDesign, instance: string): string {
  const own = design.instances.connectors.find((c) => c.id === instance)?.label?.trim();
  return own !== undefined && own !== '' ? own : instance.toUpperCase();
}

function connectedTo(design: CableDesign, segment: string, end: 'a' | 'b'): string[] {
  const out = new Set<string>();
  for (const joint of design.joints) {
    for (const [near, far] of [[joint.a, joint.b], [joint.b, joint.a]] as const) {
      if (near.instance === segment && near.end === end && far.instance !== segment) out.add(far.instance);
    }
  }
  return [...out].sort(compareStrings);
}

/** One label per end of every wire run, in designation order, `a` before `b`. */
export function deriveLabels(design: CableDesign, db: Db): WireLabel[] {
  const trunk = trunkSegment(design, db)?.id;
  const covered = new Set(suppliedEnds(design, db).flatMap((s) => [...s.covers]));
  const order = [
    ...design.instances.segments.filter((s) => s.id === trunk),
    ...design.instances.segments.filter((s) => s.id !== trunk),
  ];
  const labels: WireLabel[] = [];
  let n = 0;
  for (const segment of order) {
    if (covered.has(segment.id)) continue;
    n += 1;
    const designation = segment.label?.trim() || `W${n}`;
    const wire = findWire(db, segment.def);
    const offset =
      segment.lengthMm === undefined ? DEFAULT_OFFSET_MM : Math.max(MIN_OFFSET_MM, Math.min(DEFAULT_OFFSET_MM, Math.floor(segment.lengthMm / 4)));
    for (const end of ['a', 'b'] as const) {
      const here = connectedTo(design, segment.id, end).map((i) => designationOf(design, i));
      const there = connectedTo(design, segment.id, end === 'a' ? 'b' : 'a').map((i) => designationOf(design, i));
      // an end's own text replaces the generated lines (at most 3 of 40 characters)
      const own = (segment.endLabels?.[end] ?? []).map((l) => l.trim()).filter((l) => l !== '').slice(0, 3).map((l) => l.slice(0, 40));
      labels.push({
        id: `${segment.id}/${end}`,
        segment: segment.id,
        end,
        designation,
        lines:
          own.length > 0
            ? own
            : [
                `${designation}-${end.toUpperCase()}`,
                ...(here.length === 0 ? [] : [`${endWord(end)}: ${here.join(', ')}`]),
                ...(there.length === 0 ? [] : [`${endWord(end === 'a' ? 'b' : 'a')}: ${there.join(', ')}`]),
              ],
        offsetMm: offset,
        position: `${offset} mm from the ${end === 'a' ? 'source' : 'destination'} end of the jacket`,
        ...(wire?.partNumber === undefined ? {} : { stock: wire.partNumber }),
        ...(segment.lengthMm === undefined ? {} : { lengthMm: segment.lengthMm }),
      });
    }
    // per-core labels: only the cores someone named, at both ends, after the run's own labels
    for (const [path, raw] of Object.entries(segment.coreLabels ?? {}).sort(([x], [y]) => compareStrings(x, y))) {
      const text = raw.trim().slice(0, 40);
      if (text === '') continue;
      // a label for a core the stock does not have is not printed (the validator warns about it)
      if (wire === undefined || resolveElementPath(wire.structure, path)?.kind !== 'conductor') continue;
      for (const end of ['a', 'b'] as const) {
        labels.push({
          id: `${segment.id}/${end}/${path}`,
          segment: segment.id,
          end,
          designation,
          core: path,
          lines: [text, `${designation}-${end.toUpperCase()} · ${path}`],
          offsetMm: DEFAULT_OFFSET_MM,
          position: `on the ${path} core, ${DEFAULT_OFFSET_MM} mm from the ${end === 'a' ? 'source' : 'destination'} end of the jacket`,
          ...(wire?.partNumber === undefined ? {} : { stock: wire.partNumber }),
          ...(segment.lengthMm === undefined ? {} : { lengthMm: segment.lengthMm }),
        });
      }
    }
  }
  return labels;
}

export const LABEL_HEADERS = ['label_id', 'segment', 'end', 'designation', 'line_1', 'line_2', 'line_3', 'offset_mm', 'position', 'stock_part_number', 'length_mm', 'core'] as const;

export function labelsTable(labels: readonly WireLabel[]): Table {
  return {
    name: 'Labels',
    headers: LABEL_HEADERS,
    rows: labels.map((l) => [
      l.id, l.segment, l.end, l.designation, l.lines[0] ?? '', l.lines[1] ?? '', l.lines[2] ?? '', l.offsetMm, l.position, l.stock ?? '', l.lengthMm ?? '', l.core ?? '',
    ]),
  };
}

/** The build sheet's block: the same labels, in words a bench can apply. */
export function labelsHtml(labels: readonly WireLabel[]): string {
  if (labels.length === 0) return '';
  return htmlTable(
    'cs-cut cs-labels',
    ['Label', 'Reads', 'Position'],
    labels.map((l) => [l.lines[0] ?? '', l.lines.slice(1).join(' · '), `${l.offsetMm} mm from end`]),
  ).replace('<table', '<table data-labels="wire"');
}

/* ------------------------------------------------------------------ *
 * The printable sheet
 * ------------------------------------------------------------------ */

export interface LabelSheetLayout {
  /** page size in mm */
  pageWidth: number;
  pageHeight: number;
  columns: number;
  rows: number;
  labelWidth: number;
  labelHeight: number;
  /** left / top margin to the first label (mm) */
  marginLeft: number;
  marginTop: number;
  /** gutter between labels (mm) */
  gapX: number;
  gapY: number;
}

/** 3 × 7 labels of 63.5 × 38.1 mm on A4 (the common L7160 stock): the `a4-l7160` preset (`label-presets.ts`). */
export const LABEL_LAYOUT_A4: LabelSheetLayout = (LABEL_PRESETS.find((p) => p.id === 'a4-l7160') as LabelPreset).layout;

/** 3 × 10 labels of 66.7 × 25.4 mm on US letter (the common 5160 stock): the `letter-5160` preset. */
export const LABEL_LAYOUT_LETTER: LabelSheetLayout = (LABEL_PRESETS.find((p) => p.id === 'letter-5160') as LabelPreset).layout;

export interface LabelSheetOptions {
  /** label stock comes in two grids: A4 and Letter; any other paper takes the one of its standard (ISO sizes A4, ANSI sizes Letter) */
  paper?: PaperId;
  /** the shared frame's strip and state stamp, printed in the free band under the labels (`frame/`); absent: the labels alone */
  frame?: SheetFrameSpec;
  layout?: LabelSheetLayout;
  /** a label-stock preset id (`label-presets.ts`): the sheet takes its geometry; default: the hub's setting, else the paper's own grid */
  preset?: string;
  /** a QR code on each label (the part number and revision, or the URL pattern); default: the hub's setting, else none */
  qr?: boolean;
  /** the QR's URL pattern, `{pn}` `{rev}` `{design}` `{label}`; default: the hub's setting, else the part number and revision as text */
  qrUrl?: string;
  /** the part number and revision the label carries; default: the frame's */
  pn?: string;
  rev?: string;
  /** the design's id, for a URL pattern */
  design?: string;
  /** 1-based page, when the labels need more than one */
  page?: number;
  /** copies of each label (a label is printed twice to flag both sides of a wire) */
  copies?: number;
}

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Which stock grid a paper prints on: Letter for Letter, else by the paper's own standard. */
export function labelPaperOf(paper: PaperId | undefined): 'A4' | 'letter' {
  if (paper === undefined || paper === 'A4') return 'A4';
  return paper === 'letter' ? 'letter' : PAPERS[paper].standard === 'ansi' ? 'letter' : 'A4';
}

/** The preset a sheet is laid out on: the layout it was handed, else the preset asked for, else the hub's, else the paper's grid. */
export function labelPresetFor(options: LabelSheetOptions): LabelPreset {
  const named = labelPresetOf(options.preset) ?? labelPresetOf(registeredTitleBlock().labelPreset);
  return named ?? defaultLabelPreset(labelPaperOf(options.paper));
}

function layoutOf(options: LabelSheetOptions): LabelSheetLayout {
  return options.layout ?? labelPresetFor(options).layout;
}

export function labelSheetPages(count: number, options: LabelSheetOptions = {}): number {
  const layout = layoutOf(options);
  return Math.max(1, Math.ceil((count * (options.copies ?? 1)) / (layout.columns * layout.rows)));
}

/**
 * One page of the label sheet as SVG, in millimetres, on the label stock's grid:
 * print at 100% (no scale to fit). Cut guides are hairlines in light grey.
 */
export function labelSheetSvg(labels: readonly WireLabel[], options: LabelSheetOptions = {}): string {
  const layout = layoutOf(options);
  const copies = Math.max(1, Math.floor(options.copies ?? 1));
  const all = labels.flatMap((l) => Array.from({ length: copies }, () => l));
  const perPage = layout.columns * layout.rows;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pages);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n3(layout.pageWidth)} ${n3(layout.pageHeight)}" width="${n3(layout.pageWidth)}mm" height="${n3(layout.pageHeight)}mm" data-page="${page}" data-pages="${pages}" font-family="${PLEX_SANS_STACK}">`,
    frameFontStyle(),
    `<rect width="${n3(layout.pageWidth)}" height="${n3(layout.pageHeight)}" fill="#ffffff"/>`,
  ];
  const pn = options.pn ?? options.frame?.pn;
  const rev = options.rev ?? options.frame?.rev;
  const withQr = options.qr ?? registeredTitleBlock().labelQr === true;
  const pattern = options.qrUrl ?? registeredTitleBlock().labelQrUrl;
  const pad = Math.min(2.5, layout.labelHeight * 0.1);
  slice.forEach((label, index) => {
    const col = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const x = layout.marginLeft + col * (layout.labelWidth + layout.gapX);
    const y = layout.marginTop + row * (layout.labelHeight + layout.gapY);
    out.push(`<g data-label="${escapeHtml(label.id)}">`);
    // a single label on a roll is its own page: no cut guide
    if (layout.columns * layout.rows > 1) out.push(`<rect x="${n3(x)}" y="${n3(y)}" width="${n3(layout.labelWidth)}" height="${n3(layout.labelHeight)}" rx="1.5" fill="none" stroke="#cfcfcf" stroke-width="0.15"/>`);
    const qrSize = withQr ? Math.min(layout.labelHeight - 2 * pad, layout.labelWidth * 0.42, 22) : 0;
    const room = layout.labelWidth - 2 * pad - (withQr ? qrSize + pad : 0);
    // the headline scales with the label's height; the detail lines and the part number sit under it, the whole shrunk to fit
    const lines = label.lines.slice(1);
    const pnText = pn === undefined || pn === '' ? undefined : `${pn}${rev === undefined || rev === '' || rev === '—' ? '' : ` rev ${rev}`}`;
    let head = Math.min(layout.labelHeight * 0.3, 7);
    let detail = Math.min(layout.labelHeight * 0.16, 3.6);
    const content = head * 1.05 + lines.length * detail * 1.25 + (pnText === undefined ? 0 : detail * 1.35);
    const k = Math.min(1, (layout.labelHeight - 2 * pad) / content);
    head *= k;
    detail *= k;
    let cursor = y + pad + head * 0.85;
    const headFit = fitText(label.lines[0] ?? '', room, head, 'semi', 1);
    out.push(`<text x="${n3(x + pad)}" y="${n3(cursor)}" font-size="${n3(headFit.size)}" font-weight="bold" fill="#000000">${escapeHtml(headFit.lines[0] ?? '')}</text>`);
    cursor += head * 0.2;
    for (const line of lines) {
      cursor += detail * 1.25;
      const fit = fitText(line, room, detail, 'sans', 1);
      out.push(`<text x="${n3(x + pad)}" y="${n3(cursor)}" font-size="${n3(fit.size)}" fill="#000000">${escapeHtml(fit.lines[0] ?? '')}</text>`);
    }
    if (pnText !== undefined) {
      const fit = fitText(pnText, room, detail * 0.9, 'mono', 1);
      out.push(`<text x="${n3(x + pad)}" y="${n3(y + layout.labelHeight - pad)}" font-size="${n3(fit.size)}" font-family="${PLEX_MONO_STACK}" fill="#000000" data-label-pn="${escapeHtml(pnText)}">${escapeHtml(fit.lines[0] ?? '')}</text>`);
    }
    if (withQr) out.push(qrSvg(qrPayload({ ...(pn === undefined ? {} : { pn }), ...(rev === undefined ? {} : { rev }), ...(options.design === undefined ? {} : { design: options.design }), label: label.id }, pattern), x + layout.labelWidth - pad - qrSize, y + (layout.labelHeight - qrSize) / 2, qrSize));
    out.push('</g>');
  });
  if (options.frame !== undefined && layout.columns * layout.rows > 1) {
    // the strip sits in the band under the stock, 5 mm from the edge; the stock itself is never framed (its registration is the printer's)
    const spec: SheetFrameSpec = { ...options.frame, paper: labelPaperOf(options.paper), orientation: 'portrait', variant: 'strip', inset: 5, sheet: `${page} of ${pages}` };
    out.push(frameSvgGroup(frameGeometry(spec), { border: false }));
  }
  out.push('</svg>');
  return out.join('');
}
