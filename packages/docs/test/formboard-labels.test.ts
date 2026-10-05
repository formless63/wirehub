/**
 * Formboard label collision avoidance: the geometry (`formboard-labels.ts`),
 * and what it does on the Y splitter at the tile scales a shop prints at —
 * no caption sits on a connector glyph, a peg, a tick or another caption, and
 * a caption the tile edge would cut is whole on the tile where it fits.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { deriveFormboard, formboardPageCount, formboardSvg } from '../src/index.ts';
import { textWidth } from '../src/drawing/render.ts';
import { Occupied, overlaps, placeFirstFree, rotatedRect, shiftIntoView, thickLine, type Poly } from '../src/formboard-labels.ts';

const db = loadDb();

describe('the geometry', () => {
  it('tells overlapping rectangles from clear and touching ones', () => {
    const a = rotatedRect({ x: 0, y: 0 }, 10, 4, 0);
    expect(overlaps(a, rotatedRect({ x: 8, y: 0 }, 10, 4, 0))).toBe(true);
    expect(overlaps(a, rotatedRect({ x: 10, y: 0 }, 10, 4, 0))).toBe(false);
    expect(overlaps(a, rotatedRect({ x: 0, y: 6 }, 10, 4, 0))).toBe(false);
  });

  it('tests turned rectangles and lines, not their bounding boxes', () => {
    const slanted = thickLine({ x: -10, y: -10 }, { x: 10, y: 10 }, 0.5);
    // the corner of the box a slanted line's bounding box would cover, with no line in it
    expect(overlaps(slanted, rotatedRect({ x: 8, y: -8 }, 3, 3, 0))).toBe(false);
    expect(overlaps(slanted, rotatedRect({ x: 0, y: 0 }, 3, 3, 0))).toBe(true);
    expect(overlaps(rotatedRect({ x: 0, y: 0 }, 20, 2, 45), rotatedRect({ x: 6, y: 6 }, 2, 2, 0))).toBe(true);
    expect(overlaps(rotatedRect({ x: 0, y: 0 }, 20, 2, 45), rotatedRect({ x: 6, y: -6 }, 2, 2, 0))).toBe(false);
  });

  it('places the first free candidate, records it, and keeps the home place when none is free', () => {
    const occupied = new Occupied();
    occupied.add(rotatedRect({ x: 0, y: 0 }, 10, 4, 0));
    const at = (c: { y: number }): Poly => rotatedRect({ x: 0, y: c.y }, 10, 4, 0);
    expect(placeFirstFree(occupied, [{ y: 0 }, { y: 2 }, { y: 6 }, { y: 20 }], at)).toEqual({ y: 6 });
    // the second caption now has to clear the first
    expect(placeFirstFree(occupied, [{ y: 6 }, { y: 10 }], at)).toEqual({ y: 10 });
    expect(placeFirstFree(occupied, [{ y: 0 }, { y: 6 }], at)).toEqual({ y: 0 });
  });

  it('pulls a span inside a view only when it fits whole', () => {
    const view = { x0: 0, y0: 0, x1: 100, y1: 50 };
    expect(shiftIntoView(10, 40, view)).toBe(0);
    expect(shiftIntoView(-20, 10, view)).toBe(21);
    expect(shiftIntoView(80, 120, view)).toBe(-21);
    expect(shiftIntoView(-20, 150, view)).toBe(0);
    expect(shiftIntoView(-20, 10, undefined)).toBe(0);
  });
});

interface Caption {
  group: string;
  poly: Poly;
  body: string;
}

/** The captions, glyphs, ticks and pegs of one page as polygons, read back from its SVG. */
function read(svg: string): { captions: Caption[]; glyphs: { kind: string; poly: Poly }[]; ticks: Poly[]; pegs: Poly[] } {
  const num = (attrs: string, key: string): number => Number(new RegExp(`${key}="(-?[\\d.]+)"`).exec(attrs)?.[1] ?? 0);
  const captions: Caption[] = [];
  const textRe = /<text ([^>]*)>([^<]*)<\/text>/g;
  for (const m of svg.matchAll(textRe)) {
    const attrs = m[1] as string;
    const body = (m[2] as string).replace(/&amp;/g, '&');
    const group = /data-caption="([^"]+)"/.exec(attrs)?.[1];
    if (group !== undefined) {
      const size = num(attrs, 'font-size');
      const bold = attrs.includes('font-weight="bold"');
      const w = textWidth(body, size, bold);
      const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? 'start';
      const x = num(attrs, 'x');
      const y = num(attrs, 'y');
      const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      captions.push({ group, body, poly: [{ x: x0, y: y - size * 0.78 }, { x: x0 + w, y: y - size * 0.78 }, { x: x0 + w, y: y + size * 0.22 }, { x: x0, y: y + size * 0.22 }] });
    }
  }
  // a peg's and a tick's own names are captions too
  for (const m of svg.matchAll(/<g data-(peg|marker)="([^"]+)">(.*?)<\/g>/g)) {
    const inner = m[3] as string;
    const t = /<text ([^>]*)>([^<]*)<\/text>/.exec(inner);
    if (t === null) continue;
    const attrs = t[1] as string;
    const size = num(attrs, 'font-size');
    const body = t[2] as string;
    const w = textWidth(body, size, attrs.includes('font-weight="bold"'));
    const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? 'start';
    const x = num(attrs, 'x');
    const y = num(attrs, 'y');
    const rot = /rotate\((-?[\d.]+)/.exec(attrs)?.[1];
    const middle = attrs.includes('dominant-baseline="middle"');
    const top = middle ? -size * 0.5 : -size * 0.78;
    const bottom = middle ? size * 0.5 : size * 0.22;
    const x0 = anchor === 'middle' ? -w / 2 : anchor === 'end' ? -w : 0;
    const a = (Number(rot ?? 0) * Math.PI) / 180;
    const corner = (lx: number, ly: number): { x: number; y: number } => ({ x: x + lx * Math.cos(a) - ly * Math.sin(a), y: y + lx * Math.sin(a) + ly * Math.cos(a) });
    captions.push({ group: `${m[1]}:${m[2]}`, body, poly: [corner(x0, top), corner(x0 + w, top), corner(x0 + w, bottom), corner(x0, bottom)] });
  }
  const glyphs: { kind: string; poly: Poly }[] = [];
  for (const m of svg.matchAll(/<g data-(terminus|mould)="[^"]+" transform="translate\((-?[\d.]+) (-?[\d.]+)\) rotate\((-?[\d.]+)\)"><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    glyphs.push({ kind: m[1] as string, poly: rotatedRect({ x: Number(m[2]), y: Number(m[3]) }, Number(m[7]), Number(m[8]), Number(m[4])) });
  }
  const ticks: Poly[] = [];
  for (const m of svg.matchAll(/<g data-marker="[^"]+"><line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g)) {
    ticks.push(thickLine({ x: Number(m[1]), y: Number(m[2]) }, { x: Number(m[3]), y: Number(m[4]) }, 0.7));
  }
  const pegs: Poly[] = [];
  for (const m of svg.matchAll(/<g data-peg="[^"]+"><circle cx="(-?[\d.]+)" cy="(-?[\d.]+)"/g)) pegs.push(rotatedRect({ x: Number(m[1]), y: Number(m[2]) }, 4, 4, 0));
  return { captions, glyphs, ticks, pegs };
}

describe('captions on the Y splitter', () => {
  const board = deriveFormboard(loadDesign('dc-y-splitter'), db);

  for (const scale of [1, 0.5]) {
    it(`touch no glyph, peg, tick or other caption at ${scale === 1 ? '1:1' : '1:2'}`, () => {
      const pages = formboardPageCount(board, { scale });
      for (let page = 1; page < pages; page += 1) {
        const { captions, glyphs, ticks, pegs } = read(formboardSvg(board, page, { scale }));
        captions.forEach((caption, i) => {
          const what = `page ${page}: ${caption.group} '${caption.body}'`;
          // a breakout's peg sits inside its mould: its label may too
          for (const glyph of glyphs) if (!(glyph.kind === 'mould' && caption.group.startsWith('peg:'))) expect(overlaps(caption.poly, glyph.poly), `${what} on a glyph`).toBe(false);
          for (const tick of ticks) expect(overlaps(caption.poly, tick), `${what} on a tick`).toBe(false);
          // a peg label beside its own cross is the peg; every other caption keeps off every peg
          if (!caption.group.startsWith('peg:')) for (const peg of pegs) expect(overlaps(caption.poly, peg), `${what} on a peg`).toBe(false);
          captions.slice(i + 1).forEach((other) => {
            if (other.group === caption.group) return;
            expect(overlaps(caption.poly, other.poly), `${what} on ${other.group} '${other.body}'`).toBe(false);
          });
        });
      }
    });
  }

  it("keeps the mould's caption whole on each tile that shows the breakout, where it fits", () => {
    // at 1:2 the breakout sits across the join of pages 3 and 4: the name is whole on both
    for (const page of [3, 4]) {
      const { captions } = read(formboardSvg(board, page, { scale: 0.5 }));
      const lines = captions.filter((c) => c.group === 'mould:bk1');
      expect(lines.length, `page ${page}`).toBeGreaterThan(0);
      for (const line of lines) {
        const xs = line.poly.map((p) => p.x);
        expect(Math.min(...xs), `page ${page}: '${line.body}' past the left edge`).toBeGreaterThanOrEqual(12);
        expect(Math.max(...xs), `page ${page}: '${line.body}' past the right edge`).toBeLessThanOrEqual(285);
      }
    }
  });

  it('leaves a caption where it always was when nothing is in its way', () => {
    // J1, at the trunk's free end at 1:2, has nothing near it
    const { captions } = read(formboardSvg(board, 1, { scale: 0.5 }));
    const j1 = captions.filter((c) => c.group === 'terminus:w1/a');
    expect(j1.map((c) => c.body)).toEqual(['J1', 'Terminal block, 4-way, 5.08 mm']);
  });
});
