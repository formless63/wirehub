/**
 * Bulk CSV library import (cs-5k1.19): connectors, wire stocks, components and
 * mechanicals from CSV, through the import review and one change set. The
 * importer reads the canonical columns (`kinds.ts`); the studio's **Bulk CSV…**
 * dialog does the column mapping, validation and dry-run diff on the client with
 * the same functions, then uploads the canonical file as an import job.
 * Update mode (`library-csv-update`) diffs each row against the record the library has and
 * applies the changes as edits, in the same change set. A CSV or an XLSX sheet (`xlsx.ts`).
 * MIT; a template per kind is `templateCsv`.
 */

import type { Db } from '@wirehub/model';
import { defineModule, type ImportResult } from '@wirehub/modules';

import { importLibraryText } from './import.ts';
import { toCsv } from './csv.ts';
import { looksLikeZip, readXlsx } from './xlsx.ts';

export { analyseCsv, importLibraryCsv, importLibraryText, slug } from './import.ts';
export type { AnalyseOptions, Analysis, RowResult } from './import.ts';
export { looksLikeZip, readXlsx, unzip, XlsxError } from './xlsx.ts';
export { parseCsv, toCsv } from './csv.ts';
export { EXAMPLE, FIELDS, LIBRARY_KINDS, TYPE_COLUMN, detectKind, fieldFor, kindOfType, suggestMapping } from './kinds.ts';
export type { FieldSpec, LibraryKind } from './kinds.ts';
export { applyMapping, templateCsv, templateFileName } from './mapping.ts';

export const MODULE_ID = 'csv-library';

/** A CSV or an XLSX workbook (its first sheet) of library records, as the importer reads it. */
export async function importLibraryFile(fileName: string, bytes: Uint8Array, db: Db, options: { batchSrc?: string; update?: boolean } = {}): Promise<ImportResult> {
  if (/\.xlsx$/i.test(fileName) || looksLikeZip(bytes)) return importLibraryText(fileName, toCsv(await readXlsx(bytes)), db, options);
  return importLibraryText(fileName, new TextDecoder().decode(bytes), db, options);
}

export const csvLibrary = defineModule({
  id: MODULE_ID,
  label: 'Bulk CSV library import',
  version: '0.1.0',
  license: 'MIT',
  importers: [
    {
      id: 'library-csv',
      label: 'Library parts (CSV)',
      accepts: ['.csv', '.xlsx'],
      import: (input, db) => importLibraryFile(input.fileName, input.bytes, db),
    },
    {
      id: 'library-csv-update',
      label: 'Library parts (CSV or XLSX, update existing)',
      accepts: ['.csv', '.xlsx'],
      import: (input, db) => importLibraryFile(input.fileName, input.bytes, db, { update: true }),
    },
  ],
});
