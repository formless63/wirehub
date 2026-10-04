/**
 * `layoutSchematic(design, db)` — the whole geometry pass.
 *
 * The drawing is a story told left to right: end `a` (the console) on the
 * left, the wire bundle as the hero in the middle, end `b` (the sink) on the
 * right, and any branch legs dropping below the trunk to their own connector
 * blocks. Everything below is deterministic arithmetic over the design's
 * declared order — no randomness, no clock, no iteration over unordered sets.
 */

import {
  breakoutFates,
  deriveNets,
  findComponent,
  findConnector,
  findPcba,
  findWire,
  wireDisplayName,
  linkDesignators,
  noteIndexReferencingTerminal,
  parseTerminalKey,
  pigtailMembers,
  pigtailKey,
  terminalKey,
  terminalsOf,
  validateDesign,
  type CableDesign,
  type ComponentDefinition,
  type ConnectorBody,
  type ConnectorDefinition,
  type Db,
  type Issue,
} from '@wirehub/model';

import type { BoardPart } from '@wirehub/catalog';

import {
  boardFaces,
  facePoint,
  isConnectorSideTerminal,
  isNaturalApproach,
  type BoardFaceSide,
  type BoardFacesSource,
  type FacePad,
  type FacePlan,
} from './board-faces.ts';
import { bondedRepresentative } from './bond-fold.ts';
import {
  avoidObstacles,
  clearLaneX,
  componentObstacle,
  cutEndObstacle,
  LANE_TOUCH,
  MAX_DETOUR_PASSES,
  OBSTACLE_EPS,
  separateRoutes,
  settleLanes,
  simplify,
  type DetourRings,
  type LanePlan,
  type Obstacle,
} from './detours.ts';
import { connectorArt, type ConnectorArt } from './connector-art.ts';
import { planPinLeads, type PinLead } from './connector-leads.ts';
import { orderLanes, type LaneRun } from './lanes.ts';
import { optimiseTrackOrder, type TrackLanding } from './track-order.ts';
import { crossSectionLayout } from './cross-section.ts';
import {
  catalogDepictions,
  resolveDepiction,
  type DepictionSource,
  type ResolvedDepiction,
} from './depictions.ts';
import { METRICS as M } from './metrics.ts';
import type {
  Anchor,
  ComponentSymbol,
  CrossSection,
  DepictionDiagnostic,
  Diagram,
  DiagramBand,
  DiagramBlock,
  DiagramBoardFace,
  DiagramBreakout,
  DiagramBreakoutRow,
  DiagramComponent,
  DiagramComponentTerminal,
  DiagramConnectorArt,
  DiagramCutEnd,
  DiagramDepiction,
  DiagramEdge,
  DiagramInternalLink,
  DiagramJointDot,
  DiagramMouldJack,
  DiagramNote,
  DiagramPigtail,
  DiagramPort,
  DiagramThrough,
  DiagramTrack,
  DiagramTrackGroup,
  Point,
  Rect,
  Side,
  Zone,
} from './model.ts';
import {
  analyzeTopology,
  buildTerminalGraph,
  carriedConnectors,
  throughView,
  mountedConnectors,
  trackBarycenter,
  type JointRecord,
  type Topology,
} from './structure.ts';
import { bandTrackSpecs, type GroupSpec, type TrackSpec } from './tracks.ts';
import {
  compareTerminalIds,
  fitText,
  maxTextWidth,
  summarizeIds,
  textWidth,
  wrapText,
} from './text.ts';

/* ------------------------------------------------------------------ *
 * Intermediate plans
 * ------------------------------------------------------------------ */

interface BandPlan {
  segmentId: string;
  def: string;
  label: string;
  fullLabel: string;
  role?: string;
  zone: Zone;
  tracks: TrackSpec[];
  groups: GroupSpec[];
  leftEnd: 'a' | 'b';
  /** x offset, from the band's left edge, where track labels start */
  trackLabelOffset: number;
  groupLabelOffset: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

interface PortPlan {
  key: string;
  terminal: string;
  /** what is printed in the pin-number gutter */
  displayId: string;
  label: string;
  column: 'cable' | 'integrated';
  /**
   * A joint lands here. Only used ports *must* have a depiction anchor; a row
   * shown purely because an internal link mentions it may go unanchored.
   */
  used: boolean;
  bary?: number;
  note?: string;
}

interface BlockPlan {
  id: string;
  kind: 'connector' | 'pcba';
  def: string;
  title: string;
  subtitle?: string;
  note?: string;
  zone: Zone;
  cableSide: Side;
  cable: PortPlan[];
  integrated: PortPlan[];
  captions?: { cable?: string; integrated?: string };
  footnotes: string[];
  cableIdW: number;
  cableLabelW: number;
  integratedIdW: number;
  integratedLabelW: number;
  corridor: number;
  headerHeight: number;
  width: number;
  height: number;
  /** column this block stacks in (`branch`: beyond a branch band's far end) */
  column: 'left' | 'right' | 'branch';
  x: number;
  y: number;
  /** artwork this block draws instead of pin rows */
  depiction?: ResolvedDepiction;
  /** page mm per artwork unit, when depicted */
  artScale: number;
  artWidth: number;
  artHeight: number;
  /** widest callout text, when depicted */
  gutterWidth: number;
  /** a two-faced board's geometry */
  board?: BoardGeometry;
  /** the board a mounted connector is drawn docked beside */
  dockedTo?: string;
  /** the connectors docked beside this board */
  docks: string[];
  /** a connector drawn as itself */
  art?: ArtPlan;
}

/**
 * A connector block drawn as the shared connector art,
 * every coordinate relative to the block's top-left corner: the drawing on
 * the far side, a row per used pin on the cable side (its number and signal
 * printed over its wire), and between them the fan each wire takes from its
 * row to the level it crosses the drawing at (`connector-leads.ts`).
 */
interface ArtPlan {
  art: ConnectorArt;
  def: ConnectorDefinition;
  body?: ConnectorBody;
  /** page mm per art unit */
  scale: number;
  leads: Map<string, PinLead>;
  /** each used pin's row: the level its wire lands on the block edge at */
  rowY: Map<string, number>;
  artX: number;
  artY: number;
  artW: number;
  artH: number;
  captionY: number;
  idW: number;
  labelW: number;
}

/** `id` for a pad, `prefix.id` for an integrated pin, plus the label if it says more. */
function calloutText(port: PortPlan): string {
  const id = port.column === 'integrated' ? port.terminal : port.displayId;
  return port.label === '' || port.label === id ? id : `${id} · ${port.label}`;
}

interface ComponentPlan {
  id: string;
  def: ComponentDefinition;
  symbol: ComponentSymbol;
  label: string;
  zone: 'source' | 'dest' | 'inline';
  location?: string;
  note?: string;
  flip: boolean;
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function symbolFor(definition: ComponentDefinition): ComponentSymbol {
  if (definition.kind === 'resistor') return 'resistor';
  if (definition.kind === 'capacitor') {
    return definition.terminals.some((terminal) => terminal.polarity !== undefined)
      ? 'capacitor-polarized'
      : 'capacitor';
  }
  return 'generic';
}

/**
 * The **printed footnote number** of the design note that names this terminal,
 * if any. Core answers which note it is (0-based, a model fact); numbering
 * footnotes from 1 is the drawing's convention, so that part lives here.
 */
function noteRefForTerminal(design: CableDesign, key: string): number | undefined {
  const index = noteIndexReferencingTerminal(design, parseTerminalKey(key));
  return index === undefined ? undefined : index + 1;
}

/** 0, +1, -1, +2, -2 … — a deterministic outward spread for routing lanes. */
function spreadIndex(index: number): number {
  return index % 2 === 0 ? index / 2 : -(index + 1) / 2;
}

function stackHeight(blocks: readonly BlockPlan[], gap: number): number {
  if (blocks.length === 0) return 0;
  let total = 0;
  for (const block of blocks) total += block.height + footnoteBlockHeight(block);
  return total + gap * (blocks.length - 1);
}

function footnoteBlockHeight(block: BlockPlan): number {
  return block.footnotes.length === 0
    ? 0
    : 1.5 + block.footnotes.length * M.footnoteLineHeight;
}

/**
 * Height of an `n`-line annotation block, first line's cap to last line's
 * descender. The same box the render-svg text audit measures.
 */
function annotationHeight(lines: number): number {
  return lines === 0 ? 0 : (lines - 1) * M.fontAnnot * 1.15 + M.fontAnnot * 0.92;
}

/** Clear air between two annotation blocks. */
const ANNOT_GAP = 0.6;

/**
 * Push apart the `via` annotations of one **depicted** block.
 *
 * On artwork each annotation rides on the middle of the trace it describes,
 * which is right where it belongs — until two traces run close enough that
 * their labels land on top of each other, and the board's most important
 * detail ("R203 180 Ω") becomes an unreadable smudge. Anything that collides
 * moves down, in a deterministic order (topmost first, declaration order to
 * break ties), so it still sits over its own copper but clear of its
 * neighbour. Mutates `items` in place.
 */
function spreadAnnotations(
  items: { x: number; y: number; halfWidth: number; height: number }[],
): void {
  const order = items
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.height > 0)
    .sort((x, y) => (x.item.y === y.item.y ? x.index - y.index : x.item.y - y.item.y));

  const placed: { x0: number; x1: number; top: number; bottom: number }[] = [];
  for (const { item } of order) {
    const x0 = item.x - item.halfWidth;
    const x1 = item.x + item.halfWidth;
    let top = item.y - M.fontAnnot * 0.72;
    // each pass can only move a block downwards, past at least one already
    // placed block, so it settles in at most one pass per placed block
    for (let pass = 0; pass <= placed.length; pass += 1) {
      let pushed = false;
      for (const box of placed) {
        if (x1 <= box.x0 + ANNOT_GAP || x0 >= box.x1 - ANNOT_GAP) continue;
        if (top >= box.bottom + ANNOT_GAP) continue;
        if (top + item.height <= box.top - ANNOT_GAP) continue;
        top = box.bottom + ANNOT_GAP;
        pushed = true;
      }
      if (!pushed) break;
    }
    item.y = top + M.fontAnnot * 0.72;
    placed.push({ x0, x1, top, bottom: top + item.height });
  }
}

/* ------------------------------------------------------------------ *
 * Orthogonal routing
 * ------------------------------------------------------------------ */

/** One joint to route, with the two anchors already ordered left → right. */
interface RouteJob {
  joint: JointRecord;
  left: Anchor;
  right: Anchor;
  /**
   * `same-column`  both anchors leave the same face of the same column
   * `forward`      left leaves rightwards into right, which faces back at it
   * `reverse`      at least one anchor faces away; the route detours below
   */
  mode: 'same-column' | 'forward' | 'reverse';
  bucket: string;
  /**
   * The x each anchor's wire has to reach before it may turn — the outward
   * face of the block it belongs to, or the anchor's own x when it is a track
   * end, a component lead, or a port already on its block's outline.
   */
  leftClear: number;
  rightClear: number;
  /** keep-outs this route has to miss: every component it is not attached to */
  obstacles: Obstacle[];
  /** a forward run's corridors, left to right (see `planLegs`) */
  legs: RouteLeg[];
  net?: string;
}

/**
 * One corridor a forward run crosses: it enters on row `yIn` at the
 * corridor's left side, and leaves on row `yOut` at its right, turning on a
 * vertical lane in between. The lane is chosen per corridor, for every run in
 * it at once (`lanes.ts`), so their order is the crossing-free one.
 */
interface RouteLeg {
  /** corridor identity: its two sides, to 0.1 mm */
  bucket: string;
  from: number;
  to: number;
  yIn: number;
  yOut: number;
  /** undefined when the leg is level and needs no lane */
  laneX?: number;
}

/** Which lane of its bucket a route was given, and how crowded that bucket is. */
interface Lane {
  index: number;
  size: number;
}

/**
 * Are these two anchors on the same horizontal run?
 *
 * Exact equality, deliberately — this is the one place a tolerance would be a
 * lie. The straight two-point form below draws from anchor to anchor, so if
 * "aligned" meant "within a fraction of a millimetre" the drawing would carry
 * a shallow diagonal wherever the fraction was non-zero, and the schematic's
 * visual language has no diagonals in it. Two anchors that are merely *close*
 * (a pin row pitched at `portPitch` meeting a track pitched at `trackPitch`
 * can land 0.15 mm apart) take the ordinary jogged route instead: the jog is
 * sub-millimetre and invisible on paper, and every segment it emits is exactly
 * horizontal or exactly vertical.
 */
function level(a: Anchor, b: Anchor): boolean {
  return a.y === b.y;
}

/**
 * The polyline for one joint. Every consecutive pair of points shares an x or
 * a y exactly — the invariant the whole drawing is built on, pinned by
 * `layout.test.ts` and again at the SVG level by `structure.test.ts`.
 */
function routeJoint(
  job: RouteJob,
  lane: Lane,
  spread?: ReadonlyMap<string, number>,
  rings?: DetourRings,
): Point[] {
  return avoidObstacles(
    cutRoute(job, lane, undefined, spread),
    job.obstacles.filter((item) => item.laneOnly === undefined),
    rings,
    job.net,
  );
}

/**
 * `routeJoint` before the obstacle pass: the shape of the run, in the clear.
 * `record` hears of every vertical lane it cuts; `spread` moves lanes to the
 * x `settleLanes` gave them.
 */
function cutRoute(
  job: RouteJob,
  lane: Lane,
  record?: (item: LanePlan) => void,
  spread?: ReadonlyMap<string, number>,
): Point[] {
  const { left, right } = job;
  /** Where a wire leaving `anchor` is first allowed to turn. */
  const exitX = (anchor: Anchor, clear: number, extra = 0): number =>
    anchor.dir === 1
      ? Math.max(anchor.x + M.stub + extra, clear + M.stub)
      : Math.min(anchor.x - M.stub - extra, clear - M.stub);
  const leftStub = { x: exitX(left, job.leftClear), y: left.y };
  const rightStub = { x: exitX(right, job.rightClear), y: right.y };

  if (job.mode === 'same-column') {
    if (level(left, right)) {
      return [
        { x: left.x, y: left.y },
        { x: right.x, y: left.y },
      ];
    }
    // both anchors face the same way, so one lane has to clear both blocks
    const clear =
      left.dir === 1
        ? Math.max(job.leftClear, job.rightClear)
        : Math.min(job.leftClear, job.rightClear);
    const candidate = exitX(left, clear, lane.index * 1.6);
    const cleared = clearLaneX(candidate, left.y, right.y, job.obstacles);
    const id = `${job.joint.index}:-1`;
    // out beyond both blocks' exit, never back toward the column
    const exit = exitX(left, clear);
    const reach = exit + left.dir * 2 * MAX_DETOUR_PASSES * M.lanePitchMin;
    const face = cleared.face;
    const lo = Math.min(exit, reach);
    const hi = Math.max(exit, reach);
    record?.({
      id,
      x: cleared.x,
      ...(face === undefined ? {} : { face }),
      candidate,
      y0: Math.min(left.y, right.y),
      y1: Math.max(left.y, right.y),
      lo: face?.outward === 1 ? Math.max(lo, face.x) : lo,
      hi: face?.outward === -1 ? Math.min(hi, face.x) : hi,
      ...(job.net === undefined ? {} : { net: job.net }),
      tie: job.joint.index,
      obstacles: job.obstacles,
    });
    const x = spread?.get(id) ?? cleared.x;
    return [
      { x: left.x, y: left.y },
      { x, y: left.y },
      { x, y: right.y },
      { x: right.x, y: right.y },
    ];
  }

  if (job.mode === 'forward') {
    // one leg per corridor the run crosses: in along its entry row, along
    // its lane, out along its exit row. A run that has to get round a block
    // standing in its corridor has two, joined over or under the block.
    const points: Point[] = [{ x: left.x, y: left.y }];
    job.legs.forEach((leg, index) => {
      if (leg.laneX === undefined) return; // a level leg passes straight through
      const cleared = clearLaneX(leg.laneX, leg.yIn, leg.yOut, job.obstacles);
      const id = `${job.joint.index}:${index}`;
      const face = cleared.face;
      // never out of the leg's own corridor, never back into the keep-out
      const lo = Math.min(leg.from, leg.to);
      const hi = Math.max(leg.from, leg.to);
      record?.({
        id,
        x: cleared.x,
        ...(face === undefined ? {} : { face }),
        candidate: leg.laneX,
        y0: Math.min(leg.yIn, leg.yOut),
        y1: Math.max(leg.yIn, leg.yOut),
        lo: face?.outward === 1 ? Math.max(lo, face.x) : lo,
        hi: face?.outward === -1 ? Math.min(hi, face.x) : hi,
        ...(job.net === undefined ? {} : { net: job.net }),
        tie: job.joint.index,
        obstacles: job.obstacles,
      });
      const x = spread?.get(id) ?? cleared.x;
      points.push({ x, y: leg.yIn }, { x, y: leg.yOut });
    });
    points.push({ x: right.x, y: right.y });
    return points;
  }

  const laneY = Math.max(left.y, right.y) + 5 + spreadIndex(lane.index) * 2.2;
  return [
    { x: left.x, y: left.y },
    leftStub,
    { x: leftStub.x, y: laneY },
    { x: rightStub.x, y: laneY },
    rightStub,
    { x: right.x, y: right.y },
  ];
}

/* ------------------------------------------------------------------ *
 * layoutSchematic
 * ------------------------------------------------------------------ */

export interface LayoutOptions {
  /**
   * Draw the trunk stock's cross-section cutaway as an inset under the trunk
   * column (default `true`). Turn it off for sheets that carry the cutaway
   * separately — `renderCrossSection` produces the same panel standalone.
   */
  crossSection?: boolean;
  /**
   * Draw blocks whose definition has usable artwork as **depicted** blocks —
   * the asset at true size, ports on the real pad positions (default `true`).
   * `false` gives every block the abstract pin-row table; a `DepictionSource`
   * supplies the artwork from somewhere other than the catalog's committed
   * tree. A block whose artwork is missing, unreadable or short an anchor for
   * a used pin falls back on its own, and says so in `diagram.depictions`.
   */
  depictions?: boolean | DepictionSource;
}

export function layoutSchematic(
  original: CableDesign,
  db: Db,
  options: LayoutOptions = {},
): Diagram {
  const issues = validateDesign(original, db);
  // a pin soldered through a carrier's hole onto the board beneath (e5c.37)
  // is drawn into the hole like the plug's other pins; the pad reads landed
  const through = throughView(original);
  const design = through.design;
  const landedThrough = new Map(through.landings.map((landing) => [landing.pad, landing]));
  const topology = analyzeTopology(design, db);
  for (const pad of landedThrough.keys()) topology.usedTerminals.add(pad);
  const graph = buildTerminalGraph(design, db, topology.joints, topology.kindOf);

  // galvanic nets, straight from core: every drawn piece of copper carries
  // its net id so a viewer can light up a whole trace without re-deriving it
  const netOf = new Map<string, string>();
  for (const net of deriveNets(original, db)) {
    for (const terminal of net.terminals) netOf.set(terminal.key, net.id);
  }

  const depictionOption = options.depictions ?? true;
  const depictionSource: DepictionSource | undefined =
    depictionOption === false
      ? undefined
      : depictionOption === true
        ? catalogDepictions()
        : depictionOption;
  const depictions: DepictionDiagnostic[] = [];
  const depictionIssues: Issue[] = [];

  /**
   * Resolve one block's artwork, recording what happened either way. A block
   * with no depiction at all is the ordinary case and raises no issue; artwork
   * that exists but cannot be used is a defect, and warns.
   */
  const planDepiction = (
    kind: 'connector' | 'pcba',
    id: string,
    def: string,
    ports: readonly PortPlan[],
  ): ResolvedDepiction | undefined => {
    if (depictionSource === undefined) return undefined;
    const required = ports.filter((port) => port.used).map((port) => port.terminal);
    const resolution = resolveDepiction(depictionSource, kind, def, required);
    depictions.push({
      instance: id,
      def,
      kind,
      status: resolution.status,
      ...(resolution.depiction === undefined ? {} : { view: resolution.depiction.view }),
      ...(resolution.missing === undefined ? {} : { missing: resolution.missing }),
      ...(resolution.detail === undefined ? {} : { detail: resolution.detail }),
    });
    if (resolution.status === 'drawn' || resolution.status === 'no-depiction') {
      return resolution.depiction;
    }
    const why =
      resolution.missing === undefined
        ? (resolution.detail ?? resolution.status)
        : `no anchor for used pin(s) ${resolution.missing.join(', ')}`;
    depictionIssues.push({
      code: `depiction-${resolution.status}`,
      severity: 'warning',
      message: `${id} (${def}) draws as an abstract block: ${why}`,
      where: `${design.id}/${id}`,
    });
    return undefined;
  };

  /* --- 1 · bands ------------------------------------------------- */

  const bandPlans: BandPlan[] = [];
  const segmentOrder = [
    topology.trunkId,
    ...topology.branches.map((branch) => branch.segmentId),
  ];
  for (const segmentId of segmentOrder) {
    const instance = design.instances.segments.find((item) => item.id === segmentId);
    if (instance === undefined) continue;
    const wire = findWire(db, instance.def);
    if (wire === undefined) continue;
    const { tracks, groups } = bandTrackSpecs(wire, instance.scope);
    const branch = topology.branches.find((item) => item.segmentId === segmentId);
    const isTrunk = branch === undefined;

    const labelParts = [wireDisplayName(db, instance.def)];
    if (instance.lengthMm !== undefined) labelParts.push(`${instance.lengthMm} mm`);
    if (instance.role !== undefined) labelParts.push(instance.role);

    const groupLabelW = maxTextWidth(
      groups.map((group) => group.label),
      M.fontGroup,
      'bold',
    );
    const groupLabelOffset = M.bracketX + M.bracketWidth + M.groupLabelGap;
    const trackLabelOffset = groupLabelOffset + groupLabelW + M.trackLabelGap;
    const trackLabelW = maxTextWidth(
      tracks.map((track) => track.label),
      M.fontTrack,
    );
    const minWidth = isTrunk ? M.bandMinWidth : M.branchBandMinWidth;
    const width = Math.max(minWidth, trackLabelOffset + trackLabelW + M.bandTailPad);
    const height = 2 * M.bandPadY + Math.max(0, tracks.length - 1) * M.trackPitch;

    // Which physical end sits at the band's left edge. A branch hangs under
    // the trunk with its near end toward the column it joins and its far end
    // toward the blocks it runs out to: a source-side
    // whip reads left to right like the trunk above it.
    let leftEnd: 'a' | 'b' = 'a';
    if (branch !== undefined) {
      leftEnd = branch.hostZone === 'source' ? branch.nearEnd : branch.farEnd;
      // a leg out of the trunk's destination mould runs on rightwards from it
      if (branch.breakout !== undefined && branch.hostZone === 'dest') leftEnd = branch.nearEnd;
    }

    bandPlans.push({
      segmentId,
      def: instance.def,
      // stops short of the band's far end, where a breakout mould's title can stand
      label: fitText(labelParts.join(' · '), M.fontBandLabel, width - 4, 'bold'),
      fullLabel: labelParts.join(' · '),
      ...(instance.role === undefined ? {} : { role: instance.role }),
      zone: isTrunk ? 'source' : 'branch',
      tracks,
      groups,
      leftEnd,
      trackLabelOffset,
      groupLabelOffset,
      width,
      height,
      x: 0,
      y: 0,
    });
  }

  /* --- 2 · vertical rank of every track, for port ordering -------- */

  const rankByTrack = new Map<string, number>();
  const pigtailedEnds = new Set<string>();
  /** track keys (no end) a pigtail's members draw as, folded screens resolved */
  const pigtailTrackPaths = new Map<string, string[]>();
  const foldedTo = new Map<string, string>();
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const set of wire.bonded ?? []) {
      const rep = bondedRepresentative(wire, set);
      for (const member of set.members) foldedTo.set(`${segment.id}:${member}`, `${segment.id}:${rep}`);
    }
  }
  /** the track a segment terminal (`w1:core-red.shield`, no end) draws on */
  const trackKeyOf = (key: string): string => foldedTo.get(key) ?? key;
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const pigtail of segment.pigtails ?? []) {
      const members = pigtailMembers(wire, pigtail);
      for (const path of members) pigtailedEnds.add(`${segment.id}:${path}@${pigtail.end}`);
      const paths = [...new Set(members.map((path) => trackKeyOf(`${segment.id}:${path}`)))];
      pigtailTrackPaths.set(pigtailKey(segment.id, pigtail), paths);
    }
  }
  const setRanks = (): void => {
    rankByTrack.clear();
    let rankCursor = 0;
    for (const band of bandPlans) {
      for (const track of band.tracks) {
        rankByTrack.set(`${band.segmentId}:${track.elementPath}`, rankCursor);
        rankCursor += 1;
      }
      rankCursor += 4; // keep bands apart in rank space
    }
    for (const [key, paths] of pigtailTrackPaths) {
      const ranks = paths
        .map((path) => rankByTrack.get(path))
        .filter((rank): rank is number => rank !== undefined);
      if (ranks.length > 0) {
        rankByTrack.set(key, ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length);
      }
    }
  };
  setRanks();
  const rankOf = (key: string): number | undefined => {
    const exact = rankByTrack.get(key);
    if (exact !== undefined) return exact;
    const ref = parseTerminalKey(key);
    return rankByTrack.get(trackKeyOf(`${ref.instance}:${ref.terminal}`));
  };

  /* --- 3 · blocks ------------------------------------------------- */

  const blockPlans: BlockPlan[] = [];
  // a plug soldered into a carrier board docks on the carrier (e5c.36)
  const carried = carriedConnectors(design);
  const mounts = new Map<string, { board: string; prefixes: string[]; beyond?: string }>([
    ...mountedConnectors(design),
    ...carried,
  ]);
  // a connector a breakout houses is drawn inside its
  // mould's own outline (§8b below), never as a block of its own on a lead
  const housedIds = new Set((design.instances.breakouts ?? []).flatMap((b) => b.housed ?? []));

  /** the side a block's wires leave toward, from where it sits in the story */
  const cableSideOf = (zone: Zone, id: string): Side => {
    if (zone === 'branch') {
      const branch = topology.branches.find((item) => item.blockIds.includes(id));
      // a leg out of the trunk's destination mould runs on rightwards, its
      // plugs beyond it facing back at it (the band's far end is on its right)
      if (branch?.breakout !== undefined && branch.hostZone === 'dest') return 'left';
      // a branch's blocks sit beyond its far end: right of a source-side
      // branch (facing back at it), left of a destination-side one
      return branch?.hostZone === 'dest' ? 'right' : 'left';
    }
    return zone === 'dest' ? 'left' : 'right';
  };

  const orderPorts = (ports: PortPlan[]): PortPlan[] =>
    [...ports].sort((x, y) => {
      const xBary = x.bary ?? Number.POSITIVE_INFINITY;
      const yBary = y.bary ?? Number.POSITIVE_INFINITY;
      if (xBary !== yBary) return xBary - yBary;
      return compareTerminalIds(x.terminal, y.terminal);
    });

  for (const instance of design.instances.connectors) {
    if (housedIds.has(instance.id)) continue;
    const definition = findConnector(db, instance.def);
    if (definition === undefined) continue;
    const zone = topology.zoneOf.get(instance.id) ?? 'source';
    const used: PortPlan[] = [];
    const unused: string[] = [];
    // core enumerates the pins and carries each one's label and note; the
    // drawing only decides which of them get a row and which get a footnote.
    for (const pin of terminalsOf(design, db, instance.id)) {
      if (!topology.usedTerminals.has(pin.key)) {
        unused.push(pin.terminal);
        continue;
      }
      const bary = trackBarycenter(graph, pin.key, rankOf);
      used.push({
        key: pin.key,
        terminal: pin.terminal,
        displayId: pin.terminal,
        label: pin.label ?? '',
        column: 'cable',
        used: true,
        ...(bary === undefined ? {} : { bary }),
        ...(pin.note === undefined ? {} : { note: pin.note }),
      });
    }
    const subtitleParts: string[] = [];
    if (instance.role !== undefined) subtitleParts.push(instance.role);
    subtitleParts.push(
      definition.gender === undefined
        ? definition.family
        : `${definition.family} ${definition.gender}`,
    );
    const cable = orderPorts(used);
    blockPlans.push(
      finishBlockPlan(
        {
          id: instance.id,
          kind: 'connector',
          def: instance.def,
          title: definition.label,
          subtitle: subtitleParts.join(' · '),
          ...(instance.note === undefined ? {} : { note: instance.note }),
          zone,
          cable,
          integrated: [],
          footnotes:
            unused.length === 0 ? [] : [`pins not used: ${summarizeIds(unused)}`],
          depiction: planDepiction('connector', instance.id, instance.def, cable),
        },
        cableSideOf(zone, instance.id),
      ),
    );
    // no artwork of its own: the connector draws as itself, from the shared
    // connector art — never when depictions are off,
    // so the abstract drawing stays the pin table it always was
    const plan = blockPlans[blockPlans.length - 1]!;
    if (depictionSource !== undefined && plan.depiction === undefined) {
      const body = definition.body === undefined ? undefined : (db.bodies ?? []).find((item) => item.id === definition.body);
      const drawn = planConnectorArt(plan, definition, body);
      if (drawn !== undefined) {
        plan.art = drawn.art;
        plan.width = drawn.width;
        plan.height = drawn.height;
        plan.headerHeight = 5.5 + (plan.subtitle === undefined ? 0 : 4.2);
        const diagnostic = depictions[depictions.length - 1];
        if (diagnostic?.instance === instance.id && diagnostic.status === 'no-depiction') {
          diagnostic.status = 'drawn';
          diagnostic.view = drawn.art.art.view === 'profile' ? 'side-profile' : 'mating-face';
          diagnostic.detail = `built-in connector art (${drawn.art.art.short})`;
        }
      }
    }
  }

  for (const instance of design.instances.pcbas) {
    const definition = findPcba(db, instance.def);
    if (definition === undefined) continue;
    const zone = topology.zoneOf.get(instance.id) ?? 'dest';

    const linked = new Set<string>();
    for (const link of definition.internalLinks) {
      linked.add(link.from);
      linked.add(link.to);
    }
    const shown = (terminal: string): boolean =>
      topology.usedTerminals.has(`${instance.id}:${terminal}`) || linked.has(terminal);

    // Unlike a connector, a PCBA's terminals are read straight off the
    // definition rather than through `terminalsOf`: the drawing has to split
    // them into two columns (own pads vs. integrated-connector pins) and print
    // an integrated pin under its *un-prefixed* id, and both of those are
    // facts about the definition's shape that a flat terminal list has thrown
    // away by the time it reaches here.
    const pads: PortPlan[] = [];
    const unusedPads: string[] = [];
    for (const terminal of definition.terminals) {
      if (!shown(terminal.id)) {
        unusedPads.push(terminal.id);
        continue;
      }
      const key = `${instance.id}:${terminal.id}`;
      const bary = trackBarycenter(graph, key, rankOf);
      const hole = landedThrough.get(key)?.hole;
      pads.push({
        key,
        terminal: terminal.id,
        displayId: terminal.id,
        // landed through the carrier hole above it: no run comes to it (e5c.37)
        label: `${terminal.label ?? terminal.id}${hole === undefined ? '' : ` · through ${hole.replace(':', ' ')}`}`,
        column: 'cable',
        used: topology.usedTerminals.has(key),
        ...(bary === undefined ? {} : { bary }),
        ...(terminal.note === undefined ? {} : { note: terminal.note }),
      });
    }

    const integrated: PortPlan[] = [];
    const unusedPins: string[] = [];
    const prefixes: string[] = [];
    for (const integratedConnector of definition.integratedConnectors ?? []) {
      const connector = findConnector(db, integratedConnector.connectorDefId);
      if (connector === undefined) continue;
      prefixes.push(`${integratedConnector.terminalPrefix}.n`);
      for (const pin of connector.pins) {
        const terminal = `${integratedConnector.terminalPrefix}.${pin.id}`;
        if (!shown(terminal)) {
          unusedPins.push(pin.id);
          continue;
        }
        const key = `${instance.id}:${terminal}`;
        const bary = trackBarycenter(graph, key, rankOf);
        integrated.push({
          key,
          terminal,
          displayId: pin.id,
          label: pin.label,
          column: 'integrated',
          used: topology.usedTerminals.has(key),
          ...(bary === undefined ? {} : { bary }),
          ...(pin.note === undefined ? {} : { note: pin.note }),
        });
      }
    }

    const footnotes: string[] = [];
    if (unusedPads.length > 0) footnotes.push(`pads not used: ${summarizeIds(unusedPads)}`);
    if (unusedPins.length > 0) {
      footnotes.push(`connector pins not wired: ${summarizeIds(unusedPins)}`);
    }

    const buildLabel =
      definition.build === undefined ? '' : ` · ${definition.build}`;
    const cable = orderPorts(pads);
    const integratedPorts = orderPorts(integrated);
    const depiction = planDepiction('pcba', instance.id, instance.def, [
      ...cable,
      ...integratedPorts,
    ]);
    // A depicted block draws one gutter of callouts over one picture, so the
    // two-column captions have nothing left to caption.
    const captions =
      integrated.length === 0 || depiction !== undefined
        ? undefined
        : { cable: 'cable pads', integrated: prefixes.join(' / ') };
    // the terminals the board's own mounted connector lands on: its pins
    // print their own labels, so the board draws those pads unlabelled
    const dockJoined = new Set<string>();
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== instance.id) continue;
        const mount = mounts.get(other.instance);
        if (mount?.board !== instance.id) continue;
        // a carrier's slot pad a pin also lands on (jp.R) keeps its name
        if (mount.beyond !== undefined && !mount.prefixes.some((prefix) => mine.terminal.startsWith(`${prefix}.`))) continue;
        dockJoined.add(mine.terminal);
      }
    }
    // a carrier's slot pads face the board beyond it (e5c.36)
    const cableFacing = new Set<string>();
    for (const mount of carried.values()) {
      if (mount.board !== instance.id) continue;
      for (const joint of design.joints) {
        for (const [mine, other] of [
          [joint.a, joint.b],
          [joint.b, joint.a],
        ] as const) {
          if (mine.instance === instance.id && other.instance === mount.beyond) cableFacing.add(mine.terminal);
        }
      }
    }
    blockPlans.push(
      finishBlockPlan(
        {
          id: instance.id,
          kind: 'pcba',
          def: instance.def,
          title: `${definition.partNumber} ${definition.revision}${buildLabel}`,
          subtitle: definition.label,
          ...(instance.note === undefined ? {} : { note: instance.note }),
          zone,
          cable,
          integrated: integratedPorts,
          ...(captions === undefined ? {} : { captions }),
          footnotes,
          ...(depiction === undefined ? {} : { depiction }),
          terminals: definition.terminals.map((terminal) => terminal.id).concat(
            (definition.integratedConnectors ?? []).flatMap((carried) => {
              const connector = findConnector(db, carried.connectorDefId);
              return (connector?.pins ?? []).map((pin) => `${carried.terminalPrefix}.${pin.id}`);
            }),
          ),
          dockJoined,
          ...(cableFacing.size === 0 ? {} : { cableFacing }),
        },
        cableSideOf(zone, instance.id),
      ),
    );
  }

  // A connector mounted on a two-faced board is drawn beside the board's
  // connector edge, pins facing it, instead of stacking in the column
  // — the schematic's form of the canvas's dock bay.
  const planById = new Map(blockPlans.map((plan) => [plan.id, plan]));
  for (const [connectorId, mount] of mounts) {
    const connector = planById.get(connectorId);
    const board = planById.get(mount.board);
    if (connector === undefined || board?.board === undefined) continue;
    if (connector.depiction !== undefined || connector.zone === 'branch' || board.zone === 'branch') continue;
    connector.dockedTo = board.id;
    const turned = connector.cableSide !== board.cableSide;
    connector.cableSide = board.cableSide;
    board.docks.push(connector.id);
    // a drawn connector faces the board now: redraw it for that side
    if (turned && connector.art !== undefined) {
      const drawn = planConnectorArt(connector, connector.art.def, connector.art.body);
      if (drawn === undefined) delete connector.art;
      else {
        connector.art = drawn.art;
        connector.width = drawn.width;
        connector.height = drawn.height;
      }
    }
  }
  // A carrier board with its plug docked on it docks beside the board beyond
  // it in turn: plug | perfboard | board, the
  // perfboard's slot pads facing the board across a corridor of its own.
  /** the corridor between a docked plan and its host, when not `M.dockGap` */
  const dockGapOf = new Map<string, number>();
  for (const [plugId, mount] of carried) {
    const plug = planById.get(plugId);
    const carrier = planById.get(mount.board);
    const beyond = planById.get(mount.beyond);
    if (plug?.dockedTo !== carrier?.id || carrier?.board === undefined || beyond === undefined) continue;
    if (carrier.dockedTo !== undefined || beyond.dockedTo !== undefined || beyond.zone === 'branch') continue;
    if (carrier.cableSide !== beyond.cableSide || beyond.docks.length > 0) continue;
    carrier.dockedTo = beyond.id;
    beyond.docks.push(carrier.id);
    // every run across it: the slot pads' T-joins, and the pins that pass the carrier
    const runs = topology.joints.filter((joint) => {
      const pair = [joint.a.instance, joint.b.instance];
      return pair.includes(beyond.id) && (pair.includes(carrier.id) || pair.includes(plugId));
    }).length;
    dockGapOf.set(carrier.id, Math.max(M.dockGap, 2 * M.stub + 8 + runs * M.lanePitchMin * 1.4));
  }

  /* --- 4 · components -------------------------------------------- */

  const componentPlans: ComponentPlan[] = [];
  for (const instance of design.instances.components) {
    const definition = findComponent(db, instance.def);
    if (definition === undefined) continue;
    const zone = topology.componentZone.get(instance.id) ?? 'source';
    const value = definition.value ?? definition.label;
    componentPlans.push({
      id: instance.id,
      def: definition,
      symbol: symbolFor(definition),
      label: `${instance.id} · ${value}`,
      zone,
      ...(instance.location === undefined ? {} : { location: instance.location }),
      ...(instance.note === undefined ? {} : { note: instance.note }),
      flip: false,
      x: 0,
      y: 0,
    });
  }

  /* --- 5 · horizontal placement ----------------------------------- */

  for (const block of blockPlans) {
    block.column =
      block.zone === 'branch' ? 'branch' : block.cableSide === 'right' ? 'left' : 'right';
  }
  const docked = (host: BlockPlan): BlockPlan[] =>
    host.docks
      .map((id) => planById.get(id))
      .filter((plan): plan is BlockPlan => plan !== undefined);
  const gapOf = (plan: BlockPlan): number => dockGapOf.get(plan.id) ?? M.dockGap;
  /** a block and the connectors docked beside it (and theirs), side by side */
  const unitWidth = (host: BlockPlan): number => {
    const mounted = docked(host);
    return mounted.length === 0
      ? host.width
      : host.width + Math.max(...mounted.map((plan) => gapOf(plan) + unitWidth(plan)));
  };
  const hosts = blockPlans.filter((block) => block.dockedTo === undefined);
  const leftBlocks = hosts.filter((block) => block.column === 'left');
  const rightBlocks = hosts.filter((block) => block.column === 'right');
  const leftWidth = leftBlocks.reduce((widest, block) => Math.max(widest, unitWidth(block)), 0);
  const rightWidth = rightBlocks.reduce((widest, block) => Math.max(widest, unitWidth(block)), 0);

  // the trunk's destination breakout mould: it sits on
  // the trunk's end, and its legs run on out of it in the right column, their
  // plugs beyond them
  const mould = (design.instances.breakouts ?? []).find(
    (b) => b.trunk.segment === topology.trunkId && b.trunk.end === 'b',
  );
  const isMouldLeg = (band: BandPlan): boolean =>
    mould !== undefined && topology.branches.some((item) => item.segmentId === band.segmentId && item.breakout === mould.id);
  const mouldLegs = bandPlans.slice(1).filter(isMouldLeg);
  const branchBands = bandPlans.slice(1).filter((band) => !isMouldLeg(band));
  // a connector the mould houses needs room for its own
  // drawing too — reserved here, before anything downstream is placed off the
  // mould's width, so its box never has to overflow to fit the jack in later
  const housedWidth =
    mould === undefined || depictionSource === undefined
      ? 0
      : (mould.housed ?? []).reduce((widest, id) => {
          const instance = design.instances.connectors.find((c) => c.id === id);
          const definition = instance === undefined ? undefined : findConnector(db, instance.def);
          if (definition === undefined) return widest;
          const body = definition.body === undefined ? undefined : (db.bodies ?? []).find((item) => item.id === definition.body);
          const art = connectorArt({ def: definition, facing: 'right', ...(body === undefined ? {} : { body }) });
          return art === undefined ? widest : Math.max(widest, art.width * M.artProfileScale + 2 * M.breakoutInset);
        }, 0);
  const mouldWidth =
    mould === undefined ? 0 : Math.max(M.pigtailBracketGap + 3 * M.pigtailSlotPitch + M.pigtailLead + M.breakoutPad, housedWidth);
  // the fan corridors widen with the number of runs they carry, so their
  // lanes keep a readable pitch
  const fanRuns = (end: 'a' | 'b'): number =>
    topology.joints.filter(
      (joint) =>
        (joint.a.instance === topology.trunkId && joint.a.end === end) ||
        (joint.b.instance === topology.trunkId && joint.b.end === end),
    ).length;
  const fanGapFor = (runs: number): number =>
    Math.max(M.fanGap, 2 * M.stub + 8 + runs * M.lanePitchMin * 1.4);
  const leftFan = fanGapFor(fanRuns('a'));
  const throughRuns = mould === undefined ? 0 : mouldLegs.length * 2;
  const rightFan = fanGapFor(fanRuns('b') + throughRuns) + mouldWidth;

  const leftColumnX = M.margin;
  const trunkBand = bandPlans[0];

  const trunkX = leftColumnX + leftWidth + leftFan;
  if (trunkBand !== undefined) trunkBand.x = trunkX;
  // a branch hangs under the trunk, inside the trunk's own column, with its
  // blocks beyond its far end — and the trunk runs the column's full width,
  // so the fans at its ends start past anything hanging under it
  let middleWidth = trunkBand?.width ?? M.bandMinWidth;
  for (const band of branchBands) {
    const branch = topology.branches.find((item) => item.segmentId === band.segmentId);
    const far = blockPlans.filter((block) => branch?.blockIds.includes(block.id) === true);
    const farWidth = far.reduce((widest, block) => Math.max(widest, block.width), 0);
    middleWidth = Math.max(
      middleWidth,
      band.width + (far.length === 0 ? 0 : M.branchFanGap + farWidth),
    );
  }
  if (trunkBand !== undefined) trunkBand.width = middleWidth;
  const trunkWidth = trunkBand?.width ?? M.bandMinWidth;
  const trunkRight = trunkX + trunkWidth;
  const rightColumnX = trunkX + middleWidth + rightFan;

  /**
   * Both columns sit flush on their **cable** side, so every port in a column
   * starts its wire on the same line and the fan-out corridor between the
   * column and the band is empty. A connector docked on a board sits beyond
   * the board's connector edge, across the dock corridor.
   */
  const placeDocksX = (block: BlockPlan, column: 'left' | 'right'): void => {
    for (const plan of docked(block)) {
      plan.x = column === 'left' ? block.x - gapOf(plan) - plan.width : block.x + block.width + gapOf(plan);
      placeDocksX(plan, column);
    }
  };
  for (const block of hosts) {
    if (block.column === 'left') {
      block.x = leftColumnX + leftWidth - block.width;
      placeDocksX(block, 'left');
    } else if (block.column === 'right') {
      block.x = rightColumnX;
      placeDocksX(block, 'right');
    }
  }
  let contentRight = rightColumnX + rightWidth;
  for (const band of mouldLegs) {
    const branch = topology.branches.find((item) => item.segmentId === band.segmentId);
    const far = hosts.filter((block) => branch?.blockIds.includes(block.id) === true);
    band.x = rightColumnX;
    for (const block of far) {
      block.x = band.x + band.width + M.branchFanGap;
      contentRight = Math.max(contentRight, block.x + block.width);
    }
    contentRight = Math.max(contentRight, band.x + band.width);
  }
  for (const band of branchBands) {
    const branch = topology.branches.find((item) => item.segmentId === band.segmentId);
    const far = hosts.filter((block) => branch?.blockIds.includes(block.id) === true);
    if (branch?.hostZone === 'dest') {
      band.x = trunkX + middleWidth - band.width;
      for (const block of far) block.x = band.x - M.branchFanGap - block.width;
    } else {
      band.x = trunkX;
      for (const block of far) {
        // inside the trunk's own width where they fit, clear of the fan
        // corridor beyond it
        block.x = Math.max(
          band.x + band.width + M.branchFanGap,
          Math.min(trunkRight - block.width, trunkX + middleWidth - block.width),
        );
        contentRight = Math.max(contentRight, block.x + block.width);
      }
    }
  }

  /* --- 6 · vertical placement -------------------------------------- */

  const contentTop = M.margin + M.titleBlockHeight;
  if (trunkBand !== undefined) trunkBand.y = contentTop + M.bandLabelHeight;
  const trunkCenter = (trunkBand?.y ?? contentTop) + (trunkBand?.height ?? 0) / 2;

  const stackGap = 11;
  const dockStack = 6;
  /** a unit's extent above and below its host's own top edge (docks of docks too) */
  const unitExtent = (host: BlockPlan): { top: number; bottom: number } => {
    const mounted = docked(host);
    const own = host.height + footnoteBlockHeight(host);
    if (mounted.length === 0) return { top: 0, bottom: own };
    const total = stackHeight(mounted, dockStack);
    const start = host.height / 2 - total / 2;
    let top = Math.min(0, start);
    let bottom = Math.max(own, start + total);
    let cursor = start;
    for (const plan of mounted) {
      const inner = unitExtent(plan);
      top = Math.min(top, cursor + inner.top);
      bottom = Math.max(bottom, cursor + inner.bottom);
      cursor += plan.height + footnoteBlockHeight(plan) + dockStack;
    }
    return { top, bottom };
  };
  /** its docks centred on the block, and theirs on them */
  const placeDocksY = (block: BlockPlan): void => {
    const mounted = docked(block);
    let dockCursor = block.y + block.height / 2 - stackHeight(mounted, dockStack) / 2;
    for (const plan of mounted) {
      plan.y = dockCursor;
      dockCursor += plan.height + footnoteBlockHeight(plan) + dockStack;
      placeDocksY(plan);
    }
  };
  const placeStack = (blocks: BlockPlan[], center: number, minTop: number): number => {
    if (blocks.length === 0) return minTop;
    const extents = blocks.map((block) => unitExtent(block));
    const total =
      extents.reduce((sum, extent) => sum + extent.bottom - extent.top, 0) +
      stackGap * (blocks.length - 1);
    let cursor = Math.max(minTop, center - total / 2);
    blocks.forEach((block, index) => {
      const extent = extents[index]!;
      block.y = cursor - extent.top;
      placeDocksY(block);
      cursor += extent.bottom - extent.top + stackGap;
    });
    return cursor - stackGap;
  };

  let bottom = contentTop;
  // the mould's legs stack down the right column from the top, each with its plugs beside it
  let rightTop = contentTop;
  for (const band of mouldLegs) {
    band.y = rightTop + M.bandLabelHeight;
    const branch = topology.branches.find((item) => item.segmentId === band.segmentId);
    const far = hosts.filter((block) => branch?.blockIds.includes(block.id) === true);
    const stackBottom = placeStack(far, band.y + band.height / 2, band.y - M.bandLabelHeight);
    rightTop = Math.max(band.y + band.height, stackBottom) + M.branchGapY;
    bottom = Math.max(bottom, rightTop);
  }
  bottom = Math.max(bottom, placeStack(leftBlocks.filter((block) => block.zone !== 'branch'), trunkCenter, contentTop));
  bottom = Math.max(bottom, placeStack(rightBlocks.filter((block) => block.zone !== 'branch'), mouldLegs.length > 0 ? rightTop : trunkCenter, rightTop));
  if (trunkBand !== undefined) bottom = Math.max(bottom, trunkBand.y + trunkBand.height);

  // branches: under the trunk band, in its column
  let middleBottom = trunkBand === undefined ? contentTop : trunkBand.y + trunkBand.height;
  for (const band of branchBands) {
    band.y = middleBottom + M.branchGapY + M.bandLabelHeight;
    const branch = topology.branches.find((item) => item.segmentId === band.segmentId);
    const far = hosts.filter((block) => branch?.blockIds.includes(block.id) === true);
    const center = band.y + band.height / 2;
    const stackBottom = placeStack(far, center, band.y - M.bandLabelHeight);
    middleBottom = Math.max(band.y + band.height, stackBottom);
    bottom = Math.max(bottom, middleBottom);
  }

  /* --- 6b · track order and board face order ----------------------- */

  // Where each joint end lands on a two-faced board is fixed by the board;
  // everything else follows the tracks. So pick, together, which face of
  // each board stacks on top and which order the band's tracks run in, for
  // the fewest crossings.
  const boardPlans = blockPlans.filter((plan) => plan.board !== undefined);
  const segmentIds = new Set(design.instances.segments.map((segment) => segment.id));
  const landingAt = (
    joint: JointRecord,
    end: 'a' | 'b',
  ): { plan: BlockPlan; pad: FacePad } | undefined => {
    const ref = end === 'a' ? joint.a : joint.b;
    const other = end === 'a' ? joint.b : joint.a;
    const plan = planById.get(ref.instance);
    if (plan?.board === undefined) return undefined;
    const pad = choosePad(plan.board, ref.terminal, ref.pad, approachOf(plan, ref.terminal, other.instance, segmentIds));
    return pad === undefined ? undefined : { plan, pad };
  };
  const bandLandings = (band: BandPlan): TrackLanding[][] => {
    const ends: TrackLanding[][] = [[], []];
    for (const joint of topology.joints) {
      for (const [self, other, otherEnd] of [
        [joint.a, joint.b, 'b'],
        [joint.b, joint.a, 'a'],
      ] as const) {
        if (self.instance !== band.segmentId || self.end === undefined) continue;
        const key = terminalKey(self);
        const pigtail = pigtailTrackPaths.get(key);
        const paths =
          pigtail ?? [trackKeyOf(`${self.instance}:${self.terminal}`)];
        const landing = landingAt(joint, otherEnd);
        // a connector drawn as itself lands each wire on its pin's fixed row
        const otherRef = otherEnd === 'a' ? joint.a : joint.b;
        const artPlan = planById.get(otherRef.instance);
        const artRow = artPlan?.art?.rowY.get(otherRef.terminal);
        const y =
          artRow !== undefined
            ? artPlan!.y + artRow
            : landing === undefined
              ? undefined
              : landing.plan.y + padLocal(landing.plan.board!, landing.pad).y;
        const net = netOf.get(key);
        ends[self.end === 'a' ? 0 : 1]!.push({
          paths: paths.map((path) => path.slice(band.segmentId.length + 1)),
          ...(y === undefined ? {} : { y }),
          ...(pigtail === undefined ? {} : { pigtail: true }),
          ...(net === undefined ? {} : { net }),
        });
      }
    }
    return ends;
  };
  const unitsOf = (band: BandPlan): string[][] => {
    const units: string[][] = [];
    for (const track of band.tracks) {
      const last = units[units.length - 1];
      const previous = band.tracks.find((item) => item.elementPath === last?.[0]);
      if (
        last !== undefined &&
        track.groupId !== undefined &&
        previous?.groupId === track.groupId
      ) {
        last.push(track.elementPath);
      } else {
        units.push([track.elementPath]);
      }
    }
    return units;
  };
  const faceOrders: [BoardFaceSide, BoardFaceSide][] = [
    ['top', 'bottom'],
    ['bottom', 'top'],
  ];
  // at most four boards vary; any further ones keep the top face on top
  const varying = boardPlans.slice(0, 4);
  let bestCombo = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestOrders: number[][] = bandPlans.map((band) => band.tracks.map((_track, index) => index));
  for (let combo = 0; combo < 1 << varying.length; combo += 1) {
    varying.forEach((plan, index) => {
      plan.board!.order = faceOrders[(combo >> index) & 1]!;
    });
    let cost = 0;
    const orders: number[][] = [];
    for (const band of bandPlans) {
      const units = unitsOf(band);
      const result = optimiseTrackOrder(units, bandLandings(band));
      cost += result.cost;
      orders.push(result.order.flatMap((unit) => {
        const paths = units[unit] ?? [];
        return paths.map((path) => band.tracks.findIndex((track) => track.elementPath === path));
      }));
    }
    // flipping a board costs a hair: TOP stays on top unless it saves a crossing
    const flips = varying.filter((_plan, index) => ((combo >> index) & 1) === 1).length;
    const score = cost + flips * 0.01;
    if (score < bestCost - 1e-9) {
      bestCost = score;
      bestCombo = combo;
      bestOrders = orders;
    }
  }
  varying.forEach((plan, index) => {
    plan.board!.order = faceOrders[(bestCombo >> index) & 1]!;
  });
  bandPlans.forEach((band, index) => {
    const order = bestOrders[index] ?? [];
    const tracks = order.map((at) => band.tracks[at]).filter((track): track is TrackSpec => track !== undefined);
    if (tracks.length !== band.tracks.length) return;
    band.tracks = tracks;
    band.groups = regroup(band.groups, tracks);
  });
  setRanks();
  // abstract blocks' pin rows follow the tracks they now face
  for (const plan of blockPlans) {
    if (plan.depiction !== undefined || plan.dockedTo !== undefined) continue;
    const rebary = (ports: PortPlan[]): PortPlan[] =>
      orderPorts(
        ports.map((port) => {
          const bary = trackBarycenter(graph, port.key, rankOf);
          const { bary: _old, ...rest } = port;
          return bary === undefined ? rest : { ...rest, bary };
        }),
      );
    plan.cable = rebary(plan.cable);
    plan.integrated = rebary(plan.integrated);
  }

  /* --- 7 · materialise blocks + anchors ---------------------------- */

  const anchors: Record<string, Anchor> = {};
  /** `${jointIndex}:a|b` → the anchor that joint end lands on */
  const jointAnchor = new Map<string, string>();

  const materialise = (plan: BlockPlan): DiagramBlock => {
    const rect = { x: plan.x, y: plan.y, w: plan.width, h: plan.height };
    const ports: DiagramPort[] = [];
    const integratedSide: Side = plan.cableSide === 'right' ? 'left' : 'right';
    let depiction: DiagramDepiction | undefined;
    let internalLinks: DiagramInternalLink[] = [];

    const columnGeometry = (
      side: Side,
      idW: number,
      labelW: number,
    ): { x: number; idX: number; labelX: number; innerX: number; anchor: 'start' | 'end' } =>
      side === 'right'
        ? {
            x: rect.x + rect.w,
            idX: rect.x + rect.w - M.blockPad,
            labelX: rect.x + rect.w - M.blockPad - idW,
            innerX: rect.x + rect.w - M.blockPad - idW - labelW - 2,
            anchor: 'end',
          }
        : {
            x: rect.x,
            idX: rect.x + M.blockPad,
            labelX: rect.x + M.blockPad + idW,
            innerX: rect.x + M.blockPad + idW + labelW + 2,
            anchor: 'start',
          };

    const cableGeometry = columnGeometry(plan.cableSide, plan.cableIdW, plan.cableLabelW);
    const integratedGeometry = columnGeometry(
      integratedSide,
      plan.integratedIdW,
      plan.integratedLabelW,
    );

    const rowY = (index: number): number =>
      rect.y + plan.headerHeight + M.portPitch * (index + 0.5);

    const emit = (
      list: PortPlan[],
      geometry: ReturnType<typeof columnGeometry>,
      side: Side,
    ): void => {
      list.forEach((port, index) => {
        const y = rowY(index);
        const net = netOf.get(port.key);
        const diagramPort: DiagramPort = {
          key: port.key,
          terminal: port.displayId,
          label: port.label,
          column: port.column,
          side,
          x: geometry.x,
          y,
          innerX: geometry.innerX,
          idX: geometry.idX,
          labelX: geometry.labelX,
          textAnchor: geometry.anchor,
          ...(port.note === undefined ? {} : { note: port.note }),
          ...(net === undefined ? {} : { net }),
        };
        ports.push(diagramPort);
        anchors[port.key] = {
          key: port.key,
          x: diagramPort.x,
          y,
          dir: side === 'right' ? 1 : -1,
          owner: 'block',
          instance: plan.id,
        };
      });
    };

    let drawnArt: DiagramConnectorArt | undefined;
    if (plan.art !== undefined) {
      const drawn = materialiseArt(plan, plan.art, rect);
      ports.push(...drawn.ports);
      drawnArt = drawn.art;
    } else if (plan.board !== undefined) {
      const drawn = materialiseBoard(plan, rect);
      ports.push(...drawn.ports);
      internalLinks = drawn.links;
      depiction = drawn.depiction;
    } else if (plan.depiction === undefined) {
      if (plan.dockedTo !== undefined) {
        // a docked connector's rows follow the pads they land on, so the dock
        // corridor between it and its board is a clean fan
        const partnerY = (port: PortPlan): number | undefined => {
          for (const joint of topology.joints) {
            for (const [self, end] of [
              [joint.keyA, 'b'],
              [joint.keyB, 'a'],
            ] as const) {
              if (self !== port.key) continue;
              const anchor = anchors[jointAnchor.get(`${joint.index}:${end}`) ?? ''];
              if (anchor !== undefined && anchor.instance === plan.dockedTo) return anchor.y;
            }
          }
          return undefined;
        };
        plan.cable = [...plan.cable].sort((x, y) => {
          const px = partnerY(x) ?? Number.POSITIVE_INFINITY;
          const py = partnerY(y) ?? Number.POSITIVE_INFINITY;
          if (px !== py) return px - py;
          const bx = x.bary ?? Number.POSITIVE_INFINITY;
          const by = y.bary ?? Number.POSITIVE_INFINITY;
          return bx !== by ? bx - by : compareTerminalIds(x.terminal, y.terminal);
        });
      }
      emit(plan.cable, cableGeometry, plan.cableSide);
      emit(plan.integrated, integratedGeometry, integratedSide);
    } else {
      const drawn = materialiseSingleView(plan, rect);
      ports.push(...drawn.ports);
      depiction = drawn.depiction;
    }

    /* internal links of an abstract PCBA, drawn inside the outline */
    const definition = plan.kind === 'pcba' ? findPcba(db, plan.def) : undefined;
    if (definition !== undefined && plan.depiction !== undefined && plan.board === undefined) {
      internalLinks = singleViewLinks(plan, definition, ports);
    } else if (definition !== undefined && plan.depiction === undefined && plan.integrated.length > 0) {
      const byKey = new Map(ports.map((port) => [port.key, port]));
      const corridorLeft = Math.min(cableGeometry.innerX, integratedGeometry.innerX);
      const corridorRight = Math.max(cableGeometry.innerX, integratedGeometry.innerX);
      const count = definition.internalLinks.length;
      interface CorridorLinkPlan {
        padPort: DiagramPort;
        pinPort: DiagramPort;
        link: (typeof definition.internalLinks)[number];
        points: Point[];
        lines: string[];
        annotX: number;
        annotAnchor: 'start' | 'end';
        /** spreadAnnotations' own fields: `x` is the text box's *centre*, `y` its first line's baseline */
        x: number;
        y: number;
        halfWidth: number;
        height: number;
      }
      const corridorPlans: CorridorLinkPlan[] = [];
      definition.internalLinks.forEach((link, index) => {
        const fromPort = byKey.get(`${plan.id}:${link.from}`);
        const toPort = byKey.get(`${plan.id}:${link.to}`);
        if (fromPort === undefined || toPort === undefined) return;
        // `from`/`to` are authored in whichever direction reads best in the
        // catalog; the drawing needs them by column, not by declaration.
        const [padPort, pinPort] =
          fromPort.column === 'integrated' && toPort.column !== 'integrated'
            ? [toPort, fromPort]
            : [fromPort, toPort];
        const laneX =
          corridorLeft +
          ((corridorRight - corridorLeft) * (index + 1)) / (count + 1);
        const points: Point[] = [
          { x: padPort.innerX, y: padPort.y },
          { x: laneX, y: padPort.y },
          { x: laneX, y: pinPort.y },
          { x: pinPort.innerX, y: pinPort.y },
        ];
        const lines =
          link.via === undefined
            ? []
            : wrapText(link.via, M.fontAnnot, Math.max(16, plan.corridor - 9));
        const pinIsRight = integratedSide === 'right';
        // a pad-to-pad link (PCA-00104's S_S → S jumper) turns in the
        // corridor: its note rides beside that turn, clear of both pads' labels
        const padToPad = padPort.column !== 'integrated' && pinPort.column !== 'integrated';
        const towardPins = pinIsRight ? -1.6 : 1.6;
        const annotX = padToPad ? laneX + (pinIsRight ? 1.6 : -1.6) : pinPort.innerX + towardPins;
        const annotAnchor: 'start' | 'end' = padToPad
          ? pinIsRight
            ? 'start'
            : 'end'
          : pinIsRight
            ? 'end'
            : 'start';
        const y =
          (padToPad ? (padPort.y + pinPort.y) / 2 : pinPort.y) +
          M.fontAnnot * 0.35 -
          ((lines.length - 1) * M.fontAnnot * 1.15) / 2;
        const textWidth = maxTextWidth(lines, M.fontAnnot);
        corridorPlans.push({
          padPort,
          pinPort,
          link,
          points,
          lines,
          annotX,
          annotAnchor,
          x: annotAnchor === 'end' ? annotX - textWidth / 2 : annotX + textWidth / 2,
          y,
          halfWidth: textWidth / 2,
          height: annotationHeight(lines.length),
        });
      });
      // several links can fan to pins pitched closer together than a wrapped
      // `via` annotation is tall (three switch positions off one shared pin,
      //) — spread them the same way a depicted block's
      // `via` annotations are spread over its artwork, so a bigger type scale
      // never lets one caption print over another's.
      spreadAnnotations(corridorPlans);
      for (const item of corridorPlans) {
        const nets = linkNets(item.padPort.key, item.pinPort.key);
        internalLinks.push({
          from: item.padPort.key,
          to: item.pinPort.key,
          ...(item.link.via === undefined ? {} : { via: item.link.via }),
          points: item.points,
          annotation: item.lines,
          annotX: item.annotX,
          annotY: item.y,
          annotAnchor: item.annotAnchor,
          ...(nets.length === 0 ? {} : { nets }),
        });
      }
    }

    return {
      id: plan.id,
      kind: plan.kind,
      def: plan.def,
      title: plan.title,
      ...(plan.subtitle === undefined ? {} : { subtitle: plan.subtitle }),
      rect,
      headerHeight: plan.headerHeight,
      ...(plan.captions === undefined ? {} : { captions: plan.captions }),
      cableSide: plan.cableSide,
      ports,
      internalLinks,
      footnoteLines: plan.footnotes.flatMap((line) =>
        wrapText(line, M.fontFootnote, plan.width),
      ),
      zone: plan.zone,
      ...(depiction === undefined ? {} : { depiction }),
      ...(drawnArt === undefined ? {} : { connectorArt: drawnArt }),
      ...(plan.note === undefined ? {} : { note: plan.note }),
    };
  };

  /* --- 7c · a connector drawn as itself --------- */

  const materialiseArt = (
    plan: BlockPlan,
    drawing: ArtPlan,
    rect: Rect,
  ): { ports: DiagramPort[]; art: DiagramConnectorArt } => {
    const right = plan.cableSide === 'right';
    const edgeX = right ? rect.x + rect.w : rect.x;
    const idX = right ? edgeX - M.blockPad : edgeX + M.blockPad;
    const labelX = right ? idX - drawing.idW : idX + drawing.idW;
    const innerX = right ? labelX - drawing.labelW - 2 : labelX + drawing.labelW + 2;
    const artLeft = rect.x + drawing.artX;
    const artTop = rect.y + drawing.artY;
    const artEdgeX = right ? artLeft + drawing.artW : artLeft;
    const round = (value: number): number => Math.round(value * 100) / 100;
    const ports: DiagramPort[] = [];
    for (const port of plan.cable) {
      const lead = drawing.leads.get(port.terminal);
      const row = drawing.rowY.get(port.terminal);
      if (lead === undefined || row === undefined) continue;
      const pin = { x: round(artLeft + lead.x * drawing.scale), y: round(artTop + lead.y * drawing.scale) };
      const slot = { x: round(edgeX), y: round(rect.y + row) };
      const channel = round(artTop + lead.channel * drawing.scale);
      // a far-row pin reached from behind the field comes back onto it level
      const back = lead.behind === undefined ? undefined : round(artLeft + lead.behind * drawing.scale);
      const points = simplify([
        slot,
        { x: round(innerX), y: slot.y },
        { x: round(artEdgeX), y: channel },
        ...(back === undefined
          ? [{ x: pin.x, y: channel }]
          : [
              { x: back, y: channel },
              { x: back, y: pin.y },
            ]),
        pin,
      ]);
      const net = netOf.get(port.key);
      ports.push({
        key: port.key,
        terminal: port.displayId,
        label: port.label,
        column: 'cable',
        side: plan.cableSide,
        x: pin.x,
        y: pin.y,
        innerX: round(innerX),
        idX: round(idX),
        labelX: round(labelX),
        textAnchor: right ? 'end' : 'start',
        slot,
        lead: points.slice(1, -1),
        ...(port.note === undefined ? {} : { note: port.note }),
        ...(net === undefined ? {} : { net }),
      });
      anchors[port.key] = {
        key: port.key,
        x: slot.x,
        y: slot.y,
        dir: right ? 1 : -1,
        owner: 'block',
        instance: plan.id,
      };
    }
    const used = new Set(plan.cable.map((port) => port.terminal));
    const { art } = drawing;
    return {
      ports,
      art: {
        defId: art.defId,
        view: art.view,
        short: art.short,
        rect: { x: round(artLeft), y: round(artTop), w: round(drawing.artW), h: round(drawing.artH) },
        scale: drawing.scale,
        width: art.width,
        height: art.height,
        shapes: art.shapes,
        pins: art.pins.map((pin) => ({ ...pin, used: used.has(pin.terminal) })),
        labels: art.labels,
        caption: {
          text: art.view === 'profile' ? 'SIDE VIEW' : 'MATING FACE',
          x: round(artLeft + drawing.artW / 2),
          y: round(rect.y + drawing.captionY),
        },
        approximate: art.approximate,
      },
    };
  };

  /** the nets a link joins, deduplicated, in `from`, `to` order */
  const linkNets = (from: string, to: string): string[] => {
    const out: string[] = [];
    for (const key of [from, to]) {
      const net = netOf.get(key);
      if (net !== undefined && !out.includes(net)) out.push(net);
    }
    return out;
  };

  /* --- 7a · a single-view depiction (the pre-e5c.24 depicted block) --- */

  const materialiseSingleView = (
    plan: BlockPlan,
    rect: Rect,
  ): { ports: DiagramPort[]; depiction: DiagramDepiction } => {
    /* --- depicted: ports land on the artwork's real pad positions ---- *
     *
     * Anchor coordinates are artwork units with +y **down**, the same sense
     * as the page, so the map into the block's frame is a scale and a
     * translate — no flip. The pin text moves to a gutter on the side away
     * from the cable, tied back to its pad by a leader, so the artwork never
     * has to carry a label the drawing needs.
     */
    const art = plan.depiction!;
    const ports: DiagramPort[] = [];
    const artX =
      plan.cableSide === 'right'
        ? rect.x + rect.w - M.blockPad - plan.artWidth
        : rect.x + M.blockPad;
    const bodyTop = rect.y + plan.headerHeight + M.depictionPad;
    const bodyHeight = rect.h - plan.headerHeight - 2 * M.depictionPad;
    const artY = bodyTop + (bodyHeight - plan.artHeight) / 2;
    const gutterX =
      plan.cableSide === 'right'
        ? artX - M.calloutGap
        : artX + plan.artWidth + M.calloutGap;
    const calloutAnchor: 'start' | 'end' = plan.cableSide === 'right' ? 'end' : 'start';
    const leaderX =
      gutterX + (plan.cableSide === 'right' ? M.calloutLeaderGap : -M.calloutLeaderGap);
    const dir: -1 | 1 = plan.cableSide === 'right' ? 1 : -1;

    interface PlacedPort {
      port: PortPlan;
      x: number;
      y: number;
      labelY: number;
    }
    const placed: PlacedPort[] = [];
    for (const port of [...plan.cable, ...plan.integrated]) {
      const anchor = art.anchors[port.terminal];
      if (anchor === undefined) continue;
      placed.push({
        port,
        x: artX + anchor.x * plan.artScale,
        y: artY + anchor.y * plan.artScale,
        labelY: 0,
      });
    }
    placed.sort((x, y) =>
      x.y === y.y ? compareTerminalIds(x.port.terminal, y.port.terminal) : x.y - y.y,
    );

    // callouts want to sit level with their pad, but never on top of each
    // other: one pass down for the pitch, one back up for the bottom edge.
    let cursor = bodyTop + M.calloutPitch / 2;
    for (const item of placed) {
      item.labelY = Math.max(cursor, item.y);
      cursor = item.labelY + M.calloutPitch;
    }
    let floor = bodyTop + bodyHeight;
    for (let index = placed.length - 1; index >= 0; index -= 1) {
      const item = placed[index];
      if (item === undefined) continue;
      item.labelY = Math.min(item.labelY, floor);
      floor = item.labelY - M.calloutPitch;
    }

    for (const item of placed) {
      const net = netOf.get(item.port.key);
      const diagramPort: DiagramPort = {
        key: item.port.key,
        terminal: item.port.displayId,
        label: item.port.label,
        column: item.port.column,
        side: plan.cableSide,
        x: item.x,
        y: item.y,
        innerX: item.x,
        idX: gutterX,
        labelX: gutterX,
        textAnchor: calloutAnchor,
        callout: {
          text: calloutText(item.port),
          x: gutterX,
          y: item.labelY + M.fontCallout * 0.35,
          anchor: calloutAnchor,
          leader: [
            { x: leaderX, y: item.labelY },
            { x: item.x, y: item.y },
          ],
        },
        ...(item.port.note === undefined ? {} : { note: item.port.note }),
        ...(net === undefined ? {} : { net }),
      };
      ports.push(diagramPort);
      anchors[item.port.key] = {
        key: item.port.key,
        x: item.x,
        y: item.y,
        dir,
        owner: 'block',
        instance: plan.id,
      };
    }

    return {
      ports,
      depiction: {
        defId: art.defId,
        view: art.view,
        kind: art.kind,
        rect: { x: artX, y: artY, w: plan.artWidth, h: plan.artHeight },
        scale: plan.artScale,
        widthUnits: art.widthUnits,
        heightUnits: art.heightUnits,
        ...(art.parts.length === 0 ? {} : { parts: art.parts }),
      },
    };
  };

  /** On single-view artwork an internal link is the copper it stands for: pad to pin. */
  const singleViewLinks = (
    plan: BlockPlan,
    definition: NonNullable<ReturnType<typeof findPcba>>,
    ports: DiagramPort[],
  ): DiagramInternalLink[] => {
    const byKey = new Map(ports.map((port) => [port.key, port]));
    interface LinkPlan {
      link: (typeof definition.internalLinks)[number];
      padPort: DiagramPort;
      pinPort: DiagramPort;
      lines: string[];
      x: number;
      /** baseline of the first line */
      y: number;
      halfWidth: number;
      height: number;
    }
    const linkPlans: LinkPlan[] = [];
    for (const link of definition.internalLinks) {
      const fromPort = byKey.get(`${plan.id}:${link.from}`);
      const toPort = byKey.get(`${plan.id}:${link.to}`);
      if (fromPort === undefined || toPort === undefined) continue;
      const [padPort, pinPort] =
        fromPort.column === 'integrated' && toPort.column !== 'integrated'
          ? [toPort, fromPort]
          : [fromPort, toPort];
      const lines =
        link.via === undefined
          ? []
          : wrapText(link.via, M.fontAnnot, Math.max(16, plan.artWidth * 0.8));
      linkPlans.push({
        link,
        padPort,
        pinPort,
        lines,
        x: (padPort.x + pinPort.x) / 2,
        y: (padPort.y + pinPort.y) / 2 - 1 - (lines.length - 1) * M.fontAnnot * 1.15,
        halfWidth: maxTextWidth(lines, M.fontAnnot) / 2,
        height: annotationHeight(lines.length),
      });
    }
    spreadAnnotations(linkPlans);
    return linkPlans.map((item) => {
      const nets = linkNets(item.padPort.key, item.pinPort.key);
      return {
        from: item.padPort.key,
        to: item.pinPort.key,
        ...(item.link.via === undefined ? {} : { via: item.link.via }),
        points: [
          { x: item.padPort.x, y: item.padPort.y },
          { x: item.pinPort.x, y: item.pinPort.y },
        ],
        annotation: item.lines,
        annotX: item.x,
        annotY: item.y,
        annotAnchor: 'middle' as const,
        ...(nets.length === 0 ? {} : { nets }),
      };
    });
  };

  /* --- 7b · a two-faced board ------------------ */

  const materialiseBoard = (
    plan: BlockPlan,
    rect: Rect,
  ): { ports: DiagramPort[]; links: DiagramInternalLink[]; depiction: DiagramDepiction } => {
    const geom = plan.board!;
    const ports: DiagramPort[] = [];
    const portPlanOf = new Map([...plan.cable, ...plan.integrated].map((port) => [port.terminal, port]));
    const registered = new Map<string, { port: DiagramPort; anchorKey: string }>();
    const padsUsed = new Map<string, number>();
    const multiPad = (terminal: string): boolean => (geom.source.pads[terminal]?.length ?? 0) > 1;
    const far: Side = plan.cableSide === 'right' ? 'left' : 'right';
    const page = (pad: FacePad): Point => {
      const local = padLocal(geom, pad);
      return { x: rect.x + local.x, y: rect.y + local.y };
    };

    /** one port + anchor per physical pad drawn; the first pad of a terminal keeps the plain key */
    const register = (pad: FacePad, approach?: 'cable' | 'connector'): string => {
      const id = `${pad.terminal}|${pad.side}|${pad.index}`;
      const existing = registered.get(id);
      const wantFacing: Side | undefined =
        approach === undefined ? undefined : approach === 'connector' ? far : plan.cableSide;
      if (existing !== undefined) {
        if (wantFacing === undefined || wantFacing === existing.port.side) return existing.anchorKey;
        // one pad, wired from both edges (a connector pin's pad the +5 V
        // bodge also lands on): a second anchor on it, facing the other way
        const altKey = `${existing.anchorKey}>${wantFacing}`;
        const base = anchors[existing.anchorKey]!;
        anchors[altKey] = { ...base, dir: wantFacing === 'right' ? 1 : -1 };
        return altKey;
      }
      const key = `${plan.id}:${pad.terminal}`;
      const count = padsUsed.get(pad.terminal) ?? 0;
      padsUsed.set(pad.terminal, count + 1);
      const anchorKey = count === 0 ? key : `${key}~${pad.ref ?? `${pad.side}.${pad.index}`}`;
      const at = page(pad);
      const connectorSide = isConnectorSideTerminal(pad.terminal);
      // a pad faces the edge its wire comes in over: a GND pad the mounted
      // connector's shell lands on faces the connector, not the cable
      const facing: Side =
        (approach ?? (connectorSide ? 'connector' : 'cable')) === 'connector' ? far : plan.cableSide;
      const portPlan = portPlanOf.get(pad.terminal);
      const net = netOf.get(key);
      //: a pad whose row sits at a real angle to the
      // board edge draws its wire's final approach along that axis instead
      // of square to the block outline — but only when it actually reads as
      // angled from this port's own facing (`isNaturalApproach`), the same
      // gate the canvas board node uses, so a "straight-in" board's landing
      // is untouched.
      //: a pad on a guided row is reached at its slot on
      // the row's entry guide, off the board — the route's own anchor sits
      // there, and render-svg adds the one straight lead in to the pad
      const slotAt =
        pad.slot === undefined || facing !== plan.cableSide ? undefined : page({ ...pad, x: pad.slot.x, y: pad.slot.y });
      const wireApproach =
        slotAt !== undefined || pad.approach === undefined || isNaturalApproach(pad.approach, facing)
          ? undefined
          : pad.approach;
      const port: DiagramPort = {
        key,
        terminal: portPlan?.displayId ?? pad.terminal,
        label: portPlan?.label ?? '',
        column: portPlan?.column ?? (connectorSide ? 'integrated' : 'cable'),
        side: facing,
        x: at.x,
        y: at.y,
        innerX: at.x,
        idX: at.x,
        labelX: at.x,
        textAnchor: 'start',
        face: pad.side,
        ...(pad.ref === undefined ? {} : { pad: pad.ref }),
        ...(portPlan?.note === undefined ? {} : { note: portPlan.note }),
        ...(net === undefined ? {} : { net }),
        ...(wireApproach === undefined ? {} : { approach: wireApproach }),
        ...(slotAt === undefined ? {} : { slot: slotAt }),
      };
      ports.push(port);
      anchors[anchorKey] = {
        key,
        x: (slotAt ?? at).x,
        y: (slotAt ?? at).y,
        dir: facing === 'right' ? 1 : -1,
        owner: 'block',
        instance: plan.id,
        ...(pad.ref === undefined ? {} : { pad: pad.ref }),
      };
      registered.set(id, { port, anchorKey });
      return anchorKey;
    };

    // every joint end on this board, on the pad it is soldered to — a docked
    // carrier's joints to the board it docks beside first, so a slot pad the
    // plug also lands on (jp.R, e5c.36) is named on that side
    const wired = new Set<string>();
    const beside = (joint: JointRecord): boolean =>
      plan.dockedTo !== undefined && (joint.a.instance === plan.dockedTo || joint.b.instance === plan.dockedTo);
    const ordered = [...topology.joints.filter(beside), ...topology.joints.filter((joint) => !beside(joint))];
    // a pad landed through the carrier hole above it (e5c.37) is named on the
    // carrier's side, where its solder point is, before any wire lands on it
    for (const [key] of landedThrough) {
      const ref = parseTerminalKey(key);
      if (ref.instance !== plan.id) continue;
      const pad = geom.pads.find((candidate) => candidate.terminal === ref.terminal);
      if (pad !== undefined) register(pad, 'connector');
    }
    for (const joint of ordered) {
      for (const end of ['a', 'b'] as const) {
        const landing = landingAt(joint, end);
        if (landing === undefined || landing.plan !== plan) continue;
        const ref = end === 'a' ? joint.a : joint.b;
        const other = end === 'a' ? joint.b : joint.a;
        const anchorKey = register(landing.pad, approachOf(plan, ref.terminal, other.instance, segmentIds));
        jointAnchor.set(`${joint.index}:${end}`, anchorKey);
        wired.add(anchorKey);
      }
    }

    // internal links: on the face their part (or their pin) is on
    const definition = findPcba(db, plan.def);
    const partsBySide = {
      top: geom.faces.top.parts,
      bottom: geom.faces.bottom.parts,
    };
    const boxOf = (side: BoardFaceSide): Rect => {
      const local = faceBox(geom, side);
      return { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h };
    };
    const partPoint = (side: BoardFaceSide, part: BoardPart): Point => {
      const box = boxOf(side);
      return { x: box.x + part.x * geom.scale, y: box.y + part.y * geom.scale };
    };
    const partNets: Record<string, string[]> = {};
    interface LinkDraft {
      link: NonNullable<typeof definition>['internalLinks'][number];
      from: string;
      to: string;
      face: BoardFaceSide;
      points: Point[];
      ghosts: Point[];
      parts: string[];
      lines: string[];
      x: number;
      y: number;
      halfWidth: number;
      height: number;
    }
    const drafts: LinkDraft[] = [];
    for (const link of definition?.internalLinks ?? []) {
      const [padT, pinT] =
        isConnectorSideTerminal(link.from) && !isConnectorSideTerminal(link.to)
          ? [link.to, link.from]
          : [link.from, link.to];
      if (geom.source.pads[padT] === undefined || geom.source.pads[pinT] === undefined) continue;
      if (!portPlanOf.has(padT) || !portPlanOf.has(pinT)) continue;
      // the parts the `via` names, in the order it names them — matched as
      // whole tokens against the build's own reference designators, so the
      // prose around them never matters
      const tokens = linkDesignators(link);
      const named: { side: BoardFaceSide; part: BoardPart }[] = [];
      for (const token of tokens) {
        for (const side of ['top', 'bottom'] as const) {
          const part = partsBySide[side].find((candidate) => candidate.ref === token);
          if (part !== undefined && !named.some((item) => item.part.ref === part.ref)) {
            named.push({ side, part });
          }
        }
      }
      const facesOf = (terminal: string): BoardFaceSide[] =>
        geom.order.filter((side) => geom.pads.some((pad) => pad.terminal === terminal && pad.side === side));
      const common = facesOf(padT).filter((side) => facesOf(pinT).includes(side));
      const face: BoardFaceSide =
        named[0]?.side ?? common[0] ?? facesOf(pinT)[0] ?? facesOf(padT)[0] ?? geom.order[0];
      const ghosts: Point[] = [];
      const endpoint = (terminal: string, toward: Point | undefined): Point => {
        const onFace = geom.pads.filter((pad) => pad.terminal === terminal && pad.side === face);
        if (onFace.length > 0) {
          const best = [...onFace].sort((a, b) => {
            if (toward === undefined) return a.index - b.index;
            const pa = page(a);
            const pb = page(b);
            const da = Math.hypot(pa.x - toward.x, pa.y - toward.y);
            const dbb = Math.hypot(pb.x - toward.x, pb.y - toward.y);
            return da === dbb ? a.index - b.index : da - dbb;
          })[0]!;
          register(best);
          return page(best);
        }
        // the pad is on the other face: the link reaches the spot it sits
        // behind, marked as such, and the pad itself is drawn where it is
        const primary = geom.pads.find((pad) => pad.terminal === terminal);
        if (primary !== undefined) register(primary);
        const source = geom.source.pads[terminal]?.[0];
        const box = boxOf(face);
        const turned = source === undefined ? { x: 0, y: 0 } : facePoint(source, face, geom.source, geom.faces[face]);
        const point = { x: box.x + turned.x * geom.scale, y: box.y + turned.y * geom.scale };
        ghosts.push(point);
        return point;
      };
      const through = named.filter((item) => item.side === face).map((item) => partPoint(face, item.part));
      const pinAt = endpoint(pinT, through[through.length - 1]);
      const padAt = endpoint(padT, through[0] ?? pinAt);
      const points = [padAt, ...through, pinAt];
      const nets = linkNets(`${plan.id}:${padT}`, `${plan.id}:${pinT}`);
      for (const item of named) {
        const list = partNets[item.part.ref] ?? [];
        for (const net of nets) if (!list.includes(net)) list.push(net);
        partNets[item.part.ref] = list;
      }
      // a `via` whose part the board draws is said by the part itself (its
      // label and body); only one that names nothing drawn prints as text
      const lines =
        link.via === undefined || named.length > 0
          ? []
          : wrapText(link.via, M.fontAnnot, Math.max(16, geom.artW * 0.8));
      const mid = points[Math.floor((points.length - 1) / 2)]!;
      const next = points[Math.floor((points.length - 1) / 2) + 1] ?? mid;
      drafts.push({
        link,
        from: `${plan.id}:${padT}`,
        to: `${plan.id}:${pinT}`,
        face,
        points,
        ghosts,
        parts: named.map((item) => item.part.ref),
        lines,
        x: (mid.x + next.x) / 2,
        y: (mid.y + next.y) / 2 - 1 - (lines.length - 1) * M.fontAnnot * 1.15,
        halfWidth: maxTextWidth(lines, M.fontAnnot) / 2,
        height: annotationHeight(lines.length),
      });
    }
    spreadAnnotations(drafts);
    const links: DiagramInternalLink[] = drafts.map((draft) => {
      const nets = linkNets(draft.from, draft.to);
      return {
        from: draft.from,
        to: draft.to,
        ...(draft.link.via === undefined ? {} : { via: draft.link.via }),
        points: draft.points,
        annotation: draft.lines,
        annotX: draft.x,
        annotY: draft.y,
        annotAnchor: 'middle' as const,
        ...(nets.length === 0 ? {} : { nets }),
        ...(draft.parts.length === 0 ? {} : { parts: draft.parts }),
        face: draft.face,
        ...(draft.ghosts.length === 0 ? {} : { ghosts: draft.ghosts }),
      };
    });

    // anything shown that neither a joint nor a link placed: its primary pad
    for (const port of [...plan.cable, ...plan.integrated]) {
      if (padsUsed.has(port.terminal)) continue;
      const primary = geom.pads.find((pad) => pad.terminal === port.terminal);
      if (primary !== undefined) register(primary);
    }

    /* pad names: in the gutter on the cable side, just over their wire */
    const cableX =
      plan.cableSide === 'right'
        ? rect.x + geom.artX + geom.artW + M.padLabelGap
        : rect.x + geom.artX - M.padLabelGap;
    const cableAnchor: 'start' | 'end' = plan.cableSide === 'right' ? 'start' : 'end';
    const cablePorts = ports
      .filter((port) => port.side === plan.cableSide)
      .sort((x, y) => (x.y === y.y ? compareTerminalIds(x.terminal, y.terminal) : x.y - y.y));
    const texts = cablePorts.map((port) =>
      padLabelText(port.terminal, port.pad, multiPad(parseTerminalKey(port.key).terminal)),
    );
    const columnWidth = maxTextWidth(texts, M.fontPadLabel, 'bold') + M.padLabelGap;
    const columnOf = labelColumns(cablePorts.map((port) => port.y));
    const anchorKeyOfPort = new Map<DiagramPort, string>();
    for (const { port, anchorKey } of registered.values()) anchorKeyOfPort.set(port, anchorKey);
    cablePorts.forEach((port, index) => {
      const step = (columnOf[index] ?? 0) * columnWidth;
      // a pad no wire lands on (a board link's end) is tied to its name by a
      // leader along the row its wire would take
      const edgeX = plan.cableSide === 'right' ? rect.x + geom.artX + geom.artW : rect.x + geom.artX;
      const leader = wired.has(anchorKeyOfPort.get(port) ?? '')
        ? []
        : [
            { x: edgeX, y: port.y },
            { x: port.x, y: port.y },
          ];
      port.callout = {
        text: texts[index]!,
        x: cableX + (plan.cableSide === 'right' ? step : -step),
        y: port.y - M.padLabelLift,
        anchor: cableAnchor,
        leader,
        kind: 'pad',
      };
    });

    /* connector-side pins nobody docked prints: callouts in the far gutter */
    const farX =
      plan.cableSide === 'right'
        ? rect.x + geom.artX - M.calloutGap
        : rect.x + geom.artX + geom.artW + M.calloutGap;
    const farAnchor: 'start' | 'end' = plan.cableSide === 'right' ? 'end' : 'start';
    const leaderX = farX + (plan.cableSide === 'right' ? M.calloutLeaderGap : -M.calloutLeaderGap);
    const farPorts = ports
      .filter((port) => {
        const terminal = parseTerminalKey(port.key).terminal;
        return port.side !== plan.cableSide && !geom.dockJoined.has(terminal);
      })
      .sort((x, y) => (x.y === y.y ? compareTerminalIds(x.terminal, y.terminal) : x.y - y.y));
    const bodyTop = rect.y + geom.bodyTop;
    const bodyBottom = rect.y + rect.h - M.depictionPad;
    const labelYs = farPorts.map((port) => port.y);
    let cursor = bodyTop + M.calloutPitch / 2;
    for (let index = 0; index < labelYs.length; index += 1) {
      labelYs[index] = Math.max(cursor, labelYs[index]!);
      cursor = labelYs[index]! + M.calloutPitch;
    }
    let ceiling = bodyBottom;
    for (let index = labelYs.length - 1; index >= 0; index -= 1) {
      labelYs[index] = Math.min(labelYs[index]!, ceiling);
      ceiling = labelYs[index]! - M.calloutPitch;
    }
    farPorts.forEach((port, index) => {
      const portPlan = portPlanOf.get(parseTerminalKey(port.key).terminal);
      const labelY = labelYs[index]!;
      port.callout = {
        text: portPlan === undefined ? port.terminal : calloutText(portPlan),
        x: farX,
        y: labelY + M.fontCallout * 0.35,
        anchor: farAnchor,
        leader: [
          { x: leaderX, y: labelY },
          { x: port.x, y: port.y },
        ],
      };
    });

    const faces: DiagramBoardFace[] = geom.order.map((side) => {
      const box = boxOf(side);
      const face = geom.faces[side];
      return {
        side,
        view: face.view,
        rect: box,
        rotation: face.rotation,
        frame: geom.source.frame,
        scale: geom.scale,
        caption: {
          text: side === 'top' ? 'TOP' : 'BOTTOM',
          x: plan.cableSide === 'right' ? box.x : box.x + box.w,
          y: box.y - 1.1,
          anchor: plan.cableSide === 'right' ? 'start' : 'end',
        },
        ...(face.parts.length === 0 ? {} : { parts: face.parts }),
      };
    });

    const art = plan.depiction!;
    return {
      ports,
      links,
      depiction: {
        defId: art.defId,
        view: art.view,
        kind: art.kind,
        rect: {
          x: rect.x + geom.artX,
          y: rect.y + geom.bodyTop,
          w: geom.artW,
          h: plan.artHeight,
        },
        scale: geom.scale,
        widthUnits: art.widthUnits,
        heightUnits: art.heightUnits,
        faces,
        ...(Object.keys(partNets).length === 0 ? {} : { partNets }),
      },
    };
  };

  // boards first: a docked connector orders its rows by the pads they land on
  const materialised = new Map<string, DiagramBlock>();
  for (const plan of blockPlans) {
    if (plan.board !== undefined) materialised.set(plan.id, materialise(plan));
  }
  for (const plan of blockPlans) {
    if (plan.board === undefined) materialised.set(plan.id, materialise(plan));
  }
  const blocks: DiagramBlock[] = blockPlans
    .map((plan) => materialised.get(plan.id))
    .filter((block): block is DiagramBlock => block !== undefined);

  /* --- 8 · materialise bands + track anchors ----------------------- */

  // what becomes of each conductor at a breakout mould
  const fates = breakoutFates(design, db);

  const bands: DiagramBand[] = [];
  for (const plan of bandPlans) {
    const rect = { x: plan.x, y: plan.y, w: plan.width, h: plan.height };
    const segment = design.instances.segments.find((item) => item.id === plan.segmentId);
    const wire = segment === undefined ? undefined : findWire(db, segment.def);
    const tracks: DiagramTrack[] = [];
    plan.tracks.forEach((spec, index) => {
      const y = rect.y + M.bandPadY + index * M.trackPitch;
      const key = `${plan.segmentId}:${spec.elementPath}`;
      const leftIsA = plan.leftEnd === 'a';
      const makeEnd = (end: 'a' | 'b') => {
        const atLeft = (end === 'a') === leftIsA;
        const endKey = `${key}@${end}`;
        const connected = topology.usedTerminals.has(endKey) || pigtailedEnds.has(endKey) || fates.get(endKey)?.fate === 'through';
        const noteRef = connected ? undefined : noteRefForTerminal(design, endKey);
        return {
          key: endKey,
          end,
          x: atLeft ? rect.x : rect.x + rect.w,
          y,
          dir: (atLeft ? -1 : 1) as -1 | 1,
          connected,
          ...(noteRef === undefined ? {} : { noteRef }),
        };
      };
      const a = makeEnd('a');
      const b = makeEnd('b');
      const net = netOf.get(a.key) ?? netOf.get(b.key);
      tracks.push({
        key,
        segment: plan.segmentId,
        elementPath: spec.elementPath,
        kind: spec.kind,
        role: spec.role,
        ...(spec.colorName === undefined ? {} : { colorName: spec.colorName }),
        bare: spec.bare,
        label: spec.label,
        y,
        x1: rect.x,
        x2: rect.x + rect.w,
        ...(spec.groupId === undefined ? {} : { groupId: spec.groupId }),
        a,
        b,
        ...(net === undefined ? {} : { net }),
      });
      for (const end of [a, b]) {
        anchors[end.key] = {
          key: end.key,
          x: end.x,
          y: end.y,
          dir: end.dir,
          owner: 'track',
          instance: plan.segmentId,
        };
      }
    });

    //: a bonded screen folded out of the band (no track
    // of its own — `bandTrackSpecs`) still resolves a joint keyed to it
    // directly: it shares its set's representative's anchor, so that edge
    // still routes — "the drain stands for the bonded mass" visually too.
    for (const set of wire?.bonded ?? []) {
      const rep = bondedRepresentative(wire!, set);
      for (const end of ['a', 'b'] as const) {
        const repAnchor = anchors[`${plan.segmentId}:${rep}@${end}`];
        if (repAnchor === undefined) continue;
        for (const member of set.members) {
          if (member === rep) continue;
          anchors[`${plan.segmentId}:${member}@${end}`] = repAnchor;
        }
      }
    }

    const groups: DiagramTrackGroup[] = plan.groups.map((group) => {
      const y1 = rect.y + M.bandPadY + group.first * M.trackPitch;
      const y2 = rect.y + M.bandPadY + group.last * M.trackPitch;
      return {
        id: group.id,
        label: group.label,
        role: group.role,
        x: rect.x + M.bracketX,
        y1,
        y2,
        labelX: rect.x + plan.groupLabelOffset,
        // a group folded down to one track (a bonded core: its screen joined
        // the mass) labels above its line, like a track, not across it
        labelY: y1 === y2 ? y1 - 1.3 : (y1 + y2) / 2 + M.fontGroup * 0.35,
      };
    });

    // pigtails: a bracket gathering the member ends, one lead out to the
    // anchor. Brackets whose spans do not overlap share a slot, so an end
    // with a pigtail per board face draws two short brackets side by side
    // in the same column rather than one nested inside the other.
    const pigtails: DiagramPigtail[] = [];
    const slots: Record<'a' | 'b', { y1: number; y2: number }[][]> = { a: [], b: [] };
    for (const pigtail of wire === undefined ? [] : (segment?.pigtails ?? [])) {
      const memberKeys = pigtailTrackPaths.get(pigtailKey(plan.segmentId, pigtail)) ?? [];
      const memberTracks = tracks.filter((track) => memberKeys.includes(track.key));
      if (memberTracks.length === 0) continue;
      const atLeft = (pigtail.end === 'a') === (plan.leftEnd === 'a');
      const dir: -1 | 1 = atLeft ? -1 : 1;
      const edgeX = atLeft ? rect.x : rect.x + rect.w;
      const ys = memberTracks.map((track) => track.y);
      const y1 = Math.min(...ys);
      const y2 = Math.max(...ys);
      const endSlots = slots[pigtail.end];
      let slot = endSlots.findIndex((taken) =>
        taken.every((span) => y2 < span.y1 - 1 || y1 > span.y2 + 1),
      );
      if (slot === -1) {
        slot = endSlots.length;
        endSlots.push([]);
      }
      endSlots[slot]!.push({ y1, y2 });
      const x = edgeX + dir * (M.pigtailBracketGap + slot * M.pigtailSlotPitch);
      // the lead leaves on a member's own line, the one nearest the middle
      const middle = (y1 + y2) / 2;
      const anchorY = ys.reduce((best, y) => (Math.abs(y - middle) < Math.abs(best - middle) ? y : best), ys[0] ?? middle);
      const key = pigtailKey(plan.segmentId, pigtail);
      const anchor = { x: x + dir * M.pigtailLead, y: anchorY };
      const net = netOf.get(key);
      pigtails.push({
        key,
        segment: plan.segmentId,
        id: pigtail.id,
        end: pigtail.end,
        members: memberTracks.map((track) => track.key),
        edgeX,
        x,
        y1,
        y2,
        memberYs: ys,
        anchor,
        dir,
        ...(pigtail.note === undefined ? {} : { note: pigtail.note }),
        ...(net === undefined ? {} : { net }),
      });
      anchors[key] = { key, x: anchor.x, y: anchor.y, dir, owner: 'track', instance: plan.segmentId };
    }

    bands.push({
      segment: plan.segmentId,
      def: plan.def,
      label: plan.label,
      ...(plan.fullLabel === plan.label ? {} : { fullLabel: plan.fullLabel }),
      ...(plan.role === undefined ? {} : { role: plan.role }),
      rect,
      labelX: rect.x,
      labelY: rect.y - 2,
      trackLabelX: rect.x + plan.trackLabelOffset,
      tracks,
      groups,
      pigtails,
      leftEnd: plan.leftEnd,
      zone: plan.zone,
    });
  }

  /* --- 8b · the trunk's destination mould ---------------------------- */

  const breakouts: DiagramBreakout[] = [];
  const trunkDrawn = bands.find((band) => band.segment === topology.trunkId);
  if (mould !== undefined && trunkDrawn !== undefined) {
    const atRight = trunkDrawn.leftEnd === 'a';
    const edgeX = atRight ? trunkDrawn.rect.x + trunkDrawn.rect.w : trunkDrawn.rect.x;
    const dir: -1 | 1 = atRight ? 1 : -1;
    const x0 = edgeX - dir * M.breakoutInset;
    const x1 = edgeX + dir * mouldWidth;
    const rect = { x: Math.min(x0, x1), y: trunkDrawn.rect.y - M.breakoutInset, w: Math.abs(x1 - x0), h: trunkDrawn.rect.h + 2 * M.breakoutInset };
    const outer = atRight ? rect.x + rect.w : rect.x;
    const rows: DiagramBreakoutRow[] = [];
    const throughs: DiagramThrough[] = [];
    let lane = 0;
    for (const track of trunkDrawn.tracks) {
      const key = `${track.key}@b`;
      const fate = fates.get(key);
      const row: DiagramBreakoutRow = {
        key,
        y: track.y,
        fate: fate?.fate ?? 'nc',
        role: track.role,
        ...(track.colorName === undefined ? {} : { colorName: track.colorName }),
        bare: track.bare,
        ...(fate?.reason === undefined ? {} : { reason: fate.reason }),
        ...(track.net === undefined ? {} : { net: track.net }),
      };
      rows.push(row);
      if (fate?.fate !== 'through' || fate.peer === undefined) continue;
      const to = `${fate.peer.instance}:${fate.peer.terminal}@${fate.peer.end ?? 'a'}`;
      const target = anchors[to];
      if (target === undefined) continue;
      const laneX = outer + dir * (M.stub + lane * M.lanePitchMin);
      lane += 1;
      throughs.push({
        from: key,
        to,
        points: simplify([
          { x: outer, y: track.y },
          { x: laneX, y: track.y },
          { x: laneX, y: target.y },
          { x: target.x, y: target.y },
        ]),
        role: track.role,
        ...(track.colorName === undefined ? {} : { colorName: track.colorName }),
        bare: track.bare,
        ...(track.net === undefined ? {} : { net: track.net }),
      });
    }
    // a leg's own conductors cut back in the mould (the Y-audio branch's spare core)
    for (const band of bands) {
      const leg = mould.legs.find((l) => l.segment === band.segment);
      if (leg === undefined) continue;
      for (const track of band.tracks) {
        const end = leg.end === 'a' ? track.a : track.b;
        const fate = fates.get(end.key);
        if (fate?.fate !== 'nc') continue;
        rows.push({
          key: end.key,
          y: end.y,
          x: end.x,
          dir: end.dir,
          fate: 'nc',
          role: track.role,
          ...(track.colorName === undefined ? {} : { colorName: track.colorName }),
          bare: track.bare,
          ...(fate.reason === undefined ? {} : { reason: fate.reason }),
        });
      }
    }
    // connectors this mould houses ( — the owner,
    // 2026-09-29: "the female TRS is female and inside the breakout"): drawn
    // as themselves, stacked under the rows, their own outline growing the
    // mould's rather than sitting outside it on a lead
    const jacks: DiagramMouldJack[] = [];
    const round = (value: number): number => Math.round(value * 100) / 100;
    let jackBottom = rect.y + rect.h;
    for (const id of mould.housed ?? []) {
      const instance = design.instances.connectors.find((c) => c.id === id);
      const definition = instance === undefined ? undefined : findConnector(db, instance.def);
      const label = definition?.label ?? instance?.def ?? id;
      const body =
        definition?.body === undefined ? undefined : (db.bodies ?? []).find((item) => item.id === definition.body);
      // no artwork of its own with depictions off (the abstract page stays
      // the abstract page): the housed jack still lists its landings in
      // words, it just draws no shapes (matches every other connector, above)
      const art =
        definition === undefined || depictionSource === undefined
          ? undefined
          : connectorArt({ def: definition, facing: dir === 1 ? 'right' : 'left', ...(body === undefined ? {} : { body }) });
      if (art === undefined) {
        jacks.push({ instanceId: id, label, leads: [] });
        continue;
      }
      const scale = M.artProfileScale;
      const artW = art.width * scale;
      const artH = art.height * scale;
      const artTop = jackBottom + M.breakoutInset;
      const artLeft = rect.x + (rect.w - artW) / 2;
      const used = new Set(
        design.joints
          .flatMap((joint) => [joint.a, joint.b])
          .filter((ref) => ref.instance === id)
          .map((ref) => ref.terminal),
      );
      const pinAt = new Map(art.pins.map((pin) => [pin.terminal, { x: artLeft + pin.x * scale, y: artTop + pin.y * scale }]));
      // every trunk terminal (or pigtail) landing on this jack: a short stub,
      // entirely inside the mould, from its already-placed anchor to the pin —
      // each on its own lane (the same fan the through runs above use, and the
      // same counter, so two different signals never share one line, nck.13)
      const leads: DiagramMouldJack['leads'] = [];
      for (const joint of design.joints) {
        for (const [mine, other] of [
          [joint.a, joint.b],
          [joint.b, joint.a],
        ] as const) {
          if (mine.instance !== id) continue;
          const otherKey = terminalKey(other);
          const start = anchors[otherKey];
          const end = pinAt.get(mine.terminal);
          if (start === undefined || end === undefined) continue;
          const laneX = outer + dir * (M.stub + lane * M.lanePitchMin);
          lane += 1;
          leads.push({
            from: otherKey,
            terminal: mine.terminal,
            points: simplify([{ x: start.x, y: start.y }, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end]),
          });
        }
      }
      jacks.push({
        instanceId: id,
        label,
        connectorArt: {
          defId: art.defId,
          view: art.view,
          short: art.short,
          rect: { x: round(artLeft), y: round(artTop), w: round(artW), h: round(artH) },
          scale,
          width: art.width,
          height: art.height,
          shapes: art.shapes,
          pins: art.pins.map((pin) => ({ ...pin, used: used.has(pin.terminal) })),
          labels: art.labels,
          caption: {
            text: art.view === 'profile' ? 'SIDE VIEW' : 'MATING FACE',
            x: round(artLeft + artW / 2),
            y: round(artTop + artH + M.mouldSubLineHeight),
          },
          approximate: art.approximate,
        },
        leads,
      });
      jackBottom = artTop + artH + M.mouldSubLineHeight + 1.5;
    }
    if (jacks.some((jack) => jack.connectorArt !== undefined)) rect.h = jackBottom - rect.y;

    const mouldInstance = (design.instances.mechanical ?? []).find((m) => m.id === mould.mould);
    const mouldDef = mouldInstance === undefined ? undefined : db.mechanicals?.find((m) => m.id === mouldInstance.def);
    const sublabel = mouldDef === undefined ? undefined : (mouldDef.partNumber ?? mouldDef.label);
    // the part line wraps to the mould's own width under it: past its edges
    // is the fan corridor, where the runs out of the mould turn (nck.13)
    if (sublabel !== undefined) {
      const lines = wrapText(sublabel, M.fontMouldSub, rect.w).length;
      bottom = Math.max(bottom, rect.y + rect.h + 0.4 + lines * M.mouldSubLineHeight);
    } else {
      bottom = Math.max(bottom, rect.y + rect.h);
    }
    breakouts.push({
      id: mould.id,
      label: `${mould.id} · breakout mould`,
      ...(sublabel === undefined
        ? {}
        : { sublabel, sublabelLines: wrapText(sublabel, M.fontMouldSub, rect.w) }),
      rect,
      edgeX,
      dir,
      rows,
      throughs,
      jacks,
    });
  }

  /** the anchor a joint end lands on: its board pad, else its terminal's */
  const anchorKeyOf = (joint: JointRecord, end: 'a' | 'b'): string =>
    jointAnchor.get(`${joint.index}:${end}`) ?? (end === 'a' ? joint.keyA : joint.keyB);

  /* --- 9 · components: position from what they connect to ---------- */

  const components: DiagramComponent[] = [];
  const jointsByTerminal = new Map<string, JointRecord[]>();
  for (const joint of topology.joints) {
    for (const key of [joint.keyA, joint.keyB]) {
      const list = jointsByTerminal.get(key);
      if (list === undefined) jointsByTerminal.set(key, [joint]);
      else list.push(joint);
    }
  }
  const partnerAnchors = (key: string): Anchor[] => {
    const out: Anchor[] = [];
    for (const joint of jointsByTerminal.get(key) ?? []) {
      const otherEnd = joint.keyA === key ? 'b' : 'a';
      const anchor = anchors[anchorKeyOf(joint, otherEnd)];
      if (anchor !== undefined) out.push(anchor);
    }
    return out;
  };

  for (const plan of componentPlans) {
    const terminals = plan.def.terminals;
    const first = terminals[0];
    const second = terminals[1];
    const anchorsA = first === undefined ? [] : partnerAnchors(`${plan.id}:${first.id}`);
    const anchorsB = second === undefined ? [] : partnerAnchors(`${plan.id}:${second.id}`);
    const all = [...anchorsA, ...anchorsB];
    plan.y =
      all.length === 0
        ? trunkCenter
        : all.reduce((sum, anchor) => sum + anchor.y, 0) / all.length;
    const meanX = (list: Anchor[]): number | undefined =>
      list.length === 0
        ? undefined
        : list.reduce((sum, anchor) => sum + anchor.x, 0) / list.length;
    const xA = meanX(anchorsA);
    const xB = meanX(anchorsB);
    plan.flip = xA !== undefined && xB !== undefined && xA > xB;
  }

  /**
   * Rows a component's leads must not ride on: every block port and track
   * end facing the component's column, of a net neither lead is on. A lead
   * out along another net's row shares that row with its run to its lane —
   * the resistor reads as wired to the pin it merely sits level with
   *.
   */
  const foreignRows = (plan: ComponentPlan): number[] => {
    const own = new Set(
      plan.def.terminals
        .map((terminal) => netOf.get(`${plan.id}:${terminal.id}`))
        .filter((net): net is string => net !== undefined),
    );
    const rows: number[] = [];
    for (const anchor of Object.values(anchors)) {
      if (anchor.owner === 'component') continue;
      const net = netOf.get(anchor.key);
      if (net !== undefined && own.has(net)) continue;
      const facing = anchor.dir === 1 ? anchor.x < plan.x : anchor.x > plan.x + M.componentWidth;
      if (facing) rows.push(anchor.y);
    }
    return rows;
  };
  for (const zone of ['source', 'dest', 'inline'] as const) {
    const column = componentPlans.filter((plan) => plan.zone === zone);
    column.sort((x, y) => (x.y === y.y ? x.id.localeCompare(y.id) : x.y - y.y));
    let previous = Number.NEGATIVE_INFINITY;
    for (const plan of column) {
      plan.y = Math.max(plan.y, previous + M.componentPitch);
      if (zone === 'source') {
        plan.x = trunkX - M.componentInset - M.componentWidth;
      } else if (zone === 'dest') {
        plan.x = trunkRight + M.componentInset;
      } else {
        plan.x = trunkX + trunkWidth / 2 - M.componentWidth / 2;
      }
      if (zone !== 'inline') {
        // off any foreign row, by the smallest step that clears them all
        const rows = foreignRows(plan);
        const clear = (y: number): boolean => rows.every((row) => Math.abs(row - y) >= LANE_TOUCH);
        const base = plan.y;
        for (let step = 0; step <= 8; step += 1) {
          const tries = step === 0 ? [base] : [base + step * LANE_TOUCH, base - step * LANE_TOUCH];
          const found = tries.find((y) => y >= previous + M.componentPitch && clear(y));
          if (found !== undefined) {
            plan.y = found;
            break;
          }
        }
      }
      previous = plan.y;
    }
  }

  for (const plan of componentPlans) {
    const rect = {
      x: plan.x,
      y: plan.y - M.componentHeight / 2,
      w: M.componentWidth,
      h: M.componentHeight,
    };
    const terminals: DiagramComponentTerminal[] = [];
    plan.def.terminals.forEach((terminal, index) => {
      if (index > 1) return;
      const onLeft = plan.flip ? index === 1 : index === 0;
      const key = `${plan.id}:${terminal.id}`;
      const entry: DiagramComponentTerminal = {
        key,
        terminal: terminal.id,
        x: onLeft ? rect.x : rect.x + rect.w,
        y: plan.y,
        dir: onLeft ? -1 : 1,
        ...(terminal.polarity === undefined ? {} : { polarity: terminal.polarity }),
      };
      terminals.push(entry);
      anchors[key] = {
        key,
        x: entry.x,
        y: entry.y,
        dir: entry.dir,
        owner: 'component',
        instance: plan.id,
      };
    });
    const nets = terminals
      .map((terminal) => netOf.get(terminal.key))
      .filter((net, index, all): net is string => net !== undefined && all.indexOf(net) === index);
    components.push({
      id: plan.id,
      def: plan.def.id,
      symbol: plan.symbol,
      label: plan.label,
      labelX: rect.x + rect.w / 2,
      labelY: rect.y - M.componentLabelLift,
      rect,
      terminals,
      ...(plan.location === undefined ? {} : { location: plan.location }),
      ...(plan.note === undefined ? {} : { note: plan.note }),
      ...(nets.length === 0 ? {} : { nets }),
    });
    bottom = Math.max(bottom, rect.y + rect.h);
  }

  /* --- 10 · route the joints --------------------------------------- */

  // deliberate cut ends: drawn after the wiring, but their glyphs stand in
  // the fan corridor, so the router has to know where they are
  const cutEnds: DiagramCutEnd[] = [];
  for (const band of bands) {
    for (const track of band.tracks) {
      for (const end of [track.a, track.b]) {
        const other = end === track.a ? track.b : track.a;
        if (end.connected || !other.connected) continue;
        cutEnds.push({
          key: end.key,
          x: end.x,
          y: end.y,
          dir: end.dir,
          ...(end.noteRef === undefined ? {} : { noteRef: end.noteRef }),
          ...(track.net === undefined ? {} : { net: track.net }),
        });
      }
    }
  }

  /**
   * The x a wire has to reach before it may turn: the outward face of the
   * block the anchor belongs to.
   *
   * On an ordinary block a port already sits on that face, so this is the
   * anchor's own x and nothing changes. On a **depicted** block the port is a
   * pad in the middle of the artwork, and a turn taken at the usual stub
   * distance would still be inside the outline — over the block below it in
   * the same column, whose white fill is painted on top of the wiring. So the
   * turn is pushed out to the column's cable edge instead.
   */
  const blockRects = new Map(
    blocks.map((block) => [block.id, block.rect] as const),
  );
  const clearX = (anchor: Anchor): number => {
    if (anchor.owner === 'track') {
      // a trunk end inside a breakout mould: its runs turn past the mould,
      // not through it and out under its part line (nck.13)...
      const inMould = breakouts.find(
        (item) => item.dir === anchor.dir && Math.abs(item.edgeX - anchor.x) < OBSTACLE_EPS && anchor.instance === topology.trunkId,
      );
      if (inMould === undefined) return anchor.x;
      // ...and past the lanes the mould's through runs take (their last lane
      // stands `stub + (n-1)·pitch` out), so the two sets of lanes never meet
      const outer = inMould.dir === 1 ? inMould.rect.x + inMould.rect.w : inMould.rect.x;
      return outer + inMould.dir * inMould.throughs.length * M.lanePitchMin;
    }
    if (anchor.owner !== 'block') return anchor.x;
    const rect = blockRects.get(anchor.instance);
    if (rect === undefined) return anchor.x;
    return anchor.dir === 1
      ? Math.max(anchor.x, rect.x + rect.w)
      : Math.min(anchor.x, rect.x);
  };

  /**
   * Component keep-outs, in a fixed order — left column first, then top to
   * bottom, then by id — so "the first obstacle in the way" is the same
   * obstacle on every run of the program.
   */
  const obstacles = [
    ...components.map((component) => componentObstacle(component)),
    ...cutEnds.map((cut) => cutEndObstacle(cut)),
  ].sort((x, y) => {
    if (x.x0 !== y.x0) return x.x0 - y.x0;
    if (x.y0 !== y.y0) return x.y0 - y.y0;
    return x.id.localeCompare(y.id);
  });

  /** a block's keep-out for runs that do not belong to it: outline plus footnotes */
  const blockKeepOut = (block: DiagramBlock): Obstacle => ({
    id: block.id,
    x0: block.rect.x,
    y0: block.rect.y,
    x1: block.rect.x + block.rect.w,
    y1:
      block.rect.y +
      block.rect.h +
      (block.footnoteLines.length === 0 ? 0 : 1.5 + block.footnoteLines.length * M.footnoteLineHeight),
  });
  const blockKeepOuts = blocks.map((block) => blockKeepOut(block));

  const exitX = (anchor: Anchor, clear: number): number =>
    anchor.dir === 1
      ? Math.max(anchor.x + M.stub, clear + M.stub)
      : Math.min(anchor.x - M.stub, clear - M.stub);
  const bucketOf = (from: number, to: number): string => `${from.toFixed(1)}:${to.toFixed(1)}`;

  /**
   * The corridors a forward run crosses. Ordinarily one — the gap between its
   * two blocks — but a block standing *in* that gap (the board between a
   * docked connector and the wire, say) splits it in two, and the run goes
   * over or under the block, whichever is the shorter way round.
   */
  const planLegs = (left: Anchor, right: Anchor, leftClear: number, rightClear: number): RouteLeg[] => {
    const from = exitX(left, leftClear);
    const to = exitX(right, rightClear);
    const low = Math.min(left.y, right.y);
    const high = Math.max(left.y, right.y);
    const blockers = blockKeepOuts.filter(
      (box) =>
        box.id !== left.instance &&
        box.id !== right.instance &&
        box.x0 > from - OBSTACLE_EPS &&
        box.x1 < to + OBSTACLE_EPS &&
        box.y0 <= high + M.detourClearance &&
        box.y1 >= low - M.detourClearance,
    );
    if (blockers.length === 0) {
      return [{ bucket: bucketOf(from, to), from, to, yIn: left.y, yOut: right.y }];
    }
    const x0 = Math.min(...blockers.map((box) => box.x0));
    const x1 = Math.max(...blockers.map((box) => box.x1));
    const above = Math.min(...blockers.map((box) => box.y0)) - M.detourClearance;
    const below = Math.max(...blockers.map((box) => box.y1)) + M.detourClearance;
    const cost = (y: number): number => Math.abs(left.y - y) + Math.abs(y - right.y);
    const pass = cost(above) < cost(below) ? above : below;
    const firstTo = x0 - M.stub;
    const secondFrom = x1 + M.stub;
    return [
      { bucket: bucketOf(from, firstTo), from, to: firstTo, yIn: left.y, yOut: pass },
      { bucket: bucketOf(secondFrom, to), from: secondFrom, to, yIn: pass, yOut: right.y },
    ];
  };

  const jobs: RouteJob[] = [];
  for (const joint of topology.joints) {
    const anchorA = anchors[anchorKeyOf(joint, 'a')];
    const anchorB = anchors[anchorKeyOf(joint, 'b')];
    if (anchorA === undefined || anchorB === undefined) continue;
    const [left, right] =
      anchorA.x <= anchorB.x ? [anchorA, anchorB] : [anchorB, anchorA];
    const sameColumn =
      Math.abs(left.x - right.x) < 0.5 && left.dir === right.dir;
    const forward = left.dir === 1 && right.dir === -1;
    const mode: RouteJob['mode'] = sameColumn
      ? 'same-column'
      : forward
        ? 'forward'
        : 'reverse';
    const bucket =
      mode === 'same-column'
        ? `same:${left.x.toFixed(1)}:${left.dir}`
        : mode === 'forward'
          ? 'fwd'
          : 'rev';
    const leftClear = clearX(left);
    const rightClear = clearX(right);
    const net = netOf.get(joint.keyA) ?? netOf.get(joint.keyB);
    jobs.push({
      joint,
      left,
      right,
      mode,
      bucket,
      leftClear,
      rightClear,
      // a joint that lands *on* a component is entitled to run into it
      obstacles: obstacles.filter(
        (item) => item.id !== left.instance && item.id !== right.instance,
      ),
      legs: mode === 'forward' ? planLegs(left, right, leftClear, rightClear) : [],
      ...(net === undefined ? {} : { net }),
    });
  }

  // lanes: forward runs by corridor, crossing-aware (`lanes.ts`)
  const corridors = new Map<string, { leg: RouteLeg; job: RouteJob }[]>();
  for (const job of jobs) {
    for (const leg of job.legs) {
      if (Math.abs(leg.yIn - leg.yOut) < 1e-9) continue;
      const list = corridors.get(leg.bucket);
      if (list === undefined) corridors.set(leg.bucket, [{ leg, job }]);
      else list.push({ leg, job });
    }
  }
  for (const list of corridors.values()) {
    const runs: LaneRun[] = list.map(({ leg, job }) => ({
      yIn: leg.yIn,
      yOut: leg.yOut,
      tie: job.joint.index,
      ...(job.net === undefined ? {} : { net: job.net }),
    }));
    const order = orderLanes(runs);
    const first = list[0]!.leg;
    const from = Math.min(first.from, first.to);
    const to = Math.max(first.from, first.to);
    order.forEach((at, position) => {
      const item = list[at]!;
      item.leg.laneX = from + ((to - from) * (position + 1)) / (order.length + 1);
    });
  }

  const buckets = new Map<string, RouteJob[]>();
  for (const job of jobs) {
    if (job.mode === 'forward') continue;
    const list = buckets.get(job.bucket);
    if (list === undefined) buckets.set(job.bucket, [job]);
    else list.push(job);
  }
  const laneIndex = new Map<number, { index: number; size: number }>();
  for (const list of buckets.values()) {
    list.sort((x, y) => {
      // nested brackets: the shortest span takes the innermost lane
      const spanX = Math.abs(x.right.y - x.left.y);
      const spanY = Math.abs(y.right.y - y.left.y);
      if (x.mode === 'same-column' && spanX !== spanY) return spanX - spanY;
      if (x.right.y !== y.right.y) return x.right.y - y.right.y;
      if (x.left.y !== y.left.y) return x.left.y - y.left.y;
      return x.joint.index - y.joint.index;
    });
    list.forEach((job, index) => {
      laneIndex.set(job.joint.index, { index, size: list.length });
    });
  }

  // every lane, settled so no two nets share a line (nck.13)
  const lanePlans: LanePlan[] = [];
  for (const job of jobs) {
    cutRoute(job, laneIndex.get(job.joint.index) ?? { index: 0, size: 1 }, (item) => lanePlans.push(item));
  }
  const spread = settleLanes(lanePlans);

  const edges: DiagramEdge[] = [];
  const rings: DetourRings = new Map();
  const finished = separateRoutes(
    jobs.map((job) => ({
      points: routeJoint(job, laneIndex.get(job.joint.index) ?? { index: 0, size: 1 }, spread, rings),
      obstacles: job.obstacles,
      ...(job.net === undefined ? {} : { net: job.net }),
    })),
  );
  jobs.forEach((job, at) => {
    const points = finished[at]!;
    const padA = anchors[anchorKeyOf(job.joint, 'a')]?.pad;
    const padB = anchors[anchorKeyOf(job.joint, 'b')]?.pad;
    edges.push({
      index: job.joint.index,
      a: job.joint.keyA,
      b: job.joint.keyB,
      points,
      ...(job.joint.note === undefined ? {} : { note: job.joint.note }),
      ...(padA === undefined ? {} : { padA }),
      ...(padB === undefined ? {} : { padB }),
      ...(job.net === undefined ? {} : { net: job.net }),
    });
    for (const point of points) bottom = Math.max(bottom, point.y);
  });
  edges.sort((x, y) => x.index - y.index);

  /* --- 11 · joint dots and cut ends -------------------------------- */

  // one dot per anchor a joint lands on: a terminal with a joint on each of
  // two pads (GND on both faces) shows both
  const dotDegree = new Map<string, number>();
  for (const joint of topology.joints) {
    for (const end of ['a', 'b'] as const) {
      const key = anchorKeyOf(joint, end);
      dotDegree.set(key, (dotDegree.get(key) ?? 0) + 1);
    }
  }
  const jointDots: DiagramJointDot[] = [];
  const dotAt = new Map<string, DiagramJointDot>();
  for (const anchorKey of [...dotDegree.keys()].sort((x, y) => x.localeCompare(y))) {
    const anchor = anchors[anchorKey];
    if (anchor === undefined) continue;
    // a folded screen shares its representative's anchor: key the dot by the
    // anchor's own terminal, and two anchors on one spot are one dot
    const terminal = anchorKey.includes('~') || anchorKey.includes('>') ? anchor.key : anchorKey;
    const spot = `${terminal}|${anchor.pad ?? ''}|${anchor.x}|${anchor.y}`;
    const seen = dotAt.get(spot);
    if (seen !== undefined) {
      seen.degree += dotDegree.get(anchorKey) ?? 1;
      continue;
    }
    const net = netOf.get(terminal);
    const dot: DiagramJointDot = {
      key: terminal,
      x: anchor.x,
      y: anchor.y,
      degree: dotDegree.get(anchorKey) ?? 1,
      ...(anchor.pad === undefined ? {} : { pad: anchor.pad }),
      ...(net === undefined ? {} : { net }),
    };
    dotAt.set(spot, dot);
    jointDots.push(dot);
  }
  // a board pad landed through a carrier hole (e5c.37): no run comes to it,
  // its dot says it is soldered
  for (const pad of [...landedThrough.keys()].sort((x, y) => x.localeCompare(y))) {
    const anchor = anchors[pad];
    if (anchor === undefined || jointDots.some((dot) => dot.key === pad)) continue;
    const net = netOf.get(pad);
    jointDots.push({ key: pad, x: anchor.x, y: anchor.y, degree: 1, ...(net === undefined ? {} : { net }) });
  }


  /* --- 12 · footnotes and page size --------------------------------- */

  for (const block of blocks) {
    bottom = Math.max(
      bottom,
      block.rect.y +
        block.rect.h +
        (block.footnoteLines.length === 0
          ? 0
          : 1.5 + block.footnoteLines.length * M.footnoteLineHeight),
    );
  }

  /* --- 12b · the stock cutaway, inset under the trunk column -------- */

  // The inset belongs to the trunk band, so it takes the trunk's left edge and
  // sits under everything already placed — the one spot that cannot collide
  // with a branch band, a block stack or a component column.
  let crossSection: CrossSection | undefined;
  if (options.crossSection !== false && trunkBand !== undefined) {
    const wire = findWire(db, trunkBand.def);
    if (wire !== undefined) {
      crossSection = crossSectionLayout(wire, {
        origin: { x: trunkBand.x, y: bottom + M.crossSectionInsetGap },
      });
    }
  }
  if (crossSection !== undefined) {
    bottom = Math.max(bottom, crossSection.rect.y + crossSection.rect.h);
  }

  const contentWidth = Math.max(
    contentRight + M.margin,
    crossSection === undefined ? 0 : crossSection.rect.x + crossSection.rect.w + M.margin,
    200,
  );

  /*
   * Notes default to their own full-width strip below everything else. When
   * a cutaway is drawn, nothing else is placed as low as its row (the cutaway
   * is inset under everything already placed), so a
   * notes column that fits beside it is free height the drawing does not
   * have to add — that is most of what made these sheets feel like wasted
   * paper. A notes list too wide to read in what is
   * left over falls back to the strip below, unchanged.
   */
  let noteX: number = M.margin;
  let noteWidth: number = contentWidth - 2 * M.margin - M.footnoteIndent;
  let noteY: number = bottom + M.footnoteGap;
  if (crossSection !== undefined && (design.notes ?? []).length > 0) {
    const besideX = crossSection.rect.x + crossSection.rect.w + M.crossSectionInsetGap;
    const besideWidth = contentWidth - M.margin - besideX - M.footnoteIndent;
    if (besideWidth >= M.notesBesideMin) {
      noteX = besideX;
      noteWidth = besideWidth;
      noteY = crossSection.rect.y;
    }
  }
  const notes: DiagramNote[] = [];
  const notesHeading =
    (design.notes ?? []).length === 0 ? undefined : { x: noteX, y: noteY };
  if (notesHeading !== undefined) noteY += M.fontNote + 2.5;
  (design.notes ?? []).forEach((text, index) => {
    const lines = wrapText(text, M.fontNote, noteWidth);
    notes.push({ index: index + 1, lines, x: noteX, y: noteY });
    noteY += Math.max(1, lines.length) * M.footnoteLineHeight + 1.2;
  });
  const contentHeight = Math.max(noteY, bottom) + M.margin;
  const width = Math.max(contentWidth, contentHeight * M.targetAspect);

  const sourceLabel = describeEnd(design, db, topology, 'a');
  const destLabel = describeEnd(design, db, topology, 'b');

  return {
    designId: design.id,
    title: design.label,
    subtitle: [design.id, design.productRef].filter((part) => part !== undefined).join(' · '),
    width,
    height: contentHeight,
    direction: {
      leftLabel: `end a · source — ${sourceLabel}`,
      rightLabel: `${destLabel} — destination · end b`,
      y: M.margin + 17,
      x1: M.margin,
      x2: width - M.margin,
    },
    legend: { y: M.margin + 26, x1: M.margin, x2: width - M.margin },
    blocks,
    bands,
    ...(crossSection === undefined ? {} : { crossSection }),
    components,
    edges,
    jointDots,
    cutEnds,
    notes,
    ...(notesHeading === undefined ? {} : { notesHeading }),
    anchors,
    depictions,
    issues: [...issues, ...depictionIssues],
    ...(breakouts.length === 0 ? {} : { breakouts }),
  };
}

/* ------------------------------------------------------------------ *
 * Two-faced boards: geometry helpers
 * ------------------------------------------------------------------ */

/** A two-faced board's layout inside its block, in block-local millimetres. */
interface BoardGeometry {
  source: BoardFacesSource;
  faces: Record<BoardFaceSide, FacePlan>;
  pads: FacePad[];
  /** page mm per artwork unit */
  scale: number;
  cableSide: Side;
  /** left edge and width of the art column */
  artX: number;
  artW: number;
  /** where the first face's caption row starts */
  bodyTop: number;
  /** which face stacks on top — chosen for the fewest crossings */
  order: [BoardFaceSide, BoardFaceSide];
  /** terminals the board's docked connector lands on (drawn without a name) */
  dockJoined: ReadonlySet<string>;
}

/** Magnification for a two-faced board: its long side toward `boardLongSide`, stepped and clamped. */
function boardScaleFor(frame: { width: number; height: number }): number {
  const long = Math.max(frame.width, frame.height);
  const wanted = long <= 0 ? M.boardScaleMin : M.boardLongSide / long;
  const stepped = Math.floor(wanted / M.boardScaleStep + 1e-9) * M.boardScaleStep;
  return Math.min(M.boardScaleMax, Math.max(M.boardScaleMin, stepped));
}

/** One face's box, block-local, for the current face order. */
function faceBox(geom: BoardGeometry, side: BoardFaceSide): Rect {
  const [first] = geom.order;
  const firstHeight = geom.faces[first].size.height * geom.scale;
  const face = geom.faces[side];
  const w = face.size.width * geom.scale;
  const h = face.size.height * geom.scale;
  const y =
    geom.bodyTop +
    M.faceCaption +
    (side === first ? 0 : firstHeight + M.faceGap + M.faceCaption);
  // both faces flush to the cable side, so every cable pad is as near the
  // wire as the board allows
  const x = geom.cableSide === 'right' ? geom.artX + geom.artW - w : geom.artX;
  return { x, y, w, h };
}

/** A pad's position, block-local. */
function padLocal(geom: BoardGeometry, pad: FacePad): Point {
  const box = faceBox(geom, pad.side);
  return { x: box.x + pad.x * geom.scale, y: box.y + pad.y * geom.scale };
}

/** How far a pad sits from the edge its wire comes in over. */
function edgeDistance(geom: BoardGeometry, pad: FacePad, approach: 'cable' | 'connector'): number {
  const width = geom.faces[pad.side].size.width;
  const nearRight = (geom.cableSide === 'right') === (approach === 'cable');
  return nearRight ? width - pad.x : pad.x;
}

/**
 * Does a joint to `terminal` come in over the connector edge or the cable
 * edge? From the wire it is always the cable edge — even onto a pad that sits
 * by the connector (a +5 V bodge onto a connector pin's pad runs in across
 * the board) — and from the board's own mounted connector always the
 * connector edge; anything else by which kind of terminal it is.
 */
function approachOf(
  plan: BlockPlan,
  terminal: string,
  other: string,
  segments: ReadonlySet<string>,
): 'cable' | 'connector' {
  if (segments.has(other)) return 'cable';
  if (plan.docks.includes(other)) return 'connector';
  // a carrier board docked beside the board beyond it (e5c.36): its slot
  // pads face that board, across its cable edge
  if (plan.dockedTo === other) return 'cable';
  return isConnectorSideTerminal(terminal) ? 'connector' : 'cable';
}

/**
 * The physical pad a joint lands on: the one the joint names (`pad`), else —
 * a multi-pad terminal with no pad given — the one nearest the edge the wire
 * comes in over, then the primary pad. A through-hole pad shows on both faces;
 * it lands on the face that stacks on top.
 */
function choosePad(
  geom: BoardGeometry,
  terminal: string,
  wanted: string | undefined,
  approach: 'cable' | 'connector',
): FacePad | undefined {
  let candidates = geom.pads.filter((pad) => pad.terminal === terminal);
  if (wanted !== undefined) {
    const named = candidates.filter((pad) => pad.ref === wanted);
    if (named.length > 0) candidates = named;
  }
  const faceRank = (side: BoardFaceSide): number => geom.order.indexOf(side);
  return [...candidates].sort((a, b) => {
    const da = edgeDistance(geom, a, approach);
    const db = edgeDistance(geom, b, approach);
    if (Math.abs(da - db) > 0.5) return da - db;
    if (a.index !== b.index) return a.index - b.index;
    if (faceRank(a.side) !== faceRank(b.side)) return faceRank(a.side) - faceRank(b.side);
    return 0;
  })[0];
}

/**
 * Stagger pad names into columns: each y (sorted ascending) takes the first
 * column whose last name is at least a line of text above it — a real line
 * box (DejaVu Sans runs 1.16 em ascender to descender), so two names stacked
 * in one column never share glyph space whatever face the reader has.
 */
function labelColumns(ys: readonly number[]): number[] {
  const pitch = M.fontPadLabel * 1.15;
  const last: number[] = [];
  return ys.map((y) => {
    let column = last.findIndex((previous) => y - previous >= pitch);
    if (column === -1) {
      column = last.length;
      last.push(y);
    } else {
      last[column] = y;
    }
    return column;
  });
}

/** `R`, or — a terminal with several pads — which one: `GND2`, `GND·H9`. */
function padLabelText(displayId: string, pad: string | undefined, multi: boolean): string {
  if (!multi || pad === undefined) return displayId;
  return pad.toUpperCase().startsWith(displayId.toUpperCase()) ? pad : `${displayId}·${pad}`;
}

/** Group brackets for a reordered band: each group spans its members' new rows. */
function regroup(groups: readonly GroupSpec[], tracks: readonly TrackSpec[]): GroupSpec[] {
  return groups
    .map((group) => {
      const indices = tracks
        .map((track, index) => (track.groupId === group.id ? index : -1))
        .filter((index) => index !== -1);
      return indices.length === 0
        ? undefined
        : { ...group, first: Math.min(...indices), last: Math.max(...indices) };
    })
    .filter((group): group is GroupSpec => group !== undefined);
}

/* ------------------------------------------------------------------ *
 * Block sizing
 * ------------------------------------------------------------------ */

interface BlockPlanInput {
  id: string;
  kind: 'connector' | 'pcba';
  def: string;
  title: string;
  subtitle?: string;
  note?: string;
  zone: Zone;
  cable: PortPlan[];
  integrated: PortPlan[];
  captions?: { cable?: string; integrated?: string };
  footnotes: string[];
  depiction?: ResolvedDepiction;
  /** every terminal the definition declares (a PCBA's pads and integrated pins) */
  terminals?: readonly string[];
  /** terminals the board's docked connector lands on */
  dockJoined?: ReadonlySet<string>;
  /**
   * Connector-side terminals whose wire comes in over the cable edge: a
   * carrier board's slot pads, facing the board it docks beside (e5c.36).
   */
  cableFacing?: ReadonlySet<string>;
}

/**
 * A two-faced board: both faces stacked in one art
 * column, each turned so its cable edge faces the wire, with a gutter on the
 * cable side for the pad names and one on the far side for the connector pins
 * nobody else labels. Sized for the face order that makes the column tallest
 * — both orders are the same height, so the choice made later never moves
 * the block.
 */
function finishBoardPlan(
  input: BlockPlanInput,
  depiction: ResolvedDepiction,
  source: BoardFacesSource,
  cableSide: Side,
): BlockPlan {
  const terminals = new Set(input.terminals ?? Object.keys(source.pads));
  const { faces, pads } = boardFaces(source, cableSide, terminals);
  const scale = boardScaleFor(source.frame);
  const artW = Math.max(faces.top.size.width, faces.bottom.size.width) * scale;
  const bodyHeight =
    2 * M.faceCaption + M.faceGap + (faces.top.size.height + faces.bottom.size.height) * scale;

  // a row shown only because an internal link names it may go unanchored
  const anchored = (ports: PortPlan[]): PortPlan[] =>
    ports.filter((port) => source.pads[port.terminal] !== undefined);
  const cable = anchored(input.cable);
  const integrated = anchored(input.integrated);
  const dropped = [...input.cable, ...input.integrated]
    .filter((port) => source.pads[port.terminal] === undefined)
    .map((port) => port.terminal);

  const dockJoined = input.dockJoined ?? new Set<string>();
  const cableFacing = input.cableFacing ?? new Set<string>();
  const onCable = (terminal: string): boolean => !isConnectorSideTerminal(terminal) || cableFacing.has(terminal);
  const shown = [...cable, ...integrated];
  const cableTexts = shown
    .filter((port) => onCable(port.terminal))
    .flatMap((port) => {
      const list = source.pads[port.terminal] ?? [];
      return list.map((pad) => padLabelText(port.displayId, pad.ref, list.length > 1));
    });
  const farTexts = shown
    .filter((port) => !onCable(port.terminal) && !dockJoined.has(port.terminal))
    .map((port) => calloutText(port));
  // pads closer together than a line of text stagger their names into
  // columns, so every name still sits just over its own wire
  const columnWidth = maxTextWidth(cableTexts, M.fontPadLabel, 'bold') + M.padLabelGap;
  const columns = Math.max(
    1,
    ...(['top', 'bottom'] as const).map((side) => {
      const ys = pads
        .filter((pad) => pad.side === side && onCable(pad.terminal))
        .filter((pad) => shown.some((port) => port.terminal === pad.terminal))
        .map((pad) => pad.y * scale)
        .sort((a, b) => a - b);
      return 1 + Math.max(-1, ...labelColumns(ys));
    }),
  );
  const cableGutter = Math.max(6, columns * columnWidth + M.padLabelGap);
  const farGutter = farTexts.length === 0 ? 0 : maxTextWidth(farTexts, M.fontCallout) + M.calloutGap;

  // block titles print semibold: the regular-weight advance table runs short
  const headings = [textWidth(input.title, M.fontBlockTitle, 'bold')];
  if (input.subtitle !== undefined) headings.push(textWidth(input.subtitle, M.fontBlockSub));
  const width = Math.max(farGutter + artW + cableGutter, ...headings) + 2 * M.blockPad;
  const headerHeight = 5.5 + (input.subtitle === undefined ? 0 : 4.2);
  const height = headerHeight + 2 * M.depictionPad + bodyHeight;
  const artX =
    cableSide === 'right' ? width - M.blockPad - cableGutter - artW : M.blockPad + cableGutter;

  const footnotes = [...input.footnotes];
  if (dropped.length > 0) {
    footnotes.push(`no artwork anchor: ${summarizeIds(dropped.sort(compareTerminalIds))}`);
  }

  return {
    id: input.id,
    kind: input.kind,
    def: input.def,
    title: input.title,
    ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
    ...(input.note === undefined ? {} : { note: input.note }),
    zone: input.zone,
    cableSide,
    cable,
    integrated,
    footnotes,
    cableIdW: 0,
    cableLabelW: 0,
    integratedIdW: 0,
    integratedLabelW: 0,
    corridor: 0,
    headerHeight,
    width,
    height,
    column: 'left',
    x: 0,
    y: 0,
    depiction,
    artScale: scale,
    artWidth: artW,
    artHeight: bodyHeight,
    gutterWidth: farGutter,
    docks: [],
    board: {
      source,
      faces,
      pads,
      scale,
      cableSide,
      artX,
      artW,
      bodyTop: headerHeight + M.depictionPad,
      order: ['top', 'bottom'],
      dockJoined,
    },
  };
}

/**
 * A depicted block is sized by its artwork, not by its rows: the asset frame at
 * the fixed magnification, a gutter wide enough for the pin callouts beside it,
 * and enough height for whichever of the two is taller.
 */
function finishDepictedPlan(
  input: BlockPlanInput,
  depiction: ResolvedDepiction,
  cableSide: Side,
): BlockPlan {
  const artScale = M.depictionScale * depiction.mmPerUnit;
  const artWidth = depiction.widthUnits * artScale;
  const artHeight = depiction.heightUnits * artScale;

  // A row shown only because an internal link names it may go unanchored; the
  // footnote below says so rather than the drawing quietly dropping it.
  const anchored = (ports: PortPlan[]): PortPlan[] =>
    ports.filter((port) => depiction.anchors[port.terminal] !== undefined);
  const cable = anchored(input.cable);
  const integrated = anchored(input.integrated);
  const dropped = [...input.cable, ...input.integrated]
    .filter((port) => depiction.anchors[port.terminal] === undefined)
    .map((port) => port.terminal);

  const texts = [...cable, ...integrated].map((port) => calloutText(port));
  const gutterWidth = maxTextWidth(texts, M.fontCallout);

  // block titles print semibold: the regular-weight advance table runs short
  const headings = [textWidth(input.title, M.fontBlockTitle, 'bold')];
  if (input.subtitle !== undefined) {
    headings.push(textWidth(input.subtitle, M.fontBlockSub));
  }
  const width =
    Math.max(artWidth + M.calloutGap + gutterWidth, ...headings) + 2 * M.blockPad;
  const headerHeight = 5.5 + (input.subtitle === undefined ? 0 : 4.2);
  const bodyHeight = Math.max(artHeight, texts.length * M.calloutPitch);
  const height = headerHeight + 2 * M.depictionPad + bodyHeight;

  const footnotes = [...input.footnotes];
  if (dropped.length > 0) {
    footnotes.push(`no artwork anchor: ${summarizeIds(dropped.sort(compareTerminalIds))}`);
  }

  return {
    id: input.id,
    kind: input.kind,
    def: input.def,
    title: input.title,
    ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
    ...(input.note === undefined ? {} : { note: input.note }),
    zone: input.zone,
    cableSide,
    cable,
    integrated,
    footnotes,
    cableIdW: 0,
    cableLabelW: 0,
    integratedIdW: 0,
    integratedLabelW: 0,
    corridor: 0,
    headerHeight,
    width,
    height,
    column: 'left',
    x: 0,
    y: 0,
    depiction,
    artScale,
    artWidth,
    artHeight,
    gutterWidth,
    docks: [],
  };
}

/**
 * Draw a connector block as the connector itself, or
 * `undefined` when the shared art has no drawing for it — an unknown family,
 * or a used pin the family's drawing has no place for — and the pin table
 * stays. Sizes the block: the drawing at its fixed scale, the rows (each as
 * near level with its pin's run as the row pitch allows), and a fan between
 * them wide enough that the wires' slants stay readable.
 */
function planConnectorArt(
  plan: Pick<BlockPlan, 'title' | 'subtitle' | 'cable' | 'cableSide'>,
  def: ConnectorDefinition,
  body: ConnectorBody | undefined,
): { art: ArtPlan; width: number; height: number } | undefined {
  const art = connectorArt({ def, facing: plan.cableSide, ...(body === undefined ? {} : { body }) });
  if (art === undefined) return undefined;
  const drawn = new Set(art.pins.map((pin) => pin.terminal));
  if (plan.cable.length === 0 || plan.cable.some((port) => !drawn.has(port.terminal))) return undefined;

  // a face grows toward the height of its rows (so a mini-DIN is not a
  // thumbnail beside eight rows), within limits; a profile keeps its scale
  const scale =
    art.view === 'profile'
      ? M.artProfileScale
      : Math.min(M.artFaceScaleMax, Math.max(M.artFaceScale, (plan.cable.length * M.portPitch * 0.9) / art.height));
  const used = new Set(plan.cable.map((port) => port.terminal));
  // where no clear way exists across the face (an HD15's far row sits right
  // behind its near row, the middle row filling the gaps) a far-row pin is
  // reached from behind the field instead
  const leadList = planPinLeads(art, used, {
    side: plan.cableSide,
    clearance: M.artLeadClearance / scale,
    gap: M.artLeadGap / scale,
    step: M.artLeadStep / scale,
  });
  const leads = new Map(leadList.map((lead) => [lead.terminal, lead]));
  const artW = art.width * scale;
  const artH = art.height * scale;

  // pin numbers print semibold: `shell`, `sleeve` outrun the regular-weight table
  const idW = Math.max(M.pinIdWidth, maxTextWidth(plan.cable.map((port) => port.displayId), M.fontPin, 'bold') + 2);
  const labelW = maxTextWidth(plan.cable.map((port) => port.label), M.fontPin);
  const rowsW = idW + 2 + labelW;

  const headerHeight = 5.5 + (plan.subtitle === undefined ? 0 : 4.2);
  const bodyTop = headerHeight + M.depictionPad;
  const rows = [...plan.cable].sort(
    (x, y) =>
      (leads.get(x.terminal)?.channel ?? 0) - (leads.get(y.terminal)?.channel ?? 0) ||
      compareTerminalIds(x.terminal, y.terminal),
  );
  const contentH = Math.max(artH + M.artCaption, rows.length * M.portPitch);
  const artY = bodyTop + M.artCaption + (contentH - M.artCaption - artH) / 2;
  // rows want to sit level with their pin's run, but never closer than the
  // row pitch: one pass down for the pitch, one back up for the bottom edge
  const want = (terminal: string): number => artY + (leads.get(terminal)?.channel ?? 0) * scale;
  const rowY = new Map<string, number>();
  let cursor = bodyTop + M.portPitch / 2;
  for (const port of rows) {
    const y = Math.max(cursor, want(port.terminal));
    rowY.set(port.terminal, y);
    cursor = y + M.portPitch;
  }
  let floor = bodyTop + contentH - M.portPitch / 2;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const port = rows[index]!;
    const y = Math.min(rowY.get(port.terminal)!, floor);
    rowY.set(port.terminal, Math.round(y * 100) / 100);
    floor = y - M.portPitch;
  }
  const slant = Math.max(...rows.map((port) => Math.abs(rowY.get(port.terminal)! - want(port.terminal))));
  const fanW = Math.max(M.artFanMin, 3 + slant * 0.3);

  // block titles print semibold: the regular-weight advance table runs short
  const headings = [textWidth(plan.title, M.fontBlockTitle, 'bold')];
  if (plan.subtitle !== undefined) headings.push(textWidth(plan.subtitle, M.fontBlockSub));
  const width = Math.max(artW + fanW + rowsW, ...headings) + 2 * M.blockPad;
  const height = bodyTop + contentH + M.depictionPad;
  // the drawing sits against the fan; a wide title leaves its slack beyond it
  const artX = plan.cableSide === 'right' ? width - M.blockPad - rowsW - fanW - artW : M.blockPad + rowsW + fanW;
  return {
    art: {
      art,
      def,
      ...(body === undefined ? {} : { body }),
      scale,
      leads,
      rowY,
      artX,
      artY,
      artW,
      artH,
      captionY: artY - 1.2,
      idW,
      labelW,
    },
    width,
    height,
  };
}

function finishBlockPlan(input: BlockPlanInput, cableSide: Side): BlockPlan {
  if (input.depiction?.board !== undefined && input.kind === 'pcba') {
    return finishBoardPlan(input, input.depiction, input.depiction.board, cableSide);
  }
  if (input.depiction !== undefined) return finishDepictedPlan(input, input.depiction, cableSide);

  const cableIdW = Math.max(
    M.pinIdWidth,
    maxTextWidth(input.cable.map((port) => port.displayId), M.fontPin, 'bold') + 2,
  );
  const cableLabelW = maxTextWidth(input.cable.map((port) => port.label), M.fontPin);
  const integratedIdW =
    input.integrated.length === 0
      ? 0
      : Math.max(
          M.pinIdWidth,
          maxTextWidth(input.integrated.map((port) => port.displayId), M.fontPin, 'bold') + 2,
        );
  const integratedLabelW = maxTextWidth(
    input.integrated.map((port) => port.label),
    M.fontPin,
  );

  const corridor = input.integrated.length === 0 ? 0 : M.pcbaCorridor;

  const columnsWidth =
    cableIdW +
    2 +
    cableLabelW +
    (input.integrated.length === 0 ? 0 : corridor + integratedIdW + 2 + integratedLabelW);

  // block titles print semibold: the regular-weight advance table runs short
  const headings = [textWidth(input.title, M.fontBlockTitle, 'bold')];
  if (input.subtitle !== undefined) {
    headings.push(textWidth(input.subtitle, M.fontBlockSub));
  }
  const width = Math.max(columnsWidth, ...headings) + 2 * M.blockPad;

  const headerHeight =
    5.5 +
    (input.subtitle === undefined ? 0 : 4.2) +
    (input.captions === undefined ? 0 : 3.6);
  const rows = Math.max(input.cable.length, input.integrated.length);
  const height = headerHeight + rows * M.portPitch + M.blockPad;

  return {
    id: input.id,
    kind: input.kind,
    def: input.def,
    title: input.title,
    ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
    ...(input.note === undefined ? {} : { note: input.note }),
    zone: input.zone,
    cableSide,
    cable: input.cable,
    integrated: input.integrated,
    ...(input.captions === undefined ? {} : { captions: input.captions }),
    footnotes: input.footnotes,
    cableIdW,
    cableLabelW,
    integratedIdW,
    integratedLabelW,
    corridor,
    headerHeight,
    width,
    height,
    column: 'left',
    x: 0,
    y: 0,
    artScale: 0,
    artWidth: 0,
    artHeight: 0,
    gutterWidth: 0,
    docks: [],
  };
}

/* ------------------------------------------------------------------ *
 * Header text
 * ------------------------------------------------------------------ */

function describeEnd(
  design: CableDesign,
  db: Db,
  topology: Topology,
  end: 'a' | 'b',
): string {
  const wanted = end === 'a' ? topology.sourceBlocks : topology.destBlocks;
  const names: string[] = [];
  for (const id of wanted) {
    const connector = design.instances.connectors.find((item) => item.id === id);
    if (connector !== undefined) {
      names.push(findConnector(db, connector.def)?.label ?? connector.def);
      continue;
    }
    const pcba = design.instances.pcbas.find((item) => item.id === id);
    if (pcba !== undefined) {
      const definition = findPcba(db, pcba.def);
      names.push(
        definition === undefined
          ? pcba.def
          : `${definition.partNumber} ${definition.revision}`,
      );
    }
  }
  // the trunk end sits in a breakout mould: name it and what its legs run out to
  const mould = (design.instances.breakouts ?? []).find((b) => b.trunk.segment === topology.trunkId && b.trunk.end === end);
  if (mould !== undefined) {
    const legPlugs = topology.branches
      .filter((branch) => branch.breakout === mould.id)
      .flatMap((branch) => branch.blockIds)
      .map((id) => design.instances.connectors.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .map((item) => findConnector(db, item.def)?.label ?? item.def);
    const counted = [...new Set(legPlugs)].map((label) => {
      const n = legPlugs.filter((x) => x === label).length;
      return n > 1 ? `${n}× ${label}` : label;
    });
    return [`breakout mould ${mould.id}`, ...counted, ...names].join(' + ');
  }
  return names.length === 0 ? 'open' : names.join(' + ');
}
