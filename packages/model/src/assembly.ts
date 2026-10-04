/**
 * Assembly-level derivations: which end of the
 * cable an instance lives on, which terminals a design leaves unwired, and
 * which nets a design commons on purpose.
 *
 * Pure folds over the design and the definitions — no presentation. The
 * documents (BOM, test spec) and the schematic layout all ask the same
 * questions, so they are answered once, here.
 */

import { isFoilPath, screenTerminations } from './bonds.ts';
import { findWire, type CableDesign, type Db } from './model.ts';
import type { Net } from './nets.ts';
import { kindOfSignal, signalOf } from './signals.ts';
import { designInstances, terminalKey, terminalsOf, type ResolvedTerminal } from './validate.ts';

/** Where an instance sits: the source end (a), the destination end (b), both, or neither. */
export type AssemblySide = 'a' | 'b' | 'both' | 'unassigned';

/** One wire end an instance is soldered to. */
export interface WireEnd {
  segment: string;
  end: 'a' | 'b';
}

/**
 * The wire ends instance `instanceId` is jointed to directly, sorted by
 * segment then end. A segment has none of its own (it *is* the wire).
 */
export function wireEndsOf(design: CableDesign, instanceId: string): WireEnd[] {
  const segmentIds = new Set(design.instances.segments.map((s) => s.id));
  if (segmentIds.has(instanceId)) return [];
  const seen = new Set<string>();
  const out: WireEnd[] = [];
  for (const joint of design.joints) {
    for (const [near, far] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (near.instance !== instanceId) continue;
      if (!segmentIds.has(far.instance) || far.end === undefined) continue;
      const key = `${far.instance}@${far.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ segment: far.instance, end: far.end });
    }
  }
  return out.sort((x, y) => (x.segment === y.segment ? (x.end < y.end ? -1 : 1) : x.segment < y.segment ? -1 : 1));
}

/**
 * The end of the assembly every non-segment instance lives on.
 *
 * Seeded from the wire ends each instance is soldered to (`a` = console side
 * by house convention), then propagated through joints between non-wire
 * instances to a fixed point, so a connector soldered only to a PCBA inherits
 * that board's end. A design with no wire at all (the JagSat bridge) leaves
 * everything `unassigned`. Segments themselves are not in the map.
 */
export function assemblySides(design: CableDesign): Map<string, AssemblySide> {
  const sides = new Map<string, Set<'a' | 'b'>>();
  const note = (instance: string, end: 'a' | 'b'): boolean => {
    const bucket = sides.get(instance);
    if (bucket === undefined) {
      sides.set(instance, new Set([end]));
      return true;
    }
    if (bucket.has(end)) return false;
    bucket.add(end);
    return true;
  };
  const segmentIds = new Set(design.instances.segments.map((s) => s.id));
  for (const joint of design.joints) {
    for (const [near, far] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (!segmentIds.has(far.instance) || far.end === undefined) continue;
      if (segmentIds.has(near.instance)) continue;
      note(near.instance, far.end);
    }
  }
  for (let pass = 0; pass < design.joints.length + 1; pass += 1) {
    let changed = false;
    for (const joint of design.joints) {
      for (const [near, far] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (segmentIds.has(near.instance) || segmentIds.has(far.instance)) continue;
        for (const end of sides.get(far.instance) ?? []) {
          if (note(near.instance, end)) changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const out = new Map<string, AssemblySide>();
  for (const [instance, ends] of sides) {
    out.set(instance, ends.size > 1 ? 'both' : ends.has('a') ? 'a' : 'b');
  }
  return out;
}

/** `assemblySides(design).get(instanceId) ?? 'unassigned'`. */
export function assemblySideOf(design: CableDesign, instanceId: string): AssemblySide {
  return assemblySides(design).get(instanceId) ?? 'unassigned';
}

/**
 * The terminals a design leaves unwired: no joint names them, and (for a
 * screen) no landed pigtail or landed bonded mass terminates them at that
 * end. Pigtail terminals and foil screens (trimmed back, never indicated —
 * owner 2026-09-25) are never listed. Instance order, then terminal order as
 * `terminalsOf` gives it.
 */
export function unwiredTerminals(design: CableDesign, db: Db): ResolvedTerminal[] {
  const wired = new Set<string>();
  for (const joint of design.joints) {
    wired.add(terminalKey(joint.a));
    wired.add(terminalKey(joint.b));
  }
  for (const key of screenTerminations(design, db).keys()) wired.add(key);
  const out: ResolvedTerminal[] = [];
  for (const instance of designInstances(design)) {
    const stock = instance.kind === 'segment' ? findWire(db, instance.def) : undefined;
    for (const terminal of terminalsOf(design, db, instance.id)) {
      if (terminal.pigtail !== undefined) continue;
      if (stock !== undefined && isFoilPath(stock, terminal.terminal)) continue;
      if (wired.has(terminal.key)) continue;
      out.push(terminal);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Deliberate commoning
 * ------------------------------------------------------------------ */

/**
 * A recorded fact that a net carries one signal to several channels on
 * purpose — a board's LA and RA pads are one /LEFT trace, a source device
 * has one audio pin for both SCART audio inputs. Read from data that already
 * exists: terminal tags (`audio-mono`) and the recipe's source device
 * (`Device.audio: 'mono'`).
 */
export interface CommoningFact {
  /** the signal kind the fact speaks for */
  kind: 'audio';
  /** printable citation: `u1 LA tagged audio-mono (PCA-00102-rev2)` */
  source: string;
}

function isMonoSignal(db: Db, id: string): boolean {
  return id === 'audio-mono' || (id.endsWith('-mono') && kindOfSignal(db, id) === 'audio');
}

/**
 * The facts saying `net` is commoned by design. Empty when none is recorded —
 * then a net carrying two channels of one kind is, as far as the data knows,
 * a short. Only terminal tags are read.
 */
export function commoningFacts(
  design: CableDesign,
  db: Db,
  net: Net,
): CommoningFact[] {
  const out: CommoningFact[] = [];
  // one fact per instance and tag: `u1 j.LA, LA, RA tagged audio-mono (PCA-00102-rev2)`
  const tagged = new Map<string, { instance: string; def: string; signal: string; terminals: string[] }>();
  for (const terminal of net.terminals) {
    const signal = signalOf(db, terminal.instanceKind, terminal.def, terminal.terminal)?.signal;
    // only a settled tag counts: `oneOf` a mono option is a pin the device decides, not a fact
    if (typeof signal !== 'string' || !isMonoSignal(db, signal)) continue;
    const key = `${terminal.instance}|${signal}`;
    const entry = tagged.get(key);
    if (entry === undefined) {
      tagged.set(key, { instance: terminal.instance, def: terminal.def, signal, terminals: [terminal.terminal] });
    } else if (!entry.terminals.includes(terminal.terminal)) entry.terminals.push(terminal.terminal);
  }
  for (const entry of tagged.values()) {
    out.push({ kind: 'audio', source: `${entry.instance} ${entry.terminals.join(', ')} tagged ${entry.signal} (${entry.def})` });
  }
  return out;
}
