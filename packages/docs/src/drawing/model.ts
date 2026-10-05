/**
 * `deriveDrawing(design, db, meta?)` — everything the ANSI A drawing sheet
 * says, as data, before anything is placed on paper.
 *
 * The sheet is the owner's house format (`racc/sample-schematics`): a BOM
 * table of P-designated connectors, the cable and the boards; the solder side
 * of each end's connector with every pin coloured by what lands on it; one
 * row per conductor saying which pin it leaves and which pin it reaches
 * (`15 via "R" pad`); length variants; remarks. None of that is authored here.
 * Every fact is read off the canonical model:
 *
 * - **Which end is which** comes from the trunk: whatever a trunk conductor
 *   reaches from end `a` without running back down the trunk is on the P1
 *   side, from end `b` the far side.
 * - **What a conductor reaches** is a walk over core's `buildGraph`, plain
 *   copper first. Only when copper alone reaches no mating pin does it step
 *   through components and `via` links, and then it keeps the pins at the
 *   fewest steps — so a termination resistor to ground cannot drag every
 *   ground pin into a signal's row.
 * - **Grey (ground)** is whatever the shields and the drain reach at that end.
 *
 * What the model cannot know — part number, revision, designer, date, the
 * orderable length variants, the assembled-board part numbers the BOM prints —
 * comes in as `DrawingMeta`, the per-design sidecar the studio edits. Every
 * field is optional and has a stated default, so a design with no sidecar
 * still draws.
 */

import {
  breakoutsOf,
  buildGraph,
  findConnector,
  findMechanical,
  findPcba,
  findWire,
  passThroughRuns,
  type CableDesign,
  type ConductorElement,
  type Db,
  type Element,
  type GraphEdge,
  type ResolvedTerminal,
  type SegmentInstance,
  type WireDefinition,
} from '@wirehub/model';

import { faceFor, materialFromLabel, plugFor, type FaceArt, type FaceSource } from './faces.ts';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One orderable length: `-36 = 1830 MM`, optionally `(… MM Overall)`. */
export interface LengthVariant {
  suffix: string;
  mm: number;
  overallMm?: number;
}

/**
 * The drawing sidecar: what goes on the sheet that the electrical model does
 * not (and should not) carry. Stored beside the design as
 * `catalog/data/drawings/<design-id>.json`.
 */
export interface DrawingMeta {
  /** defaults to the design label */
  title?: string;
  /** "CBL-00101-3X"; defaults to the design's productRef, else blank */
  partNumber?: string;
  revision?: string;
  designer?: string;
  /** printed verbatim — the house style is `2026.08.02` */
  date?: string;
  /** title-block MATERIAL cell; defaults to "See BOM" */
  material?: string;
  /** defaults to the trunk's own length */
  lengths?: LengthVariant[];
  /**
   * BOM material text per design instance id, where the catalog's wording is
   * not what purchasing orders — typically the assembled board
   * (`{ "u2": "PCA-00103-00" }`) rather than the bare PCB's 3E number.
   */
  materials?: Record<string, string>;
  /** extra remarks, numbered after the derived ones */
  remarks?: string[];
  /**
   * The cable illustration: `art` — the owner's hand-drawn cutaway where one
   * exists (the default), `drawn` — generated from the stock's element tree.
   */
  cutaway?: 'art' | 'drawn';
  /**
   * How the build sheet, BOM and continuity spec print for this design
   * — kept here because this sidecar is already the
   * per-design home of title-block facts. The drawing sheet ignores it.
   */
  sheet?: SheetSettings;
  src?: string;
}

/** The printed sheets' page and document identity, as the studio stores them. */
export interface SheetSettings {
  /** `A4` (the renderers' default) or `letter` */
  paper?: 'A4' | 'letter';
  /** document number; the host defaults it to the part number */
  number?: string;
  revision?: string;
  /** free text — `DRAFT`, `RELEASED`, … */
  status?: string;
  /** print the date the sheet was rendered; the renderers own no clock, so the host passes it */
  stampDate?: boolean;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export type Side = 'a' | 'b';

/** A mating connector on the drawing: a connector instance, or a board's own. */
export interface DrawingPort {
  designator: string;
  /** design instance that owns the pins */
  instance: string;
  /** for a board-integrated connector, the terminal prefix (`scart`) */
  prefix?: string;
  connectorDef?: string;
  side: Side | undefined;
  material: string;
  /** mating pin ids in definition order */
  pins: string[];
  /** the lead that reaches this plug, when it is not the trunk (mm) */
  leadMm?: number;
  /** that lead's segment instance — plugs sharing one are drawn on one lead */
  leadSegment?: string;
  /** a 90° plug: its lead is a right-angle stock, or the instance says so */
  angled?: boolean;
  /** a moulded plug fitted by the contract manufacturer (the instance's note says so) */
  moulded?: boolean;
}

/**
 * A secondary plug: drawn in side view at the end of its lead, beside its
 * side's face (a whip), or in a row off an overmoulded breakout.
 */
export interface DrawingPlug {
  port: DrawingPort;
  art: FaceArt;
  /** pin id → what the art's pin-tagged paths (an RCA's centre pin) are filled with */
  pins: Record<string, PinState>;
  /**
   * A jack with no lead of its own, mounted in the hood (a light-gun
   * RCA): drawn end-on at the face, not on a lead.
   */
  mounted?: boolean;
}

/**
 * An end with no multi-pin face, only round single-signal plugs (a BNC
 * breakout): the trunk runs into an overmoulded breakout — carrying the board
 * and any jack embedded in it — and a lead leaves it to each plug.
 */
export interface Breakout {
  plugs: DrawingPlug[];
  /** more than one plug, or a board in the hood: an overmould, not a bare plug */
  overmold: boolean;
  /** a jack moulded into the breakout (the BNC breakout's 3.5 mm audio out) */
  jack?: { designator?: string; label: string };
  /** the lead to each plug, when the design gives one (mm) */
  leadMm?: number;
}

export type PinState =
  | { kind: 'signal'; color: string; row: number }
  | { kind: 'ground' }
  | { kind: 'unused' };

export interface DrawingFace {
  port: DrawingPort;
  face: FaceArt;
  /** a real face (the owner's, or drawn from the reviewed connector geometry), not the generic grid */
  traced: boolean;
  source: FaceSource;
  /** pin id → what the drawing fills it with */
  pins: Record<string, PinState>;
  /**
   * Parts fitted by hand straight across two of this face's pins (the bare
   * SCART's 180 Ω from 8 to 16), drawn on the face.
   */
  bridges: FaceBridge[];
}

export interface FaceBridge {
  /** pin ids on this face */
  from: string;
  to: string;
  /** "R1 180 Ω" */
  label: string;
  kind: 'resistor' | 'capacitor' | 'other';
}

export interface BomRow {
  n: number;
  reference: string;
  material: string;
  /** a number, or "X" for cut-to-length stock */
  qty: string;
}

export interface WireRow {
  /** "Red" */
  name: string;
  /** fill for the face pins */
  swatch: string;
  /** coax / shielded cores draw long-dash, plain cores short-dash */
  line: 'shielded' | 'plain';
  left: string;
  right: string;
}

export interface Remark {
  text: string;
  /** draw a sample of this line type after the text */
  line?: WireRow['line'];
}

export interface Drawing {
  title: string;
  partNumber: string;
  revision: string;
  designer: string;
  date: string;
  material: string;
  bom: BomRow[];
  ports: DrawingPort[];
  /** the P1-side face and the far-side face, when each exists */
  faces: { a?: DrawingFace; b?: DrawingFace };
  /** secondary plugs with artwork (TRS/RCA whips, hood-mounted jacks), drawn beside their side's face */
  plugs: DrawingPlug[];
  /** an end drawn as a breakout instead of a face */
  breakouts: { a?: Breakout; b?: Breakout };
  /**
   * An end with no plug and nothing soldered to the trunk there: the cable is
   * supplied stripped ("Stripped Per Photo" on the owner's sheets).
   */
  stripped: { a: boolean; b: boolean };
  lengths: LengthVariant[];
  rows: WireRow[];
  remarks: Remark[];
  /** which stock the cutaway illustrates */
  trunkDef?: string;
  /** that stock's definition, for the cutaway */
  trunkWire?: WireDefinition;
  /** which cutaway style the sidecar asked for */
  cutawayStyle: 'art' | 'drawn';
  /** things a reviewer should know the sheet could not show */
  caveats: string[];
}

/* ------------------------------------------------------------------ *
 * Colours — sampled from the owner's sheets, so a generated face reads
 * exactly like a hand-drawn one
 * ------------------------------------------------------------------ */

export const PIN_COLORS: Readonly<Record<string, string>> = {
  red: '#a30000',
  green: '#46a000',
  blue: '#0f33b7',
  yellow: '#e2b700',
  white: '#dbdbdb',
  black: '#1e1e1e',
  brown: '#5e4324',
  purple: '#aa0eaa',
  violet: '#aa0eaa',
  orange: '#e27000',
  grey: '#919191',
  gray: '#919191',
};
export const GROUND_FILL = '#919191';
export const UNUSED_FILL = '#ffffff';

const WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function count(n: number): string {
  return WORDS[n] ?? String(n);
}

/* ------------------------------------------------------------------ *
 * The trunk and its conductors
 * ------------------------------------------------------------------ */

/**
 * The segment the sheet is about: the one with the most cores (a 300 mm AV
 * link's trunk beats its longer 2-core audio lead), then the longest, then
 * the first.
 */
export function trunkSegment(design: CableDesign, db: Db): SegmentInstance | undefined {
  const cores = (segment: SegmentInstance): number => {
    const wire = findWire(db, segment.def);
    return wire === undefined ? 0 : walkStructure(wire.structure).cores.length;
  };
  // a leg out of a breakout mould is never the trunk, however long (a Y-audio's
  // 300 mm legs on a 200 mm stem)
  const legs = new Set((design.instances.breakouts ?? []).flatMap((b) => b.legs.map((l) => l.segment)));
  const trunks = new Set((design.instances.breakouts ?? []).map((b) => b.trunk.segment));
  let best: SegmentInstance | undefined;
  for (const segment of design.instances.segments) {
    // a run out of a breakout carries only part of its stock: never the sheet's trunk
    if (segment.scope !== undefined) continue;
    if (legs.has(segment.id) && !trunks.has(segment.id)) continue;
    if (best === undefined) {
      best = segment;
      continue;
    }
    const more = cores(segment) - cores(best);
    if (more > 0 || (more === 0 && (segment.lengthMm ?? 0) > (best.lengthMm ?? 0))) best = segment;
  }
  return best;
}

interface Core {
  path: string;
  element: ConductorElement;
  shielded: boolean;
  /** inside a `coax` group: a 75 Ω line */
  coax: boolean;
}

interface Shield {
  path: string;
}

/** Signal conductors (not drains) and every shield/drain, in structure order. */
function walkStructure(root: Element): { cores: Core[]; grounds: Shield[] } {
  const cores: Core[] = [];
  const grounds: Shield[] = [];
  const visit = (element: Element, prefix: string, shielded: boolean, coax: boolean): void => {
    const path = prefix === '' ? element.id : `${prefix}.${element.id}`;
    switch (element.kind) {
      case 'conductor':
        if (element.bare === true) grounds.push({ path });
        else cores.push({ path, element, shielded, coax });
        return;
      case 'shield':
        grounds.push({ path });
        return;
      case 'insulation':
        return;
      case 'group': {
        const inner = shielded || element.role === 'coax' || element.role === 'shielded-core';
        for (const child of element.children) visit(child, path, inner, coax || element.role === 'coax');
      }
    }
  };
  // paths are relative to the root group's children
  if (root.kind === 'group') for (const child of root.children) visit(child, '', false, false);
  else visit(root, '', false, false);
  return { cores, grounds };
}

/* ------------------------------------------------------------------ *
 * Mating pins
 * ------------------------------------------------------------------ */

interface MatingPin {
  /** port key: instance, or instance + prefix */
  port: string;
  pin: string;
  /** the board pad the conductor landed on, for a board-integrated pin */
  pad?: string;
}

interface PortSeed {
  key: string;
  instance: string;
  prefix?: string;
  connectorDef?: string;
  label: string;
  pins: string[];
}

function portSeeds(design: CableDesign, db: Db): Map<string, PortSeed> {
  const seeds = new Map<string, PortSeed>();
  for (const instance of design.instances.connectors) {
    const def = findConnector(db, instance.def);
    seeds.set(instance.id, {
      key: instance.id,
      instance: instance.id,
      connectorDef: instance.def,
      label: def === undefined ? instance.def : materialFromLabel(def),
      pins: def?.pins.map((pin) => pin.id) ?? [],
    });
  }
  for (const instance of design.instances.pcbas) {
    const pcba = findPcba(db, instance.def);
    if (pcba === undefined) continue;
    for (const integrated of pcba.integratedConnectors ?? []) {
      const def = findConnector(db, integrated.connectorDefId);
      const key = `${instance.id}.${integrated.terminalPrefix}`;
      seeds.set(key, {
        key,
        instance: instance.id,
        prefix: integrated.terminalPrefix,
        connectorDef: integrated.connectorDefId,
        label: def === undefined ? integrated.connectorDefId : materialFromLabel(def),
        pins: def?.pins.map((pin) => pin.id) ?? [],
      });
    }
  }
  return seeds;
}

function matingPin(terminal: ResolvedTerminal, seeds: Map<string, PortSeed>): { port: string; pin: string } | undefined {
  if (terminal.instanceKind === 'connector') return { port: terminal.instance, pin: terminal.terminal };
  if (terminal.instanceKind !== 'pcba') return undefined;
  const dot = terminal.terminal.indexOf('.');
  if (dot < 0) return undefined;
  const key = `${terminal.instance}.${terminal.terminal.slice(0, dot)}`;
  if (!seeds.has(key)) return undefined;
  return { port: key, pin: terminal.terminal.slice(dot + 1) };
}

interface Adjacent {
  to: ResolvedTerminal;
  stepped: boolean;
}

function adjacency(edges: GraphEdge[], trunk: string): Map<string, Adjacent[]> {
  const map = new Map<string, Adjacent[]>();
  const add = (from: ResolvedTerminal, to: ResolvedTerminal, stepped: boolean): void => {
    const list = map.get(from.key);
    if (list === undefined) map.set(from.key, [{ to, stepped }]);
    else list.push({ to, stepped });
  };
  for (const edge of edges) {
    // never run back down the trunk: that is the other side of the sheet
    if (edge.kind === 'wire' && edge.a.instance === trunk) continue;
    const stepped = edge.passage !== undefined;
    add(edge.a, edge.b, stepped);
    add(edge.b, edge.a, stepped);
  }
  return map;
}

/**
 * Mating pins reachable from `start`, with the fewest component/`via` steps
 * that reaches any (0-1 BFS). Each pin remembers the first pad of its own
 * board the walk landed on — the "via R pad" of the house format.
 */
function reach(start: string, graph: Map<string, Adjacent[]>, seeds: Map<string, PortSeed>, byKey: Map<string, ResolvedTerminal>): MatingPin[] {
  interface State {
    key: string;
    steps: number;
    /** first pad per board instance on the way here */
    pads: Record<string, string>;
  }
  const best = new Map<string, number>();
  const deque: State[] = [{ key: start, steps: 0, pads: {} }];
  best.set(start, 0);
  const found: { pin: MatingPin; steps: number }[] = [];
  const seen = new Set<string>();
  while (deque.length > 0) {
    const state = deque.shift() as State;
    if ((best.get(state.key) ?? Infinity) < state.steps) continue;
    const terminal = byKey.get(state.key);
    if (terminal !== undefined) {
      const mating = matingPin(terminal, seeds);
      if (mating !== undefined) {
        const tag = `${mating.port}#${mating.pin}`;
        if (!seen.has(tag)) {
          seen.add(tag);
          const pad = state.pads[terminal.instance];
          found.push({ pin: { ...mating, ...(pad === undefined || mating.port === terminal.instance ? {} : { pad }) }, steps: state.steps });
        }
      }
    }
    for (const next of graph.get(state.key) ?? []) {
      const steps = state.steps + (next.stepped ? 1 : 0);
      if ((best.get(next.to.key) ?? Infinity) <= steps) continue;
      best.set(next.to.key, steps);
      const pads = { ...state.pads };
      if (next.to.instanceKind === 'pcba' && pads[next.to.instance] === undefined && matingPin(next.to, seeds) === undefined) {
        pads[next.to.instance] = next.to.terminal;
      }
      const item = { key: next.to.key, steps, pads };
      if (next.stepped) deque.push(item);
      else deque.unshift(item);
    }
  }
  if (found.length === 0) return [];
  const fewest = Math.min(...found.map((f) => f.steps));
  return found.filter((f) => f.steps === fewest).map((f) => f.pin);
}

/** Every copper-connected mating pin, no stepping — for ground. */
function copperReach(start: string, graph: Map<string, Adjacent[]>, seeds: Map<string, PortSeed>, byKey: Map<string, ResolvedTerminal>): MatingPin[] {
  const out: MatingPin[] = [];
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    const terminal = byKey.get(key);
    const mating = terminal === undefined ? undefined : matingPin(terminal, seeds);
    if (mating !== undefined) out.push(mating);
    for (const next of graph.get(key) ?? []) {
      if (next.stepped || visited.has(next.to.key)) continue;
      visited.add(next.to.key);
      queue.push(next.to.key);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The derivation
 * ------------------------------------------------------------------ */

function comparePins(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

const SIDE_PIN_WORDS: Readonly<Record<string, string>> = { tip: 'T', ring: 'R', sleeve: 'S' };

function pinWord(pin: string, port: DrawingPort): string {
  if (port.connectorDef?.startsWith('bnc') === true && pin === 'tip') return 'Center';
  return SIDE_PIN_WORDS[pin] ?? pin;
}

export function deriveDrawing(design: CableDesign, db: Db, meta: DrawingMeta = {}): Drawing {
  const caveats: string[] = [];
  const trunk = trunkSegment(design, db);
  const wire = trunk === undefined ? undefined : findWire(db, trunk.def);
  const graph = buildGraph(design, db);
  const byKey = new Map<string, ResolvedTerminal>();
  for (const node of graph.nodes) byKey.set(node.key, node);
  const seeds = portSeeds(design, db);
  const adj = adjacency(graph.edges, trunk?.id ?? '');

  const { cores, grounds } = wire === undefined ? { cores: [], grounds: [] } : walkStructure(wire.structure);
  const endKey = (path: string, end: Side): string => `${trunk?.id ?? ''}:${path}@${end}`;

  // what each core reaches at each end
  const coreReach = cores.map((core) => ({
    core,
    a: reach(endKey(core.path, 'a'), adj, seeds, byKey),
    b: reach(endKey(core.path, 'b'), adj, seeds, byKey),
  }));
  const groundReach = {
    a: grounds.flatMap((g) => copperReach(endKey(g.path, 'a'), adj, seeds, byKey)),
    b: grounds.flatMap((g) => copperReach(endKey(g.path, 'b'), adj, seeds, byKey)),
  };

  // which side each port sits on: whichever end reaches more of its pins
  const hits = new Map<string, { a: number; b: number }>();
  const bump = (pins: MatingPin[], side: Side): void => {
    for (const pin of pins) {
      const tally = hits.get(pin.port) ?? { a: 0, b: 0 };
      tally[side] += 1;
      hits.set(pin.port, tally);
    }
  };
  for (const r of coreReach) {
    bump(r.a, 'a');
    bump(r.b, 'b');
  }
  bump(groundReach.a, 'a');
  bump(groundReach.b, 'b');

  // drop a board's integrated port when a real connector instance is wired
  // to the board instead (the board is the connector's carrier, not a port)
  const seedList = [...seeds.values()].filter((seed) => seed.prefix === undefined || hits.has(seed.key));
  const sideOf = (seed: PortSeed): Side | undefined => {
    const tally = hits.get(seed.key);
    if (tally === undefined) return undefined;
    return tally.b > tally.a ? 'b' : 'a';
  };
  // the connector drawn as each end's face is the one most conductors land
  // on; the faces are P1 and P2 and everything else (whips, breakout plugs)
  // follows, source side first — the numbering the owner's sheets use
  const landings = (seed: PortSeed, side: Side): number =>
    coreReach.filter((r) => r[side].some((p) => p.port === seed.key)).length;
  // a female 3.5 mm jack (the BNC breakout's audio out, moulded into the
  // breakout) is never an end's face while a plug shares its end: it numbers
  // after the plugs, the way the owner's BNC sheets number them
  const isJackSeed = (seed: PortSeed): boolean => {
    const def = seed.connectorDef === undefined ? undefined : findConnector(db, seed.connectorDef);
    return def?.gender === 'female' && /3\.5|trs/i.test(def.family ?? '');
  };
  const pickPrimary = (side: Side): PortSeed | undefined => {
    let best: PortSeed | undefined;
    const plugsHere = seedList.some((seed) => sideOf(seed) === side && !isJackSeed(seed));
    for (const seed of seedList) {
      if (sideOf(seed) !== side) continue;
      if (plugsHere && isJackSeed(seed)) continue;
      if (best === undefined || landings(seed, side) > landings(best, side)) best = seed;
    }
    return best;
  };
  const primarySeeds = { a: pickPrimary('a'), b: pickPrimary('b') };
  const rank = (seed: PortSeed): number => {
    if (seed === primarySeeds.a) return 0;
    if (seed === primarySeeds.b) return 1;
    const side = sideOf(seed);
    const jack = isJackSeed(seed) ? 0.5 : 0;
    return (side === 'a' ? 2 : side === 'b' ? 3 : 4) + jack;
  };
  const ordered = seedList
    .map((seed, index) => ({ seed, index, side: sideOf(seed) }))
    .sort((x, y) => rank(x.seed) - rank(y.seed) || x.index - y.index);

  const ports: DrawingPort[] = ordered.map(({ seed, side }, index) => {
    const lead = leadOf(design, db, seed.instance, trunk?.id);
    return {
      designator: `P${index + 1}`,
      instance: seed.instance,
      ...(seed.prefix === undefined ? {} : { prefix: seed.prefix }),
      ...(seed.connectorDef === undefined ? {} : { connectorDef: seed.connectorDef }),
      side,
      material: meta.materials?.[seed.key] ?? faceMaterial(seed, db, lead.angled === true),
      pins: seed.pins,
      ...lead,
    };
  });
  const portByKey = new Map(ordered.map(({ seed }, index) => [seed.key, ports[index] as DrawingPort]));
  const primaries = {
    a: primarySeeds.a === undefined ? undefined : portByKey.get(primarySeeds.a.key),
    b: primarySeeds.b === undefined ? undefined : portByKey.get(primarySeeds.b.key),
  };
  // "[P1] 6" only when a bare "6" could mean two plugs on that end — the
  // owner's HD15 sheet writes "13" and "T" untagged, another sheet tags
  // "[P1] 1" / "[P3] 4" because both plugs have numbered pins
  const collides = (side: Side): boolean => {
    const words = new Map<string, number>();
    for (const port of ports.filter((p) => p.side === side)) {
      for (const pin of new Set(port.pins.map((id) => pinWord(id, port)))) words.set(pin, (words.get(pin) ?? 0) + 1);
    }
    return [...words.values()].some((count) => count > 1);
  };
  const multi = { a: collides('a'), b: collides('b') };

  const strippedEnd = (end: Side): boolean =>
    trunk !== undefined &&
    !ports.some((p) => p.side === end) &&
    !design.joints.some((j) => [j.a, j.b].some((r) => r.instance === trunk.id && r.end === end));
  const stripped = { a: strippedEnd('a'), b: strippedEnd('b') };

  const describe = (pins: MatingPin[], side: Side): string => {
    if (pins.length === 0) return stripped[side] ? '' : 'NC';
    const groups = new Map<string, MatingPin[]>();
    for (const pin of pins) {
      const list = groups.get(pin.port);
      if (list === undefined) groups.set(pin.port, [pin]);
      else list.push(pin);
    }
    const parts: string[] = [];
    const keys = [...groups.keys()].sort(
      (x, y) => Number(portByKey.get(x)?.designator.slice(1) ?? 0) - Number(portByKey.get(y)?.designator.slice(1) ?? 0),
    );
    for (const key of keys) {
      const list = groups.get(key) ?? [];
      const port = portByKey.get(key);
      if (port === undefined) continue;
      const sorted = [...list].sort((x, y) => comparePins(x.pin, y.pin));
      const pads = [...new Set(sorted.map((p) => p.pad).filter((p): p is string => p !== undefined))];
      const numbers = sorted.map((p) => pinWord(p.pin, port)).join(', ');
      // tag when a bare pin could be misread: names shared across this end's
      // plugs, a row that lands on more than one plug, or a plug on the far end
      const tag = multi[side] || groups.size > 1 || port.side !== side ? `[${port.designator}] ` : '';
      const via = pads.length === 1 ? ` via “${pads[0]}” pad` : pads.length > 1 ? ` via ${pads.map((p) => `“${p}”`).join('/')} pads` : '';
      parts.push(`${tag}${numbers}${via}`);
    }
    return parts.join(', ');
  };

  const rows: WireRow[] = coreReach.map(({ core, a, b }) => {
    const colorWord = core.element.color ?? '';
    return {
      name: colorWord === '' ? (core.element.label ?? core.path) : titleCase(colorWord),
      swatch: PIN_COLORS[colorWord.toLowerCase()] ?? UNUSED_FILL,
      line: core.shielded ? 'shielded' : 'plain',
      left: describe(a, 'a'),
      right: describe(b, 'b'),
    };
  });

  /** what each of a port's pins is filled with: its conductor's colour, ground grey, or open */
  const pinStates = (port: DrawingPort, side: Side, ids: readonly string[]): Record<string, PinState> => {
    const key = port.prefix === undefined ? port.instance : `${port.instance}.${port.prefix}`;
    const pins: Record<string, PinState> = {};
    for (const id of ids) pins[id] = { kind: 'unused' };
    for (const pin of groundReach[side]) if (pin.port === key && pins[pin.pin] !== undefined) pins[pin.pin] = { kind: 'ground' };
    coreReach.forEach((r, row) => {
      for (const pin of r[side]) {
        if (pin.port !== key || pins[pin.pin] === undefined) continue;
        pins[pin.pin] = { kind: 'signal', color: rows[row]?.swatch ?? UNUSED_FILL, row };
      }
    });
    return pins;
  };

  const defOf = (port: DrawingPort | undefined) =>
    port?.connectorDef === undefined ? undefined : findConnector(db, port.connectorDef);
  /** a round single-signal plug (BNC, RCA, 3.5 mm): drawn in side view, not as a face */
  const isRound = (port: DrawingPort | undefined): boolean => ROUND_FAMILIES.has((defOf(port)?.family ?? '').toLowerCase());
  /** the boards soldered to any of these ports */
  const boardsOf = (list: DrawingPort[]) =>
    design.instances.pcbas.filter((board) => list.some((p) => p.instance !== board.id && boardServes(design, board.id, p.instance)));
  // an end whose connectors are all round plugs, more than one or behind a
  // board, is a breakout: no face, a moulded hood and a lead to each plug
  // — or, first, where the design says so: the trunk end sits in a breakout
  const modelBreakout = (side: Side) =>
    trunk === undefined ? undefined : breakoutsOf(design).find((b) => b.trunk.segment === trunk.id && b.trunk.end === side);
  const breakoutSide = (side: Side): boolean => {
    if (modelBreakout(side) !== undefined) return true;
    const onSide = ports.filter((p) => p.side === side);
    return isRound(primaries[side]) && onSide.every(isRound) && (onSide.length > 1 || boardsOf(onSide).length > 0);
  };
  const isBreakout = { a: breakoutSide('a'), b: breakoutSide('b') };

  const faceOf = (side: Side): DrawingFace | undefined => {
    const port = primaries[side];
    if (port === undefined || isBreakout[side]) return undefined;
    const def = defOf(port);
    if (def === undefined) return undefined;
    // generic faces show mating pins only — shells and screw lugs have no hole
    const matable = port.pins.filter((id) => id !== 'shell' && !/^S\d+$/.test(id));
    const { face, traced, source } = faceFor(def, matable);
    const pins = pinStates(port, side, face.pins.map((pin) => pin.id));
    if (!traced) caveats.push(`${port.designator} (${def.label}) has no traced face yet — drawn as a numbered pin grid.`);
    if (face.approximate !== undefined) {
      caveats.push(`${port.designator} (${def.label}) is drawn from its family's general shape — "${face.approximate}" on the sheet (specs/connector-art-review.md).`);
    }
    // a component whose two terminals are both soldered to this plug's pins
    const bridges: FaceBridge[] = [];
    if (port.prefix === undefined) {
      for (const instance of design.instances.components) {
        const def = db.components.find((c) => c.id === instance.def);
        if (def === undefined || def.terminals.length !== 2) continue;
        const landing = (terminal: string): string | undefined => {
          for (const j of design.joints) {
            const pair = [j.a, j.b];
            const mine = pair.find((r) => r.instance === instance.id && r.terminal === terminal);
            const far = pair.find((r) => r !== mine);
            if (mine !== undefined && far !== undefined && far.instance === port.instance && pins[far.terminal] !== undefined) return far.terminal;
          }
          return undefined;
        };
        const from = landing(def.terminals[0]!.id);
        const to = landing(def.terminals[1]!.id);
        if (from === undefined || to === undefined) continue;
        bridges.push({
          from,
          to,
          label: [instance.id.toUpperCase(), def.value].filter(Boolean).join(' '),
          kind: def.kind === 'resistor' ? 'resistor' : def.kind === 'capacitor' ? 'capacitor' : 'other',
        });
      }
    }
    return { port, face, traced, source, pins, bridges };
  };
  const faces = { a: faceOf('a'), b: faceOf('b') };
  if (faces.a === undefined && !stripped.a && !isBreakout.a) caveats.push('Nothing on the source end reaches a mating connector, so there is no P1 face.');
  if (faces.b === undefined && !stripped.b && !isBreakout.b) caveats.push('Nothing on the destination end reaches a mating connector, so there is no far-end face.');

  /** a port drawn in side view on its lead, or end-on in the hood when it has no lead */
  const plugOf = (port: DrawingPort, side: Side): DrawingPlug | undefined => {
    if (port.connectorDef === undefined) return undefined;
    const art = plugFor(port.connectorDef, { angled: port.angled === true });
    if (art !== undefined) {
      const tagged = art.art.map((path) => path.pin).filter((id): id is string => id !== undefined);
      return { port, art, pins: pinStates(port, side, tagged) };
    }
    const def = defOf(port);
    if (def === undefined || port.leadSegment !== undefined) return undefined;
    // a jack in the hood (the light-gun leg's RCA): its end view, pins coloured
    const { face, source } = faceFor(def, []);
    if (source === 'generic') return undefined;
    return { port, art: face, pins: pinStates(port, side, face.pins.map((pin) => pin.id)), mounted: true };
  };

  const plugs: DrawingPlug[] = [];
  const breakouts: Drawing['breakouts'] = {};
  for (const side of ['a', 'b'] as const) {
    const onSide = ports.filter((p) => p.side === side);
    if (isBreakout[side]) {
      // the jack the design houses in the mould — else a female 3.5 mm on a breakout is the jack moulded into it
      const housed = modelBreakout(side)?.housed ?? [];
      const jackPort =
        onSide.find((p) => housed.includes(p.instance)) ??
        onSide.find((p) => defOf(p)?.gender === 'female' && /3\.5|trs/i.test(defOf(p)?.family ?? ''));
      const list = onSide
        .filter((p) => p !== jackPort)
        .map((p) => plugOf(p, side))
        .filter((p): p is DrawingPlug => p !== undefined);
      const boards = boardsOf(onSide);
      let jack: Breakout['jack'];
      if (jackPort !== undefined) jack = { designator: jackPort.designator, label: 'TRS' };
      else {
        // a jack the catalog models as the board's own pads (PCA-00104's
        // audio out), not as a connector: drawn, not numbered
        const onBoard = boards.find((board) =>
          (findPcba(db, board.def)?.terminals ?? []).some((t) => /3\.5\s*mm|stereo_3\.5/i.test(`${t.label ?? ''} ${t.note ?? ''}`)),
        );
        if (onBoard !== undefined) {
          jack = { label: 'TRS' };
          caveats.push(
            `The breakout's 3.5 mm jack is part of ${onBoard.id} (${onBoard.def}), not a connector in the design — drawn in the overmould, not numbered, and its audio rows read NC.`,
          );
        }
      }
      const lengths = [...new Set(list.map((p) => p.port.leadMm))];
      breakouts[side] = {
        plugs: list,
        overmold: modelBreakout(side)?.mould !== undefined || list.length > 1 || boards.length > 0 || jack !== undefined,
        ...(jack === undefined ? {} : { jack }),
        ...(lengths.length === 1 && lengths[0] !== undefined ? { leadMm: lengths[0] } : {}),
      };
      if (list.length > 0 && lengths.length === 1 && lengths[0] === undefined) {
        caveats.push(`The ${side === 'a' ? 'source' : 'destination'} breakout's lead to each plug has no length in the design — drawn undimensioned.`);
      }
      continue;
    }
    for (const port of onSide) {
      if (port === primaries[side]) continue;
      const plug = plugOf(port, side);
      if (plug !== undefined) plugs.push(plug);
    }
  }
  const drawnPorts = new Set<DrawingPort>([
    ...plugs.map((p) => p.port),
    ...[breakouts.a, breakouts.b].flatMap((b) => b?.plugs.map((p) => p.port) ?? []),
  ]);
  const jacks = new Set([breakouts.a?.jack?.designator, breakouts.b?.jack?.designator]);
  const undrawn = ports.filter((p) => p !== faces.a?.port && p !== faces.b?.port && !drawnPorts.has(p) && !jacks.has(p.designator));
  if (undrawn.length > 0) {
    caveats.push(
      `${undrawn.map((p) => p.designator).join(', ')} ${undrawn.length === 1 ? 'is' : 'are'} in the BOM and the wire table but not drawn — no side-view art for ${undrawn.length === 1 ? 'it' : 'them'} yet.`,
    );
  }

  // BOM: identical materials share a line, the way the sheets write "P1, P2"
  const bom: BomRow[] = [];
  const connectorLines = new Map<string, string[]>();
  for (const port of ports) {
    const list = connectorLines.get(port.material);
    if (list === undefined) connectorLines.set(port.material, [port.designator]);
    else list.push(port.designator);
  }
  for (const [material, refs] of connectorLines) {
    bom.push({ n: bom.length + 1, reference: refs.join(', '), material, qty: String(refs.length) });
  }
  if (trunk !== undefined) {
    bom.push({ n: bom.length + 1, reference: 'CABLE', material: cableMaterial(cores, wire?.label ?? trunk.def), qty: 'X' });
  }
  // a run passing through a breakout uncut is the trunk cable itself
  const runIds = new Set(passThroughRuns(design, db).map((r) => r.segment));
  for (const segment of design.instances.segments) {
    if (segment === trunk || runIds.has(segment.id)) continue;
    const def = findWire(db, segment.def);
    const length = segment.lengthMm === undefined ? '' : `, ${Math.round(segment.lengthMm)} MM`;
    const leadCores = def === undefined ? { cores: [], grounds: [] } : walkStructure(def.structure);
    const count = leadCores.cores.length;
    const kind = count > 0 && leadCores.cores.every((c) => c.shielded) ? 'SHIELDED ' : '';
    const material = count > 0 ? `${count}C ${kind}LEAD${length}` : `${(def?.label ?? segment.def).toUpperCase()}${length}`;
    bom.push({ n: bom.length + 1, reference: 'LEAD', material, qty: '1' });
  }
  // the breakout mould itself: "OVERMOLD BREAKOUT", one per mould
  for (const breakout of breakoutsOf(design)) {
    const mould = breakout.mould === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === breakout.mould);
    if (mould === undefined) continue;
    const def = findMechanical(db, mould.def);
    const material = meta.materials?.[mould.id] ?? (def?.partNumber ?? 'OVERMOLD BREAKOUT');
    bom.push({ n: bom.length + 1, reference: 'MOLD', material, qty: String(mould.qty) });
  }
  for (const instance of design.instances.pcbas) {
    const pcba = findPcba(db, instance.def);
    const served = ports
      .filter((p) => p.instance === instance.id || boardServes(design, instance.id, p.instance))
      .sort((x, y) => Number(x.designator.slice(1)) - Number(y.designator.slice(1)));
    const reference = served[0] === undefined ? 'PCBA' : `${served[0].designator} PCBA`;
    const material = meta.materials?.[instance.id] ?? (pcba === undefined ? instance.def : `${pcba.partNumber} ${pcba.revision}`);
    bom.push({ n: bom.length + 1, reference, material, qty: '1' });
  }
  // discrete parts: referenced by designator, named plainly ("180 Ω
  // resistor" — what it is, not the catalog's note on what it is for)
  const componentLines = new Map<string, string[]>();
  for (const instance of design.instances.components) {
    const def = db.components.find((c) => c.id === instance.def);
    const label = (def?.label ?? instance.def).replace(/\s*\(.*\)\s*$/, '');
    const value = def?.value;
    const material = meta.materials?.[instance.id] ?? (value === undefined || label.includes(value) ? label : `${value} ${label}`);
    const refs = componentLines.get(material) ?? [];
    refs.push(instance.id.toUpperCase());
    componentLines.set(material, refs);
  }
  for (const [material, refs] of componentLines) {
    bom.push({ n: bom.length + 1, reference: refs.join(', '), material, qty: String(refs.length) });
  }

  const lengths =
    meta.lengths !== undefined && meta.lengths.length > 0
      ? meta.lengths
      : trunk?.lengthMm === undefined
        ? []
        : [{ suffix: '', mm: Math.round(trunk.lengthMm) }];

  return {
    title: meta.title ?? design.label,
    partNumber: meta.partNumber ?? design.productRef ?? '',
    revision: meta.revision ?? '',
    designer: meta.designer ?? '',
    date: meta.date ?? '',
    material: meta.material ?? 'See BOM',
    bom,
    ports,
    faces,
    plugs,
    breakouts,
    stripped,
    lengths,
    rows,
    remarks: [...deriveRemarks(cores, grounds.length > 0), ...(meta.remarks ?? []).map((text) => ({ text }))],
    ...(trunk === undefined ? {} : { trunkDef: trunk.def }),
    ...(wire === undefined ? {} : { trunkWire: wire }),
    cutawayStyle: meta.cutaway ?? 'art',
    caveats,
  };
}

const ROUND_FAMILIES = new Set(['bnc', 'rca', '3.5mm', 'trs']);

const ANGLED = /90°|right[- ]angle/i;
const MOULDED = /\bmou?lded\b|overmou?ld/i;

interface Lead {
  leadMm?: number;
  leadSegment?: string;
  angled?: boolean;
  moulded?: boolean;
}

/**
 * The non-trunk segment soldered to a plug — its lead — and that lead's
 * length; whether the plug is a 90° one (a right-angle lead stock, or the
 * instance says so) and a moulded one.
 */
function leadOf(design: CableDesign, db: Db, instance: string, trunk: string | undefined): Lead {
  const out: Lead = {};
  const connector = design.instances.connectors.find((c) => c.id === instance);
  const words = `${connector?.role ?? ''} ${connector?.note ?? ''}`;
  if (ANGLED.test(words)) out.angled = true;
  if (MOULDED.test(words)) out.moulded = true;
  const segments = new Set(design.instances.segments.filter((s) => s.id !== trunk).map((s) => s.id));
  for (const joint of design.joints) {
    const pair = [joint.a, joint.b];
    const plug = pair.find((ref) => ref.instance === instance);
    const lead = pair.find((ref) => segments.has(ref.instance));
    if (plug === undefined || lead === undefined) continue;
    const segment = design.instances.segments.find((s) => s.id === lead.instance);
    if (segment === undefined) continue;
    out.leadSegment = segment.id;
    const stock = findWire(db, segment.def);
    if (/-ra$/.test(segment.def) || ANGLED.test(`${stock?.label ?? ''} ${segment.role ?? ''}`)) out.angled = true;
    if (segment.lengthMm !== undefined) out.leadMm = Math.round(segment.lengthMm);
    break;
  }
  return out;
}

function faceMaterial(seed: PortSeed, db: Db, angled: boolean): string {
  const plug = seed.connectorDef === undefined ? undefined : plugFor(seed.connectorDef, { angled });
  if (plug !== undefined) return plug.material;
  const def = seed.connectorDef === undefined ? undefined : findConnector(db, seed.connectorDef);
  if (def === undefined) return seed.label;
  return faceFor(def, []).face.material;
}

/** A board "serves" a connector instance it is soldered to. */
function boardServes(design: CableDesign, board: string, connector: string): boolean {
  return design.joints.some(
    (j) => (j.a.instance === board && j.b.instance === connector) || (j.b.instance === board && j.a.instance === connector),
  );
}

/** "6+2C 75 OHM MINI-COAX" — shielded + plain cores, then the stock's name. */
function cableMaterial(cores: Core[], label: string): string {
  const shielded = cores.filter((c) => c.shielded).length;
  const plain = cores.length - shielded;
  const coax = cores.some((c) => c.coax);
  const name = /coax/i.test(label)
    ? 'MINI-COAX'
    : label
          .replace(/\s*\(.*$/, '')
          .replace(/\b\d+(\+\d+)?C\b|\d+-core|\bshielded\b|75\s*Ω/gi, '')
          .trim();
  return `${shielded}${plain > 0 ? `+${plain}` : ''}C ${coax ? '75 OHM ' : ''}${name}`.toUpperCase().replace(/\s+/g, ' ').trim();
}

/** The remarks block, from the stock's own structure. */
function deriveRemarks(cores: Core[], hasGround: boolean): Remark[] {
  const out: Remark[] = [{ text: 'All cables 100% QC tested.' }];
  const shielded = cores.filter((c) => c.shielded);
  const plain = cores.filter((c) => !c.shielded);
  const colors = (list: Core[]): string => list.map((c) => titleCase(c.element.color ?? c.path)).join(', ');
  const plural = (n: number, word: string): string => `${word}${n === 1 ? '' : 's'}`;
  if (shielded.length > 0) {
    const kind = shielded.every((c) => c.coax) ? '75 ohm' : 'shielded';
    out.push({
      text: `${count(shielded.length)} total ${kind} ${plural(shielded.length, 'conductor')} with insulation ${plural(shielded.length, 'color')}: ${colors(shielded)}.`,
      line: 'shielded',
    });
  }
  if (plain.length > 0) {
    out.push({
      text: `${count(plain.length)} total unshielded with insulation ${plural(plain.length, 'color')}: ${colors(plain)}`,
      line: 'plain',
    });
  }
  if (hasGround) out.push({ text: 'Gray indicates Ground.' });
  return out;
}
