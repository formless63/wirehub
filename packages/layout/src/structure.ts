/**
 * Topology analysis: what is the trunk, what hangs off it, and which side of
 * the drawing every instance belongs on.
 *
 * The canonical model has no notion of "left" or "source column" — it is a
 * flat set of instances plus joints. This module derives the story the
 * schematic tells (source → trunk → destination, with branches dropping
 * below) from the joints alone, deterministically: every scan is over the
 * design's declared array order and every tie is broken by a stable key.
 */

import {
  designInstances,
  findComponent,
  findPcba,
  parseTerminalKey,
  terminalKey,
  type CableDesign,
  type Db,
  type InstanceKind,
  type TerminalRef,
} from '@wirehub/model';

import type { Zone } from './model.ts';

/** One `design.joints[i]`, kept with its index so edges stay traceable. */
export interface JointRecord {
  index: number;
  a: TerminalRef;
  b: TerminalRef;
  keyA: string;
  keyB: string;
  note?: string;
}

export interface BranchInfo {
  segmentId: string;
  /** the end that ties back into the rest of the design */
  nearEnd: 'a' | 'b';
  farEnd: 'a' | 'b';
  /** which zone the near end lands in */
  hostZone: 'source' | 'dest';
  /** connector/PCBA instances reachable only through the branch's far end */
  blockIds: string[];
  /** the breakout whose leg this is, when its near end sits in the trunk's mould */
  breakout?: string;
}

export interface Topology {
  joints: JointRecord[];
  kindOf: Map<string, InstanceKind>;
  trunkId: string;
  branches: BranchInfo[];
  /** instance id → zone, for connectors, PCBAs and segments */
  zoneOf: Map<string, Zone>;
  sourceBlocks: string[];
  destBlocks: string[];
  /** component instance id → the column it is drawn in */
  componentZone: Map<string, 'source' | 'dest' | 'inline'>;
  /** every terminal key that at least one joint lands on */
  usedTerminals: Set<string>;
  /** how many joints land on each terminal key */
  jointDegree: Map<string, number>;
}

export function jointRecords(design: CableDesign): JointRecord[] {
  return design.joints.map((joint, index) => ({
    index,
    a: joint.a,
    b: joint.b,
    keyA: terminalKey(joint.a),
    keyB: terminalKey(joint.b),
    ...(joint.note === undefined ? {} : { note: joint.note }),
  }));
}

/**
 * Instance id → kind, as a map, because the routing and zoning passes below
 * ask the question once per joint per pass. The enumeration itself is core's
 * (`designInstances`) — which categories exist, and in what order, is a fact
 * about the model, and layout knowing it separately would be a drift waiting
 * to happen.
 */
function instanceKinds(design: CableDesign): Map<string, InstanceKind> {
  return new Map(
    designInstances(design).map((instance) => [instance.id, instance.kind]),
  );
}

/* ------------------------------------------------------------------ *
 * Terminal-level graph, used for crossing-minimising port order
 * ------------------------------------------------------------------ */

/**
 * Adjacency over *terminals*, following everything a fitter would call one
 * connection point: joints, a two-terminal component's own body, and a PCBA's
 * declared internal links. Segment terminals are recorded but never expanded
 * through — a wire's far end is a different place in the drawing.
 */
export interface TerminalGraph {
  adjacency: Map<string, string[]>;
  segmentTerminals: Set<string>;
}

export function buildTerminalGraph(
  design: CableDesign,
  db: Db,
  joints: readonly JointRecord[],
  kinds: Map<string, InstanceKind>,
): TerminalGraph {
  const adjacency = new Map<string, string[]>();
  const link = (x: string, y: string): void => {
    const listX = adjacency.get(x);
    if (listX === undefined) adjacency.set(x, [y]);
    else listX.push(y);
    const listY = adjacency.get(y);
    if (listY === undefined) adjacency.set(y, [x]);
    else listY.push(x);
  };

  for (const joint of joints) link(joint.keyA, joint.keyB);

  for (const instance of design.instances.components) {
    const definition = findComponent(db, instance.def);
    if (definition === undefined || definition.terminals.length !== 2) continue;
    const [first, second] = definition.terminals;
    if (first === undefined || second === undefined) continue;
    link(`${instance.id}:${first.id}`, `${instance.id}:${second.id}`);
  }

  for (const instance of design.instances.pcbas) {
    const definition = findPcba(db, instance.def);
    if (definition === undefined) continue;
    for (const internal of definition.internalLinks) {
      link(`${instance.id}:${internal.from}`, `${instance.id}:${internal.to}`);
    }
  }

  const segmentTerminals = new Set<string>();
  for (const key of adjacency.keys()) {
    const ref = parseTerminalKey(key);
    if (kinds.get(ref.instance) === 'segment') segmentTerminals.add(key);
  }

  return { adjacency, segmentTerminals };
}

/**
 * Mean vertical rank of the wire tracks a terminal is wired to, used to order
 * pin rows so the bundle fans out with as few crossings as possible. Returns
 * `undefined` when the terminal never reaches a wire (an in-hood loop, say).
 */
export function trackBarycenter(
  graph: TerminalGraph,
  start: string,
  rankOf: (key: string) => number | undefined,
  maxDepth = 6,
): number | undefined {
  const visited = new Set<string>([start]);
  let frontier = [start];
  const ranks: number[] = [];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const neighbour of graph.adjacency.get(key) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        if (graph.segmentTerminals.has(neighbour)) {
          const rank = rankOf(neighbour);
          if (rank !== undefined) ranks.push(rank);
          continue; // never route *through* a wire
        }
        next.push(neighbour);
      }
    }
    // deterministic expansion order
    next.sort((x, y) => x.localeCompare(y));
    frontier = next;
  }
  if (ranks.length === 0) return undefined;
  return ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length;
}

/* ------------------------------------------------------------------ *
 * Zones
 * ------------------------------------------------------------------ */

function componentZoneFromLocation(
  location: string | undefined,
): 'source' | 'dest' | 'inline' | undefined {
  if (location === undefined) return undefined;
  const normalized = location.toLowerCase();
  if (normalized.includes('inline')) return 'inline';
  if (normalized.includes('source') || normalized.includes('hood')) {
    return 'source';
  }
  if (normalized.includes('dest') || normalized.includes('head')) {
    return 'dest';
  }
  return undefined;
}

export function analyzeTopology(design: CableDesign, db: Db): Topology {
  const joints = jointRecords(design);
  const kinds = instanceKinds(design);

  const usedTerminals = new Set<string>();
  const jointDegree = new Map<string, number>();
  for (const joint of joints) {
    for (const key of [joint.keyA, joint.keyB]) {
      usedTerminals.add(key);
      jointDegree.set(key, (jointDegree.get(key) ?? 0) + 1);
    }
  }

  /* --- the trunk: the segment the most joints land on --- */
  const segments = design.instances.segments;
  let trunkId = segments[0]?.id ?? '';
  let bestScore = -1;
  for (const segment of segments) {
    const terminals = new Set<string>();
    for (const key of usedTerminals) {
      if (parseTerminalKey(key).instance === segment.id) terminals.add(key);
    }
    if (terminals.size > bestScore) {
      bestScore = terminals.size;
      trunkId = segment.id;
    }
  }

  /* --- seed the two zones off the trunk's two ends --- */
  const zoneOf = new Map<string, Zone>();
  if (trunkId !== '') zoneOf.set(trunkId, 'source');

  const seeds: { instance: string; zone: 'source' | 'dest' }[] = [];
  for (const joint of joints) {
    const pairs: [TerminalRef, TerminalRef][] = [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ];
    for (const [self, other] of pairs) {
      if (self.instance !== trunkId || self.end === undefined) continue;
      if (kinds.get(other.instance) === 'segment') continue;
      seeds.push({ instance: other.instance, zone: self.end === 'a' ? 'source' : 'dest' });
    }
  }

  // multi-source BFS over joints between non-segment instances; source seeds
  // are enqueued first so a tie resolves towards the console end.
  const assigned = new Map<string, 'source' | 'dest'>();
  const queue: { instance: string; zone: 'source' | 'dest' }[] = [
    ...seeds.filter((seed) => seed.zone === 'source'),
    ...seeds.filter((seed) => seed.zone === 'dest'),
  ];
  for (const seed of queue) if (!assigned.has(seed.instance)) assigned.set(seed.instance, seed.zone);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const joint of joints) {
      const pairs: [string, string][] = [
        [joint.a.instance, joint.b.instance],
        [joint.b.instance, joint.a.instance],
      ];
      for (const [self, other] of pairs) {
        if (self !== current.instance) continue;
        if (kinds.get(other) === 'segment') continue;
        if (assigned.has(other)) continue;
        assigned.set(other, current.zone);
        queue.push({ instance: other, zone: current.zone });
      }
    }
  }

  /* --- branches: every segment that is not the trunk --- */
  const branches: BranchInfo[] = [];
  for (const segment of segments) {
    if (segment.id === trunkId) continue;
    const tally = { a: 0, b: 0 };
    const hostVotes = { source: 0, dest: 0 };
    for (const joint of joints) {
      const pairs: [TerminalRef, TerminalRef][] = [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ];
      for (const [self, other] of pairs) {
        if (self.instance !== segment.id || self.end === undefined) continue;
        let zone: 'source' | 'dest' | undefined;
        if (other.instance === trunkId) zone = other.end === 'b' ? 'dest' : 'source';
        else zone = assigned.get(other.instance);
        if (zone === undefined) continue;
        tally[self.end] += 1;
        hostVotes[zone] += 1;
      }
    }
    // a leg of a breakout on the trunk: its near end is the one in the mould,
    // and it hangs off the trunk end the mould is on
    const mould = (design.instances.breakouts ?? []).find(
      (b) => b.trunk.segment === trunkId && b.legs.some((l) => l.segment === segment.id),
    );
    const mouldEnd = mould?.legs.find((l) => l.segment === segment.id)?.end;
    const nearEnd: 'a' | 'b' = mouldEnd ?? (tally.b > tally.a ? 'b' : 'a');
    const farEnd: 'a' | 'b' = nearEnd === 'a' ? 'b' : 'a';
    const hostZone: 'source' | 'dest' =
      mould !== undefined ? (mould.trunk.end === 'b' ? 'dest' : 'source') : hostVotes.dest > hostVotes.source ? 'dest' : 'source';

    // everything reachable only through the far end belongs to the branch
    const blockIds: string[] = [];
    const branchQueue: string[] = [];
    for (const joint of joints) {
      const pairs: [TerminalRef, TerminalRef][] = [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ];
      for (const [self, other] of pairs) {
        if (self.instance !== segment.id || self.end !== farEnd) continue;
        if (kinds.get(other.instance) === 'segment') continue;
        if (assigned.has(other.instance)) continue;
        if (branchQueue.includes(other.instance)) continue;
        branchQueue.push(other.instance);
      }
    }
    for (let head = 0; head < branchQueue.length; head += 1) {
      const instance = branchQueue[head];
      if (instance === undefined) continue;
      const kind = kinds.get(instance);
      if (kind === 'connector' || kind === 'pcba') blockIds.push(instance);
      zoneOf.set(instance, 'branch');
      for (const joint of joints) {
        const pairs: [string, string][] = [
          [joint.a.instance, joint.b.instance],
          [joint.b.instance, joint.a.instance],
        ];
        for (const [self, other] of pairs) {
          if (self !== instance) continue;
          if (kinds.get(other) === 'segment') continue;
          if (assigned.has(other) || branchQueue.includes(other)) continue;
          branchQueue.push(other);
        }
      }
    }
    zoneOf.set(segment.id, 'branch');
    branches.push({ segmentId: segment.id, nearEnd, farEnd, hostZone, blockIds, ...(mould === undefined ? {} : { breakout: mould.id }) });
  }

  /* --- block columns, in declaration order --- */
  const sourceBlocks: string[] = [];
  const destBlocks: string[] = [];
  const blockInstances = [
    ...design.instances.connectors.map((instance) => instance.id),
    ...design.instances.pcbas.map((instance) => instance.id),
  ];
  // a connector a breakout houses draws inside its
  // mould's own outline, never as a block on a lead — see `layout.ts` §8b
  const housedIds = new Set((design.instances.breakouts ?? []).flatMap((b) => b.housed ?? []));
  for (const id of blockInstances) {
    if (zoneOf.get(id) === 'branch') continue;
    const zone = assigned.get(id) ?? 'source';
    zoneOf.set(id, zone);
    if (housedIds.has(id)) continue;
    if (zone === 'source') sourceBlocks.push(id);
    else destBlocks.push(id);
  }

  const componentZone = new Map<string, 'source' | 'dest' | 'inline'>();
  for (const instance of design.instances.components) {
    const fromLocation = componentZoneFromLocation(instance.location);
    const zone = fromLocation ?? assigned.get(instance.id) ?? 'source';
    componentZone.set(instance.id, zone);
    zoneOf.set(instance.id, zone === 'dest' ? 'dest' : 'source');
  }

  return {
    joints,
    kindOf: kinds,
    trunkId,
    branches,
    zoneOf,
    sourceBlocks,
    destBlocks,
    componentZone,
    usedTerminals,
    jointDegree,
  };
}

/* ------------------------------------------------------------------ *
 * Connectors mounted on a board
 * ------------------------------------------------------------------ */

/** A connector the design mounts on a board. */
export interface ConnectorMount {
  /** the board instance */
  board: string;
  /** the board terminal prefixes its pins land on (`j`, `j1`) */
  prefixes: string[];
}

/**
 * The connectors the design mounts on a board — the rule: every joint the
 * connector has to a board goes to **one** board, and its joints to that
 * board's connector-side terminals (`j.3`, `j1.5`: ids with a dot, not a cable
 * pad) are at least one and at least half of all its joints. A DB-23
 * (all ten pins on `PCA-00116`'s `j.N`) and a multi-out port qualify; so does
 * a mini-DIN whose +5 V pin also runs straight to the wire. A
 * connector whose pins are wired to the cable is not mounted on anything.
 *
 * One rule for both drawings: the canvas docks these in its board node's dock
 * bay, the schematic draws them beside the board's connector edge.
 */
export function mountedConnectors(design: CableDesign): Map<string, ConnectorMount> {
  const boards = new Set(design.instances.pcbas.map((instance) => instance.id));
  const out = new Map<string, ConnectorMount>();
  for (const connector of design.instances.connectors) {
    let total = 0;
    let onBoard = 0;
    const landed = new Map<string, Set<string>>();
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== connector.id || other.instance === connector.id) continue;
        total += 1;
        if (!boards.has(other.instance)) continue;
        const prefixes = landed.get(other.instance) ?? new Set<string>();
        landed.set(other.instance, prefixes);
        if (!other.terminal.includes('.')) continue;
        onBoard += 1;
        prefixes.add(other.terminal.slice(0, other.terminal.indexOf('.')));
      }
    }
    const [board, prefixes] = [...landed][0] ?? [];
    if (landed.size !== 1 || board === undefined || prefixes === undefined) continue;
    if (onBoard === 0 || onBoard * 2 < total) continue;
    out.set(connector.id, { board, prefixes: [...prefixes].sort() });
  }
  return out;
}

/** A connector soldered into a carrier board that T-joins the board beyond it. */
export interface CarriedMount extends ConnectorMount {
  /** the board the carrier's pads T-join (the console board `u1` beyond the perfboard) */
  beyond: string;
}

/**
 * The connectors the design solders into a **carrier** board
 * (`BoardFootprint.carrier`, the DIN-8 perfboard PCA-00109 between the plug
 * and the console board) — the rule: the connector's
 * joints go to the carrier, and at most one other board — the board beyond,
 * which the carrier's pads T-join; and the joints to the carrier are at
 * least half of all its joints. `prefixes` are the carrier's terminal
 * prefixes the plug's pins solder into (`j1`, not the slot pads `jp` that
 * only T-join the board beyond; `j1` stays even though its J1-4 / J1-5 also
 * T-join, owner batch 10). A pin the carrier does not route lands on the
 * board beyond directly (none on the DIN-8 perfboard since batch 10).
 *
 * Presentation only: both drawings dock the plug on the carrier and set the
 * carrier beside the board beyond; the design is unchanged. A plug every
 * pin of which solders into the carrier (which `mountedConnectors` would
 * mount on it) is carried too — callers let carried win.
 */
export function carriedConnectors(design: CableDesign): Map<string, CarriedMount> {
  const boards = new Set(design.instances.pcbas.map((instance) => instance.id));
  const out = new Map<string, CarriedMount>();
  for (const connector of design.instances.connectors) {
    // a plug every pin of which solders into the carrier is "mounted" on it too; carried wins
    let total = 0;
    const byBoard = new Map<string, string[]>();
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== connector.id || other.instance === connector.id) continue;
        total += 1;
        if (!boards.has(other.instance)) continue;
        const list = byBoard.get(other.instance) ?? [];
        list.push(other.terminal);
        byBoard.set(other.instance, list);
      }
    }
    if (byBoard.size !== 1 && byBoard.size !== 2) continue;
    // the carrier: the board most of its pins solder into
    const [[carrier, onCarrier], second] = [...byBoard].sort((p, q) => q[1].length - p[1].length || (p[0] < q[0] ? -1 : 1)) as [
      [string, string[]],
      [string, string[]] | undefined,
    ];
    if (onCarrier.length * 2 < total || !onCarrier.every((terminal) => terminal.includes('.'))) continue;
    // the board beyond: the one the carrier's pads T-join (every pin may go
    // through the carrier — the DIN-8 perfboard routes all eight, owner batch
    // 10 — so it need not take any of the plug's own pins)
    const joinedTo = new Map<string, Set<string>>();
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== carrier || other.instance === carrier || !boards.has(other.instance)) continue;
        const set = joinedTo.get(other.instance) ?? new Set<string>();
        set.add(mine.terminal);
        joinedTo.set(other.instance, set);
      }
    }
    const beyond = second?.[0] ?? [...joinedTo].sort((p, q) => q[1].size - p[1].size || (p[0] < q[0] ? -1 : 1))[0]?.[0];
    const joinedBeyond = beyond === undefined ? undefined : joinedTo.get(beyond);
    if (beyond === undefined || joinedBeyond === undefined || joinedBeyond.size === 0) continue;
    // the plug's own prefixes: those with a pad only the plug solders into
    // (`j1`, even when the carrier's own J1-4 / J1-5 also T-join the board
    // beyond); a prefix every pad of which T-joins (`jp`) is the carrier's
    const prefixes = new Set(
      onCarrier.filter((terminal) => !joinedBeyond.has(terminal)).map((terminal) => terminal.slice(0, terminal.indexOf('.'))),
    );
    if (prefixes.size === 0) continue;
    out.set(connector.id, { board: carrier, prefixes: [...prefixes].sort(), beyond });
  }
  return out;
}

/** A board pad a docked plug's pin lands on through a carrier hole (e5c.37). */
export interface ThroughLanding {
  /** the board pad beneath the hole (`u1:jp.4`) */
  pad: string;
  /** the carrier hole the one solder point is made through (`u3:j1.4`) */
  hole: string;
  /** the plug pin (`j1:4`) */
  pin: string;
}

/**
 * The design as the schematic draws it: a joint made
 * `through` a carrier's hole by a plug docked on that carrier is drawn as the
 * pin going into the hole, like every other pin of the plug — the hole IS
 * the board pad's joint (owner 2026-09-29), so no run goes on to the board;
 * the board pad is listed in `landings` and drawn landed instead. Nets are
 * the real design's (the caller derives them from it). Presentation only.
 */
export function throughView(design: CableDesign): { design: CableDesign; landings: ThroughLanding[] } {
  const carried = carriedConnectors(design);
  const landings: ThroughLanding[] = [];
  let changed = false;
  const joints = design.joints.map((joint) => {
    const through = joint.through;
    if (through === undefined) return joint;
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (carried.get(mine.instance)?.board !== through.instance) continue;
      changed = true;
      landings.push({
        pad: `${other.instance}:${other.terminal}`,
        hole: `${through.instance}:${through.terminal}`,
        pin: `${mine.instance}:${mine.terminal}`,
      });
      return { a: mine, b: { instance: through.instance, terminal: through.terminal }, ...(joint.note === undefined ? {} : { note: joint.note }) };
    }
    return joint;
  });
  return { design: changed ? { ...design, joints } : design, landings };
}
