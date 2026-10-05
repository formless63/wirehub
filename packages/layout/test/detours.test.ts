/**
 * Detours that share a face, and wires that strike out type.
 *
 * nck.11 taught the router to go round a component keep-out. What it left:
 * every lane blocked by one keep-out was projected onto the same face, so two
 * blocked runs drew their verticals one on top of the other; two hops round
 * one part rode the same line under it; and the designator printed over a
 * part was not part of its keep-out, so a lane could run down through
 * "r1 · 470 Ω". The unit tests pin the mechanism; the crowded-hood fixture
 * pins the drawing.
 */

import { describe, expect, it } from 'vitest';

import {
  avoidObstacles,
  clearLaneX,
  COINCIDENT,
  componentObstacle,
  settleLanes,
  separateRoutes,
  type DetourRings,
  type LanePlan,
  type Obstacle,
} from '../src/detours.ts';
import { layoutSchematic } from '../src/index.ts';
import { METRICS as M } from '../src/metrics.ts';
import type { Diagram, DiagramComponent, Point } from '../src/model.ts';
import { textWidth } from '../src/text.ts';
import { DETOUR_DB, DETOUR_DESIGN } from './detour-fixtures.ts';

const PART: Obstacle = { id: 'r1', x0: 10, y0: 10, x1: 20, y1: 20 };

const lane = (id: string, candidate: number, y0: number, y1: number, net: string): LanePlan => {
  const cleared = clearLaneX(candidate, y0, y1, [PART]);
  return {
    id,
    x: cleared.x,
    ...(cleared.face === undefined ? {} : { face: cleared.face }),
    candidate,
    y0,
    y1,
    lo: 0,
    hi: 40,
    net,
    tie: Number(id),
    obstacles: [PART],
  };
};

describe('lanes projected onto one keep-out face', () => {
  it('both land on the nearer face, which is the collision', () => {
    // limit 1 as the bead states it: two blocked lanes, one face
    expect(clearLaneX(12, 0, 30, [PART]).x).toBe(10);
    expect(clearLaneX(13, 5, 25, [PART]).x).toBe(10);
  });

  it('are spread outward, keeping the corridor’s order, never back into the keep-out', () => {
    const lanes = [lane('1', 12, 0, 30, 'a'), lane('2', 13, 5, 25, 'b')];
    const settled = settleLanes(lanes);
    const x1 = settled.get('1') ?? lanes[0]!.x;
    const x2 = settled.get('2') ?? lanes[1]!.x;
    expect(x1).not.toBe(x2);
    expect(Math.abs(x1 - x2)).toBeGreaterThanOrEqual(M.lanePitchMin - 1e-9);
    for (const x of [x1, x2]) expect(x).toBeLessThan(PART.x0);
    // lane 2 was right of lane 1 in its corridor, so it stays nearer the part
    expect(x2).toBeGreaterThan(x1);
  });

  it('leave the face itself to the hops that turn on it', () => {
    const settled = settleLanes([lane('1', 12, 0, 30, 'a')]);
    expect(settled.get('1')).toBeLessThan(PART.x0);
  });

  it('do not move when their spans do not meet', () => {
    const lanes = [lane('1', 12, 0, 12, 'a'), lane('2', 13, 18, 30, 'b')];
    const settled = settleLanes(lanes);
    expect(settled.get('1')).toBe(settled.get('2'));
  });

  it('stay inside their own corridor', () => {
    const narrow = { ...lane('2', 13, 5, 25, 'b'), lo: 9.5 };
    const settled = settleLanes([lane('1', 12, 0, 30, 'a'), narrow]);
    expect(settled.get('2') ?? narrow.x).toBeGreaterThanOrEqual(9.5);
  });
});

describe('hops round one keep-out', () => {
  it('nest instead of sharing the line under it', () => {
    const rings: DetourRings = new Map();
    const first = avoidObstacles([{ x: 0, y: 15 }, { x: 30, y: 15 }], [PART], rings, 'a');
    const second = avoidObstacles([{ x: 0, y: 14 }, { x: 30, y: 14 }], [PART], rings, 'b');
    const under = (points: Point[]): number => Math.max(...points.map((point) => point.y));
    expect(under(first)).toBe(PART.y1);
    expect(under(second)).toBe(PART.y1 + M.lanePitchMin);
    // and one net may share its ring
    const again = avoidObstacles([{ x: 0, y: 13 }, { x: 30, y: 13 }], [PART], rings, 'a');
    expect(under(again)).toBe(PART.y1);
  });

  it('never start behind the run they cut into', () => {
    const rings: DetourRings = new Map([['r1', ['x']]]);
    const points = avoidObstacles(
      [{ x: 9.5, y: 30 }, { x: 9.5, y: 15 }, { x: 30, y: 15 }],
      [PART],
      rings,
      'a',
    );
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!;
      const b = points[index]!;
      if (a.y === b.y) expect(b.x, 'a horizontal stretch runs backwards').toBeGreaterThan(a.x);
    }
  });
});

describe('the backstop', () => {
  it('moves a later run’s inner stretch off an earlier run of another net', () => {
    const [first, second] = separateRoutes([
      { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }, { x: 9, y: 10 }], net: 'a', obstacles: [] },
      { points: [{ x: 0, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 12 }, { x: 9, y: 12 }], net: 'b', obstacles: [] },
    ]);
    expect(first![1]!.x).toBe(5);
    expect(second![1]!.x).not.toBe(5);
    expect(second![0]).toEqual({ x: 0, y: 2 });
    expect(second![3]).toEqual({ x: 9, y: 12 });
  });

  it('lets one net share its line', () => {
    const routes = separateRoutes([
      { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }, { x: 9, y: 10 }], net: 'a', obstacles: [] },
      { points: [{ x: 0, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 12 }, { x: 9, y: 12 }], net: 'a', obstacles: [] },
    ]);
    expect(routes[1]![1]!.x).toBe(5);
  });

  /**
   * Three pads level in one row: the runs to the two far
   * ones each come in on a row of their own and drop onto the pad line just
   * past the nearer pad's run, nested so no two nets share a line.
   */
  it('dog-legs runs to the far pads of one row off the near pad’s run', () => {
    const row = 50;
    const pads = [60, 100, 110];
    const routes = separateRoutes(
      pads.map((padX, index) => ({
        points: [
          { x: 0, y: 100 + index * 10 },
          { x: 10 + index * 2, y: 100 + index * 10 },
          { x: 10 + index * 2, y: row },
          { x: padX, y: row },
        ],
        net: `n${index}`,
        obstacles: [],
      })),
    );
    routes.forEach((points, index) => {
      // every run still lands on its own pad, along the row, orthogonally
      expect(points[points.length - 1]).toEqual({ x: pads[index], y: row });
      expect(points[points.length - 2]!.y).toBe(row);
      for (let at = 1; at < points.length; at += 1) {
        const a = points[at - 1]!;
        const b = points[at]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    });
    // on the pad row itself, each run starts past the nearer pad's run
    const onRow = routes.map((points) => points[points.length - 2]!.x);
    expect(onRow[0]).toBe(10); // the nearest pad keeps its straight run
    expect(onRow[1]).toBeGreaterThan(pads[0]!);
    expect(onRow[2]).toBeGreaterThan(pads[1]!);
    // …and the rows they come in on are apart
    const inRow = routes.map((points) => points[points.length - 3]!.y);
    expect(new Set(inRow).size).toBe(3);
  });
});

describe('a component’s keep-out', () => {
  it('takes in the designator printed over it', () => {
    const component: DiagramComponent = {
      id: 'r9',
      def: 'x',
      symbol: 'resistor',
      label: 'r9 · 4.7 kΩ — a long value',
      labelX: 15.5,
      labelY: 20 - M.componentLabelLift,
      rect: { x: 10, y: 20, w: M.componentWidth, h: M.componentHeight },
      terminals: [],
    };
    const box = componentObstacle(component);
    const half = textWidth(component.label, M.fontComponentLabel, 'bold') / 2;
    expect(box.y0).toBeLessThan(component.labelY - M.fontComponentLabel * 0.72);
    expect(box.x0).toBeLessThan(component.labelX - half);
    expect(box.x1).toBeGreaterThan(component.labelX + half);
  });
});

/* ------------------------------------------------------------------ *
 * The crowded hood
 * ------------------------------------------------------------------ */

interface Stretch {
  edge: number;
  net: string;
  vertical: boolean;
  at: number;
  lo: number;
  hi: number;
}

function stretches(diagram: Diagram): Stretch[] {
  const out: Stretch[] = [];
  for (const edge of diagram.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      const a = edge.points[index - 1]!;
      const b = edge.points[index]!;
      const vertical = a.x === b.x;
      out.push({
        edge: edge.index,
        net: edge.net ?? `?${edge.index}`,
        vertical,
        at: vertical ? a.x : a.y,
        lo: vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x),
        hi: vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x),
      });
    }
  }
  return out;
}

/** Pairs of different nets drawn along one line (closer than the thinnest stroke is wide). */
function sharedLines(diagram: Diagram): string[] {
  const all = stretches(diagram);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const p = all[i]!;
      const q = all[j]!;
      if (p.net === q.net || p.vertical !== q.vertical) continue;
      if (Math.abs(p.at - q.at) >= COINCIDENT) continue;
      if (Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo) <= 0.3) continue;
      out.push(`edges ${p.edge} and ${q.edge} share ${p.vertical ? 'x' : 'y'} ≈ ${p.at}`);
    }
  }
  return out;
}

/** Runs through a component body or its designator, other than its own. */
function throughParts(diagram: Diagram): string[] {
  const out: string[] = [];
  for (const edge of diagram.edges) {
    const own = new Set([edge.a, edge.b].map((key) => key.slice(0, key.indexOf(':'))));
    for (const component of diagram.components) {
      if (own.has(component.id)) continue;
      const half = textWidth(component.label, M.fontComponentLabel, 'bold') / 2;
      const boxes = [
        { what: 'body', x0: component.rect.x, x1: component.rect.x + component.rect.w, y0: component.rect.y, y1: component.rect.y + component.rect.h },
        {
          what: 'label',
          x0: component.labelX - half,
          x1: component.labelX + half,
          y0: component.labelY - M.fontComponentLabel * 0.72,
          y1: component.labelY + M.fontComponentLabel * 0.2,
        },
      ];
      for (let index = 1; index < edge.points.length; index += 1) {
        const a = edge.points[index - 1]!;
        const b = edge.points[index]!;
        for (const box of boxes) {
          const hit =
            a.x === b.x
              ? a.x > box.x0 && a.x < box.x1 && Math.min(Math.max(a.y, b.y), box.y1) - Math.max(Math.min(a.y, b.y), box.y0) > 0.05
              : a.y > box.y0 && a.y < box.y1 && Math.min(Math.max(a.x, b.x), box.x1) - Math.max(Math.min(a.x, b.x), box.x0) > 0.05;
          if (hit) out.push(`edge ${edge.index} runs through ${component.id}'s ${box.what}`);
        }
      }
    }
  }
  return out;
}

describe('the crowded hood', () => {
  const build = (): Diagram =>
    layoutSchematic(DETOUR_DESIGN, DETOUR_DB, { depictions: false, crossSection: false });
  const diagram = build();

  it('crowds the parts: several foreign runs cross each part’s column, spans overlapping', () => {
    // the precondition — without it every assertion below passes vacuously
    for (const component of diagram.components) {
      const box = componentObstacle(component);
      const crossing = diagram.edges.filter((edge) => {
        if (edge.a.startsWith(`${component.id}:`) || edge.b.startsWith(`${component.id}:`)) return false;
        const a = diagram.anchors[edge.a]!;
        const b = diagram.anchors[edge.b]!;
        return Math.min(a.x, b.x) < box.x0 && Math.max(a.x, b.x) > box.x1 &&
          Math.min(a.y, b.y) < box.y1 && Math.max(a.y, b.y) > box.y0;
      });
      expect(crossing.length, `${component.id} stands in nobody's way`).toBeGreaterThanOrEqual(2);
    }
    // and the two parts are stacked at the column pitch: the channel between
    // them is the tight one the bead measures
    const [upper, lower] = [...diagram.components].sort((p, q) => p.rect.y - q.rect.y);
    expect(lower!.rect.y - upper!.rect.y).toBeLessThanOrEqual(M.componentPitch + M.lanePitchMin * 2);
  });

  it('draws no two nets along one line', () => {
    expect(sharedLines(diagram)).toEqual([]);
  });

  it('runs nothing through a part or the value printed over it', () => {
    expect(throughParts(diagram)).toEqual([]);
  });

  it('keeps every segment axis-aligned and every end on its anchor', () => {
    for (const edge of diagram.edges) {
      for (let index = 1; index < edge.points.length; index += 1) {
        const a = edge.points[index - 1]!;
        const b = edge.points[index]!;
        expect(a.x === b.x || a.y === b.y, `edge ${edge.index} has a diagonal`).toBe(true);
      }
      const ends = [edge.points[0]!, edge.points.at(-1)!];
      for (const key of [edge.a, edge.b]) {
        const anchor = diagram.anchors[key]!;
        expect(ends.some((point) => point.x === anchor.x && point.y === anchor.y)).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(diagram));
  });
});
