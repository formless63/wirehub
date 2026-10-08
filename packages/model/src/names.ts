/**
 * Human names for terminals, for the sentences a person reads.
 *
 * A terminal's key (`w1:pair-1.a@a`, `j1:2`) is for programs. In an issue, a
 * dialog or a status bar a terminal is `J1 pin 2 · RXD` or `W1 pair 1 · blue`:
 * the instance in capitals, then what the definition calls the pin or the
 * conductor. Pure: a design, the definitions and a reference in; text out.
 */

import { findConnector, findPcba, findWire, type CableDesign, type Db, type Element, type Issue, type TerminalRef, type WireDefinition } from './model.ts';
import { parseTerminalKey, terminalKey } from './validate.ts';

/** A label without its trailing colour hint: `Pair 1 (blue)` → `pair 1`. */
function plain(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

function dashed(id: string): string {
  return id.replace(/[-_]+/g, ' ');
}

/** The instance as the drawings write it: `J1`, `W1`, `U2`. */
export function instanceName(ref: Pick<TerminalRef, 'instance'>): string {
  return ref.instance.toUpperCase();
}

/** What a wire's element path is called: `pair 1 · blue`, `overall foil`. */
export function elementName(design: CableDesign, db: Db, instanceId: string, path: string): string {
  const segment = design.instances.segments.find((s) => s.id === instanceId);
  return wireElementName(segment === undefined ? undefined : findWire(db, segment.def), path);
}

/** The same, for a path in a wire stock. */
export function wireElementName(wire: WireDefinition | undefined, path: string): string {
  if (wire === undefined) return dashed(path);
  const groups: string[] = [];
  let children: Element[] = wire.structure.children;
  let last: Element | undefined;
  for (const id of path.split('.')) {
    last = children.find((c) => c.id === id);
    if (last === undefined) return dashed(path);
    if (last.kind === 'group') {
      groups.push(plain(last.label ?? dashed(last.id)));
      children = last.children;
    } else {
      children = [];
    }
  }
  if (last === undefined || last.kind === 'group') return groups.join(' ') || dashed(path);
  const own =
    last.label !== undefined
      ? plain(last.label)
      : last.kind === 'conductor' && last.color !== undefined
        ? dashed(last.color)
        : dashed(last.id);
  return groups.length === 0 ? own : `${groups.join(' ')} · ${own}`;
}

/** `J1 pin 2 · RXD`, `W1 pair 1 · blue (end A)`, `U1 · GND`. */
export function terminalName(design: CableDesign, db: Db, ref: TerminalRef): string {
  const name = instanceName(ref);
  const end = ref.end === undefined ? '' : ` (end ${ref.end.toUpperCase()})`;
  const connector = design.instances.connectors.find((c) => c.id === ref.instance);
  if (connector !== undefined) {
    if (ref.terminal === 'shell') return `${name} shell`;
    const label = findConnector(db, connector.def)?.pins.find((p) => p.id === ref.terminal)?.label;
    return `${name} pin ${ref.terminal}${label === undefined || label === '' || label === ref.terminal ? '' : ` · ${label}`}`;
  }
  const pcba = design.instances.pcbas.find((p) => p.id === ref.instance);
  if (pcba !== undefined) {
    const label = findPcba(db, pcba.def)?.terminals.find((t) => t.id === ref.terminal)?.label;
    return `${name} · ${label ?? ref.terminal}`;
  }
  if (design.instances.segments.some((s) => s.id === ref.instance)) {
    return `${name} ${elementName(design, db, ref.instance, ref.terminal)}${end}`;
  }
  return `${name} ${ref.terminal}${end}`;
}

/**
 * The text with every raw terminal key of this design's instances replaced by
 * its human name. Only keys whose instance is in the design are touched.
 */
export function humanizeText(design: CableDesign, db: Db, text: string): string {
  const ids = [
    ...design.instances.connectors,
    ...design.instances.segments,
    ...design.instances.pcbas,
  ].map((i) => i.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (ids.length === 0) return text;
  const key = new RegExp(`(?<![\\w-])(?:${ids.join('|')}):[\\w.-]*[\\w](?:@[ab])?(?![\\w-])`, 'g');
  const quoted = new RegExp(`\\b(segment|connector|board|component|part|instance) '(${ids.join('|')})'`, 'g');
  return text
    .replace(key, (raw) => terminalName(design, db, parseTerminalKey(raw)))
    .replace(quoted, (_all, noun: string, id: string) => `${noun} ${id.toUpperCase()}`);
}

/** Is `where` a terminal key of this design? */
export function isTerminalKey(design: CableDesign, where: string | undefined): where is string {
  if (where === undefined || !where.includes(':')) return false;
  const ref = parseTerminalKey(where);
  return terminalKey(ref) === where && [...design.instances.connectors, ...design.instances.segments, ...design.instances.pcbas].some((i) => i.id === ref.instance);
}

/** The issue with its words made human; `where` stays the machine address, `whereLabel` is its name. */
export function humanizeIssue(design: CableDesign, db: Db, issue: Issue): Issue {
  const message = humanizeText(design, db, issue.message);
  const whereLabel = isTerminalKey(design, issue.where) ? terminalName(design, db, parseTerminalKey(issue.where)) : undefined;
  return { ...issue, message, ...(whereLabel === undefined ? {} : { whereLabel }) };
}
