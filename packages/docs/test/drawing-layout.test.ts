/**
 * Drawing-sheet layout: set in IBM Plex, and no text out of its cell at A4 or Letter. The BOM
 * table wraps a long material instead of squeezing it, every cell's text measures within its
 * column, and the composition keeps a readable scale inside the frame.
 */

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { PAPER_IDS, paperSize, plexWidth, renderDrawingSheet, type PaperId } from '../src/index.ts';

const db = loadDb();
const ids = listDesignIds();

/** the BOM table's columns on the composition's grid, pt */
const COLS = [449.7, 477.3, 579.3, 745.5, 780] as const;

interface Txt {
  x: number;
  y: number;
  size: number;
  mono: boolean;
  bold: boolean;
  anchor: string;
  text: string;
}

function textsIn(svg: string, group: string): Txt[] {
  const start = svg.indexOf(`<g class="${group}">`);
  const end = svg.indexOf('</g>', start);
  const body = svg.slice(start, end);
  return [...body.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attr = (name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(m[1] as string)?.[1];
    return {
      x: Number(attr('x')),
      y: Number(attr('y')),
      size: Number(attr('font-size')),
      mono: (attr('font-family') ?? '').includes('Mono'),
      bold: attr('font-weight') !== undefined,
      anchor: attr('text-anchor') ?? 'start',
      text: (m[2] as string).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
    };
  });
}

describe('drawing sheet type and layout', () => {
  for (const paper of ['A4', 'letter', 'A3'] as const satisfies readonly PaperId[]) {
    for (const id of ids) {
      it(`${id} on ${paper}: the BOM's cells hold their text at full size, and the sheet is set in Plex`, () => {
        const html = renderDrawingSheet(loadDesign(id), db, { paper, state: 'RELEASED' });
        expect(html).toMatch(/font-family="[^"]*IBM Plex Sans/);
        expect(html).toMatch(/font-family="[^"]*IBM Plex Mono/);
        expect(html).not.toContain('CS Gothic');
        for (const t of textsIn(html, 'ra-bom')) {
          // every cell is set at one of two sizes: the header or the body text; never squeezed
          expect(t.size).toBeGreaterThanOrEqual(8.5);
          const column = COLS.findIndex((c, i) => i < COLS.length - 1 && (t.anchor === 'middle' ? t.x > c && t.x < (COLS[i + 1] as number) : t.x >= c && t.x < (COLS[i + 1] as number)));
          expect(column).toBeGreaterThanOrEqual(0);
          const width = plexWidth(t.text, t.size, t.mono ? 'mono' : t.bold ? 'semi' : 'sans', 0, 1);
          const left = t.anchor === 'middle' ? t.x - width / 2 : t.x;
          expect(left).toBeGreaterThanOrEqual((COLS[column] as number) - 0.01);
          expect(left + width).toBeLessThanOrEqual((COLS[column + 1] as number) + 0.01);
        }
      });
    }
  }

  it('wraps a long material onto lines in its own cell instead of shrinking it', () => {
    const svg = renderDrawingSheet(loadDesign('de9-crossover'), db);
    const material = textsIn(svg, 'ra-bom').filter((t) => t.x > COLS[2] && t.x < COLS[3]);
    // the cable's material is longer than the cell: two lines, both at the body size
    const cable = material.filter((t) => /CABLE|FOIL/.test(t.text));
    expect(cable.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cable.map((t) => t.size))).toEqual(new Set([9]));
  });

  it('keeps the composition readable on every paper (never scaled below half)', () => {
    for (const paper of PAPER_IDS) {
      const html = renderDrawingSheet(loadDesign(ids[0] as string), db, { paper, revisions: [{ rev: 'A', description: 'First', date: '2026.09.01', by: 'AB' }, { rev: 'B', description: 'Second', date: '2026.09.02', by: 'AB' }] });
      const scale = Number(/class="wh-content" transform="translate\([\d.-]+ [\d.-]+\) scale\(([\d.]+)\)"/.exec(html)?.[1]);
      const { width } = paperSize(paper, 'landscape');
      // millimetres per composition point: 0.353 would be life-size; a smaller paper shrinks it, but never past half
      expect(scale).toBeGreaterThanOrEqual(0.5 * 0.3528 * Math.min(1, width / 279.4) - 1e-3);
    }
  });
});
