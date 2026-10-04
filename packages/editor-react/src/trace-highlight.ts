/**
 * Trace highlighting on the schematic: which nets light
 * up when a pin, pad, conductor or joint is picked, and how the trace is
 * summed up in the toolbar chip.
 *
 * Connectivity is **core's**, never re-derived here: `trace` walks from the
 * picked terminal through joints, wire copper, board links (a `via` part
 * included) and components; `deriveNets` says which galvanic net each reached
 * terminal is on. The schematic SVG stamps the same net ids on everything it
 * draws (`data-net`), so lighting a trace is a class toggle on the elements
 * whose nets are in the set — no re-render.
 */

import {
  deriveNets,
  findPcba,
  parseTerminalKey,
  trace,
  type CableDesign,
  type Db,
  type Net,
  type ResolvedTerminal,
} from '@wirehub/model';

export interface TraceSummary {
  /** the terminal the trace started from */
  start: string;
  /** every net the trace reaches (the ids the SVG carries in `data-net`) */
  nets: string[];
  /** the connector pins it reaches, `j1.7 Red` — the ends of the path */
  ends: string[];
  /** what it passes through on the way (`C1 220 µF`, `r1 (330 Ω)`) */
  passages: string[];
  /** every terminal reached, for the chip's tooltip */
  terminals: string[];
}

/** What a picked SVG element says about itself. */
export interface TracePick {
  /** `data-terminal` (a port, a joint dot) or `data-a` (a joint) */
  terminal?: string;
  /** `data-net`: one net id, or two across a board link's `via` */
  net?: string;
}

/** The pick's starting terminal: its own, else the first terminal of its first net. */
function startOf(pick: TracePick, nets: readonly Net[]): string | undefined {
  if (pick.terminal !== undefined && pick.terminal !== '') return pick.terminal;
  const first = pick.net?.split(/\s+/)[0];
  return nets.find((net) => net.id === first)?.terminals[0]?.key;
}

/** A reached terminal that is an end of the path: a connector pin, or a board's own connector pin. */
function isEnd(design: CableDesign, db: Db, terminal: ResolvedTerminal): boolean {
  if (terminal.instanceKind === 'connector') return true;
  if (terminal.instanceKind !== 'pcba') return false;
  const instance = design.instances.pcbas.find((item) => item.id === terminal.instance);
  const pcba = instance === undefined ? undefined : findPcba(db, instance.def);
  return (pcba?.integratedConnectors ?? []).some((carried) =>
    terminal.terminal.startsWith(`${carried.terminalPrefix}.`),
  );
}

function endLabel(terminal: ResolvedTerminal): string {
  const id = `${terminal.instance}.${terminal.terminal}`;
  return terminal.label === undefined || terminal.label === terminal.terminal ? id : `${id} ${terminal.label}`;
}

/**
 * The trace from a picked element, or `undefined` when the element names no
 * terminal the design knows.
 */
export function traceFromPick(
  design: CableDesign,
  db: Db,
  pick: TracePick,
  nets: readonly Net[] = deriveNets(design, db),
): TraceSummary | undefined {
  const start = startOf(pick, nets);
  if (start === undefined) return undefined;
  const result = trace(design, db, parseTerminalKey(start));
  if (result.issues.length > 0 && result.reached.length === 0) return undefined;
  const netOf = new Map<string, string>();
  for (const net of nets) for (const terminal of net.terminals) netOf.set(terminal.key, net.id);

  const all = [result.from, ...result.reached.map((step) => step.terminal)];
  const reachedNets: string[] = [];
  for (const terminal of all) {
    const net = netOf.get(terminal.key);
    if (net !== undefined && !reachedNets.includes(net)) reachedNets.push(net);
  }
  // the picked element's own nets always light, even a board link's far side
  for (const net of pick.net?.split(/\s+/) ?? []) {
    if (net !== '' && !reachedNets.includes(net)) reachedNets.push(net);
  }
  const passages: string[] = [];
  for (const step of result.reached) {
    for (const passage of step.passages) {
      if (!passages.includes(passage.description)) passages.push(passage.description);
    }
  }
  return {
    start,
    nets: reachedNets,
    ends: all.filter((terminal) => isEnd(design, db, terminal)).map((terminal) => endLabel(terminal)),
    passages,
    terminals: all.map((terminal) => terminal.key),
  };
}

/** The `.on-trace` class on every drawn element whose nets meet the trace; the rest dim. */
export function applyTrace(root: Element, nets: readonly string[] | undefined): void {
  const lit = new Set(nets ?? []);
  root.classList.toggle('is-tracing', nets !== undefined);
  for (const element of root.querySelectorAll('[data-net]')) {
    const own = (element.getAttribute('data-net') ?? '').split(/\s+/);
    element.classList.toggle('on-trace', nets !== undefined && own.some((net) => lit.has(net)));
  }
}

/** The pickable element under an event target: the nearest ancestor that carries a net. */
export function pickOf(target: EventTarget | null): TracePick | undefined {
  if (!(target instanceof Element)) return undefined;
  const element = target.closest('[data-net]');
  if (element === null) return undefined;
  const terminal = element.getAttribute('data-terminal') ?? element.getAttribute('data-a') ?? undefined;
  const net = element.getAttribute('data-net') ?? undefined;
  return {
    ...(terminal === undefined ? {} : { terminal }),
    ...(net === undefined ? {} : { net }),
  };
}
