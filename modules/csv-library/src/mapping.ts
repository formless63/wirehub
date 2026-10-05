/**
 * Column mapping and templates for the bulk CSV import (cs-5k1.19).
 *
 * A person's spreadsheet rarely has the template's headers. The app shows each
 * field of the chosen kind with a dropdown of the file's columns (pre-filled by
 * `suggestMapping`), then `applyMapping` writes the **canonical** CSV that the
 * importer reads: a `type` column, one column per field in a fixed order, the
 * batch source filled into rows that have none. That canonical file is what is
 * uploaded to the import job, so the job's plan is exactly what the dry run showed.
 */

import { toCsv } from './csv.ts';
import { EXAMPLE, FIELDS, TYPE_COLUMN, type LibraryKind } from './kinds.ts';

const TYPE_VALUE: Record<LibraryKind, string> = { connectors: 'connector', wires: 'wire', components: 'component', mechanicals: 'mechanical' };

/** The template CSV for a kind: the header row and one worked example row. */
export function templateCsv(kind: LibraryKind): string {
  const keys = FIELDS[kind].map((f) => f.key);
  return toCsv([[TYPE_COLUMN, ...keys], [TYPE_VALUE[kind], ...keys.map((k) => EXAMPLE[kind][k] ?? '')]]);
}

export const templateFileName = (kind: LibraryKind): string => `wirehub-${kind}-template.csv`;

/**
 * The canonical CSV from a parsed file (header row first), a mapping of field key to
 * column index, and an optional batch source for rows that have no source of their own.
 */
export function applyMapping(rows: readonly (readonly string[])[], kind: LibraryKind, mapping: Readonly<Record<string, number | undefined>>, batchSrc?: string, defaults: Readonly<Record<string, string>> = {}): string {
  const keys = FIELDS[kind].map((f) => f.key);
  const body = rows.slice(1).filter((r) => r.some((cell) => cell.trim() !== ''));
  const out: string[][] = [[TYPE_COLUMN, ...keys]];
  for (const row of body) {
    out.push([
      TYPE_VALUE[kind],
      ...keys.map((key) => {
        const index = mapping[key];
        const cell = index === undefined ? '' : (row[index] ?? '').trim();
        if (cell !== '') return cell;
        // a fixed value for a column the file does not have (or leaves blank): the batch source, a currency, a kind
        return key === 'src' && batchSrc !== undefined && batchSrc.trim() !== '' ? batchSrc.trim() : (defaults[key] ?? '').trim();
      }),
    ]);
  }
  return toCsv(out);
}
