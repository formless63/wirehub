/**
 * Net highlight on hover: point at any pin, pad or wire
 * element on the canvas and every terminal on its net — and every joint edge
 * that carries it — lights, without selecting anything.
 *
 * Deliberately outside React Flow's node data: a hover must not re-derive the
 * flow. Every terminal on the canvas already carries its key
 * (`data-terminal`, or the handle's own `data-handleid`) and every edge its
 * joint indices (`data-joints`), so the hovered net is one generated
 * `<style>` of attribute selectors, owned by a tiny component that is the only
 * thing re-rendering. Presentation only; never editor state or history.
 */

import { deriveNets, type CableDesign, type Db } from '@cable-studio/model';
import { terminalKey } from '@cable-studio/model';
import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';

export interface NetHoverIndex {
  /** terminal key → net id */
  netOf: Map<string, string>;
  /** net id → its terminal keys */
  keysOf: Map<string, string[]>;
  /** net id → indices of the joints on it */
  jointsOf: Map<string, number[]>;
}

export function netHoverIndex(design: CableDesign, db: Db): NetHoverIndex {
  const netOf = new Map<string, string>();
  const keysOf = new Map<string, string[]>();
  const jointsOf = new Map<string, number[]>();
  for (const net of deriveNets(design, db)) {
    const keys = net.terminals.map((t) => t.key);
    keysOf.set(net.id, keys);
    for (const key of keys) netOf.set(key, net.id);
  }
  design.joints.forEach((joint, index) => {
    const net = netOf.get(terminalKey(joint.a)) ?? netOf.get(terminalKey(joint.b));
    if (net === undefined) return;
    const list = jointsOf.get(net);
    if (list === undefined) jointsOf.set(net, [index]);
    else list.push(index);
  });
  return { netOf, keysOf, jointsOf };
}

function attr(value: string): string {
  return value.replace(/["\\]/g, (c) => `\\${c}`);
}

/** The stylesheet that lights net `netId` inside `scope`; empty for an unknown net. */
export function netHoverCss(index: NetHoverIndex, netId: string, scope = '.cs-canvas'): string {
  const keys = index.keysOf.get(netId) ?? [];
  if (keys.length === 0) return '';
  const terminals = keys.flatMap((key) => [
    `${scope} [data-terminal="${attr(key)}"]`,
    `${scope} .react-flow__handle[data-handleid="${attr(key)}"]`,
  ]);
  const rows = keys.map((key) => `${scope} .cs-row[data-terminal="${attr(key)}"]`);
  // an edge's own stretch over its parts — into the pin, from the jacket into
  // the core, under the jacket to the port (e5c.30) — lights with the edge
  const leads = keys.map((key) => `${scope} [data-lead="${attr(key)}"]`);
  const joints = index.jointsOf.get(netId) ?? [];
  const edges = joints.map((i) => `${scope} .cs-edge[data-joints~="${i}"]`);
  return [
    // the rest of the wiring steps back, so the net reads in its own colours
    `${scope} .react-flow__edge { opacity: 0.18; transition: opacity 80ms; }`,
    edges.length === 0 ? '' : `${edges.map((e) => `${scope} .react-flow__edge:has(${e.slice(scope.length + 1)})`).join(',\n')} { opacity: 1; }`,
    edges.length === 0 ? '' : `${edges.map((e) => `${e} .react-flow__edge-path`).join(',\n')} { stroke-width: 3px !important; }`,
    `${scope} [data-lead] { opacity: 0.18; transition: opacity 80ms; }`,
    `${leads.join(',\n')} { opacity: 1; }`,
    `${leads.map((lead) => `${lead} .cs-lead-line`).join(',\n')} { stroke-width: 2.2px; }`,
    `${terminals.join(',\n')} { outline: 2px solid var(--cs-accent, #e28a50); outline-offset: 1px; box-shadow: 0 0 0 4px var(--accent-soft, rgba(226,138,80,.25)); }`,
    rows.length === 0 ? '' : `${rows.join(',\n')} { background: var(--accent-soft, rgba(226,138,80,.18)); }`,
  ]
    .filter((rule) => rule !== '')
    .join('\n');
}

/** The terminal key an element under the pointer stands for, if any. */
export function terminalKeyAt(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const el = target.closest('[data-terminal], [data-handleid]');
  if (el === null) return undefined;
  return el.getAttribute('data-terminal') ?? el.getAttribute('data-handleid') ?? undefined;
}

/**
 * Listens on `container` for the pointer entering a terminal and renders the
 * stylesheet for its net. The index is built on first hover after an edit,
 * not on every edit.
 */
export function NetHover({
  design,
  db,
  container,
}: {
  design: CableDesign;
  db: Db;
  container: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const [net, setNet] = useState<string | undefined>(undefined);
  const cache = useRef<{ design: CableDesign; db: Db; index: NetHoverIndex } | undefined>(undefined);
  const indexFor = (): NetHoverIndex => {
    const hit = cache.current;
    if (hit !== undefined && hit.design === design && hit.db === db) return hit.index;
    const index = netHoverIndex(design, db);
    cache.current = { design, db, index };
    return index;
  };
  const latest = useRef(indexFor);
  latest.current = indexFor;

  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const over = (event: PointerEvent): void => {
      const key = terminalKeyAt(event.target);
      setNet(key === undefined ? undefined : latest.current().netOf.get(key));
    };
    const leave = (): void => setNet(undefined);
    el.addEventListener('pointerover', over);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerover', over);
      el.removeEventListener('pointerleave', leave);
    };
  }, [container]);

  // an edit can renumber nets: drop a stale highlight
  useEffect(() => setNet(undefined), [design]);

  if (net === undefined) return null;
  const css = netHoverCss(indexFor(), net);
  return css === '' ? null : <style data-net-hover={net}>{css}</style>;
}
