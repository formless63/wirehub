/**
 * Bulk CSV library import (cs-5k1.19): connectors, wire stocks, components and
 * mechanicals from CSV, through the import review and one change set. The
 * importer reads the canonical columns (`kinds.ts`); the studio's **Bulk CSV…**
 * dialog does the column mapping, validation and dry-run diff on the client with
 * the same functions, then uploads the canonical file as an import job.
 * MIT; a template per kind is `templateCsv`.
 */

import { defineModule } from '@wirehub/modules';

import { importLibraryCsv } from './import.ts';

export { analyseCsv, importLibraryCsv, slug } from './import.ts';
export type { Analysis, RowResult } from './import.ts';
export { parseCsv, toCsv } from './csv.ts';
export { EXAMPLE, FIELDS, LIBRARY_KINDS, TYPE_COLUMN, detectKind, fieldFor, kindOfType, suggestMapping } from './kinds.ts';
export type { FieldSpec, LibraryKind } from './kinds.ts';
export { applyMapping, templateCsv, templateFileName } from './mapping.ts';

export const MODULE_ID = 'csv-library';

export const csvLibrary = defineModule({
  id: MODULE_ID,
  label: 'Bulk CSV library import',
  version: '0.1.0',
  license: 'MIT',
  importers: [
    {
      id: 'library-csv',
      label: 'Library parts (CSV)',
      accepts: ['.csv'],
      import: (input, db) => importLibraryCsv(input.fileName, input.bytes, db),
    },
  ],
});
