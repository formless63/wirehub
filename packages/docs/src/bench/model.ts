/**
 * The bench build sheet's model: what the bench does,
 * in the order it does it — derived, never authored.
 *
 * `deriveBench(design, db)` answers, per end of the cable:
 *
 * - which conductor, braid twist or shield mass lands on which pad, on which
 *   board face, and **in what order** (standard work: "Solder R/G/B + ground,
 *   then RA/LA/S + ground" — the RGB face first, its cores then its twist; the
 *   other face the same; anything straight onto a connector pin last);
 * - what happens to every element of the stock at that end — landed, twisted
 *   into a pigtail, or cut back (the strip plan). The foil is never listed:
 *   it is trimmed back and never indicated; a bonded multi-core
 *   mass is one row; a coax drain lands at the source only;
 * - the non-wire work at that end: pin bridges and hand-fitted parts.
 *
 * Everything here is a fold of the design's joints and pigtails against the
 * definitions. Presentation (the board drawings, the numbered markers) lives
 * in `figures.ts` and `render.ts`.
 */

import {
  assemblySides,
  breakoutFates,
  inScope,
  findComponent,
  findConnector,
  findPcba,
  findWire,
  isFoilPath,
  isFullyBonded,
  pigtailMembers,
  resolveElementPath,
  screenPaths,
  terminalKey,
  type CableDesign,
  type Db,
  type Element,
  type GroupElement,
  type TerminalRef,
  type WireDefinition, stripMakerSuffix } from '@wirehub/model';

import { trunkSegment } from '../drawing/model.ts';
import { compareStrings } from '../text.ts';

export type EndSide = 'a' | 'b';
export type BoardFace = 'top' | 'bottom';

/* ------------------------------------------------------------------ *
 * The stock's elements
 * ------------------------------------------------------------------ */

/** One element of a stock the bench handles at an end (never the foil). */
export interface StockElement {
  path: string;
  kind: 'core' | 'screen' | 'drain';
  /** catalog colour name of the core (or its coax jacket): `red`, `white` */
  colour?: string;
  /** `Red`, `Red braid`, `Drain` */
  name: string;
  /** the definition's own words: `Video R centre conductor` */
  label?: string;
  /** a core inside a coax / shielded-core group */
  shielded: boolean;
  /** the group a core or its braid belongs to (`core-red`) */
  group?: string;
}

const COLOUR_ORDER = ['red', 'green', 'blue', 'yellow', 'white', 'black', 'brown', 'purple', 'violet', 'orange', 'grey', 'gray'];

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function colourOf(element: Element | undefined): string | undefined {
  if (element === undefined) return undefined;
  if ('color' in element && element.color !== undefined) return element.color;
  return undefined;
}

/** The stock's cores, screens and drains in structure order — the foil left out. */
export function stockElements(wire: WireDefinition): StockElement[] {
  const out: StockElement[] = [];
  const visit = (element: Element, prefix: string, group: GroupElement | undefined): void => {
    const path = prefix === '' ? element.id : `${prefix}.${element.id}`;
    if (element.kind === 'group') {
      for (const child of element.children) visit(child, path, element);
      return;
    }
    if (element.kind === 'conductor') {
      const colour = element.color ?? (group === undefined ? undefined : group.children.map(colourOf).find((c) => c !== undefined));
      const shielded = group !== undefined && group.children.some((c) => c.kind === 'shield');
      if (element.bare === true) {
        out.push({ path, kind: 'drain', name: 'Drain', ...(element.label === undefined ? {} : { label: element.label }), shielded: false });
        return;
      }
      out.push({
        path,
        kind: 'core',
        ...(colour === undefined ? {} : { colour }),
        name: colour === undefined ? (element.label ?? path) : titleCase(colour),
        ...(element.label === undefined ? {} : { label: element.label }),
        shielded,
        ...(group === undefined ? {} : { group: group.id }),
      });
      return;
    }
    if (element.kind === 'shield') {
      if (isFoilPath(wire, path)) return;
      const colour = group === undefined ? undefined : group.children.map(colourOf).find((c) => c !== undefined);
      out.push({
        path,
        kind: 'screen',
        ...(colour === undefined ? {} : { colour }),
        name: colour === undefined ? (element.label ?? path) : `${titleCase(colour)} braid`,
        ...(element.label === undefined ? {} : { label: element.label }),
        shielded: false,
        ...(group === undefined ? {} : { group: group.id }),
      });
    }
  };
  for (const child of wire.structure.children) visit(child, '', undefined);
  return out;
}

function colourRank(colour: string | undefined): number {
  const index = colour === undefined ? -1 : COLOUR_ORDER.indexOf(colour.toLowerCase());
  return index < 0 ? COLOUR_ORDER.length : index;
}

/* ------------------------------------------------------------------ *
 * Landings
 * ------------------------------------------------------------------ */

export type LandingElement =
  | { kind: 'core'; path: string; name: string; colour?: string; label?: string; shielded: boolean }
  /** one screen landed on its own (a BNC's braid to the shell) */
  | { kind: 'screen'; path: string; name: string; colour?: string }
  | {
      kind: 'pigtail';
      id: string;
      /** screen paths twisted into it (never the foil) */
      members: string[];
      /** a fully bonded stock's whole copper mass (bonded multi-core) */
      mass: boolean;
      /** `R, G, B braids + drain` / `Shield mass` */
      name: string;
    };

export interface LandingTarget {
  instance: string;
  kind: 'pcba' | 'connector' | 'component';
  def: string;
  terminal: string;
  /** the pin/pad label the definition gives it: `R`, `Blue`, `Audio L` */
  label?: string;
  /** the physical pad ref (`GND2`, `H9`) — named by the joint, else the terminal's primary pad */
  pad?: string;
  /** copper side of that pad */
  copper?: 'top' | 'bottom' | 'both';
  /** a board terminal carried for its mounted connector (`j.2`) rather than a cable pad */
  connectorSide?: boolean;
}

export interface Landing {
  /** soldering order at this end, 1-based */
  n: number;
  segment: string;
  segEnd: EndSide;
  element: LandingElement;
  target: LandingTarget;
  /** the board face it is soldered on (boards only) */
  face?: BoardFace;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * The strip plan
 * ------------------------------------------------------------------ */

export type StripTreatment =
  /** lands on its own: see landing `n` */
  | { kind: 'land'; n: number }
  /** twisted into a pigtail, which lands as `n` (undefined: not landed) */
  | { kind: 'twist'; pigtail: string; n?: number }
  /** cut back at the jacket and left (the destination drain, a spare core) */
  | { kind: 'cut'; why: string }
  /** runs on uncut through a breakout mould onto its leg */
  | { kind: 'through'; to: string };

export interface StripRow {
  element: StockElement;
  /** one row standing for a whole bonded mass (bonded multi-core): its member count */
  mass?: number;
  treatment: StripTreatment;
}

export interface SegmentEnd {
  segment: string;
  end: EndSide;
  def: string;
  stock: string;
  /** a segment's role: `trunk (6 ft)`, `audio whip …` */
  role?: string;
  lengthMm?: number;
  /** the stock's screens are one copper mass (bonded multi-core) */
  bonded: boolean;
  rows: StripRow[];
}

/* ------------------------------------------------------------------ *
 * An end of the assembly
 * ------------------------------------------------------------------ */

export interface Termination {
  instance: string;
  kind: 'pcba' | 'connector' | 'component';
  def: string;
  label: string;
  partNumber?: string;
  landings: Landing[];
  /** connectors mounted on this board (`j1` Mini-DIN 9), which solder to its pads */
  mounted: { instance: string; label: string }[];
}

/** A non-wire joint at an end: a pin bridge, a bodge, a hand-fitted part's leg. */
export interface Bridge {
  from: string;
  to: string;
  /** a hand-fitted part in it: `r1 180 Ω` */
  part?: string;
  note?: string;
}

export interface BenchEnd {
  side: EndSide;
  terminations: Termination[];
  /** the segment ends prepared at this end (trunk end, whip ends) */
  segmentEnds: SegmentEnd[];
  bridges: Bridge[];
}

export interface Bench {
  designId: string;
  ends: BenchEnd[];
}

/* ------------------------------------------------------------------ *
 * deriveBench
 * ------------------------------------------------------------------ */

interface RawLanding {
  segment: string;
  segEnd: EndSide;
  element: LandingElement;
  target: LandingTarget;
  face?: BoardFace;
  note?: string;
}

function instanceKind(design: CableDesign, id: string): 'segment' | 'pcba' | 'connector' | 'component' | 'mechanical' | undefined {
  if (design.instances.segments.some((s) => s.id === id)) return 'segment';
  if (design.instances.pcbas.some((s) => s.id === id)) return 'pcba';
  if (design.instances.connectors.some((s) => s.id === id)) return 'connector';
  if (design.instances.components.some((s) => s.id === id)) return 'component';
  if ((design.instances.mechanical ?? []).some((s) => s.id === id)) return 'mechanical';
  return undefined;
}

function defOf(design: CableDesign, id: string): string {
  const all = [
    ...design.instances.pcbas,
    ...design.instances.connectors,
    ...design.instances.components,
    ...design.instances.segments,
  ];
  return all.find((i) => i.id === id)?.def ?? '';
}

function targetOf(design: CableDesign, db: Db, ref: TerminalRef): LandingTarget | undefined {
  const kind = instanceKind(design, ref.instance);
  if (kind !== 'pcba' && kind !== 'connector' && kind !== 'component') return undefined;
  const def = defOf(design, ref.instance);
  if (kind === 'pcba') {
    const pcba = findPcba(db, def);
    const terminal = pcba?.terminals.find((t) => t.id === ref.terminal);
    const pads = (terminal?.pads ?? []).filter((p) => p.role !== 'shell');
    const pad = ref.pad === undefined ? pads[0] : (terminal?.pads ?? []).find((p) => p.ref === ref.pad);
    const label = terminal?.label ?? ref.terminal;
    return {
      instance: ref.instance,
      kind,
      def,
      terminal: ref.terminal,
      label,
      ...(pad === undefined ? (ref.pad === undefined ? {} : { pad: ref.pad }) : { pad: pad.ref }),
      ...(pad?.side === undefined ? {} : { copper: pad.side }),
      ...(ref.terminal.includes('.') ? { connectorSide: true } : {}),
    };
  }
  if (kind === 'connector') {
    const pin = findConnector(db, def)?.pins.find((p) => p.id === ref.terminal);
    return { instance: ref.instance, kind, def, terminal: ref.terminal, ...(pin?.label === undefined ? {} : { label: pin.label }) };
  }
  const component = findComponent(db, def);
  const terminal = component?.terminals.find((t) => t.id === ref.terminal);
  return { instance: ref.instance, kind, def, terminal: ref.terminal, ...(terminal?.label === undefined ? {} : { label: terminal.label }) };
}

/** Plain words for a pigtail's members: `R, G, B braids + drain`. */
export function pigtailName(wire: WireDefinition, members: readonly string[], mass: boolean): string {
  if (mass) return 'Shield mass';
  const elements = stockElements(wire);
  const braids: string[] = [];
  const others: string[] = [];
  for (const path of members) {
    const element = elements.find((e) => e.path === path);
    if (element === undefined) continue; // the foil: never named
    if (element.kind === 'screen' && element.colour !== undefined) braids.push(titleCase(element.colour));
    else others.push(element.kind === 'drain' ? 'drain' : element.name);
  }
  // colour initials keep a twist's label short: `R G B braids + drain`
  const initial = (c: string): string => ({ Black: 'Bk', Brown: 'Br', Blue: 'B' } as Record<string, string>)[c] ?? c.slice(0, 1);
  const parts: string[] = [];
  if (braids.length > 0) parts.push(`${braids.length === 1 ? braids[0] : braids.map(initial).join(' ')} braid${braids.length === 1 ? '' : 's'}`);
  parts.push(...others);
  return parts.join(' + ') || 'Screens';
}

function faceOf(target: LandingTarget): BoardFace | undefined {
  if (target.kind !== 'pcba') return undefined;
  return target.copper === 'bottom' ? 'bottom' : 'top';
}

/** Soldering order within one termination (see the file comment). */
function orderLandings(raw: RawLanding[], segmentOrder: readonly string[]): RawLanding[] {
  const isRgb = (l: RawLanding): boolean => l.element.kind === 'core' && ['red', 'green', 'blue'].includes((l.element.colour ?? '').toLowerCase());
  const faces: (BoardFace | undefined)[] = [];
  const rgbFace = raw.find(isRgb)?.face;
  if (rgbFace !== undefined) faces.push(rgbFace);
  for (const l of raw) if (!faces.includes(l.face)) faces.push(l.face);
  // anything not on a board face (a connector pin, a board's connector-side terminal) goes last
  const faceRank = (l: RawLanding): number => (l.target.kind !== 'pcba' || l.target.connectorSide === true ? faces.length + 1 : faces.indexOf(l.face));
  const elementRank = (l: RawLanding): number => {
    if (l.element.kind === 'core') return 10 + colourRank(l.element.colour);
    if (l.element.kind === 'screen') return 40 + colourRank(l.element.colour);
    return 60; // the face's ground twist after its cores
  };
  return [...raw].sort(
    (x, y) =>
      faceRank(x) - faceRank(y) ||
      segmentOrder.indexOf(x.segment) - segmentOrder.indexOf(y.segment) ||
      elementRank(x) - elementRank(y) ||
      compareStrings(x.target.terminal, y.target.terminal) ||
      compareStrings(x.segment, y.segment),
  );
}

export function deriveBench(design: CableDesign, db: Db): Bench {
  const sides = trunkSides(design, db);
  const segmentIds = new Set(design.instances.segments.map((s) => s.id));

  // every wire landing, keyed by the target's side of the assembly
  const raw: RawLanding[] = [];
  for (const joint of design.joints) {
    for (const [near, far] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (!segmentIds.has(near.instance) || near.end === undefined) continue;
      if (segmentIds.has(far.instance)) continue;
      const segment = design.instances.segments.find((s) => s.id === near.instance);
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      const target = targetOf(design, db, far);
      if (segment === undefined || wire === undefined || target === undefined) continue;
      let element: LandingElement | undefined;
      if (near.terminal.startsWith('pigtail:')) {
        const id = near.terminal.slice('pigtail:'.length);
        const pigtail = (segment.pigtails ?? []).find((p) => p.id === id && p.end === near.end);
        if (pigtail === undefined) continue;
        const mass = isFullyBonded(wire) && pigtail.members === undefined;
        const members = pigtailMembers(wire, pigtail).filter((path) => !isFoilPath(wire, path));
        element = { kind: 'pigtail', id, members, mass, name: pigtailName(wire, members, mass) };
      } else {
        const found = stockElements(wire).find((e) => e.path === near.terminal);
        if (found === undefined) {
          const resolved = resolveElementPath(wire.structure, near.terminal);
          if (resolved === undefined || isFoilPath(wire, near.terminal)) continue;
          element = { kind: 'core', path: near.terminal, name: near.terminal, shielded: false };
        } else if (found.kind === 'core') {
          element = {
            kind: 'core',
            path: found.path,
            name: found.name,
            ...(found.colour === undefined ? {} : { colour: found.colour }),
            ...(found.label === undefined ? {} : { label: found.label }),
            shielded: found.shielded,
          };
        } else {
          element = { kind: 'screen', path: found.path, name: found.name, ...(found.colour === undefined ? {} : { colour: found.colour }) };
        }
      }
      const face = faceOf(target);
      raw.push({
        segment: segment.id,
        segEnd: near.end,
        element,
        target,
        ...(face === undefined ? {} : { face }),
        ...(joint.note === undefined ? {} : { note: joint.note }),
      });
    }
  }

  const sideOfTarget = (l: RawLanding): EndSide => sides.get(l.target.instance) ?? l.segEnd;

  // the trunk before whips and leads
  const trunkId = trunkSegment(design, db)?.id;
  const segmentOrder = [
    ...(trunkId === undefined ? [] : [trunkId]),
    ...design.instances.segments.map((s) => s.id).filter((id) => id !== trunkId),
  ];
  const ends: BenchEnd[] = [];
  for (const side of ['a', 'b'] as const) {
    const here = raw.filter((l) => sideOfTarget(l) === side);
    // terminations in instance order: boards, then connectors, then parts
    const order = [
      ...design.instances.pcbas.map((i) => i.id),
      ...design.instances.connectors.map((i) => i.id),
      ...design.instances.components.map((i) => i.id),
    ];
    const byTarget = new Map<string, RawLanding[]>();
    for (const l of here) byTarget.set(l.target.instance, [...(byTarget.get(l.target.instance) ?? []), l]);
    const terminations: Termination[] = [];
    let n = 0;
    const numberOf = new Map<RawLanding, number>();
    for (const id of order) {
      const list = byTarget.get(id);
      if (list === undefined) continue;
      const kind = instanceKind(design, id) as Termination['kind'];
      const def = defOf(design, id);
      const landings: Landing[] = orderLandings(list, segmentOrder).map((l) => {
        n += 1;
        numberOf.set(l, n);
        return { n, ...l };
      });
      const pcba = kind === 'pcba' ? findPcba(db, def) : undefined;
      const connector = kind === 'connector' ? findConnector(db, def) : undefined;
      const component = kind === 'component' ? findComponent(db, def) : undefined;
      terminations.push({
        instance: id,
        kind,
        def,
        label: pcba?.label ?? connector?.label ?? component?.label ?? def,
        ...((pcba?.partNumber ?? connector?.partNumber ?? component?.partNumber) === undefined
          ? {}
          : { partNumber: (pcba?.partNumber ?? connector?.partNumber ?? component?.partNumber) as string }),
        landings,
        mounted: kind === 'pcba' ? mountedOn(design, db, id) : [],
      });
    }

    // the segment ends prepared here: every (segment, end) a landing on this side comes from
    const segEnds = new Map<string, { segment: string; end: EndSide }>();
    for (const l of here) segEnds.set(`${l.segment}@${l.segEnd}`, { segment: l.segment, end: l.segEnd });
    const segmentEnds: SegmentEnd[] = [];
    for (const segment of design.instances.segments) {
      for (const end of ['a', 'b'] as const) {
        if (!segEnds.has(`${segment.id}@${end}`)) continue;
        const wire = findWire(db, segment.def);
        if (wire === undefined) continue;
        segmentEnds.push(stripPlan(design, db, segment.id, end, wire, here, numberOf));
      }
    }

    ends.push({ side, terminations, segmentEnds, bridges: bridgesAt(design, db, side, sides) });
  }
  return { designId: design.id, ends };
}

/**
 * Which end of the **trunk** each instance belongs to: whatever is jointed to
 * the trunk's end a (or b), and everything reached from there through other
 * joints and through non-trunk segments (a whip's far plugs belong to the end
 * its near end lands at). An instance reached from both sides is left out.
 */
export function trunkSides(design: CableDesign, db: Db): Map<string, EndSide> {
  const trunk = trunkSegment(design, db)?.id;
  const out = new Map<string, EndSide>();
  if (trunk === undefined) {
    for (const [id, side] of assemblySides(design)) if (side === 'a' || side === 'b') out.set(id, side);
    return out;
  }
  const adjacency = new Map<string, Set<string>>();
  const link = (x: string, y: string): void => {
    adjacency.set(x, (adjacency.get(x) ?? new Set()).add(y));
    adjacency.set(y, (adjacency.get(y) ?? new Set()).add(x));
  };
  const seeds: Record<EndSide, string[]> = { a: [], b: [] };
  for (const joint of design.joints) {
    const [x, y] = [joint.a, joint.b];
    if (x.instance === trunk && y.instance === trunk) continue;
    if (x.instance === trunk && x.end !== undefined) seeds[x.end].push(y.instance);
    else if (y.instance === trunk && y.end !== undefined) seeds[y.end].push(x.instance);
    else link(x.instance, y.instance);
  }
  for (const m of design.instances.mechanical ?? []) if (m.attachedTo !== undefined) link(m.id, m.attachedTo);
  const reach = (from: readonly string[]): Set<string> => {
    const seen = new Set<string>(from);
    const queue = [...from];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      for (const n of adjacency.get(next) ?? []) {
        if (n === trunk || seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return seen;
  };
  const a = reach(seeds.a);
  const b = reach(seeds.b);
  for (const id of a) if (!b.has(id)) out.set(id, 'a');
  for (const id of b) if (!a.has(id)) out.set(id, 'b');
  return out;
}

/** Connectors whose pins are jointed to this board's connector-side terminals. */
function mountedOn(design: CableDesign, db: Db, board: string): { instance: string; label: string }[] {
  const out = new Map<string, string>();
  for (const joint of design.joints) {
    for (const [near, far] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (near.instance !== board || instanceKind(design, far.instance) !== 'connector') continue;
      const def = defOf(design, far.instance);
      out.set(far.instance, findConnector(db, def)?.label ?? def);
    }
  }
  return [...out.entries()].sort((x, y) => compareStrings(x[0], y[0])).map(([instance, label]) => ({ instance, label }));
}

function stripPlan(
  design: CableDesign,
  db: Db,
  segmentId: string,
  end: EndSide,
  wire: WireDefinition,
  landings: readonly RawLanding[],
  numberOf: ReadonlyMap<RawLanding, number>,
): SegmentEnd {
  const segment = design.instances.segments.find((s) => s.id === segmentId);
  const mine = landings.filter((l) => l.segment === segmentId && l.segEnd === end);
  const bonded = isFullyBonded(wire);
  const rows: StripRow[] = [];
  // a breakout run carries only its own core; a mould decides what each conductor does
  const elements = stockElements(wire).filter((e) => inScope(segment, e.path));
  const fates = breakoutFates(design, db);
  const twistOf = (path: string): { pigtail: string; n?: number } | undefined => {
    for (const l of mine) {
      if (l.element.kind === 'pigtail' && l.element.members.includes(path)) {
        const n = numberOf.get(l);
        return { pigtail: l.element.id, ...(n === undefined ? {} : { n }) };
      }
    }
    const declared = (segment?.pigtails ?? []).find((p) => p.end === end && pigtailMembers(wire, p).includes(path));
    return declared === undefined ? undefined : { pigtail: declared.id };
  };
  let massRow: StripRow | undefined;
  for (const element of elements) {
    if (bonded && element.kind !== 'core') {
      // one row for the whole copper mass, never one per braid — after the cores
      if (massRow !== undefined) continue;
      const twist = twistOf(element.path);
      const count = screenPaths(wire).filter((p) => !isFoilPath(wire, p)).length;
      massRow = {
        element: { path: 'mass', kind: 'screen', name: 'Shield mass', shielded: false },
        mass: count,
        treatment: twist === undefined ? { kind: 'cut', why: 'not landed at this end' } : { kind: 'twist', ...twist },
      };
      continue;
    }
    const own = mine.find((l) => l.element.kind !== 'pigtail' && l.element.path === element.path);
    if (own !== undefined) {
      rows.push({ element, treatment: { kind: 'land', n: numberOf.get(own) ?? 0 } });
      continue;
    }
    const fate = fates.get(`${segmentId}:${element.path}@${end}`);
    if (fate?.fate === 'through' && fate.peer !== undefined) {
      rows.push({ element, treatment: { kind: 'through', to: fate.peer.instance } });
      continue;
    }
    if (fate?.fate === 'nc' && fate.reason !== undefined && twistOf(element.path) === undefined) {
      rows.push({ element, treatment: { kind: 'cut', why: fate.reason } });
      continue;
    }
    if (element.kind !== 'core') {
      const twist = twistOf(element.path);
      if (twist !== undefined) {
        rows.push({ element, treatment: { kind: 'twist', ...twist } });
        continue;
      }
      rows.push({
        element,
        treatment: { kind: 'cut', why: element.kind === 'drain' ? 'drain lands at the source only' : 'not landed at this end' },
      });
      continue;
    }
    rows.push({ element, treatment: { kind: 'cut', why: 'not used' } });
  }
  if (massRow !== undefined) rows.push(massRow);
  return {
    segment: segmentId,
    end,
    def: wire.id,
    stock: stripMakerSuffix(wire.label, wire.manufacturer),
    ...(segment?.role === undefined ? {} : { role: segment.role }),
    ...(segment?.lengthMm === undefined ? {} : { lengthMm: segment.lengthMm }),
    bonded,
    rows,
  };
}

/** A terminal in words: `j1 pin 16`, `u2 R`. */
function terminalText(design: CableDesign, db: Db, ref: TerminalRef): string {
  const kind = instanceKind(design, ref.instance);
  if (kind === 'connector') return `${ref.instance} pin ${ref.terminal}`;
  if (kind === 'component') {
    const def = findComponent(db, defOf(design, ref.instance));
    return `${ref.instance}${def?.value === undefined ? '' : ` ${def.value}`}`;
  }
  return `${ref.instance} ${ref.terminal}${ref.pad === undefined ? '' : ` (${ref.pad})`}`;
}

/**
 * Non-wire joints at an end that the bench makes by hand: connector pin to
 * pin (the DB-23 ground bridge), a hand-fitted part's legs. A connector's pin
 * soldering onto its own board's footprint is the board's mating, not a bridge.
 */
function bridgesAt(design: CableDesign, db: Db, side: EndSide, sides: ReadonlyMap<string, EndSide>): Bridge[] {
  const out: Bridge[] = [];
  const components = new Map<string, TerminalRef[]>();
  for (const joint of design.joints) {
    const ka = instanceKind(design, joint.a.instance);
    const kb = instanceKind(design, joint.b.instance);
    if (ka === 'segment' || kb === 'segment') continue;
    const at = sides.get(joint.a.instance) ?? sides.get(joint.b.instance);
    if (at !== side) continue;
    if (ka === 'component' || kb === 'component') {
      const [part, other] = ka === 'component' ? [joint.a, joint.b] : [joint.b, joint.a];
      components.set(part.instance, [...(components.get(part.instance) ?? []), other]);
      continue;
    }
    // a connector onto its board's footprint: the board's own mating
    const boardMate =
      (ka === 'connector' && kb === 'pcba' && joint.b.terminal.includes('.')) ||
      (kb === 'connector' && ka === 'pcba' && joint.a.terminal.includes('.'));
    if (boardMate) continue;
    // a connector shell's legs through its board's GND pads: also the mating
    const shellMate = (ka === 'connector' && kb === 'pcba' && joint.a.terminal === 'shell') || (kb === 'connector' && ka === 'pcba' && joint.b.terminal === 'shell');
    if (shellMate) continue;
    out.push({
      from: terminalText(design, db, joint.a),
      to: terminalText(design, db, joint.b),
      ...(joint.note === undefined ? {} : { note: joint.note }),
    });
  }
  for (const [instance, legs] of components) {
    const def = findComponent(db, defOf(design, instance));
    const [a, b] = legs;
    out.push({
      from: a === undefined ? '' : terminalText(design, db, a),
      to: b === undefined ? '' : terminalText(design, db, b),
      part: `${instance}${def?.value === undefined ? '' : ` ${def.value}`}`,
      ...(design.instances.components.find((c) => c.id === instance)?.note === undefined
        ? {}
        : { note: design.instances.components.find((c) => c.id === instance)?.note as string }),
    });
  }
  return out;
}

/** Stable key for a landing (for tests and markers). */
export function landingKey(landing: Landing): string {
  return `${landing.segment}@${landing.segEnd}:${landing.element.kind === 'pigtail' ? `pigtail:${landing.element.id}` : landing.element.path}→${terminalKey({ instance: landing.target.instance, terminal: landing.target.terminal })}`;
}
