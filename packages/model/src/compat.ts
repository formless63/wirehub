/**
 * Joint compatibility — what may legally be soldered to what.
 *
 * `validateDesign` is structural: it refuses a joint only when a terminal
 * cannot be resolved at all. This module adds the *physical* rules a real
 * cable obeys, derived from how every catalog design is actually wired:
 *
 * - every terminal falls into one **class** (`TerminalClass`): a connector
 *   pin, a board's cable-side pad (`R`, `GND`, `LA` …), a board's
 *   connector-side pad (`j.3`, `j1.5`, `jp.GND`, or an integrated connector's
 *   `scart.15`), a wire conductor, a drain, a shield/foil, or a component lead;
 * - its **signal** (`SignalHint`) comes from its vocab tags (`signalOf`: pin
 *   signal, pad role, the lane a stock's colour code gives a core — data model
 *   v2 task 3), and only for an untagged terminal is it read off its label —
 *   `Video R`, `CSync`, `Audio L`, `+5 V`, `GND` — falling back to a
 *   conductor's colour;
 * - `jointCompatibility` says whether two terminals may share a joint.
 *
 * The rules are deliberately few, and each one is a fact about copper, not a
 * preference:
 *
 * 1. a shield, foil or drain only lands on something at ground — a
 *    ground-labelled pin or pad, or another shield/drain (a splice) — never
 *    on a signal pin/pad, a signal conductor or a component lead;
 * 2. two pins on *different* connectors never meet directly unless they mate
 *    (same family, opposite genders, same pin) or are both ground (a bonding
 *    tie) — an RCA plug's tip does not solder to a SCART pin;
 * 3. pads on *different* boards likewise never meet directly unless both are
 *    ground — boards are linked by wire, not by touching;
 * 4. a wire stock's terminals are never joined to each other — that is a loop
 *    (`core@a` to `core@b`) or a short between two cores of the same cable.
 *
 * Everything else — a conductor end on a pin, a pad (either side of a board)
 * or another conductor (a splice), a connector pin on a board's pads, a
 * component lead on anything — is allowed. Which of the allowed matches is
 * *likely* (a red core onto an `R` pad) is ranking, and ranking is the
 * editor's business, not core's.
 *
 * `compatibilityIssues` runs the rules over a design and reports each
 * violation as a **warning** (never an error): a design that breaks one may
 * still be what the bench built, and the person reading the warning decides.
 * `validateDesign` folds these warnings in so every
 * consumer sees them in one pass; this module stays independent of
 * `validateDesign` so it can still be called on its own (e.g. to profile a
 * single candidate joint before it is added to a design).
 */

import {
  findComponent,
  findConnector,
  findPcba,
  findWire,
  pigtailIdOf,
  type CableDesign,
  type ConnectorDefinition,
  type ConnectorGender,
  type Db,
  type InstanceKind,
  type Issue,
  type TerminalRef,
} from './model.ts';
import { isElectricalElement, resolveElementPath } from './paths.ts';
import { kindOfSignal, laneOfPadRole, signalOf, type TerminalTags } from './signals.ts';
import { findInstance, terminalKey } from './validate.ts';
import { signalIds } from './vocab.ts';

/** What kind of physical thing a terminal is. */
export type TerminalClass =
  | 'connector-pin'
  | 'board-cable-pad'
  | 'board-connector-pad'
  | 'conductor'
  | 'drain'
  | 'shield'
  | 'component-lead';

/**
 * The signal a terminal carries, as far as its label says. `sync` covers every
 * signal the sync core carries in practice (CSync, H/V sync, luma, CVBS);
 * `switching` is the +V-fed control lines (SCART blanking, JP21 Ys, function
 * switching) that a cable feeds from its +5 V core.
 */
export type SignalHint =
  | 'red'
  | 'green'
  | 'blue'
  | 'sync'
  | 'chroma'
  | 'audio-l'
  | 'audio-r'
  | 'audio-mono'
  | 'power'
  | 'switching'
  | 'ground';

/** One terminal, described for compatibility. */
export interface TerminalProfile {
  class: TerminalClass;
  /** undefined = the label says nothing recognisable (`Signal`, `Mode select`, `spare`) */
  signal?: SignalHint;
  /** at ground: a ground-labelled pin/pad, or any shield/drain */
  ground: boolean;
  /** the connector a pin belongs to — a connector's own, or the one a board integrates */
  connector?: { family: string; gender?: ConnectorGender; pin: string };
}

const CONDUCTOR_COLOUR_SIGNAL: Readonly<Record<string, SignalHint>> = {
  red: 'red',
  green: 'green',
  blue: 'blue',
  yellow: 'sync',
  white: 'audio-l',
  black: 'audio-r',
  brown: 'power',
};

/**
 * The signal a label names, or `undefined`. Order matters: `Red GND` is ground
 * before it is red, `Audio R` is audio before it is red, and an explicit
 * "not connected" beats anything else in the text.
 */
export function signalFromLabel(label: string | undefined): SignalHint | undefined {
  if (label === undefined) return undefined;
  const text = label.trim();
  if (text === '') return undefined;
  if (/\bgnd\b|ground|\bshield\b|\bshell\b|chassis/i.test(text)) return 'ground';
  if (/not connected|unused|unknown|internal net|\bspare\b/i.test(text)) return undefined;
  if (/chroma/i.test(text)) return 'chroma';
  if (/sync|luma|cvbs|composite/i.test(text)) return 'sync';
  if (/audio|\bLA\b|\bRA\b/i.test(text)) {
    if (/mono|L\s*\+\s*R/i.test(text)) return 'audio-mono';
    if (/\bL\b|left|\bLA\b/i.test(text)) return 'audio-l';
    if (/\bR\b|right|\bRA\b/i.test(text)) return 'audio-r';
    return 'audio-mono';
  }
  if (/\bred\b|video r\b/i.test(text)) return 'red';
  if (/\bgreen\b|video g\b/i.test(text)) return 'green';
  if (/\bblue\b|video b\b/i.test(text)) return 'blue';
  if (/blanking|rgb select|\bYs\b|function switch|status/i.test(text)) return 'switching';
  if (/[+-]?\d+(\.\d+)?\s*V\b|\bV\+|power/i.test(text)) return 'power';
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Tags → hints
 * ------------------------------------------------------------------ */

const SIGNAL_HINTS: Readonly<Record<string, SignalHint>> = {
  'video-r': 'red',
  'video-g': 'green',
  'video-b': 'blue',
  csync: 'sync',
  cvbs: 'sync',
  luma: 'sync',
  hsync: 'sync',
  vsync: 'sync',
  sog: 'sync',
  chroma: 'chroma',
  'audio-l': 'audio-l',
  'audio-l-in': 'audio-l',
  'audio-r': 'audio-r',
  'audio-r-in': 'audio-r',
  'audio-mono': 'audio-mono',
  blanking: 'switching',
  'function-switch': 'switching',
};

const LANE_HINTS: Readonly<Record<string, SignalHint>> = {
  'video-r': 'red',
  'video-g': 'green',
  'video-b': 'blue',
  sync: 'sync',
  'audio-l': 'audio-l',
  'audio-r': 'audio-r',
  power: 'power',
};

const ROLE_HINTS: Readonly<Record<string, SignalHint>> = {
  gnd: 'ground',
  'gnd-audio': 'ground',
  'audio-l-in': 'audio-l',
  'audio-r-in': 'audio-r',
};

function hintOfSignal(db: Db, id: string): SignalHint | undefined {
  const hint = SIGNAL_HINTS[id];
  if (hint !== undefined) return hint;
  const kind = kindOfSignal(db, id);
  if (kind === 'ground' || id === 'gnd' || id.startsWith('gnd-')) return 'ground';
  if (kind === 'power' || id.startsWith('pwr-')) return 'power';
  return undefined;
}

/**
 * The compat hint a terminal's tags give: a screen is ground; otherwise the
 * signal (the first of a `oneOf` — the pin's own label), then the pad role,
 * then the lane. `undefined` when the tags name nothing compat has a word for
 * (`nc`, `mode-select`, a spare core).
 */
export function hintOfTags(db: Db, tags: TerminalTags): SignalHint | undefined {
  if (tags.screen === true) return 'ground';
  if (tags.signal !== undefined) {
    const first = signalIds(tags.signal)[0];
    const hint = first === undefined ? undefined : hintOfSignal(db, first);
    if (hint !== undefined) return hint;
  }
  if (tags.role !== undefined) {
    const own = ROLE_HINTS[tags.role];
    if (own !== undefined) return own;
    const lane = laneOfPadRole(db, tags.role);
    if (lane !== undefined) return LANE_HINTS[lane];
    return undefined;
  }
  if (tags.lane !== undefined) return LANE_HINTS[tags.lane];
  return undefined;
}

function pinProfile(db: Db, connector: ConnectorDefinition, pinId: string, cls: TerminalClass): TerminalProfile | undefined {
  const pin = connector.pins.find((p) => p.id === pinId);
  if (pin === undefined) return undefined;
  const tags = signalOf(db, 'connector', connector.id, pin.id);
  const signal = tags === undefined ? signalFromLabel(pin.label) : hintOfTags(db, tags);
  return {
    class: cls,
    ...(signal === undefined ? {} : { signal }),
    ground: signal === 'ground',
    connector: {
      family: connector.family,
      ...(connector.gender === undefined ? {} : { gender: connector.gender }),
      pin: pin.id,
    },
  };
}

/**
 * Describe terminal `terminal` of a `kind`/`def` definition — no design
 * needed, so a part not yet on the canvas can be profiled. `undefined` when
 * the definition or terminal does not exist (or names a non-electrical wire
 * element).
 */
export function profileTerminal(
  db: Db,
  kind: InstanceKind,
  def: string,
  terminal: string,
): TerminalProfile | undefined {
  switch (kind) {
    case 'connector': {
      const connector = findConnector(db, def);
      return connector === undefined ? undefined : pinProfile(db, connector, terminal, 'connector-pin');
    }
    case 'segment': {
      const wire = findWire(db, def);
      // a pigtail is twisted screens: it profiles as a shield, at ground. Which
      // pigtails exist is a fact of the design, not the stock, so the id is
      // not checked here — `resolveTerminal` does that.
      if (wire !== undefined && pigtailIdOf(terminal) !== undefined) {
        return { class: 'shield', signal: 'ground', ground: true };
      }
      const element = wire === undefined ? undefined : resolveElementPath(wire.structure, terminal);
      if (element === undefined || !isElectricalElement(element)) return undefined;
      if (element.kind === 'shield') return { class: 'shield', signal: 'ground', ground: true };
      if (element.bare === true) return { class: 'drain', signal: 'ground', ground: true };
      const tags = signalOf(db, 'segment', def, terminal);
      const signal =
        tags !== undefined
          ? hintOfTags(db, tags)
          : (signalFromLabel(element.label) ??
            (element.color === undefined ? undefined : CONDUCTOR_COLOUR_SIGNAL[element.color]));
      return { class: 'conductor', ...(signal === undefined ? {} : { signal }), ground: signal === 'ground' };
    }
    case 'component': {
      const component = findComponent(db, def);
      if (component?.terminals.some((t) => t.id === terminal) !== true) return undefined;
      return { class: 'component-lead', ground: false };
    }
    case 'pcba': {
      const pcba = findPcba(db, def);
      if (pcba === undefined) return undefined;
      const own = pcba.terminals.find((t) => t.id === terminal);
      if (own !== undefined) {
        const tags = signalOf(db, 'pcba', def, terminal);
        const signal = tags !== undefined ? hintOfTags(db, tags) : (signalFromLabel(own.label) ?? signalFromLabel(own.id));
        return {
          // a dotted pad id (`j.3`, `j1.5`, `jp.GND`) is a pad of a connector
          // footprint on the board — the console/display side; a bare id
          // (`R`, `GND`, `LA`) is a pad the cable's wires land on
          class: terminal.includes('.') ? 'board-connector-pad' : 'board-cable-pad',
          ...(signal === undefined ? {} : { signal }),
          ground: signal === 'ground',
        };
      }
      for (const integrated of pcba.integratedConnectors ?? []) {
        const prefix = `${integrated.terminalPrefix}.`;
        if (!terminal.startsWith(prefix)) continue;
        const connector = findConnector(db, integrated.connectorDefId);
        const profile =
          connector === undefined
            ? undefined
            : pinProfile(db, connector, terminal.slice(prefix.length), 'board-connector-pad');
        if (profile !== undefined) return profile;
      }
      return undefined;
    }
  }
}

/** A profiled terminal of a design instance: the profile plus whose it is. */
export interface InstanceTerminal {
  instance: string;
  kind: InstanceKind;
  profile: TerminalProfile;
}

/** `profileTerminal` for a terminal of a design, or `undefined` if it does not resolve. */
export function profileDesignTerminal(
  design: CableDesign,
  db: Db,
  ref: TerminalRef,
): InstanceTerminal | undefined {
  const instance = findInstance(design, ref.instance);
  if (instance === undefined) return undefined;
  const profile = profileTerminal(db, instance.kind, instance.def, ref.terminal);
  return profile === undefined ? undefined : { instance: instance.id, kind: instance.kind, profile };
}

export type JointVerdict =
  | { ok: true }
  | { ok: false; code: CompatibilityCode; reason: string };

export type CompatibilityCode =
  | 'shield-off-ground'
  | 'pin-to-foreign-pin'
  | 'board-to-board'
  | 'wire-to-itself';

const isBoard = (cls: TerminalClass): boolean => cls === 'board-cable-pad' || cls === 'board-connector-pad';
const isPin = (p: TerminalProfile): boolean => p.connector !== undefined;
const isScreen = (cls: TerminalClass): boolean => cls === 'shield' || cls === 'drain';

function mates(x: TerminalProfile, y: TerminalProfile): boolean {
  const a = x.connector;
  const b = y.connector;
  return (
    a !== undefined &&
    b !== undefined &&
    a.family === b.family &&
    a.gender !== undefined &&
    b.gender !== undefined &&
    a.gender !== b.gender &&
    a.pin === b.pin
  );
}

/**
 * May these two terminals share a joint? Symmetric. `x.instance === y.instance`
 * matters: a bridge between two pins of one connector (commoned GND pins) or
 * two pads of one board (`AUD_GND` to `GND`) is a jumper, not a mismatch.
 */
export function jointCompatibility(x: InstanceTerminal, y: InstanceTerminal): JointVerdict {
  const p = x.profile;
  const q = y.profile;
  const sameInstance = x.instance === y.instance;

  if (x.kind === 'segment' && y.kind === 'segment' && sameInstance) {
    return { ok: false, code: 'wire-to-itself', reason: 'a wire stock joined to itself — a loop or a short between its own cores' };
  }
  for (const [screen, other] of [
    [p, q],
    [q, p],
  ] as const) {
    if (!isScreen(screen.class)) continue;
    if (other.ground || isScreen(other.class)) continue;
    return { ok: false, code: 'shield-off-ground', reason: `a ${screen.class} lands only on ground, not on a ${other.class}${other.signal === undefined ? '' : ` carrying ${other.signal}`}` };
  }
  if (isPin(p) && isPin(q) && !sameInstance) {
    // a board's integrated connector counts as a connector here: its pins
    // mate, they do not take another connector's pins by solder
    if (!(p.ground && q.ground) && !mates(p, q)) {
      return { ok: false, code: 'pin-to-foreign-pin', reason: 'pins of two different connectors meet only by mating (same family, opposite genders, same pin) or as a ground bond' };
    }
    return { ok: true };
  }
  // two boards' connector-side pads soldered straight together are a stacked
  // board: the DIN-8 perfboard's slot pads T-join the console board's pin
  // landings (PCA-00109 Rev2 README "T-joint pad method"; owner 2026-09-29)
  const tJoint = p.class === 'board-connector-pad' && q.class === 'board-connector-pad';
  if (isBoard(p.class) && isBoard(q.class) && !sameInstance && !(p.ground && q.ground) && !tJoint) {
    return { ok: false, code: 'board-to-board', reason: 'pads of two different boards are linked by a wire, not directly' };
  }
  return { ok: true };
}

/**
 * Every joint of `design` that breaks a compatibility rule, as a warning
 * (`where` = `joints[i]`). Joints whose terminals do not resolve are skipped —
 * `validateDesign` already reports those as errors.
 *
 * Folded into `validateDesign`: the render-svg schematic
 * `<desc>`, the docs build sheet and the editor's Issues panel all read
 * `validateDesign`'s output, so they pick these warnings up automatically.
 * This function stays exported and independent for callers that want just
 * the compatibility rules (e.g. `compat.test.ts`, or profiling a candidate
 * joint before it is added to a design).
 */
export function compatibilityIssues(design: CableDesign, db: Db): Issue[] {
  const issues: Issue[] = [];
  design.joints.forEach((joint, index) => {
    const x = profileDesignTerminal(design, db, joint.a);
    const y = profileDesignTerminal(design, db, joint.b);
    if (x === undefined || y === undefined) return;
    const verdict = jointCompatibility(x, y);
    if (verdict.ok) return;
    issues.push({
      code: verdict.code,
      severity: 'warning',
      message: `${terminalKey(joint.a)} ↔ ${terminalKey(joint.b)}: ${verdict.reason}`,
      where: `joints[${index}]`,
    });
  });
  return issues;
}
