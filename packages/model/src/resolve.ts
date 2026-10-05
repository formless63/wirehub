/**
 * The device resolver: "which cable do I need?" (`docs/resolver.md`).
 *
 * Given a source device and port and a destination device and port, find
 * every way to connect them and rank the ways by the library's policy:
 *
 * - **direct** — pins paired by what they carry: the same signal (an output
 *   onto an input), or signals the vocabulary pairs (`pairsWith`: transmit
 *   onto receive); grounds to grounds, supplies to the inputs that need them;
 * - **conditioned** — the same pairing with conditioning recipes on the lines
 *   whose levels differ, or that a pin or a port requirement asks for (a pad,
 *   a termination);
 * - **straight** — pin for pin, as an off-the-shelf cable would be, when the
 *   two ports have the same positions; listed so its hazards are visible;
 * - **board** — through an adapter board (a device with a `board`) that mates
 *   one end and offers its pads to the cable.
 *
 * Every option lists its links, the parts it takes, its hazards (the
 * library's hazard patterns, matched on every connection), its missing pieces
 * (an input nothing drives, a level nothing converts, a requirement no recipe
 * meets) and the facts nobody confirmed. An option that makes a connection a
 * `reject` hazard matches is refused, with the reason. Nothing is dropped
 * because it ranks lower.
 *
 * Pure: library and query in, a resolution out.
 */

import {
  bindPort,
  devicePort,
  hazardsInForce,
  policyInForce,
  resolveDevice,
  type BoundPin,
  type ConditioningRecipe,
  type DeviceProfile,
  type DevicePort,
  type HazardRule,
  type PinPattern,
  type ResolverLibrary,
} from './devices.ts';
import { vocabEntry, type SignalEntry } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ResolveQuery {
  source: { device: string; port?: string };
  destination: { device: string; port?: string };
  /** consider adapter boards (default true) */
  boards?: boolean;
}

export type End = 'source' | 'destination';

export interface Finding {
  code: string;
  message: string;
  end?: End;
  /** the positions it is about, `<end>:<position>` */
  at?: string[];
  src?: string;
}

/** One line of a cable: a terminal at the source end to one at the destination end. */
export interface Link {
  /** the source end's position (a device port's pin, or an adapter's pad) */
  from: string;
  to: string;
  how: 'same' | 'pair' | 'power' | 'straight';
  signal?: string;
  toSignal?: string;
  /** which end drives the line; absent for a passive or undirected line */
  driver?: End;
  /** conditioning recipes on the line, in order */
  recipes: string[];
  /** the end their parts go at (the receiving end, unless a recipe says otherwise) */
  at?: End;
}

/** A port requirement the option meets with a recipe. */
export interface RequirementUse {
  end: End;
  requirement: string;
  recipe: string;
  positions: string[];
}

/** An adapter board at one end. */
export interface BoardUse {
  end: End;
  device: string;
  pcba: string;
  /** the adapter's port that mates the device */
  mate: string;
  /** the adapter's port the cable lands on */
  pads: string;
}

export type OptionKind = 'direct' | 'conditioned' | 'straight' | 'board';

export interface CableOption {
  /** stable within a library: `direct`, `conditioned:pad-20db`, `board:<device>@source` */
  id: string;
  label: string;
  kind: OptionKind;
  links: Link[];
  /** positions of each end that take the common ground (one return conductor) */
  grounds: { source: string[]; destination: string[] };
  /** chassis / shell positions of each end (the screen lands on them) */
  chassis: { source: string[]; destination: string[] };
  requirements: RequirementUse[];
  boards: BoardUse[];
  /** discrete parts the recipes place */
  parts: number;
  /** conductors the cable needs (lines plus a return) */
  conductors: number;
  hazards: Finding[];
  missing: Finding[];
  unverified: string[];
  /** things worth knowing that are not wrong (an output nothing uses) */
  notes: string[];
  /** why the option is what it is, in sentences */
  reasons: string[];
  /** 1 = preferred */
  rank: number;
  /** the policy criteria values, in policy order (lower wins) */
  score: number[];
}

export interface BoundEnd {
  device: string;
  label: string;
  port: string;
  portLabel: string;
  interface?: string;
  pins: BoundPin[];
}

export interface Resolution {
  query: ResolveQuery;
  source?: BoundEnd;
  destination?: BoundEnd;
  /** the valid options, ranked */
  options: CableOption[];
  /** options a reject hazard refuses */
  rejected: { option: CableOption; why: Finding[] }[];
  /** what stopped the query, or that nothing connects */
  problems: Finding[];
  /** valid options past the policy's `maxOptions` */
  more: number;
}

/* ------------------------------------------------------------------ *
 * Pin relations
 * ------------------------------------------------------------------ */

function signalEntry(lib: ResolverLibrary, id: string | undefined): SignalEntry | undefined {
  return id === undefined ? undefined : vocabEntry<SignalEntry>(lib.vocab, 'signals', id);
}

/** Whether two signals are paired by the vocabulary (`pairsWith`, read both ways). */
export function signalsPair(lib: Pick<ResolverLibrary, 'vocab'>, a: string, b: string): boolean {
  const ea = vocabEntry<SignalEntry>(lib.vocab, 'signals', a);
  const eb = vocabEntry<SignalEntry>(lib.vocab, 'signals', b);
  return (ea?.pairsWith ?? []).includes(b) || (eb?.pairsWith ?? []).includes(a);
}

/** How a source pin can feed a destination pin: by the same signal, by a pairing, or not at all. */
export function pinRelation(lib: Pick<ResolverLibrary, 'vocab'>, s: BoundPin, d: BoundPin): 'same' | 'pair' | undefined {
  if (s.signal === undefined || d.signal === undefined || s.class === 'nc' || d.class === 'nc') return undefined;
  const same = s.signal === d.signal;
  const pair = !same && signalsPair(lib, s.signal, d.signal);
  if (!same && !pair) return undefined;
  if (s.dir !== undefined && d.dir !== undefined) {
    if (s.dir === 'out' && d.dir === 'out') return undefined;
    if (s.dir === 'in' && d.dir === 'in') return undefined;
  }
  return same ? 'same' : 'pair';
}

/** How well the directions fit (lower is better): out→in or bidir↔bidir is exact. */
function dirFit(s: BoundPin, d: BoundPin): number {
  if ((s.dir === 'out' && d.dir === 'in') || (s.dir === 'in' && d.dir === 'out') || (s.dir === 'bidir' && d.dir === 'bidir')) return 0;
  if (s.dir === 'passive' || d.dir === 'passive') return 0;
  return 1;
}

function driverOf(s: BoundPin, d: BoundPin): End | undefined {
  if (s.dir === 'out' || (s.dir === undefined && d.dir === 'in')) return 'source';
  if (d.dir === 'out' || (d.dir === undefined && s.dir === 'in')) return 'destination';
  return undefined;
}

function matchesPattern(p: PinPattern, pin: BoundPin): boolean {
  const kind = pin.class === 'chassis' ? 'ground' : pin.kind;
  if (p.kinds !== undefined && (kind === undefined || !p.kinds.includes(kind))) return false;
  if (p.notKinds !== undefined && kind !== undefined && p.notKinds.includes(kind)) return false;
  if (p.notKinds !== undefined && kind === undefined && pin.signal === undefined) return false;
  if (p.signals !== undefined && (pin.signal === undefined || !p.signals.includes(pin.signal))) return false;
  if (p.notSignals !== undefined && pin.signal !== undefined && p.notSignals.includes(pin.signal)) return false;
  if (p.dirs !== undefined && (pin.dir === undefined || !p.dirs.includes(pin.dir))) return false;
  if (p.levels !== undefined && (pin.level === undefined || !p.levels.includes(pin.level))) return false;
  return true;
}

const pinText = (end: End, pin: BoundPin): string => `${end} pin ${pin.position} (${pin.label}${pin.signal !== undefined && pin.signal !== pin.label ? `, ${pin.signal}` : ''})`;

/** The hazards a connection between two pins matches, both ways round. */
export function hazardsOf(hazards: readonly HazardRule[], s: BoundPin, d: BoundPin): { rule: HazardRule; finding: Finding }[] {
  if (s.class === 'nc' || d.class === 'nc' || s.class === 'open' || d.class === 'open') return [];
  const out: { rule: HazardRule; finding: Finding }[] = [];
  for (const rule of hazards) {
    const relationHolds = (): boolean => {
      if (rule.relation === 'same-signal') return s.signal === d.signal;
      if (rule.relation === 'different-signal') return s.signal !== d.signal;
      if (rule.relation === 'different-level') return s.level !== undefined && d.level !== undefined && s.level !== d.level;
      return true;
    };
    const forward = matchesPattern(rule.a, s) && matchesPattern(rule.b, d);
    const backward = matchesPattern(rule.a, d) && matchesPattern(rule.b, s);
    if (!(forward || backward) || !relationHolds()) continue;
    const [a, b] = forward ? [pinText('source', s), pinText('destination', d)] : [pinText('destination', d), pinText('source', s)];
    out.push({ rule, finding: { code: `hazard:${rule.id}`, message: rule.text.replace('{a}', a).replace('{b}', b), at: [`source:${s.position}`, `destination:${d.position}`], src: rule.src } });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Recipes
 * ------------------------------------------------------------------ */

function recipeTakes(lib: ResolverLibrary, recipe: ConditioningRecipe, pin: BoundPin): boolean {
  const from = recipe.from;
  if (from === undefined) return true;
  if (from.signal !== undefined && from.signal !== pin.signal) return false;
  if (from.kind !== undefined && (signalEntry(lib, pin.signal)?.kind ?? pin.kind) !== from.kind) return false;
  return true;
}

/**
 * What a line needs between a driver and a receiver: `ok` when the levels fit
 * (or one is not stated), else the recipes that convert — each one an
 * alternative; an empty list is a missing piece.
 */
export function levelConversions(lib: ResolverLibrary, driver: BoundPin, receiver: BoundPin, bidirectional: boolean): 'ok' | ConditioningRecipe[] {
  const accepted = [receiver.level, ...(receiver.accepts ?? [])].filter((l): l is string => l !== undefined);
  if (driver.level === undefined || accepted.length === 0 || accepted.includes(driver.level)) return 'ok';
  return (lib.conditioningRecipes ?? []).filter(
    (r) =>
      r.from?.level === driver.level &&
      r.to?.level !== undefined &&
      accepted.includes(r.to.level) &&
      recipeTakes(lib, r, driver) &&
      (!bidirectional || r.bidirectional === true),
  );
}

/** The recipes that realise conditioning `id` on a line carrying `pin`'s signal. */
export function recipesFor(lib: ResolverLibrary, id: string, pin?: BoundPin): ConditioningRecipe[] {
  return (lib.conditioningRecipes ?? []).filter((r) => r.conditioning === id && (pin === undefined || recipeTakes(lib, r, pin)));
}

function findRecipe(lib: ResolverLibrary, id: string): ConditioningRecipe | undefined {
  return (lib.conditioningRecipes ?? []).find((r) => r.id === id);
}

/* ------------------------------------------------------------------ *
 * Pairing two ends
 * ------------------------------------------------------------------ */

/** A decision with alternatives: each alternative is a list of recipe ids for one link or requirement. */
interface Choice {
  kind: 'link' | 'requirement';
  index: number;
  alternatives: string[][];
}

interface Pairing {
  links: Link[];
  grounds: { source: string[]; destination: string[] };
  chassis: { source: string[]; destination: string[] };
  requirements: RequirementUse[];
  missing: Finding[];
  hazards: { rule: HazardRule; finding: Finding }[];
  unverified: string[];
  notes: string[];
  choices: Choice[];
}

interface EndPins {
  end: End;
  pins: BoundPin[];
  port?: DevicePort;
}

function emptyPairing(): Pairing {
  return { links: [], grounds: { source: [], destination: [] }, chassis: { source: [], destination: [] }, requirements: [], missing: [], hazards: [], unverified: [], notes: [], choices: [] };
}

const isUnverified = (pin: BoundPin): boolean => pin.confidence === 'inferred' || pin.confidence === 'unknown';

/** Ground and chassis positions of both ends, and the return finding when one end has none. */
function pairGrounds(S: EndPins, D: EndPins, out: Pairing): void {
  out.grounds.source = S.pins.filter((p) => p.class === 'ground').map((p) => p.position);
  out.grounds.destination = D.pins.filter((p) => p.class === 'ground').map((p) => p.position);
  out.chassis.source = S.pins.filter((p) => p.class === 'chassis').map((p) => p.position);
  out.chassis.destination = D.pins.filter((p) => p.class === 'chassis').map((p) => p.position);
  const hasLines = out.links.length > 0;
  if (hasLines && out.grounds.source.length === 0 && out.grounds.destination.length > 0) {
    out.missing.push({ code: 'no-return', message: `the ${S.end} end has no ground pin for the ${D.end} end's return`, end: S.end });
  }
  if (hasLines && out.grounds.destination.length === 0 && out.grounds.source.length > 0) {
    out.missing.push({ code: 'no-return', message: `the ${D.end} end has no ground pin for the ${S.end} end's return`, end: D.end });
  }
}

/** The port requirements of one end, each a choice among recipes (or a missing piece). */
function requirementChoices(lib: ResolverLibrary, end: EndPins, out: Pairing): void {
  for (const req of end.port?.requires ?? []) {
    const pin = end.pins.find((p) => p.position === req.positions[0]);
    const recipes = recipesFor(lib, req.conditioning, pin);
    if (recipes.length === 0) {
      out.missing.push({ code: 'requirement-unmet', message: `${end.end} port needs ${req.conditioning} on ${req.positions.join(' and ')}${req.text === undefined ? '' : ` (${req.text})`}, and no recipe provides it`, end: end.end, at: req.positions.map((p) => `${end.end}:${p}`), src: req.src });
      continue;
    }
    out.requirements.push({ end: end.end, requirement: req.id, recipe: recipes[0]!.id, positions: req.positions });
    if (recipes.length > 1) out.choices.push({ kind: 'requirement', index: out.requirements.length - 1, alternatives: recipes.map((r) => [r.id]) });
  }
}

/** Conditioning a line needs: level conversion and what either pin `needs`. */
function lineChoices(lib: ResolverLibrary, s: BoundPin, d: BoundPin, link: Link, out: Pairing): void {
  const driver = link.driver === 'destination' ? d : s;
  const receiver = link.driver === 'destination' ? s : d;
  const bidir = s.dir === 'bidir' || d.dir === 'bidir';
  const alternatives: string[][] = [];
  const conv = levelConversions(lib, driver, receiver, bidir);
  const where = [`source:${s.position}`, `destination:${d.position}`];
  if (conv !== 'ok') {
    if (conv.length === 0) {
      out.missing.push({ code: 'level-unconverted', message: `${pinText(link.driver === 'destination' ? 'destination' : 'source', driver)} drives ${driver.level}; ${receiver.label} takes ${[receiver.level, ...(receiver.accepts ?? [])].filter(Boolean).join(' or ')}, and no recipe converts it`, at: where });
    } else alternatives.push(...conv.map((r) => [r.id]));
  }
  const needs = [...(s.needs ?? []), ...(d.needs ?? [])];
  const fixed: string[] = [];
  for (const need of [...new Set(needs)]) {
    const recipes = recipesFor(lib, need, driver);
    if (recipes.length === 0) {
      out.missing.push({ code: 'need-unmet', message: `${pinText('source', s)} → ${d.label} needs ${need}, and no recipe provides it`, at: where });
      continue;
    }
    fixed.push(recipes[0]!.id);
  }
  if (alternatives.length === 0) link.recipes = fixed;
  else {
    link.recipes = [...alternatives[0]!, ...fixed];
    if (alternatives.length > 1) out.choices.push({ kind: 'link', index: out.links.length, alternatives: alternatives.map((a) => [...a, ...fixed]) });
  }
  if (link.recipes.length > 0) {
    const own = findRecipe(lib, link.recipes[0]!)?.location;
    link.at = own === undefined ? (link.driver === 'destination' ? 'source' : 'destination') : own === 'source-hood' ? 'source' : own === 'dest-head' ? 'destination' : link.driver === 'destination' ? 'source' : 'destination';
  }
}

/**
 * The signal pins no link serves: an input nothing drives or a bus line
 * nothing carries is missing (a control input — a handshake — is only
 * noted); an unused output is noted; no signal paired at all, while both ends
 * have some, is missing.
 */
function unmatched(S: EndPins, D: EndPins, usedS: ReadonlySet<string>, usedD: ReadonlySet<string>, out: Pairing): void {
  const check = (end: EndPins, other: EndPins, used: ReadonlySet<string>): void => {
    for (const pin of end.pins.filter((p) => p.class === 'signal' && !used.has(p.position))) {
      if (pin.dir === 'in') {
        const text = `${pinText(end.end, pin)} is an input and nothing on the ${other.end} end drives ${pin.signal}`;
        if (pin.kind === 'control') out.notes.push(text);
        else out.missing.push({ code: 'input-undriven', message: text, at: [`${end.end}:${pin.position}`] });
      } else if (pin.dir === 'bidir') {
        out.missing.push({ code: 'line-unpaired', message: `${pinText(end.end, pin)} is a bus line and nothing on the ${other.end} end carries ${pin.signal}`, at: [`${end.end}:${pin.position}`] });
      } else if (pin.dir === 'out') out.notes.push(`${pinText(end.end, pin)} is not used`);
    }
  };
  check(D, S, usedD);
  check(S, D, usedS);
  const sigS = S.pins.some((p) => p.class === 'signal');
  const sigD = D.pins.some((p) => p.class === 'signal');
  if (sigS && sigD && !S.pins.some((p) => p.class === 'signal' && usedS.has(p.position))) {
    out.missing.push({ code: 'nothing-paired', message: `no signal of the ${S.end} end matches one of the ${D.end} end: the two speak different signals` });
  }
}

/**
 * Pair two ends by what their pins carry: signals (same or paired), supplies
 * to the inputs that need them, grounds and chassis noted per end.
 */
function pairBySignal(lib: ResolverLibrary, hazards: readonly HazardRule[], S: EndPins, D: EndPins): Pairing {
  const out = emptyPairing();
  const usedS = new Set<string>();
  const usedD = new Set<string>();
  const addLink = (s: BoundPin, d: BoundPin, how: Link['how']): void => {
    const driver = driverOf(s, d);
    const link: Link = { from: s.position, to: d.position, how, ...(s.signal === undefined ? {} : { signal: s.signal }), ...(d.signal === undefined ? {} : { toSignal: d.signal }), ...(driver === undefined ? {} : { driver }), recipes: [] };
    lineChoices(lib, s, d, link, out);
    out.links.push(link);
    usedS.add(s.position);
    usedD.add(d.position);
    out.hazards.push(...hazardsOf(hazards, s, d));
    if (isUnverified(s)) out.unverified.push(`${S.end} pin ${s.position} (${s.label}): ${s.confidence}`);
    if (isUnverified(d)) out.unverified.push(`${D.end} pin ${d.position} (${d.label}): ${d.confidence}`);
  };

  // supplies: an input that needs a rail, fed from the same rail on the other end
  for (const d of D.pins.filter((p) => p.class === 'power')) {
    const takes = d.dir === 'out' ? undefined : S.pins.find((s) => s.class === 'power' && !usedS.has(s.position) && s.signal === d.signal && s.dir !== 'in');
    if (takes !== undefined) {
      addLink(takes, d, 'power');
      continue;
    }
    if (d.dir === 'out') {
      const sink = S.pins.find((s) => s.class === 'power' && !usedS.has(s.position) && s.signal === d.signal && s.dir === 'in');
      if (sink !== undefined) addLink(sink, d, 'power');
      continue;
    }
    if (d.dir === 'in') {
      const offered = S.pins.filter((s) => s.class === 'power' && s.dir !== 'in');
      const convert = offered.flatMap((s) => (lib.conditioningRecipes ?? []).filter((r) => r.from?.signal === s.signal && r.to?.signal === d.signal).map((r) => ({ s, r })));
      if (convert.length > 0) {
        const { s, r } = convert[0]!;
        const link: Link = { from: s.position, to: d.position, how: 'power', ...(s.signal === undefined ? {} : { signal: s.signal }), ...(d.signal === undefined ? {} : { toSignal: d.signal }), driver: 'source', recipes: [r.id], at: 'destination' };
        out.links.push(link);
        usedS.add(s.position);
        usedD.add(d.position);
        if (convert.length > 1) out.choices.push({ kind: 'link', index: out.links.length - 1, alternatives: convert.map((c) => [c.r.id]) });
      } else {
        out.missing.push({ code: 'supply-missing', message: `${pinText(D.end, d)} needs ${d.signal}; the ${S.end} end ${offered.length === 0 ? 'offers no supply' : `offers ${offered.map((s) => s.signal).join(', ')}`}`, at: [`${D.end}:${d.position}`] });
      }
    }
  }
  for (const s of S.pins.filter((p) => p.class === 'power' && p.dir === 'in' && !usedS.has(p.position))) {
    out.missing.push({ code: 'supply-missing', message: `${pinText(S.end, s)} needs ${s.signal}, and the ${D.end} end does not supply it`, at: [`${S.end}:${s.position}`] });
  }

  // signals: each destination pin fed by the best source pin still free
  const sources = S.pins.filter((p) => p.class === 'signal');
  for (const d of D.pins.filter((p) => p.class === 'signal')) {
    const candidates = sources
      .filter((s) => !usedS.has(s.position))
      .map((s) => ({ s, how: pinRelation(lib, s, d) }))
      .filter((c): c is { s: BoundPin; how: 'same' | 'pair' } => c.how !== undefined)
      .sort((x, y) => dirFit(x.s, d) - dirFit(y.s, d));
    const best = candidates[0];
    if (best !== undefined) {
      addLink(best.s, d, best.how);
    }
  }
  unmatched(S, D, usedS, usedD, out);
  pairGrounds(S, D, out);
  requirementChoices(lib, S, out);
  requirementChoices(lib, D, out);
  return out;
}

/** Pin for pin: every position both ends have, joined as it is. */
function pairStraight(lib: ResolverLibrary, hazards: readonly HazardRule[], S: EndPins, D: EndPins, mated: boolean): Pairing {
  const out = emptyPairing();
  const usedS = new Set<string>();
  const usedD = new Set<string>();
  const dBy = new Map(D.pins.map((p) => [p.position, p] as const));
  for (const s of S.pins) {
    const d = dBy.get(s.position);
    if (d === undefined) continue;
    if (s.class === 'nc' || d.class === 'nc' || s.class === 'open' || d.class === 'open') continue;
    if ((s.class === 'ground' || s.class === 'chassis') && (d.class === 'ground' || d.class === 'chassis')) continue;
    const found = hazardsOf(hazards, s, d);
    out.hazards.push(...found);
    if (isUnverified(s)) out.unverified.push(`${S.end} pin ${s.position} (${s.label}): ${s.confidence}`);
    if (isUnverified(d)) out.unverified.push(`${D.end} pin ${d.position} (${d.label}): ${d.confidence}`);
    const how = pinRelation(lib, s, d);
    if (how !== undefined) {
      usedS.add(s.position);
      usedD.add(d.position);
    }
    if (how === undefined && found.length === 0) {
      out.missing.push({ code: mated ? 'mate-mismatch' : 'straight-mismatch', message: `${pinText(S.end, s)} meets ${pinText(D.end, d)}`, at: [`${S.end}:${s.position}`, `${D.end}:${d.position}`] });
    }
    if (!mated) {
      const driver = driverOf(s, d);
      const link: Link = { from: s.position, to: d.position, how: 'straight', ...(s.signal === undefined ? {} : { signal: s.signal }), ...(d.signal === undefined ? {} : { toSignal: d.signal }), ...(driver === undefined ? {} : { driver }), recipes: [] };
      if (how !== undefined) lineChoices(lib, s, d, link, out);
      out.links.push(link);
    }
  }
  if (!mated) {
    unmatched(S, D, usedS, usedD, out);
    pairGrounds(S, D, out);
    requirementChoices(lib, S, out);
    requirementChoices(lib, D, out);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

function partsOf(lib: ResolverLibrary, ids: readonly string[]): number {
  return ids.reduce((n, id) => n + (findRecipe(lib, id)?.parts.length ?? 0), 0);
}

/** Each combination of the choices, the first alternatives first; at most `cap`. */
function expand(p: Pairing, cap: number): Pairing[] {
  let variants: Pairing[] = [p];
  for (const choice of p.choices) {
    const next: Pairing[] = [];
    for (const v of variants) {
      for (const alt of choice.alternatives) {
        if (next.length >= cap) break;
        const copy: Pairing = { ...v, links: v.links.map((l) => ({ ...l })), requirements: v.requirements.map((r) => ({ ...r })) };
        if (choice.kind === 'link') copy.links[choice.index]!.recipes = alt;
        else copy.requirements[choice.index]!.recipe = alt[0]!;
        next.push(copy);
      }
    }
    variants = next;
  }
  return variants;
}

interface Built {
  option: Omit<CableOption, 'rank' | 'score'>;
  rejects: Finding[];
}

function build(lib: ResolverLibrary, kind: OptionKind, p: Pairing, boards: BoardUse[], extra: { hazards?: Pairing['hazards']; missing?: Finding[]; unverified?: string[]; label: string; reasons?: string[] }): Built {
  const recipeIds = [...p.links.flatMap((l) => l.recipes), ...p.requirements.map((r) => r.recipe)];
  const allHazards = [...p.hazards, ...(extra.hazards ?? [])];
  const rejects = allHazards.filter((h) => h.rule.severity === 'reject').map((h) => h.finding);
  const warnings = allHazards.filter((h) => h.rule.severity === 'warning').map((h) => h.finding);
  const effectiveKind: OptionKind = kind === 'direct' && recipeIds.length > 0 ? 'conditioned' : kind;
  const recipePart = [...new Set(recipeIds)].sort().join('+');
  const boardPart = boards.map((b) => `${b.device}@${b.end}`).join('+');
  const id = [effectiveKind, ...(boardPart === '' ? [] : [boardPart]), ...(recipePart === '' ? [] : [recipePart])].join(':');
  const lines = p.links.length;
  const conductors = lines + (p.grounds.source.length > 0 && p.grounds.destination.length > 0 ? 1 : 0);
  const parts = partsOf(lib, recipeIds);
  const reasons: string[] = [...(extra.reasons ?? [])];
  const crossed = p.links.filter((l) => l.how === 'pair');
  if (effectiveKind !== 'straight') reasons.push(`${lines} line${lines === 1 ? '' : 's'} paired by signal${crossed.length > 0 ? `, ${crossed.length} crossed (${crossed.map((l) => `${l.signal} → ${l.toSignal}`).join(', ')})` : ''}`);
  for (const r of [...new Set(recipeIds)]) {
    const recipe = findRecipe(lib, r);
    if (recipe !== undefined) reasons.push(`${recipe.label}: ${recipe.parts.map((x) => `${x.value ?? x.kind ?? x.component ?? ''} ${x.placement}`.trim()).join(', ')}`);
  }
  if (p.grounds.source.length > 0 && p.grounds.destination.length > 0) reasons.push('one return conductor joins the grounds');
  const unverified = [...new Set([...p.unverified, ...(extra.unverified ?? [])])];
  return {
    option: {
      id,
      label: extra.label,
      kind: effectiveKind,
      links: p.links,
      grounds: p.grounds,
      chassis: p.chassis,
      requirements: p.requirements,
      boards,
      parts,
      conductors,
      hazards: warnings,
      missing: [...p.missing, ...(extra.missing ?? [])],
      unverified,
      notes: p.notes,
      reasons,
    },
    rejects,
  };
}

function criterion(c: string, o: Omit<CableOption, 'rank' | 'score'>): number {
  switch (c) {
    case 'missing':
      return o.missing.length;
    case 'hazards':
      return o.hazards.length;
    case 'unverified':
      return o.unverified.length;
    case 'boards':
      return o.boards.length;
    case 'prefer-boards':
      return -o.boards.length;
    case 'parts':
      return o.parts;
    case 'conductors':
      return o.conductors;
    case 'straight':
      return o.kind === 'straight' ? 0 : 1;
    default:
      return 0;
  }
}

function boundEnd(lib: ResolverLibrary, device: DeviceProfile, port: DevicePort): BoundEnd {
  return {
    device: device.id,
    label: device.label,
    port: port.id,
    portLabel: port.label ?? port.id,
    ...(port.interface === undefined ? {} : { interface: port.interface }),
    pins: bindPort(lib, port),
  };
}

/** Adapters (devices with a board) that can sit at `end`, mating `port`: the mating port and the pad port. */
function adaptersFor(lib: ResolverLibrary, port: DevicePort): { device: DeviceProfile; mate: DevicePort; pads: DevicePort }[] {
  if (port.interface === undefined) return [];
  const out: { device: DeviceProfile; mate: DevicePort; pads: DevicePort }[] = [];
  for (const raw of lib.devices ?? []) {
    const device = resolveDevice(lib.devices, raw.id);
    if (device?.board === undefined || device.status === 'retired') continue;
    const mate = device.ports.find((p) => p.interface === port.interface && p.terminals !== undefined && p.terminals !== '');
    const pads = device.ports.find((p) => p.terminals === '');
    if (mate !== undefined && pads !== undefined) out.push({ device, mate, pads });
  }
  return out;
}

/**
 * Every way to connect `query.source` to `query.destination`, ranked by the
 * library's policy (`resolver-policy.json`, else `DEFAULT_RESOLVER_POLICY`).
 */
export function resolve(lib: ResolverLibrary, query: ResolveQuery): Resolution {
  const out: Resolution = { query, options: [], rejected: [], problems: [], more: 0 };
  const src = resolveDevice(lib.devices, query.source.device);
  if (src === undefined) {
    out.problems.push({ code: 'device-unknown', message: `there is no device '${query.source.device}'`, end: 'source' });
    return out;
  }
  const dst = resolveDevice(lib.devices, query.destination.device);
  if (dst === undefined) {
    out.problems.push({ code: 'device-unknown', message: `there is no device '${query.destination.device}'`, end: 'destination' });
    return out;
  }
  const sPort = devicePort(src, query.source.port, 'source');
  const dPort = devicePort(dst, query.destination.port, 'sink');
  if (sPort === undefined) {
    out.problems.push({ code: 'port-unknown', message: `${src.label} has no port${query.source.port === undefined ? '' : ` '${query.source.port}'`}`, end: 'source' });
    return out;
  }
  if (dPort === undefined) {
    out.problems.push({ code: 'port-unknown', message: `${dst.label} has no port${query.destination.port === undefined ? '' : ` '${query.destination.port}'`}`, end: 'destination' });
    return out;
  }
  out.source = boundEnd(lib, src, sPort);
  out.destination = boundEnd(lib, dst, dPort);
  const policy = policyInForce(lib);
  const hazards = hazardsInForce(lib);
  const S: EndPins = { end: 'source', pins: out.source.pins, port: sPort };
  const D: EndPins = { end: 'destination', pins: out.destination.pins, port: dPort };
  const built: Built[] = [];
  const CAP = 16;

  // direct and conditioned
  const paired = pairBySignal(lib, hazards, S, D);
  for (const variant of expand(paired, CAP)) built.push(build(lib, 'direct', variant, [], { label: 'Wired by signal' }));

  // straight, when the ports have the same positions and pairing is not already pin for pin
  const samePositions = S.pins.length > 0 && S.pins.length === D.pins.length && S.pins.every((p) => D.pins.some((q) => q.position === p.position));
  const pinForPin = paired.links.length > 0 && paired.links.every((l) => l.from === l.to);
  if (samePositions && !pinForPin) {
    const straight = pairStraight(lib, hazards, S, D, false);
    for (const variant of expand(straight, CAP)) built.push(build(lib, 'straight', variant, [], { label: 'Straight through (pin for pin)', reasons: ['every pin to the same pin, as an off-the-shelf cable'] }));
  }

  // through an adapter board at one end (or both)
  if (query.boards !== false) {
    const atSource = adaptersFor(lib, sPort);
    const atDest = adaptersFor(lib, dPort);
    const tryBoards = (sa: (typeof atSource)[number] | undefined, da: (typeof atDest)[number] | undefined): void => {
      const boards: BoardUse[] = [];
      const extraHazards: Pairing['hazards'] = [];
      const extraMissing: Finding[] = [];
      const extraUnverified: string[] = [];
      let left: EndPins = S;
      let right: EndPins = D;
      const reasons: string[] = [];
      if (sa !== undefined) {
        const mate = pairStraight(lib, hazards, S, { end: 'destination', pins: bindPort(lib, sa.mate) }, true);
        extraHazards.push(...mate.hazards);
        extraMissing.push(...mate.missing);
        extraUnverified.push(...mate.unverified);
        left = { end: 'source', pins: bindPort(lib, sa.pads), port: sa.pads };
        boards.push({ end: 'source', device: sa.device.id, pcba: sa.device.board!, mate: sa.mate.id, pads: sa.pads.id });
        reasons.push(`${sa.device.label} mates the ${src.label} port and carries the cable from its pads`);
      }
      if (da !== undefined) {
        const mate = pairStraight(lib, hazards, { end: 'source', pins: bindPort(lib, da.mate) }, D, true);
        extraHazards.push(...mate.hazards);
        extraMissing.push(...mate.missing);
        extraUnverified.push(...mate.unverified);
        right = { end: 'destination', pins: bindPort(lib, da.pads), port: da.pads };
        boards.push({ end: 'destination', device: da.device.id, pcba: da.device.board!, mate: da.mate.id, pads: da.pads.id });
        reasons.push(`${da.device.label} mates the ${dst.label} port and takes the cable on its pads`);
      }
      const p = pairBySignal(lib, hazards, left, right);
      // the device-side requirements still apply where a board does not stand in front of them
      for (const variant of expand(p, CAP)) {
        built.push(build(lib, 'board', variant, boards, { hazards: extraHazards, missing: extraMissing, unverified: extraUnverified, label: `Through ${boards.map((b) => resolveDevice(lib.devices, b.device)?.label ?? b.device).join(' and ')}`, reasons }));
      }
    };
    for (const a of atSource) tryBoards(a, undefined);
    for (const a of atDest) tryBoards(undefined, a);
    for (const a of atSource) for (const b of atDest) tryBoards(a, b);
  }

  // rank, refuse, dedupe
  const seen = new Set<string>();
  const valid: Omit<CableOption, 'rank' | 'score'>[] = [];
  for (const b of built) {
    if (seen.has(b.option.id)) continue;
    seen.add(b.option.id);
    if (b.rejects.length > 0) out.rejected.push({ option: { ...b.option, rank: 0, score: [] }, why: b.rejects });
    else valid.push(b.option);
  }
  const scored = valid.map((o) => ({ o, score: policy.order.map((c) => criterion(c, o)) }));
  scored.sort((x, y) => {
    for (let i = 0; i < x.score.length; i++) if (x.score[i] !== y.score[i]) return x.score[i]! - y.score[i]!;
    return x.o.id.localeCompare(y.o.id);
  });
  const max = policy.maxOptions ?? 12;
  out.options = scored.slice(0, max).map(({ o, score }, i) => ({ ...o, rank: i + 1, score }));
  out.more = Math.max(0, scored.length - max);
  if (out.options.length === 0) out.problems.push({ code: 'no-option', message: `nothing connects ${src.label} (${sPort.label ?? sPort.id}) to ${dst.label} (${dPort.label ?? dPort.id}) without a refused connection` });
  return out;
}

/** The option a recipe names, else the top-ranked one. */
export function optionOf(resolution: Resolution, id?: string): CableOption | undefined {
  if (id === undefined) return resolution.options[0];
  return resolution.options.find((o) => o.id === id) ?? resolution.rejected.find((r) => r.option.id === id)?.option;
}
