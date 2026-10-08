/**
 * The sheet frame's geometry: one border, one title block, one state stamp, for
 * every sheet WireHub prints (build sheet, continuity spec, drawing, formboard,
 * BOM, labels, schematic). Everything is computed here, in millimetres, from a
 * `SheetFrameSpec`; the SVG and HTML renderers only draw what this file
 * decided, so a sheet carries the same frame wherever it is rendered, and a
 * test can measure every cell without a browser.
 *
 * The title-block layouts are data (`TITLE_BLOCKS`): the ANSI layout is a
 * full-width block along the bottom edge, the ISO 7200 layout a block at the
 * bottom right. Which one a sheet uses is a setting (Settings › Documents),
 * defaulting to the paper's own convention (`PAPERS[paper].standard`).
 *
 * Drawing language, after the schematic: IBM Plex Sans for words, IBM Plex Mono
 * for identifiers (part number, revision, sheet), 0.5 pt hairlines, small
 * upper-case captions over larger values.
 */

import { fitText, plexWidth, type PlexKind } from './measure.ts';
import { PAPERS, paperSize, paperText, type Orientation, type PaperId, type TitleBlockStandard } from './paper.ts';

/* ------------------------------------------------------------------ *
 * The spec
 * ------------------------------------------------------------------ */

export interface RevisionRow {
  rev: string;
  description: string;
  date?: string;
  by?: string;
}

export interface FrameLogo {
  pngBase64: string;
  /** width over height */
  aspect: number;
}

export interface FrameExtras {
  material?: string;
  /** general notes, one per line */
  notes?: readonly string[];
  tolerances?: readonly (readonly [string, string])[];
}

export interface SheetFrameSpec {
  paper: PaperId;
  orientation: Orientation;
  standard: TitleBlockStandard;
  /** `full`: the whole title block; `strip`: the one-row strip continuation pages, tiles and label sheets carry */
  variant: 'full' | 'strip';
  /** the document's kind, the title cell's caption: `Build sheet` */
  kind: string;
  org?: string;
  logo?: FrameLogo;
  title: string;
  pn?: string;
  rev?: string;
  /** `RELEASED`, `UNRELEASED · awaiting approval`, … */
  state?: string;
  drawn?: string;
  checked?: string;
  date?: string;
  /** `2 of 5`; absent hides the cell on a full block, and leaves it for the page counter on a strip */
  sheet?: string;
  /** a revision table above the title block (drawings) */
  revisions?: readonly RevisionRow[];
  extras?: FrameExtras;
  /** paper edge to border, mm (default `FRAME_METRICS.margin`); a label sheet, whose stock owns most of the page, keeps its frame to the edge band */
  inset?: number;
}

/* ------------------------------------------------------------------ *
 * Metrics, shared by every sheet
 * ------------------------------------------------------------------ */

export const FRAME_METRICS = {
  /** paper edge to border, mm */
  margin: 8,
  /** border to content, mm (flow documents; drawings place their own content) */
  pad: 4,
  /** gap between the content area and the revision table or title block, mm */
  gap: 2.5,
  /** hairline, mm (0.5 pt) */
  rule: 0.1764,
  /** the border, mm (0.75 pt) */
  border: 0.2646,
  /** cell padding, mm */
  cellX: 1.4,
  /** the strip's height, mm */
  stripHeight: 7.5,
  /** type, pt */
  captionPt: 4.8,
  valuePt: 8.5,
  titlePt: 9.5,
  stripCaptionPt: 4.2,
  stripValuePt: 7,
  /** the revision table */
  revisionWidth: 118,
  revisionRow: 4.2,
  revisionMax: 5,
  /** the stamp, mm */
  stampHeight: 4.6,
} as const;

export const PT_MM = 25.4 / 72;

export type Field = 'org' | 'title' | 'pn' | 'rev' | 'state' | 'drawn' | 'checked' | 'date' | 'paper' | 'sheet';

interface CellDef {
  field: Field;
  span: number;
}

interface RowDef {
  height: number;
  cells: readonly CellDef[];
}

export interface TitleBlockLayout {
  id: TitleBlockStandard;
  label: string;
  /** the full block: its width (`null` = the whole frame) and rows */
  full: { width: number | null; rows: readonly RowDef[] };
  /** the strip: one row, the whole frame */
  strip: RowDef;
}

const STRIP_CELLS: readonly CellDef[] = [
  { field: 'org', span: 2.1 },
  { field: 'title', span: 4.2 },
  { field: 'pn', span: 2.2 },
  { field: 'rev', span: 0.7 },
  { field: 'state', span: 1.5 },
  { field: 'paper', span: 0.95 },
  { field: 'sheet', span: 1.05 },
];

export const TITLE_BLOCKS: Readonly<Record<TitleBlockStandard, TitleBlockLayout>> = {
  ansi: {
    id: 'ansi',
    label: 'ANSI (full-width block)',
    full: {
      width: null,
      rows: [
        { height: 11, cells: [{ field: 'title', span: 4.4 }, { field: 'pn', span: 2.6 }, { field: 'rev', span: 1 }, { field: 'state', span: 1.9 }] },
        {
          height: 9,
          cells: [
            { field: 'org', span: 3.6 },
            { field: 'drawn', span: 1.3 },
            { field: 'checked', span: 1.3 },
            { field: 'date', span: 1.3 },
            { field: 'paper', span: 1.2 },
            { field: 'sheet', span: 1.1 },
          ],
        },
      ],
    },
    strip: { height: FRAME_METRICS.stripHeight, cells: STRIP_CELLS },
  },
  iso: {
    id: 'iso',
    label: 'ISO 7200 (block at the bottom right)',
    full: {
      width: 180,
      rows: [
        { height: 8.5, cells: [{ field: 'org', span: 3.2 }, { field: 'state', span: 1.6 }] },
        { height: 10.5, cells: [{ field: 'title', span: 1 }] },
        { height: 8.5, cells: [{ field: 'pn', span: 2.4 }, { field: 'rev', span: 0.8 }, { field: 'paper', span: 1 }] },
        { height: 8.5, cells: [{ field: 'drawn', span: 1 }, { field: 'checked', span: 1 }, { field: 'date', span: 1 }, { field: 'sheet', span: 0.8 }] },
      ],
    },
    strip: { height: FRAME_METRICS.stripHeight, cells: STRIP_CELLS },
  },
};

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tone = 'ink' | 'muted' | 'ok' | 'warn';

export interface FrameText {
  lines: string[];
  /** pt */
  size: number;
  kind: PlexKind;
  tone: Tone;
}

export interface FrameCell extends Rect {
  field: Field | 'material' | 'notes' | 'tolerances' | 'revision';
  caption: string;
  /** the value, fitted: every line measures within the cell */
  value: FrameText;
  /** the caption's size, pt */
  captionPt: number;
  /** the logo, inside the org cell: its box */
  logo?: Rect & { pngBase64: string };
  /** where the value starts, mm from the cell's left (a logo pushes it right) */
  inset: number;
}

export interface FrameGeometry {
  spec: SheetFrameSpec;
  page: { width: number; height: number };
  border: Rect;
  /** the title block (or strip) */
  title: Rect;
  titleCells: FrameCell[];
  revision?: Rect;
  revisionCells: FrameCell[];
  /** what is left for the sheet's own drawing, inside the border */
  content: Rect;
  /** the state stamp's word, when the state calls for one */
  stamp?: string;
}

const STAMPED = /^(UNRELEASED|UNAPPROVED|DRAFT|PRELIM\w*|OBSOLETE|SUPERSEDED|REJECTED|WITHDRAWN)\b/i;

/** The word the corner stamp carries for a state, or `undefined` for a quiet one (released, or none given). */
export function stampOf(state: string | undefined): string | undefined {
  if (state === undefined) return undefined;
  const m = STAMPED.exec(state.trim());
  return m === null ? undefined : (m[1] as string).toUpperCase();
}

export function toneOfState(state: string | undefined): Tone {
  if (state === undefined || state.trim() === '') return 'muted';
  if (stampOf(state) !== undefined) return 'warn';
  return /^RELEASED\b/i.test(state.trim()) ? 'ok' : 'ink';
}

const CAPTIONS: Readonly<Record<Field, string>> = {
  org: 'ISSUED BY',
  title: 'TITLE',
  pn: 'PART NUMBER',
  rev: 'REV',
  state: 'STATE',
  drawn: 'DRAWN',
  checked: 'CHECKED',
  date: 'DATE',
  paper: 'PAPER',
  sheet: 'SHEET',
};

function valueOf(spec: SheetFrameSpec, field: Field): { text: string; kind: PlexKind; tone: Tone } {
  const dash = '—';
  switch (field) {
    case 'org':
      return { text: spec.org ?? dash, kind: 'sans', tone: spec.org === undefined ? 'muted' : 'ink' };
    case 'title':
      return { text: spec.title === '' ? dash : spec.title, kind: 'semi', tone: 'ink' };
    case 'pn':
      return { text: spec.pn ?? dash, kind: 'monoMedium', tone: spec.pn === undefined ? 'muted' : 'ink' };
    case 'rev':
      return { text: spec.rev ?? dash, kind: 'monoMedium', tone: spec.rev === undefined ? 'muted' : 'ink' };
    case 'state':
      return { text: spec.state ?? dash, kind: 'semi', tone: toneOfState(spec.state) };
    case 'drawn':
      return { text: spec.drawn ?? dash, kind: 'sans', tone: spec.drawn === undefined ? 'muted' : 'ink' };
    case 'checked':
      return { text: spec.checked ?? dash, kind: 'sans', tone: spec.checked === undefined ? 'muted' : 'ink' };
    case 'date':
      return { text: spec.date ?? dash, kind: 'mono', tone: spec.date === undefined ? 'muted' : 'ink' };
    case 'paper':
      return { text: paperText(spec.paper), kind: 'mono', tone: 'ink' };
    case 'sheet':
      return { text: spec.sheet ?? '', kind: 'mono', tone: 'ink' };
  }
}

function makeCell(spec: SheetFrameSpec, def: CellDef, box: Rect, strip: boolean): FrameCell {
  const { cellX } = FRAME_METRICS;
  const captionPt = strip ? FRAME_METRICS.stripCaptionPt : FRAME_METRICS.captionPt;
  const base = strip ? FRAME_METRICS.stripValuePt : def.field === 'title' ? FRAME_METRICS.titlePt : FRAME_METRICS.valuePt;
  const v = valueOf(spec, def.field);
  let inset = cellX;
  let logo: FrameCell['logo'];
  if (def.field === 'org' && spec.logo !== undefined && !strip) {
    const lh = box.h - 2.4;
    const lw = Math.min(lh * spec.logo.aspect, box.w * 0.4);
    logo = { x: box.x + cellX, y: box.y + 1.2, w: lw, h: lw / spec.logo.aspect, pngBase64: spec.logo.pngBase64 };
    inset = cellX + lw + 1.6;
  }
  const width = box.w - inset - cellX;
  const lineRoom = box.h - 2.4;
  const lines = def.field === 'title' && !strip ? Math.max(1, Math.min(2, Math.floor(lineRoom / (base * PT_MM * 1.2)))) : 1;
  const fitted = fitText(v.text, width / PT_MM, base, v.kind, lines);
  return {
    ...box,
    field: def.field,
    caption: def.field === 'title' ? spec.kind.toUpperCase() : CAPTIONS[def.field],
    value: { lines: fitted.lines, size: fitted.size, kind: v.kind, tone: v.tone },
    captionPt,
    ...(logo === undefined ? {} : { logo }),
    inset,
  };
}

function rowCells(spec: SheetFrameSpec, row: RowDef, x: number, y: number, width: number, strip: boolean): FrameCell[] {
  const cells = row.cells.filter((c) => c.field !== 'sheet' || spec.sheet !== undefined);
  const total = cells.reduce((sum, c) => sum + c.span, 0);
  let cx = x;
  return cells.map((def, i) => {
    const w = i === cells.length - 1 ? x + width - cx : Math.round(((width * def.span) / total) * 1000) / 1000;
    const cell = makeCell(spec, def, { x: cx, y, w, h: row.height }, strip);
    cx += w;
    return cell;
  });
}

function extrasRow(spec: SheetFrameSpec, x: number, y: number, width: number, forceHeight?: number): { cells: FrameCell[]; height: number } | undefined {
  const e = spec.extras;
  if (e === undefined) return undefined;
  const tol = e.tolerances ?? [];
  const notes = e.notes ?? [];
  if (e.material === undefined && notes.length === 0 && tol.length === 0) return undefined;
  const small = FRAME_METRICS.stripValuePt;
  const lineH = small * PT_MM * 1.25;
  const height = forceHeight ?? Math.max(9, 4.6 + Math.max(notes.length, tol.length) * lineH);
  const defs: { field: FrameCell['field']; caption: string; span: number; text: string[]; kind: PlexKind }[] = [
    { field: 'material', caption: 'MATERIAL', span: 1.3, text: [e.material ?? '—'], kind: 'sans' },
    { field: 'notes', caption: 'NOTES', span: 3.4, text: notes.length === 0 ? ['—'] : [...notes], kind: 'sans' },
    { field: 'tolerances', caption: 'TOLERANCES', span: 2.2, text: tol.map(([k, v]) => `${k}  ${v}`), kind: 'mono' },
  ];
  const shown = defs.filter((d) => d.field !== 'tolerances' || tol.length > 0);
  const total = shown.reduce((s, d) => s + d.span, 0);
  let cx = x;
  const cells = shown.map((d, i) => {
    const w = i === shown.length - 1 ? x + width - cx : Math.round(((width * d.span) / total) * 1000) / 1000;
    const room = w - 2 * FRAME_METRICS.cellX;
    const lines = d.text.map((t) => fitText(t, room / PT_MM, small, d.kind, 1));
    const size = Math.min(small, ...lines.map((l) => l.size));
    const cell: FrameCell = {
      x: cx,
      y,
      w,
      h: height,
      field: d.field,
      caption: d.caption,
      value: { lines: lines.map((l) => l.lines[0] ?? ''), size, kind: d.kind, tone: 'ink' },
      captionPt: FRAME_METRICS.captionPt,
      inset: FRAME_METRICS.cellX,
    };
    cx += w;
    return cell;
  });
  return { cells, height };
}

function revisionCells(rows: readonly RevisionRow[], box: Rect): FrameCell[] {
  const cols = [
    { id: 'REV', w: 12, kind: 'monoMedium' as PlexKind },
    { id: 'DESCRIPTION', w: box.w - 12 - 20 - 14, kind: 'sans' as PlexKind },
    { id: 'DATE', w: 20, kind: 'mono' as PlexKind },
    { id: 'BY', w: 14, kind: 'sans' as PlexKind },
  ];
  const cells: FrameCell[] = [];
  const head = FRAME_METRICS.revisionRow;
  const size = 6.4;
  const trimmed = rows.length > FRAME_METRICS.revisionMax ? rows.slice(rows.length - (FRAME_METRICS.revisionMax - 1)) : rows;
  const earlier = rows.length - trimmed.length;
  const lines: { rev: string; description: string; date: string; by: string }[] = [
    ...(earlier > 0 ? [{ rev: '…', description: `${earlier} earlier revision${earlier === 1 ? '' : 's'}`, date: '', by: '' }] : []),
    ...trimmed.map((r) => ({ rev: r.rev, description: r.description, date: r.date ?? '', by: r.by ?? '' })),
  ];
  let cx = box.x;
  cols.forEach((col) => {
    cells.push({
      x: cx, y: box.y, w: col.w, h: head, field: 'revision', caption: col.id, captionPt: FRAME_METRICS.captionPt, inset: FRAME_METRICS.cellX,
      value: { lines: [], size, kind: col.kind, tone: 'muted' },
    });
    lines.forEach((row, i) => {
      const text = col.id === 'REV' ? row.rev : col.id === 'DESCRIPTION' ? row.description : col.id === 'DATE' ? row.date : row.by;
      const fit = fitText(text === '' ? ' ' : text, (col.w - 2 * FRAME_METRICS.cellX) / PT_MM, size, col.kind, 1);
      cells.push({
        x: cx, y: box.y + head * (i + 1), w: col.w, h: head, field: 'revision', caption: '', captionPt: 0, inset: FRAME_METRICS.cellX,
        value: { lines: text === '' ? [] : fit.lines, size: fit.size, kind: col.kind, tone: 'ink' },
      });
    });
    cx += col.w;
  });
  return cells;
}

export function frameGeometry(spec: SheetFrameSpec): FrameGeometry {
  const { gap } = FRAME_METRICS;
  const margin = spec.inset ?? FRAME_METRICS.margin;
  const page = paperSize(spec.paper, spec.orientation);
  const border: Rect = { x: margin, y: margin, w: page.width - 2 * margin, h: page.height - 2 * margin };
  const layout = TITLE_BLOCKS[spec.standard];
  let titleCells: FrameCell[] = [];
  let titleRect: Rect;
  if (spec.variant === 'strip') {
    const h = layout.strip.height;
    titleRect = { x: border.x, y: border.y + border.h - h, w: border.w, h };
    titleCells = rowCells(spec, layout.strip, titleRect.x, titleRect.y, titleRect.w, true);
  } else {
    const width = layout.full.width === null ? border.w : Math.min(layout.full.width, border.w);
    // ANSI stacks the notes row over the block; ISO has room beside it and puts them there
    const beside = layout.full.width !== null && border.w - width >= 60;
    const stacked = beside ? undefined : extrasRow(spec, 0, 0, width);
    const rowsHeight = layout.full.rows.reduce((s, r) => s + r.height, 0) + (stacked?.height ?? 0);
    titleRect = { x: border.x + border.w - width, y: border.y + border.h - rowsHeight, w: width, h: rowsHeight };
    let y = titleRect.y;
    if (stacked !== undefined) {
      const placed = extrasRow(spec, titleRect.x, y, width);
      if (placed !== undefined) {
        titleCells.push(...placed.cells);
        y += placed.height;
      }
    }
    for (const row of layout.full.rows) {
      titleCells.push(...rowCells(spec, row, titleRect.x, y, width, false));
      y += row.height;
    }
    if (beside) {
      const placed = extrasRow(spec, border.x, titleRect.y, border.w - width, rowsHeight);
      if (placed !== undefined) titleCells.push(...placed.cells);
    }
  }
  let revision: Rect | undefined;
  let cells: FrameCell[] = [];
  let bottom = titleRect.y;
  if (spec.revisions !== undefined) {
    const shown = Math.min(spec.revisions.length, FRAME_METRICS.revisionMax);
    const h = FRAME_METRICS.revisionRow * (shown + 1);
    revision = { x: border.x + border.w - FRAME_METRICS.revisionWidth, y: titleRect.y - h, w: FRAME_METRICS.revisionWidth, h };
    cells = revisionCells(spec.revisions, revision);
    bottom = revision.y;
  }
  const content: Rect = { x: border.x, y: border.y, w: border.w, h: bottom - gap - border.y };
  const stamp = stampOf(spec.state);
  return { spec, page, border, title: titleRect, titleCells, ...(revision === undefined ? {} : { revision }), revisionCells: cells, content, ...(stamp === undefined ? {} : { stamp }) };
}

/** The widest a stamp's word prints, mm (for layout checks and HTML boxes). */
export function stampWidth(word: string): number {
  return plexWidth(word, 7, 'monoMedium', 0.06) * PT_MM + 3.6;
}

/** The page's size in millimetres, for a spec. */
export function framePage(spec: Pick<SheetFrameSpec, 'paper' | 'orientation'>): { width: number; height: number } {
  return paperSize(spec.paper, spec.orientation);
}

export { PAPERS };
