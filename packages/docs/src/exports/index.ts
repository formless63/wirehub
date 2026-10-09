/**
 * The base exports: what a spreadsheet, a purchasing system, a wire-cutting
 * machine, a continuity tester or a label printer can read. Each is one
 * `ExportFormat`: pure, `(design, db, options) → file`, so the browser's
 * Documents toolbar, the server's export route and the headless CLI all call
 * the same function. Formats and columns are documented in `docs/exports.md`.
 *
 * A module adds formats of its own (a tester's dialect, an ERP's import file)
 * as an `ExporterContribution`; it reads the same derivations
 * (`deriveContinuityExport`, `bomTable`, `deriveLabels`, …) exported from here.
 */

import type { CableDesign, Db } from '@wirehub/model';

import { continuityCsv, continuityJson, deriveContinuityExport } from './continuity.ts';
import { deriveLabels, labelSheetSvg, labelsTable, type LabelSheetOptions } from './labels.ts';
import { bomTable, crimpListTable, cutListTable, wireListTable, type ExportOptions } from './rows.ts';
import { sheetFrameFor } from '../sheet-frame.ts';
import type { TestParameters } from './test-params.ts';
import { toCsv, toXlsx, XLSX_MIME } from './table.ts';

export * from './table.ts';
export * from './rows.ts';
export * from './continuity.ts';
export * from './labels.ts';
export * from './label-presets.ts';
export * from './qr.ts';
export * from './plain.ts';
export * from './sheet-options.ts';
export * from './test-params.ts';

export interface FormatOptions extends ExportOptions, LabelSheetOptions {}

/** Same shape as `ExportOutput` in `@wirehub/modules`. */
export interface FormatOutput {
  mimeType: string;
  fileName: string;
  body: string | Uint8Array;
}

export interface ExportFormat {
  /** `bom.csv` — the id in `/api/designs/:id/exports/:id` */
  id: string;
  label: string;
  description: string;
  group: 'production' | 'tester' | 'labels';
  render(design: CableDesign, db: Db, options?: FormatOptions): FormatOutput;
}

const CSV = 'text/csv; charset=utf-8';

function stem(design: CableDesign, options: FormatOptions, what: string): string {
  return `${design.id}${options.revisionNumber === undefined ? '' : `-rev${options.revisionNumber}`}-${what}`;
}

const csv = (what: string, table: (d: CableDesign, db: Db, o: FormatOptions) => { headers: readonly string[]; rows: readonly (readonly (string | number)[])[] }) =>
  (design: CableDesign, db: Db, options: FormatOptions = {}): FormatOutput => ({
    mimeType: CSV,
    fileName: `${stem(design, options, what)}.csv`,
    body: toCsv(table(design, db, options)),
  });

export const BASE_EXPORTS: readonly ExportFormat[] = [
  { id: 'bom.csv', label: 'BOM (CSV)', description: 'Bill of materials: part number, description, quantity, unit, section.', group: 'production', render: csv('bom', bomTable) },
  { id: 'wire-list.csv', label: 'Wire list (CSV)', description: 'Every conductor and screen: stock, colour, where each end lands, length.', group: 'production', render: csv('wire-list', (d, db) => wireListTable(d, db)) },
  { id: 'cut-list.csv', label: 'Cut list (CSV)', description: 'Pieces to cut per stock and length, with the orderable length variations.', group: 'production', render: csv('cut-list', cutListTable) },
  { id: 'crimp-list.csv', label: 'Crimp list (CSV)', description: 'Every cavity of each crimp housing: wires, contact, seal or plug, strip length, crimp height and tool.', group: 'production', render: csv('crimp-list', (d, db) => crimpListTable(d, db)) },
  {
    id: 'production.xlsx',
    label: 'BOM, wire, cut and crimp lists (XLSX)',
    description: 'One workbook with the BOM, wire list, cut list and crimp list on separate sheets.',
    group: 'production',
    render: (design, db, options = {}) => ({
      mimeType: XLSX_MIME,
      fileName: `${stem(design, options, 'production')}.xlsx`,
      body: toXlsx([bomTable(design, db, options), wireListTable(design, db), cutListTable(design, db, options), crimpListTable(design, db)]),
    }),
  },
  {
    id: 'continuity.csv',
    label: 'Continuity (CSV)',
    description: 'Net-to-pin pairs, expected connections and isolation pairs with the test parameters, for a tester or fixture.',
    group: 'tester',
    render: (design, db, options = {}) => ({
      mimeType: CSV,
      fileName: `${stem(design, options, 'continuity')}.csv`,
      body: continuityCsv(deriveContinuityExport(design, db, continuityInputs(options))),
    }),
  },
  {
    id: 'continuity.json',
    label: 'Continuity (JSON)',
    description: 'The same as structured JSON: points, nets, connections, isolation, opens and the test parameters.',
    group: 'tester',
    render: (design, db, options = {}) => ({
      mimeType: 'application/json',
      fileName: `${stem(design, options, 'continuity')}.json`,
      body: continuityJson(deriveContinuityExport(design, db, continuityInputs(options))),
    }),
  },
  { id: 'labels.csv', label: 'Wire labels (CSV)', description: 'Label text and position for each end of each wire run.', group: 'labels', render: csv('labels', (d, db) => labelsTable(deriveLabels(d, db))) },
  {
    id: 'labels.svg',
    label: 'Label sheet (SVG)',
    description: 'The labels laid out on a sheet of label stock, to print at 100%.',
    group: 'labels',
    render: (design, db, options = {}) => ({
      mimeType: 'image/svg+xml',
      fileName: `${stem(design, options, 'labels')}.svg`,
      body: labelSheetSvg(deriveLabels(design, db), { ...options, frame: options.frame ?? sheetFrameFor(design, db, options, 'LABELS', 'portrait', 'strip') }),
    }),
  },
];

function continuityInputs(options: FormatOptions): { parameters?: TestParameters; defaults?: TestParameters } {
  return {
    ...((options.testParameters ?? options.drawing?.test) === undefined ? {} : { parameters: (options.testParameters ?? options.drawing?.test) as TestParameters }),
    ...(options.testDefaults === undefined ? {} : { defaults: options.testDefaults }),
  };
}

export function baseExport(id: string): ExportFormat | undefined {
  return BASE_EXPORTS.find((format) => format.id === id);
}
