/**
 * The formboard drawing: true-length geometry, pegs, tiling with registration
 * marks, and byte-stable goldens on the starter design that has a breakout.
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { attachBreakoutLeg, type CableDesign } from '@wirehub/model';

import {
  BRANCH_STEP_DEG,
  NOMINAL_LENGTH_MM,
  TILE_OVERLAP_MM,
  deriveFormboard,
  formboardHtml,
  formboardLayout,
  formboardPageCount,
  formboardSvg,
  formboardSvgPages,
  parseScale,
  scaleText,
} from '../src/index.ts';

const db = loadDb();
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('the Y splitter (a trunk and two legs)', () => {
  const design = loadDesign('dc-y-splitter');
  const board = deriveFormboard(design, db);

  it('draws every run at its true length', () => {
    expect(board.runs.map((r) => [r.segment, r.lengthMm, r.lengthKnown])).toEqual([
      ['w1', 1500, true],
      ['w2', 300, true],
      ['w3', 300, true],
    ]);
    for (const run of board.runs) expect(dist(run.from, run.to)).toBeCloseTo(run.lengthMm, 1);
  });

  it('fans the legs symmetrically about the trunk axis, and starts the legs where the trunk ends', () => {
    const [trunk, a, b] = board.runs;
    expect(trunk?.angleDeg).toBe(0);
    expect(a?.branchDeg).toBe(-BRANCH_STEP_DEG / 2);
    expect(b?.branchDeg).toBe(BRANCH_STEP_DEG / 2);
    expect(a?.from).toEqual(trunk?.to);
    expect(b?.from).toEqual(trunk?.to);
    expect(a?.parent).toBe('w1');
  });

  it('puts a peg at each free end and one at the breakout, numbered in drawing order', () => {
    expect(board.pegs.map((p) => [p.id, p.kind])).toEqual([
      ['P1', 'end'],
      ['P2', 'breakout'],
      ['P3', 'end'],
      ['P4', 'end'],
    ]);
    const breakout = board.pegs[1]?.at;
    expect(breakout).toEqual(board.runs[0]?.to);
  });

  it('names the connector at each free end and the mould at the breakout', () => {
    expect(board.termini.map((t) => [t.segment, t.end, t.joined.map((j) => j.label)])).toEqual([
      ['w1', 'a', ['J1']],
      ['w2', 'b', ['J2']],
      ['w3', 'b', ['J3']],
    ]);
    expect(board.moulds).toHaveLength(1);
    expect(board.moulds[0]?.breakout).toBe('bk1');
    expect(board.moulds[0]?.label).toMatch(/Y/);
  });

  it('carries the wire-label markers at their offsets, on the runs', () => {
    const labels = board.markers.filter((m) => m.kind === 'label');
    expect(labels.map((m) => `${m.segment}/${m.end}`)).toEqual(['w1/a', 'w1/b', 'w2/a', 'w2/b', 'w3/a', 'w3/b']);
    expect(labels.find((m) => m.segment === 'w2')?.offsetMm).toBe(Math.floor(300 / 4) > 40 ? 40 : Math.floor(300 / 4));
  });

  it('keeps every coordinate on the board, from its top-left corner', () => {
    for (const p of [...board.pegs.map((q) => q.at), ...board.runs.flatMap((r) => [r.from, r.to])]) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(board.width + 20);
      expect(p.y).toBeLessThan(board.height);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(deriveFormboard(design, db))).toBe(JSON.stringify(board));
    expect(formboardSvgPages(board)).toEqual(formboardSvgPages(deriveFormboard(design, db)));
  });

  it('cuts the trunk to the chosen variation', () => {
    const family = deriveFormboard(design, db, { variation: '-36', drawing: { lengths: [{ suffix: '-36', mm: 900 }] } });
    expect(family.runs[0]?.lengthMm).toBe(900);
    expect(family.runs[1]?.lengthMm).toBe(300);
  });
});

describe('tiling', () => {
  const board = deriveFormboard(loadDesign('dc-y-splitter'), db);

  it('is one tile when the board fits the sheet, and many at 1:1 for a 1.8 m board', () => {
    expect(formboardLayout(board, { scale: 0.1 }).tiles).toBe(1);
    const layout = formboardLayout(board, { scale: 1 });
    expect(layout.cols).toBeGreaterThan(5);
    expect(layout.tiles).toBe(layout.cols * layout.rows);
    expect(formboardPageCount(board, { scale: 1 })).toBe(layout.tiles + 1);
  });

  it('covers the whole board: the last tile reaches past the far edge', () => {
    const layout = formboardLayout(board, { scale: 1, paper: 'letter' });
    expect((layout.cols - 1) * layout.step.x + layout.content.width).toBeGreaterThanOrEqual(board.width + 20);
    expect((layout.rows - 1) * layout.step.y + layout.content.height).toBeGreaterThanOrEqual(board.height + 20);
    // one fewer tile would not
    expect((layout.cols - 2) * layout.step.x + layout.content.width).toBeLessThan(board.width + 20);
  });

  it('prints registration marks on the same board coordinates as the neighbouring tile', () => {
    const marks = (svg: string): string[] => [...svg.matchAll(/data-registration="(\d\d)"[\s\S]*?<text [^>]*>([^<]*)<\/text>/g)].map((m) => `${m[1]}=${m[2]}`);
    const one = marks(formboardSvg(board, 1, { scale: 1 }));
    const two = marks(formboardSvg(board, 2, { scale: 1 }));
    // tile 1's right-hand marks are tile 2's left-hand marks
    expect(one.find((m) => m.startsWith('10'))?.split('=')[1]).toBe(two.find((m) => m.startsWith('00'))?.split('=')[1]);
    expect(one.find((m) => m.startsWith('11'))?.split('=')[1]).toBe(two.find((m) => m.startsWith('01'))?.split('=')[1]);
    expect(one).toHaveLength(4);
  });

  it('says which page it is, what it joins, and carries a 100 mm print check', () => {
    const svg = formboardSvg(board, 2, { scale: 1 });
    expect(svg).toContain('page 2 of ');
    expect(svg).toContain('joins left p1, right p3');
    expect(svg).toContain('data-print-check="100"');
    expect(svg).toContain('1:1 on A4');
  });

  it('the overview is the whole board, its tile map and the tables; page 0', () => {
    const svg = formboardSvg(board, 0, { scale: 1 });
    expect(svg).toContain('data-formboard="overview"');
    expect(svg.match(/data-tile="/g)).toHaveLength(formboardLayout(board).tiles);
    expect(svg).toContain('W1 w1');
    expect(svg).toContain('P2 ');
    // a page out of range is the nearest one
    expect(formboardSvg(board, 999, { scale: 1 })).toContain(`data-page="${formboardLayout(board).tiles}"`);
  });

  it('paper size follows A4 or letter', () => {
    expect(formboardSvg(board, 1, { paper: 'letter' })).toContain('width="279.4mm"');
    expect(formboardSvg(board, 1)).toContain('width="297mm"');
  });

  it('html carries every page once, each page-broken', () => {
    const html = formboardHtml(board, { scale: 0.25 });
    expect(html.match(/<section class="cs-formboard-page">/g)).toHaveLength(formboardPageCount(board, { scale: 0.25 }));
    expect(html).not.toMatch(/<script\b|<link\b|\bsrc="https?:/);
  });

  it('parses scales', () => {
    expect(parseScale('1:2')).toBe(0.5);
    expect(parseScale('0.25')).toBe(0.25);
    expect(parseScale('2:1')).toBe(2);
    expect(parseScale('1:1000')).toBeUndefined();
    expect(parseScale('banana')).toBeUndefined();
    expect(parseScale('')).toBeUndefined();
    expect(scaleText(1)).toBe('1:1');
    expect(scaleText(0.5)).toBe('1:2');
    expect(scaleText(2)).toBe('2:1');
  });
});

describe('more than two legs, nested breakouts, missing lengths, sleeves', () => {
  it('a third leg fans at minus, zero and plus a step', () => {
    const three = attachBreakoutLeg(loadDesign('dc-y-splitter'), db, 'bk1', { lengthMm: 250 });
    const board = deriveFormboard(three, db);
    expect(board.runs.filter((r) => r.parent === 'w1').map((r) => r.branchDeg)).toEqual([-BRANCH_STEP_DEG, 0, BRANCH_STEP_DEG]);
    expect(board.termini).toHaveLength(4);
    expect(board.pegs).toHaveLength(5);
  });

  it('a run with no length is drawn nominal, dashed, and called out', () => {
    const design = clone(loadDesign('dc-y-splitter')) as CableDesign;
    delete design.instances.segments[1]?.lengthMm;
    const board = deriveFormboard(design, db);
    const run = board.runs.find((r) => r.segment === 'w2');
    expect(run?.lengthKnown).toBe(false);
    expect(run?.lengthMm).toBe(NOMINAL_LENGTH_MM);
    expect(board.notes.join(' ')).toContain('w2 has no length');
    expect(formboardSvg(board, 0)).toContain('stroke-dasharray="3 2"');
    expect(formboardSvg(board, 0)).toContain('~200 mm');
  });

  it('a heat-shrink sleeve attached to a connector sits at that connector’s end, at its own length', () => {
    const design = clone(loadDesign('dc-led-lead')) as CableDesign;
    const sleeve = design.instances.mechanical?.find((m) => m.def === 'heatshrink-6mm');
    const connector = design.instances.connectors[1]?.id as string;
    (sleeve as { attachedTo?: string }).attachedTo = connector;
    const board = deriveFormboard(design, db);
    const marker = board.markers.find((m) => m.kind === 'sleeve');
    expect(marker?.lengthMm).toBe(40);
    expect(marker?.lengthKnown).toBe(true);
    expect(marker?.text).toContain('Sleeve on');
    expect(formboardSvg(board, 0)).toContain('data-marker=');
  });

  it('a nested breakout (a leg that is a trunk) chains the fans', () => {
    const design = clone(loadDesign('dc-y-splitter')) as CableDesign;
    // w2 becomes the trunk of a second breakout at its far end, with one new leg
    design.instances.segments.push({ id: 'w4', def: 'dc-2core-24awg', lengthMm: 150 });
    design.instances.breakouts?.push({
      id: 'bk2',
      trunk: { segment: 'w2', end: 'b' },
      legs: [{ segment: 'w4', end: 'a' }],
      conductors: [],
    });
    const board = deriveFormboard(design, db);
    const w4 = board.runs.find((r) => r.segment === 'w4');
    const w2 = board.runs.find((r) => r.segment === 'w2');
    expect(w4?.from).toEqual(w2?.to);
    expect(w4?.parent).toBe('w2');
    expect(board.moulds.map((m) => m.breakout)).toEqual(['bk1', 'bk2']);
  });
});

describe.each(listDesignIds())('%s', (id) => {
  const design = loadDesign(id);
  const board = deriveFormboard(design, db);

  it('draws, deterministically and self-contained, with true lengths', () => {
    expect(board.runs.length).toBe(design.instances.segments.length);
    for (const run of board.runs) expect(dist(run.from, run.to)).toBeCloseTo(run.lengthMm, 1);
    const pages = formboardSvgPages(board, { scale: 0.5 });
    expect(pages).toHaveLength(formboardPageCount(board, { scale: 0.5 }));
    expect(formboardSvgPages(deriveFormboard(design, db), { scale: 0.5 })).toEqual(pages);
    for (const svg of pages) expect(svg).not.toMatch(/<script\b|<link\b|href=|url\(https?:/);
    expect(TILE_OVERLAP_MM).toBeGreaterThan(0);
  });
});

describe('goldens', () => {
  const board = deriveFormboard(loadDesign('dc-y-splitter'), db);
  it('the overview at 1:1 tiling', async () => {
    await expect(formboardSvg(board, 0, { scale: 1 })).toMatchFileSnapshot('./__golden__/formboard-dc-y-splitter-overview.svg');
  });
  it('the tile with the breakout, at 1:1', async () => {
    await expect(formboardSvg(board, 7, { scale: 1 })).toMatchFileSnapshot('./__golden__/formboard-dc-y-splitter-tile-7.svg');
  });
  it('the whole board on one sheet at 1:10', async () => {
    await expect(formboardSvg(board, 1, { scale: 0.1 })).toMatchFileSnapshot('./__golden__/formboard-dc-y-splitter-1-10.svg');
  });
});
