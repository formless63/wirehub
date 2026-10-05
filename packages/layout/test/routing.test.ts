/**
 * Routing invariants, pinned on a synthetic design rather than on the catalog.
 *
 * The catalog's designs are edited by hand and can be re-modelled at any time
 * (the geometry below was first hit by a real design, which was then re-modelled
 * around the bug —). A fixture built here cannot be
 * re-modelled away, so the defect stays pinned to the layout code that owns it.
 */

import { describe, expect, it } from 'vitest';

import type {
  CableDesign,
  ComponentDefinition,
  ConnectorDefinition,
  Db,
  Joint,
  WireDefinition,
} from '@wirehub/model';

import { layoutSchematic } from '../src/index.ts';
import { METRICS as M } from '../src/metrics.ts';
import type { Diagram } from '../src/model.ts';

/* ------------------------------------------------------------------ *
 * The fixture: a 3-pin plug jointed onto a 4-track shielded whip
 * ------------------------------------------------------------------ */

/**
 * A 3.5 mm TRS plug, shaped like the catalog's `trs-3-5mm`: tip / ring /
 * sleeve, with the sleeve bonding both channel shields.
 */
const PLUG: ConnectorDefinition = {
  id: 'x-trs-3',
  label: '3-contact plug',
  family: 'test',
  gender: 'male',
  pins: [
    { id: 'tip', label: 'Audio L' },
    { id: 'ring', label: 'Audio R' },
    { id: 'sleeve', label: 'Ground / shield' },
  ],
  src: 'synthetic fixture for',
};

const SINK: ConnectorDefinition = {
  id: 'x-sink-4',
  label: '4-contact sink',
  family: 'test',
  gender: 'female',
  pins: [
    { id: '1', label: 'L centre' },
    { id: '2', label: 'L shield' },
    { id: '3', label: 'R centre' },
    { id: '4', label: 'R shield' },
  ],
  src: 'synthetic fixture for',
};

/**
 * A 2-core shielded whip, shaped like the catalog's `audio-whip-2core`: two
 * shielded-core groups, so the band carries **four** electrical tracks against
 * the plug's **three** pin rows. That mismatch is the whole point — port rows
 * are pitched at `portPitch` (6.5 mm) and tracks at `trackPitch` (7 mm), and
 * the block stack is centred on the band, so one of the three pins lands
 * 0.15 mm off its track instead of level with it.
 */
const WHIP: WireDefinition = {
  id: 'x-whip-2core',
  label: '2-core shielded whip',
  structure: {
    kind: 'group',
    id: 'x-whip-2core',
    role: 'cable',
    children: [
      {
        kind: 'group',
        id: 'left',
        label: 'Audio L shielded core',
        role: 'shielded-core',
        children: [
          { kind: 'conductor', id: 'center', label: 'Audio L centre', color: 'white' },
          { kind: 'insulation', id: 'insulation', label: 'Core insulation' },
          { kind: 'shield', id: 'shield', label: 'Audio L shield', construction: 'spiral' },
        ],
      },
      {
        kind: 'group',
        id: 'right',
        label: 'Audio R shielded core',
        role: 'shielded-core',
        children: [
          { kind: 'conductor', id: 'center', label: 'Audio R centre', color: 'red' },
          { kind: 'insulation', id: 'insulation', label: 'Core insulation' },
          { kind: 'shield', id: 'shield', label: 'Audio R shield', construction: 'spiral' },
        ],
      },
    ],
  },
  src: 'synthetic fixture for',
};

const DB: Db = {
  connectors: [PLUG, SINK],
  wires: [WHIP],
  components: [],
  pcbas: [],
};

const joint = (
  a: Joint['a'],
  b: Joint['b'],
): Joint => ({ a, b });

const DESIGN: CableDesign = {
  schemaVersion: 1,
  id: 'x-trs-whip',
  label: '3-pin plug on a 4-track whip',
  instances: {
    connectors: [
      { id: 'j1', def: 'x-trs-3', role: 'whip plug' },
      { id: 'j2', def: 'x-sink-4', role: 'sink' },
    ],
    segments: [{ id: 'w1', def: 'x-whip-2core', lengthMm: 400 }],
    components: [],
    pcbas: [],
  },
  joints: [
    joint({ instance: 'j1', terminal: 'tip' }, { instance: 'w1', terminal: 'left.center', end: 'a' }),
    joint({ instance: 'j1', terminal: 'ring' }, { instance: 'w1', terminal: 'right.center', end: 'a' }),
    joint({ instance: 'j1', terminal: 'sleeve' }, { instance: 'w1', terminal: 'left.shield', end: 'a' }),
    joint({ instance: 'j1', terminal: 'sleeve' }, { instance: 'w1', terminal: 'right.shield', end: 'a' }),
    joint({ instance: 'w1', terminal: 'left.center', end: 'b' }, { instance: 'j2', terminal: '1' }),
    joint({ instance: 'w1', terminal: 'left.shield', end: 'b' }, { instance: 'j2', terminal: '2' }),
    joint({ instance: 'w1', terminal: 'right.center', end: 'b' }, { instance: 'j2', terminal: '3' }),
    joint({ instance: 'w1', terminal: 'right.shield', end: 'b' }, { instance: 'j2', terminal: '4' }),
  ],
  src: 'synthetic fixture for',
};

function layout(): Diagram {
  // no artwork, no cutaway: this fixture is about routing geometry only
  return layoutSchematic(DESIGN, DB, { depictions: false, crossSection: false });
}

/** Every consecutive point pair of every edge, as {dx, dy} deltas. */
function segments(diagram: Diagram): { edge: number; dx: number; dy: number }[] {
  const out: { edge: number; dx: number; dy: number }[] = [];
  for (const edge of diagram.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      const previous = edge.points[index - 1]!;
      const current = edge.points[index]!;
      out.push({
        edge: edge.index,
        dx: Math.abs(current.x - previous.x),
        dy: Math.abs(current.y - previous.y),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('routing a 3-pin connector against a 4-track wire', () => {
  const diagram = layout();

  it('lands one pin off its track by less than a millimetre', () => {
    // The precondition of the regression: without this offset the design
    // would route straight anyway and the test below would prove nothing.
    const ring = diagram.anchors['j1:ring'];
    const track = diagram.anchors['w1:right.center@a'];
    expect(ring).toBeDefined();
    expect(track).toBeDefined();
    const offset = Math.abs(ring!.y - track!.y);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(1);
  });

  it('still routes that joint with axis-aligned segments only', () => {
    const edge = diagram.edges.find(
      (item) => item.a === 'j1:ring' && item.b === 'w1:right.center@a',
    );
    expect(edge, 'the ring → right centre joint is not routed').toBeDefined();
    // an offset joint cannot be a straight two-point run: it needs a jog
    expect(edge!.points.length).toBeGreaterThan(2);
    for (let index = 1; index < edge!.points.length; index += 1) {
      const previous = edge!.points[index - 1]!;
      const current = edge!.points[index]!;
      expect(
        previous.x === current.x || previous.y === current.y,
        `segment ${index} of edge ${edge!.index} is diagonal`,
      ).toBe(true);
    }
  });

  it('routes every joint with exactly horizontal or exactly vertical segments', () => {
    for (const { edge, dx, dy } of segments(diagram)) {
      expect(dx === 0 || dy === 0, `edge ${edge} has a diagonal segment`).toBe(true);
    }
  });

  it('never accepts a near-miss as level: a straight run is truly straight', () => {
    for (const item of diagram.edges) {
      if (item.points.length !== 2) continue;
      const [from, to] = item.points as [{ x: number; y: number }, { x: number; y: number }];
      expect(from.x === to.x || from.y === to.y).toBe(true);
    }
  });

  /**
   * The other half of the invariant, and the reason a tolerance cannot be
   * rescued by snapping: an edge has to be axis-aligned *and* land exactly on
   * both of its anchors. Snapping the far endpoint onto the near one's y buys
   * a horizontal line at the cost of an endpoint that misses its joint dot;
   * only a real jog satisfies both.
   */
  it('keeps both endpoints of every edge exactly on their anchors', () => {
    for (const edge of diagram.edges) {
      const first = edge.points[0]!;
      const last = edge.points[edge.points.length - 1]!;
      const anchorA = diagram.anchors[edge.a]!;
      const anchorB = diagram.anchors[edge.b]!;
      const ends = [first, last];
      for (const anchor of [anchorA, anchorB]) {
        expect(
          ends.some((point) => point.x === anchor.x && point.y === anchor.y),
          `edge ${edge.index} does not land on ${anchor.key}`,
        ).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(layout())).toBe(JSON.stringify(diagram));
  });
});

/* ------------------------------------------------------------------ *
 * The second fixture: a discrete part parked in another run's corridor
 * ------------------------------------------------------------------ */

/**.
 * A component is drawn on white fill *after* the wiring
 * layer, so a run whose y lands inside a component's body does not read as a
 * crossing — it simply vanishes behind the part, which on a schematic says
 * "this wire goes through the capacitor".
 *
 * The geometry that produces it is ordinary, not exotic: a component's y is
 * the mean of the anchors it bridges, so a part that bonds a high pin to a low
 * track sits in the middle of the fan — squarely on some *other* pair's run.
 * That is what the fixture below builds, with nothing in it that a catalog
 * edit could take away.
 */

const SRC6: ConnectorDefinition = {
  id: 'x-src-6',
  label: '6-contact source',
  family: 'test',
  gender: 'male',
  pins: [
    { id: '1', label: 'Signal 1' },
    { id: '2', label: 'Signal 2' },
    { id: '3', label: 'Signal 3' },
    { id: '4', label: 'Signal 4' },
    { id: '5', label: 'Feed' },
    { id: '6', label: 'Return' },
  ],
  src: 'synthetic fixture for',
};

const DST4: ConnectorDefinition = {
  id: 'x-dst-4',
  label: '4-contact sink',
  family: 'test',
  gender: 'female',
  pins: [
    { id: '1', label: 'Signal 1' },
    { id: '2', label: 'Signal 2' },
    { id: '3', label: 'Signal 3' },
    { id: '4', label: 'Signal 4' },
  ],
  src: 'synthetic fixture for',
};

/** Four plain conductors, so the band is four evenly pitched tracks. */
const FLAT4: WireDefinition = {
  id: 'x-flat-4',
  label: '4-core flat',
  structure: {
    kind: 'group',
    id: 'x-flat-4',
    role: 'cable',
    children: [
      { kind: 'conductor', id: 't1', label: 'Core 1', color: 'brown' },
      { kind: 'conductor', id: 't2', label: 'Core 2', color: 'red' },
      { kind: 'conductor', id: 't3', label: 'Core 3', color: 'orange' },
      { kind: 'conductor', id: 't4', label: 'Core 4', color: 'yellow' },
    ],
  },
  src: 'synthetic fixture for',
};

const RES: ComponentDefinition = {
  id: 'x-res-100',
  label: '100 Ω resistor',
  kind: 'resistor',
  value: '100 Ω',
  terminals: [{ id: 'a' }, { id: 'b' }],
  src: 'synthetic fixture for',
};

const OBSTACLE_DB: Db = {
  connectors: [SRC6, DST4],
  wires: [FLAT4],
  components: [RES],
  pcbas: [],
};

const OBSTACLE_DESIGN: CableDesign = {
  schemaVersion: 1,
  id: 'x-part-in-the-way',
  label: 'a discrete part parked in the fan corridor',
  instances: {
    connectors: [
      { id: 'j1', def: 'x-src-6', role: 'source plug' },
      { id: 'j2', def: 'x-dst-4', role: 'sink' },
    ],
    segments: [{ id: 'w1', def: 'x-flat-4', lengthMm: 400 }],
    // 'source hood' pins the column: the router's problem is the same either
    // way, but the fixture should not depend on how zoning guesses
    components: [{ id: 'r1', def: 'x-res-100', location: 'source hood' }],
    pcbas: [],
  },
  joints: [
    joint({ instance: 'j1', terminal: '1' }, { instance: 'w1', terminal: 't1', end: 'a' }),
    joint({ instance: 'j1', terminal: '2' }, { instance: 'w1', terminal: 't2', end: 'a' }),
    joint({ instance: 'j1', terminal: '3' }, { instance: 'w1', terminal: 't3', end: 'a' }),
    joint({ instance: 'j1', terminal: '4' }, { instance: 'w1', terminal: 't4', end: 'a' }),
    joint({ instance: 'w1', terminal: 't1', end: 'b' }, { instance: 'j2', terminal: '1' }),
    joint({ instance: 'w1', terminal: 't2', end: 'b' }, { instance: 'j2', terminal: '2' }),
    joint({ instance: 'w1', terminal: 't3', end: 'b' }, { instance: 'j2', terminal: '3' }),
    joint({ instance: 'w1', terminal: 't4', end: 'b' }, { instance: 'j2', terminal: '4' }),
    // the part itself: pin 5 (near the top of the block) down to the bottom
    // track, which parks its body halfway up the fan
    joint({ instance: 'j1', terminal: '5' }, { instance: 'r1', terminal: 'a' }),
    joint({ instance: 'r1', terminal: 'b' }, { instance: 'w1', terminal: 't4', end: 'a' }),
    joint({ instance: 'j1', terminal: '6' }, { instance: 'w1', terminal: 't1', end: 'a' }),
  ],
  src: 'synthetic fixture for',
};

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The body a component paints over the wiring, plus the clearance owed to it. */
function keepOut(component: Diagram['components'][number]): Box {
  const overhang = component.symbol.startsWith('capacitor') ? M.componentPlateOverhang : 0;
  return {
    x0: component.rect.x,
    y0: component.rect.y - overhang,
    x1: component.rect.x + component.rect.w,
    y1: component.rect.y + component.rect.h + overhang,
  };
}

/** How far a segment runs inside a box, 0 when it misses (axis-aligned only). */
function insideLength(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: Box,
): number {
  if (a.y === b.y) {
    if (a.y <= box.y0 || a.y >= box.y1) return 0;
    return Math.max(
      0,
      Math.min(Math.max(a.x, b.x), box.x1) - Math.max(Math.min(a.x, b.x), box.x0),
    );
  }
  if (a.x <= box.x0 || a.x >= box.x1) return 0;
  return Math.max(
    0,
    Math.min(Math.max(a.y, b.y), box.y1) - Math.max(Math.min(a.y, b.y), box.y0),
  );
}

/** `edge index → 'r1'` for every run that disappears behind a part. */
function componentCrossings(diagram: Diagram): string[] {
  const out: string[] = [];
  for (const edge of diagram.edges) {
    const attached = new Set([edge.a, edge.b].map((key) => key.slice(0, key.indexOf(':'))));
    for (const component of diagram.components) {
      if (attached.has(component.id)) continue;
      const box = keepOut(component);
      for (let index = 1; index < edge.points.length; index += 1) {
        const inside = insideLength(edge.points[index - 1]!, edge.points[index]!, box);
        if (inside > 0.05) out.push(`edge ${edge.index} runs ${inside} mm through ${component.id}`);
      }
    }
  }
  return out;
}

describe('routing past a component that is not on the net', () => {
  const build = (): Diagram =>
    layoutSchematic(OBSTACLE_DESIGN, OBSTACLE_DB, {
      depictions: false,
      crossSection: false,
    });
  const diagram = build();

  it('parks the part across another pair’s corridor', () => {
    // The precondition of the regression: without a body standing between two
    // anchors that have to be joined, everything below would pass vacuously.
    const component = diagram.components[0];
    expect(component, 'the fixture drew no component').toBeDefined();
    const box = keepOut(component!);
    const blocked = diagram.edges.filter((edge) => {
      if (edge.a.startsWith('r1:') || edge.b.startsWith('r1:')) return false;
      const from = diagram.anchors[edge.a]!;
      const to = diagram.anchors[edge.b]!;
      const [left, right] = from.x <= to.x ? [from, to] : [to, from];
      // the body stands between the two anchors, and one of them sits at a y
      // the body occupies — so the straight run out of that anchor walks into
      // it long before it reaches the other side
      if (left.x >= box.x0 || right.x <= box.x1) return false;
      return [left.y, right.y].some((y) => y > box.y0 && y < box.y1);
    });
    expect(blocked.length, 'no run is obstructed, so the fixture proves nothing')
      .toBeGreaterThan(0);
  });

  it('routes every joint clear of every component it is not attached to', () => {
    expect(componentCrossings(diagram)).toEqual([]);
  });

  it('still routes with exactly horizontal or exactly vertical segments', () => {
    for (const { edge, dx, dy } of segments(diagram)) {
      expect(dx === 0 || dy === 0, `edge ${edge} has a diagonal segment`).toBe(true);
    }
  });

  it('still lands both endpoints of every edge exactly on their anchors', () => {
    for (const edge of diagram.edges) {
      const ends = [edge.points[0]!, edge.points[edge.points.length - 1]!];
      for (const key of [edge.a, edge.b]) {
        const anchor = diagram.anchors[key]!;
        expect(
          ends.some((point) => point.x === anchor.x && point.y === anchor.y),
          `edge ${edge.index} does not land on ${key}`,
        ).toBe(true);
      }
    }
  });

  it('detours deterministically', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(diagram));
  });
});

describe('the routing constants', () => {
  it('carries no alignment tolerance that could re-introduce a diagonal', () => {
    // A tolerance here would once again let "nearly level" draw as a straight
    // line between two anchors that are not level. There must be none.
    expect(Object.keys(M)).not.toContain('alignEpsilon');
  });
});
