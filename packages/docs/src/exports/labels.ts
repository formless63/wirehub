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
  /** the label's text lines, top to bottom: `W1-A`, `at J1`, `to J2` */
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
                ...(here.length === 0 ? [] : [`at ${here.join(', ')}`]),
                ...(there.length === 0 ? [] : [`to ${there.join(', ')}`]),
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

/** 3 × 7 labels of 63.5 × 38.1 mm on A4 (the common L7160 stock). */
export const LABEL_LAYOUT_A4: LabelSheetLayout = {
  pageWidth: 210, pageHeight: 297, columns: 3, rows: 7, labelWidth: 63.5, labelHeight: 38.1, marginLeft: 7.2, marginTop: 15.1, gapX: 2.5, gapY: 0,
};

/** 3 × 10 labels of 66.7 × 25.4 mm on US letter (the common 5160 stock). */
export const LABEL_LAYOUT_LETTER: LabelSheetLayout = {
  pageWidth: 215.9, pageHeight: 279.4, columns: 3, rows: 10, labelWidth: 66.7, labelHeight: 25.4, marginLeft: 4.8, marginTop: 12.7, gapX: 3.1, gapY: 0,
};

export interface LabelSheetOptions {
  paper?: 'A4' | 'letter';
  layout?: LabelSheetLayout;
  /** 1-based page, when the labels need more than one */
  page?: number;
  /** copies of each label (a label is printed twice to flag both sides of a wire) */
  copies?: number;
}

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);

export function labelSheetPages(count: number, options: LabelSheetOptions = {}): number {
  const layout = options.layout ?? (options.paper === 'letter' ? LABEL_LAYOUT_LETTER : LABEL_LAYOUT_A4);
  return Math.max(1, Math.ceil((count * (options.copies ?? 1)) / (layout.columns * layout.rows)));
}

/**
 * One page of the label sheet as SVG, in millimetres, on the label stock's grid:
 * print at 100% (no scale to fit). Cut guides are hairlines in light grey.
 */
export function labelSheetSvg(labels: readonly WireLabel[], options: LabelSheetOptions = {}): string {
  const layout = options.layout ?? (options.paper === 'letter' ? LABEL_LAYOUT_LETTER : LABEL_LAYOUT_A4);
  const copies = Math.max(1, Math.floor(options.copies ?? 1));
  const all = labels.flatMap((l) => Array.from({ length: copies }, () => l));
  const perPage = layout.columns * layout.rows;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pages);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n3(layout.pageWidth)} ${n3(layout.pageHeight)}" width="${n3(layout.pageWidth)}mm" height="${n3(layout.pageHeight)}mm" data-page="${page}" data-pages="${pages}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${n3(layout.pageWidth)}" height="${n3(layout.pageHeight)}" fill="#ffffff"/>`,
  ];
  slice.forEach((label, index) => {
    const col = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const x = layout.marginLeft + col * (layout.labelWidth + layout.gapX);
    const y = layout.marginTop + row * (layout.labelHeight + layout.gapY);
    out.push(`<g data-label="${escapeHtml(label.id)}">`);
    out.push(`<rect x="${n3(x)}" y="${n3(y)}" width="${n3(layout.labelWidth)}" height="${n3(layout.labelHeight)}" rx="1.5" fill="none" stroke="#cfcfcf" stroke-width="0.15"/>`);
    // the headline scales with the label's height; the detail lines sit under it
    const head = Math.min(layout.labelHeight * 0.34, 7);
    const detail = Math.min(layout.labelHeight * 0.2, 3.8);
    out.push(`<text x="${n3(x + 2.5)}" y="${n3(y + 2.5 + head * 0.85)}" font-size="${n3(head)}" font-weight="bold" fill="#000000">${escapeHtml(label.lines[0] ?? '')}</text>`);
    label.lines.slice(1).forEach((line, i) => {
      out.push(`<text x="${n3(x + 2.5)}" y="${n3(y + 2.5 + head + detail * (i * 1.25 + 1.3))}" font-size="${n3(detail)}" fill="#000000">${escapeHtml(line)}</text>`);
    });
    out.push('</g>');
  });
  out.push('</svg>');
  return out.join('');
}
