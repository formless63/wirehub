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
 * `html` is the browser's own render, byte for byte (same functions). With a
 * browser PDF engine configured (`browser-pdf.ts`, `WIREHUB_PDF_ENGINE_URL`)
 * the `pdf` of the three text sheets and of the drawing sheet is that HTML
 * printed by Chromium, as the browser's Print prints it. Without one, `svg` and
 * `pdf` of the three text sheets are a plain page layout of the sheet's text
 * (`layout.ts`) — tables and notes, without the figures — because laying out
 * HTML needs a browser engine the WireHub image does not ship; the schematic,
 * the drawing sheet and the label sheet are drawings already, so they come out
 * as themselves (SVG) or as a rasterised page (PDF); the formboard is the exception, its
 * PDF is vector (`vector.ts`), so a 1:1 nail-board tile prints crisp.
 */

import { renderSchematic } from '@wirehub/render-svg';
import {
  baseExport,
  effectivePaper,
  frameFontStyle,
  framedSchematicSvg,
  frameGeometry,
  paperSize,
  schematicFrame,
  sheetFrameFor,
  type PaperId,
  type RevisionRow,
  type TitleBlockStandard,
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
  testSpecToMarkdown,
  deriveTestSpec,
  resolveTestParameters,
  registerDrawingArt,
  type DrawingArt,
  type DrawingMeta,
  type FormatOptions,
  type FormatOutput,
  type TestParameters,
} from '@wirehub/docs';
import type { CableDesign, Db, KnownPartNumber, PartNumberScheme } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import type { PdfEngine } from './browser-pdf.ts';
import { framedPagesToPdf, framedPagesToSvg, framedTextPages } from './framed-text.ts';
import { pagesToPdf, type PdfPage } from './pdf.ts';
import { svgToPdfPage } from './raster.ts';
import { svgToVectorPdfPage } from './vector.ts';

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
  paper?: PaperId;
  /** the title-block layout (`ansi` or `iso`), when the hub sets one */
  titleBlock?: TitleBlockStandard;
  /** who checked it (the approver, when approvals are on) */
  checked?: string;
  /** the drawing's revision table: the saved revisions, oldest first */
  revisions?: readonly RevisionRow[];
  variation?: string;
  /** label sheet: 1-based page and copies of each label */
  page?: number;
  copies?: number;
  /** label sheet: the label stock (`label-presets.ts`) and whether each label carries a QR code; absent: the hub's settings */
  labelPreset?: string;
  labelQr?: boolean;
  /** formboard: paper millimetres per board millimetre (1 = 1:1); page is then a tile, 1-based, and absent is the overview */
  scale?: number;
  /** cables in the build, for the BOM's quantity breaks */
  buildQty?: number;
  /** the BOM lists each sub-assembly's parts instead of one line for it */
  explode?: boolean;
  /** the organisation's default test parameters */
  testDefaults?: TestParameters;
  /** the working copy: its state is UNRELEASED, in the title block and in the corner stamp — set when the studio keeps saved revisions */
  unreleased?: boolean;
  /** the state word when the sidecar names none (default UNRELEASED; a saved version still awaiting approval says UNAPPROVED) */
  unreleasedLabel?: string;
  /** board artwork the sheets draw (default: the catalog's own tree) */
  depictions?: DepictionSource;
  /** the numbering scheme and every number in use: unnumbered BOM parts carry a proposal */
  partNumbers?: { scheme: PartNumberScheme; known: readonly KnownPartNumber[] };
  /** a date to stamp when the sheet settings ask for one (the library renders no clock) */
  today?: string;
  /** the hub's branding as drawing art (`brandingArt`), registered only while the sheet is drawn — after any module's art, so a module still wins */
  branding?: DrawingArt;
  /** the browser engine the HTML sheets are printed to PDF with (`browser-pdf.ts`); absent: the plain PDFs */
  pdfEngine?: PdfEngine;
}

/** How a PDF was made: `browser` is the HTML sheet printed by the engine; `fallback` says why a sheet that could be was not. */
export interface PdfProvenance {
  renderer: 'browser' | 'text-layout' | 'raster' | 'vector';
  fallback?: string;
}

export type DocumentResult =
  | { ok: true; output: FormatOutput; pdf?: PdfProvenance }
  | { ok: false; status: number; error: string; hint: string };

/** The documents whose PDF is their sheet printed by the browser engine, when one is configured: the HTML sheets, and the schematic, drawing and label sheets (an SVG page each). Their text stays text. */
export const BROWSER_PDF_KINDS: ReadonlySet<DocumentKind> = new Set(['build-sheet', 'bom', 'test-spec', 'drawing', 'schematic', 'labels']);

/** SVG pages as one HTML document the browser engine prints: a page each, of the SVG's own size. */
export function svgPagesHtml(title: string, pages: readonly string[], width: number, height: number): string {
  const size = `${Math.round(width * 100) / 100}mm ${Math.round(height * 100) / 100}mm`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, ' ')}</title>` +
    `<style>@page{size:${size};margin:0}html,body{margin:0;padding:0;background:#fff}` +
    `.wh-page{width:${width}mm;height:${height}mm;overflow:hidden;break-after:page;page-break-after:always}.wh-page:last-child{break-after:auto;page-break-after:auto}.wh-page svg{display:block;width:${width}mm;height:${height}mm}</style></head><body>` +
    pages.map((svg) => `<div class="wh-page">${svg}</div>`).join('') +
    '</body></html>'
  );
}

/** Run a synchronous sheet render with the hub's branding registered, and only then (the registry is shared). */
export function withBranding<T>(art: DrawingArt | undefined, render: () => T): T {
  if (art === undefined) return render();
  const off = registerDrawingArt(art);
  try {
    return render();
  } finally {
    off();
  }
}

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
  // one state for every sheet: the sidecar's (RELEASED, UNAPPROVED · awaiting approval …), else the working copy's
  const state = sheet.document?.status ?? (request.unreleased === true ? (request.unreleasedLabel ?? 'UNRELEASED') : undefined);
  const identity = state === undefined ? sheet.document : { ...(sheet.document ?? {}), status: state };
  // the paper: asked for, else the sheet's own, else the hub's setting (registered with the branding), else A4
  const asked: PaperId | undefined = request.paper ?? sheet.paper;
  const paper: PaperId = withBranding(request.branding, () => effectivePaper(asked));
  const options: FormatOptions = {
    ...sheet,
    ...(identity === undefined ? {} : { document: identity }),
    paper,
    ...(request.titleBlock === undefined ? {} : { titleBlock: request.titleBlock }),
    ...(request.checked === undefined ? {} : { checked: request.checked }),
    drawing: meta,
    ...(request.variation === undefined ? {} : { variation: request.variation }),
    ...(request.revisionNumber === undefined ? {} : { revisionNumber: request.revisionNumber }),
    ...(meta.test === undefined ? {} : { testParameters: meta.test }),
    ...(request.testDefaults === undefined ? {} : { testDefaults: request.testDefaults }),
    ...(request.page === undefined ? {} : { page: request.page }),
    ...(request.copies === undefined ? {} : { copies: request.copies }),
    ...(request.labelPreset === undefined ? {} : { preset: request.labelPreset }),
    ...(request.labelQr === undefined ? {} : { qr: request.labelQr }),
    ...(request.buildQty === undefined ? {} : { buildQty: request.buildQty }),
    ...(request.explode === true ? { explode: true } : {}),
    depictions: request.depictions ?? true,
    ...(request.partNumbers === undefined ? {} : { partNumbers: request.partNumbers }),
  };
  let pdf: PdfProvenance | undefined;
  const out = (body: string | Uint8Array, fileFormat: DocumentFormat = format, renderer?: PdfProvenance['renderer']): DocumentResult => ({
    ok: true,
    output: { mimeType: MIME[fileFormat], fileName: `${stem(request)}.${fileFormat}`, body },
    ...(fileFormat === 'pdf' && renderer !== undefined ? { pdf: { ...pdf, renderer } } : {}),
  });
  const drawingOptions = {
    meta,
    ...(request.photo === undefined ? {} : { photo: request.photo }),
    paper,
    ...(request.titleBlock === undefined ? {} : { titleBlock: request.titleBlock }),
    ...(state === undefined ? {} : { state }),
    ...(request.checked === undefined ? {} : { checked: request.checked }),
    ...(request.revisions === undefined ? {} : { revisions: request.revisions }),
  };
  /** a design's sheet frame, for the sheets drawn as SVG */
  const frameOf = (what: string, orientation: 'portrait' | 'landscape', variant: 'full' | 'strip' = 'full') => sheetFrameFor(design, db, options, what, orientation, variant);
  /** the schematic: the render-svg drawing, framed (`withBranding`: the title block's organisation and logo) */
  const schematicSvg = (): string => {
    let svg: string;
    try {
      svg = renderSchematic(design, db, request.depictions === undefined ? {} : { depictions: request.depictions });
    } catch {
      svg = renderSchematic(design, db, { depictions: false });
    }
    return withBranding(request.branding, () => framedSchematicSvg(svg, schematicFrame(design, db, svg, options)));
  };
  /** the label sheet's pages, each framed */
  const labelPages = (): string[] => {
    const labels = deriveLabels(design, db);
    const count = labelSheetPages(labels.length, options);
    return withBranding(request.branding, () => {
      const frame = frameOf('LABELS', 'portrait', 'strip');
      return Array.from({ length: count }, (_, i) => labelSheetSvg(labels, { ...options, frame, design: design.id, page: i + 1 }));
    });
  };
  const sizeOfSvg = (svg: string): { width: number; height: number } => {
    const mm = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
    return { width: Number(mm?.[1] ?? 210), height: Number(mm?.[2] ?? 297) };
  };
  const toPt = (mm: number): number => (mm / 25.4) * 72;
  /** the sheet of a document that has one, as the HTML the browser engine prints (not the formboard: its PDF is vector already) */
  const sheetHtml = (): string => {
    if (kind === 'schematic') {
      const svg = schematicSvg();
      const size = sizeOfSvg(svg);
      return svgPagesHtml(titleOf(request), [svg], size.width, size.height);
    }
    if (kind === 'labels') {
      const pages = labelPages();
      const size = sizeOfSvg(pages[0] as string);
      return svgPagesHtml(titleOf(request), pages, size.width, size.height);
    }
    return withBranding(request.branding, () =>
      kind === 'build-sheet'
        ? renderBuildSheet(design, db, options)
        : kind === 'bom'
          ? renderBomSheet(design, db, options)
          : kind === 'test-spec'
            ? renderTestSpecSheet(design, db, options)
            : renderDrawingSheet(design, db, drawingOptions),
    );
  };
  try {
    if (format === 'pdf' && BROWSER_PDF_KINDS.has(kind)) {
      if (request.pdfEngine === undefined) {
        pdf = { renderer: 'text-layout', fallback: 'No browser PDF engine is configured (WIREHUB_PDF_ENGINE_URL), so this is the headless PDF, not the printed HTML sheet (format=html prints that in a browser).' };
      } else {
        try {
          return out(await request.pdfEngine.htmlToPdf(sheetHtml()), 'pdf', 'browser');
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          console.warn(`[documents] browser PDF of ${design.id} ${kind}: ${why}; sent the headless PDF instead`);
          pdf = { renderer: 'text-layout', fallback: `The browser PDF engine failed (${why}), so this is the headless PDF, not the printed HTML sheet.` };
        }
      }
    }
    if (format === 'csv') {
      const id = { 'build-sheet': 'wire-list.csv', bom: 'bom.csv', 'test-spec': 'continuity.csv', labels: 'labels.csv' }[kind as 'bom'];
      const made = baseExport(id)!.render(design, db, options);
      return { ok: true, output: { ...made, fileName: `${stem(request)}.csv` } };
    }
    switch (kind) {
      case 'schematic': {
        const svg = schematicSvg();
        if (format === 'svg') return out(svg);
        const size = sizeOfSvg(svg);
        return out(pagesToPdf([await svgToPdfPage({ svg, width: toPt(size.width), height: toPt(size.height), ...(request.branding?.font === undefined ? {} : { brand: request.branding.font }) })], titleOf(request)), 'pdf', 'raster');
      }
      case 'drawing': {
        if (format === 'html') return out(sheetHtml());
        const svg = withBranding(request.branding, () => renderDrawingSheet(design, db, { ...drawingOptions, fragment: true }));
        if (format === 'svg') return out(svg);
        const size = paperSize(paper, 'landscape');
        return out(pagesToPdf([await svgToPdfPage({ svg, width: toPt(size.width), height: toPt(size.height), ...(request.branding?.font === undefined ? {} : { brand: request.branding.font }) })], titleOf(request)), 'pdf', 'raster');
      }
      case 'formboard': {
        // the hub's own typeface (branding) is registered while the board is drawn and its PDF text is chosen
        return withBranding(request.branding, () => {
          const board = deriveFormboard(design, db, { ...(request.variation === undefined ? {} : { variation: request.variation }), drawing: meta });
          const sheetOptions = { paper, frame: frameOf('FORMBOARD', 'landscape', 'strip'), ...(request.scale === undefined ? {} : { scale: request.scale }), ...(request.revisionNumber === undefined ? {} : { revisionNumber: request.revisionNumber }) };
          const layout = formboardLayout(board, sheetOptions);
          if (request.page !== undefined && request.page > layout.tiles) {
            return refuse(400, `The formboard has ${layout.tiles} tile page${layout.tiles === 1 ? '' : 's'} at ${request.scale === undefined ? '1:1' : `scale ${request.scale}`} on ${paper}, not ${request.page}.`, `Use page=1 to ${layout.tiles}, or leave page out for the overview.`);
          }
          if (format === 'html') return out(formboardHtml(board, sheetOptions));
          if (format === 'svg') return out(formboardSvg(board, request.page ?? 0, sheetOptions));
          const mm = paperSize(paper, 'landscape');
          const pages: PdfPage[] = [];
          for (const svg of formboardSvgPages(board, sheetOptions)) {
            pages.push(svgToVectorPdfPage(svg, { width: toPt(mm.width), height: toPt(mm.height) }));
          }
          return out(pagesToPdf(pages, titleOf(request)), 'pdf', 'vector');
        });
      }
      case 'labels': {
        const pages = labelPages();
        if (format === 'svg') return out(pages[request.page === undefined ? 0 : Math.min(request.page, pages.length) - 1] as string);
        const rendered: PdfPage[] = [];
        for (const svg of pages) {
          const size = sizeOfSvg(svg);
          rendered.push(await svgToPdfPage({ svg, width: toPt(size.width), height: toPt(size.height), dpi: 300 }));
        }
        return out(pagesToPdf(rendered, titleOf(request)), 'pdf', 'raster');
      }
      default: {
        if (format === 'html') return out(sheetHtml());
        const parameters = resolveTestParameters(meta.test, request.testDefaults);
        const markdown = withBranding(request.branding, () =>
          kind === 'build-sheet'
            ? buildSheetMarkdown(design, db, options)
            : kind === 'bom'
              ? renderBomMarkdown(design, db, options)
              : testSpecToMarkdown(deriveTestSpec(design, db, { continuityOhmsMax: parameters.continuityOhmsMax }), parameters),
        );
        return withBranding(request.branding, () => {
          // the text on the sheet frame: the full title block first, the strip and "n of N" after (cs-dcuk)
          const what = kind === 'build-sheet' ? 'BENCH BUILD SHEET' : kind === 'bom' ? 'BILL OF MATERIALS' : 'CONTINUITY & TEST SPEC';
          const pages = framedTextPages(markdown, frameOf(what, 'portrait', 'full'));
          return format === 'svg' ? out(framedPagesToSvg(pages)) : out(pagesToPdf(framedPagesToPdf(pages), titleOf(request)), 'pdf', 'text-layout');
        });
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
    status = a?.state === 'approved' ? `RELEASED · approved by ${a.by} ${a.at.slice(0, 10)}` : `UNAPPROVED · ${a?.state === 'submitted' ? 'awaiting approval' : a?.state === 'rejected' ? 'rejected' : 'not approved'}`;
  }
  const sheet = { ...rest, status };
  return { ...meta, revision: target === 'working' ? '—' : String(target), sheet };
}
