/**
 * Supply and ground rails. A conductor may sit on a
 * supply or ground terminal only when it positively reads as that rail: its
 * own words (or its core's) say so, the stock names its lane, or it has no
 * words of its own and its colour code says so. Everything else on a rail is
 * a short a builder would solder without question — an error, whatever else
 * the design says:
 *
 * - `signal-on-power-rail`: a conductor that reads as a signal, on a supply rail
 * - `unknown-on-power-rail`: a conductor whose own words the vocabulary cannot
 *   read ("Video Sync" on a hub with no plain "sync" entry), on a supply or a
 *   ground; its colour code (yellow is a supply in one code) does not count
 * - `rail-mismatch`: a supply conductor on a ground, a ground on a supply, or
 *   one conductor joining two supplies of different voltages
 *
 * A conductor with no words of its own and no lane (a plain "Pin 9" core of
 * a straight-through lead) is the design's own choice of use and is not
 * flagged; the wizard never lands one on a rail by its reading alone.
 *
 * Softer: a signal tied to a ground (`signal-on-ground`), a supply conductor whose words name one voltage on a terminal of
 * another (`rail-voltage-differs`), and two different signals joined onto one
 * terminal (`signals-share-terminal`; a vocabulary stand-in, both audio
 * channels onto one mono pin, is fine) are warnings.
 */

import { profileDesignTerminal, type SignalHint } from './compat.ts';
import { readConductor, type ConductorReading } from './conductor-reading.ts';
import { findConnector, findPcba, findWire, type CableDesign, type Db, type Issue, type TerminalRef } from './model.ts';
import { resolveElementPath } from './paths.ts';
import { readSignalWords, signalOfLane, voltageOfSignal } from './signal-words.ts';
import { laneOfPadRole, signalOf } from './signals.ts';
import { findInstance, terminalKey } from './validate.ts';
import { signalIds, vocabEntry, type SignalEntry } from './vocab.ts';

/** How a trunk element reads: a conductor by `readConductor`; a shield, a foil or a pigtail is ground by construction. */
function elementReading(design: CableDesign, db: Db, ref: TerminalRef): ConductorReading | undefined {
  const seg = design.instances.segments.find((s) => s.id === ref.instance);
  const wire = seg === undefined ? undefined : findWire(db, seg.def);
  if (wire === undefined) return undefined;
  const element = resolveElementPath(wire.structure, ref.terminal);
  if (element === undefined) {
    // a pigtail (twisted screens) is a fact of the design, not the stock
    return profileDesignTerminal(design, db, ref)?.profile.class === 'shield' ? { basis: 'construction', hint: 'ground' } : undefined;
  }
  if (element.kind === 'shield') return { basis: 'construction', hint: 'ground' };
  return readConductor(db, wire, ref.terminal);
}

/** The vocab signal a board pad or connector pin carries exactly (`pwr-5v`), when its tags or words name one. */
function terminalSignal(design: CableDesign, db: Db, ref: TerminalRef): string | undefined {
  const instance = findInstance(design, ref.instance);
  if (instance === undefined || (instance.kind !== 'pcba' && instance.kind !== 'connector')) return undefined;
  const tags = signalOf(db, instance.kind, instance.def, ref.terminal);
  if (tags?.signal !== undefined) {
    const first = signalIds(tags.signal)[0];
    if (first !== undefined) return first;
  }
  if (tags?.role !== undefined) {
    const lane = laneOfPadRole(db, tags.role);
    const signal = lane === undefined ? undefined : signalOfLane(db.vocab, lane);
    if (signal !== undefined) return signal;
  }
  if (instance.kind === 'connector') {
    return readSignalWords(db.vocab, findConnector(db, instance.def)?.pins.find((p) => p.id === ref.terminal)?.label);
  }
  const pcba = findPcba(db, instance.def);
  const own = pcba?.terminals.find((t) => t.id === ref.terminal);
  if (own !== undefined) return readSignalWords(db.vocab, own.label) ?? readSignalWords(db.vocab, own.id);
  for (const integrated of pcba?.integratedConnectors ?? []) {
    const prefix = `${integrated.terminalPrefix}.`;
    if (!ref.terminal.startsWith(prefix)) continue;
    const pin = findConnector(db, integrated.connectorDefId)?.pins.find((p) => p.id === ref.terminal.slice(prefix.length));
    return readSignalWords(db.vocab, pin?.label);
  }
  return undefined;
}

const isSignal = (hint: SignalHint | undefined): hint is string => hint !== undefined && hint !== 'power' && hint !== 'ground';
const railName = (rail: 'power' | 'ground'): string => (rail === 'power' ? 'a supply rail' : 'a ground');

/** The conductor a joint end is, without the end: both ends of one conductor are one key. */
const conductorKey = (ref: TerminalRef): string => `${ref.instance}:${ref.terminal}`;

export function railIssues(design: CableDesign, db: Db): Issue[] {
  const issues: Issue[] = [];
  const onTerminal = new Map<string, { signals: Set<string>; terminalSignal?: string }>();
  /** per conductor: the supply voltages it is joined to, and where */
  const supplies = new Map<string, Map<string, string>>();
  design.joints.forEach((joint, index) => {
    for (const [wireEnd, other] of [[joint.a, joint.b], [joint.b, joint.a]] as const) {
      if (!design.instances.segments.some((s) => s.id === wireEnd.instance)) continue;
      if (design.instances.segments.some((s) => s.id === other.instance)) continue;
      const target = profileDesignTerminal(design, db, other);
      if (target === undefined) continue;
      const reading = elementReading(design, db, wireEnd);
      if (reading === undefined) continue;
      const carried = reading.hint;
      const rail = target.profile.signal === 'power' || target.profile.signal === 'ground' ? target.profile.signal : undefined;
      const where = `joints[${index}]`;
      const here = `${terminalKey(wireEnd)} lands on ${terminalKey(other)}`;

      if (rail !== undefined && carried !== rail) {
        if (isSignal(carried)) {
          if (rail === 'power') {
            issues.push({ code: 'signal-on-power-rail', severity: 'error', message: `${terminalKey(wireEnd)} carries ${carried} but lands on ${terminalKey(other)}, a supply rail: a short between a signal and the supply`, where });
          } else {
            // tying a line to its return is sometimes the build (a balanced cold leg in an unbalanced adapter)
            issues.push({ code: 'signal-on-ground', severity: 'warning', message: `${terminalKey(wireEnd)} carries ${carried} but lands on ${terminalKey(other)}, a ground: the signal is tied to ground`, where });
          }
        } else if (carried !== undefined) {
          issues.push({ code: 'rail-mismatch', severity: 'error', message: `${here}: a ${carried === 'power' ? 'supply' : 'ground'} conductor on ${railName(rail)} shorts the supply to ground`, where });
        } else if (reading.basis === 'unread') {
          const colour = reading.colourLane === undefined ? '' : ` (its colour code's ${reading.colourLane} lane does not count against its own label)`;
          issues.push({
            code: 'unknown-on-power-rail',
            severity: 'error',
            message: `${here}, ${railName(rail)}, but its label "${reading.words ?? ''}" does not read as ${rail === 'power' ? 'a supply' : 'a ground'}${colour}: name its signal in the vocabulary, or land it elsewhere`,
            where,
          });
        }
      }

      if (rail === 'power' && carried === 'power') {
        const at = terminalSignal(design, db, other);
        const volts = at === undefined ? undefined : voltageOfSignal(db.vocab, at);
        if (volts !== undefined) {
          const seen = supplies.get(conductorKey(wireEnd)) ?? new Map<string, string>();
          if (!seen.has(volts)) seen.set(volts, terminalKey(other));
          supplies.set(conductorKey(wireEnd), seen);
          const own = reading.signal === undefined ? undefined : voltageOfSignal(db.vocab, reading.signal);
          if (own !== undefined && own !== volts) {
            issues.push({ code: 'rail-voltage-differs', severity: 'warning', message: `${terminalKey(wireEnd)} is a ${own} V conductor but lands on ${terminalKey(other)}, a ${volts} V supply`, where });
          }
        }
      }

      if (!isSignal(carried)) continue;
      const key = terminalKey(other);
      const seen = onTerminal.get(key) ?? { signals: new Set<string>(), ...(isSignal(target.profile.signal) ? { terminalSignal: target.profile.signal } : {}) };
      seen.signals.add(carried);
      onTerminal.set(key, seen);
    }
  });
  for (const [conductor, volts] of supplies) {
    if (volts.size < 2) continue;
    issues.push({
      code: 'rail-mismatch',
      severity: 'error',
      message: `${conductor} joins supplies of different voltages: ${[...volts].map(([v, at]) => `${v} V at ${at}`).join(' and ')}`,
      where: conductor,
    });
  }
  for (const [key, { signals, terminalSignal }] of onTerminal) {
    if (signals.size < 2) continue;
    // both channels onto one mono pin is the vocabulary's own stand-in convention
    const standIns = [...signals].map((s) => vocabEntry<SignalEntry>(db.vocab, 'signals', s)?.standIn);
    if (terminalSignal !== undefined && standIns.every((s) => s === terminalSignal)) continue;
    issues.push({ code: 'signals-share-terminal', severity: 'warning', message: `${key} takes ${[...signals].join(' and ')}: two different signals joined on one terminal`, where: key });
  }
  return issues;
}
