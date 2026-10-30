/**
 * Conductor trace with hop semantics: follow a conductor from a cable end
 * through joints and wire copper into a board's **native nets**
 * (`PcbaNetlist`, read from its board file) and out through its other
 * terminals, classifying every hop:
 *
 * - `copper` — the same piece of copper: a joint, a conductor, a board net,
 *   a bridged jumper, a declared plain link;
 * - `passive` — through a resistor, capacitor, inductor or ferrite (its value
 *   when the source has one); the walk continues on the far side;
 * - `active` — into an IC, transistor, regulator or diode: the walk stops
 *   there and reports it (silicon drives, it does not conduct);
 * - `unknown` — a fact is missing: a board terminal with no native net, a
 *   board with no nets and no declared link, a do-not-populate part, a jumper
 *   or switch whose state nobody declared, a part whose kind the source does
 *   not say. The walk stops: a missing fact never becomes continuity.
 *
 * Facts that disagree (a declared plain link between two terminals the board
 * file puts on different nets, a link declared through a do-not-populate
 * part) surface as `contradiction` findings. Nothing here blocks editing; it
 * only says what the design claims and what it cannot.
 *
 * A board without a netlist is traced through its declared `internalLinks`
 * exactly as `trace()` does, with each link classified the same way.
 * Two occurrences of one board are separate instances, so they trace (and may
 * declare jumper states, `PcbaInstance.partStates`) independently.
 *
 * Pure and deterministic: the cheapest path to each terminal (fewest
 * non-copper hops, then fewest hops, ties by key) wins.
 */

import { boardBuildOf, boardPartsOf, componentCategory } from './board-parts.ts';
import { linkElements } from './link-elements.ts';
import {
  findComponent,
  findPcba,
  type CableDesign,
  type ComponentCategory,
  type Db,
  type Issue,
  type PcbaDefinition,
  type PcbaInstance,
  type PcbaLinkElement,
  type PcbaNetPart,
  type TerminalRef,
} from './model.ts';
import { buildGraph, type EdgeKind } from './nets.ts';
import { flattenSubassemblies, hasSubassemblies } from './subassemblies.ts';
import { resolveTerminal, terminalKey, type ResolvedTerminal } from './validate.ts';

export type HopKind = 'copper' | 'passive' | 'active' | 'unknown';

/** What carried a hop. */
export type HopCarrier = Exclude<EdgeKind, 'pcba-link'> | 'board-link' | 'board-net' | 'board-part';

export interface TraceHop {
  kind: HopKind;
  carrier: HopCarrier;
  /** node keys: a terminal key, or a board net `u1#/A`, or a stopping part `u1#U1` */
  from: string;
  to: string;
  /** the board or component instance the hop is inside */
  instance?: string;
  /** the board net the hop enters (board hops) */
  net?: string;
  /** the part's reference designator (a board part, or a component instance id) */
  ref?: string;
  category?: ComponentCategory;
  value?: string;
  /** plain words: `R1 120 Ω`, `net /A`, `JP1 state not declared` */
  description: string;
}

export interface TracedEnd {
  terminal: ResolvedTerminal;
  /** the hops from the start, in order */
  hops: TraceHop[];
  /** the worst hop on the way: `copper` only when every hop is; `active` when it crossed a declared passage through silicon */
  kind: 'copper' | 'passive' | 'active';
}

export type TraceFindingKind = 'active' | 'unknown' | 'contradiction' | 'open';

export interface TraceFinding {
  kind: TraceFindingKind;
  code: string;
  /** the board or component instance */
  instance?: string;
  ref?: string;
  message: string;
  /** the path that led here (empty for a contradiction found on the board's records) */
  hops: TraceHop[];
}

/** What a trace touched on one board occurrence, for a board view to light. */
export interface BoardTraceView {
  instance: string;
  def: string;
  /** native nets entered */
  nets: string[];
  /** board terminals reached (terminal keys) */
  terminals: string[];
  /** parts crossed or stopped at, with the hop kind */
  parts: { ref: string; kind: HopKind }[];
  /**
   * The path across this board as anchor-to-anchor steps — a terminal (its
   * key) or a part (its ref) at each end — each in the kind of the hop that
   * takes it, so a view can draw the route pad → part → pad.
   */
  segments: { from: BoardAnchor; to: BoardAnchor; kind: HopKind }[];
}

export type BoardAnchor = { terminal: string } | { part: string };

export interface ConductorTrace {
  from: ResolvedTerminal;
  reached: TracedEnd[];
  findings: TraceFinding[];
  boards: BoardTraceView[];
  issues: Issue[];
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

const PASSIVE: readonly ComponentCategory[] = ['resistor', 'capacitor', 'inductor'];
const ACTIVE: readonly ComponentCategory[] = ['ic', 'regulator', 'transistor', 'diode'];

/** A power or ground net by its name: walked as copper, never expanded through decoupling or supply pins. */
export function isSupplyNet(net: string): boolean {
  const name = net.replace(/^\//, '').split('/').pop() ?? '';
  return /^(?:[ADPS]?GND[A-Z0-9_]*|VSS|VEE|VCC[A-Z0-9_]*|VDD[A-Z0-9_]*|VBUS|VIN|VBAT|\+?\d+(?:\.\d+)?V\d*)$/i.test(name);
}

function partWords(ref: string, value: string | undefined, extra?: string): string {
  return [ref, value, extra].filter((w) => w !== undefined && w !== '').join(' ');
}

/** How one element of a declared board link passes a signal. */
function elementKind(element: PcbaLinkElement): HopKind {
  if (element.kind === 'ic') return 'active';
  if (element.kind === 'jumper' || element.kind === 'switch') {
    if (element.state === undefined || /build option|open|unset|undeclared/i.test(element.state)) return 'unknown';
    return element.ohms === 0 || /bridged|closed|fitted/i.test(element.state) ? 'copper' : 'unknown';
  }
  if (element.kind === 'resistor' || element.kind === 'capacitor' || element.kind === 'inductor') return 'passive';
  return 'unknown';
}

const RANK: Readonly<Record<HopKind, number>> = { copper: 0, passive: 1, unknown: 2, active: 3 };

function worst(kinds: readonly HopKind[]): HopKind {
  let out: HopKind = 'copper';
  for (const kind of kinds) if (RANK[kind] > RANK[out]) out = kind;
  return out;
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

interface Arc {
  to: string;
  hop: Omit<TraceHop, 'from' | 'to'>;
  /** the walk does not continue past `to` (an active or unknown hop) */
  stop?: TraceFinding['kind'];
  code?: string;
  message?: string;
  /** a finding to report when the walk crosses this arc (it continues past `to`) */
  note?: { kind: TraceFindingKind; code: string; message: string };
}

interface BoardContext {
  instance: PcbaInstance;
  def: PcbaDefinition;
  /**
   * The build that produced this definition (`Db.boardParts`): a bridged
   * jumper or link reads as closed, an omitted one as open (a part that is not
   * a jumper: do-not-populate), under any state the occurrence declares.
   */
  population?: { bridged: readonly string[]; omitted: readonly string[] };
}

/**
 * Trace a conductor from `from` through cable and board topology. See the
 * module comment for the hop kinds and what stops the walk.
 */
export function traceConductor(design: CableDesign, db: Db, from: TerminalRef): ConductorTrace {
  const flat = hasSubassemblies(design) ? flattenSubassemblies(design, db) : undefined;
  const fd = flat?.design ?? design;
  const fdb = flat?.db ?? db;
  const graph = buildGraph(design, db);

  const nodes = new Map<string, ResolvedTerminal>();
  for (const node of graph.nodes) nodes.set(node.key, node);
  const startKey = terminalKey(from);
  let start = nodes.get(startKey);
  if (start === undefined) {
    const resolved = resolveTerminal(design, db, from);
    if (!resolved.ok) {
      const ref: ResolvedTerminal = { key: startKey, instance: from.instance, instanceKind: 'connector', def: '', terminal: from.terminal, ...(from.end === undefined ? {} : { end: from.end }) };
      return { from: ref, reached: [], findings: [], boards: [], issues: resolved.issues };
    }
    start = resolved.terminal;
    nodes.set(start.key, start);
  }

  const boards = new Map<string, BoardContext>();
  for (const instance of fd.instances.pcbas) {
    const def = findPcba(fdb, instance.def);
    if (def === undefined) continue;
    const entry = boardPartsOf(fdb, def.partNumber, def.revision);
    const build = entry === undefined ? undefined : boardBuildOf(entry, def.id);
    boards.set(instance.id, { instance, def, ...(build === undefined ? {} : { population: { bridged: build.bridged, omitted: build.omitted } }) });
  }
  const native = (instance: string): BoardContext | undefined => {
    const board = boards.get(instance);
    return board?.def.netlist === undefined ? undefined : board;
  };

  const arcs = new Map<string, Arc[]>();
  const add = (a: string, arc: Arc): void => {
    const list = arcs.get(a);
    if (list === undefined) arcs.set(a, [arc]);
    else list.push(arc);
  };
  const both = (a: string, b: string, hop: Arc['hop']): void => {
    add(a, { to: b, hop });
    add(b, { to: a, hop });
  };
  const declaredLinkAt = new Set<string>();

  // 1 · the cable graph, a netlisted board's declared links left to its nets
  for (const edge of graph.edges) {
    if (edge.kind === 'pcba-link') {
      declaredLinkAt.add(edge.a.key);
      declaredLinkAt.add(edge.b.key);
      if (native(edge.a.instance) !== undefined) continue;
      const elements = edge.passage?.elements ?? [];
      if (edge.passage === undefined) {
        both(edge.a.key, edge.b.key, { kind: 'copper', carrier: 'board-link', instance: edge.a.instance, description: `${edge.a.instance} declared link` });
        continue;
      }
      const kind = worst(elements.length === 0 ? ['unknown'] : elements.map(elementKind));
      const hop = { kind, carrier: 'board-link' as const, instance: edge.a.instance, description: `${edge.a.instance} ${edge.passage.description}` };
      if (kind === 'copper' || kind === 'passive') both(edge.a.key, edge.b.key, hop);
      else {
        const message =
          kind === 'active'
            ? `${edge.a.instance}: the declared link ${edge.a.terminal}–${edge.b.terminal} runs through active silicon (${edge.passage.description}); it is not continuity.`
            : `${edge.a.instance}: the declared link ${edge.a.terminal}–${edge.b.terminal} runs through ${edge.passage.description}, whose state or kind is not declared.`;
        const code = kind === 'active' ? 'trace-active-link' : 'trace-unknown-link';
        add(edge.a.key, { to: `${edge.a.instance}#${edge.passage.description}`, hop, stop: kind, code, message });
        add(edge.b.key, { to: `${edge.a.instance}#${edge.passage.description}`, hop, stop: kind, code, message });
      }
      continue;
    }
    if (edge.kind === 'component') {
      const instance = edge.passage?.instance ?? edge.a.instance;
      const component = findComponent(fdb, edge.a.def);
      const category = component === undefined ? 'other' : componentCategory(component);
      const value = component?.value;
      const description = edge.passage?.description ?? instance;
      if (PASSIVE.includes(category)) {
        both(edge.a.key, edge.b.key, { kind: 'passive', carrier: 'component', instance, ref: instance, category, ...(value === undefined ? {} : { value }), description });
      } else {
        const kind: HopKind = ACTIVE.includes(category) ? 'active' : 'unknown';
        const hop = { kind, carrier: 'component' as const, instance, ref: instance, category, ...(value === undefined ? {} : { value }), description };
        const message = kind === 'active' ? `${description} is active (${category}): the trace stops there.` : `${description} is a ${category} whose state is not declared: the trace stops there.`;
        for (const side of [edge.a.key, edge.b.key]) add(side, { to: `${instance}#part`, hop, stop: kind, code: kind === 'active' ? 'trace-active-part' : 'trace-unknown-part', message });
      }
      continue;
    }
    both(edge.a.key, edge.b.key, { kind: 'copper', carrier: edge.kind, description: edge.kind === 'wire' ? `${edge.a.instance} ${edge.a.terminal}` : edge.note ?? edge.kind });
  }

  // 2 · native board nets
  const contradictions: TraceFinding[] = [];
  const terminalNode = (instance: string, terminal: string): string | undefined => {
    const key = terminalKey({ instance, terminal });
    if (nodes.has(key)) return key;
    const resolved = resolveTerminal(fd, fdb, { instance, terminal });
    if (!resolved.ok) return undefined;
    nodes.set(key, resolved.terminal);
    return key;
  };
  for (const [id, board] of [...boards].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const netlist = board.def.netlist;
    if (netlist === undefined) continue;
    const netNode = (net: string): string => `${id}#${net}`;
    for (const [terminal, net] of Object.entries(netlist.terminals).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      const key = terminalNode(id, terminal);
      if (key === undefined) continue;
      both(key, netNode(net), { kind: 'copper', carrier: 'board-net', instance: id, net, description: `${id} net ${net}` });
    }
    for (const part of [...netlist.parts].sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0))) {
      partArcs(id, board, part, netNode, add);
    }
    // declared facts against the board file
    for (const link of board.def.internalLinks) {
      const a = netlist.terminals[link.from];
      const b = netlist.terminals[link.to];
      const elements = linkElements(link);
      if (elements.length === 0 && a !== undefined && b !== undefined && a !== b) {
        contradictions.push({
          kind: 'contradiction',
          code: 'trace-declared-copper-split',
          instance: id,
          message: `${id}: ${board.def.id} declares ${link.from}–${link.to} as plain copper, but its board file puts them on different nets (${a}, ${b}).`,
          hops: [],
        });
      }
      for (const element of elements) {
        const part = element.designator === undefined ? undefined : netlist.parts.find((p) => p.ref === element.designator);
        if (part?.dnp === true) {
          contradictions.push({
            kind: 'contradiction',
            code: 'trace-declared-through-dnp',
            instance: id,
            ref: part.ref,
            message: `${id}: ${board.def.id} declares ${link.from}–${link.to} through ${part.ref}, but its board file marks ${part.ref} do-not-populate.`,
            hops: [],
          });
        }
      }
    }
  }

  for (const list of arcs.values()) {
    list.sort((x, y) => (x.to < y.to ? -1 : x.to > y.to ? 1 : x.hop.description < y.hop.description ? -1 : x.hop.description > y.hop.description ? 1 : 0));
  }

  // 3 · cheapest paths: fewest non-copper hops, then fewest hops, then key
  interface Best {
    cost: number;
    length: number;
    hops: TraceHop[];
  }
  const best = new Map<string, Best>([[start.key, { cost: 0, length: 0, hops: [] }]]);
  const done = new Set<string>();
  const findings = new Map<string, TraceFinding>();
  const better = (a: Best, b: Best | undefined): boolean => b === undefined || a.cost < b.cost || (a.cost === b.cost && a.length < b.length);
  for (;;) {
    let key: string | undefined;
    let current: Best | undefined;
    for (const [candidate, value] of best) {
      if (done.has(candidate)) continue;
      if (current === undefined || better(value, current) || (value.cost === current.cost && value.length === current.length && candidate < (key ?? ''))) {
        key = candidate;
        current = value;
      }
    }
    if (key === undefined || current === undefined) break;
    done.add(key);
    // a supply net is copper to everything on it; only series parts lead off it
    // (a decoupling capacitor or an IC's supply pin is not a signal path)
    const net = key.includes('#') ? key.slice(key.indexOf('#') + 1) : undefined;
    const supplyNet = net !== undefined && isSupplyNet(net);
    for (const arc of arcs.get(key) ?? []) {
      if (supplyNet && arc.hop.carrier === 'board-part' && !isSeries(arc.hop.category)) continue;
      const hop: TraceHop = { ...arc.hop, from: key, to: arc.to };
      const hops = [...current.hops, hop];
      if (arc.stop !== undefined) {
        const id = `${arc.code ?? arc.stop}|${arc.to}`;
        if (!findings.has(id)) findings.set(id, { kind: arc.stop, code: arc.code ?? `trace-${arc.stop}`, ...(arc.hop.instance === undefined ? {} : { instance: arc.hop.instance }), ...(arc.hop.ref === undefined ? {} : { ref: arc.hop.ref }), message: arc.message ?? arc.hop.description, hops });
        continue;
      }
      if (arc.note !== undefined) {
        const id = `${arc.note.code}|${key}|${arc.to}`;
        if (!findings.has(id)) findings.set(id, { kind: arc.note.kind, code: arc.note.code, ...(arc.hop.instance === undefined ? {} : { instance: arc.hop.instance }), ...(arc.hop.ref === undefined ? {} : { ref: arc.hop.ref }), message: arc.note.message, hops });
      }
      if (done.has(arc.to)) continue;
      const next: Best = { cost: current.cost + (arc.hop.kind === 'copper' ? 0 : 1), length: current.length + 1, hops };
      if (better(next, best.get(arc.to))) best.set(arc.to, next);
    }
  }

  // 4 · ends, unknown terminals, and the board views
  const reached: TracedEnd[] = [];
  for (const [key, value] of best) {
    if (key === start.key) continue;
    const terminal = nodes.get(key);
    if (terminal === undefined) continue;
    reached.push({ terminal, hops: value.hops, kind: value.hops.some((h) => h.kind === 'active') ? 'active' : value.hops.some((h) => h.kind === 'passive') ? 'passive' : 'copper' });
    const board = boards.get(terminal.instance);
    if (terminal.instanceKind === 'pcba' && board !== undefined) {
      if (board.def.netlist !== undefined && board.def.netlist.terminals[terminal.terminal] === undefined) {
        findings.set(`no-net|${key}`, { kind: 'unknown', code: 'trace-terminal-no-net', instance: terminal.instance, message: `${terminal.instance}: terminal ${terminal.terminal} has no net in ${board.def.id}'s board file, so nothing is known past it.`, hops: value.hops });
      } else if (board.def.netlist === undefined && !declaredLinkAt.has(key) && board.def.terminals.length > 1) {
        findings.set(`no-net|${key}`, { kind: 'unknown', code: 'trace-board-no-nets', instance: terminal.instance, message: `${terminal.instance}: ${board.def.id} has no board nets and declares no link from ${terminal.terminal}, so nothing is known past it.`, hops: value.hops });
      }
    }
    if (terminal.instanceKind === 'component') {
      const component = findComponent(fdb, terminal.def);
      if (component !== undefined && component.terminals.length !== 2) {
        const category = componentCategory(component);
        const kind: HopKind = ACTIVE.includes(category) ? 'active' : 'unknown';
        findings.set(`part|${terminal.instance}`, { kind, code: kind === 'active' ? 'trace-active-part' : 'trace-unknown-part', instance: terminal.instance, ref: terminal.instance, message: `${terminal.instance} (${component.label}) is ${kind === 'active' ? `active (${category})` : `a ${category} with ${component.terminals.length} terminals`}: the trace stops there.`, hops: value.hops });
      }
    }
  }
  reached.sort((x, y) => (x.terminal.key < y.terminal.key ? -1 : x.terminal.key > y.terminal.key ? 1 : 0));

  const findingList = [...[...findings.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, f]) => f)];
  const touched = new Set([...reached.flatMap((r) => r.hops), ...findingList.flatMap((f) => f.hops)].map((h) => h.instance).filter((i): i is string => i !== undefined));
  touched.add(start.instance);
  for (const c of contradictions) if (touched.has(c.instance ?? '')) findingList.push(c);

  const views = new Map<string, BoardTraceView>();
  const view = (instance: string): BoardTraceView | undefined => {
    const board = boards.get(instance);
    if (board === undefined) return undefined;
    let out = views.get(instance);
    if (out === undefined) {
      out = { instance, def: board.def.id, nets: [], terminals: [], parts: [], segments: [] };
      views.set(instance, out);
    }
    return out;
  };
  const allHops = [...reached.flatMap((r) => r.hops), ...findingList.flatMap((f) => f.hops)];
  for (const hop of allHops) {
    if (hop.instance === undefined) continue;
    const v = view(hop.instance);
    if (v === undefined) continue;
    if (hop.net !== undefined && !v.nets.includes(hop.net)) v.nets.push(hop.net);
    if (hop.carrier === 'board-part' && hop.ref !== undefined) {
      const known = v.parts.find((p) => p.ref === hop.ref);
      if (known === undefined) v.parts.push({ ref: hop.ref, kind: hop.kind });
      else if (RANK[hop.kind] > RANK[known.kind]) known.kind = hop.kind;
    }
  }
  const seenSegment = new Set<string>();
  const anchorKey = (a: BoardAnchor): string => ('terminal' in a ? `t:${a.terminal}` : `p:${a.part}`);
  for (const path of [...reached.map((r) => r.hops), ...findingList.map((f) => f.hops)]) {
    let last: { instance: string; anchor: BoardAnchor } | undefined;
    for (const hop of path) {
      const instance = hop.instance;
      let anchor: BoardAnchor | undefined;
      if (hop.carrier === 'board-net' && instance !== undefined) {
        if (!hop.from.includes('#')) {
          last = { instance, anchor: { terminal: hop.from } };
          continue;
        }
        if (!hop.to.includes('#')) anchor = { terminal: hop.to };
        else continue;
      } else if (hop.carrier === 'board-part' && instance !== undefined && hop.ref !== undefined) {
        anchor = { part: hop.ref };
      } else {
        last = undefined;
        continue;
      }
      if (last !== undefined && last.instance === instance) {
        const v = view(instance);
        const id = `${instance}|${anchorKey(last.anchor)}|${anchorKey(anchor)}`;
        const back = `${instance}|${anchorKey(anchor)}|${anchorKey(last.anchor)}`;
        if (v !== undefined && !seenSegment.has(id) && !seenSegment.has(back)) {
          seenSegment.add(id);
          v.segments.push({ from: last.anchor, to: anchor, kind: hop.kind });
        }
      }
      last = { instance, anchor };
    }
  }
  for (const key of [start.key, ...reached.map((r) => r.terminal.key)]) {
    const terminal = nodes.get(key);
    if (terminal?.instanceKind !== 'pcba') continue;
    const v = view(terminal.instance);
    if (v !== undefined && !v.terminals.includes(key)) v.terminals.push(key);
  }
  const boardViews = [...views.values()].sort((x, y) => (x.instance < y.instance ? -1 : 1));
  for (const v of boardViews) {
    v.nets.sort();
    v.terminals.sort();
    v.parts.sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
  }

  return { from: start, reached, findings: findingList, boards: boardViews, issues: graph.issues };
}

/** A part in series on a supply net (a ferrite, a fuse resistor, a jumper) is walked; a decoupling capacitor or a supply pin is not. */
function isSeries(category: ComponentCategory | undefined): boolean {
  return category === 'resistor' || category === 'inductor' || category === 'jumper' || category === 'switch';
}

/** What the build says of a part: fitted as a link (`bridged`), left off (`omitted`), or nothing. */
function populationState(board: BoardContext, part: PcbaNetPart): 'bridged' | 'omitted' | undefined {
  if (board.population?.omitted.includes(part.ref) === true) return 'omitted';
  if (board.population?.bridged.includes(part.ref) === true) return 'bridged';
  return undefined;
}

/** The arcs one board part contributes between the nets it sits on. */
function partArcs(
  id: string,
  board: BoardContext,
  part: PcbaNetPart,
  netNode: (net: string) => string,
  add: (from: string, arc: Arc) => void,
): void {
  const nets = [...new Set(Object.values(part.pins))].sort();
  if (nets.length < 2) return;
  const stopNode = `${id}#${part.ref}`;
  const base = { carrier: 'board-part' as const, instance: id, ref: part.ref, category: part.category, ...(part.value === undefined ? {} : { value: part.value }) };
  const stopAll = (kind: 'active' | 'unknown', code: string, words: string, message: string): void => {
    for (const net of nets) add(netNode(net), { to: stopNode, hop: { ...base, kind, net, description: words }, stop: kind, code, message });
  };
  const popState = populationState(board, part);
  if (popState === 'omitted' && part.category !== 'jumper' && part.category !== 'switch') {
    stopAll('unknown', 'trace-dnp', partWords(`${id} ${part.ref}`, part.value, '(omitted on this build)'), `${id}: ${part.ref} is omitted on ${board.def.id}'s build; whether anything is fitted there is not known.`);
    return;
  }
  if (part.dnp === true && !((part.category === 'jumper' || part.category === 'switch') && popState !== undefined)) {
    stopAll('unknown', 'trace-dnp', partWords(`${id} ${part.ref}`, part.value, '(do not populate)'), `${id}: ${part.ref} is marked do-not-populate on ${board.def.id}; whether anything is fitted there is not known.`);
    return;
  }
  if (ACTIVE.includes(part.category)) {
    let passed = false;
    for (const passage of part.passages ?? []) {
      const from = part.pins[passage.from];
      const to = part.pins[passage.to];
      if (from === undefined || to === undefined || from === to) continue;
      passed = true;
      const words = partWords(`${id} ${part.ref}`, part.value, passage.label ?? `${passage.from}→${passage.to}`);
      add(netNode(from), {
        to: netNode(to),
        hop: { ...base, kind: 'active', net: to, description: `${words} (active passage)` },
        note: { kind: 'active', code: 'trace-active-passage', message: `${id}: ${partWords(part.ref, part.value)} is active (${part.category}); the board record declares ${passage.label ?? `${passage.from}→${passage.to}`}, so the trace continues as an active passage (silicon drives it; not copper).` },
      });
    }
    if (passed) {
      // every other net of the part still stops the walk, as for any silicon
      const entries = new Set((part.passages ?? []).map((p) => part.pins[p.from]));
      for (const net of nets) {
        if (entries.has(net)) continue;
        add(netNode(net), { to: stopNode, hop: { ...base, kind: 'active', net, description: partWords(`${id} ${part.ref}`, part.value) }, stop: 'active', code: 'trace-active-part', message: `${id}: ${partWords(part.ref, part.value)} is active (${part.category}); the trace stops there and claims nothing beyond it.` });
      }
      return;
    }
    stopAll('active', 'trace-active-part', partWords(`${id} ${part.ref}`, part.value), `${id}: ${partWords(part.ref, part.value)} is active (${part.category}); the trace stops there and claims nothing beyond it.`);
    return;
  }
  if (nets.length !== 2) {
    stopAll('unknown', 'trace-unknown-part', partWords(`${id} ${part.ref}`, part.value), `${id}: ${part.ref} (${part.category}) joins ${nets.length} nets; which pins pass a signal is not declared.`);
    return;
  }
  const [a, b] = nets as [string, string];
  const pair = (kind: HopKind, description: string): void => {
    add(netNode(a), { to: netNode(b), hop: { ...base, kind, net: b, description } });
    add(netNode(b), { to: netNode(a), hop: { ...base, kind, net: a, description } });
  };
  if (popState === 'bridged' && PASSIVE.includes(part.category)) {
    pair('copper', `${id} ${part.ref} fitted as a link`);
    return;
  }
  if (PASSIVE.includes(part.category)) {
    pair('passive', partWords(`${id} ${part.ref}`, part.value ?? 'value unknown', part.ferrite === true ? 'ferrite' : undefined));
    return;
  }
  if (part.category === 'jumper' || part.category === 'switch') {
    const state = board.instance.partStates?.[part.ref] ?? (popState === 'bridged' ? 'closed' : popState === 'omitted' ? 'open' : undefined) ?? part.state;
    const chosen = part.category === 'switch' && state !== undefined && state !== 'closed' && state !== 'open' ? (part.passages ?? []).filter((p) => p.position === state) : [];
    if (chosen.length > 0) {
      for (const passage of chosen) {
        const from = part.pins[passage.from];
        const to = part.pins[passage.to];
        if (from === undefined || to === undefined || from === to) continue;
        const hop = { ...base, kind: 'copper' as const, description: `${id} ${part.ref} ${state}` };
        add(netNode(from), { to: netNode(to), hop: { ...hop, net: to } });
        add(netNode(to), { to: netNode(from), hop: { ...hop, net: from } });
      }
    } else if (state === 'closed') pair('copper', `${id} ${part.ref} closed`);
    else if (state === 'open') {
      for (const net of nets) add(netNode(net), { to: stopNode, hop: { ...base, kind: 'copper', net, description: `${id} ${part.ref} open` }, stop: 'open', code: 'trace-open', message: `${id}: ${part.ref} is open on this occurrence; nothing passes it.` });
    } else stopAll('unknown', 'trace-state-undeclared', `${id} ${part.ref} state not declared`, `${id}: the state of ${part.ref} (${part.category}) is not declared for this occurrence; declare it closed or open to trace past it.`);
    return;
  }
  stopAll('unknown', 'trace-unknown-part', partWords(`${id} ${part.ref}`, part.value), `${id}: what ${part.ref} is (${part.category}) is not known; the trace stops there.`);
}
