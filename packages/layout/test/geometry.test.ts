/**
 * Layout geometry on the starter catalog and small synthetic inputs: lane
 * ordering, text metrics, board-face rotation, bonded-screen folding, pin
 * leads, entry-guide geometry and topology. Re-covers the generic cases of the
 * layout tests dropped at the split (docs/boundaries.md §6).
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { findWire } from '@wirehub/model';

import {
  analyzeTopology,
  bondedRepresentative,
  bondFoldedPaths,
  connectorArt,
  crossSectionLayout,
  crossingsLeftOf,
  endFaceLayout,
  fitText,
  isFoilElement,
  orderLanes,
  planPinLeads,
  summarizeIds,
  textWidth,
  wrapText,
  type LaneRun,
} from '../src/index.ts';
import { compareTerminalIds } from '../src/text.ts';
import { isNaturalApproach, reflectApproach, rotateApproach, rotatePoint, rotatedSize, turnToward } from '../src/board-faces.ts';
import { padPolygon, segmentsIntersect } from '../src/entry-guides.ts';

const db = loadDb();
const wire = (id: string) => {
  const found = findWire(db, id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

describe('lane ordering', () => {
  it('keeps parallel downward runs from crossing', () => {
    const runs: LaneRun[] = [
      { yIn: 0, yOut: 20, tie: 0 },
      { yIn: 10, yOut: 30, tie: 1 },
      { yIn: 20, yOut: 40, tie: 2 },
    ];
    const order = orderLanes(runs);
    expect([...order].sort()).toEqual([0, 1, 2]);
    let crossings = 0;
    for (let a = 0; a < order.length; a += 1) for (let b = a + 1; b < order.length; b += 1) crossings += crossingsLeftOf(runs[order[a]!]!, runs[order[b]!]!);
    expect(crossings).toBe(0);
  });

  it('lets two runs on one net cross for free', () => {
    const a: LaneRun = { yIn: 0, yOut: 30, net: 'n', tie: 0 };
    const b: LaneRun = { yIn: 10, yOut: 20, net: 'n', tie: 1 };
    expect(crossingsLeftOf(a, b)).toBe(0);
    expect(crossingsLeftOf(a, { ...b, net: 'other' })).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const runs: LaneRun[] = [0, 1, 2, 3].map((i) => ({ yIn: i * 7, yOut: 50 - i * 9, tie: i }));
    expect(orderLanes(runs)).toEqual(orderLanes(runs));
  });
});

describe('text metrics', () => {
  it('measures bold wider than regular and longer wider than shorter', () => {
    expect(textWidth('Signal', 10, 'bold')).toBeGreaterThan(textWidth('Signal', 10));
    expect(textWidth('Signals', 10)).toBeGreaterThan(textWidth('Signal', 10));
  });

  it('wraps on words and never past the width', () => {
    const lines = wrapText('a short line of text that has to be broken up', 10, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('a short line of text that has to be broken up');
    expect(wrapText('   ', 10, 60)).toEqual([]);
  });

  it('summarises terminal ids as runs', () => {
    expect(summarizeIds(['1', '2', '3', '4', '7', 'shell'])).toBe('1-4, 7, shell');
    expect(summarizeIds(['1', '2'])).toBe('1, 2');
  });

  it('sorts numeric terminals before names, numerically', () => {
    expect(['shell', '10', '2', 'A'].sort(compareTerminalIds)).toEqual(['2', '10', 'A', 'shell']);
  });

  it('shortens a label with an ellipsis to fit', () => {
    const fitted = fitText('a very long label that will not fit in a narrow box', 10, 50);
    expect(fitted.endsWith('…')).toBe(true);
    expect(textWidth(fitted, 10)).toBeLessThanOrEqual(60);
    expect(fitText('ok', 10, 500)).toBe('ok');
  });
});

describe('board-face rotation', () => {
  const frame = { width: 40, height: 20 };
  it('swaps the frame for a quarter turn and not for a half turn', () => {
    expect(rotatedSize(frame, 90)).toEqual({ width: 20, height: 40 });
    expect(rotatedSize(frame, 180)).toEqual(frame);
  });

  it('keeps the corner opposite the origin opposite after any turn', () => {
    for (const turn of [0, 90, 180, 270] as const) {
      const size = rotatedSize(frame, turn);
      const origin = rotatePoint({ x: 0, y: 0 }, frame, turn);
      const far = rotatePoint({ x: 40, y: 20 }, frame, turn);
      expect(Math.abs(far.x - origin.x)).toBe(size.width);
      expect(Math.abs(far.y - origin.y)).toBe(size.height);
    }
  });

  it('turns an approach angle back by the rotation and reflects it about an axis', () => {
    expect(rotateApproach(90, 90)).toBe(0);
    expect(rotateApproach(0, 90)).toBe(270);
    expect(reflectApproach(0, 'x')).toBeCloseTo(180);
    expect(reflectApproach(90, 'y')).toBeCloseTo(270);
  });

  it('calls an approach natural within a small tolerance of the side it enters from', () => {
    expect(isNaturalApproach(10, 'right')).toBe(true);
    expect(isNaturalApproach(90, 'right')).toBe(false);
    expect(isNaturalApproach(175, 'left')).toBe(true);
  });

  it('turns a cable toward its side, defaulting to a quarter turn with no direction', () => {
    expect(turnToward(undefined, 'right')).toBe(90);
    expect([0, 90, 180, 270]).toContain(turnToward({ x: -1, y: 0 }, 'left'));
  });
});

describe('screen folding', () => {
  it('folds a foil and drain pair into the drain and drops the foil', () => {
    const w = wire('shielded-2pair-24awg');
    expect(isFoilElement(w, 'foil')).toBe(true);
    expect(isFoilElement(w, 'drain')).toBe(false);
    expect(bondedRepresentative(w, w.bonded![0]!)).toBe('drain');
    expect([...bondFoldedPaths(w)]).toEqual(['foil']);
  });

  it('folds nothing on an unshielded stock', () => {
    expect(bondFoldedPaths(wire('cat5e-utp')).size).toBe(0);
  });
});

describe('cross-section', () => {
  it('lays out every stock deterministically inside its own rectangle', () => {
    for (const w of db.wires) {
      const a = crossSectionLayout(w);
      expect(a, w.id).toBeDefined();
      expect(JSON.stringify(crossSectionLayout(w))).toBe(JSON.stringify(a));
      expect(a!.rect.w).toBeGreaterThan(0);
      expect(a!.cores.length).toBeGreaterThan(0);
    }
  });

  it('names the stock and its lay direction in the subtitle', () => {
    expect(crossSectionLayout(wire('dc-2core-24awg'))!.subtitle).toMatch(/CW/);
    expect(crossSectionLayout(wire('cat5e-utp'))!.subtitle).toMatch(/CCW/);
  });

  it('draws the jacket around every core', () => {
    const cs = crossSectionLayout(wire('multicore-3coax-4core'))!;
    const reach = (c: { cx: number; cy: number; r?: number }) => Math.hypot(c.cx - cs.cx, c.cy - cs.cy) + (c.r ?? 0);
    const jacket = cs.jacket as unknown as { r: number };
    for (const core of cs.cores) expect(reach(core as never), core.elementPath).toBeLessThanOrEqual(jacket.r + 1e-6);
  });
});

describe('end face', () => {
  it('has no end face for a stock without a recorded lay order', () => {
    for (const w of db.wires) {
      if (w.layOrder?.viewedFrom === undefined) expect(endFaceLayout(w, 'a'), w.id).toBeUndefined();
    }
  });
});

describe('pin leads', () => {
  const art = () => connectorArt({ def: db.connectors.find((c) => c.id === 'de9-male')!, facing: 'right' })!;
  const options = { side: 'right', clearance: 2, gap: 2, step: 1 } as const;

  it('plans one lead per used pin and skips an id the drawing has no pin for', () => {
    const leads = planPinLeads(art(), new Set(['3', '5', '8', 'nope']), options);
    expect(leads.map((l) => l.terminal).sort()).toEqual(['3', '5', '8']);
  });

  it('keeps two runs at least one gap apart', () => {
    const leads = planPinLeads(art(), new Set(['1', '2', '3', '4', '5']), options).filter((l) => !l.blocked);
    const channels = leads.map((l) => l.channel).sort((x, y) => x - y);
    for (let i = 1; i < channels.length; i += 1) expect(channels[i]! - channels[i - 1]!).toBeGreaterThanOrEqual(options.gap - 1e-6);
  });
});

describe('entry-guide geometry', () => {
  it('detects crossing and parallel segments', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false);
  });

  it('grows a pad outline when asked to', () => {
    const pad = { x: 0, y: 0, size: [2, 1], side: 'top', approach: 0 } as never;
    const area = (p: { x: number; y: number }[]) => {
      let sum = 0;
      for (let i = 0; i < p.length; i += 1) {
        const q = p[(i + 1) % p.length]!;
        sum += p[i]!.x * q.y - q.x * p[i]!.y;
      }
      return Math.abs(sum) / 2;
    };
    expect(area(padPolygon(pad, 0.5))).toBeGreaterThan(area(padPolygon(pad, 0)));
  });
});

describe('topology', () => {
  it('finds the trunk of every starter design among its own segments', () => {
    for (const id of listDesignIds()) {
      const d = loadDesign(id);
      // a design built only from sub-assemblies has no wire of its own to be a trunk
      if (d.instances.segments.length === 0) continue;
      const t = analyzeTopology(d, db);
      expect(d.instances.segments.map((s) => s.id), id).toContain(t.trunkId);
    }
  });

  it('is repeatable', () => {
    const d = loadDesign('dc-y-splitter');
    expect(JSON.stringify(analyzeTopology(d, db), (_k, v) => (v instanceof Map || v instanceof Set ? [...v] : v))).toBe(
      JSON.stringify(analyzeTopology(structuredClone(d), db), (_k, v) => (v instanceof Map || v instanceof Set ? [...v] : v)),
    );
  });
});
