/**
 * Derived views: the connectivity graph, galvanic nets, and signal traces.
 *
 * A net is *continuous copper*: joints, the copper of a wire element between
 * its two ends, and plain (no-`via`) PCBA internal links all merge nets.
 * Components and `via`-annotated links are net boundaries — a trace crosses
 * them and annotates the passage.
 */

import {
  findComponent,
  findPcba,
  findWire,
  type CableDesign,
  type Db,
  type Issue,
  type PcbaLinkElement,
  type TerminalRef,
} from './model.ts';
import { linkElements, linkVia } from './link-elements.ts';
import { pigtailMembers, pigtailsAt } from './bonds.ts';
import { inScope, segmentElectricalPaths, throughPairs } from './breakouts.ts';
import { pigtailTerminal } from './model.ts';
import { flattenSubassemblies, hasSubassemblies, portsOfSubassembly, subassembliesOf } from './subassemblies.ts';
import {
  resolveTerminal,
  terminalKey,
  type ResolvedTerminal,
} from './validate.ts';

/** Something a signal passes *through*: a component or a `via` link. */
export interface Passage {
  kind: 'component' | 'pcba-link';
  /** design instance the passage sits in */
  instance: string;
  /** definition id, for components */
  def?: string;
  /** human-readable: "r1 (330 Ω)", "C1 220 µF" */
  description: string;
  /** a board link's parts, as structure (`linkElements`); absent for a component */
  elements?: PcbaLinkElement[];
  note?: string;
}

/**
 * `bond` is copper the stock or its preparation provides: a pigtail to each
 * screen twisted into it, and the members of a bonded set to each other at
 * each end (specs/shield-bonding.md §2.3). Plain copper, no passage.
 * `through` is a conductor passing uncut through a breakout mould: its trunk
 * end and the leg end it continues on are the same copper. `port` is a
 * sub-assembly's port (`lead-1:w1@b:red`) and the terminal it is inside the
 * placed design (`lead-1/w1:red@b`): one terminal under two names.
 */
export type EdgeKind = 'joint' | 'wire' | 'pcba-link' | 'component' | 'bond' | 'through' | 'port';

export interface GraphEdge {
  a: ResolvedTerminal;
  b: ResolvedTerminal;
  kind: EdgeKind;
  /** absent = plain copper, so the edge merges nets */
  passage?: Passage;
  note?: string;
}

export interface DesignGraph {
  nodes: ResolvedTerminal[];
  edges: GraphEdge[];
  issues: Issue[];
}

function compareEdges(x: GraphEdge, y: GraphEdge): number {
  const first = x.a.key.localeCompare(y.a.key);
  if (first !== 0) return first;
  const second = x.b.key.localeCompare(y.b.key);
  if (second !== 0) return second;
  return (x.passage?.description ?? '').localeCompare(
    y.passage?.description ?? '',
  );
}

/**
 * The full connectivity graph of a design. Unresolvable references are
 * skipped and reported in `issues` (never thrown).
 *
 * A design placing sub-assemblies is flattened first
 * (`flattenSubassemblies`): the graph runs through the placed designs' parts
 * (`lead-1/w1:red@b`), and each port of a sub-assembly is tied to the
 * terminal it is by a `port` edge, so a trace from a port, or a net holding
 * one, works on the parent's own terminal names too.
 */
export function buildGraph(design: CableDesign, db: Db): DesignGraph {
  if (hasSubassemblies(design)) return subassemblyGraph(design, db);
  return ownGraph(design, db);
}

function subassemblyGraph(design: CableDesign, db: Db): DesignGraph {
  const flat = flattenSubassemblies(design, db);
  const graph = ownGraph(flat.design, flat.db);
  const edges = [...graph.edges];
  for (const sub of subassembliesOf(design)) {
    for (const port of portsOfSubassembly(design, db, sub.id) ?? []) {
      const ref: TerminalRef = { instance: sub.id, terminal: port.id };
      const target = flat.ports.get(terminalKey(ref));
      if (target === undefined) continue;
      const a = resolveTerminal(design, db, ref);
      const b = resolveTerminal(flat.design, flat.db, target);
      if (!a.ok || !b.ok) continue;
      edges.push({ a: a.terminal, b: b.terminal, kind: 'port' });
    }
  }
  edges.sort(compareEdges);
  const byKey = new Map<string, ResolvedTerminal>();
  for (const edge of edges) {
    if (!byKey.has(edge.a.key)) byKey.set(edge.a.key, edge.a);
    if (!byKey.has(edge.b.key)) byKey.set(edge.b.key, edge.b);
  }
  const nodes = [...byKey.values()].sort((x, y) => x.key.localeCompare(y.key));
  return { nodes, edges, issues: [...flat.issues, ...graph.issues] };
}

function ownGraph(design: CableDesign, db: Db): DesignGraph {
  const issues: Issue[] = [];
  const edges: GraphEdge[] = [];

  const resolve = (ref: TerminalRef): ResolvedTerminal | undefined => {
    const result = resolveTerminal(design, db, ref);
    if (result.ok) return result.terminal;
    issues.push(...result.issues);
    return undefined;
  };

  // 1 · joints — physical solder/crimp facts
  for (const joint of design.joints) {
    const a = resolve(joint.a);
    const b = resolve(joint.b);
    if (a === undefined || b === undefined) continue;
    edges.push({
      a,
      b,
      kind: 'joint',
      ...(joint.note === undefined ? {} : { note: joint.note }),
    });
    // the carrier hole the one solder point is made through is on the same copper
    const through = joint.through === undefined ? undefined : resolve(joint.through);
    if (through !== undefined) edges.push({ a, b: through, kind: 'joint', ...(joint.note === undefined ? {} : { note: joint.note }) });
  }

  // 2 · the copper of each wire element, end a to end b
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const path of segmentElectricalPaths(wire, segment)) {
      const a = resolve({ instance: segment.id, terminal: path, end: 'a' });
      const b = resolve({ instance: segment.id, terminal: path, end: 'b' });
      if (a === undefined || b === undefined) continue;
      edges.push({ a, b, kind: 'wire' });
    }
  }

  // 2b · bonds: each pigtail to its screens, each bonded set tied at each end
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const end of ['a', 'b'] as const) {
      for (const pigtail of pigtailsAt(segment, end)) {
        const tail = resolve({ instance: segment.id, terminal: pigtailTerminal(pigtail.id), end });
        if (tail === undefined) continue;
        for (const path of pigtailMembers(wire, pigtail)) {
          const member = resolve({ instance: segment.id, terminal: path, end });
          if (member !== undefined) edges.push({ a: tail, b: member, kind: 'bond' });
        }
      }
      for (const set of wire.bonded ?? []) {
        const [first, ...rest] = set.members.filter((m) => inScope(segment, m));
        if (first === undefined) continue;
        const hub = resolve({ instance: segment.id, terminal: first, end });
        if (hub === undefined) continue;
        for (const path of rest) {
          const member = resolve({ instance: segment.id, terminal: path, end });
          if (member !== undefined) edges.push({ a: hub, b: member, kind: 'bond' });
        }
      }
    }
  }

  // 2c · conductors passing uncut through a breakout
  for (const pair of throughPairs(design, db)) {
    const a = resolve(pair.from);
    const b = resolve(pair.to);
    if (a === undefined || b === undefined) continue;
    edges.push({ a, b, kind: 'through', note: `through ${pair.breakout}` });
  }

  // 3 · declared PCBA internal continuity
  for (const instance of design.instances.pcbas) {
    const pcba = findPcba(db, instance.def);
    if (pcba === undefined) continue;
    for (const link of pcba.internalLinks) {
      const a = resolve({ instance: instance.id, terminal: link.from });
      const b = resolve({ instance: instance.id, terminal: link.to });
      if (a === undefined || b === undefined) continue;
      const via = linkVia(link);
      edges.push({
        a,
        b,
        kind: 'pcba-link',
        ...(via === undefined
          ? {}
          : {
              passage: {
                kind: 'pcba-link',
                instance: instance.id,
                def: pcba.id,
                description: via,
                elements: linkElements(link),
                ...(link.note === undefined ? {} : { note: link.note }),
              },
            }),
        ...(link.note === undefined ? {} : { note: link.note }),
      });
    }
  }

  // 4 · two-terminal components
  for (const instance of design.instances.components) {
    const component = findComponent(db, instance.def);
    if (component === undefined) continue;
    if (component.terminals.length !== 2) continue;
    const [first, second] = component.terminals;
    if (first === undefined || second === undefined) continue;
    const a = resolve({ instance: instance.id, terminal: first.id });
    const b = resolve({ instance: instance.id, terminal: second.id });
    if (a === undefined || b === undefined) continue;
    const value = component.value ?? component.label;
    edges.push({
      a,
      b,
      kind: 'component',
      passage: {
        kind: 'component',
        instance: instance.id,
        def: component.id,
        description: `${instance.id} (${value})`,
        ...(instance.note === undefined ? {} : { note: instance.note }),
      },
    });
  }

  edges.sort(compareEdges);

  const byKey = new Map<string, ResolvedTerminal>();
  for (const edge of edges) {
    if (!byKey.has(edge.a.key)) byKey.set(edge.a.key, edge.a);
    if (!byKey.has(edge.b.key)) byKey.set(edge.b.key, edge.b);
  }
  const nodes = [...byKey.values()].sort((x, y) => x.key.localeCompare(y.key));

  return { nodes, edges, issues };
}

/* ------------------------------------------------------------------ *
 * Nets
 * ------------------------------------------------------------------ */

export interface Net {
  id: string;
  terminals: ResolvedTerminal[];
}

/** Galvanic nets: union-find over every plain-copper edge. */
export function deriveNets(design: CableDesign, db: Db): Net[] {
  const graph = buildGraph(design, db);

  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let current = parent.get(key) ?? key;
    while (current !== (parent.get(current) ?? current)) {
      current = parent.get(current) ?? current;
    }
    parent.set(key, current);
    return current;
  };
  const union = (x: string, y: string): void => {
    const rootX = find(x);
    const rootY = find(y);
    if (rootX === rootY) return;
    // deterministic: the lexicographically smaller key becomes the root
    if (rootX < rootY) parent.set(rootY, rootX);
    else parent.set(rootX, rootY);
  };

  for (const node of graph.nodes) if (!parent.has(node.key)) parent.set(node.key, node.key);
  for (const edge of graph.edges) {
    if (edge.passage !== undefined) continue;
    union(edge.a.key, edge.b.key);
  }

  const buckets = new Map<string, ResolvedTerminal[]>();
  for (const node of graph.nodes) {
    const root = find(node.key);
    const bucket = buckets.get(root);
    if (bucket === undefined) buckets.set(root, [node]);
    else bucket.push(node);
  }

  const nets = [...buckets.entries()]
    .map(([root, terminals]) => ({
      root,
      terminals: [...terminals].sort((x, y) => x.key.localeCompare(y.key)),
    }))
    .sort((x, y) => x.root.localeCompare(y.root));

  return nets.map((net, index) => ({
    id: `net-${index + 1}`,
    terminals: net.terminals,
  }));
}

/** The net a terminal belongs to, if any. */
export function netForTerminal(
  nets: Net[],
  ref: TerminalRef | string,
): Net | undefined {
  const key = typeof ref === 'string' ? ref : terminalKey(ref);
  return nets.find((net) => net.terminals.some((t) => t.key === key));
}

/* ------------------------------------------------------------------ *
 * Trace
 * ------------------------------------------------------------------ */

export interface TraceStep {
  terminal: ResolvedTerminal;
  /** ordered list of things the signal passed through to get here */
  passages: Passage[];
}

export interface TraceResult {
  from: ResolvedTerminal;
  reached: TraceStep[];
  issues: Issue[];
}

/**
 * Walk outward from a terminal through joints, wire copper, plain and `via`
 * PCBA links, and two-terminal components — annotating each passage. This is
 * what a continuity/test spec derives from.
 *
 * `reached` excludes the starting terminal and holds, per terminal, the
 * passages of the shortest path that got there (ties broken deterministically
 * by terminal key).
 */
export function trace(
  design: CableDesign,
  db: Db,
  from: TerminalRef,
): TraceResult {
  const graph = buildGraph(design, db);
  let start = resolveTerminal(design, db, from);
  if (!start.ok && hasSubassemblies(design)) {
    // a flattened terminal (`lead-1/w1:red@b`) is a node of the graph too
    const known = graph.nodes.find((node) => node.key === terminalKey(from));
    if (known !== undefined) start = { ok: true, terminal: known };
  }
  if (!start.ok) {
    const startRef: ResolvedTerminal = {
      key: terminalKey(from),
      instance: from.instance,
      instanceKind: 'connector',
      def: '',
      terminal: from.terminal,
      ...(from.end === undefined ? {} : { end: from.end }),
    };
    return { from: startRef, reached: [], issues: start.issues };
  }

  interface Link {
    to: ResolvedTerminal;
    passage?: Passage;
  }
  const adjacency = new Map<string, Link[]>();
  const add = (fromKey: string, link: Link): void => {
    const list = adjacency.get(fromKey);
    if (list === undefined) adjacency.set(fromKey, [link]);
    else list.push(link);
  };
  for (const edge of graph.edges) {
    add(edge.a.key, {
      to: edge.b,
      ...(edge.passage === undefined ? {} : { passage: edge.passage }),
    });
    add(edge.b.key, {
      to: edge.a,
      ...(edge.passage === undefined ? {} : { passage: edge.passage }),
    });
  }
  for (const list of adjacency.values()) {
    list.sort((x, y) => {
      const byKey = x.to.key.localeCompare(y.to.key);
      if (byKey !== 0) return byKey;
      return (x.passage?.description ?? '').localeCompare(
        y.passage?.description ?? '',
      );
    });
  }

  const visited = new Set<string>([start.terminal.key]);
  const reached: TraceStep[] = [];
  let frontier: TraceStep[] = [{ terminal: start.terminal, passages: [] }];

  while (frontier.length > 0) {
    const next: TraceStep[] = [];
    for (const step of frontier) {
      for (const link of adjacency.get(step.terminal.key) ?? []) {
        if (visited.has(link.to.key)) continue;
        visited.add(link.to.key);
        const passages =
          link.passage === undefined
            ? step.passages
            : [...step.passages, link.passage];
        const found: TraceStep = { terminal: link.to, passages };
        reached.push(found);
        next.push(found);
      }
    }
    frontier = next;
  }

  reached.sort((x, y) => x.terminal.key.localeCompare(y.terminal.key));
  return { from: start.terminal, reached, issues: graph.issues };
}

/** The trace step for one terminal, if the trace reached it. */
export function reachedTerminal(
  result: TraceResult,
  ref: TerminalRef | string,
): TraceStep | undefined {
  const key = typeof ref === 'string' ? ref : terminalKey(ref);
  return result.reached.find((step) => step.terminal.key === key);
}
