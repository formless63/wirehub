/**
 * design → canvas.
 *
 * The canvas is a **projection** of the CableDesign, never a second copy of the
 * truth. Everything React Flow needs — nodes, handles, edges — is computed here
 * from `(design, db)` plus purely presentational overrides (dragged positions,
 * what is selected). Nothing in this file may ever be the only place a fact
 * lives: delete the whole canvas and the design is unharmed.
 */

import {
  breakoutFates,
  inScope,
  elementPaths,
  findComponent,
  findConnector,
  findPcba,
  findWire,
  isElectricalElement,
  parseTerminalKey,
  placedDesign,
  portsOfSubassembly,
  screenTerminations,
  terminalKey,
  type CableDesign,
  type ConductorElement,
  type ConnectorBody,
  type ConnectorDefinition,
  type Db,
  type Element,
  type InstanceKind,
  type Joint,
  type TerminalRef,
} from '@wirehub/model';
import { wireDisplayName } from '@wirehub/docs';
import {
  bondFoldedPaths,
  carriedConnectors,
  conductorPaint,
  mountedConnectors,
  representativeLabel,
  type DepictionSource,
} from '@wirehub/render-svg';
import type { Edge, Node } from '@xyflow/react';

import {
  BOARD_LAYOUT,
  boardArt,
  isConnectorTerminal,
  placedTerminals,
  type BoardArt,
  type BoardDockRequest,
  type Facing,
} from './board-art.ts';
import {
  connectorArt,
  dockCaption,
  dockedLayout,
  dockSize,
  type ConnectorArt,
  type ConnectorArtLayout,
} from './connector-art.ts';
import { canvasView, mouldIds, mouldNodes, MOULD_KIND, rankView, type CanvasView, type MouldHoused, type MouldNodeData } from './moulds.ts';
import {
  anchorOf,
  inversions,
  planBreakouts,
  placedNode,
  routeY,
  type BreakoutPlan,
  type Link,
  type PlacedNode,
  type PortKind,
  type WireBreakout,
} from './breakout.ts';
import type { Bridge } from './bridge-bus.ts';
import { designRanks, facingByColumns, type Ranks } from './ranks.ts';
import { elkLayout, type ElkEdgeSpec, type ElkGraphSpec, type ElkNodeSpec, type ElkPortSpec } from './elk.ts';
import { endFacing, wireArt, type WireArt, type WireEnd } from './wire-art.ts';
import { netPainter, type NetPaint } from './net-paint.ts';
import { connectorFan } from './connector-fan.ts';

import {
  BOX,
  NODE_BASE_WIDTH,
  artHeadWidth,
  connectorArtLayout,
  estimateNodeSize,
  rowsTop,
  wireHeadMeta,
  rectsOverlap,
  type NodeSize,
} from './layout-size.ts';

/** The body a connector is built on, as `connectorArt` takes it — the art is the body's. */
function bodyOf(db: Db, def: ConnectorDefinition): { body?: ConnectorBody } {
  const body = def.body === undefined ? undefined : (db.bodies ?? []).find((candidate) => candidate.id === def.body);
  return body === undefined ? {} : { body };
}

export interface XY {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ *
 * Handles
 * ------------------------------------------------------------------ */

/**
 * A handle id **is** a terminal key (`w1:core-red.center@a`, `j1:6`,
 * `u1:scart.15`). One string, produced and parsed by core, so a React Flow
 * connection converts back into a `TerminalRef` with no editor-owned mapping
 * table that could drift from the model.
 */
export function handleIdFor(ref: TerminalRef): string {
  return terminalKey(ref);
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

export type TerminalRole =
  | 'pin'
  | 'pad'
  | 'integrated-pin'
  | 'conductor'
  | 'shield'
  | 'drain'
  | 'lead';

/** One addressable terminal, drawn as a row with a React Flow handle. */
export type TerminalRow = {
  /** terminal key — also the handle id */
  key: string;
  /** terminal id as the definition names it (`6`, `scart.15`, `core-red.center`) */
  terminal: string;
  label?: string;
  role: TerminalRole;
  side: 'left' | 'right';
  /** as the interface declares it, seen from the device that owns the port */
  dir?: 'out' | 'in' | 'bidir' | 'passive';
  end?: 'a' | 'b';
  /** css paint for the swatch, when the terminal has an identifying colour */
  color?: string;
  /** the terminal is soldered to something in this design */
  used: boolean;
  /** the terminal sits on the net of the current selection */
  onSelectedNet: boolean;
  /** this exact terminal is the current selection */
  selected: boolean;
  /**
   * Soldered only by same-part bridges: no edge comes
   * to it, the part's ground bus does — so it draws no edge lead.
   */
  bridgedOnly?: true;
  /**
   * Landed through a carrier's hole (`Joint.through`):
   * the plug pin, the carrier hole and this pad are one solder point, so no
   * edge is drawn to it — the pad itself shows it is landed, in its net's
   * paint (grey `''` when the net has none).
   */
  through?: string;
};

/** A wire element drawn as one row with a handle at each end. */
export type ElementRow = {
  path: string;
  label?: string;
  role: TerminalRole;
  color?: string;
  a: TerminalRow;
  b: TerminalRow;
};

const SHIELD_PAINT = '#7a8794';
const DRAIN_PAINT = '#b08a4a';

export function elementRole(element: Element): TerminalRole {
  if (element.kind === 'shield') return 'shield';
  if (element.kind === 'conductor' && element.bare === true) return 'drain';
  return 'conductor';
}

function elementPaint(element: Element): string {
  if (element.kind === 'shield') return SHIELD_PAINT;
  if (element.kind === 'conductor') {
    const conductor = element as ConductorElement;
    if (conductor.bare === true) return DRAIN_PAINT;
    return conductorPaint(conductor.color);
  }
  return SHIELD_PAINT;
}

/* ------------------------------------------------------------------ *
 * Node data
 * ------------------------------------------------------------------ */

export type ConnectorNodeData = {
  kind: 'connector';
  instanceId: string;
  def: string;
  title: string;
  subtitle: string;
  role?: string;
  note?: string;
  rows: TerminalRow[];
  missingDef: boolean;
  /**
   * The pins are listed last to first: every joint on this connector lands
   * on terminals stacked the other way up (a plug soldered to a board turned
   * to face its wire), and listing them in that order is what keeps its
   * edges from crossing (see `orientConnectors`).
   */
  reversed?: boolean;
  /**
   * The connector drawn as itself (`connector-art.ts`): its mating face or
   * side profile, a handle on every drawn pin. Absent, the node is the pin
   * list — an unknown family, or pins its family's drawing has no place for.
   */
  art?: ConnectorArtLayout;
  /**
   * The drawn face's exit fan (`connector-fan.ts`): the
   * slot each wired pin's lead runs to, drawing coordinates, by pin terminal.
   * Absent when docked (a docked pin keeps its own exit) or nothing is wired.
   */
  fan?: Record<string, { x: number; y: number }>;
  /** mounted on a board: drawn in that board's dock bay (see `mountsOf`) */
  dock?: ConnectorDock;
  /**
   * Joints between two of its own pins (bridges, jumpers, commoned grounds),
   * drawn as the part's faint ground bus rather than as edges
   * (`bridge-bus.ts`).
   */
  bridges?: Bridge[];
};

/**
 * Where a docked connector sits: inside its board's node, against the edge
 * away from the wire. Its joints to that board draw no edge (they are the
 * connector's own solder joints on the board); any other joint (the source device'
 * +5 V pin run straight to the cable, say) would otherwise draw straight
 * across the board's own artwork to reach the cable side, so instead it
 * leaves through the *dock bay's* own outer edge — the side the connector
 * itself sits against, not the board's — first horizontally, at the pin's
 * own height, then straight down along that same edge to below the whole
 * node, before bending toward its real target (; the
 * two-segment exit is replacing a single diagonal lead
 * that could still cut across the board's own artwork on the way).
 */
export interface ConnectorDock {
  /** the board instance it is mounted on */
  board: string;
  /** its position inside the board node (the React Flow parent) */
  offset: XY;
  /** the side its remaining edges leave toward: the board's cable side */
  facing: Facing;
  /** the dock bay's own outer edge, relative to the docked node's x */
  entryDx: number;
  /** just below the whole board node, relative to the docked node's y */
  entryDy: number;
  /**
   * The board's *other* edge — away from the dock bay, toward `facing` (the
   * cable side) — relative to the docked node's x. A stray edge's bend starts
   * here, not at `entryDx`: from the dock bay's own edge, straight down and
   * then along under the whole board to this one, so the bend toward a target
   * on the board's far side never has to cross back over it.
   */
  clearDx: number;
  /**
   * The board terminal prefixes its pins solder into (`Mount.prefixes`). A
   * joint to another of the board's own terminals — pin 6 of the DIN-8 plug
   * to the perfboard's slot pad `jp.R` — draws as a
   * straight stub across the board to that pad, the trace it is.
   */
  prefixes?: readonly string[];
}

/** A connector the board is sold with, drawn in the board's dock bay. */
export interface IntegratedArt {
  /** the dock id: `integrated:<prefix>` */
  id: string;
  prefix: string;
  art: ConnectorArt;
}

export type SegmentNodeData = {
  kind: 'segment';
  instanceId: string;
  def: string;
  title: string;
  subtitle: string;
  role?: string;
  lengthMm?: number;
  elements: ElementRow[];
  missingDef: boolean;
  /**
   * Both cut ends of the cable, when the stock documents its face (lay order,
   * viewed-from end, diameters). Absent, the node is the element rows.
   */
  wire?: WireArt;
  /**
   * End `b` is drawn on the left: the parts its `b` end is soldered to sit
   * left of it (see `segmentFlips`).
   */
  flipped?: boolean;
  /**
   * The port columns, stubs and face turns of `wire` (`breakout.ts`) — the
   * chosen angle per end is `breakout.rotation`. Derived, never persisted.
   */
  breakout?: WireBreakout;
};

export type ComponentNodeData = {
  kind: 'component';
  instanceId: string;
  def: string;
  title: string;
  subtitle: string;
  componentKind: string;
  value?: string;
  note?: string;
  rows: TerminalRow[];
  missingDef: boolean;
};

export type PcbaNodeData = {
  kind: 'pcba';
  instanceId: string;
  def: string;
  title: string;
  subtitle: string;
  note?: string;
  /** cable-side pads */
  pads: TerminalRow[];
  /** pins of the connector the board is sold soldered to */
  integrated: TerminalRow[];
  /** the side of the node the wire is on: the pads' column sits there */
  cableFacing: Facing;
  missingDef: boolean;
  revision?: string;
  build?: string;
  /**
   * Both faces of the real board, when the definition has a gerber depiction
   * and every terminal this design solders to has a pad on it. Absent, the
   * node is the pin list.
   */
  board?: BoardArt;
  /** the integrated connectors' faces, drawn in `board.docks` */
  integratedArt?: IntegratedArt[];
  /** joints between two of its own pads, drawn as its ground bus (see `ConnectorNodeData.bridges`) */
  bridges?: Bridge[];
};

/**
 * Another design placed as a sub-assembly: a block with one row per port
 * (its connectors' pins, its flying leads), grouped by the end they belong to.
 */
export type SubassemblyNodeData = {
  kind: 'subassembly';
  instanceId: string;
  /** the placed design's id */
  def: string;
  /** the placed design's label */
  title: string;
  /** `Rev 2` or `working copy` */
  subtitle: string;
  role?: string;
  /** the placed design's product part number */
  partNumber?: string;
  /** the pinned revision; absent = follows the working copy */
  rev?: number;
  rows: TerminalRow[];
  /** the ends the rows belong to, in row order: a heading over `count` rows from `start` */
  groups: { label: string; start: number; count: number }[];
  /** the placed design could not be opened (missing, a missing revision, no library): rows are only what the joints land on */
  missingDef: boolean;
};

export type EditorNodeData =
  | ConnectorNodeData
  | SegmentNodeData
  | ComponentNodeData
  | PcbaNodeData
  | MouldNodeData
  | SubassemblyNodeData;

/** What a canvas node is: an instance of the design, or a breakout mould (`moulds.ts`). */
export type EditorNodeKind = InstanceKind | typeof MOULD_KIND;

export type EditorNode = Node<EditorNodeData, EditorNodeKind>;

export type EditorEdgeKind = PortKind | 'plain';

export type EditorEdgeData = {
  /** the first joint the edge draws */
  jointIndex: number;
  /**
   * Every joint the edge draws: one, or a ground bundle's members (all the
   * shields and drain of one wire end landing on one terminal). Selecting the
   * edge selects them all; deleting it unsolders them all.
   */
  joints: number[];
  note?: string;
  kind: EditorEdgeKind;
  /** ground bundle size — the `×n` badge when above one */
  count: number;
  /** css paint of a conductor edge */
  paint?: string;
  /** white or black: drawn with an outline so it reads in both themes */
  outlined?: boolean;
  /**
   * A joint no wire element touches (a plug pin into a carrier board, a
   * carrier's pad onto the next board): the paint of the net it carries
   * (`net-paint.ts`) — its conductor's colour in
   * `paint`, or ground's dashed style. Absent: no conductor reaches the net,
   * or the net is ambiguous, and the edge stays grey.
   */
  net?: NetPaint['kind'];
  /** see `Anchor.entryX` */
  sourceEntryX?: number;
  targetEntryX?: number;
  /** see `Anchor.entryY` */
  sourceEntryY?: number;
  targetEntryY?: number;
  /** see `Anchor.clearX` */
  sourceClearX?: number;
  targetClearX?: number;
  /** see `Anchor.approach` */
  sourceApproach?: number;
  targetApproach?: number;
  /** see `Anchor.approachLead` */
  sourceApproachLead?: number;
  targetApproachLead?: number;
  /** see `Anchor.slot` */
  sourceSlot?: { dx: number; dy: number };
  targetSlot?: { dx: number; dy: number };
  /** some, not all, of its joints are the current selection */
  partial?: boolean;
  /** a docked connector's pin straight to its board pad (`Link.stub`) */
  stub?: boolean;
  /**
   * A conductor's run into or out of a breakout mould (`moulds.ts`): not a
   * solder joint — nothing to select or delete; `joints` is empty.
   */
  mould?: 'in' | 'through';
  /**
   * The joint is a docked connector's own solder joint on its board (or a
   * strap between two of its pins): kept in the design and the inspector,
   * not drawn.
   */
  docked?: boolean;
  /**
   * The joint is a breakout's own solder joint onto a connector it houses
   * (`BreakoutInstance.housed` — a jack inset in the
   * mould, say): kept in the design and the inspector, not drawn — the jack
   * is drawn as part of the mould itself, with no lead reaching it.
   */
  housed?: boolean;
  /**
   * A same-part bridge: drawn by its part's ground bus,
   * not as a wire — the edge is kept (hidden, not selectable, not deletable)
   * so every joint still has exactly one edge.
   */
  bridge?: boolean;
  /**
   * One braid of a ground pigtail (: every braid runs on
   * its own to the pad): the pigtail's terminal key — the hover id its
   * braids share — and the braid, so unsoldering this edge takes just that
   * braid out of the twist.
   */
  braid?: { pigtail: string; segment: string; end: 'a' | 'b'; id: string; member: string };
  /**
   * The ends that show a re-pin grip: set by the editor
   * on the selected wire when it can be edited, never by the derivation.
   */
  grips?: 'source' | 'target' | 'both';
};

export type EditorEdge = Edge<EditorEdgeData>;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export const NODE_METRICS = {
  /** the width a node of each kind starts at; its content may widen it */
  width: NODE_BASE_WIDTH,
  /** clear air between two columns */
  columnGap: 96,
  /** clear air between two nodes stacked in one column */
  rowGap: 40,
} as const;

/**
 * The class the header carries, and the only surface a node is dragged by.
 *
 * Every row of a node is dense with handles (React Flow marks those `nodrag`,
 * so a pin swallows the gesture that would have moved the part) and with click
 * targets of the editor's own. Naming the header as the node's `dragHandle`
 * makes "grab it here" a fact of the node rather than a matter of hitting a gap
 * between two pins — see.
 */
export const NODE_DRAG_HANDLE = '.cs-node-head';

export interface AutoLayout {
  positions: Record<string, XY>;
  columns: Record<string, number>;
}

type Graph = Ranks;

/**
 * The columns (`ranks.ts`: end `a` left, end `b` right, parts on their
 * wire's side). `alias` folds an instance into another (a docked connector
 * into its board): its joints count as the board's, and it takes the
 * board's column.
 */
function graphOf(design: CableDesign, db: Db, alias: ReadonlyMap<string, string> = new Map()): Graph {
  // a breakout mould takes a column of its own between its trunk and its legs
  return designRanks(rankView(canvasView(design, db)), alias, mouldIds(design));
}

/**
 * Place the columns: each one as wide as its widest node, each node stacked
 * under the last with `rowGap` of clear air, the whole column centred on the
 * band so a short column sits beside a tall one rather than under its top edge.
 *
 * The sizes come from `estimateNodeSize`, which is also the width the node is
 * *rendered* at — so two boxes this routine keeps apart are two boxes the
 * browser keeps apart. Deterministic: same design, same numbers, every time.
 */
function packColumns(
  graph: Graph,
  sizes: Map<string, NodeSize>,
  docked: ReadonlySet<string> = new Set(),
): Record<string, XY> {
  const byColumn = new Map<number, string[]>();
  for (const id of graph.order) {
    // a docked connector rides inside its board's box
    if (docked.has(id)) continue;
    const column = graph.columns[id] ?? 0;
    const bucket = byColumn.get(column);
    if (bucket === undefined) byColumn.set(column, [id]);
    else bucket.push(id);
  }

  const fallback: NodeSize = { width: NODE_BASE_WIDTH.connector, height: 120 };
  const positions: Record<string, XY> = {};
  let x = 0;
  for (const column of [...byColumn.keys()].sort((p, q) => p - q)) {
    const ids = byColumn.get(column) ?? [];
    const boxes = ids.map((id) => sizes.get(id) ?? fallback);
    const stack =
      boxes.reduce((total, box) => total + box.height, 0) +
      NODE_METRICS.rowGap * Math.max(ids.length - 1, 0);
    let y = Math.round(-stack / 2);
    let width = 0;
    ids.forEach((id, at) => {
      const box = boxes[at] ?? fallback;
      positions[id] = { x, y };
      y += box.height + NODE_METRICS.rowGap;
      width = Math.max(width, box.width);
    });
    x += width + NODE_METRICS.columnGap;
  }
  return positions;
}

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

export interface DeriveOptions {
  /** dragged-node overrides; anything missing falls back to `autoLayout` */
  positions?: Record<string, XY>;
  columns?: Record<string, number>;
  selectedTerminalKey?: string;
  /** terminal keys on the net of the current selection */
  netKeys?: ReadonlySet<string>;
  selectedInstanceId?: string;
  selectedJointIndex?: number;
  /** several joints selected at once (a ground bundle) */
  selectedJoints?: readonly number[];
  /** board artwork; without it every PCBA is drawn as its pin list */
  depictions?: DepictionSource | undefined;
}

/** Every terminal key a joint lands on. */
export function jointedKeys(joints: Joint[]): Set<string> {
  const keys = new Set<string>();
  for (const joint of joints) {
    keys.add(terminalKey(joint.a));
    keys.add(terminalKey(joint.b));
    // the carrier hole a joint is made through is soldered too
    if (joint.through !== undefined) keys.add(terminalKey(joint.through));
  }
  return keys;
}

interface RowContext {
  used: Set<string>;
  /** keys soldered only by same-part joints (see `TerminalRow.bridgedOnly`) */
  bridgedOnly: Set<string>;
  depictions?: DepictionSource | undefined;
  selectedTerminalKey?: string | undefined;
  netKeys?: ReadonlySet<string> | undefined;
  /** joint indices currently selected (a bridge's `selected`) */
  selectedJoints: ReadonlySet<number>;
}

function makeRow(
  context: RowContext,
  ref: TerminalRef,
  fields: {
    label?: string | undefined;
    role: TerminalRole;
    side: 'left' | 'right';
    color?: string | undefined;
    dir?: TerminalRow['dir'] | undefined;
  },
): TerminalRow {
  const key = terminalKey(ref);
  return {
    key,
    terminal: ref.terminal,
    role: fields.role,
    side: fields.side,
    used: context.used.has(key),
    onSelectedNet: context.netKeys?.has(key) ?? false,
    selected: context.selectedTerminalKey === key,
    ...(context.bridgedOnly.has(key) ? { bridgedOnly: true as const } : {}),
    ...(ref.end === undefined ? {} : { end: ref.end }),
    ...(fields.label === undefined ? {} : { label: fields.label }),
    ...(fields.color === undefined ? {} : { color: fields.color }),
    ...(fields.dir === undefined ? {} : { dir: fields.dir }),
  };
}

/** The direction a connector's interface gives a pin, when it has an interface that says. */
function pinDirection(db: Db, def: { interface?: string } | undefined, pin: string): TerminalRow['dir'] {
  if (def?.interface === undefined) return undefined;
  return (db.interfaces ?? []).find((iface) => iface.id === def.interface)?.pins[pin]?.dir;
}

/** One instance, drawn — everything a node needs except where it sits. */
interface NodeEntry {
  id: string;
  kind: EditorNodeKind;
  data: EditorNodeData;
}

/**
 * The node data of every instance, in one pass.
 *
 * Both callers need this and neither may compute it differently: the canvas
 * renders it, and `autoLayout` measures it (`estimateNodeSize` reads node data,
 * not the definitions, so the box it reserves is the box that draws).
 */
function nodeDataOf(
  design: CableDesign,
  db: Db,
  columns: Record<string, number>,
  context: RowContext,
): NodeEntry[] {
  const entries: NodeEntry[] = [];
  const flips = segmentFlips(design, columns);
  // moulds next: a connector a breakout houses is drawn
  // inside its mould's own box, which only exists once the mould's data does
  const mouldEntries: NodeEntry[] = mouldNodes(design, db).map((mould) => ({
    id: mould.id,
    kind: MOULD_KIND,
    data: mould.data,
  }));
  const housedIndex = new Map<string, { mouldId: string; mouldData: MouldNodeData; item: MouldHoused }>();
  for (const entry of mouldEntries) {
    if (entry.data.kind !== 'breakout') continue;
    for (const item of entry.data.housed) housedIndex.set(item.instanceId, { mouldId: entry.id, mouldData: entry.data, item });
  }
  // boards: a connector mounted on one is drawn in its dock bay, which only
  // exists once the board's art does
  const boards = pcbaEntries(design, db, columns, context, flips);
  const docked = new Map<string, NodeEntry>();
  for (const entry of boards) {
    if (entry.data.kind !== 'pcba' || entry.data.board === undefined) continue;
    for (const dock of entry.data.board.docks) {
      if (!dock.id.startsWith(INTEGRATED)) docked.set(dock.id, entry);
    }
  }
  const artKeys: string[] = [];
  const tail: NodeEntry[] = [];
  const mounts = mountsOf(design);

  for (const instance of design.instances.connectors) {
    const def = findConnector(db, instance.def);
    // its pins face the columns most of its joints go to (`facingByColumns`)
    const side: 'left' | 'right' = facingByColumns(design, instance.id, columns);
    const board = docked.get(instance.id);
    const boardData = board?.data.kind === 'pcba' ? board.data : undefined;
    const housedBy = housedIndex.get(instance.id);
    // housed in a mould: its opening faces the same way the legs run
    // (outward) — the mould already drew its art facing
    // that way, so it is reused rather than drawn again
    const facing: Facing = housedBy !== undefined ? 'right' : (boardData?.cableFacing ?? side);
    const title = def?.label ?? instance.def;
    const art =
      housedBy !== undefined ? housedBy.item.art : def === undefined ? undefined : connectorArt({ def, facing, ...bodyOf(db, def) });
    const data: ConnectorNodeData = {
      kind: 'connector',
      instanceId: instance.id,
      def: instance.def,
      title,
      subtitle:
        def === undefined
          ? 'unknown connector definition'
          : [def.family, def.gender].filter((part) => part !== undefined).join(' · '),
      missingDef: def === undefined,
      rows: (def?.pins ?? []).map((pin) =>
        makeRow(context, { instance: instance.id, terminal: pin.id }, {
          label: pin.label,
          role: 'pin',
          side: art === undefined ? side : facing,
          dir: pinDirection(db, def, pin.id),
        }),
      ),
      ...(instance.role === undefined ? {} : { role: instance.role }),
      ...(instance.note === undefined ? {} : { note: instance.note }),
    };
    if (art === undefined) {
      entries.push({ id: instance.id, kind: 'connector', data });
      continue;
    }
    for (const row of data.rows) if (row.used) artKeys.push(row.key);
    const dock =
      housedBy !== undefined
        ? mouldDockOf(housedBy.mouldId, housedBy.mouldData, housedBy.item)
        : board === undefined || boardData?.board === undefined
          ? undefined
          : dockOf(instance.id, board.id, boardData, boardData.board, mounts.get(instance.id)?.prefixes);
    const layout = dock === undefined ? connectorArtLayout(instance.id, title, art) : undefined;
    // a free face fans its wired pins out to their own exit slots
    const fan =
      layout === undefined
        ? undefined
        : connectorFan(
            layout,
            data.rows.filter((row) => row.used && row.bridgedOnly !== true).map((row) => row.terminal),
            facing,
          );
    const drawn: ConnectorNodeData = {
      ...data,
      ...(layout !== undefined
        ? { art: layout, ...(fan === undefined ? {} : { fan }) }
        : { art: housedBy?.item.layout ?? dockedLayout(art, dockCaption(art, instance.id)), ...(dock === undefined ? {} : { dock }) }),
    };
    if (drawn.dock === undefined) entries.push({ id: instance.id, kind: 'connector', data: drawn });
    else tail.push({ id: instance.id, kind: 'connector', data: drawn });
  }

  for (const instance of design.instances.segments) {
    const def = findWire(db, instance.def);
    const flipped = flips.has(instance.id);
    //: a bonded screen other than its set's
    // representative gets no row/port here either — the same fold
    // `endFaceLayout`'s terminals apply, so the fallback (no documented
    // face) draws the same way as `wire-art.ts` does when there is one.
    const dropped = def === undefined ? new Set<string>() : bondFoldedPaths(def);
    const elements: ElementRow[] =
      def === undefined
        ? []
        : elementPaths(def.structure)
            // a breakout run carries only its own core (`SegmentInstance.scope`)
            .filter((entry) => isElectricalElement(entry.element) && !dropped.has(entry.path) && inScope(instance, entry.path))
            .map((entry) => {
              const role = elementRole(entry.element);
              const color = elementPaint(entry.element);
              // a bonded multi-core mass's representative is all of its shielding
              const label = representativeLabel(def, entry.path) ?? entry.element.label;
              const row = (end: 'a' | 'b', side: 'left' | 'right'): TerminalRow =>
                makeRow(
                  context,
                  { instance: instance.id, terminal: entry.path, end },
                  { label, role, side, color },
                );
              return {
                path: entry.path,
                role,
                color,
                a: row('a', endFacing('a', flipped)),
                b: row('b', endFacing('b', flipped)),
                ...(label === undefined ? {} : { label }),
              };
            });
    const data: SegmentNodeData = {
      kind: 'segment',
      instanceId: instance.id,
      def: instance.def,
      // never the manufacturer on the canvas — the
      // maker stays inside the wire's own detail view in the Library
      title: def === undefined ? instance.def : wireDisplayName(db, instance.def),
      subtitle: def?.partNumber ?? def?.specRef ?? 'wire stock',
      missingDef: def === undefined,
      elements,
      ...(instance.role === undefined ? {} : { role: instance.role }),
      ...(instance.lengthMm === undefined ? {} : { lengthMm: instance.lengthMm }),
      ...(flipped ? { flipped } : {}),
    };
    // a run out of a mould draws as its rows: the stock's cut face is the whole trunk's
    const art = instance.scope === undefined ? wireArtOf(instance.id, data, def) : undefined;
    entries.push({
      id: instance.id,
      kind: 'segment',
      data: art === undefined ? data : { ...data, wire: art },
    });
  }

  for (const instance of design.instances.components) {
    const def = findComponent(db, instance.def);
    const terminals = def?.terminals ?? [];
    const data: ComponentNodeData = {
      kind: 'component',
      instanceId: instance.id,
      def: instance.def,
      title: def?.label ?? instance.def,
      subtitle: def?.partNumber ?? instance.def,
      componentKind: def?.kind ?? 'other',
      missingDef: def === undefined,
      rows: terminals.map((terminal, index) =>
        makeRow(context, { instance: instance.id, terminal: terminal.id }, {
          label: terminal.label ?? terminal.polarity,
          role: 'lead',
          side: index === 0 ? 'left' : 'right',
        }),
      ),
      ...(def?.value === undefined ? {} : { value: def.value }),
      ...(instance.note === undefined ? {} : { note: instance.note }),
    };
    entries.push({ id: instance.id, kind: 'component', data });
  }

  for (const instance of design.instances.subassemblies ?? []) {
    entries.push({ id: instance.id, kind: 'subassembly', data: subassemblyData(design, db, instance.id, columns, context) });
  }

  // a board's integrated connector: its pins reach the cable through the board
  for (const entry of boards) {
    if (entry.data.kind !== 'pcba' || entry.data.integratedArt === undefined) continue;
    for (const item of entry.data.integratedArt) {
      for (const row of entry.data.integrated) {
        if (row.terminal.startsWith(`${item.prefix}.`)) artKeys.push(row.key);
      }
    }
  }
  // breakout moulds before `tail`: a housed connector's
  // `parentId` (below) must name a node already in the array
  entries.push(...boards, ...mouldEntries, ...tail);
  return withBridges(design, paintThrough(design, db, paintPins(entries, pinColours(design, db, artKeys))), context.selectedJoints);
}

/** A sub-assembly's block: its ports as rows, grouped by end, facing the columns its joints go to. */
function subassemblyData(design: CableDesign, db: Db, id: string, columns: Record<string, number>, context: RowContext): SubassemblyNodeData {
  const instance = (design.instances.subassemblies ?? []).find((s) => s.id === id)!;
  const opened = placedDesign(db, instance);
  const placed = opened?.ok === true ? opened.placed.design : undefined;
  const side: 'left' | 'right' = facingByColumns(design, id, columns);
  const ports = portsOfSubassembly(design, db, id);
  const rows: TerminalRow[] = [];
  const groups: SubassemblyNodeData['groups'] = [];
  if (ports !== undefined) {
    for (const port of ports) {
      const last = groups[groups.length - 1];
      if (last === undefined || last.label !== port.groupLabel) groups.push({ label: port.groupLabel, start: rows.length, count: 1 });
      else last.count += 1;
      rows.push(makeRow(context, { instance: id, terminal: port.id }, { label: port.label, role: port.kind === 'lead' ? 'conductor' : 'pin', side }));
    }
  } else {
    // not opened: what this design's joints land on, so its edges still draw
    const landed = [...new Set(design.joints.flatMap((j) => [j.a, j.b, ...(j.through === undefined ? [] : [j.through])]).filter((r) => r.instance === id).map((r) => r.terminal))].sort();
    if (landed.length > 0) groups.push({ label: 'ports (design not loaded)', start: 0, count: landed.length });
    for (const terminal of landed) rows.push(makeRow(context, { instance: id, terminal }, { role: 'pin', side }));
  }
  return {
    kind: 'subassembly',
    instanceId: id,
    def: instance.def,
    title: placed?.label ?? instance.def,
    subtitle: instance.rev === undefined ? 'working copy' : `Rev ${instance.rev}`,
    rows,
    groups,
    missingDef: ports === undefined,
    ...(instance.role === undefined ? {} : { role: instance.role }),
    ...(placed?.productRef === undefined ? {} : { partNumber: placed.productRef }),
    ...(instance.rev === undefined ? {} : { rev: instance.rev }),
  };
}

/**
 * A board pad a docked plug's pin lands on through a carrier hole
 * reads landed in its net's paint: nothing is drawn to it, so the pad says it.
 */
function paintThrough(design: CableDesign, db: Db, entries: NodeEntry[]): NodeEntry[] {
  const mounts = mountsOf(design);
  const landed = new Set<string>();
  for (const joint of design.joints) {
    if (joint.through === undefined || !isDockedJoint(joint, mounts)) continue;
    // the end that is not the docked plug: the board pad beneath the hole
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mounts.get(mine.instance)?.board === joint.through.instance) landed.add(terminalKey(other));
    }
  }
  if (landed.size === 0) return entries;
  const paint = netPainter(design, db);
  const cssOf = (key: string): string => {
    const net = paint(key);
    return net === undefined ? '' : net.kind === 'ground' ? GROUND_CSS : conductorCss(net.colorName);
  };
  return entries.map((entry) => {
    if (entry.data.kind !== 'pcba' || !entry.data.pads.some((row) => landed.has(row.key))) return entry;
    const pads = entry.data.pads.map((row) => (landed.has(row.key) ? { ...row, through: cssOf(row.key) } : row));
    return { ...entry, data: { ...entry.data, pads } };
  });
}

/**
 * Each connector's and board's same-part joints, as its bridges — the ground
 * bus it draws in place of edges.
 */
function withBridges(design: CableDesign, entries: NodeEntry[], selected: ReadonlySet<number>): NodeEntry[] {
  const byPart = new Map<string, Bridge[]>();
  design.joints.forEach((joint, index) => {
    if (joint.a.instance !== joint.b.instance) return;
    const list = byPart.get(joint.a.instance) ?? [];
    list.push({
      a: terminalKey(joint.a),
      b: terminalKey(joint.b),
      index,
      selected: selected.has(index),
      ...(joint.note === undefined ? {} : { note: joint.note }),
    });
    byPart.set(joint.a.instance, list);
  });
  if (byPart.size === 0) return entries;
  return entries.map((entry) => {
    const bridges = byPart.get(entry.id);
    if (bridges === undefined || (entry.data.kind !== 'connector' && entry.data.kind !== 'pcba')) return entry;
    if (entry.data.kind === 'pcba' && entry.data.board === undefined) return entry;
    return { ...entry, data: { ...entry.data, bridges } };
  });
}

/** Whether every joint of a link is a same-part bridge on a part that draws its bus (`buses`). */
function isBridgeLink(design: CableDesign, joints: readonly number[], buses: ReadonlySet<string>): boolean {
  return (
    joints.length > 0 &&
    joints.every((index) => {
      const joint = design.joints[index];
      return joint !== undefined && joint.a.instance === joint.b.instance && buses.has(joint.a.instance);
    })
  );
}

/**
 * The parts that draw their bridges as a bus: every connector (its face or
 * its pin list) and a board drawn as itself. A board drawn as its pin list
 * keeps its bridges as edges — its two columns have no room for a bus.
 */
function busParts(entries: readonly NodeEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.data.kind === 'connector' || (entry.data.kind === 'pcba' && entry.data.board !== undefined))
      .map((entry) => entry.id),
  );
}

/** The PCBA entries, each board drawn with its docks. */
function pcbaEntries(
  design: CableDesign,
  db: Db,
  columns: Record<string, number>,
  context: RowContext,
  flips: ReadonlySet<string>,
): NodeEntry[] {
  const entries: NodeEntry[] = [];
  for (const instance of design.instances.pcbas) {
    const def = findPcba(db, instance.def);
    // the cable-side pads face the wire, the integrated connector away from it;
    // a carrier board faces the board beyond it, its plug docked on
    // the far edge
    const cableFacing = carrierFacing(design, instance.id, columns) ?? cableFacingOf(design, instance.id, columns, flips);
    const away: Facing = cableFacing === 'left' ? 'right' : 'left';
    const integrated: TerminalRow[] = [];
    for (const carried of def?.integratedConnectors ?? []) {
      const connector = findConnector(db, carried.connectorDefId);
      for (const pin of connector?.pins ?? []) {
        integrated.push(
          makeRow(
            context,
            { instance: instance.id, terminal: `${carried.terminalPrefix}.${pin.id}` },
            { label: pin.label, role: 'integrated-pin', side: away },
          ),
        );
      }
    }
    const data: PcbaNodeData = {
      kind: 'pcba',
      instanceId: instance.id,
      def: instance.def,
      title: def?.partNumber ?? instance.def,
      subtitle:
        def === undefined
          ? 'unknown PCBA definition'
          : [def.revision, def.build].filter((part) => part !== undefined).join(' · '),
      missingDef: def === undefined,
      pads: (def?.terminals ?? []).map((pad) =>
        makeRow(context, { instance: instance.id, terminal: pad.id }, {
          label: pad.label,
          role: 'pad',
          side: cableFacing,
        }),
      ),
      integrated,
      cableFacing,
      ...(def?.revision === undefined ? {} : { revision: def.revision }),
      ...(def?.build === undefined ? {} : { build: def.build }),
      ...(instance.note === undefined ? {} : { note: instance.note }),
    };
    const { requests, integratedArt } =
      def === undefined || context.depictions === undefined
        ? { requests: [], integratedArt: [] }
        : dockRequests(design, db, instance.id, def, cableFacing);
    const board =
      def === undefined || context.depictions === undefined
        ? undefined
        : boardArtFor(data, context, cableFacing, requests, connectorSideFacings(design, instance.id, columns));
    const drawn = board?.docks.some((dock) => dock.id.startsWith(INTEGRATED)) === true;
    entries.push({
      id: instance.id,
      kind: 'pcba',
      data:
        board === undefined
          ? data
          : {
              ...data,
              board,
              ...(drawn
                ? { integratedArt: integratedArt.filter((item) => board.docks.some((dock) => dock.id === item.id)) }
                : {}),
            },
    });
  }

  return entries;
}

/** A segment's art at a given face turn (`breakout.ts` chooses it). */
function wireArtOf(
  instanceId: string,
  data: SegmentNodeData,
  def: ReturnType<typeof findWire>,
  rotation?: Record<WireEnd, number>,
): WireArt | undefined {
  if (def === undefined) return undefined;
  return wireArt({
    instanceId,
    wire: def,
    lengthMm: data.lengthMm,
    minWidth: artHeadWidth(instanceId, data.title, wireHeadMeta(data)),
    flip: data.flipped,
    ...(rotation === undefined ? {} : { rotation }),
  });
}

/**
 * The segments drawn with end `b` on the left: those whose `b` end is
 * soldered to parts in earlier columns than the parts on their `a` end (an
 * audio whip whose `b` end lands on the console board). With only one end
 * soldered, that end is compared with the segment's own column.
 */
export function segmentFlips(design: CableDesign, columns: Record<string, number>): Set<string> {
  const flips = new Set<string>();
  for (const segment of design.instances.segments) {
    const sums = { a: 0, b: 0 };
    const counts = { a: 0, b: 0 };
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== segment.id || mine.end === undefined) continue;
        const column = columns[other.instance];
        if (column === undefined) continue;
        sums[mine.end] += column;
        counts[mine.end] += 1;
      }
    }
    const own = columns[segment.id] ?? 0;
    const a = counts.a === 0 ? undefined : sums.a / counts.a;
    const b = counts.b === 0 ? undefined : sums.b / counts.b;
    const flip =
      a !== undefined && b !== undefined ? b < a : b !== undefined ? b < own : a !== undefined && a > own;
    if (flip) flips.add(segment.id);
  }
  return flips;
}

/**
 * Which side of a board the wire is on. A board soldered to the end a
 * segment draws on its left (`a`, or `b` when flipped) has the wire on its
 * right, and the other way round; a board soldered to no segment falls back
 * to its column, the way connectors do.
 */
function cableFacingOf(
  design: CableDesign,
  instanceId: string,
  columns: Record<string, number>,
  flips: ReadonlySet<string>,
): Facing {
  let vote = 0;
  for (const joint of design.joints) {
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mine.instance !== instanceId || other.end === undefined) continue;
      vote += endFacing(other.end, flips.has(other.instance)) === 'left' ? 1 : -1;
    }
  }
  if (vote !== 0) return vote > 0 ? 'right' : 'left';
  return facingByColumns(design, instanceId, columns);
}

/**
 * A carrier board's facing: toward the board its pads
 * T-join, so the plug it carries docks on the edge away from that board.
 */
function carrierFacing(design: CableDesign, boardId: string, columns: Readonly<Record<string, number>>): Facing | undefined {
  for (const mount of mountsOf(design).values()) {
    if (mount.board !== boardId || mount.beyond === undefined) continue;
    const own = columns[boardId];
    const beyond = columns[mount.beyond];
    if (own === undefined || beyond === undefined || own === beyond) return undefined;
    return beyond > own ? 'right' : 'left';
  }
  return undefined;
}

/**
 * Which way each of a board's connector-side terminals faces, when its joints
 * say so: every other part it is soldered to sits in a
 * column on one side of the board's own. A carrier board between a plug and
 * the next board (the DIN-8 perfboard PCA-00109) then takes the plug's pins
 * on the plug's side and hands its slot pads on toward the board — not both
 * out of the one edge, with every run looping back round the node. A
 * connector mounted on this board, a same-part strap, a joint to a wire, or
 * parts on both sides: no opinion (the terminal faces away from the wire).
 */
export function connectorSideFacings(
  design: CableDesign,
  boardId: string,
  columns: Readonly<Record<string, number>>,
): Map<string, Facing> {
  const own = columns[boardId];
  const out = new Map<string, Facing>();
  if (own === undefined) return out;
  const mountsHere = new Map([...mountsOf(design)].filter(([, mount]) => mount.board === boardId));
  const mounted = new Set(mountsHere.keys());
  const votes = new Map<string, Set<Facing | 'none'>>();
  for (const joint of design.joints) {
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mine.instance !== boardId || !isConnectorTerminal(mine.terminal)) continue;
      // a docked pin stubbed to one of the carrier's own slot pads:
      // the stub is drawn straight, so the pad faces the board it T-joins
      const mount = mountsHere.get(other.instance);
      if (mount?.beyond !== undefined && !underPrefix(mine.terminal, mount.prefixes)) continue;
      const column = columns[other.instance];
      const side: Facing | undefined =
        other.instance === boardId || other.end !== undefined || mounted.has(other.instance) || column === undefined || column === own
          ? undefined
          : column < own
            ? 'left'
            : 'right';
      const bucket = votes.get(mine.terminal) ?? new Set<Facing | 'none'>();
      bucket.add(side ?? 'none');
      votes.set(mine.terminal, bucket);
    }
  }
  for (const [terminal, sides] of votes) {
    const [only] = [...sides];
    if (sides.size === 1 && (only === 'left' || only === 'right')) out.set(terminal, only);
  }
  return out;
}

/**
 * The board art for one PCBA node, or `undefined` to keep the pin list: no
 * gerber depiction, or a terminal this design solders to has no pad on the
 * art (the renderer's rule — a joint must never land on nothing).
 */
function boardArtFor(
  data: PcbaNodeData,
  context: RowContext,
  cableFacing: Facing,
  docks: readonly BoardDockRequest[] = [],
  facings: ReadonlyMap<string, Facing> = new Map(),
): BoardArt | undefined {
  if (context.depictions === undefined) return undefined;
  const rows = [...data.pads, ...data.integrated];
  const art = boardArt({
    instanceId: data.instanceId,
    defId: data.def,
    terminals: rows.map((row) => row.terminal),
    cableFacing,
    depictions: context.depictions,
    ...(docks.length === 0 ? {} : { docks }),
    ...(facings.size === 0 ? {} : { facings }),
  });
  if (art === undefined) return undefined;
  const placed = placedTerminals(art);
  return rows.every((row) => !row.used || placed.has(row.terminal)) ? art : undefined;
}

/* ------------------------------------------------------------------ *
 * Docking
 * ------------------------------------------------------------------ */

/** The dock id prefix of a connector the board is sold with. */
const INTEGRATED = 'integrated:';

/** A connector the design mounts on a board. */
export interface Mount {
  /** the board instance */
  board: string;
  /** the board terminal prefixes its pins land on (`j`, `j1`) */
  prefixes: string[];
  /**
   * The board is a carrier (the DIN-8 perfboard) whose
   * pads T-join this board beyond it; the plug's pins the carrier does not
   * route land there directly.
   */
  beyond?: string;
}

/**
 * The connectors the design mounts on a board — the rule: every joint the
 * connector has to a board goes to **one** board's connector-side terminals
 * (`j.3`, `j1.5`, not a cable pad), and those are at least half of its
 * joints. A DB-23 (all ten pins on `PCA-00116`'s `j.N`) and a multi-out
 * port qualify; so does a mini-DIN whose +5 V pin also runs
 * straight to the wire (that joint keeps its edge). A connector whose pins
 * are wired to the cable is not mounted on anything.
 */
export function mountsOf(design: CableDesign): Map<string, Mount> {
  // the rule lives in layout, shared with the schematic's docked blocks; a
  // plug soldered into a carrier board docks on the carrier
  const out = new Map<string, Mount>(mountedConnectors(design));
  for (const [id, mount] of carriedConnectors(design)) out.set(id, mount);
  return out;
}

/** Does `terminal` sit under one of these prefixes (`j1.3` under `j1`)? */
function underPrefix(terminal: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => terminal.startsWith(`${prefix}.`));
}

/**
 * Is this joint a docked connector's own: to its board's connector side, pin
 * to pin, or made through its board's hole onto the pad beneath (a carried
 * plug's J1-4 / J1-5 — the plug docked and the pad landed show it;
 * there is no line to draw)?
 */
export function isDockedJoint(joint: Joint, mounts: ReadonlyMap<string, Mount>): boolean {
  for (const [mine, other] of [
    [joint.a, joint.b],
    [joint.b, joint.a],
  ] as const) {
    const mount = mounts.get(mine.instance);
    if (mount === undefined) continue;
    if (other.instance === mine.instance) return true;
    if (joint.through?.instance === mount.board) return true;
    if (other.instance === mount.board && isConnectorTerminal(other.terminal) && underPrefix(other.terminal, mount.prefixes)) return true;
  }
  return false;
}

/**
 * What a board's dock bay holds: the connectors the design mounts on it, and
 * the ones its definition says it is sold with — each drawn as itself, lugs
 * (for a profile) toward the board.
 */
function dockRequests(
  design: CableDesign,
  db: Db,
  boardId: string,
  def: NonNullable<ReturnType<typeof findPcba>>,
  cableFacing: Facing,
): { requests: BoardDockRequest[]; integratedArt: IntegratedArt[] } {
  const requests: BoardDockRequest[] = [];
  const integratedArt: IntegratedArt[] = [];
  for (const [id, mount] of mountsOf(design)) {
    if (mount.board !== boardId) continue;
    const instance = design.instances.connectors.find((candidate) => candidate.id === id);
    const connector = instance === undefined ? undefined : findConnector(db, instance.def);
    const art = connector === undefined ? undefined : connectorArt({ def: connector, facing: cableFacing, ...bodyOf(db, connector) });
    if (art === undefined) continue;
    requests.push({ id, prefixes: mount.prefixes, ...dockSize(art, dockCaption(art, id)) });
  }
  for (const carried of def.integratedConnectors ?? []) {
    const connector = findConnector(db, carried.connectorDefId);
    const art = connector === undefined ? undefined : connectorArt({ def: connector, facing: cableFacing, ...bodyOf(db, connector) });
    if (art === undefined) continue;
    const id = `${INTEGRATED}${carried.terminalPrefix}`;
    requests.push({ id, prefixes: [carried.terminalPrefix], ...dockSize(art, dockCaption(art)) });
    integratedArt.push({ id, prefix: carried.terminalPrefix, art });
  }
  return { requests, integratedArt };
}

/** clear of the node's own bottom edge, before a docked connector's stray edge bends back up */
const DOCK_EXIT_GAP = 8;

/** A docked connector's place inside its board's node. */
function dockOf(
  id: string,
  boardId: string,
  data: PcbaNodeData,
  board: BoardArt,
  prefixes?: readonly string[],
): ConnectorDock | undefined {
  const dock = board.docks.find((candidate) => candidate.id === id);
  if (dock === undefined) return undefined;
  // the art area is centred in the board node (`.cs-board-art`, `margin: 0 auto`)
  const size = estimateNodeSize(data);
  const inner = size.width - BOX.border * 2;
  const offset = {
    x: Math.round((BOX.border + Math.max(0, (inner - board.width) / 2) + dock.x) * 100) / 100,
    y: Math.round((BOX.border + BOARD_LAYOUT.head + dock.y) * 100) / 100,
  };
  return {
    board: boardId,
    offset,
    facing: data.cableFacing,
    // the board's absolute edges are `board.x` and `board.x + size.width`;
    // `anchorOf` adds this to the *connector's* own absolute x
    // (`board.x + offset.x`), so each branch below subtracts `offset.x` back
    // out. The dock bay's own outer edge — the near side, where the
    // connector itself sits — not the board's far (cable) side
    //: the opposite of which edge held the wire.
    entryDx: data.cableFacing === 'right' ? -offset.x : size.width - offset.x,
    entryDy: size.height + DOCK_EXIT_GAP - offset.y,
    // the board's other edge — the far (cable) side, where a stray edge's
    // bend actually starts — is `entryDx`'s mirror:
    // whichever branch `entryDx` did not take.
    clearDx: data.cableFacing === 'right' ? size.width - offset.x : -offset.x,
    ...(prefixes === undefined ? {} : { prefixes }),
  };
}

/**
 * A housed connector's place inside its breakout mould:
 * stacked under the mould's own rows and leg notes, centred in the mould's
 * width — `layout-size.ts`'s `mouldBody` reserves exactly this room. Every
 * one of its joints is the mould's own (the trunk conductors it terminates),
 * so — unlike a board-mounted connector — nothing else ever reaches it: the
 * dock-bay geometry below is never exercised, only supplied so the type is
 * whole.
 */
function mouldDockOf(mouldId: string, mouldData: MouldNodeData, item: MouldHoused): ConnectorDock | undefined {
  if (item.art === undefined || item.layout === undefined) return undefined;
  const size = estimateNodeSize(mouldData);
  const before = mouldData.housed.slice(0, mouldData.housed.indexOf(item));
  const priorHeight = before.reduce((sum, h) => sum + (h.layout === undefined ? 0 : h.layout.height + BOX.bodyPadY), 0);
  const top =
    rowsTop(mouldData) + mouldData.rows.length * BOX.row + mouldData.legNotes.length * BOX.lineSmall + priorHeight;
  const x = Math.round(((size.width - item.layout.width) / 2) * 100) / 100;
  return {
    board: mouldId,
    offset: { x, y: Math.round(top * 100) / 100 },
    facing: 'right',
    entryDx: x + item.layout.width,
    entryDy: size.height,
    clearDx: x,
  };
}

/* ------------------------------------------------------------------ *
 * Pin colours
 * ------------------------------------------------------------------ */

export const GROUND_CSS = 'var(--cond-gnd)';

/**
 * The colour each of `keys` (connector pins drawn as art) reaches the cable
 * in: its net's paint (`net-paint.ts`) — a coloured conductor paints the pin
 * its colour, a shield or drain paints it ground. A net no conductor reaches,
 * or one the rule cannot call, no colour (the pin draws as bare metal). The
 * edges between parts are painted by the same rule (`edgeOf`), so a pin and
 * the run leaving it agree.
 */
function pinColours(design: CableDesign, db: Db, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const paint = netPainter(design, db);
  for (const key of keys) {
    const net = paint(key);
    if (net === undefined) continue;
    out.set(key, net.kind === 'ground' ? GROUND_CSS : conductorCss(net.colorName));
  }
  return out;
}

/** Connector art rows (and a drawn integrated connector's) take their pin's colour. */
function paintPins(entries: NodeEntry[], colours: ReadonlyMap<string, string>): NodeEntry[] {
  if (colours.size === 0) return entries;
  return entries.map((entry) => {
    if (entry.data.kind === 'pcba' && entry.data.integratedArt !== undefined) {
      const integrated = entry.data.integrated.map((row) => {
        const color = colours.get(row.key);
        return color === undefined ? row : { ...row, color };
      });
      return { ...entry, data: { ...entry.data, integrated } };
    }
    if (entry.data.kind !== 'connector' || entry.data.art === undefined) return entry;
    const rows = entry.data.rows.map((row) => {
      const color = colours.get(row.key);
      return color === undefined ? row : { ...row, color };
    });
    return { ...entry, data: { ...entry.data, rows } };
  });
}

/** The row flags every derived view shares: what is soldered, what is selected. */
function rowContextOf(design: CableDesign, db: Db, options: DeriveOptions): RowContext {
  // a screen twisted into a landed pigtail is soldered too; one only bonded
  // to a landed mass (the cut drain on the foil) is still physically cut —
  // even after folds it off the canvas as a track/port,
  // its own literal cut/used fact stays what it always was (matching
  // render-svg's own schematic, which draws the same way).
  const used = jointedKeys(design.joints);
  const screens = screenTerminations(design, db);
  for (const [key, how] of screens) if (how === 'pigtail') used.add(key);
  // a conductor passing through or ending in a breakout mould is taken there
  for (const [key, fate] of breakoutFates(design, db)) if (fate.fate !== 'nc') used.add(key);
  const external = jointedKeys(design.joints.filter((joint) => joint.a.instance !== joint.b.instance));
  const bridgedOnly = new Set(
    [...jointedKeys(design.joints.filter((joint) => joint.a.instance === joint.b.instance))].filter(
      (key) => !external.has(key) && !screens.has(key),
    ),
  );
  return {
    used,
    bridgedOnly,
    selectedJoints: selectedJointsOf(options),
    selectedTerminalKey: options.selectedTerminalKey,
    netKeys: options.netKeys,
    depictions: options.depictions,
  };
}

/** Estimated size per instance, keyed by id. */
function sizesOf(entries: readonly NodeEntry[]): Map<string, NodeSize> {
  return new Map(entries.map((entry) => [entry.id, estimateNodeSize(entry.data)]));
}

/** The connectors drawn docked on a board. */
function dockedIds(entries: readonly NodeEntry[]): Set<string> {
  return new Set(dockAliases(entries).keys());
}

/** Docked connector → its board. */
function dockAliases(entries: readonly NodeEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (entry.data.kind === 'connector' && entry.data.dock !== undefined) out.set(entry.id, entry.data.dock.board);
  }
  return out;
}

/**
 * Pack the placed nodes: the joint graph with every docked connector folded
 * into its board, so the board takes the connector's place in the columns.
 */
function packed(design: CableDesign, db: Db, entries: readonly NodeEntry[]): Record<string, XY> {
  const alias = dockAliases(entries);
  return packColumns(graphOf(design, db, alias), sizesOf(entries), new Set(alias.keys()));
}

/** A docked connector's canvas position: its board's, plus its offset in it. */
function withDocks(entries: readonly NodeEntry[], positions: Record<string, XY>): Record<string, XY> {
  const out = { ...positions };
  for (const entry of entries) {
    if (entry.data.kind !== 'connector' || entry.data.dock === undefined) continue;
    const board = out[entry.data.dock.board] ?? { x: 0, y: 0 };
    out[entry.id] = { x: board.x + entry.data.dock.offset.x, y: board.y + entry.data.dock.offset.y };
  }
  return out;
}

/**
 * The ELK graph of a design: one node per drawn box (a docked connector is
 * part of its board's), sized by `estimateNodeSize`; one port per handle an
 * edge leaves, fixed on its node's side at the handle's own height (a pad on
 * a board, a conductor on a wire's cut face, a pin on a connector's face —
 * the docked connector's pins at their place in the board); one edge per
 * joint, oriented by the column constraints (`ranks.ts`), so ELK's layers run
 * the same way the design does.
 */
function elkGraphOf(original: CableDesign, db: Db, entries: readonly NodeEntry[]): { graph: ElkGraphSpec; order: string[] } {
  const alias = dockAliases(entries);
  // the canvas view: moulds wired in as parts of their own (`moulds.ts`)
  const view = canvasView(original, db);
  const design = view.design;
  const ranks = designRanks(rankView(view), alias, mouldIds(original));
  const own = (id: string): string => alias.get(id) ?? id;
  const sizes = sizesOf(entries);
  // each node at the origin: handles relative to its own corner, a docked
  // connector's relative to its board's
  const placed = new Map<string, PlacedNode>(
    entries.map((entry) => [
      entry.id,
      placedNode(
        entry.id,
        entry.data,
        entry.data.kind === 'connector' && entry.data.dock !== undefined ? entry.data.dock.offset : { x: 0, y: 0 },
      ),
    ]),
  );
  const ports = new Map<string, Map<string, ElkPortSpec>>();
  const endOf = (ref: TerminalRef): string => {
    const node = own(ref.instance);
    const size = sizes.get(node);
    const at = placed.get(ref.instance);
    const key = terminalKey(ref);
    const anchor = at === undefined ? undefined : anchorOf(at, key);
    if (anchor === undefined || size === undefined) return node;
    const id = `${node}|${key}`;
    let list = ports.get(node);
    if (list === undefined) {
      list = new Map();
      ports.set(node, list);
    }
    if (!list.has(id)) {
      list.set(id, {
        id,
        x: anchor.facing === 'left' ? 0 : size.width,
        // a fanned connector pin's edge leaves at its exit slot's height
        y: Math.min(size.height, Math.max(0, at?.data.kind === 'connector' ? routeY(anchor) : anchor.y)),
        side: anchor.facing === 'left' ? 'WEST' : 'EAST',
      });
    }
    return id;
  };
  const leftOf = new Set(ranks.constraints.map(([u, v]) => `${u}\u0000${v}`));
  const edges: ElkEdgeSpec[] = [];
  const seen = new Set<string>();
  design.joints.forEach((joint, index) => {
    const a = own(joint.a.instance);
    const b = own(joint.b.instance);
    if (a === b) return;
    const [from, to] = leftOf.has(`${a}\u0000${b}`)
      ? [joint.a, joint.b]
      : leftOf.has(`${b}\u0000${a}`)
        ? [joint.b, joint.a]
        : [];
    if (from === undefined || to === undefined) return;
    const source = endOf(from);
    const target = endOf(to);
    // a ground bundle's members share their pad: one edge says it
    const pair = `${source}\u0000${target}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    edges.push({ id: `joint${index}`, source, target });
  });
  const drawn = new Set(entries.map((entry) => entry.id));
  const order = ranks.order.filter((id) => drawn.has(id) && !alias.has(id));
  const nodes: ElkNodeSpec[] = order.map((id) => {
    const size = sizes.get(id) ?? { width: NODE_BASE_WIDTH.connector, height: 120 };
    return { id, width: size.width, height: size.height, ports: [...(ports.get(id)?.values() ?? [])] };
  });
  return { graph: { nodes, edges }, order };
}

/** ELK's placement of the drawn boxes; a docked connector rides in its board. */
function arranged(design: CableDesign, db: Db, entries: readonly NodeEntry[]): Record<string, XY> {
  const { graph, order } = elkGraphOf(design, db, entries);
  const placed = elkLayout(graph);
  const positions: Record<string, XY> = {};
  for (const id of order) {
    const at = placed[id];
    if (at !== undefined) positions[id] = at;
  }
  return positions;
}

/**
 * Deterministic left→right placement: ELK layered (`elk.ts`) over the
 * columns `ranks.ts` works out — end `a` on the left, every port where its
 * handle is, nodes at their drawn sizes. Same design, same numbers.
 *
 * Purely presentational — the design carries no coordinates — and applied only
 * where the editor has no arrangement of its own: the first time a design is
 * opened, or when the user asks for it with Auto-arrange. Should the engine
 * ever fail, the plain column packing stands in.
 */
export function autoLayout(
  design: CableDesign,
  db: Db,
  depictions?: DepictionSource,
): AutoLayout {
  const graph = graphOf(design, db);
  const entries = nodeDataOf(design, db, graph.columns, rowContextOf(design, db, { depictions }));
  let positions: Record<string, XY>;
  try {
    positions = arranged(design, db, entries);
  } catch {
    positions = packed(design, db, entries);
  }
  return { positions, columns: graph.columns };
}

/**
 * Where a part the user just added should land.
 *
 * Its auto-layout spot is the right *idea* — the column its joints put it in —
 * but the rest of the canvas is wherever the user left it, so that spot may
 * already be occupied. This drops the new node straight down until it is clear
 * of everything already placed, which is what a person does with a part on a
 * bench and is deterministic besides.
 */
export function vacantPosition(
  design: CableDesign,
  db: Db,
  id: string,
  positions: Record<string, XY>,
  depictions?: DepictionSource,
): XY {
  const graph = graphOf(design, db);
  const entries = nodeDataOf(design, db, graph.columns, rowContextOf(design, db, { depictions }));
  const sizes = sizesOf(entries);
  const docked = dockedIds(entries);
  const auto = packed(design, db, entries);
  const at = (other: string): XY => positions[other] ?? auto[other] ?? { x: 0, y: 0 };

  const size = sizes.get(id);
  let spot = at(id);
  if (size === undefined) return spot;

  const taken = entries
    .filter((entry) => entry.id !== id && !docked.has(entry.id))
    .map((entry) => ({ ...at(entry.id), ...(sizes.get(entry.id) ?? size) }));

  for (let guard = 0; guard < 64; guard += 1) {
    const rect = { ...spot, ...size };
    const hits = taken.filter((other) => rectsOverlap(rect, other));
    if (hits.length === 0) return spot;
    const bottom = Math.max(...hits.map((other) => other.y + other.height));
    spot = { x: spot.x, y: bottom + NODE_METRICS.rowGap };
  }
  return spot;
}

/** Everything the canvas draws, computed once: placed node data and the breakout plan. */
interface Plan {
  entries: NodeEntry[];
  positions: Record<string, XY>;
  breakout: BreakoutPlan;
  /** the design as the canvas draws it (`moulds.ts`) */
  view: CanvasView;
}

function selectedJointsOf(options: DeriveOptions): Set<number> {
  const out = new Set<number>(options.selectedJoints ?? []);
  if (options.selectedJointIndex !== undefined) out.add(options.selectedJointIndex);
  return out;
}

function planOf(design: CableDesign, db: Db, options: DeriveOptions): Plan {
  const graph = graphOf(design, db);
  const columns = { ...graph.columns, ...(options.columns ?? {}) };
  const flat = nodeDataOf(design, db, columns, rowContextOf(design, db, options));
  // the design as the canvas draws it: moulds wired in (`moulds.ts`)
  const view = canvasView(design, db);
  const positions = withDocks(flat, {
    ...packed(design, db, flat),
    ...(options.positions ?? {}),
  });
  const placed = new Map<string, PlacedNode>(
    flat.map((entry) => [
      entry.id,
      placedNode(entry.id, entry.data, positions[entry.id] ?? { x: 0, y: 0 }),
    ]),
  );
  // a connector whose pins land on terminals stacked the other way up lists
  // them last to first; same size, so nothing moves
  for (const id of orientConnectors(view.design, placed)) {
    const node = placed.get(id);
    if (node?.data.kind !== 'connector') continue;
    const data: ConnectorNodeData = { ...node.data, rows: [...node.data.rows].reverse(), reversed: true };
    placed.set(id, { ...node, data });
    const at = flat.findIndex((entry) => entry.id === id);
    const entry = flat[at];
    if (entry !== undefined) flat[at] = { ...entry, data };
  }
  const breakout = planBreakouts({
    design: view.design,
    nodes: placed,
    selected: selectedJointsOf(options),
    artFor: (instanceId, rotation) => {
      const entry = flat.find((candidate) => candidate.id === instanceId);
      if (entry?.data.kind !== 'segment') return undefined;
      return wireArtOf(instanceId, entry.data, findWire(db, entry.data.def), rotation);
    },
  });
  // the turned art and its ports replace the flat art the router measured
  const entries = flat.map((entry): NodeEntry => {
    const wire = breakout.wires.get(entry.id);
    if (wire === undefined || entry.data.kind !== 'segment') return entry;
    return { ...entry, data: { ...entry.data, wire: wire.art, breakout: wire.breakout } };
  });
  return { entries, positions, breakout, view };
}

/**
 * The connectors whose edges cross less with their pins listed last to
 * first: the heights their joints land at, read in pin order, have fewer
 * pairs out of order reversed than as they are.
 */
function orientConnectors(design: CableDesign, placed: ReadonlyMap<string, PlacedNode>): string[] {
  const out: string[] = [];
  for (const node of placed.values()) {
    // a connector drawn as itself keeps its pins where the part has them
    if (node.data.kind !== 'connector' || node.data.art !== undefined) continue;
    const index = new Map(node.data.rows.map((row, at) => [row.key, at]));
    const landings: { row: number; y: number }[] = [];
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== node.id || other.instance === node.id) continue;
        const row = index.get(terminalKey(mine));
        const target = placed.get(other.instance);
        const at = target === undefined ? undefined : anchorOf(target, terminalKey(other));
        if (row !== undefined && at !== undefined) landings.push({ row, y: at.y });
      }
    }
    landings.sort((p, q) => p.row - q.row);
    const ys = landings.map((landing) => landing.y);
    if (inversions([...ys].reverse()) < inversions(ys)) out.push(node.id);
  }
  return out;
}

function nodesOf(plan: Plan, options: DeriveOptions): EditorNode[] {
  return plan.entries.map((entry): EditorNode => {
    const selected = options.selectedInstanceId === entry.id;
    // a docked connector is its board's child: React Flow moves it with the
    // board, and it does not move on its own (entries list it after the board)
    if (entry.data.kind === 'connector' && entry.data.dock !== undefined) {
      return {
        id: entry.id,
        type: entry.kind,
        position: entry.data.dock.offset,
        parentId: entry.data.dock.board,
        draggable: false,
        data: entry.data,
        selected,
        ...(entry.data.art?.art.view === 'face' ? { zIndex: 2 } : {}),
      };
    }
    return {
      id: entry.id,
      type: entry.kind,
      position: plan.positions[entry.id] ?? { x: 0, y: 0 },
      // the header, and only the header, moves the part: every row below it is
      // handles and click targets
      dragHandle: NODE_DRAG_HANDLE,
      data: entry.data,
      selected,
      // a mating face sits over its edges, so each one appears from under the
      // part at its pin's height rather than across the other pins
      ...(entry.data.kind === 'connector' && entry.data.art?.art.view === 'face' ? { zIndex: 2 } : {}),
    };
  });
}

/** The React Flow nodes of a design, one per instance. */
export function deriveNodes(
  design: CableDesign,
  db: Db,
  options: DeriveOptions = {},
): EditorNode[] {
  return nodesOf(planOf(design, db, options), options);
}

/** A wire element as the edges see it: its role and colour name. */
export function elementOf(
  design: CableDesign,
  db: Db,
  ref: TerminalRef,
): { role: TerminalRole; colorName?: string; paint: string } | undefined {
  if (ref.end === undefined) return undefined;
  const segment = design.instances.segments.find((instance) => instance.id === ref.instance);
  if (segment === undefined) return undefined;
  const wire = findWire(db, segment.def);
  if (wire === undefined) return undefined;
  const entry = elementPaths(wire.structure).find((candidate) => candidate.path === ref.terminal);
  if (entry === undefined) return undefined;
  const role = elementRole(entry.element);
  const color =
    entry.element.kind === 'conductor' && role === 'conductor'
      ? (entry.element as ConductorElement).color
      : undefined;
  return {
    role,
    paint: elementPaint(entry.element),
    ...(color === undefined ? {} : { colorName: color }),
  };
}

const OUTLINED = new Set(['white', 'black']);

/** A conductor's css paint: the theme token when there is one. */
export function conductorCss(colorName: string): string {
  const name = colorName.toLowerCase();
  return `var(--cond-${name}, ${conductorPaint(name)})`;
}

function edgeOf(
  design: CableDesign,
  db: Db,
  link: Link,
  selected: ReadonlySet<number>,
  boards: ReadonlySet<string>,
  mounts: ReadonlyMap<string, Mount>,
  view?: CanvasView,
  buses: ReadonlySet<string> = new Set(),
  housedJoints: ReadonlySet<number> = new Set(),
  netPaint: (key: string) => NetPaint | undefined = () => undefined,
): EditorEdge | undefined {
  const firstIndex = link.joints[0];
  const first = firstIndex === undefined ? undefined : design.joints[firstIndex];
  if (first === undefined || firstIndex === undefined) return undefined;
  // a mould handle stands for the trunk terminal it carries (`moulds.ts`)
  const real = (ref: TerminalRef): TerminalRef => view?.origin.get(terminalKey(ref)) ?? ref;
  const element = elementOf(design, db, real(first.a)) ?? elementOf(design, db, real(first.b));
  const virtual = view !== undefined && link.joints.every((index) => index >= view.virtualFrom);
  const port = link.port;
  const kind: EditorEdgeKind =
    port?.kind ??
    (link.rowBundle !== undefined
      ? 'ground'
      : element === undefined
      ? 'plain'
      : element.role === 'shield' || element.role === 'drain'
        ? 'ground'
        : 'conductor');
  // a joint between two parts: the colour of the conductor its net reaches
  const net = kind === 'plain' ? (netPaint(terminalKey(real(first.a))) ?? netPaint(terminalKey(real(first.b)))) : undefined;
  const colorName = port?.colorName ?? element?.colorName ?? (net?.kind === 'conductor' ? net.colorName : undefined);
  const chosen = link.joints.filter((index) => selected.has(index)).length;
  const bundle = link.joints.length > 1;
  // one landing joint draws as several edges (a pigtail's braids; a shell on
  // two pads): those carry their handles in the id to stay distinct
  const fanned =
    port?.pigtail !== undefined || link.rowBundle !== undefined || first.a.pad !== undefined || first.b.pad !== undefined;
  const id = bundle
    ? `bundle:${link.source.handle}|${link.target.handle}`
    : fanned
      ? `joint:${terminalKey(first.a)}|${terminalKey(first.b)}|${link.source.handle}|${link.target.handle}`
      : `joint:${terminalKey(first.a)}|${terminalKey(first.b)}`;
  const count =
    port?.kind === 'ground' ? port.members.length : (link.rowBundle ?? link.joints.length);
  const pigtailRef =
    port?.pigtail === undefined ? undefined : parseTerminalKey(port.pigtail.key);
  const braid =
    port?.pigtail === undefined || pigtailRef?.end === undefined || port.members[0] === undefined
      ? undefined
      : {
          pigtail: port.pigtail.key,
          segment: pigtailRef.instance,
          end: pigtailRef.end,
          id: port.pigtail.id,
          member: port.members[0].terminal,
        };
  const data: EditorEdgeData = {
    jointIndex: virtual ? -1 : firstIndex,
    joints: view === undefined ? link.joints : link.joints.filter((index) => index < view.virtualFrom),
    ...(virtual ? { mould: first.b.terminal.startsWith('in:') ? ('in' as const) : ('through' as const) } : {}),
    kind,
    count,
    ...(first.note === undefined || bundle ? {} : { note: first.note }),
    ...(net === undefined ? {} : { net: net.kind }),
    ...((kind === 'conductor' || net?.kind === 'conductor') && colorName !== undefined
      ? { paint: conductorCss(colorName), ...(OUTLINED.has(colorName) ? { outlined: true } : {}) }
      : kind === 'conductor' && element !== undefined
        ? { paint: element.paint }
        : {}),
    ...(link.sourceAnchor?.entryX === undefined ? {} : { sourceEntryX: link.sourceAnchor.entryX }),
    ...((link.targetEntryX ?? link.targetAnchor?.entryX) === undefined
      ? {}
      : { targetEntryX: link.targetEntryX ?? link.targetAnchor?.entryX }),
    ...(link.sourceAnchor?.entryY === undefined ? {} : { sourceEntryY: link.sourceAnchor.entryY }),
    ...(link.targetAnchor?.entryY === undefined ? {} : { targetEntryY: link.targetAnchor.entryY }),
    ...(link.sourceAnchor?.clearX === undefined ? {} : { sourceClearX: link.sourceAnchor.clearX }),
    ...(link.targetAnchor?.clearX === undefined ? {} : { targetClearX: link.targetAnchor.clearX }),
    ...(link.sourceAnchor?.approach === undefined ? {} : { sourceApproach: link.sourceAnchor.approach }),
    ...(link.targetAnchor?.approach === undefined ? {} : { targetApproach: link.targetAnchor.approach }),
    ...(link.sourceAnchor?.approachLead === undefined ? {} : { sourceApproachLead: link.sourceAnchor.approachLead }),
    ...(link.targetAnchor?.approachLead === undefined ? {} : { targetApproachLead: link.targetAnchor.approachLead }),
    ...(link.sourceAnchor?.slot === undefined ? {} : { sourceSlot: link.sourceAnchor.slot }),
    ...(link.targetAnchor?.slot === undefined ? {} : { targetSlot: link.targetAnchor.slot }),
    ...(chosen > 0 && chosen < link.joints.length ? { partial: true } : {}),
    ...(link.stub === true ? { stub: true } : {}),
    ...(braid === undefined ? {} : { braid }),
  };
  const docked = link.joints.every((index) => {
    const joint = design.joints[index];
    return joint !== undefined && isDockedJoint(joint, mounts);
  });
  if (docked) data.docked = true;
  const housed = link.joints.length > 0 && link.joints.every((index) => housedJoints.has(index));
  if (housed) data.housed = true;
  const bridge = !virtual && isBridgeLink(design, link.joints, buses);
  if (bridge) data.bridge = true;
  // an edge that lands on a pad *inside* a board, or leaves a port inside a
  // wire's face band, is drawn over the nodes or its last stretch would hide
  const over =
    port !== undefined || boards.has(link.source.instance) || boards.has(link.target.instance);
  return {
    id: virtual ? `mould:${id}` : id,
    source: link.source.instance,
    sourceHandle: link.source.handle,
    target: link.target.instance,
    targetHandle: link.target.handle,
    type: 'breakout',
    selected: !virtual && chosen > 0 && chosen === link.joints.length,
    data,
    ...(virtual || bridge ? { selectable: false, deletable: false, focusable: false } : {}),
    ...(over ? { zIndex: 1 } : {}),
    ...(docked || bridge || housed ? { hidden: true } : {}),
  };
}

/**
 * Every joint that is a breakout's own solder joint onto a connector it
 * houses — only once that connector is actually drawn
 * inside the mould (`data.dock`), the same rule `mounts` below applies to a
 * board-mounted connector's own joints.
 */
function housedJointIndices(design: CableDesign, entries: readonly NodeEntry[]): ReadonlySet<number> {
  const breakouts = design.instances.breakouts ?? [];
  if (breakouts.length === 0) return new Set();
  const drawn = new Set(
    entries.filter((entry) => entry.data.kind === 'connector' && entry.data.dock !== undefined).map((entry) => entry.id),
  );
  const out = new Set<number>();
  design.joints.forEach((joint, index) => {
    for (const breakout of breakouts) {
      const housed = breakout.housed ?? [];
      if (housed.length === 0) continue;
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (housed.includes(mine.instance) && drawn.has(mine.instance) && other.instance === breakout.trunk.segment) {
          out.add(index);
        }
      }
    }
  });
  return out;
}

function edgesOf(design: CableDesign, db: Db, plan: Plan, options: DeriveOptions): EditorEdge[] {
  const selected = selectedJointsOf(options);
  const boards = new Set(
    plan.entries
      .filter(
        (entry) =>
          (entry.data.kind === 'pcba' && entry.data.board !== undefined) ||
          (entry.data.kind === 'connector' && entry.data.dock !== undefined),
      )
      .map((entry) => entry.id),
  );
  // only the connectors actually drawn docked hide their joints
  const mounts = new Map(
    [...mountsOf(design)].filter(([id]) => {
      const entry = plan.entries.find((candidate) => candidate.id === id);
      return entry?.data.kind === 'connector' && entry.data.dock !== undefined;
    }),
  );
  const housedJoints = housedJointIndices(design, plan.entries);
  const edges: EditorEdge[] = [];
  const buses = busParts(plan.entries);
  const netPaint = netPainter(design, db);
  for (const link of plan.breakout.links) {
    const edge = edgeOf(plan.view.design, db, link, selected, boards, mounts, plan.view, buses, housedJoints, netPaint);
    if (edge !== undefined) edges.push(edge);
  }
  return edges;
}

/**
 * The React Flow edges of a design: one per distinct pair of handles. A joint
 * on a wire's face leaves from its end's port column; a ground bundle's
 * joints share one edge. Every joint is drawn by exactly one edge.
 */
export function deriveEdges(
  design: CableDesign,
  db: Db,
  options: DeriveOptions = {},
): EditorEdge[] {
  return edgesOf(design, db, planOf(design, db, options), options);
}

export interface Flow {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

/** The whole canvas, derived in one pass. */
export function deriveFlow(
  design: CableDesign,
  db: Db,
  options: DeriveOptions = {},
): Flow {
  const plan = planOf(design, db, options);
  return { nodes: nodesOf(plan, options), edges: edgesOf(design, db, plan, options) };
}
