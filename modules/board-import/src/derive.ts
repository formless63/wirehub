/**
 * A board file → a PCBA definition: the black box a cable lands on, with its
 * terminals (where a conductor lands, and the pads behind each) and its
 * declared internal continuity, derived from the board's own nets.
 *
 * **Terminals.** A footprint whose pads are all on one net is a landing (a
 * wire pad, a test point, a shield tab): one terminal, named by the
 * footprint's value when that reads as a name (`GND`, `A`), else by its net,
 * else by its reference. Landings with the same name on the same net collapse
 * into one terminal with several pads. A connector footprint (`J`, `P`, `CN`,
 * `X` … or a `Connector…` library) exposes each pad as `<ref>.<pad>`, unless
 * the review step names the Library connector it is (`connectors` option):
 * then the board integrates that connector and its pins are the terminals.
 *
 * **Internal links.** Nets are nodes and fitted two-net parts (resistors,
 * capacitors, inductors, diodes, jumpers, two-pin switches) are edges.
 * Terminals on one net are plain copper. Terminals on two nets joined by at
 * most two parts in series get one link, `via` the parts (`R1 120 Ω`); the
 * path never runs through a power or ground plane, or through a net that
 * already has a terminal of its own. A capacitor-only path to a plane is
 * decoupling, not continuity, and is left out. Parts with more than two nets
 * (ICs) are opaque: a person declares what passes through them.
 *
 * Pure and deterministic: the same file and options give the same record.
 */

import type { ComponentCategory, Db, PcbaDefinition, PcbaInternalLink, PcbaLinkElement, PcbaPad, PcbaTerminal } from '@wirehub/model';

import type { BoardSource, FootprintSource, PadSource } from './kicad.ts';
import { categoryOfRef, displayValue, elementKindOf, kebab, parseOhms } from './values.ts';

export interface DeriveOptions {
  /** the file's sha256 (hex), for the citation */
  sha256: string;
  id?: string;
  label?: string;
  partNumber?: string;
  revision?: string;
  build?: string;
  /** footprint reference → Library connector id: that connector is integrated, its pins are terminals */
  connectors?: Readonly<Record<string, string>>;
}

/** A terminal's pads where the board file places them (art frame, mm). */
export interface TerminalPad {
  ref: string;
  pad: string;
  x: number;
  y: number;
  side: 'top' | 'bottom' | 'both';
  w?: number;
  h?: number;
}

export interface DerivedBoard {
  pcba: PcbaDefinition;
  /** terminal id → its pads, primary first (only from a `.kicad_pcb`) */
  pads: Map<string, TerminalPad[]>;
  notes: string[];
}

const TWO_TERMINAL: readonly ComponentCategory[] = ['resistor', 'capacitor', 'inductor', 'diode', 'jumper', 'switch'];
const PARTS: readonly ComponentCategory[] = [...TWO_TERMINAL, 'ic', 'regulator', 'transistor'];
const MAX_PARTS_PER_LINK = 2;
const GENERIC_VALUE = /^(~|tp|testpoint|test_point|pad|wire|wirepad|solderwirepad|conn|conn_01x01|mountinghole|mounting_hole|net-tie|nettie|fiducial|[a-z]+_[a-z0-9_.-]*)$/i;

/** A power or ground net: never walked through. */
export function isPlaneNet(net: string): boolean {
  const name = net.replace(/^\//, '');
  return /^(?:[ADPS]?GND[A-Z0-9_]*|VSS|VEE|VCC[A-Z0-9_]*|VDD[A-Z0-9_]*|VBUS|VIN|VBAT|\+?\d+(?:\.\d+)?V\d*)$/i.test(name);
}

/** `/A` → `A`; `Net-(R1-Pad2)` and the like → undefined (no name a person gave it). */
export function netLabel(net: string | undefined): string | undefined {
  if (net === undefined) return undefined;
  if (/^(Net-\(|unconnected-|N\$|\$)/i.test(net)) return undefined;
  const name = net.replace(/^\//, '').split('/').pop() ?? '';
  return name.trim() === '' ? undefined : name.trim();
}

function terminalName(text: string): string {
  return text.trim().replace(/[^A-Za-z0-9_+-]+/g, '_').replace(/^_+|_+$/g, '') || 'pad';
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function netted(fp: FootprintSource): PadSource[] {
  return fp.pads.filter((p) => p.net !== undefined);
}

function distinctNets(fp: FootprintSource): string[] {
  return [...new Set(netted(fp).map((p) => p.net!))];
}

function sideOf(pad: PadSource, fp: FootprintSource): 'top' | 'bottom' | 'both' {
  if (pad.kind === 'thru_hole' || pad.kind === 'np_thru_hole') return 'both';
  if (pad.layers.some((l) => l.startsWith('B.'))) return 'bottom';
  if (pad.layers.some((l) => l.startsWith('F.'))) return 'top';
  return fp.side;
}

type Role = 'landing' | 'connector' | 'part' | 'skip';

export function roleOf(fp: FootprintSource): Role {
  if (fp.ref === '' || fp.ref.startsWith('#')) return 'skip';
  const nets = distinctNets(fp);
  if (nets.length === 0) return 'skip';
  const category = categoryOfRef(fp.ref, fp.lib);
  if (category === 'connector') return nets.length === 1 && new Set(netted(fp).map((p) => p.number)).size === 1 ? 'landing' : 'connector';
  if (nets.length === 1 && !PARTS.includes(category)) return 'landing';
  return nets.length >= 2 ? 'part' : 'skip';
}

interface TerminalDraft {
  terminal: PcbaTerminal;
  net: string;
  pads: TerminalPad[];
}

function padAt(fp: FootprintSource, pad: PadSource, frame: BoardSource['frame']): TerminalPad | undefined {
  if (frame === undefined || pad.x === undefined || pad.y === undefined) return undefined;
  return {
    ref: fp.ref,
    pad: pad.number,
    x: round(pad.x - frame.x0),
    y: round(pad.y - frame.y0),
    side: sideOf(pad, fp),
    ...(pad.w === undefined || pad.h === undefined ? {} : { w: round(pad.w), h: round(pad.h) }),
  };
}

function landingName(fp: FootprintSource, net: string): string {
  const value = fp.value?.trim();
  const libName = fp.lib.slice(fp.lib.indexOf(':') + 1);
  if (value !== undefined && value !== '' && value.length <= 16 && value !== libName && !GENERIC_VALUE.test(value) && !/\s/.test(value)) return terminalName(value);
  const label = netLabel(net);
  if (label !== undefined && label.length <= 24) return terminalName(label);
  return terminalName(fp.ref);
}

function orderedPads(pads: TerminalPad[]): TerminalPad[] {
  // primary first: the first pad visible from the top
  const top = pads.findIndex((p) => p.side !== 'bottom');
  return top <= 0 ? pads : [pads[top]!, ...pads.slice(0, top), ...pads.slice(top + 1)];
}

function asPcbaPad(pad: TerminalPad, connector: boolean): PcbaPad {
  return { ref: pad.ref, side: pad.side, x: pad.x, y: pad.y, ...(connector ? { note: `pad ${pad.pad}` } : {}) };
}

interface Edge {
  ref: string;
  nets: [string, string];
  element: PcbaLinkElement;
  /** a jumper or switch whose state the board does not settle */
  option: boolean;
}

function edgeOf(fp: FootprintSource): Edge | undefined {
  const nets = distinctNets(fp);
  if (nets.length !== 2 || fp.dnp) return undefined;
  const category = categoryOfRef(fp.ref, fp.lib);
  if (!TWO_TERMINAL.includes(category)) return undefined;
  const kind = elementKindOf(category);
  const bridged = category === 'jumper' && /bridged/i.test(fp.lib);
  const value = displayValue(category, fp.value === fp.lib.slice(fp.lib.indexOf(':') + 1) ? undefined : fp.value);
  const state = category === 'jumper' ? (bridged ? 'bridged' : 'build option') : category === 'switch' ? 'build option' : undefined;
  const ohms = category === 'resistor' && fp.value !== undefined ? parseOhms(fp.value) : bridged ? 0 : undefined;
  const words = [fp.ref, category === 'jumper' ? undefined : value, state === undefined ? undefined : `(${state})`].filter((w): w is string => w !== undefined && w !== '');
  return {
    ref: fp.ref,
    nets: [nets[0]!, nets[1]!],
    option: state === 'build option',
    element: {
      text: words.join(' '),
      kind,
      designator: fp.ref,
      ...(value === undefined || category === 'jumper' ? {} : { value }),
      ...(ohms === undefined ? {} : { ohms }),
      ...(state === undefined ? {} : { state }),
    },
  };
}

function basename(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.(kicad_pcb|net)$/i, '');
}

export function deriveBoard(source: BoardSource, options: DeriveOptions, db?: Pick<Db, 'connectors'>): DerivedBoard {
  const notes: string[] = [];
  const base = basename(source.fileName);
  const drafts: TerminalDraft[] = [];
  const integrated: { connectorDefId: string; terminalPrefix: string }[] = [];
  // terminal id → net, for every terminal (integrated connector pins too)
  const netOfTerminal = new Map<string, string>();
  const counts = { landings: 0, connectors: 0, parts: 0, opaque: [] as string[], dnp: [] as string[] };

  for (const fp of source.footprints) {
    const role = roleOf(fp);
    if (role === 'landing') {
      counts.landings += 1;
      const net = distinctNets(fp)[0]!;
      let id = landingName(fp, net);
      const clash = drafts.find((d) => d.terminal.id === id);
      if (clash !== undefined && clash.net === net) {
        for (const pad of netted(fp)) {
          const at = padAt(fp, pad, source.frame);
          if (at !== undefined) clash.pads.push(at);
        }
        continue;
      }
      if (clash !== undefined) id = terminalName(`${id}_${fp.ref}`);
      const label = netLabel(net);
      const pads = netted(fp)
        .map((pad) => padAt(fp, pad, source.frame))
        .filter((p): p is TerminalPad => p !== undefined);
      drafts.push({ terminal: { id, ...(label !== undefined && label !== id ? { label } : {}), note: `${fp.ref}${fp.lib === '' ? '' : ` (${fp.lib})`}` }, net, pads });
    } else if (role === 'connector') {
      counts.connectors += 1;
      const prefix = kebab(fp.ref) || 'j';
      const connectorDefId = options.connectors?.[fp.ref];
      if (connectorDefId !== undefined) {
        const def = db?.connectors.find((c) => c.id === connectorDefId);
        if (def === undefined) {
          notes.push(`${fp.ref}: there is no Library connector '${connectorDefId}', so its pads are plain terminals.`);
        } else {
          integrated.push({ connectorDefId, terminalPrefix: prefix });
          const pins = new Set(def.pins.map((p) => p.id));
          for (const pad of netted(fp)) {
            if (pins.has(pad.number)) netOfTerminal.set(`${prefix}.${pad.number}`, pad.net!);
            else notes.push(`${fp.ref} pad ${pad.number} is not a pin of ${connectorDefId}; it is left out.`);
          }
          continue;
        }
      }
      for (const pad of netted(fp)) {
        const id = `${prefix}.${terminalName(pad.number)}`;
        const at = padAt(fp, pad, source.frame);
        const existing = drafts.find((d) => d.terminal.id === id);
        if (existing !== undefined) {
          if (at !== undefined) existing.pads.push(at);
          continue;
        }
        const label = netLabel(pad.net);
        drafts.push({ terminal: { id, ...(label === undefined ? {} : { label }), note: `${fp.ref} pad ${pad.number}${fp.lib === '' ? '' : ` (${fp.lib})`}` }, net: pad.net!, pads: at === undefined ? [] : [at] });
      }
    } else if (role === 'part') {
      counts.parts += 1;
      if (fp.dnp) counts.dnp.push(fp.ref);
      else if (edgeOf(fp) === undefined && distinctNets(fp).length > 2) counts.opaque.push(fp.ref);
    }
  }

  const terminals: PcbaTerminal[] = [];
  const pads = new Map<string, TerminalPad[]>();
  for (const draft of drafts) {
    const ordered = orderedPads(draft.pads);
    const connector = draft.terminal.id.includes('.');
    terminals.push({ ...draft.terminal, ...(ordered.length === 0 ? {} : { pads: ordered.map((p) => asPcbaPad(p, connector)) }) });
    if (ordered.length > 0) pads.set(draft.terminal.id, ordered);
    netOfTerminal.set(draft.terminal.id, draft.net);
  }
  const order = [...netOfTerminal.keys()];
  const rank = new Map(order.map((id, i) => [id, i]));
  const terminalsOn = new Map<string, string[]>();
  for (const [id, net] of netOfTerminal) terminalsOn.set(net, [...(terminalsOn.get(net) ?? []), id]);

  const links: PcbaInternalLink[] = [];
  // plain copper: each further terminal on a net to its first
  for (const ids of terminalsOn.values()) for (const other of ids.slice(1)) links.push({ from: ids[0]!, to: other });

  // through parts
  const edges = source.footprints.map(edgeOf).filter((e): e is Edge => e !== undefined);
  const byNet = new Map<string, Edge[]>();
  for (const e of edges) for (const net of e.nets) byNet.set(net, [...(byNet.get(net) ?? []), e]);
  const padCount = new Map<string, number>();
  for (const fp of source.footprints) for (const pad of netted(fp)) padCount.set(pad.net!, (padCount.get(pad.net!) ?? 0) + 1);
  const walkable = (net: string): boolean => !terminalsOn.has(net) && !isPlaneNet(net);
  const best = new Map<string, { from: string; to: string; path: Edge[] }>();
  const better = (a: Edge[], b: Edge[]): boolean => {
    if (a.length !== b.length) return a.length < b.length;
    const oa = a.filter((e) => e.option).length;
    const ob = b.filter((e) => e.option).length;
    if (oa !== ob) return oa < ob;
    const ta = a.map((e) => e.element.text).join(' → ');
    const tb = b.map((e) => e.element.text).join(' → ');
    return ta < tb;
  };
  const consider = (start: string, end: string, path: Edge[]): void => {
    if (start === end) return;
    if (path.every((e) => e.element.kind === 'capacitor') && (isPlaneNet(start) || isPlaneNet(end))) return;
    const a = terminalsOn.get(start)![0]!;
    const b = terminalsOn.get(end)![0]!;
    const forward = rank.get(a)! < rank.get(b)!;
    const key = forward ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    const ordered = forward ? path : [...path].reverse();
    const current = best.get(key);
    if (current === undefined || better(ordered, current.path)) best.set(key, { from: forward ? a : b, to: forward ? b : a, path: ordered });
  };
  const walk = (start: string, net: string, path: Edge[]): void => {
    for (const edge of byNet.get(net) ?? []) {
      if (path.includes(edge)) continue;
      const next = edge.nets[0] === net ? edge.nets[1] : edge.nets[0];
      const route = [...path, edge];
      if (terminalsOn.has(next)) consider(start, next, route);
      else if (route.length < MAX_PARTS_PER_LINK && walkable(next)) walk(start, next, route);
    }
  };
  for (const net of terminalsOn.keys()) walk(net, net, []);
  const throughParts = [...best.values()].sort((x, y) => rank.get(x.from)! - rank.get(y.from)! || rank.get(x.to)! - rank.get(y.to)!);
  for (const { from, to, path } of throughParts) {
    const elements = path.map((e) => e.element);
    links.push({ from, to, via: elements.map((e) => e.text).join(' → '), elements });
  }

  if (counts.opaque.length > 0) notes.push(`${counts.opaque.join(', ')} ${counts.opaque.length === 1 ? 'has' : 'have'} more than two nets and ${counts.opaque.length === 1 ? 'is' : 'are'} treated as a black box: declare any path through ${counts.opaque.length === 1 ? 'it' : 'them'} by hand.`);
  if (counts.dnp.length > 0) notes.push(`${counts.dnp.join(', ')} ${counts.dnp.length === 1 ? 'is' : 'are'} marked do-not-populate and carr${counts.dnp.length === 1 ? 'ies' : 'y'} no link.`);
  if (terminals.length === 0 && integrated.length === 0) notes.push('No landing pads or connector pins were found: a board needs terminals before a cable can land on it.');
  if (source.format === 'kicad-netlist') notes.push('A netlist has no pad positions or outline: import the .kicad_pcb for artwork and anchors.');
  else if (source.outline === undefined) notes.push('The board file has no closed Edge.Cuts outline: pad positions are relative to the pads themselves.');

  const label = options.label ?? source.title ?? base;
  const revision = options.revision ?? source.revision ?? 'unrevised';
  if (options.revision === undefined && source.revision === undefined) notes.push('The board file names no revision (title block): set one in the review step, or on the record after publishing.');
  const partNumber = options.partNumber ?? source.title ?? base;
  const id = options.id ?? (kebab(`${source.title ?? base}-${revision === 'unrevised' ? '' : `rev-${revision}`}`).slice(0, 80).replace(/-$/, '') || 'board');
  const pcba: PcbaDefinition = {
    id,
    label,
    partNumber,
    revision,
    build: options.build ?? 'as-designed',
    kicadProject: base,
    terminals,
    ...(integrated.length === 0 ? {} : { integratedConnectors: integrated }),
    internalLinks: links,
    src: `${source.fileName} (KiCad ${source.format === 'kicad-pcb' ? 'board file' : 'netlist'}, sha256 ${options.sha256.slice(0, 16)}…), read by the board-import module: ${terminals.length} terminal(s) from its landing pads and connector pins, ${links.length} internal link(s) from its nets and two-terminal parts — inferred, review before use`,
  };
  notes.unshift(`${source.fileName}: ${counts.landings} landing(s), ${counts.connectors} connector(s), ${counts.parts} part(s) → ${terminals.length} terminal(s), ${links.length} link(s).`);
  return { pcba, pads, notes };
}
