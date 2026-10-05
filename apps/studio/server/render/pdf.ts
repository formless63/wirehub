/**
 * A small PDF writer: pages of text and rules (`layout.ts`) set in the
 * standard Helvetica faces, pages that are vector drawings whose text is
 * Liberation Sans embedded as a subset TrueType font (`vector.ts`), and pages
 * that are a raster image (an SVG rendered by resvg). No dependency beyond
 * Node's zlib; deterministic (no creation date, no id).
 */

import { deflateSync } from 'node:zlib';

import { liberation, type Face, type PdfFont } from './fonts.ts';
import { winAnsiByte, type Op, type Page } from './layout.ts';

export type PdfPage =
  | { kind: 'ops'; page: Page }
  | {
      kind: 'vector';
      width: number;
      height: number;
      content: string;
      alphas: { key: string; ca: number; CA: number }[];
      /** the glyphs the page's text uses (`/E1` regular, `/E2` bold): embedded once for the document, subset to these */
      glyphs: { face: Face; gid: number; cp: number }[];
      /** the font each face was set in (absent: the bundled Liberation Sans) */
      fonts?: Partial<Record<Face, PdfFont>>;
    }
  | { kind: 'image'; width: number; height: number; at: { x: number; y: number; w: number; h: number }; pixelWidth: number; pixelHeight: number; rgb: Uint8Array };

const n = (v: number): string => String(Math.round(v * 100) / 100);

export function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const b = winAnsiByte(ch);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

function content(page: Page): string {
  const out: string[] = [];
  for (const op of page.ops as Op[]) {
    if (op.t === 'text') {
      out.push(`BT ${op.grey === true ? '0.45 g' : '0 g'} /${op.bold ? 'F2' : 'F1'} ${n(op.size)} Tf ${n(op.x)} ${n(page.height - op.y)} Td ${pdfString(op.text)} Tj ET`);
    } else if (op.t === 'line') {
      out.push(`0.55 G ${n(op.w)} w ${n(op.x1)} ${n(page.height - op.y1)} m ${n(op.x2)} ${n(page.height - op.y2)} l S`);
    } else {
      out.push(`${n(op.fill)} g ${n(op.x)} ${n(page.height - op.y - op.h)} ${n(op.w)} ${n(op.h)} re f`);
    }
  }
  return out.join('\n');
}

const hex4 = (v: number): string => v.toString(16).toUpperCase().padStart(4, '0');

/** Six capital letters from the glyph set: a subset font's name prefix, the same for the same glyphs. */
function subsetTag(face: Face, gids: readonly number[]): string {
  let h = face === 'bold' ? 0x811c9dc5 : 0x01000193;
  for (const g of gids) h = Math.imul(h ^ g, 0x01000193) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i += 1) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + Math.imul(i + 1, 0x9e3779b1) >>> 0;
  }
  return tag;
}

/** The ToUnicode map that lets a viewer copy and search the embedded text. */
function toUnicode(map: readonly { gid: number; cp: number }[]): string {
  const entries = map.map(({ gid, cp }) => {
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    return `<${hex4(gid)}> <${units.map(hex4).join('')}>`;
  });
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

export function pagesToPdf(pages: readonly PdfPage[], title: string): Uint8Array {
  const objects: (string | Uint8Array)[] = [];
  /** the dictionary that precedes each stream object */
  const contentDict = new Map<number, string>();
  const imageDict = new Map<number, string>();
  const add = (body: string | Uint8Array): number => {
    objects.push(body);
    return objects.length;
  };
  // 1 catalog, 2 pages, 3 info, 4 F1, 5 F2 — pages follow
  add('');
  add('');
  add(`<< /Title ${pdfString(title)} /Producer (WireHub) >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  // the vector pages' text: one subset of each Liberation Sans face, shared by every page
  const used: Record<Face, Map<number, number>> = { regular: new Map(), bold: new Map() };
  for (const p of pages) if (p.kind === 'vector') for (const g of p.glyphs) if (!used[g.face].has(g.gid)) used[g.face].set(g.gid, g.cp);
  const embedded: Partial<Record<Face, number>> = {};
  for (const face of ['regular', 'bold'] as const) {
    const gids = [...used[face].keys()].sort((a, b) => a - b);
    if (gids.length === 0) continue;
    const chosen = pages.flatMap((p) => (p.kind === 'vector' ? [p.fonts?.[face]] : [])).find((f) => f !== undefined);
    const font = chosen?.font ?? liberation(face);
    const program = font.subset(gids);
    const packed = deflateSync(program);
    const name = `${subsetTag(face, gids)}+${chosen?.name ?? 'LiberationSans'}${face === 'bold' ? '-Bold' : ''}`;
    const fileNo = add(packed);
    contentDict.set(fileNo, `<< /Filter /FlateDecode /Length ${packed.length} /Length1 ${program.length} >>`);
    const d = font.descriptor;
    const descriptorNo = add(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${d.bbox.join(' ')}] /ItalicAngle ${n(d.italicAngle)} /Ascent ${d.ascent} /Descent ${d.descent} /CapHeight ${Math.round(d.capHeight)} /StemV ${face === 'bold' ? 140 : 80} /FontFile2 ${fileNo} 0 R >>`,
    );
    const widths = gids.map((g) => `${g} [${Math.round((font.advance(g) * 1000) / font.unitsPerEm)}]`).join(' ');
    const cidNo = add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorNo} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${widths}] >>`,
    );
    const unicode = deflateSync(Buffer.from(toUnicode(gids.map((gid) => ({ gid, cp: used[face].get(gid) as number }))), 'latin1'));
    const unicodeNo = add(unicode);
    contentDict.set(unicodeNo, `<< /Filter /FlateDecode /Length ${unicode.length} >>`);
    embedded[face] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cidNo} 0 R] /ToUnicode ${unicodeNo} 0 R >>`);
  }
  const kids: number[] = [];
  pages.forEach((p, i) => {
    const w = p.kind === 'ops' ? p.page.width : p.width;
    const h = p.kind === 'ops' ? p.page.height : p.height;
    const pageNo = objects.length + 1;
    const streamNo = pageNo + 1;
    kids.push(pageNo);
    let resources = '/Font << /F1 4 0 R /F2 5 0 R >>';
    let stream: Uint8Array;
    let imageNo: number | undefined;
    if (p.kind === 'ops') {
      stream = deflateSync(Buffer.from(content(p.page), 'latin1'));
    } else if (p.kind === 'vector') {
      resources = `/Font << /F1 4 0 R /F2 5 0 R${embedded.regular === undefined ? '' : ` /E1 ${embedded.regular} 0 R`}${embedded.bold === undefined ? '' : ` /E2 ${embedded.bold} 0 R`} >>`;
      if (p.alphas.length > 0) resources += ` /ExtGState << ${p.alphas.map((a) => `/${a.key} << /ca ${n(a.ca)} /CA ${n(a.CA)} >>`).join(' ')} >>`;
      stream = deflateSync(Buffer.from(p.content, 'latin1'));
    } else {
      imageNo = streamNo + 1;
      resources += ` /XObject << /Im${i} ${imageNo} 0 R >>`;
      stream = deflateSync(Buffer.from(`q ${n(p.at.w)} 0 0 ${n(p.at.h)} ${n(p.at.x)} ${n(p.at.y)} cm /Im${i} Do Q`, 'latin1'));
    }
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(w)} ${n(h)}] /Resources << ${resources} >> /Contents ${streamNo} 0 R >>`);
    add(stream);
    if (p.kind === 'image' && imageNo !== undefined) {
      const raw = deflateSync(p.rgb);
      add(raw);
      // the dictionaries of the two streams are written below, by position
      imageDict.set(imageNo, `<< /Type /XObject /Subtype /Image /Width ${p.pixelWidth} /Height ${p.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${raw.length} >>`);
    }
    contentDict.set(streamNo, `<< /Filter /FlateDecode /Length ${stream.length} >>`);
  });
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  // `Info` is object 3; the trailer points at it

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const no = i + 1;
    const dict = contentDict.get(no) ?? imageDict.get(no);
    const head = Buffer.from(`${no} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    const middle =
      typeof body === 'string'
        ? Buffer.from(body, 'latin1')
        : Buffer.concat([Buffer.from(`${dict}\nstream\n`, 'latin1'), Buffer.from(body), Buffer.from('\nendstream', 'latin1')]);
    for (const part of [head, middle, tail]) {
      chunks.push(part);
      length += part.length;
    }
  });
  const xref = length;
  const table = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}
