/**
 * The new-cable wizard — a guided flow that produces a *wired* design.
 *
 * "New" used to hand a non-technical user a blank canvas and wish them luck.
 * This module is the other answer: six questions whose answers the catalog can
 * already turn into a real cable — instances, joints, the drain note and all —
 * so what lands on the canvas is a design somebody could build.
 *
 * Everything here is pure. No React, no IO, no `Date.now()`: the flow is a
 * reducer over a `WizardState` and the wiring is a function from that state to
 * a `CableDesign`, which is what makes both testable against the real catalog.
 *
 * ## The one rule the generator obeys
 *
 * **Never invent a joint.** A conductor is soldered only where the catalog says
 * so without ambiguity — one landing on this end carries that signal, and only
 * one. Two candidates is a question for the user (`openChoices`), none is a
 * sentence on the review step (`unconnected`). Nothing is guessed quietly.
 *
 * ## Where the conventions come from
 *
 * They are read out of the data, never hardcoded. First from the vocab
 * **tags** (`signalOf`): a pin's signal, a pad's role and signal, the lane
 * the stock's colour code gives each core. Only a terminal nobody has tagged
 * is read from its words — matched against the catalog's own `signals` list
 * (label, short name, aliases), so a domain module's pack teaches the wizard
 * its signals without a line of code here:
 *
 * - **Wire cores** carry their role in their tags or their own `label`.
 * - **Connector pins** carry theirs in `label`/`aliases` ("Audio L", "TXD",
 *   "+5 V", "GND"); a pin whose words (or `oneOf` tag) name several signals
 *   takes a core of any of them.
 * - **Board pads** carry theirs in `label`, and their `note` says whether a
 *   pad is where the *trunk* lands ("conductor landing pad H9") or where a
 *   *connector pin* does ("connector pin landing pad H1") — which is how the
 *   wizard knows to solder the cable to one set and a plug to the other.
 *
 * Shields and the drain go to ground. A shield whose core has a role prefers
 * the return the vocabulary names for that signal (`returnFor`), which is how
 * a connector with per-signal returns gets each braid on its own return;
 * otherwise every shield and the drain bond to the end's general ground.
 */

import {
  bindPort,
  diffPairs,
  pairPins,
  stockShape,
  CHASSIS_SIGNAL,
  CURRENT_SCHEMA_VERSION,
  GROUND_SIGNAL,
  findConnector,
  findPcba,
  findWire,
  isGroundSignal,
  kindOfSignal,
  laneOfPadRole,
  migrateShieldBonds,
  resolveElementPath,
  readSignalLabels,
  returnOf,
  signalIds,
  signalOf,
  signalOfLane,
  validateDesign,
  wireElementName,
  vocabEntry,
  type BoundPin,
  type Link as PinLink,
  type PinDir,
  type SignalEntry,
  type TerminalTags,
  type CableDesign,
  type ConnectorDefinition,
  type Db,
  type Element,
  type Issue,
  type Joint,
  type PcbaDefinition,
  type TerminalRef,
  type WireDefinition,
} from '@wirehub/model';

import { isDesignId, suggestDesignId } from './persistence.ts';

/* ------------------------------------------------------------------ *
 * Roles — what a wire, pin or pad is for
 * ------------------------------------------------------------------ */

/**
 * What a wire, pin or pad is for: a vocab signal id (`audio-l`,
 * `rs232-txd`, whatever a module's pack defines), a kind-level role for a
 * conductor whose lane names only a kind (`kind:power` — any supply rail), or
 * `ground`. The wizard knows no signal by name; everything comes from the
 * catalog's vocabulary.
 */
export type Role = string;

export const GROUND_ROLE: Role = 'ground';

/**
 * The class a *ground* belongs to: the id of the return it is
 * (`gnd-audio` — a return with `returnFor`), `chassis` for the shell tab (a
 * bond, not a signal return), `other` for a return the vocabulary gives no
 * signals for; `undefined` is the end's general ground.
 */
export type GroundClass = string;

const KIND_ROLE = 'kind:';

/** How a role reads on screen: the signal's label, in plain words. */
export function roleLabel(db: Db, role: Role): string {
  if (role === GROUND_ROLE) return 'ground';
  if (role.startsWith(KIND_ROLE)) return `${role.slice(KIND_ROLE.length)} (any)`;
  const entry = vocabEntry<SignalEntry>(db.vocab, 'signals', role);
  return entry?.label ?? role;
}

type Reading = { role: Role; ground?: GroundClass };

/** A vocab signal id as a reading: grounds by their class, `nc` and the like as nothing. */
function readingOfSignal(db: Db, id: string): Reading | undefined {
  const entry = vocabEntry<SignalEntry>(db.vocab, 'signals', id);
  if (isGroundSignal(db.vocab, id)) {
    if (id === CHASSIS_SIGNAL) return { role: GROUND_ROLE, ground: 'chassis' };
    if (id === GROUND_SIGNAL) return { role: GROUND_ROLE };
    if ((entry?.returnFor ?? []).length > 0) return { role: GROUND_ROLE, ground: id };
    return { role: GROUND_ROLE, ground: 'other' };
  }
  if (entry === undefined || entry.kind === 'none') return undefined;
  return { role: id };
}

/** The ground class a shield takes from the core it wraps: that signal's return. */
function groundClassOf(db: Db, role: Role | undefined): GroundClass | undefined {
  if (role === undefined || role === GROUND_ROLE || role.startsWith(KIND_ROLE)) return undefined;
  return returnOf(db.vocab, role);
}

/** The role a lane gives a conductor: its signal, else its kind (`power`), else ground. */
function roleOfLane(db: Db, lane: string): Role | undefined {
  const signal = signalOfLane(db.vocab, lane);
  if (signal !== undefined) return readingOfSignal(db, signal)?.role;
  if (lane === 'ground') return GROUND_ROLE;
  if (lane === 'power') return `${KIND_ROLE}power`;
  return undefined;
}

/**
 * The roles a terminal's words name, label first: every signal of the label
 * and its aliases, read against the catalog's vocabulary. A terminal whose
 * id or label is a shell/chassis word is the chassis tab however its other
 * words read.
 */
export function readingsOfLabels(db: Db, labels: (string | undefined)[]): Reading[] {
  const readings = readSignalLabels(db.vocab, labels)
    .map((id) => readingOfSignal(db, id))
    .filter((r): r is Reading => r !== undefined);
  if (readings[0]?.role === GROUND_ROLE && readings.some((r) => r.ground === 'chassis')) {
    return [{ role: GROUND_ROLE, ground: 'chassis' }, ...readings.slice(1).filter((r) => r.ground !== 'chassis')];
  }
  return readings;
}

/** The first role a terminal's words name — `undefined` when they name nothing the vocabulary carries. */
export function roleOfLabels(db: Db, labels: (string | undefined)[]): Reading | undefined {
  return readingsOfLabels(db, labels)[0];
}

/**
 * The roles a terminal's tags give: every signal of a `oneOf` (the device
 * decides, so a core of any of them may land there), else its pad role's
 * lane, else its lane. `[]` when the tags name nothing a cable lands (`nc`,
 * a spare core).
 */
export function readingsOfTags(db: Db, tags: TerminalTags): Reading[] {
  if (tags.signal !== undefined) {
    const readings = signalIds(tags.signal)
      .map((id) => readingOfSignal(db, id))
      .filter((r): r is Reading => r !== undefined);
    if (readings.length > 0) return readings;
  }
  if (tags.role !== undefined) {
    const lane = laneOfPadRole(db, tags.role);
    const role = lane === undefined ? (/^gnd\b|ground|shield/.test(tags.role) ? GROUND_ROLE : undefined) : roleOfLane(db, lane);
    return role === undefined ? [] : [{ role }];
  }
  if (tags.lane !== undefined) {
    const role = roleOfLane(db, tags.lane);
    return role === undefined ? [] : [{ role }];
  }
  return [];
}

/** The first role a terminal's tags give, or `undefined`. */
export function roleOfTags(db: Db, tags: TerminalTags): Reading | undefined {
  return readingsOfTags(db, tags)[0];
}

/** Does terminal `terminal` take a core of role `role`? A kind-level role takes any signal of that kind. */
function takes(db: Db, terminal: EndTerminal, role: Role): boolean {
  if (terminal.roles.includes(role)) return true;
  if (!role.startsWith(KIND_ROLE)) return false;
  const kind = role.slice(KIND_ROLE.length);
  return terminal.roles.some((r) => kindOfSignal(db, r) === kind);
}

/** What a role would *accept* when nothing carries it exactly — offered, never taken. */
function nearRoles(db: Db, role: Role): Role[] {
  if (role === GROUND_ROLE || role.startsWith(KIND_ROLE)) return [];
  const entry = vocabEntry<SignalEntry>(db.vocab, 'signals', role);
  if (entry === undefined) return [];
  if (entry.near !== undefined) return entry.near;
  return ((db.vocab?.['signals']?.entries ?? []) as SignalEntry[])
    .filter((e) => e.id !== entry.id && e.kind === entry.kind && e.kind !== 'ground' && e.kind !== 'none' && e.pending !== true && e.deprecatedBy === undefined)
    .map((e) => e.id);
}

/* ------------------------------------------------------------------ *
 * Reading the catalog: what each end and each wire offers
 * ------------------------------------------------------------------ */

/** One place on an end that something can be soldered to. */
export interface EndTerminal {
  /** the terminal id as a `TerminalRef` would name it */
  id: string;
  /** what the catalog calls it */
  label: string;
  /** its first role (the label's, or the first of a `oneOf`) */
  role?: Role;
  /** every role a core may land here as — a pin the device switches between signals takes any of them */
  roles: Role[];
  ground?: GroundClass;
  /**
   * True for the pads/pins the *trunk* lands on. A board's other terminals are
   * where a connector's pins land ("connector pin landing pad H1") — a
   * different job, handled by the plug picker.
   */
  cableSide: boolean;
  /** for a board's connector-pin pads: the group they belong to (`j`, `jp`, …) */
  plugPrefix?: string;
  /** the vocab signal id the pin carries, when its tags, words or interface name one */
  signal?: string;
  /** the pin's direction as its interface gives it, for pairing a transmit with a receive */
  dir?: PinDir;
}

/**
 * Whether a pad is where the *trunk* lands.
 *
 * A board record says so in the pad's own note: "conductor landing pad H9"
 * and "shield / ground pads H16, H17" are cable-side, "connector pin landing
 * pad H1" is where a plug's pin goes. Terminals whose id carries a prefix
 * (`j.5`, `j1.15`) are already excluded by their shape, so the note only has
 * to catch the one phrase.
 */
function isTrunkPad(note: string | undefined): boolean {
  return note === undefined || !normalise(note).startsWith('connector pin landing pad');
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function terminalOf(id: string, label: string, readings: Reading[], cableSide: boolean, extra: { plugPrefix?: string; signal?: string; dir?: PinDir } = {}): EndTerminal {
  const first = readings[0];
  return {
    id,
    label,
    cableSide,
    roles: readings.map((r) => r.role),
    ...(first === undefined ? {} : { role: first.role }),
    ...(first?.ground === undefined ? {} : { ground: first.ground }),
    ...extra,
  };
}

/**
 * A connector's pins as the wizard reads them: a tagged pin from its tags
 * (`signalOf`); an untagged one from its label, id and aliases.
 */
export function connectorTerminals(connector: ConnectorDefinition, db: Db): EndTerminal[] {
  // a connector that names an interface (`ethernet-mdi`, `rs232-de9`) inherits its pins' signals and
  // directions; its own tags and words still come first
  const bound = new Map<string, BoundPin>(
    connector.interface === undefined
      ? []
      : bindPort(db, { id: 'plug', interface: connector.interface, ...(connector.body === undefined ? {} : { body: connector.body }) }).map((pin) => [pin.position, pin] as const),
  );
  return connector.pins.map((pin) => {
    const tags = signalOf(db, 'connector', connector.id, pin.id);
    const viaInterface = (): Reading[] => {
      const signal = bound.get(pin.id)?.signal;
      return signal === undefined ? [] : readingsOfTags(db, { signal });
    };
    const readings = tags !== undefined ? readingsOfTags(db, tags) : (() => {
      const words = readingsOfLabels(db, [pin.label, pin.id, ...(pin.aliases ?? [])]);
      return words.length > 0 ? words : viaInterface();
    })();
    const fromInterface = bound.get(pin.id);
    return terminalOf(pin.id, pin.label, readings, true, {
      ...(fromInterface?.signal === undefined || fromInterface.class === 'nc' ? {} : { signal: fromInterface.signal }),
      ...(fromInterface?.dir === undefined ? {} : { dir: fromInterface.dir }),
    });
  });
}

/** A board's terminals as the wizard reads them — tags first, as `connectorTerminals`. */
export function pcbaTerminals(pcba: PcbaDefinition, db: Db): EndTerminal[] {
  const integrated = new Set((pcba.integratedConnectors ?? []).map((entry) => entry.terminalPrefix));
  return pcba.terminals.map((terminal) => {
    const tags = signalOf(db, 'pcba', pcba.id, terminal.id);
    const readings = tags !== undefined ? readingsOfTags(db, tags) : readingsOfLabels(db, [terminal.label, terminal.id]);
    const dot = terminal.id.indexOf('.');
    const prefix = dot === -1 ? undefined : terminal.id.slice(0, dot);
    const cableSide = dot === -1 && isTrunkPad(terminal.note);
    return terminalOf(
      terminal.id,
      terminal.label ?? terminal.id,
      readings,
      cableSide,
      prefix === undefined || integrated.has(prefix) ? {} : { plugPrefix: prefix },
    );
  });
}

/**
 * A wire label with its colour words taken out: parenthesised colours
 * ("Pair 1 (blue)") go, and a label made only of colours ("white/blue")
 * is nothing. `undefined` when nothing but colour is left.
 */
export function withoutColourWords(db: Db, label: string): string | undefined {
  const colours = new Set<string>();
  for (const entry of (db.vocab?.['colours']?.entries ?? []) as { id: string; label?: string; aliases?: string[] }[]) {
    for (const text of [entry.id, entry.label, ...(entry.aliases ?? [])]) {
      if (typeof text === 'string') colours.add(text.trim().toLowerCase());
    }
  }
  const isColour = (text: string): boolean => {
    const parts = text.toLowerCase().split(/[\s/,&+-]+/).filter((part) => part !== '');
    return parts.length > 0 && parts.every((part) => colours.has(part) || part === 'stripe' || part === 'striped');
  };
  const rest = label.replace(/\(([^)]*)\)/g, (whole, inner: string) => (isColour(inner) ? ' ' : whole)).replace(/\s+/g, ' ').trim();
  return rest === '' || isColour(rest) ? undefined : rest;
}

/** One electrical element of a wire stock, with the signal it carries. */
export interface WireLine {
  /** the element path a `TerminalRef` uses — `pair-1.a`, `drain` */
  path: string;
  label: string;
  kind: 'conductor' | 'shield';
  role: Role;
  /** for a shield: the class of ground it prefers, from the core it wraps */
  ground?: GroundClass;
  /** true for the bare drain, which is landed at the source end only */
  drain: boolean;
  /**
   * Set by `connect: 'signal'` for a conductor whose stock says nothing about what it
   * carries: the exact terminal it lands on at each end, from pairing the two ends' pins.
   */
  lands?: Partial<Record<EndSide, string>>;
}

/**
 * Every electrical element of a stock, in lay order of the structure, with the
 * role it carries. Conductors take their role from their tags (the lane the
 * stock's colour code gives them) and, untagged, from their own label;
 * shields take the *ground class* of the core they wrap, so a shield knows
 * which return it belongs on.
 */
export function wireLines(wire: WireDefinition, db: Db): WireLine[] {
  const lines: WireLine[] = [];
  /** a conductor's role from its tags, or `undefined` when it is untagged or carries nothing */
  const tagged = (path: string): Role | undefined => {
    const tags = signalOf(db, 'segment', wire.id, path);
    return tags === undefined || tags.screen === true ? undefined : roleOfTags(db, tags)?.role;
  };
  const isTagged = (path: string): boolean => signalOf(db, 'segment', wire.id, path) !== undefined;
  // a conductor's label may name its colour ("Pair 1 (blue)", "white/blue"); a
  // colour is not a signal, however a vocabulary's aliases happen to spell it
  const ofLabel = (label: string | undefined): Role | undefined => {
    const words = label === undefined ? undefined : withoutColourWords(db, label);
    return words === undefined ? undefined : roleOfLabels(db, [words])?.role;
  };

  const walk = (element: Element, path: string, coreRole: Role | undefined): void => {
    if (element.kind === 'group') {
      // only a *core* group lends its role to what it wraps: the root `cable`
      // group holds the whole stock, and its overall shield and drain belong to
      // no one core
      const isCore = element.role !== 'cable' && element.role !== 'bundle';
      const inner = element.children.find(
        (child): child is Extract<Element, { kind: 'conductor' }> => child.kind === 'conductor',
      );
      const innerPath = inner === undefined ? undefined : path === '' ? inner.id : `${path}.${inner.id}`;
      const role = !isCore
        ? undefined
        : inner === undefined
          ? coreRole
          : innerPath !== undefined && isTagged(innerPath)
            ? tagged(innerPath)
            : (ofLabel(inner.label) ?? ofLabel(element.label));
      for (const child of element.children) {
        walk(child, path === '' ? child.id : `${path}.${child.id}`, role);
      }
      return;
    }
    if (element.kind === 'insulation') return;
    if (element.kind === 'conductor') {
      const role =
        element.bare === true
          ? GROUND_ROLE
          : isTagged(path)
            ? tagged(path)
            : (ofLabel(element.label) ?? coreRole);
      if (role === undefined) return;
      lines.push({
        path,
        label: element.label ?? path,
        kind: 'conductor',
        role,
        // the bare drain is the one conductor landed at the source end only
        drain: element.bare === true,
      });
      return;
    }
    // a shield is a ground, classed by the core it wraps
    const cls = groundClassOf(db, coreRole);
    lines.push({
      path,
      label: element.label ?? path,
      kind: 'shield',
      role: GROUND_ROLE,
      drain: false,
      ...(cls === undefined ? {} : { ground: cls }),
    });
  };

  walk(wire.structure, '', undefined);
  // the order every hand-authored design uses: the cores first, then the
  // braids, then the drain. It is how a builder works through the cut face.
  const rank = (line: WireLine): number => (line.drain ? 2 : line.kind === 'shield' ? 1 : 0);
  return lines
    .map((line, at) => ({ line, at }))
    .sort((x, y) => rank(x.line) - rank(y.line) || x.at - y.at)
    .map((entry) => entry.line);
}

/* ------------------------------------------------------------------ *
 * Lengths — mm is the model; the UI offers metric and imperial presets
 * ------------------------------------------------------------------ */

const MM_PER_INCH = 25.4;

/** `1830` → `6 ft 0 in`. What the mm field shows underneath itself. */
export function describeLength(mm: number): string {
  if (!Number.isFinite(mm) || mm <= 0) return '';
  // round to a tenth of an inch *first*, then split: 914 mm is 35.98 in, and
  // splitting before rounding would print it as "2 ft 12 in"
  const tenths = Math.round((mm / MM_PER_INCH) * 10);
  const feet = Math.floor(tenths / 120);
  const inches = (tenths - feet * 120) / 10;
  if (feet === 0) return `${inches} in`;
  return `${feet} ft ${inches} in`;
}

/** Generic metric lengths; no shop-specific defaults. */
export const LENGTH_PRESETS: readonly { mm: number; label: string }[] = [
  { mm: 500, label: '0.5 m' },
  { mm: 1000, label: '1 m' },
  { mm: 2000, label: '2 m' },
];

export const IMPERIAL_LENGTH_PRESETS: readonly { mm: number; label: string }[] = [
  { mm: 914, label: '3 ft' },
  { mm: 1830, label: '6 ft' },
  { mm: 3048, label: '10 ft' },
];

/** A whole number of millimetres, or `undefined` when the field is not a length. */
export function parseLengthMm(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

/**
 * The longest run this stock is documented for, when the record says.
 *
 * No stock in the catalog carries one today, so this reads a `maxLengthMm`
 * field if a wire definition ever grows one rather than inventing a limit —
 * a made-up ceiling would be a fact the data does not have.
 */
export function maxLengthOf(wire: WireDefinition): number | undefined {
  const value = (wire as unknown as { maxLengthMm?: unknown }).maxLengthMm;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

export type WizardStep = 'name' | 'source' | 'wire' | 'destination' | 'choices' | 'review';

export const WIZARD_STEPS: readonly WizardStep[] = [
  'name',
  'source',
  'wire',
  'destination',
  'choices',
  'review',
];

export const STEP_TITLES: Readonly<Record<WizardStep, string>> = {
  name: 'What is this design called?',
  source: 'What does it plug into at the source end?',
  wire: 'Which wire, and how long?',
  destination: 'What does it plug into at the destination end?',
  choices: 'A few things only you can decide',
  review: 'Check it over',
};

export const STEP_SAY: Readonly<Record<WizardStep, string>> = {
  name: 'A name a builder would read at the top of the build sheet, and a reference for where the information comes from.',
  source: 'Pick the plug that goes into the source device, or the source-side board the design is soldered to.',
  wire: 'The stock the trunk is cut from, and how long to cut it.',
  destination: 'The plug or board at the destination end.',
  choices:
    'Where the catalog offers more than one landing for the same signal, it is not the wizard’s call to make.',
  review: 'Everything the wizard is about to solder, and everything it deliberately left alone.',
};

/** Which end of the cable a question is about. */
export type EndSide = 'source' | 'destination';

/** What sits at one end: a plug, or a board (optionally with plugs on it). */
export interface EndChoice {
  kind: 'connector' | 'pcba';
  def: string;
  /** for a board: which connector solders onto each group of pin pads */
  plugs: Record<string, string>;
}

/**
 * How the wizard joins the trunk's conductors to the ends:
 *
 * - `signal` — by what the pins carry: the two ends' pins are paired with the resolver's rule
 *   (the same signal, or signals the vocabulary pairs, a transmit onto a receive) and each pair
 *   takes a conductor, differential pairs on twisted pairs. A conductor the stock's colour code
 *   already names keeps that role.
 * - `colour` — only by the stock's colour code and the conductors' own labels; a conductor
 *   nothing names is left alone.
 * - `open` — place the ends and the trunk, join nothing.
 */
export type ConnectMode = 'signal' | 'colour' | 'open';

export const CONNECT_MODES: readonly { mode: ConnectMode; label: string; say: string }[] = [
  { mode: 'signal', label: 'By signal', say: 'Pair the ends by what their pins carry, then give each pair a conductor.' },
  { mode: 'colour', label: 'By colour', say: 'Only what the stock’s colour code and labels name.' },
  { mode: 'open', label: 'Leave open', say: 'Place the parts and the wire; connect them on the canvas.' },
];

export interface WizardState {
  db: Db;
  /** ids already in use, so a suggestion never collides */
  taken: string[];
  step: WizardStep;
  /** the furthest step the answers have earned, for Back/forward navigation */
  reached: WizardStep;
  label: string;
  id: string;
  /** the id stops following the name the moment it is typed into */
  ownId: boolean;
  src: string;
  source: EndChoice | undefined;
  destination: EndChoice | undefined;
  wireDef: string | undefined;
  lengthText: string;
  /** how the trunk's conductors are joined to the ends (`ConnectMode`) */
  connect: ConnectMode;
  /** answers to `openChoices`, by choice id; `''` means "leave it unconnected" */
  picks: Record<string, string>;
  /** why the last Next was refused — plain sentences, cleared by the next edit */
  blocked: string[];
}

export function initialWizardState(db: Db, taken: string[] = []): WizardState {
  return {
    db,
    taken,
    step: 'name',
    reached: 'name',
    label: '',
    id: '',
    ownId: false,
    src: OWN_DESIGN,
    source: undefined,
    destination: undefined,
    wireDef: undefined,
    lengthText: '1000',
    connect: 'signal',
    picks: {},
    blocked: [],
  };
}

export type WizardAction =
  | { type: 'set-label'; value: string }
  | { type: 'set-id'; value: string }
  | { type: 'set-src'; value: string }
  | { type: 'set-end'; end: EndSide; kind: 'connector' | 'pcba'; def: string }
  | { type: 'clear-end'; end: EndSide }
  | { type: 'set-plug'; end: EndSide; prefix: string; def: string }
  | { type: 'set-wire'; def: string }
  | { type: 'set-length'; value: string }
  | { type: 'set-connect'; mode: ConnectMode }
  | { type: 'pick'; id: string; value: string }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'go'; step: WizardStep };

function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/**
 * Why this step cannot be left yet, in sentences.
 *
 * Empty means "go on". This is the gate: `next` consults it, and so does the
 * Next button, so a step that would produce an unbuildable design is not
 * reachable by clicking fast.
 */
export function stepBlockers(state: WizardState): string[] {
  switch (state.step) {
    case 'name': {
      const out: string[] = [];
      if (state.label.trim() === '') out.push('Give the design a name.');
      // held in a boolean so the guard does not narrow `id` away in the else
      const id = state.id;
      const idOk: boolean = isDesignId(id);
      if (!idOk) {
        out.push(
          id.trim() === ''
            ? 'The design needs an id — lowercase words joined by hyphens.'
            : `'${id}' cannot be used as an id. Use lowercase words joined by hyphens.`,
        );
      } else if (state.taken.includes(id)) {
        out.push(`A design called '${id}' already exists. Choose another id.`);
      }
      if (state.src.trim() === '') {
        out.push('Give a reference — say where this information comes from ("own design" is fine).');
      }
      return out;
    }
    case 'source':
      return state.source === undefined ? ['Pick the source-side plug or board.'] : [];
    case 'wire': {
      const out: string[] = [];
      const wire = state.wireDef === undefined ? undefined : findWire(state.db, state.wireDef);
      if (wire === undefined) {
        out.push('Pick the wire stock the trunk is cut from.');
        return out;
      }
      const mm = parseLengthMm(state.lengthText);
      if (mm === undefined) {
        out.push('Enter the cut length in millimetres — a whole number greater than zero.');
        return out;
      }
      const max = maxLengthOf(wire);
      if (max !== undefined && mm > max) {
        out.push(
          `${wire.label} is documented up to ${max} mm (${describeLength(max)}); ${mm} mm is longer than that.`,
        );
      }
      return out;
    }
    case 'destination':
      return state.destination === undefined ? ['Pick the plug or board at the destination end.'] : [];
    case 'choices':
      return [];
    case 'review': {
      const plan = planCable(state);
      return plan.errors.map((issue) => issue.message);
    }
  }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'set-label': {
      const label = action.value;
      return {
        ...state,
        label,
        id: state.ownId ? state.id : suggestDesignId(label, state.taken),
        blocked: [],
      };
    }
    case 'set-id':
      return { ...state, id: action.value, ownId: true, blocked: [] };
    case 'set-src':
      return { ...state, src: action.value, blocked: [] };
    case 'set-end':
      return {
        ...state,
        [action.end]: { kind: action.kind, def: action.def, plugs: {} },
        // the ends decide what the questions are; old answers no longer apply
        picks: {},
        blocked: [],
      };
    case 'clear-end':
      return { ...state, [action.end]: undefined, picks: {}, blocked: [] };
    case 'set-plug': {
      const end = state[action.end];
      if (end === undefined) return state;
      const plugs = { ...end.plugs };
      if (action.def === '') delete plugs[action.prefix];
      else plugs[action.prefix] = action.def;
      return { ...state, [action.end]: { ...end, plugs }, picks: {}, blocked: [] };
    }
    case 'set-wire':
      return { ...state, wireDef: action.def, picks: {}, blocked: [] };
    case 'set-length':
      return { ...state, lengthText: action.value, blocked: [] };
    case 'set-connect':
      return { ...state, connect: action.mode, picks: {}, blocked: [] };
    case 'pick':
      return { ...state, picks: { ...state.picks, [action.id]: action.value }, blocked: [] };
    case 'next': {
      const blockers = stepBlockers(state);
      if (blockers.length > 0) return { ...state, blocked: blockers };
      const next = WIZARD_STEPS[stepIndex(state.step) + 1];
      if (next === undefined) return { ...state, blocked: [] };
      return {
        ...state,
        step: next,
        reached: stepIndex(next) > stepIndex(state.reached) ? next : state.reached,
        blocked: [],
      };
    }
    case 'back': {
      const previous = WIZARD_STEPS[stepIndex(state.step) - 1];
      return previous === undefined ? state : { ...state, step: previous, blocked: [] };
    }
    case 'go': {
      // only backwards, or forwards into ground the answers have already earned
      if (stepIndex(action.step) > stepIndex(state.reached)) return state;
      return { ...state, step: action.step, blocked: [] };
    }
  }
}

/* ------------------------------------------------------------------ *
 * The generator
 * ------------------------------------------------------------------ */

/** The instance a resolved end became, with the terminals it offers. */
interface ResolvedEnd {
  side: EndSide;
  /** `a` for the source end of the trunk, `b` for the destination */
  wireEnd: 'a' | 'b';
  instance: string;
  kind: 'connector' | 'pcba';
  def: string;
  label: string;
  terminals: EndTerminal[];
  /** plugs soldered onto this board's pin pads: prefix → instance id */
  plugs: { prefix: string; instance: string; def: string; connector: ConnectorDefinition }[];
}

/** A question the wizard refuses to answer for the user. */
export interface OpenChoice {
  id: string;
  end: EndSide;
  /** the sentence the step asks */
  question: string;
  /** one line of context under it */
  say: string;
  options: { value: string; label: string }[];
  /** true when there is nothing to land on at all and the options are near misses */
  weak: boolean;
}

/** Something the wizard left alone, and why. */
export interface Unconnected {
  what: string;
  why: string;
}

export interface CablePlan {
  design: CableDesign;
  /** one plain sentence per generated joint, in the order they were made */
  lines: string[];
  unconnected: Unconnected[];
  choices: OpenChoice[];
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
}

function endLabel(db: Db, choice: EndChoice): string {
  const record =
    choice.kind === 'connector' ? findConnector(db, choice.def) : findPcba(db, choice.def);
  return record?.label ?? choice.def;
}

/**
 * Turn the two end answers and the wire answer into instance ids.
 *
 * The shop's own naming: `j…` for plugs, `u…` for boards, `w1` for the trunk —
 * which is also what the hand-authored designs use, so a generated document
 * reads like the ones beside it.
 */
function resolveEnds(state: WizardState): ResolvedEnd[] {
  const out: ResolvedEnd[] = [];
  let connectors = 0;
  let boards = 0;
  const nextId = (kind: 'connector' | 'pcba'): string =>
    kind === 'connector' ? `j${(connectors += 1)}` : `u${(boards += 1)}`;

  for (const side of ['source', 'destination'] as EndSide[]) {
    const choice = state[side];
    if (choice === undefined) continue;
    const instance = nextId(choice.kind);
    const terminals =
      choice.kind === 'connector'
        ? (() => {
            const connector = findConnector(state.db, choice.def);
            return connector === undefined ? [] : connectorTerminals(connector, state.db);
          })()
        : (() => {
            const pcba = findPcba(state.db, choice.def);
            return pcba === undefined ? [] : pcbaTerminals(pcba, state.db);
          })();

    const plugs: ResolvedEnd['plugs'] = [];
    for (const prefix of plugPrefixes(terminals)) {
      const def = choice.plugs[prefix];
      if (def === undefined) continue;
      const connector = findConnector(state.db, def);
      if (connector === undefined) continue;
      plugs.push({ prefix, instance: nextId('connector'), def, connector });
    }

    out.push({
      side,
      wireEnd: side === 'source' ? 'a' : 'b',
      instance,
      kind: choice.kind,
      def: choice.def,
      label: endLabel(state.db, choice),
      terminals,
      plugs,
    });
  }
  return out;
}

/** The distinct pin-pad groups a board exposes that are not already a connector. */
export function plugPrefixes(terminals: EndTerminal[]): string[] {
  const seen: string[] = [];
  for (const terminal of terminals) {
    if (terminal.plugPrefix !== undefined && !seen.includes(terminal.plugPrefix)) {
      seen.push(terminal.plugPrefix);
    }
  }
  return seen;
}

function trunkCandidates(db: Db, end: ResolvedEnd, role: Role): EndTerminal[] {
  return end.terminals.filter((terminal) => terminal.cableSide && terminal.role !== GROUND_ROLE && takes(db, terminal, role));
}

/**
 * Where a ground of class `cls` lands: the returns of that class, else the
 * end's general grounds, else — when the end has exactly one ground of any
 * sort (an XLR's pin 1, a plug's only shell) — that one.
 */
function groundCandidates(end: ResolvedEnd, cls: GroundClass | undefined): EndTerminal[] {
  const grounds = end.terminals.filter((t) => t.cableSide && t.role === GROUND_ROLE);
  if (cls !== undefined) {
    const exact = grounds.filter((t) => t.ground === cls);
    if (exact.length > 0) return exact;
  }
  const general = grounds.filter((t) => t.ground === undefined);
  if (general.length > 0) return general;
  if (grounds.length === 1) return grounds;
  // a signal return and a shell: the return is where a conductor lands, the shell is a bond
  const returns = grounds.filter((t) => t.ground !== 'chassis');
  return returns.length === 1 ? returns : [];
}

function choiceIdOf(end: EndSide, key: string): string {
  return `${end}:${key}`;
}

/**
 * The single landing a core falls back to by the vocabulary's own
 * convention (`standIn`): a source that delivers one mono audio pin feeding
 * both channels, say. When that landing is the *only* one of its signal on
 * the end, sending the core to it is the documented build, not an invention.
 */
function standInFor(db: Db, end: ResolvedEnd, role: Role): EndTerminal | undefined {
  const standIn = vocabEntry<SignalEntry>(db.vocab, 'signals', role)?.standIn;
  if (standIn === undefined) return undefined;
  const landings = trunkCandidates(db, end, standIn);
  return landings.length === 1 ? landings[0] : undefined;
}

/** Pins of one end as the resolver's pairing rule reads them. */
function boundPinsOf(db: Db, end: ResolvedEnd): BoundPin[] {
  const pins: BoundPin[] = [];
  for (const t of end.terminals) {
    if (!t.cableSide || t.role === undefined) continue;
    const ground = t.role === GROUND_ROLE;
    const signal = ground ? (t.ground === 'chassis' ? CHASSIS_SIGNAL : GROUND_SIGNAL) : (t.signal ?? t.role);
    if (!ground && t.role.startsWith(KIND_ROLE)) continue;
    pins.push({
      position: t.id,
      label: t.label,
      signal,
      class: ground ? (t.ground === 'chassis' ? 'chassis' : 'ground') : kindOfSignal(db, signal) === 'power' ? 'power' : 'signal',
      ...(t.dir === undefined ? {} : { dir: t.dir }),
      confidence: 'documented',
    });
  }
  return pins;
}

interface TrunkPlan {
  lines: WireLine[];
  /** design notes the plan needs: spare cores, lines the stock could not carry */
  notes: string[];
  /** conductors and lines left alone, with the reason */
  left: Unconnected[];
}

const SEGMENT_ID = 'w1';

/**
 * The conductors the trunk is joined by, for the connect mode. `colour` keeps the lines the
 * stock names. `signal` adds the rest: pair the two ends' pins by what they carry (the resolver's
 * rule, `pairPins`), then give each pair a free conductor, differential pairs on twisted pairs,
 * control-only lines dropped when the stock is short, the leftover cores noted as spares.
 */
function trunkPlan(state: WizardState, ends: ResolvedEnd[], wire: WireDefinition): TrunkPlan {
  const named = wireLines(wire, state.db);
  if (state.connect === 'open') return { lines: [], notes: [], left: [] };
  const shape = stockShape(wire);
  const namedPaths = new Set(named.map((line) => line.path));
  const labelOf = (path: string): string => {
    return resolveElementPath(wire.structure, path)?.label ?? path;
  };
  const free = shape.conductors.filter((path) => !namedPaths.has(path));

  if (state.connect === 'colour' || ends.length < 2 || free.length === 0) {
    return {
      lines: named,
      notes: [],
      left: state.connect === 'colour' ? free.map((path) => ({ what: labelOf(path), why: 'neither the stock’s colour code nor its label says what it carries.' })) : [],
    };
  }

  const [source, destination] = ends as [ResolvedEnd, ResolvedEnd];
  const paired = pairPins(state.db, boundPinsOf(state.db, source), boundPinsOf(state.db, destination));
  const taken = new Set(named.filter((line) => line.role !== GROUND_ROLE).map((line) => line.role));
  let links = paired.links.filter((link) => (link.signal === undefined || !taken.has(link.signal)) && (link.toSignal === undefined || !taken.has(link.toSignal)));
  const needGround = paired.grounds.source.length > 0 && paired.grounds.destination.length > 0 && links.length > 0
    && !named.some((line) => line.role === GROUND_ROLE && line.kind === 'conductor' && !line.drain);

  const notes: string[] = [];
  const left: Unconnected[] = [];
  const isControl = (id: string | undefined): boolean => id !== undefined && kindOfSignal(state.db, id) === 'control';
  const room = (): number => free.length - (needGround ? 1 : 0);
  if (links.length > room()) {
    const dropped = links.filter((l) => isControl(l.signal) && isControl(l.toSignal));
    if (dropped.length > 0) {
      links = links.filter((l) => !dropped.includes(l));
      notes.push(`Not carried (the stock has too few conductors for every line): the control lines ${dropped.map((l) => `${l.signal} → ${l.toSignal}`).join(', ')}.`);
    }
  }

  const pool = [...free];
  const takeFrom = (path: string): string => {
    pool.splice(pool.indexOf(path), 1);
    return path;
  };
  const conductorOf = new Map<number, string>();
  const pairsFree = shape.pairs.filter(([a, b]) => pool.includes(a) && pool.includes(b));
  for (const [i, j] of diffPairs(state.db, links)) {
    const pair = pairsFree.shift();
    if (pair === undefined) break;
    conductorOf.set(i, takeFrom(pair[0]));
    conductorOf.set(j, takeFrom(pair[1]));
  }
  const inFreePair = new Set(pairsFree.flat());
  links.forEach((_, i) => {
    if (conductorOf.has(i)) return;
    const path = pool.find((p) => !inFreePair.has(p)) ?? pool[0];
    if (path !== undefined) conductorOf.set(i, takeFrom(path));
  });
  const groundPath = needGround ? pool[0] : undefined;
  if (groundPath !== undefined) takeFrom(groundPath);

  const assigned: WireLine[] = [];
  links.forEach((link: PinLink, i) => {
    const path = conductorOf.get(i);
    if (path === undefined) {
      left.push({ what: `${roleLabel(state.db, link.signal ?? '')} → ${roleLabel(state.db, link.toSignal ?? link.signal ?? '')}`, why: `the stock has no conductor left for it (${shape.conductors.length} in all).` });
      return;
    }
    assigned.push({
      path,
      label: labelOf(path),
      kind: 'conductor',
      role: link.signal ?? link.toSignal ?? '',
      drain: false,
      lands: { source: link.from, destination: link.to },
    });
  });
  if (groundPath !== undefined) {
    assigned.push({ path: groundPath, label: labelOf(groundPath), kind: 'conductor', role: GROUND_ROLE, drain: false });
  }

  // nothing paired at all is not a spare: the cores stay floating and the checks say so
  const anyJoined = assigned.length > 0 || named.length > 0;
  for (const path of pool) {
    if (anyJoined) notes.push(`${SEGMENT_ID}:${path}@a is a spare: not connected at either end.`);
    left.push({ what: labelOf(path), why: anyJoined ? 'a spare: no line of this cable needs it.' : 'nothing the two ends carry matches, so no pin could be paired with it.' });
  }

  // lay order: the cores as the stock has them, then the braids, then the drain
  const order = (line: WireLine): number => {
    if (line.drain) return shape.conductors.length + 2;
    if (line.kind === 'shield') return shape.conductors.length + 1;
    const at = shape.conductors.indexOf(line.path);
    return at === -1 ? shape.conductors.length : at;
  };
  const lines = [...named, ...assigned].map((line, at) => ({ line, at })).sort((x, y) => order(x.line) - order(y.line) || x.at - y.at).map((entry) => entry.line);
  return { lines, notes, left };
}

/**
 * Everything the wizard will not decide by itself, in the order the choices
 * step asks them.
 *
 * A question exists when a signal has more than one landing on that end, or
 * when it has none but the end offers something adjacent (a board with only a
 * +12 V rail for the +5 V core; a head whose only sync-ish pin is composite).
 * Anything with exactly one landing is not a question, and anything with
 * nothing near it is not a question either — it is a sentence on the review.
 */
export function openChoices(state: WizardState): OpenChoice[] {
  const wire = state.wireDef === undefined ? undefined : findWire(state.db, state.wireDef);
  if (wire === undefined || state.connect === 'open') return [];
  const ends = resolveEnds(state);
  const lines = trunkPlan(state, ends, wire).lines;
  const out: OpenChoice[] = [];

  for (const end of ends) {
    const where = end.side === 'source' ? 'source end' : 'destination end';

    // one question for the ground bond, however many braids share the answer
    const grounds = end.terminals.filter((t) => t.cableSide && t.role === 'ground');
    const general = groundCandidates(end, undefined);
    const needing = lines.filter(
      (line) =>
        line.role === 'ground' &&
        !(line.drain && end.wireEnd === 'b') &&
        groundCandidates(end, line.ground).length !== 1,
    );
    if (needing.length > 0 && grounds.length > 0) {
      const names = needing.map((line) => line.label).join(', ');
      out.push({
        id: choiceIdOf(end.side, 'ground'),
        end: end.side,
        question: `Where does the braid bond at the ${where}?`,
        say:
          general.length === 0
            ? `${end.label} has no plain ground landing, so ${names} could go to any of its returns.`
            : `${end.label} offers ${general.length} ground landings for ${names}. Pick the one they are twisted onto.`,
        options: (general.length === 0 ? grounds : general).map((terminal) => ({
          value: terminal.id,
          label: `${terminal.id} — ${terminal.label}`,
        })),
        weak: general.length === 0,
      });
    }

    // one question per signal core that is ambiguous or unlanded-but-adjacent
    for (const line of lines) {
      if (line.role === 'ground') continue;
      // a conductor paired pin to pin by signal has nothing to ask
      if (line.lands?.[end.side] !== undefined) continue;
      const exact = trunkCandidates(state.db, end, line.role);
      if (exact.length === 1) continue;
      // a lone stand-in landing (a mono pin feeding both audio cores) is the
      // vocabulary's own convention, not a guess — see `planCable`. Nothing to ask.
      if (exact.length === 0 && standInFor(state.db, end, line.role) !== undefined) continue;
      const near =
        exact.length === 0
          ? nearRoles(state.db, line.role).flatMap((role) => trunkCandidates(state.db, end, role))
          : [];
      const options = exact.length > 1 ? exact : near;
      if (options.length === 0) continue;
      out.push({
        id: choiceIdOf(end.side, line.path),
        end: end.side,
        question: `Where does the ${roleLabel(state.db, line.role)} core land at the ${where}?`,
        say:
          exact.length > 1
            ? `${end.label} has ${exact.length} landings for ${roleLabel(state.db, line.role)}. Only you know which one this build uses.`
            : `Nothing on ${end.label} is labelled ${roleLabel(state.db, line.role)}. These are the closest — leave it unconnected if none is right.`,
        options: options.map((terminal) => ({
          value: terminal.id,
          label: `${terminal.id} — ${terminal.label}`,
        })),
        weak: exact.length === 0,
      });
    }
  }
  return out;
}

/** The design note the validator matches, copied verbatim from the catalog. */
export function drainNote(segment: string): string {
  return `Drain policy: the drain is terminated at the source end only — ${segment} drain @b is deliberately cut at the destination and left unconnected.`;
}

/** The note a stand-in landing leaves on the design: which landing takes which cores. */
function standInNote(db: Db, end: ResolvedEnd, landing: EndTerminal, roles: Role[]): string {
  const cores = roles.map((role) => roleLabel(db, role)).join(' and ');
  return `The ${end.side === 'source' ? 'source' : 'destination'} end has one landing for ${cores}: ${end.instance} ${landing.id} (${landing.label}) takes them all.`;
}

/** The reference a hand-made design starts with, so a person without a datasheet is not blocked. */
export const OWN_DESIGN = 'own design';

const GENERATED_SRC =
  'Wiring generated by the new-cable wizard from the catalog’s conductor-colour and pad-role conventions (inferred — verify each joint against the board before building).';

/**
 * The whole cable, from the answers.
 *
 * Pure: the same state always produces the same document, joint order and all,
 * which is what makes the fixture comparison in the tests meaningful.
 */
export function planCable(state: WizardState): CablePlan {
  const lengthMm = parseLengthMm(state.lengthText);
  const wire = state.wireDef === undefined ? undefined : findWire(state.db, state.wireDef);
  const ends = resolveEnds(state);
  const joints: Joint[] = [];
  const lines: string[] = [];
  const unconnected: Unconnected[] = [];
  const notes: string[] = [];
  const choices = openChoices(state);
  const choiceIds = new Set(choices.map((choice) => choice.id));

  const design: CableDesign = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: state.id,
    label: state.label.trim(),
    instances: { connectors: [], segments: [], components: [], pcbas: [] },
    joints,
    src: `${state.src.trim()} — ${GENERATED_SRC}`,
  };

  for (const end of ends) {
    if (end.kind === 'connector') {
      design.instances.connectors.push({
        id: end.instance,
        def: end.def,
        role: end.side === 'source' ? 'source plug' : 'destination plug',
      });
    } else {
      design.instances.pcbas.push({ id: end.instance, def: end.def });
    }
    for (const plug of end.plugs) {
      design.instances.connectors.push({
        id: plug.instance,
        def: plug.def,
        role: `plug soldered onto the ${plug.prefix} pads of ${end.instance}`,
      });
    }
  }

  const segmentId = SEGMENT_ID;
  if (wire !== undefined) {
    design.instances.segments.push({
      id: segmentId,
      def: wire.id,
      ...(lengthMm === undefined ? {} : { lengthMm }),
      role: lengthMm === undefined ? 'trunk' : `trunk (${describeLength(lengthMm)})`,
    });
  }

  const solder = (a: TerminalRef, b: TerminalRef, note: string | undefined, say: string): void => {
    joints.push(note === undefined ? { a, b } : { a, b, note });
    lines.push(say);
  };

  // --- the plugs that sit on a board's pin pads ---------------------------
  for (const end of ends) {
    for (const plug of end.plugs) {
      const pads = end.terminals.filter((terminal) => terminal.plugPrefix === plug.prefix);
      const pins = connectorTerminals(plug.connector, state.db);
      for (const pad of pads) {
        const suffix = pad.id.slice(plug.prefix.length + 1);
        const byNumber = pins.find((pin) => pin.id === suffix);
        if (byNumber !== undefined) {
          solder(
            { instance: plug.instance, terminal: byNumber.id },
            { instance: end.instance, terminal: pad.id },
            undefined,
            `${plug.connector.label} pin ${byNumber.id} (${byNumber.label}) onto ${end.instance} pad ${pad.id}`,
          );
          continue;
        }
        const byRole =
          pad.role === undefined
            ? []
            : pad.role === GROUND_ROLE
              ? pins.filter((pin) => pin.role === GROUND_ROLE && pin.ground === pad.ground)
              : pins.filter((pin) => pin.role === pad.role);
        if (byRole.length === 1 && byRole[0] !== undefined) {
          const pin = byRole[0];
          solder(
            { instance: plug.instance, terminal: pin.id },
            { instance: end.instance, terminal: pad.id },
            undefined,
            `${plug.connector.label} pin ${pin.id} (${pin.label}) onto ${end.instance} pad ${pad.id}`,
          );
          continue;
        }
        unconnected.push({
          what: `${end.instance} pad ${pad.id} (${pad.label})`,
          why:
            byRole.length === 0
              ? `no pin on the ${plug.connector.label} matches it, so the wizard left it for you.`
              : `${byRole.length} pins on the ${plug.connector.label} could be it — solder it on the canvas.`,
        });
      }
    }
  }

  // --- the trunk ----------------------------------------------------------
  if (wire !== undefined && state.connect !== 'open') {
    const trunk = trunkPlan(state, ends, wire);
    const allLines = trunk.lines;
    notes.push(...trunk.notes);
    unconnected.push(...trunk.left);
    for (const end of ends) {
      const where = end.side === 'source' ? 'source end' : 'destination end';
      /** stand-in landings used on this end: landing id → the roles it took */
      const stoodIn = new Map<string, { landing: EndTerminal; roles: Role[] }>();
      for (const line of allLines) {
        // the drain is landed at the source end only — the documented practice
        if (line.drain && end.wireEnd === 'b') continue;

        const ref: TerminalRef = { instance: segmentId, terminal: line.path, end: end.wireEnd };
        const pick = state.picks[choiceIdOf(end.side, line.role === GROUND_ROLE ? 'ground' : line.path)];

        let target: EndTerminal | undefined;
        let why: string | undefined;

        const landsOn = line.lands?.[end.side];
        if (landsOn !== undefined) {
          target = end.terminals.find((terminal) => terminal.id === landsOn);
        } else if (line.role === GROUND_ROLE) {
          const classed = groundCandidates(end, line.ground);
          if (classed.length === 1) target = classed[0];
          else if (pick !== undefined && pick !== '') {
            target = end.terminals.find((terminal) => terminal.id === pick);
          } else if (choiceIds.has(choiceIdOf(end.side, 'ground'))) {
            why = `you have not said where the braids bond at the ${where}.`;
          } else {
            why = `${end.label} has no ground landing for it.`;
          }
        } else {
          const exact = trunkCandidates(state.db, end, line.role);
          const label = roleLabel(state.db, line.role);
          if (exact.length === 1) target = exact[0];
          else if (pick !== undefined && pick !== '') {
            target = end.terminals.find((terminal) => terminal.id === pick);
          } else if (exact.length === 0) {
            // a lone stand-in landing legitimately takes the core (a mono pin, both audio cores)
            const standIn = standInFor(state.db, end, line.role);
            if (standIn !== undefined) {
              target = standIn;
              const used = stoodIn.get(standIn.id) ?? { landing: standIn, roles: [] };
              if (!used.roles.includes(line.role)) used.roles.push(line.role);
              stoodIn.set(standIn.id, used);
            } else {
              why = choiceIds.has(choiceIdOf(end.side, line.path))
                ? `nothing on ${end.label} is labelled ${label}, and you did not pick a stand-in.`
                : `nothing on ${end.label} carries ${label}.`;
            }
          } else {
            why = `${end.label} offers ${exact.length} landings for ${label} and you have not chosen one.`;
          }
        }

        if (target === undefined) {
          unconnected.push({
            what: `${line.label === line.path ? wireElementName(wire, line.path) : line.label} at the ${where}`,
            why: why ?? `nothing on ${end.label} matches it.`,
          });
          continue;
        }

        const note =
          line.drain
            ? 'drain terminated at the source end only'
            : line.role === GROUND_ROLE && line.kind === 'shield' && end.side === 'source'
              ? 'braid trimmed and twisted together with the drain onto the ground landing'
              : undefined;
        solder(
          ref,
          { instance: end.instance, terminal: target.id },
          note,
          `${line.label} (${line.path}) at the ${where} → ${end.instance} ${target.id} (${target.label})`,
        );
      }
      for (const { landing, roles } of stoodIn.values()) {
        const note = standInNote(state.db, end, landing, roles);
        if (!notes.includes(note)) notes.push(note);
      }
    }

    // the drain is cut at the destination on purpose; the note is what stops
    // the validator calling it a mistake, and it has to name the terminal
    const hasDrain = allLines.some((line) => line.drain);
    const landed = joints.some(
      (joint) =>
        (joint.a.instance === segmentId && joint.a.end === 'a' && joint.a.terminal === 'drain') ||
        (joint.b.instance === segmentId && joint.b.end === 'a' && joint.b.terminal === 'drain'),
    );
    if (hasDrain && landed) notes.unshift(drainNote(segmentId));
  }

  if (notes.length > 0) design.notes = notes;

  // grounds leave the wizard as pigtails, exactly as the catalog stores them
  // (shield bonding): one twist per landing, split by
  // board face where the board declares its pads
  const migrated = migrateShieldBonds(design, state.db);
  const bonded = migrated.report.ok ? migrated.design : design;
  const issues = validateDesign(bonded, state.db);
  return {
    design: bonded,
    lines,
    unconnected,
    choices,
    issues,
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}
