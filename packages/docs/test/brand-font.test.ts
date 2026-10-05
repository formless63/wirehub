/**
 * The hub's own typeface on the sheets (`drawing/brand-font.ts`): registered through `DrawingArt.font`,
 * it is carried inline by the HTML sheets and the drawing, measured by its own widths, and first in the
 * stacks; unregistered, nothing about a sheet changes.
 */

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { drawingArtProblems, registerDrawingArt, renderBuildSheet, renderDrawingSheet, textWidth, type BrandFace, type DrawingArt } from '../src/index.ts';

const db = loadDb();
const design = loadDesign(listDesignIds()[0]!);

const face = (family: string, width: number): BrandFace => ({ family, mime: 'font/ttf', base64: Buffer.from(`not really ${family}`).toString('base64'), widths: { A: width, B: width }, embeddable: false, rasterizable: false });
const art = (font: DrawingArt['font']): DrawingArt => ({ font });

describe('the brand typeface', () => {
  it('leaves a sheet exactly as it was when none is registered', () => {
    const before = renderDrawingSheet(design, db);
    const off = registerDrawingArt({ titleBlock: { organisation: 'Acme' } });
    off();
    expect(renderDrawingSheet(design, db)).toBe(before);
    expect(before).not.toContain('CS Brand');
    expect(renderBuildSheet(design, db)).not.toContain('CS Brand');
  });

  it('is carried inline, first in the stacks, by the drawing and the HTML sheets', () => {
    const off = registerDrawingArt(art({ regular: face('Acme Sans', 700), bold: face('Acme Sans Bold', 800) }));
    try {
      const drawing = renderDrawingSheet(design, db);
      expect(drawing).toContain("@font-face{font-family:'CS Brand';font-style:normal;font-weight:400;src:url(data:font/ttf;base64,");
      expect(drawing).toContain("font-weight:700;src:url(data:font/ttf;base64,");
      expect(drawing).toContain(`font-family="'CS Brand','CS Sans'`);
      const sheet = renderBuildSheet(design, db);
      expect(sheet).toContain("--cs-font:'CS Brand',");
      expect(sheet).toContain("font-family:'CS Brand'");
    } finally {
      off();
    }
  });

  it('measures text in its own widths, falling back to the bundled sans for a glyph it lacks', () => {
    const plain = textWidth('AC', 10);
    const bundledC = textWidth('C', 10);
    const off = registerDrawingArt(art({ regular: face('Acme Sans', 1000) }));
    try {
      expect(textWidth('A', 10)).toBe(10);
      // 'C' is not in the brand font's widths: the bundled width stands in
      expect(textWidth('AC', 10)).toBeCloseTo(10 + bundledC, 5);
      expect(textWidth('A', 10, true)).toBe(10);
    } finally {
      off();
    }
    expect(textWidth('AC', 10)).toBe(plain);
  });

  it('the first registration to set a font wins, so a module still beats the settings', () => {
    const first = registerDrawingArt(art({ regular: face('Module Sans', 500) }));
    const second = registerDrawingArt(art({ regular: face('Setting Sans', 900) }));
    try {
      expect(textWidth('A', 10)).toBe(5);
    } finally {
      second();
      first();
    }
  });

  it('is checked before it is registered', () => {
    expect(drawingArtProblems({ font: { regular: face('Ok', 500) } })).toEqual([]);
    expect(drawingArtProblems({ font: { regular: { family: 'x' } } }).join(' ')).toMatch(/regular font needs/);
    expect(drawingArtProblems({ font: { regular: { ...face('x', 1), mime: 'font/woff' } } }).join(' ')).toMatch(/regular font needs/);
  });
});
