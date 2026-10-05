/**
 * The bench build sheet's data types, and the work-instruction hook's.
 *
 * They live in the model (pure types, no behaviour beyond `benchRulesProvider`)
 * so that a module — `@wirehub/modules`, MIT, which imports nothing from the
 * AGPL docs package — can name them. `@wirehub/docs` derives the `Bench`
 * (`deriveBench`) and renders it; it re-exports these types unchanged.
 */

import { findConnector, type CableDesign, type Db, type WireDefinition } from './model.ts';

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
 * Work instructions
 * ------------------------------------------------------------------ */

/** One printed step of the build sheet. */
export interface Step {
  text: string;
  /** where the step comes from (a work instruction, a standard, "generic practice") */
  src: string;
  /** pictures the step shows: `data:image/…` URIs or `https:` URLs, drawn under the text */
  images?: string[];
  /** tools and consumables the step needs, listed after the text */
  tools?: string[];
  /** things to check before moving on, each printed with a tick box */
  checks?: string[];
}

/** The mechanical parts on one end, grouped under the shell they belong to. */
export interface ShellSet {
  /** the instance the shell encloses */
  attachedTo?: string;
  shell?: { id: string; label: string; partNumber?: string; qty: number };
  parts: { id: string; label: string; partNumber?: string; qty: number; kind: string }[];
}

/**
 * A shop's own work instructions, in place of the generic steps
 * (`specs/drawing-language.md` §8). Each hook returns the steps for that
 * phase, or `undefined` to leave the generic ones; the first registered
 * provider with an answer wins. A provider sees the same facts the generic
 * steps are chosen by — the stock, the end and its terminations, the shells —
 * so instructions can differ per family or termination. Every step cites its
 * source in `src`.
 */
export interface BenchStepsProvider {
  prep?(wire: WireDefinition, bonded: boolean): Step[] | undefined;
  end?(end: BenchEnd, db: Db, other?: BenchEnd): Step[] | undefined;
  assembly?(design: CableDesign, db: Db, end: BenchEnd, sets: readonly ShellSet[], trunkWire: WireDefinition | undefined): Step[] | undefined;
  /** the soldering step */
  solder?: Step;
  /** the functional check after continuity */
  qa?: readonly Step[];
}

export type BenchPhase = 'prep' | 'end' | 'assembly' | 'solder' | 'qa';

/**
 * Standard-work steps as data, so a catalog pack (or a module with no code
 * for it) can ship a shop's instructions. A rule applies to one phase when
 * every key of its `when` matches (any listed value of a key is enough); the
 * steps of all matching rules, in order, replace the generic steps. A rule
 * with no `when` always matches. `solder` and `qa` are not chosen by facts, so
 * their rules take no `when`: the first `solder` rule's first step is the
 * soldering step, and `qa` is every `qa` rule's steps.
 *
 * - `connector`: a connector definition id on the end (`end`, `assembly`);
 * - `family`: that connector's `family` (`D-Sub`), compared ignoring case;
 * - `wire`: the stock's definition id (`prep`, `assembly`);
 * - `stockFamily`: `coax`, or `bonded` for a bonded shielded-core stock (`prep`, `assembly`).
 *
 * A key that a phase cannot see never matches there, so a rule naming
 * `connector` is silent in `prep`.
 */
export interface BenchStepRule {
  /** kebab id, unique within the contribution */
  id: string;
  phase: BenchPhase;
  /** where the rule comes from; required on a record in `bench-rules.json` (every catalog record cites its source) */
  src?: string;
  when?: { connector?: string[]; family?: string[]; wire?: string[]; stockFamily?: ('coax' | 'bonded')[] };
  steps: Step[];
}

const PHASES: readonly BenchPhase[] = ['prep', 'end', 'assembly', 'solder', 'qa'];
const WHEN_KEYS = ['connector', 'family', 'wire', 'stockFamily'] as const;
const IMAGE = /^(data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]|https:\/\/)/;

function stepProblems(step: unknown, where: string): string[] {
  if (typeof step !== 'object' || step === null) return [`${where}: not a step`];
  const s = step as Record<string, unknown>;
  const out: string[] = [];
  if (typeof s['text'] !== 'string' || s['text'].trim() === '') out.push(`${where}: text is empty`);
  if (typeof s['src'] !== 'string' || s['src'].trim() === '') out.push(`${where}: src (where the step comes from) is empty`);
  for (const key of ['tools', 'checks', 'images'] as const) {
    const list = s[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || v === '')) out.push(`${where}: ${key} must be a list of non-empty strings`);
    else if (key === 'images' && list.some((v) => !IMAGE.test(v as string))) out.push(`${where}: images must be data:image URIs or https URLs`);
  }
  return out;
}

/** One sentence per problem in a module's or pack's rules; empty when they are usable. */
export function benchRuleProblems(rules: readonly BenchStepRule[], label = 'bench rules'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const where = `${label}[${i}]${typeof rule?.id === 'string' ? ` '${rule.id}'` : ''}`;
    if (typeof rule?.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id)) out.push(`${where}: id must be kebab-case`);
    else if (seen.has(rule.id)) out.push(`${where}: duplicate id`);
    else seen.add(rule.id);
    if (!PHASES.includes(rule?.phase)) out.push(`${where}: phase must be one of ${PHASES.join(', ')}`);
    if ((rule?.phase === 'solder' || rule?.phase === 'qa') && rule.when !== undefined) out.push(`${where}: a ${rule.phase} rule takes no when`);
    if (!Array.isArray(rule?.steps) || rule.steps.length === 0) out.push(`${where}: steps is empty`);
    else rule.steps.forEach((step, j) => out.push(...stepProblems(step, `${where}.steps[${j}]`)));
    for (const [key, value] of Object.entries(rule?.when ?? {})) {
      if (!(WHEN_KEYS as readonly string[]).includes(key)) out.push(`${where}: unknown when.${key}`);
      else if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) out.push(`${where}: when.${key} must be a non-empty list of strings`);
    }
  });
  return out;
}

function stockFamilyOf(wire: WireDefinition, bonded: boolean): 'coax' | 'bonded' | undefined {
  if (wire.structure.children.some((c) => c.kind === 'group' && c.role === 'coax')) return 'coax';
  return bonded ? 'bonded' : undefined;
}

interface Facts {
  connectors?: { def: string; family: string | undefined }[];
  wire?: { def: string; stockFamily: 'coax' | 'bonded' | undefined };
}

function matches(rule: BenchStepRule, facts: Facts): boolean {
  const when = rule.when;
  if (when === undefined) return true;
  const lower = (v: string): string => v.toLowerCase();
  if (when.connector !== undefined && !(facts.connectors ?? []).some((c) => when.connector?.includes(c.def))) return false;
  if (when.family !== undefined && !(facts.connectors ?? []).some((c) => c.family !== undefined && when.family?.map(lower).includes(lower(c.family)))) return false;
  if (when.wire !== undefined && !(facts.wire !== undefined && when.wire.includes(facts.wire.def))) return false;
  if (when.stockFamily !== undefined && !(facts.wire?.stockFamily !== undefined && when.stockFamily.includes(facts.wire.stockFamily))) return false;
  return true;
}

function connectorFacts(end: BenchEnd, db: Db): NonNullable<Facts['connectors']> {
  return end.terminations.filter((t) => t.kind === 'connector').map((t) => ({ def: t.def, family: findConnector(db, t.def)?.family }));
}

/** The provider a list of rules stands for; it answers only the phases some rule matches. */
export function benchRulesProvider(rules: readonly BenchStepRule[]): BenchStepsProvider {
  const pick = (phase: BenchPhase, facts: Facts): Step[] | undefined => {
    const steps = rules.filter((r) => r.phase === phase && matches(r, facts)).flatMap((r) => r.steps);
    return steps.length === 0 ? undefined : steps;
  };
  const solder = rules.find((r) => r.phase === 'solder')?.steps[0];
  const qa = rules.filter((r) => r.phase === 'qa').flatMap((r) => r.steps);
  return {
    prep: (wire, bonded) => pick('prep', { wire: { def: wire.id, stockFamily: stockFamilyOf(wire, bonded) } }),
    end: (end, db) => pick('end', { connectors: connectorFacts(end, db) }),
    assembly: (_design, db, end, _sets, trunk) =>
      pick('assembly', {
        connectors: connectorFacts(end, db),
        ...(trunk === undefined ? {} : { wire: { def: trunk.id, stockFamily: stockFamilyOf(trunk, (trunk.bonded ?? []).length > 0) } }),
      }),
    ...(solder === undefined ? {} : { solder }),
    ...(qa.length === 0 ? {} : { qa }),
  };
}
