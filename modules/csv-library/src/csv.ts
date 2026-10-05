/** RFC 4180 CSV, read and written without a dependency. Deterministic. */

/** Parse CSV text into rows of cells. A BOM is dropped; quotes, doubled quotes and CRLF are handled; blank lines are skipped. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (!(row.length === 1 && row[0] === '' && !started)) rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      endCell();
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      cell += c;
      started = true;
    }
  }
  if (cell !== '' || row.length > 0 || started) endRow();
  return rows;
}

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows to CSV text with CRLF line ends. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
