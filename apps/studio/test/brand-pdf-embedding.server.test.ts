/** Licensed bundled fonts exercise real outlines, identity glyph mappings and fallback exports. */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { create } from 'fontkit';
import { loadDb, loadDesign } from '@wirehub/catalog';
import { sans } from '@wirehub/docs/src/drawing/fonts.generated.ts';
import { describe, expect, it } from 'vitest';
import { brandFont, inspectFont } from '../server/render/brand-font.ts';
import { pdfFont } from '../server/render/fonts.ts';
import { renderDocument, withBranding } from '../server/render/index.ts';
import { pagesToPdf } from '../server/render/pdf.ts';
import { svgToVectorPdfPage } from '../server/render/vector.ts';

const cff = new Uint8Array(readFileSync(new URL('../../../packages/docs/fonts/texgyreadventor-regular.otf', import.meta.url)));
const woff = new Uint8Array(Buffer.from(sans.woff2, 'base64'));
const textOf = (b: Uint8Array) => Buffer.from(b).toString('latin1');
function stream(pdf: Uint8Array, no: number): Uint8Array {
  const text = textOf(pdf);
  const head = text.indexOf(`\n${no} 0 obj\n`);
  const length = Number(/\/Length (\d+)/.exec(text.slice(head))![1]);
  const start = text.indexOf('stream\n', head) + 7;
  return inflateSync(pdf.subarray(start, start + length));
}
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

describe('brand font programs in PDF', () => {
  for (const [name, bytes, type] of [['CFF OpenType', cff, 3], ['transformed WOFF2', woff, 2]] as const) {
    it(`retains the ${name} outlines, glyph IDs and metrics`, () => {
      const info = inspectFont(bytes);
      const original = create(bytes);
      const decoded = create(info.program!);
      for (const ch of ['A', 'a', '0', 'é', 'Ω']) {
        const gid = original.glyphForCodePoint(ch.codePointAt(0)!).id;
        expect(decoded.glyphForCodePoint(ch.codePointAt(0)!).id).toBe(gid);
        expect(decoded.getGlyph(gid).advanceWidth).toBe(original.getGlyph(gid).advanceWidth);
        expect(decoded.getGlyph(gid).path.toSVG()).toBe(original.getGlyph(gid).path.toSVG());
      }
      if (type === 3) expect(textOf(info.program!).slice(0, 4)).toBe('OTTO');
      const font = brandFont(bytes, bytes);
      const make = () => withBranding({ font }, () => {
        const page = svgToVectorPdfPage('<svg viewBox="0 0 100 30"><text x="1" y="15">AéΩ0</text></svg>', { width: 100, height: 30 });
        return { page, pdf: pagesToPdf([page], 'brand font') };
      });
      const { page, pdf } = make();
      const text = textOf(pdf);
      expect(text).toContain(`/FontFile${type}`);
      expect(text).toContain(`/Subtype /CIDFontType${type === 3 ? 0 : 2}`);
      if (type === 3) {
        expect(text).toContain('/Subtype /OpenType');
        expect(text).not.toContain('/CIDToGIDMap');
      }
      const embedded = create(stream(pdf, Number(new RegExp(`/FontFile${type} (\\d+)`).exec(text)![1])));
      for (const g of page.glyphs) expect(embedded.getGlyph(g.gid).path.toSVG()).toBe(original.getGlyph(g.gid).path.toSVG());
      const map = textOf(stream(pdf, Number(/\/ToUnicode (\d+)/.exec(text)![1])));
      for (const g of page.glyphs) {
        expect(map).toContain(`<${hex(g.gid)}> <${hex(g.cp)}>`);
        const chosen = page.fonts![g.face]!.font;
        expect(text).toContain(`${g.gid} [${Math.round(chosen.advance(g.gid) * 1000 / chosen.unitsPerEm)}]`);
      }
      expect(Buffer.from(make().pdf).equals(Buffer.from(pdf))).toBe(true);
    });
  }

  it('uses the brand font in every plain-text fallback PDF export', async () => {
    const font = brandFont(cff, cff);
    for (const kind of ['build-sheet', 'bom', 'test-spec'] as const) {
      const result = await renderDocument({ kind, format: 'pdf', design: loadDesign('dc-led-lead'), db: loadDb(), branding: { font } });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const pdf = result.output.body as Uint8Array;
      const text = textOf(pdf);
      expect(result.pdf?.renderer).toBe('text-layout');
      expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+TeXGyreAdventor/);
      expect(text).toContain('/FontFile3');
      const content = textOf(stream(pdf, Number(/\/Contents (\d+)/.exec(text)![1])));
      expect(content).toMatch(/\/E[12] [\d.]+ Tf/);
      expect(content).not.toMatch(/\/F[12] [\d.]+ Tf/);
    }
  });

  it('preserves the full TrueType program when subsetting is prohibited', () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../packages/docs/fonts/LiberationSans-Regular.ttf', import.meta.url)));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < view.getUint16(4); i += 1) {
      const at = 12 + i * 16;
      if (textOf(bytes.subarray(at, at + 4)) === 'OS/2') view.setUint16(view.getUint32(at + 8) + 8, 0x0100);
    }
    const selected = withBranding({ font: brandFont(bytes) }, () => pdfFont('regular').font);
    expect(Buffer.from(selected.subset([selected.glyphFor(65)])).equals(Buffer.from(bytes))).toBe(true);
  });

  it('keeps restricted and bitmap-only embedding flags enforced', () => {
    for (const flag of [0x0002, 0x0200]) {
      const bytes = cff.slice();
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < view.getUint16(4); i += 1) {
        const at = 12 + i * 16;
        if (textOf(bytes.subarray(at, at + 4)) === 'OS/2') view.setUint16(view.getUint32(at + 8) + 8, flag);
      }
      expect(inspectFont(bytes).embeddable).toBe(false);
      expect(withBranding({ font: brandFont(bytes) }, () => pdfFont('regular').name)).toBe('LiberationSans');
    }
  });
});
