/**
 * The vector PDF's text: the bundled Liberation Sans, embedded as a subset
 * TrueType font (cs: formboard PDF used the non-embedded Helvetica). The font
 * reader and subsetter (`server/render/ttf.ts`), and the PDF the formboard
 * route builds from them.
 */

import { inflateSync } from 'node:zlib';

import { loadDb, loadDesign } from '@wirehub/catalog';
import { deriveFormboard, formboardSvgPages, textWidth } from '@wirehub/docs';
import { describe, expect, it } from 'vitest';

import { liberation } from '../server/render/fonts.ts';
import { pagesToPdf } from '../server/render/pdf.ts';
import { svgToVectorPdfPage } from '../server/render/vector.ts';

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

/** The table directory of a font program: tag to its bytes. */
function tablesOf(font: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < view.getUint16(4); i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...font.subarray(at, at + 4));
    out.set(tag, font.subarray(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12)));
  }
  return out;
}

/** The stream of PDF object `no`, inflated. */
function streamOf(pdf: Uint8Array, no: number): Uint8Array {
  const text = latin1(pdf);
  const head = text.indexOf(`\n${no} 0 obj\n`);
  const dict = /<<[^>]*>>/.exec(text.slice(head))?.[0] as string;
  const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
  const start = text.indexOf('stream\n', head) + 'stream\n'.length;
  return inflateSync(pdf.subarray(start, start + length));
}

describe('the TrueType reader', () => {
  const regular = liberation('regular');
  const bold = liberation('bold');

  it('maps characters to glyphs and reads advances that agree with the sheet metrics', () => {
    expect(regular.unitsPerEm).toBe(2048);
    expect(regular.glyphFor('A'.codePointAt(0)!)).toBeGreaterThan(0);
    expect(regular.glyphFor('×'.codePointAt(0)!)).toBeGreaterThan(0);
    expect(regular.glyphFor('−'.codePointAt(0)!)).toBeGreaterThan(0);
    expect(regular.glyphFor(0x1f600)).toBe(0);
    // the widths the sheets are laid out with are these faces' own
    for (const text of ['W2 · DC power cable, 2 × 24 AWG, red/black', 'JST XH 2-pin housing, DC (1 = +V)', '300 mm']) {
      // the sheet's table is in whole thousandths of an em
      expect(regular.width(text, 3)).toBeCloseTo(textWidth(text, 3), 1);
      expect(bold.width(text, 3)).toBeCloseTo(textWidth(text, 3, true), 1);
    }
  });

  it('subsets to the glyphs asked for: a valid, small font program with only those outlines', () => {
    const wanted = [...'Pegs1:2'].map((c) => regular.glyphFor(c.codePointAt(0)!));
    const program = regular.subset(wanted);
    expect(program.length).toBeLessThan(20_000);
    // the checksum of the whole font, with its adjustment, is the constant a reader checks
    const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
    let sum = 0;
    for (let i = 0; i < program.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
    const tables = tablesOf(program);
    expect([...tables.keys()]).toEqual([...tables.keys()].sort());
    expect(tables.has('glyf') && tables.has('loca') && tables.has('head') && tables.has('hmtx')).toBe(true);
    const loca = new DataView(tables.get('loca')!.buffer, tables.get('loca')!.byteOffset);
    const glyph = (g: number): number => loca.getUint32((g + 1) * 4) - loca.getUint32(g * 4);
    for (const g of wanted) expect(glyph(g), `glyph ${g}`).toBeGreaterThan(0);
    // a glyph nobody asked for carries no outline
    const other = regular.glyphFor('Q'.codePointAt(0)!);
    if (other < tables.get('loca')!.length / 4 - 1) expect(glyph(other)).toBe(0);
    // the same glyphs give the same bytes
    expect(Buffer.from(regular.subset(wanted)).equals(Buffer.from(program))).toBe(true);
  });
});

describe('the formboard PDF', () => {
  const board = deriveFormboard(loadDesign('dc-y-splitter'), loadDb());
  const pages = formboardSvgPages(board, { scale: 0.5 }).map((svg) => svgToVectorPdfPage(svg, { width: 841.89, height: 595.28 }));
  const pdf = pagesToPdf(pages, 'dc-y-splitter — formboard');
  const text = latin1(pdf);

  it('embeds Liberation Sans as TrueType subsets, with a map back to text', () => {
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans /);
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans-Bold /);
    // …and the sheet frame's text in the embedded IBM Plex subsets, not Liberation (cs-mn9h)
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+IBMPlexSans /);
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+IBMPlexMono/);
    const files = text.match(/\/FontFile2 \d+ 0 R/g)!.length;
    expect(files).toBeGreaterThanOrEqual(4);
    expect(text.match(/\/ToUnicode \d+ 0 R/g)).toHaveLength(files);
    // every page that has text draws it with the embedded faces, never the standard Helvetica
    for (const page of pages) {
      expect(page.content).toContain('/E1 ');
      expect(page.content).not.toMatch(/\/F[12] [\d.]+ Tf/);
    }
    // the font file in the PDF is a TrueType program holding the glyphs the pages use
    const file = Number(/\/FontFile2 (\d+) 0 R/.exec(text)![1]);
    const program = streamOf(pdf, file);
    expect(new DataView(program.buffer, program.byteOffset).getUint32(0)).toBe(0x00010000);
    expect(program.length).toBeLessThan(40_000);
    // …and the map names the characters: a capital J (J1..J3) is in it
    const map = latin1(streamOf(pdf, Number(/\/ToUnicode (\d+) 0 R/.exec(text)![1])));
    expect(map).toContain(`<${regular().gid('J')}> <004A>`);
  });

  it('is the same bytes every time', () => {
    const again = pagesToPdf(formboardSvgPages(board, { scale: 0.5 }).map((svg) => svgToVectorPdfPage(svg, { width: 841.89, height: 595.28 })), 'dc-y-splitter — formboard');
    expect(Buffer.from(again).equals(Buffer.from(pdf))).toBe(true);
  });

  it('shows a character the face lacks as the standard text did, not as a hole', () => {
    const page = svgToVectorPdfPage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="5" font-size="2">a\u{1f600}b</text></svg>', { width: 100, height: 100 });
    const question = liberation('regular').glyphFor('?'.codePointAt(0)!);
    expect(page.glyphs.map((g) => g.cp).sort()).toEqual(['a', '?', 'b'].map((c) => c.codePointAt(0)!).sort());
    expect(page.glyphs.find((g) => g.cp === 0x3f)?.gid).toBe(question);
  });
});

function regular(): { gid: (c: string) => string } {
  const font = liberation('regular');
  return { gid: (c) => font.glyphFor(c.codePointAt(0)!).toString(16).toUpperCase().padStart(4, '0') };
}
