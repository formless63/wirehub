/**
 * What is *in* a signal path, and what a meter will therefore read across it.
 *
 * `core` tells us a path exists and annotates each thing the signal passed
 * through — a two-terminal component instance, or a PCBA's own `via` string
 * ("C201 0.1 µF → U201 LM1881 sync stripper → R202 470 Ω"). It deliberately
 * stops there: `core` owns continuity, not electrical behaviour.
 *
 * This module supplies the behaviour, and it exists because of one fact that
 * ruins bench days:
 *
 * > **A path that exists is not a path a multimeter beeps on.**
 *
 * A 220 µF coupling capacitor in series reads *open* on a DC continuity
 * range. An LM1881 sync stripper does not conduct at all — it regenerates the
 * signal, so its output has no galvanic relationship to its input. A 470 Ω
 * series resistor reads 470 Ω, not a beep. Only plain copper and bridged 0 Ω
 * jumpers beep. A test document that says "expect continuity" across a
 * coupling cap gets the cap desoldered by a well-meaning tech.
 *
 * So every passage is decomposed into elements, each element is classified,
 * and the path takes the verdict of its worst element. A board link's
 * elements are core's structure (`PcbaInternalLink.elements`, falling back to
 * core's parse of the `via` for a definition that has none — cable-studio-
 * 6n6.7); where a real `ComponentDefinition` exists (a discrete part
 * instanced in the design) its declared `kind` is used, because a declared
 * fact outranks a parse.
 */

import {
  findComponent,
  ohmsOfText,
  parseLinkElement,
  parseVia,
  valueOfText,
  type Db,
  type Passage,
  type PcbaLinkElement,
  type PcbaLinkElementKind,
} from '@cable-studio/model';

import { compareStrings } from './text.ts';

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */

export type ElementRole =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'ic'
  | 'jumper'
  | 'switch'
  | 'unknown';

/**
 * What one element does to a DC continuity measurement.
 *
 * - `pass` — copper, or near enough: a resistor, a bridged 0 Ω jumper.
 * - `block` — a series capacitor. Open on DC, by design.
 * - `active` — a semiconductor that regenerates rather than conducts.
 * - `conditional` — a jumper or switch position that may or may not be made.
 * - `unknown` — parsed as a part but with no value or role we can vouch for.
 */
export type ElementDc = 'pass' | 'block' | 'active' | 'conditional' | 'unknown';

export interface PassageElement {
  /** the element's own slice of the `via` string, verbatim */
  text: string;
  /** the design instance the element sits in — `C1` on u1 is not `C1` on u2 */
  instance?: string;
  role: ElementRole;
  /** reference designator, when the text names one: `C201`, `JP1`, `U1` */
  designator?: string;
  /** printed value, when the text names one: `220 µF`, `470 Ω` */
  value?: string;
  /** resistance in ohms, when the value parses as one */
  ohms?: number;
  dc: ElementDc;
}

/* ------------------------------------------------------------------ *
 * From core's structured link elements
 * ------------------------------------------------------------------ */

const ROLE_OF_KIND: Readonly<Record<PcbaLinkElementKind, ElementRole>> = {
  resistor: 'resistor',
  capacitor: 'capacitor',
  inductor: 'inductor',
  ic: 'ic',
  jumper: 'jumper',
  switch: 'switch',
  other: 'unknown',
};

/**
 * What one board-link element does to a DC reading. A jumper is copper only
 * when the def says it is bridged (or a 0 Ω link): `JP201 0 Ω (bridged —
 * CPL Basic)` is fitted on this build; a bare `JP1 (solder jumper — build
 * option)` is an option nobody has recorded as taken, and the honest verdict
 * is "depends on the build".
 */
function dcOf(role: ElementRole, element: PcbaLinkElement): ElementDc {
  switch (role) {
    case 'resistor':
    case 'inductor':
      return 'pass';
    case 'capacitor':
      return 'block';
    case 'ic':
      return 'active';
    case 'jumper':
      return element.state === 'bridged' || element.ohms === 0 ? 'pass' : 'conditional';
    case 'switch':
      return 'conditional';
    default:
      return 'unknown';
  }
}

/** A board link's structured element, classified for the meter. */
export function passageElementOf(element: PcbaLinkElement, instance?: string): PassageElement {
  const role = ROLE_OF_KIND[element.kind];
  return {
    text: element.text,
    ...(instance === undefined ? {} : { instance }),
    role,
    ...(element.designator === undefined ? {} : { designator: element.designator }),
    ...(element.value === undefined ? {} : { value: element.value }),
    ...(element.ohms === undefined || role !== 'resistor' ? {} : { ohms: element.ohms }),
    dc: dcOf(role, element),
  };
}

/** Classify one `→`-separated slice of a `via` string (core's parser, then the meter rules). */
export function parsePassageElement(rawText: string): PassageElement {
  return passageElementOf(parseLinkElement(rawText));
}

/**
 * The elements of one passage.
 *
 * A component instance resolves against its `ComponentDefinition`, whose
 * `kind` is an authored fact — no regex involved. A PCBA `via` string is
 * split on `→` and each slice parsed.
 */
export function passageElements(passage: Passage, db: Db): PassageElement[] {
  if (passage.kind === 'component' && passage.def !== undefined) {
    const component = findComponent(db, passage.def);
    if (component !== undefined) {
      const value = component.value ?? valueOfText(component.label);
      const ohms = value === undefined ? undefined : ohmsOfText(value);
      const role: ElementRole =
        component.kind === 'resistor'
          ? 'resistor'
          : component.kind === 'capacitor'
            ? 'capacitor'
            : component.kind === 'ic'
              ? 'ic'
              : component.kind === 'switch'
                ? 'switch'
                : 'unknown';
      const dc: ElementDc =
        role === 'resistor'
          ? 'pass'
          : role === 'capacitor'
            ? 'block'
            : role === 'ic'
              ? 'active'
              : role === 'switch'
                ? 'conditional'
                : 'unknown';
      return [
        {
          text: passage.description,
          instance: passage.instance,
          role,
          designator: passage.instance,
          ...(value === undefined ? {} : { value }),
          ...(ohms === undefined || role !== 'resistor' ? {} : { ohms }),
          dc,
        },
      ];
    }
  }
  // a board link: core's structured elements (declared, or parsed from `via`)
  const elements = passage.elements ?? parseVia(passage.description);
  return elements.map((element) => passageElementOf(element, passage.instance));
}

/* ------------------------------------------------------------------ *
 * Path verdicts
 * ------------------------------------------------------------------ */

/**
 * What a bench tech should expect from a DC continuity meter across a path.
 *
 * `continuous` and `resistive` both beep-or-read; everything else does not,
 * and the difference between them is the difference between a good cable and
 * a returned one.
 */
export type PathVerdict =
  | 'continuous'
  | 'resistive'
  | 'blocked'
  | 'active'
  | 'exclusive'
  | 'conditional'
  | 'unknown';

export interface PathBehaviour {
  verdict: PathVerdict;
  /** true only when a meter on a DC range will actually read the path */
  dcContinuous: boolean;
  /** total series resistance in ohms, when every resistive element has a value */
  ohms?: number;
  /** unresolved resistors sitting in the path (value not recorded) */
  unvaluedResistors: number;
  /** every element, in path order */
  elements: PassageElement[];
  /** elements that break DC: capacitors */
  blockedBy: PassageElement[];
  /** elements that are active silicon */
  activeBy: PassageElement[];
  /** elements whose state depends on the build: unbridged jumpers, switches */
  conditionalOn: PassageElement[];
  /**
   * elements that name one part in two different states — a path that walks
   * through `SW1 (CS position)` *and* `SW1 (L position)` cannot exist in any
   * single build
   */
  exclusiveOn: PassageElement[];
  /** one sentence a tech can act on */
  expectation: string;
}

function formatOhms(ohms: number): string {
  if (ohms >= 1_000_000) return `${(ohms / 1_000_000).toFixed(1).replace(/\.0$/, '')} MΩ`;
  if (ohms >= 1_000) return `${(ohms / 1_000).toFixed(1).replace(/\.0$/, '')} kΩ`;
  return `${ohms.toFixed(0)} Ω`;
}

function describe(elements: PassageElement[]): string {
  const names = elements.map((element) => element.designator ?? element.value ?? element.text);
  return [...new Set(names)].join(', ');
}

/**
 * Elements that name the same part on the same instance in two different
 * states. `core` records each switch position as its own link, so a graph walk
 * can happily string two positions of one SP3T together — a path that is real
 * in the model and impossible on the bench. Naming it here is the only place
 * that catches it.
 */
function exclusiveElements(elements: PassageElement[]): PassageElement[] {
  const byPart = new Map<string, Set<string>>();
  for (const element of elements) {
    if (element.designator === undefined) continue;
    if (element.role !== 'switch' && element.role !== 'jumper') continue;
    const part = `${element.instance ?? ''}/${element.designator}`;
    const states = byPart.get(part);
    if (states === undefined) byPart.set(part, new Set([element.text]));
    else states.add(element.text);
  }
  const conflicted = new Set(
    [...byPart.entries()].filter(([, states]) => states.size > 1).map(([part]) => part),
  );
  return elements.filter(
    (element) =>
      element.designator !== undefined &&
      conflicted.has(`${element.instance ?? ''}/${element.designator}`),
  );
}

/**
 * Fold a path's passages into a single expectation.
 *
 * Precedence is deliberate and is the load-bearing rule of the whole test
 * spec: **active silicon outranks a blocking capacitor outranks a conditional
 * jumper outranks an unknown part outranks plain copper.** A path with both a
 * coupling cap and an LM1881 is reported as active, because "this path is
 * regenerated, do not meter it" is the instruction that keeps the cap on the
 * board — where "open circuit" alone would invite a rework.
 */
export function pathBehaviour(passages: Passage[], db: Db): PathBehaviour {
  const elements = passages.flatMap((passage) => passageElements(passage, db));

  const blockedBy = elements.filter((element) => element.dc === 'block');
  const activeBy = elements.filter((element) => element.dc === 'active');
  const conditionalOn = elements.filter((element) => element.dc === 'conditional');
  const unknowns = elements.filter((element) => element.dc === 'unknown');
  const exclusiveOn = exclusiveElements(elements);

  const resistors = elements.filter((element) => element.role === 'resistor');
  const valued = resistors.filter((element) => element.ohms !== undefined);
  const unvaluedResistors = resistors.length - valued.length;
  const ohms = valued.reduce((total, element) => total + (element.ohms ?? 0), 0);
  const haveOhms = unvaluedResistors === 0;

  let verdict: PathVerdict;
  if (exclusiveOn.length > 0) verdict = 'exclusive';
  else if (activeBy.length > 0) verdict = 'active';
  else if (blockedBy.length > 0) verdict = 'blocked';
  else if (conditionalOn.length > 0) verdict = 'conditional';
  else if (unknowns.length > 0) verdict = 'unknown';
  else if (resistors.length > 0) verdict = 'resistive';
  else verdict = 'continuous';

  const dcContinuous = verdict === 'continuous' || verdict === 'resistive';

  let expectation: string;
  switch (verdict) {
    case 'continuous':
      expectation = 'Continuity — meter beeps, < 5 Ω end to end.';
      break;
    case 'resistive':
      expectation = haveOhms
        ? `Continuity through ${formatOhms(ohms)} series resistance — meter reads ≈ ${formatOhms(ohms)}, not a beep.`
        : `Continuity through series resistance of unrecorded value (${describe(resistors)}) — meter reads a resistance, not a beep.`;
      break;
    case 'blocked':
      expectation = `NOT DC-continuous — series capacitor(s) ${describe(blockedBy)} block DC. A meter reads OPEN. This is correct; do not rework.`;
      break;
    case 'active':
      expectation = `NOT DC-continuous — active silicon (${describe(activeBy)}) in the path. The signal is regenerated, not conducted. Verify with a live signal, never with a meter.`;
      break;
    case 'exclusive':
      expectation = `Not a buildable path — it runs through ${describe(exclusiveOn)} in more than one state at once. No reading applies; the model lists every switch position, the hardware picks one.`;
      break;
    case 'conditional':
      expectation = `Continuity depends on build state — ${describe(conditionalOn)}. Confirm the fitted option before judging the reading.`;
      break;
    default:
      expectation = `Path contains an unclassified part (${describe(unknowns)}) — behaviour unverified; treat the reading as informational.`;
  }

  return {
    verdict,
    dcContinuous,
    ...(haveOhms && resistors.length > 0 ? { ohms } : {}),
    unvaluedResistors,
    elements,
    blockedBy,
    activeBy,
    conditionalOn,
    exclusiveOn,
    expectation,
  };
}

/** Compact "what is in the way" text: the passage descriptions, joined. */
export function passagesText(passages: Passage[]): string {
  return passages.map((passage) => passage.description).join(' → ');
}

/** Deterministic ordering for a passage list used as a grouping key. */
export function passageKey(passages: Passage[]): string {
  return passages
    .map((passage) => `${passage.instance}/${passage.description}`)
    .sort(compareStrings)
    .join('|');
}

export { formatOhms };
