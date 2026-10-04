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
 * They are read out of the data, not hardcoded per console. First from the
 * vocab **tags** (`signalOf`, data model v2 task 3): a pin's signal, a pad's
 * role and signal, the lane the stock's colour code gives each core
 * (`roleOfTags`). Only a terminal nobody has tagged is read from its words, as
 * it always was:
 *
 * - **Wire cores** carry their role in their own `label` ("Video Sync centre
 *   conductor", "Audio L…", "+5 V DC…") and, as a fallback, in `color` — the
 *   fleet colour code red/green/blue = video, yellow = sync, white/black =
 *   audio L/R, brown = +5 V. The label wins because the audio whip's *right*
 *   core is red and its label is the one that is right about it.
 * - **Connector pins** carry theirs in `label`/`aliases` ("Red", "CSync",
 *   "Audio in L", "CVBS in" aliased "Sync in", "Red GND").
 * - **Board pads** carry theirs in `label` ("Video R", "Sync (delivered)",
 *   "Audio L", "+5 V", "GND"), and their `note` says whether a pad is where the
 *   *trunk* lands ("conductor landing pad H9") or where a *connector pin* does
 *   ("connector pin landing pad H1") — which is how the wizard knows to solder
 *   the cable to one set and a plug to the other.
 *
 * Shields and the drain go to ground. A shield whose core has a role prefers a
 * ground pin that names that role ("Red GND"), which is how a bare SCART head
 * gets its per-colour returns; otherwise every shield and the drain bond to the
 * end's single general ground.
 */

import {
  CURRENT_SCHEMA_VERSION,
  findConnector,
  findPcba,
  findWire,
  kindOfSignal,
  laneOfPadRole,
  migrateShieldBonds,
  signalIds,
  signalOf,
  validateDesign,
  type SignalRef,
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
 * Roles — the shared vocabulary of "what this wire/pin/pad is for"
 * ------------------------------------------------------------------ */

export type Role =
  | 'video-r'
  | 'video-g'
  | 'video-b'
  | 'sync'
  | 'cvbs'
  | 'luma'
  | 'chroma'
  | 'audio-l'
  | 'audio-r'
  | 'audio-mono'
  | 'power-5v'
  | 'power-12v'
  | 'ground';

/** How a role reads on screen. Plain words, no codes. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  'video-r': 'video red',
  'video-g': 'video green',
  'video-b': 'video blue',
  sync: 'sync',
  cvbs: 'composite video (CVBS)',
  luma: 'luma (Y)',
  chroma: 'chroma (C)',
  'audio-l': 'audio left',
  'audio-r': 'audio right',
  'audio-mono': 'audio (mono)',
  'power-5v': '+5 V',
  'power-12v': '+12 V',
  ground: 'ground',
};

/**
 * The coarse class a *ground* belongs to.
 *
 * SCART gives every colour its own return ("Red GND", "Audio GND", "CVBS
 * GND"), so a shield can land on the one that names its own core. The classes
 * are deliberately coarser than the roles: on a connector head the sync core's
 * braid lands on the CVBS/sync return, and audio L and R share one audio
 * ground — which is exactly what the hand-authored SCART builds do.
 */
export type GroundClass =
  | 'video-r'
  | 'video-g'
  | 'video-b'
  | 'video-sync'
  | 'audio'
  | 'power'
  /** the shell/chassis tab — a bond, not a signal return */
  | 'chassis'
  | 'other';

function groundClassOf(role: Role | undefined): GroundClass | undefined {
  switch (role) {
    case 'video-r':
    case 'video-g':
    case 'video-b':
      return role;
    case 'sync':
    case 'cvbs':
    case 'luma':
    case 'chroma':
      return 'video-sync';
    case 'audio-l':
    case 'audio-r':
    case 'audio-mono':
      return 'audio';
    case 'power-5v':
    case 'power-12v':
      return 'power';
    default:
      return undefined;
  }
}

/** What a role would *accept* when nothing carries it exactly — offered, never taken. */
const NEAR: Readonly<Partial<Record<Role, Role[]>>> = {
  sync: ['cvbs', 'luma', 'chroma'],
  cvbs: ['sync'],
  luma: ['sync'],
  chroma: ['sync'],
  'power-5v': ['power-12v'],
  'power-12v': ['power-5v'],
  'audio-l': ['audio-mono'],
  'audio-r': ['audio-mono'],
  'audio-mono': ['audio-l', 'audio-r'],
};

function normalise(text: string): string {
  return text.toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What one label says, as a role — `undefined` when it says nothing we carry. */
function roleOfOne(raw: string): { role: Role; ground?: GroundClass } | undefined {
  const text = normalise(raw);
  if (text === '') return undefined;

  // grounds first: "Red GND" is a ground, not a red signal
  if (/\b(gnd|ground|chassis|shell|shield)\b/.test(text)) {
    // the shell tab is a bond to the body, not a return for any one signal
    if (/\b(shell|chassis)\b/.test(text)) return { role: 'ground', ground: 'chassis' };
    // the qualifier is whatever is left once the ground words are taken out
    const qualifier = text
      .replace(/\b(gnd|ground|shield|connector)\b/g, ' ')
      .replace(/[^a-z0-9+ ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (qualifier === '') return { role: 'ground' };
    // "Audio GND" names a class, not a channel — L and R share one return
    if (/^(audio|aud)$/.test(qualifier)) return { role: 'ground', ground: 'audio' };
    const inner = roleOfOne(qualifier);
    return { role: 'ground', ground: groundClassOf(inner?.role) ?? 'other' };
  }

  if (/\bnot connected\b|^n\/?c$/.test(text)) return undefined;
  if (/\bhsync\b|\bvsync\b/.test(text)) return undefined;
  if (/\bcsync\b|\bsync\b/.test(text)) return { role: 'sync' };
  if (/\bcvbs\b|\bcomposite\b/.test(text)) return { role: 'cvbs' };
  if (/\bluma\b|\(y\)/.test(text)) return { role: 'luma' };
  if (/\bchroma\b|\(c\)/.test(text)) return { role: 'chroma' };

  if (/\bmono\b/.test(text) && /\baudio\b/.test(text)) return { role: 'audio-mono' };
  if (/\baudio\b.*\bl\b|\baudio\b.*\bleft\b|\bleft\b.*\baudio\b|^l a$|^la$/.test(text)) {
    return { role: 'audio-l' };
  }
  if (/\baudio\b.*\br\b|\baudio\b.*\bright\b|\bright\b.*\baudio\b|^r a$|^ra$/.test(text)) {
    return { role: 'audio-r' };
  }

  if (/\bred\b|\bvideo r\b|\bpr\b/.test(text)) return { role: 'video-r' };
  if (/\bgreen\b|\bvideo g\b/.test(text)) return { role: 'video-g' };
  if (/\bblue\b|\bvideo b\b|\bpb\b/.test(text)) return { role: 'video-b' };

  if (/[+]?\s*5\s*v\b|^v\+$|^v$/.test(text)) return { role: 'power-5v' };
  if (/[+]?\s*12\s*v\b/.test(text)) return (/-\s*12/.test(text) ? undefined : { role: 'power-12v' });
  return undefined;
}

/**
 * The role a terminal carries, read from its label and any aliases.
 *
 * Aliases matter: SCART pin 20 is printed "CVBS in" and aliased "Sync in", and
 * on a cable it is the sync line. Sync therefore beats composite when both are
 * on offer for the same pin.
 */
export function roleOfLabels(labels: (string | undefined)[]): { role: Role; ground?: GroundClass } | undefined {
  const found = labels
    .filter((label): label is string => typeof label === 'string' && label !== '')
    .map(roleOfOne)
    .filter((entry): entry is { role: Role; ground?: GroundClass } => entry !== undefined);
  if (found.length === 0) return undefined;
  const sync = found.find((entry) => entry.role === 'sync');
  if (sync !== undefined) return sync;
  const chosen = found[0];
  if (chosen === undefined) return undefined;
  // a terminal whose id is `shell` is the chassis tab however its label reads
  if (chosen.role === 'ground' && found.some((entry) => entry.ground === 'chassis')) {
    return { role: 'ground', ground: 'chassis' };
  }
  return chosen;
}

/* ------------------------------------------------------------------ *
 * Tags → roles (data model v2 task 3)
 * ------------------------------------------------------------------ */

type Reading = { role: Role; ground?: GroundClass };

const SIGNAL_ROLES: Readonly<Record<string, Reading>> = {
  'video-r': { role: 'video-r' },
  'video-g': { role: 'video-g' },
  'video-b': { role: 'video-b' },
  csync: { role: 'sync' },
  cvbs: { role: 'cvbs' },
  luma: { role: 'luma' },
  chroma: { role: 'chroma' },
  'audio-l': { role: 'audio-l' },
  'audio-l-in': { role: 'audio-l' },
  'audio-r': { role: 'audio-r' },
  'audio-r-in': { role: 'audio-r' },
  'audio-mono': { role: 'audio-mono' },
  'pwr-5v': { role: 'power-5v' },
  'pwr-12v': { role: 'power-12v' },
  gnd: { role: 'ground' },
  'gnd-chassis': { role: 'ground', ground: 'chassis' },
  'gnd-video-r': { role: 'ground', ground: 'video-r' },
  'gnd-video-g': { role: 'ground', ground: 'video-g' },
  'gnd-video-b': { role: 'ground', ground: 'video-b' },
  'gnd-sync': { role: 'ground', ground: 'video-sync' },
  'gnd-audio': { role: 'ground', ground: 'audio' },
  'gnd-power': { role: 'ground', ground: 'power' },
};

const LANE_ROLES: Readonly<Record<string, Role>> = {
  'video-r': 'video-r',
  'video-g': 'video-g',
  'video-b': 'video-b',
  sync: 'sync',
  'audio-l': 'audio-l',
  'audio-r': 'audio-r',
  // the fleet's brown is +5 V (ground-truth §2); a 12 V rail is the device's, not the core's
  power: 'power-5v',
};

const PAD_ROLES: Readonly<Record<string, Reading>> = {
  cvbs: { role: 'cvbs' },
  'audio-l-in': { role: 'audio-l' },
  'audio-r-in': { role: 'audio-r' },
  gnd: { role: 'ground' },
  'gnd-audio': { role: 'ground', ground: 'audio' },
};

function roleOfSignalId(db: Db, id: string): Reading | undefined {
  const known = SIGNAL_ROLES[id];
  if (known !== undefined) return known;
  // a return the wizard has no class for (Video GND, Blanking GND, a new one) is still ground
  if (kindOfSignal(db, id) === 'ground' || id.startsWith('gnd-')) return { role: 'ground', ground: 'other' };
  return undefined;
}

function roleOfSignal(db: Db, ref: SignalRef): Reading | undefined {
  const readings = signalIds(ref).map((id) => roleOfSignalId(db, id));
  // a pin that can take sync (SCART 20: CVBS or CSync) is where the sync core lands
  const sync = readings.find((r) => r?.role === 'sync');
  return sync ?? readings[0];
}

/**
 * The role a terminal's tags give: its signal first (the first of a `oneOf`,
 * unless one of them is sync), then its pad role, then its lane. `undefined`
 * when the tags name nothing a cable lands (`nc`, `hsync`, a spare core).
 */
export function roleOfTags(db: Db, tags: TerminalTags): Reading | undefined {
  if (tags.signal !== undefined) {
    const reading = roleOfSignal(db, tags.signal);
    if (reading !== undefined) return reading;
  }
  if (tags.role !== undefined) {
    const own = PAD_ROLES[tags.role];
    if (own !== undefined) return own;
    const lane = laneOfPadRole(db, tags.role);
    const role = lane === undefined ? undefined : LANE_ROLES[lane];
    return role === undefined ? undefined : { role };
  }
  if (tags.lane !== undefined) {
    const role = LANE_ROLES[tags.lane];
    return role === undefined ? undefined : { role };
  }
  return undefined;
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
  role?: Role;
  ground?: GroundClass;
  /**
   * True for the pads/pins the *trunk* lands on. A board's other terminals are
   * where a connector's pins land ("connector pin landing pad H1") — a
   * different job, handled by the plug picker.
   */
  cableSide: boolean;
  /** for a board's connector-pin pads: the group they belong to (`j`, `jp`, …) */
  plugPrefix?: string;
}

/**
 * Whether a pad is where the *trunk* lands.
 *
 * The generated board records say so in the pad's own note: "conductor landing
 * pad H9" and "shield / ground pads H16, H17" are cable-side, "connector pin
 * landing pad H1" is where a plug's pin goes. Terminals whose id carries a
 * prefix (`j.5`, `scart.15`) are already excluded by their shape, so the note
 * only has to catch the one phrase.
 */
function isTrunkPad(note: string | undefined): boolean {
  return note === undefined || !normalise(note).startsWith('connector pin landing pad');
}

/**
 * A connector's pins as the wizard reads them. With `db`, a tagged pin is read
 * from its tags (`signalOf`); an untagged one — or any pin, without `db` —
 * from its label, id and aliases.
 */
export function connectorTerminals(connector: ConnectorDefinition, db?: Db): EndTerminal[] {
  return connector.pins.map((pin) => {
    const tags = db === undefined ? undefined : signalOf(db, 'connector', connector.id, pin.id);
    const parsed =
      tags !== undefined && db !== undefined
        ? roleOfTags(db, tags)
        : roleOfLabels([pin.label, pin.id, ...(pin.aliases ?? [])]);
    return {
      id: pin.id,
      label: pin.label,
      cableSide: true,
      ...(parsed === undefined ? {} : { role: parsed.role }),
      ...(parsed?.ground === undefined ? {} : { ground: parsed.ground }),
    };
  });
}

/** A board's terminals as the wizard reads them — tags first with `db`, as `connectorTerminals`. */
export function pcbaTerminals(pcba: PcbaDefinition, db?: Db): EndTerminal[] {
  const integrated = new Set((pcba.integratedConnectors ?? []).map((entry) => entry.terminalPrefix));
  return pcba.terminals.map((terminal) => {
    const tags = db === undefined ? undefined : signalOf(db, 'pcba', pcba.id, terminal.id);
    const parsed =
      tags !== undefined && db !== undefined ? roleOfTags(db, tags) : roleOfLabels([terminal.label, terminal.id]);
    const dot = terminal.id.indexOf('.');
    const prefix = dot === -1 ? undefined : terminal.id.slice(0, dot);
    const cableSide = dot === -1 && isTrunkPad(terminal.note);
    return {
      id: terminal.id,
      label: terminal.label ?? terminal.id,
      cableSide,
      ...(parsed === undefined ? {} : { role: parsed.role }),
      ...(parsed?.ground === undefined ? {} : { ground: parsed.ground }),
      ...(prefix === undefined || integrated.has(prefix) ? {} : { plugPrefix: prefix }),
    };
  });
}

/** One electrical element of a wire stock, with the signal it carries. */
export interface WireLine {
  /** the element path a `TerminalRef` uses — `core-red.center`, `drain` */
  path: string;
  label: string;
  kind: 'conductor' | 'shield';
  role: Role;
  /** for a shield: the class of ground it prefers, from the core it wraps */
  ground?: GroundClass;
  /** true for the bare drain, which is landed at the source end only */
  drain: boolean;
}

const COLOUR_ROLE: Readonly<Record<string, Role>> = {
  red: 'video-r',
  green: 'video-g',
  blue: 'video-b',
  yellow: 'sync',
  white: 'audio-l',
  black: 'audio-r',
  brown: 'power-5v',
};

/**
 * Every electrical element of a stock, in lay order of the structure, with the
 * role it carries. Conductors take their role from their own label and fall
 * back to the fleet colour code; shields take the *ground class* of the core
 * they wrap, so a shield knows which return it belongs on.
 */
export function wireLines(wire: WireDefinition, db?: Db): WireLine[] {
  const lines: WireLine[] = [];
  /** a conductor's role from its lane, when `db` tags it */
  const tagged = (path: string): Role | undefined => {
    if (db === undefined) return undefined;
    const tags = signalOf(db, 'segment', wire.id, path);
    return tags === undefined || tags.screen === true ? undefined : roleOfTags(db, tags)?.role;
  };
  const isTagged = (path: string): boolean =>
    db !== undefined && signalOf(db, 'segment', wire.id, path) !== undefined;

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
            : (roleOfLabels([inner.label])?.role ??
              (inner.color === undefined ? undefined : COLOUR_ROLE[inner.color]) ??
              roleOfLabels([element.label])?.role);
      for (const child of element.children) {
        walk(child, path === '' ? child.id : `${path}.${child.id}`, role);
      }
      return;
    }
    if (element.kind === 'insulation') return;
    if (element.kind === 'conductor') {
      const role =
        element.bare === true && isTagged(path)
          ? 'ground'
          : isTagged(path)
            ? tagged(path)
            : (roleOfLabels([element.label])?.role ??
              (element.color === undefined ? undefined : COLOUR_ROLE[element.color]) ??
              (element.bare === true ? 'ground' : coreRole));
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
    const cls = groundClassOf(coreRole);
    lines.push({
      path,
      label: element.label ?? path,
      kind: 'shield',
      role: 'ground',
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
 * Lengths — mm is the model, feet and inches are how the shop talks
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

/** The lengths the catalog actually builds, offered as one-click presets. */
export const LENGTH_PRESETS: readonly { mm: number; label: string }[] = [
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
  name: 'What is this cable called?',
  source: 'What does it plug into? (console end)',
  wire: 'Which wire, and how long?',
  destination: 'What does it plug into at the other end?',
  choices: 'A few things only you can decide',
  review: 'Check it over',
};

export const STEP_SAY: Readonly<Record<WizardStep, string>> = {
  name: 'A name a builder would read at the top of the build sheet, and a note of where the information comes from.',
  source: 'Pick the plug that goes into the source device, or the source-side board the cable is soldered to.',
  wire: 'The stock the trunk is cut from, and how long to cut it.',
  destination: 'The plug or board at the far end — usually a SCART male destination board.',
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
    src: '',
    source: undefined,
    destination: undefined,
    wireDef: undefined,
    lengthText: '1830',
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
      if (state.label.trim() === '') out.push('Give the cable a name.');
      // held in a boolean so the guard does not narrow `id` away in the else
      const id = state.id;
      const idOk: boolean = isDesignId(id);
      if (!idOk) {
        out.push(
          id.trim() === ''
            ? 'The cable needs an id — lowercase words joined by hyphens.'
            : `'${id}' cannot be used as an id. Use lowercase words joined by hyphens.`,
        );
      } else if (state.taken.includes(id)) {
        out.push(`A design called '${id}' already exists. Choose another id.`);
      }
      if (state.src.trim() === '') {
        out.push('Say where this information comes from — every record in the catalog carries its source.');
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
      return state.destination === undefined ? ['Pick the plug or board at the far end.'] : [];
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

function trunkCandidates(end: ResolvedEnd, role: Role): EndTerminal[] {
  return end.terminals.filter((terminal) => terminal.cableSide && terminal.role === role);
}

function groundCandidates(end: ResolvedEnd, cls: GroundClass | undefined): EndTerminal[] {
  const grounds = end.terminals.filter((t) => t.cableSide && t.role === 'ground');
  if (cls !== undefined) {
    const exact = grounds.filter((t) => t.ground === cls);
    if (exact.length > 0) return exact;
  }
  return grounds.filter((t) => t.ground === undefined);
}

function choiceIdOf(end: EndSide, key: string): string {
  return `${end}:${key}`;
}

/**
 * The single mono audio pin an audio core falls back to.
 *
 * several source devices deliver one audio pin
 * that feeds both channels; the catalog says so by labelling it "Audio (mono)".
 * When that pin is the *only* audio landing on the end, sending both the L and
 * R cores to it is the documented build, not an invention.
 */
function monoStandIn(end: ResolvedEnd, role: Role): EndTerminal | undefined {
  if (role !== 'audio-l' && role !== 'audio-r') return undefined;
  const mono = trunkCandidates(end, 'audio-mono');
  return mono.length === 1 ? mono[0] : undefined;
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
/* ------------------------------------------------------------------ *
 * A bare SCART head — the SCART male soldered straight to the cable
 * ------------------------------------------------------------------ */

/**
 * A SCART male with no destination board (the contract manufacturer's sample
 * runs). Everything the board would decide is decided the same way here, so a
 * bare head is wired exactly like a PCA-00101 Rev6 "CPL Basic" build:
 *
 * - audio lands on the TV's audio *inputs*, 6 (L) and 2 (R) — the board's
 *   LA → 6 and RA → 2;
 * - the overall shield bonds to the shell, pin 21;
 * - +5 V goes to pin 8 directly and to pin 16 through a discrete 180 Ω — the
 *   board's plain V → 8 link and its R203 180 Ω blanking resistor.
 */
export const BARE_SCART_DEF = 'scart-male';
export const BARE_SCART_BLANKING = 'r-180';

const BARE_SCART_PICKS: Readonly<Record<string, string>> = {
  ground: '21',
  'audio-l': '6',
  'audio-r': '2',
};

export const BARE_SCART_NOTE =
  'Bare SCART head (no destination board): wired as the PCA-00101 Rev6 CPL Basic board would be — audio into pins 6/2, overall shield to the shell (21), +5 V to pin 8, a 180 Ω blanking resistor fitted by hand across pins 8 and 16 (the board\'s R203), and hand-wired ground jumpers on the returns the board commoned that no braid reaches (14 → 13, 18 → 17).';

/**
 * A ground return no braid lands on is bonded by a short hand-wired jumper to
 * its neighbouring return, so every pin the board commoned is still ground.
 */
export const GROUND_JUMPER_TO: Readonly<Record<string, string>> = {
  '14': '13',
  '18': '17',
};

function isBareScart(end: { kind: 'connector' | 'pcba'; def: string }): boolean {
  return end.kind === 'connector' && end.def === BARE_SCART_DEF;
}

/** What a bare SCART head answers on its own, keyed like a pick. */
function presetPick(end: ResolvedEnd, key: 'ground' | Role): string | undefined {
  if (!isBareScart(end)) return undefined;
  return BARE_SCART_PICKS[key];
}

export function openChoices(state: WizardState): OpenChoice[] {
  const wire = state.wireDef === undefined ? undefined : findWire(state.db, state.wireDef);
  if (wire === undefined) return [];
  const lines = wireLines(wire, state.db);
  const out: OpenChoice[] = [];

  for (const end of resolveEnds(state)) {
    const where = end.side === 'source' ? 'console end' : 'far end';

    // one question for the ground bond, however many braids share the answer
    const grounds = end.terminals.filter((t) => t.cableSide && t.role === 'ground');
    const general = groundCandidates(end, undefined);
    const needing = lines.filter(
      (line) =>
        line.role === 'ground' &&
        !(line.drain && end.wireEnd === 'b') &&
        groundCandidates(end, line.ground).length !== 1,
    );
    if (needing.length > 0 && grounds.length > 0 && presetPick(end, 'ground') === undefined) {
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
      const exact = trunkCandidates(end, line.role);
      if (exact.length === 1) continue;
      if (presetPick(end, line.role) !== undefined) continue;
      // a lone "Audio (mono)" pin feeding both audio cores is the catalog's own
      // convention, not a guess — see `planCable`. Nothing to ask.
      if (exact.length === 0 && monoStandIn(end, line.role) !== undefined) continue;
      const near =
        exact.length === 0
          ? (NEAR[line.role] ?? []).flatMap((role) => trunkCandidates(end, role))
          : [];
      const options = exact.length > 1 ? exact : near;
      if (options.length === 0) continue;
      out.push({
        id: choiceIdOf(end.side, line.path),
        end: end.side,
        question: `Where does the ${ROLE_LABELS[line.role]} core land at the ${where}?`,
        say:
          exact.length > 1
            ? `${end.label} has ${exact.length} landings for ${ROLE_LABELS[line.role]}. Only you know which one this build uses.`
            : `Nothing on ${end.label} is labelled ${ROLE_LABELS[line.role]}. These are the closest — leave it unconnected if none is right.`,
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
  return `Drain policy (SW / "Stripping Coax"): the drain is terminated at the source end only — ${segment} drain @b is deliberately cut at the destination and left unconnected.`;
}

const MONO_NOTE =
  'The console end delivers mono audio: one audio pin feeds both the Audio L and Audio R cores.';

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
        role: end.side === 'source' ? 'source plug (console end)' : 'destination plug',
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

  const segmentId = 'w1';
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
            : pad.role === 'ground'
              ? pins.filter((pin) => pin.role === 'ground' && pin.ground === pad.ground)
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
  if (wire !== undefined) {
    const allLines = wireLines(wire, state.db);
    for (const end of ends) {
      const where = end.side === 'source' ? 'console end' : 'far end';
      for (const line of allLines) {
        // the drain is landed at the source end only — shop standard
        if (line.drain && end.wireEnd === 'b') continue;
        // +5 V on a bare SCART head is two joints and a resistor — below
        if (line.role === 'power-5v' && isBareScart(end)) continue;

        const ref: TerminalRef = { instance: segmentId, terminal: line.path, end: end.wireEnd };
        const pick =
          state.picks[choiceIdOf(end.side, line.role === 'ground' ? 'ground' : line.path)] ??
          presetPick(end, line.role === 'ground' ? 'ground' : line.role);

        let target: EndTerminal | undefined;
        let why: string | undefined;

        if (line.role === 'ground') {
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
          const exact = trunkCandidates(end, line.role);
          if (exact.length === 1) target = exact[0];
          else if (pick !== undefined && pick !== '') {
            target = end.terminals.find((terminal) => terminal.id === pick);
          } else if (exact.length === 0) {
            // a lone mono audio pin legitimately feeds both audio cores
            const mono = monoStandIn(end, line.role);
            if (mono !== undefined) {
              target = mono;
              if (!notes.includes(MONO_NOTE)) notes.push(MONO_NOTE);
            } else {
              why = choiceIds.has(choiceIdOf(end.side, line.path))
                ? `nothing on ${end.label} is labelled ${ROLE_LABELS[line.role]}, and you did not pick a stand-in.`
                : `nothing on ${end.label} carries ${ROLE_LABELS[line.role]}.`;
            }
          } else {
            why = `${end.label} offers ${exact.length} landings for ${ROLE_LABELS[line.role]} and you have not chosen one.`;
          }
        }

        if (target === undefined) {
          unconnected.push({
            what: `${line.label} (${line.path}) at the ${where}`,
            why: why ?? `nothing on ${end.label} matches it.`,
          });
          continue;
        }

        const note =
          line.drain
            ? 'drain terminated at the source end only'
            : line.role === 'ground' && line.kind === 'shield' && end.side === 'source'
              ? 'braid trimmed and twisted together with the drain onto the ground landing'
              : undefined;
        solder(
          ref,
          { instance: end.instance, terminal: target.id },
          note,
          `${line.label} (${line.path}) at the ${where} → ${end.instance} ${target.id} (${target.label})`,
        );
      }
    }

    // --- a bare SCART head: +5 V to pin 8, and to 16 through 180 Ω ---------
    for (const end of ends) {
      if (!isBareScart(end)) continue;
      const power = allLines.find((line) => line.role === 'power-5v');
      if (power !== undefined) {
        const ref: TerminalRef = { instance: segmentId, terminal: power.path, end: end.wireEnd };
        const resistor = `r${design.instances.components.length + 1}`;
        design.instances.components.push({
          id: resistor,
          def: BARE_SCART_BLANKING,
          location: 'scart-head',
          note: 'RGB blanking, fitted by hand across SCART pins 8 and 16 — stands in for the destination board\'s R203 180 Ω',
        });
        solder(ref, { instance: end.instance, terminal: '8' }, undefined, `${power.label} (${power.path}) at the far end → ${end.instance} 8 (status)`);
        solder({ instance: end.instance, terminal: '8' }, { instance: resistor, terminal: 'a' }, undefined, `${resistor} (180 Ω) fitted across ${end.instance} 8 …`);
        solder({ instance: resistor, terminal: 'b' }, { instance: end.instance, terminal: '16' }, undefined, `… and ${end.instance} 16 (RGB blanking)`);
      }
      // the returns the board would have commoned
      const used = new Set(joints.flatMap((j) => [j.a, j.b]).filter((r) => r.instance === end.instance).map((r) => r.terminal));
      for (const [pin, partner] of Object.entries(GROUND_JUMPER_TO)) {
        if (used.has(pin) || !used.has(partner)) continue;
        solder(
          { instance: end.instance, terminal: pin },
          { instance: end.instance, terminal: partner },
          `ground jumper, hand-wired: the destination board commons pin ${pin} with the other returns`,
          `${end.instance} ${pin} ⟷ ${end.instance} ${partner} (ground jumper)`,
        );
      }
      if (!notes.includes(BARE_SCART_NOTE)) notes.push(BARE_SCART_NOTE);
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
