/**
 * Conductor trace across the board view: point at (or select) a pin, pad or
 * conductor end and the path core's `traceConductor` finds lights up on every
 * board it crosses — the pads it reaches and the parts it passes or stops at,
 * each in its hop kind's token (`--trace-copper`, `--trace-passive`,
 * `--trace-active`, `--trace-unknown`) — with a compact findings list of what
 * the trace could not claim.
 *
 * Presentation only, like `NetHover`: one generated `<style>` of attribute
 * selectors scoped to each board occurrence's node (`data-id`), so two copies
 * of one board light independently, and nothing re-derives the flow.
 */

import {
  findPcba,
  traceConductor,
  parseTerminalKey,
  type BoardAnchor,
  type BoardTraceView,
  type CableDesign,
  type ConductorTrace,
  type Db,
  type HopKind,
  type PcbaNetPart,
} from '@wirehub/model';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type RefObject } from 'react';

import { viewPoint, type BoardArt } from './board-art.ts';
import { terminalKeyAt } from './net-hover.tsx';

/* ------------------------------------------------------------------ *
 * The shared trace: one tiny external store per editor, so a hover
 * re-renders only the board nodes it lights (the `hover.ts` pattern)
 * ------------------------------------------------------------------ */

export interface BoardTraceShown {
  trace: ConductorTrace;
  /** board instance → its netlist parts by ref (where they sit) */
  parts: ReadonlyMap<string, ReadonlyMap<string, PcbaNetPart>>;
}

export interface BoardTraceStore {
  get: () => BoardTraceShown | undefined;
  set: (shown: BoardTraceShown | undefined) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createBoardTraceStore(): BoardTraceStore {
  let current: BoardTraceShown | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (shown) => {
      if (shown === current) return;
      current = shown;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const BoardTraceContext = createContext<BoardTraceStore>(createBoardTraceStore());

/** What the current trace touched on board occurrence `instance`, if anything. */
function useBoardTraceView(instance: string): { view: BoardTraceView; parts: ReadonlyMap<string, PcbaNetPart> | undefined } | undefined {
  const store = useContext(BoardTraceContext);
  const shown = useSyncExternalStore(store.subscribe, store.get, () => undefined);
  return useMemo(() => {
    const view = shown?.trace.boards.find((b) => b.instance === instance);
    return view === undefined ? undefined : { view, parts: shown?.parts.get(instance) };
  }, [shown, instance]);
}

/**
 * The traced route over one board node's art: a line pad → part → pad per
 * step, in its hop kind's token, and a ring on each part it passes or stops
 * at. Parts the board file places are drawn where they sit; a part without a
 * position is left to the findings list.
 */
export function BoardTracePath({ instanceId, board }: { instanceId: string; board: BoardArt }): JSX.Element | null {
  const touched = useBoardTraceView(instanceId);
  if (touched === undefined) return null;
  const handleAt = (key: string): { x: number; y: number } | undefined => {
    const handle = board.handles.find((h) => h.key === key && h.primary) ?? board.handles.find((h) => h.key === key);
    return handle === undefined ? undefined : { x: handle.x, y: handle.y };
  };
  const partAt = (ref: string): { x: number; y: number } | undefined => {
    const part = touched.parts?.get(ref);
    if (part?.x === undefined || part.y === undefined) return undefined;
    const face = board.views.find((v) => v.side === (part.side ?? 'top')) ?? board.views[0];
    return face === undefined ? undefined : viewPoint(face, { x: part.x, y: part.y });
  };
  const at = (anchor: BoardAnchor): { x: number; y: number } | undefined => ('terminal' in anchor ? handleAt(anchor.terminal) : partAt(anchor.part));
  return (
    <svg className="cs-trace-path" width={board.width} height={board.height} viewBox={`0 0 ${board.width} ${board.height}`} aria-hidden="true">
      {touched.view.segments.map((segment, index) => {
        const a = at(segment.from);
        const b = at(segment.to);
        return a === undefined || b === undefined ? null : <line key={index} className="cs-trace-seg" data-kind={segment.kind} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
      })}
      {touched.view.parts.map((part) => {
        const p = partAt(part.ref);
        return p === undefined ? null : (
          <g key={part.ref} className="cs-trace-part" data-kind={part.kind}>
            <circle cx={p.x} cy={p.y} r={6} />
            <text x={p.x} y={p.y - 9}>
              {part.ref}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function attr(value: string): string {
  return value.replace(/["\\]/g, (c) => `\\${c}`);
}

const KINDS: readonly HopKind[] = ['copper', 'passive', 'active', 'unknown'];
const KIND_WORD: Readonly<Record<HopKind, string>> = { copper: 'copper', passive: 'passive', active: 'active, stopped', unknown: 'unknown, stopped' };

/** Whether a trace says anything about a board, or found something it cannot claim. */
export function traceTouchesBoards(trace: ConductorTrace): boolean {
  return trace.boards.length > 0 || trace.findings.length > 0;
}

/** The stylesheet lighting `trace` on the board views inside `scope`. */
export function boardTraceCss(trace: ConductorTrace, scope = '.cs-canvas'): string {
  const rules: string[] = [];
  const kindOfEnd = new Map(trace.reached.map((end) => [end.terminal.key, end.kind] as const));
  for (const board of trace.boards) {
    const node = `${scope} .react-flow__node[data-id="${attr(board.instance)}"]`;
    // the board's other parts step back so the path reads
    rules.push(`${node} .cs-board-part { opacity: 0.3; transition: opacity 80ms; }`);
    for (const part of board.parts) {
      const sel = `${node} .cs-board-part[data-ref="${attr(part.ref)}"]`;
      rules.push(`${sel} { opacity: 1; filter: drop-shadow(0 0 1.5px var(--trace-${part.kind})) drop-shadow(0 0 3px var(--trace-${part.kind})); }`);
      rules.push(`${sel} > * { stroke: var(--trace-${part.kind}); stroke-width: 1.2px; }`);
      rules.push(`${node} .cs-board-part-label[data-ref="${attr(part.ref)}"] { fill: var(--trace-${part.kind}); }`);
    }
    for (const key of board.terminals) {
      const kind = key === trace.from.key ? 'copper' : (kindOfEnd.get(key) ?? 'copper');
      rules.push(`${node} [data-terminal="${attr(key)}"] { outline: 2px solid var(--trace-${kind}); outline-offset: 1px; box-shadow: 0 0 0 4px var(--accent-soft); }`);
    }
  }
  // ends off the boards (connector pins, conductor ends) in their kind
  for (const end of trace.reached) {
    if (end.terminal.instanceKind === 'pcba') continue;
    rules.push(`${scope} [data-terminal="${attr(end.terminal.key)}"] { outline: 2px solid var(--trace-${end.kind}); outline-offset: 1px; }`);
  }
  return rules.join('\n');
}

/** The compact list beside the canvas: what was reached, by kind, and every finding. */
export function TraceFindings({
  trace,
  pinned,
  onDeclare,
}: {
  trace: ConductorTrace;
  pinned: boolean;
  /** declare a jumper or switch's state on a board occurrence (shown on 'state not declared' findings) */
  onDeclare?: ((instance: string, ref: string, state: 'open' | 'closed') => void) | undefined;
}): JSX.Element {
  const counts = new Map<HopKind, number>();
  for (const end of trace.reached) counts.set(end.kind, (counts.get(end.kind) ?? 0) + 1);
  for (const finding of trace.findings) {
    if (finding.kind === 'active' || finding.kind === 'unknown') counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  const shown = trace.findings.slice(0, 6);
  return (
    <aside className="cs-trace-findings" aria-label="conductor trace" data-pinned={pinned || undefined}>
      <header className="cs-trace-findings-head">
        <span className="cs-trace-findings-from">trace {trace.from.key}</span>
        <span className="cs-trace-legend">
          {KINDS.map((kind) => (
            <span key={kind} className="cs-trace-kind" data-kind={kind} title={KIND_WORD[kind]}>
              <span className="cs-trace-swatch" data-kind={kind} aria-hidden="true" />
              {kind} {counts.get(kind) ?? 0}
            </span>
          ))}
        </span>
      </header>
      {/* a board crossed only through its declared continuity has no nets or parts to name */}
      {trace.boards.every((board) => board.nets.length + board.parts.length === 0) ? null : (
        <p className="cs-trace-boards">
          {trace.boards.filter((board) => board.nets.length + board.parts.length > 0).map((board) => `${board.instance}: ${board.nets.length} net${board.nets.length === 1 ? '' : 's'}, ${board.parts.length} part${board.parts.length === 1 ? '' : 's'}`).join(' · ')}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="cs-trace-none">nothing unknown or active on this path</p>
      ) : (
        <ul className="cs-trace-list">
          {shown.map((finding, index) => (
            <li key={`${finding.code}-${index}`} className="cs-trace-finding" data-kind={finding.kind}>
              <span className="cs-trace-swatch" data-kind={finding.kind === 'contradiction' || finding.kind === 'open' ? 'unknown' : finding.kind} aria-hidden="true" />
              <span className="cs-trace-finding-kind">{finding.kind}</span>
              <span className="cs-trace-finding-text">
                {finding.message}
                {finding.code === 'trace-state-undeclared' && onDeclare !== undefined && finding.instance !== undefined && finding.ref !== undefined ? (
                  <span className="cs-seg cs-trace-declare" role="group" aria-label={`declare ${finding.ref}`}>
                    {(['closed', 'open'] as const).map((state) => (
                      <button key={state} type="button" data-declare={state} onClick={() => onDeclare(finding.instance as string, finding.ref as string, state)}>
                        {state}
                      </button>
                    ))}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
          {trace.findings.length > shown.length ? <li className="cs-trace-more">+{trace.findings.length - shown.length} more in the continuity spec</li> : null}
        </ul>
      )}
    </aside>
  );
}

/**
 * Hover (or the selected terminal, when nothing is hovered) → the trace's
 * stylesheet and findings. Renders nothing when the trace crosses no board
 * and finds nothing, so a plain cable looks as it always did.
 */
export function BoardTraceOverlay({
  design,
  db,
  container,
  selected,
  onDeclare,
}: {
  design: CableDesign;
  db: Db;
  container: RefObject<HTMLElement | null>;
  /** the selected terminal's key, if a terminal is selected */
  selected?: string | undefined;
  /** declare a part's state on a board occurrence; the trace re-runs from the new design */
  onDeclare?: ((instance: string, ref: string, state: 'open' | 'closed') => void) | undefined;
}): JSX.Element | null {
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const cache = useRef<{ design: CableDesign; db: Db; traces: Map<string, ConductorTrace | undefined> }>({ design, db, traces: new Map() });
  if (cache.current.design !== design || cache.current.db !== db) cache.current = { design, db, traces: new Map() };

  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const over = (event: PointerEvent): void => setHovered(terminalKeyAt(event.target));
    const leave = (): void => setHovered(undefined);
    el.addEventListener('pointerover', over);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerover', over);
      el.removeEventListener('pointerleave', leave);
    };
  }, [container]);

  const key = hovered ?? selected;
  const trace = useMemo(() => {
    if (key === undefined) return undefined;
    const traces = cache.current.traces;
    if (!traces.has(key)) {
      let result: ConductorTrace | undefined;
      try {
        result = traceConductor(design, db, parseTerminalKey(key));
      } catch {
        result = undefined;
      }
      traces.set(key, result === undefined || result.issues.length > 0 && result.reached.length === 0 ? undefined : result);
    }
    return traces.get(key);
  }, [key, design, db]);

  const store = useContext(BoardTraceContext);
  const visible = trace !== undefined && traceTouchesBoards(trace) ? trace : undefined;
  useEffect(() => {
    if (visible === undefined) {
      store.set(undefined);
      return;
    }
    const parts = new Map<string, Map<string, PcbaNetPart>>();
    for (const board of visible.boards) {
      const def = findPcba(db, board.def);
      parts.set(board.instance, new Map((def?.netlist?.parts ?? []).map((p) => [p.ref, p])));
    }
    store.set({ trace: visible, parts });
  }, [visible, db, store]);
  useEffect(() => () => store.set(undefined), [store]);

  if (visible === undefined) return null;
  return (
    <>
      <style data-board-trace={visible.from.key}>{boardTraceCss(visible)}</style>
      <TraceFindings trace={visible} pinned={hovered === undefined} onDeclare={onDeclare} />
    </>
  );
}
