/**
 * A minimal XLSX reader for the bulk import: the first worksheet of a
 * workbook as rows of text cells. No dependency: the zip's central directory
 * is read directly, stored and deflated entries are supported (deflate through
 * the platform's `DecompressionStream`, in Node and in the browser alike), and
 * the sheet XML is read for shared strings, inline strings, numbers and
 * booleans. Formulas show their cached value; dates are the serial number
 * (spreadsheets of parts rarely have any). Anything else is refused in words.
 */

const decoder = new TextDecoder();

export class XlsxError extends Error {}

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** Whether the bytes begin like a zip (an XLSX is one). */
export const looksLikeZip = (bytes: Uint8Array): boolean => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new XlsxError('this environment cannot unzip a compressed workbook; save the sheet as CSV instead');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every entry of a zip, by name. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxError('this is not an XLSX workbook (no zip directory); save the sheet as XLSX or CSV');
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    if (u32(bytes, at) !== 0x02014b50) throw new XlsxError('the workbook\'s zip directory is damaged');
    const method = u16(bytes, at + 10);
    const size = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extra = u16(bytes, at + 30);
    const comment = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new XlsxError(`the workbook uses zip method ${method}, which is not supported`);
  }
  return out;
}

const entity = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e] as string;
  });

/** The text of every `<t>` in an element's inner XML (rich-text runs are joined; phonetic runs are skipped). */
function textOf(inner: string): string {
  return [...inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => entity(m[1] as string)).join('');
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** `C` is 2, `AA` is 26 (zero-based). */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The first worksheet of an XLSX workbook as rows of cell text (empty cells are empty strings, rows are padded to the widest). */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes);
  const text = (name: string): string | undefined => {
    const data = files.get(name);
    return data === undefined ? undefined : decoder.decode(data);
  };
  const workbook = text('xl/workbook.xml');
  if (workbook === undefined) throw new XlsxError('this zip is not an XLSX workbook (no xl/workbook.xml)');
  const first = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  if (first === undefined) throw new XlsxError('the workbook has no sheets');
  const rid = attr(first, 'r:id');
  let target = 'worksheets/sheet1.xml';
  const rels = text('xl/_rels/workbook.xml.rels');
  if (rid !== undefined && rels !== undefined) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, 'Id') === rid);
    const path = rel === undefined ? undefined : attr(rel, 'Target');
    if (path !== undefined) target = path.replace(/^\//, '').replace(/^xl\//, '');
  }
  const sheet = text(`xl/${target}`);
  if (sheet === undefined) throw new XlsxError(`the workbook's first sheet (${target}) is missing`);
  const sharedXml = text('xl/sharedStrings.xml');
  const shared = sharedXml === undefined ? [] : [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] as string));

  const rows: string[][] = [];
  let nextRow = 0;
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = attr(rowMatch[1] as string, 'r');
    const rowIndex = r === undefined ? nextRow : Number(r) - 1;
    nextRow = rowIndex + 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cell[1] as string;
      const ref = attr(head, 'r');
      const col = ref === undefined ? nextCol : columnOf(ref);
      nextCol = col + 1;
      const type = attr(head, 't');
      const inner = cell[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 'inlineStr') value = textOf(inner);
      else if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) value = entity(v);
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}
