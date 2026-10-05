/**
 * Render a design's documents without a browser (`docs/exports.md`):
 *
 *   kind        formats
 *   schematic   svg · pdf
 *   build-sheet html · svg · pdf · csv (the wire list)
 *   bom         html · svg · pdf · csv
 *   test-spec   html · svg · pdf · csv (the continuity export)
 *   drawing     html · svg · pdf
 *   labels      svg (the label sheet) · pdf · csv
 *   formboard   svg (the overview, or one tile with ?page=) · pdf (overview then every tile) · html (all pages)
 *
 * `html` is the browser's own render, byte for byte (same functions). `svg` and
 * `pdf` of the three text sheets are a plain page layout of the sheet's text
 * (`layout.ts`) — tables and notes, without the figures — because laying out
 * HTML needs a browser engine this repository does not ship; the schematic,
 * the drawing sheet and the label sheet are drawings already, so they come out
 * as themselves (SVG) or as a rasterised page (PDF); the formboard is the exception, its
 * PDF is vector (`vector.ts`), so a 1:1 nail-board tile prints crisp.
 */

import { renderSchematic } from '@wirehub/render-svg';
import {
  baseExport,
  buildSheetMarkdown,
  deriveFormboard,
  deriveLabels,
  formboardHtml,
  formboardLayout,
  formboardSvg,
  formboardSvgPages,
  labelSheetPages,
  labelSheetSvg,
  renderBomMarkdown,
  renderBomSheet,
  renderBuildSheet,
  renderDrawingSheet,
  renderTestSpecSheet,
  sheetRenderOptions,
  withUnreleasedMark,
  testSpecToMarkdown,
  deriveTestSpec,
  resolveTestParameters,
  type DrawingMeta,
  type FormatOptions,
  type FormatOutput,
  type TestParameters,
} from '@wirehub/docs';
import type { CableDesign, Db, KnownPartNumber, PartNumberScheme } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import { layoutMarkdown, PAPER } from './layout.ts';
import { pagesToPdf, type PdfPage } from './pdf.ts';
import { svgToPdfPage } from './raster.ts';
import { svgToVectorPdfPage } from './vector.ts';
import { pagesToSvg } from './svg.ts';

export const DOCUMENT_KINDS = ['schematic', 'build-sheet', 'bom', 'test-spec', 'drawing', 'labels', 'formboard'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_FORMATS = ['html', 'svg', 'pdf', 'csv'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

const FORMATS: Readonly<Record<DocumentKind, readonly DocumentFormat[]>> = {
  schematic: ['svg', 'pdf'],
  'build-sheet': ['html', 'svg', 'pdf', 'csv'],
  bom: ['html', 'svg', 'pdf', 'csv'],
  'test-spec': ['html', 'svg', 'pdf', 'csv'],
  drawing: ['html', 'svg', 'pdf'],
  labels: ['svg', 'pdf', 'csv'],
  formboard: ['html', 'svg', 'pdf'],
};

/** The format a document is rendered in when none is asked for. */
export const DEFAULT_FORMAT: Readonly<Record<DocumentKind, DocumentFormat>> = {
  schematic: 'svg',
  'build-sheet': 'html',
  bom: 'html',
  'test-spec': 'html',
  drawing: 'svg',
  labels: 'svg',
  formboard: 'svg',
};

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}
export function isDocumentFormat(value: string): value is DocumentFormat {
  return (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

export interface DocumentRequest {
  kind: DocumentKind;
  format: DocumentFormat;
  design: CableDesign;
  db: Db;
  /** the drawing sidecar: part number, lengths, sheet settings, test parameters */
  drawing?: DrawingMeta;
  /** a `data:image/…` product photo for the drawing sheet */
  photo?: string;
  /** the saved revision being rendered */
  revisionNumber?: number;
  paper?: 'A4' | 'letter';
  variation?: string;
  /** label sheet: 1-based page and copies of each label */
  page?: number;
  copies?: number;
  /** formboard: paper millimetres per board millimetre (1 = 1:1); page is then a tile, 1-based, and absent is the overview */
  scale?: number;
  /** cables in the build, for the BOM's quantity breaks */
  buildQty?: number;
  /** the BOM lists each sub-assembly's parts instead of one line for it */
  explode?: boolean;
  /** the organisation's default test parameters */
  testDefaults?: TestParameters;
  /** print the working copy marked UNRELEASED (html) — set when the studio keeps saved revisions */
  unreleased?: boolean;
  /** the word the mark carries (default UNRELEASED; a saved version still awaiting approval says UNAPPROVED) */
  unreleasedLabel?: string;
  /** board artwork the sheets draw (default: the catalog's own tree) */
  depictions?: DepictionSource;
  /** the numbering scheme and every number in use: unnumbered BOM parts carry a proposal */
  partNumbers?: { scheme: PartNumberScheme; known: readonly KnownPartNumber[] };
  /** a date to stamp when the sheet settings ask for one (the library renders no clock) */
  today?: string;
}

export type DocumentResult =
  | { ok: true; output: FormatOutput }
  | { ok: false; status: number; error: string; hint: string };

const MIME: Readonly<Record<DocumentFormat, string>> = {
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};

const refuse = (status: number, error: string, hint: string): DocumentResult => ({ ok: false, status, error, hint });

function stem(request: DocumentRequest): string {
  return `${request.design.id}${request.revisionNumber === undefined ? '' : `-rev${request.revisionNumber}`}-${request.kind}`;
}

function titleOf(request: DocumentRequest): string {
  return `${request.design.label} — ${request.kind}`;
}

export async function renderDocument(request: DocumentRequest): Promise<DocumentResult> {
  const { kind, format, design, db } = request;
  if (!FORMATS[kind].includes(format)) {
    return refuse(400, `The ${kind} cannot be rendered as ${format}.`, `It comes as ${FORMATS[kind].join(', ')}.`);
  }
  const meta = request.drawing ?? {};
  const sheet = sheetRenderOptions(meta, design, () => request.today ?? '');
  const paper = request.paper ?? sheet.paper ?? 'A4';
  const options: FormatOptions = {
    ...sheet,
    paper,
    drawing: meta,
    ...(request.variation === undefined ? {} : { variation: request.variation }),
    ...(request.revisionNumber === undefined ? {} : { revisionNumber: request.revisionNumber }),
    ...(meta.test === undefined ? {} : { testParameters: meta.test }),
    ...(request.testDefaults === undefined ? {} : { testDefaults: request.testDefaults }),
    ...(request.page === undefined ? {} : { page: request.page }),
    ...(request.copies === undefined ? {} : { copies: request.copies }),
    ...(request.buildQty === undefined ? {} : { buildQty: request.buildQty }),
    ...(request.explode === true ? { explode: true } : {}),
    depictions: request.depictions ?? true,
    ...(request.partNumbers === undefined ? {} : { partNumbers: request.partNumbers }),
  };
  const out = (body: string | Uint8Array, fileFormat: DocumentFormat = format): DocumentResult => ({
    ok: true,
    output: {
      mimeType: MIME[fileFormat],
      fileName: `${stem(request)}.${fileFormat}`,
      body: request.unreleased === true && typeof body === 'string' && fileFormat === 'html' ? withUnreleasedMark(body, request.unreleasedLabel) : body,
    },
  });
  try {
    if (format === 'csv') {
      const id = { 'build-sheet': 'wire-list.csv', bom: 'bom.csv', 'test-spec': 'continuity.csv', labels: 'labels.csv' }[kind as 'bom'];
      const made = baseExport(id)!.render(design, db, options);
      return { ok: true, output: { ...made, fileName: `${stem(request)}.csv` } };
    }
    switch (kind) {
      case 'schematic': {
        let svg: string;
        try {
          svg = renderSchematic(design, db, request.depictions === undefined ? {} : { depictions: request.depictions });
        } catch {
          svg = renderSchematic(design, db, { depictions: false });
        }
        if (format === 'svg') return out(svg);
        return out(pagesToPdf([await svgToPdfPage({ svg, width: 841.89, height: 595.28, margin: 24 })], titleOf(request)));
      }
      case 'drawing': {
        const drawingOptions = { meta, ...(request.photo === undefined ? {} : { photo: request.photo }) };
        if (format === 'html') return out(renderDrawingSheet(design, db, drawingOptions));
        const svg = renderDrawingSheet(design, db, { ...drawingOptions, fragment: true });
        if (format === 'svg') return out(svg);
        return out(pagesToPdf([await svgToPdfPage({ svg, width: 792, height: 612 })], titleOf(request)));
      }
      case 'formboard': {
        const board = deriveFormboard(design, db, { ...(request.variation === undefined ? {} : { variation: request.variation }), drawing: meta });
        const sheetOptions = { paper, ...(request.scale === undefined ? {} : { scale: request.scale }), ...(request.revisionNumber === undefined ? {} : { revisionNumber: request.revisionNumber }) };
        const layout = formboardLayout(board, sheetOptions);
        if (request.page !== undefined && request.page > layout.tiles) {
          return refuse(400, `The formboard has ${layout.tiles} tile page${layout.tiles === 1 ? '' : 's'} at ${request.scale === undefined ? '1:1' : `scale ${request.scale}`} on ${paper}, not ${request.page}.`, `Use page=1 to ${layout.tiles}, or leave page out for the overview.`);
        }
        if (format === 'html') return out(formboardHtml(board, sheetOptions));
        if (format === 'svg') return out(formboardSvg(board, request.page ?? 0, sheetOptions));
        const mm = paper === 'letter' ? { w: 279.4, h: 215.9 } : { w: 297, h: 210 };
        const pages: PdfPage[] = [];
        for (const svg of formboardSvgPages(board, sheetOptions)) {
          pages.push(svgToVectorPdfPage(svg, { width: (mm.w / 25.4) * 72, height: (mm.h / 25.4) * 72 }));
        }
        return out(pagesToPdf(pages, titleOf(request)));
      }
      case 'labels': {
        const labels = deriveLabels(design, db);
        const count = labelSheetPages(labels.length, options);
        if (format === 'svg') return out(labelSheetSvg(labels, options));
        const pages: PdfPage[] = [];
        for (let page = 1; page <= count; page += 1) {
          const svg = labelSheetSvg(labels, { ...options, page });
          const mm = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
          const w = (Number(mm?.[1] ?? 210) / 25.4) * 72;
          const h = (Number(mm?.[2] ?? 297) / 25.4) * 72;
          pages.push(await svgToPdfPage({ svg, width: w, height: h, dpi: 300 }));
        }
        return out(pagesToPdf(pages, titleOf(request)));
      }
      default: {
        if (format === 'html') {
          const html =
            kind === 'build-sheet' ? renderBuildSheet(design, db, options) : kind === 'bom' ? renderBomSheet(design, db, options) : renderTestSpecSheet(design, db, options);
          return out(html);
        }
        const parameters = resolveTestParameters(meta.test, request.testDefaults);
        const markdown =
          kind === 'build-sheet'
            ? buildSheetMarkdown(design, db, options)
            : kind === 'bom'
              ? renderBomMarkdown(design, db, options)
              : testSpecToMarkdown(deriveTestSpec(design, db, { continuityOhmsMax: parameters.continuityOhmsMax }), parameters);
        const pages = layoutMarkdown(markdown, { paper: PAPER[paper], footer: `${design.id} ${kind}${request.revisionNumber === undefined ? '' : ` rev ${request.revisionNumber}`}` });
        return format === 'svg' ? out(pagesToSvg(pages)) : out(pagesToPdf(pages.map((page): PdfPage => ({ kind: 'ops', page })), titleOf(request)));
      }
    }
  } catch (error) {
    return refuse(422, `The ${kind} of ${design.id} could not be rendered.`, error instanceof Error ? error.message : String(error));
  }
}

/**
 * The sidecar as the printed sheets read it for a target: a saved revision's
 * number is the document's revision and it prints RELEASED unless the sheet
 * says otherwise; the working copy prints with a dash and UNRELEASED
 * (`undefined` target: the studio keeps no revisions, nothing is changed).
 */
/** What the approval of the rendered revision says, when the hub requires approvals. */
export interface ApprovalFacts {
  approval?: { state: 'submitted' | 'approved' | 'rejected'; by: string; at: string };
}

export function releaseMeta(meta: DrawingMeta, target: 'working' | number | undefined, approval?: ApprovalFacts): DrawingMeta {
  if (target === undefined) return meta;
  const { revision: _revision, ...rest } = meta.sheet ?? {};
  let status = target === 'working' ? 'UNRELEASED' : (rest.status ?? 'RELEASED');
  if (approval !== undefined && target !== 'working') {
    // approvals on: only an approved version is RELEASED, and it names its approver
    const a = approval.approval;
    status = a?.state === 'approved' ? `RELEASED · approved by ${a.by} ${a.at.slice(0, 10)}` : `UNRELEASED · ${a?.state === 'submitted' ? 'awaiting approval' : a?.state === 'rejected' ? 'rejected' : 'not approved'}`;
  }
  const sheet = { ...rest, status };
  return { ...meta, revision: target === 'working' ? '—' : String(target), sheet };
}
