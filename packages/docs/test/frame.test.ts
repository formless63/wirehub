/**
 * The sheet frame (`src/frame/`): one border, title block and state stamp for every sheet.
 * Geometry is data, so the layout is tested without a browser: every cell on every paper
 * holds the text it is given (nothing overflows at A4, Letter or the larger sizes), the
 * ANSI and ISO layouts are chosen as data, and every renderer draws the same metrics.
 */

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import {
  FRAME_METRICS,
  PAPERS,
  PAPER_IDS,
  TITLE_BLOCKS,
  TITLE_BLOCK_STANDARDS,
  deriveLabels,
  deriveFormboard,
  formboardSvg,
  frameGeometry,
  framedSchematicSvg,
  framedSvg,
  labelSheetSvg,
  paperSize,
  parsePaper,
  plexWidth,
  registerDrawingArt,
  renderBomSheet,
  renderBuildSheet,
  renderDrawingSheet,
  renderTestSpecSheet,
  schematicFrame,
  sheetFrameFor,
  stampOf,
  type FrameCell,
  type SheetFrameSpec,
} from '../src/index.ts';
import { PT_MM } from '../src/frame/layout.ts';
import { renderSchematic } from '@wirehub/render-svg';

const db = loadDb();
const ids = listDesignIds();

const LONG = 'Terminal block → moulded Y → 2× JST XH, two-channel DC splitter with a long, long title that must wrap or shrink';

function spec(over: Partial<SheetFrameSpec> = {}): SheetFrameSpec {
  return {
    paper: 'A4',
    orientation: 'portrait',
    standard: 'iso',
    variant: 'full',
    kind: 'Build sheet',
    org: 'Example Cable Company, Incorporated',
    title: LONG,
    pn: 'CBL-00042-XXL',
    rev: 'B',
    state: 'UNRELEASED · awaiting approval',
    drawn: 'A. Designer',
    checked: 'C. Checker',
    date: '2026.10.08',
    sheet: '12 of 14',
    ...over,
  };
}

const inside = (inner: { x: number; y: number; w: number; h: number }, outer: { x: number; y: number; w: number; h: number }): boolean =>
  inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 && inner.x + inner.w <= outer.x + outer.w + 1e-6 && inner.y + inner.h <= outer.y + outer.h + 1e-6;

const overlap = (a: FrameCell, b: FrameCell): boolean => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

describe('paper', () => {
  it('knows the A and ANSI sizes, in either orientation', () => {
    expect(paperSize('A4')).toEqual({ width: 210, height: 297 });
    expect(paperSize('letter', 'landscape')).toEqual({ width: 279.4, height: 215.9 });
    expect(PAPER_IDS.length).toBeGreaterThanOrEqual(8);
    for (const id of PAPER_IDS) expect(PAPERS[id].standard).toMatch(/^(ansi|iso)$/);
  });

  it('reads the old spellings', () => {
    expect(parsePaper('a4')).toBe('A4');
    expect(parsePaper('Letter')).toBe('letter');
    expect(parsePaper('A5')).toBeUndefined();
  });
});

describe('a very long design title in the title cell', () => {
  /** titles sized from the cell: about 1.3 lines (needs the second line, is never cut), 6 lines of words, and one unbroken word 3 lines wide */
  const CASES = ['medium', 'very-long', 'unbroken'] as const;
  const build = (kind: (typeof CASES)[number], wide: number, base: number): string => {
    let title = kind === 'unbroken' ? 'X' : 'Cable';
    const target = wide * (kind === 'medium' ? 1.3 : kind === 'very-long' ? 6 : 3);
    while (plexWidth(title, base, 'semi') < target) title += kind === 'unbroken' ? 'X' : ' assembly with balanced pigtails';
    return title;
  };
  for (const paper of PAPER_IDS) {
    for (const standard of TITLE_BLOCK_STANDARDS) {
      for (const variant of ['full', 'strip'] as const) {
        it(`${paper} ${standard} ${variant}: wraps to a second line, shrinks to a floor, then ellipsizes; never leaves its cell`, () => {
          for (const sample of CASES) {
            const base = variant === 'strip' ? FRAME_METRICS.stripValuePt : FRAME_METRICS.titlePt;
            const probe = frameGeometry(spec({ paper, standard, variant, title: 'x' })).titleCells.find((c) => c.field === 'title') as FrameCell;
            const title = build(sample, (probe.w - probe.inset - FRAME_METRICS.cellX) / PT_MM, base);
            const geo = frameGeometry(spec({ paper, standard, variant, title }));
            const cell = geo.titleCells.find((c) => c.field === 'title') as FrameCell;
            const room = cell.w - cell.inset - FRAME_METRICS.cellX;
            expect(cell.value.lines.length).toBeLessThanOrEqual(2);
            for (const line of cell.value.lines) expect(plexWidth(line, cell.value.size, cell.value.kind) * PT_MM).toBeLessThanOrEqual(room + 1e-6);
            // the floor: 80 % of the size that fits two lines, never below 4 pt
            expect(cell.value.size).toBeGreaterThanOrEqual(4);
            // vertically: under the caption, above the cell's bottom edge
            const pitch = cell.value.size * PT_MM * 1.18;
            const top = cell.h - 1.2 - (cell.value.lines.length - 1) * pitch - pitch * 0.8;
            expect(top).toBeGreaterThanOrEqual(cell.captionPt * PT_MM + 0.7 - 1e-6);
            if (sample !== 'medium') expect(cell.value.lines.at(-1)).toMatch(/…$/);
            else {
              // fits in two lines: nothing is cut
              expect(cell.value.lines.join(' ')).toBe(title);
              expect(cell.value.lines.length).toBe(2);
            }
          }
        });
      }
    }
  }
});

describe('frame geometry', () => {
  for (const paper of PAPER_IDS) {
    for (const orientation of ['portrait', 'landscape'] as const) {
      for (const standard of TITLE_BLOCK_STANDARDS) {
        for (const variant of ['full', 'strip'] as const) {
          it(`${paper} ${orientation} ${standard} ${variant}: every cell holds its text, the block sits in the border, nothing overlaps`, () => {
            const geo = frameGeometry(spec({ paper, orientation, standard, variant, revisions: variant === 'full' ? [{ rev: 'A', description: 'First release of the build sheet, with a description that is rather too long to fit', date: '2026.09.01', by: 'AB' }] : undefined, extras: variant === 'full' ? { material: 'See BOM', notes: ['ALL DIMENSIONS ARE', 'IN MM UNLESS', 'OTHERWISE SPECIFIED'], tolerances: [['x.xx', '± 0.1'], ['FRACTIONAL', '± 1/16']] } : undefined }));
            expect(geo.border.w).toBeCloseTo(geo.page.width - 2 * FRAME_METRICS.margin, 6);
            expect(geo.content.h).toBeGreaterThan(40);
            expect(inside(geo.title, geo.border)).toBe(true);
            for (const cell of [...geo.titleCells, ...geo.revisionCells]) {
              expect(inside(cell, geo.border)).toBe(true);
              const room = cell.w - cell.inset - FRAME_METRICS.cellX;
              for (const line of cell.value.lines) expect(plexWidth(line, cell.value.size, cell.value.kind) * PT_MM).toBeLessThanOrEqual(room + 1e-6);
              if (cell.caption !== '') expect(plexWidth(cell.caption, cell.captionPt, 'sans', 0.06) * PT_MM).toBeLessThanOrEqual(cell.w - FRAME_METRICS.cellX);
              // the lines stack inside the cell, under its caption
              const pitch = cell.value.size * PT_MM * 1.18;
              expect(cell.value.lines.length * pitch).toBeLessThanOrEqual(cell.h - 1.2);
            }
            for (const [i, a] of geo.titleCells.entries()) for (const b of geo.titleCells.slice(i + 1)) expect(overlap(a, b)).toBe(false);
            if (geo.revision !== undefined) {
              expect(geo.revision.y + geo.revision.h).toBeLessThanOrEqual(geo.title.y + 1e-6);
              expect(geo.content.y + geo.content.h).toBeLessThanOrEqual(geo.revision.y);
            }
          });
        }
      }
    }
  }

  it('shares one border and one strip across every sheet on a paper', () => {
    const a = frameGeometry(spec({ variant: 'strip', kind: 'BOM', title: 'x' }));
    const b = frameGeometry(spec({ variant: 'strip', kind: 'Labels', title: 'a quite different title', pn: undefined }));
    expect(a.border).toEqual(b.border);
    expect(a.title).toEqual(b.title);
    expect(a.titleCells.map((c) => [c.field, c.x, c.w])).toEqual(b.titleCells.map((c) => [c.field, c.x, c.w]));
  });

  it('draws the ANSI layout as a full-width block and the ISO layout as a block at the bottom right, from data', () => {
    const ansi = frameGeometry(spec({ standard: 'ansi' }));
    const iso = frameGeometry(spec({ standard: 'iso' }));
    expect(ansi.title.w).toBeCloseTo(ansi.border.w, 6);
    expect(iso.title.w).toBe(TITLE_BLOCKS.iso.full.width);
    expect(iso.title.x + iso.title.w).toBeCloseTo(iso.border.x + iso.border.w, 6);
  });

  it('prints the sheet cell only when it knows the sheet', () => {
    expect(frameGeometry(spec({ sheet: undefined })).titleCells.some((c) => c.field === 'sheet')).toBe(false);
    expect(frameGeometry(spec({ sheet: '1 of 3' })).titleCells.some((c) => c.field === 'sheet')).toBe(true);
  });

  it('stamps the states that are not released, and only those', () => {
    expect(stampOf('UNRELEASED')).toBe('UNRELEASED');
    expect(stampOf('UNRELEASED · awaiting approval')).toBe('UNRELEASED');
    expect(stampOf('UNAPPROVED · not approved')).toBe('UNAPPROVED');
    expect(stampOf('draft')).toBe('DRAFT');
    expect(stampOf('RELEASED · approved by AB 2026-10-01')).toBeUndefined();
    expect(stampOf(undefined)).toBeUndefined();
  });
});

describe('the HTML sheets’ blocks fit the column the page’s text runs in', () => {
  const design = loadDesign(ids[0] as string);
  for (const paper of PAPER_IDS) {
    for (const titleBlock of TITLE_BLOCK_STANDARDS) {
      it(`${paper} ${titleBlock}: the title block and the strip are no wider than the page inside its border and padding (else the printed page is shrunk to fit)`, () => {
        const html = renderBomSheet(design, db, { paper, titleBlock, depictions: false });
        const column = paperSize(paper).width - 2 * (FRAME_METRICS.margin + FRAME_METRICS.pad);
        const block = Number(/class="wh-tb" style="width:([\d.]+)mm/.exec(html)?.[1]);
        expect(block).toBeGreaterThan(100);
        expect(block).toBeLessThanOrEqual(column + 1e-6);
        const strip = Number(/class="wh-strip" style="width:([\d.]+)mm/.exec(html)?.[1]);
        expect(strip).toBeCloseTo(paperSize(paper).width - 2 * FRAME_METRICS.margin, 3);
        // every cell of both stays in its block
        for (const m of html.matchAll(/data-frame-cell="\w+" style="left:([\d.]+)mm;top:[\d.]+mm;width:([\d.]+)mm/g)) {
          expect(Number(m[1]) + Number(m[2])).toBeLessThanOrEqual(Math.max(block, strip) + 1e-6);
        }
      });
    }
  }
});

describe('frame SVG', () => {
  it('is deterministic and self-contained, with a stamp for an unreleased state and none for a released one', () => {
    const content = { markup: '<rect width="10" height="10"/>', width: 10, height: 10 };
    const svg = framedSvg(spec(), content);
    expect(framedSvg(spec(), content)).toBe(svg);
    expect(svg).toContain('data-state-stamp="UNRELEASED"');
    expect(svg).not.toMatch(/<script\b|<link\b|url\(https?:/);
    expect(framedSvg(spec({ state: 'RELEASED' }), content)).not.toContain('data-state-stamp');
    // set in IBM Plex, with the faces inline
    expect(svg).toContain('IBM Plex Sans');
    expect(svg).toContain('@font-face');
  });

  it('fits the content inside the border, whatever the paper', () => {
    for (const paper of PAPER_IDS) {
      const geo = frameGeometry(spec({ paper, orientation: 'landscape' }));
      const svg = framedSvg(spec({ paper, orientation: 'landscape' }), { markup: '<rect width="800" height="500"/>', width: 800, height: 500 });
      const scale = /scale\(([\d.]+)\)/.exec(svg)?.[1];
      expect(Number(scale) * 800).toBeLessThanOrEqual(geo.content.w + 1e-6);
      expect(Number(scale) * 500).toBeLessThanOrEqual(geo.content.h + 1e-6);
    }
  });
});

describe('every sheet carries the frame', () => {
  const id = ids.find((d) => d.startsWith('de9')) ?? (ids[0] as string);
  const design = loadDesign(id);
  const meta = { partNumber: 'CBL-00042', revision: 'B', designer: 'AB', date: '2026.10.08' };
  const state = 'UNRELEASED';

  for (const paper of ['A4', 'letter'] as const) {
    it(`${paper}: the build sheet, BOM and continuity spec share one @page, one strip and one stamp`, () => {
      const options = { paper, drawing: meta, document: { number: 'CBL-00042', revision: 'B', status: state }, depictions: false } as const;
      const sheets = [renderBuildSheet(design, db, options), renderBomSheet(design, db, options), renderTestSpecSheet(design, db, options)];
      const size = `${Math.round(paperSize(paper).width * 100) / 100}mm ${Math.round(paperSize(paper).height * 100) / 100}mm`;
      const strips = sheets.map((html) => {
        expect(html).toContain(`@page{size:${size};margin:8mm`);
        expect(html).toContain('class="wh-paged"');
        expect(html).toContain('data-frame-cell="pn"');
        expect(html).toMatch(/class="wh-stamp"[^>]*>UNRELEASED</);
        expect(html).not.toContain('cs-unreleased-mark');
        const foot = /<div class="wh-foot"[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? '';
        // the strip's cells, as their boxes: identical on every sheet but for the text
        return [...foot.matchAll(/data-frame-cell="(\w+)" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm;height:([\d.]+)mm"/g)].map((m) => m.slice(1).join(':'));
      });
      expect(strips[0]?.length).toBeGreaterThan(4);
      expect(strips[1]).toEqual(strips[0]);
      expect(strips[2]).toEqual(strips[0]);
    });

    it(`${paper}: the drawing is cut to the paper, landscape, inside the frame`, () => {
      const html = renderDrawingSheet(design, db, { meta, paper, state, revisions: [{ rev: 'A', description: 'First release', date: '2026.09.01', by: 'AB' }] });
      const { width, height } = paperSize(paper, 'landscape');
      expect(html).toContain(`@page{size:${Math.round(width * 100) / 100}mm ${Math.round(height * 100) / 100}mm;margin:0}`);
      expect(html).toContain(`viewBox="0 0 ${width} ${height}"`);
      expect(html).toContain('data-state-stamp="UNRELEASED"');
      expect(html).toContain('class="wh-revisions"');
      const geo = frameGeometry(spec({ paper, orientation: 'landscape', standard: PAPERS[paper].standard, variant: 'full' }));
      expect(html).toContain(`<rect class="wh-frame-border" x="${geo.border.x}" y="${geo.border.y}"`);
    });

    it(`${paper}: the formboard, label sheet and schematic carry the same border and strip`, () => {
      const frameOptions = { paper, drawing: meta, document: { number: 'CBL-00042', revision: 'B', status: state } };
      const tile = formboardSvg(deriveFormboard(design, db), 0, { paper, frame: sheetFrameFor(design, db, frameOptions, 'FORMBOARD', 'landscape', 'strip') });
      const labels = labelSheetSvg(deriveLabels(design, db), { paper, frame: sheetFrameFor(design, db, frameOptions, 'LABELS', 'portrait', 'strip') });
      const svg = renderSchematic(design, db, { depictions: false });
      const schematic = framedSchematicSvg(svg, schematicFrame(design, db, svg, frameOptions));
      for (const sheet of [tile, labels, schematic]) {
        expect(sheet).toContain('data-sheet-frame=');
        expect(sheet).toContain('data-frame-field="pn"');
        expect(sheet).toContain('data-state-stamp="UNRELEASED"');
        expect(sheet).not.toContain('<text x="12" y="15.5"'); // no loose title above the frame
      }
      // the formboard strip is the strip: the same cells as the text sheets', on the landscape page
      const geo = frameGeometry(spec({ paper, orientation: 'landscape', variant: 'strip', standard: PAPERS[paper].standard }));
      expect(tile).toContain(`<rect class="wh-frame-border" x="${geo.border.x}" y="${geo.border.y}" width="${geo.border.w}" height="${geo.border.h}"`);
    });
  }

  it('honours the organisation’s paper and title-block layout when a sheet names neither', () => {
    const off = registerDrawingArt({ titleBlock: { paper: 'A3', titleBlock: 'ansi' } });
    try {
      const html = renderBomSheet(design, db, { depictions: false });
      expect(html).toContain('@page{size:297mm 420mm');
      const geo = frameGeometry(spec({ paper: 'A3', standard: 'ansi', variant: 'strip', sheet: undefined }));
      expect(html).toContain(`left:0mm;top:0mm;width:${geo.titleCells[0]?.w}mm`);
      const other = renderBomSheet(design, db, { depictions: false, paper: 'letter' });
      expect(other).toContain('@page{size:215.9mm 279.4mm');
    } finally {
      off();
    }
  });
});
