/**
 * Connector bodies and interfaces (data model v2 §1, §9 task 5,
 *).
 *
 * What was one record is now three facts:
 *
 * - a **body** is the physical connector: shell, positions, gender, family.
 *   It has no signal meaning. The DIN-8 270° plug is one body whether it is
 *   wired for one device's port or another's.
 * - an **interface** is a named pinout: a signal (vocab `signals`) per body
 *   position. EuroSCART and JP21 are two interfaces on one 21-pin body.
 * - the **connector** a design references (`din8-270-aes`, `scart-male`) stays
 *   as it is (owner question Q2, recommendation (a)): a body + interface pair
 *   plus its orderable identity. Its `pins` are **composed at load**, so every
 *   design and renderer sees exactly the pins it saw before the split.
 *
 * The seam for devices (task 11): an interface pin whose meaning the device
 * decides is `{ oneOf }` (a multi-out pin that carries composite sync on one
 * device and +12 V on another). A device port binds the interface and overrides pins per
 * device; `composePins` takes those overrides, so a device's view of its port
 * is the same composition with its bindings laid over the interface.
 *
 * Pure: records in, records out. Nothing here reads a file.
 */

import type { ConnectorDefinition, ConnectorGender, ConnectorPin, Db, Issue } from './model.ts';
import { signalIds, vocabEntry, type SignalEntry, type SignalRef, type Vocab } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** How sure the catalog is of a pin's function (data model v2 §1.2). */
export type Confidence = 'net-verified' | 'documented' | 'inferred' | 'unknown';

/** One physical position of a body: a contact, the shell, a key. */
export interface BodyPosition {
  id: string;
  kind?: 'pin' | 'shell' | 'key';
  note?: string;
}

/** A physical connector: shell, positions, gender. No signal meaning. */
export interface ConnectorBody {
  /** `din8-270-male`, `scart-21-male`, `de9-male` */
  id: string;
  label: string;
  /** vocab `families` id */
  family: string;
  /** vocab `genders` id — open, like `ConnectorGender` */
  gender: ConnectorGender;
  /** in the order a connector built on this body lists its pins */
  positions: BodyPosition[];
  /** the opposite-gender body this one mates with, when the catalog has it */
  mates?: string;
  partNumber?: string;
  /**
   * How the body is terminated — a vocab `connector-constructions` id
   * (`solder-cup`, `pcb-mount-th`, …;). The body is the
   * physical part, so this is a body fact; a connector may repeat it.
   */
  construction?: string;
  /**
   * Which of the builder's built-in drawings this body is (`din-270`,
   * `mini-din`, `d-sub`, `rca` …). The drawing belongs to the body, so
   * every interface on it draws the same; absent, the builder infers it from
   * the family, id and label (every body before).
   */
  drawing?: string;
  src: string;
}

/** What one body position carries under an interface. */
export interface PinFunction {
  /** a vocab signal, or `{ oneOf }` when the device decides */
  signal: SignalRef;
  /** as seen from the device that owns the port */
  dir?: 'out' | 'in' | 'bidir' | 'passive';
  /** display label; the signal's vocab label when absent */
  label?: string;
  aliases?: string[];
  note?: string;
  confidence?: Confidence;
  src?: string;
}

/** A named assignment of signals to a body's positions. */
export interface Interface {
  /** `rs232-dte`, `euroscart`, `jp21` */
  id: string;
  label: string;
  /** compact display name of the end it makes ('SCART', 'Mini-DIN 10'), for the cable list; `label` in the tooltip */
  short?: string;
  /** every body it is found on (a male plug and its female socket share one) */
  bodies: string[];
  /** keyed by body position id */
  pins: Record<string, PinFunction>;
  /** alternative pin maps selected by a strap or detect line (the source device 8–10 short → YPbPr) */
  modes?: { id: string; label: string; selectedBy: string; pins: Record<string, PinFunction> }[];
  /** how sure the whole pinout is — `unknown` for a table nobody has yet (the device) */
  confidence?: Confidence;
  note?: string;
  src: string;
}

/**
 * A connector as `connectors.json` stores it: the identity fields plus
 * `body` + `interface`. `pins` is only present on a connector that has no
 * body/interface pair (a hand-drawn one) or that overrides the composition.
 */
export type ConnectorRecord = Omit<ConnectorDefinition, 'pins'> & { pins?: ConnectorPin[] };

/** What composition needs from the library. */
export interface InterfaceLibrary {
  bodies: readonly ConnectorBody[];
  interfaces: readonly Interface[];
  vocab?: Vocab;
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

export function findBody(db: Pick<Db, 'bodies'>, id: string): ConnectorBody | undefined {
  return (db.bodies ?? []).find((b) => b.id === id);
}

export function findInterface(db: Pick<Db, 'interfaces'>, id: string): Interface | undefined {
  return (db.interfaces ?? []).find((i) => i.id === id);
}

/** Every connector built on body `bodyId` (the DIN-8 270° body carries several pinouts). */
export function connectorsOnBody(db: Db, bodyId: string): ConnectorDefinition[] {
  return db.connectors.filter((c) => c.body === bodyId);
}

/** Every interface found on body `bodyId`, in library order. */
export function interfacesOnBody(db: Pick<Db, 'interfaces'>, bodyId: string): Interface[] {
  return (db.interfaces ?? []).filter((i) => i.bodies.includes(bodyId));
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

function labelOf(fn: PinFunction, vocab: Vocab | undefined): string {
  if (fn.label !== undefined) return fn.label;
  const first = signalIds(fn.signal)[0] ?? '';
  return (vocab === undefined ? undefined : vocabEntry<SignalEntry>(vocab, 'signals', first)?.label) ?? first;
}

/**
 * The pins of `iface` on `body`: body positions in body order, each one the
 * interface assigns (a position it leaves out is not a pin of this
 * connector). `overrides` lays per-position functions over the interface —
 * the device binding seam (task 11): a device that leaves a pin unconnected
 * re-tags it `nc`, it does not remove the position.
 */
export function composePins(
  body: ConnectorBody,
  iface: Interface,
  vocab?: Vocab,
  overrides: Readonly<Record<string, Partial<PinFunction>>> = {},
): ConnectorPin[] {
  const pins: ConnectorPin[] = [];
  for (const position of body.positions) {
    const base = iface.pins[position.id];
    if (base === undefined) continue;
    const fn: PinFunction = { ...base, ...overrides[position.id] };
    pins.push({
      id: position.id,
      label: labelOf(fn, vocab),
      ...(fn.aliases === undefined ? {} : { aliases: [...fn.aliases] }),
      ...(fn.note === undefined ? {} : { note: fn.note }),
      signal: typeof fn.signal === 'string' ? fn.signal : { oneOf: [...fn.signal.oneOf] },
    });
  }
  return pins;
}

/**
 * One stored connector as every consumer sees it. A record that carries its
 * own `pins` keeps them (a hand-drawn connector, or one whose pins were
 * edited away from its interface — `validateDb` reports the latter); a
 * record with an unresolvable body or interface composes to no pins, and
 * `validateDb` says why.
 */
export function composeConnector(record: ConnectorRecord, library: InterfaceLibrary): ConnectorDefinition {
  const { pins: own, src, ...head } = record;
  let pins = own;
  if (pins === undefined) {
    const body = library.bodies.find((b) => b.id === record.body);
    const iface = library.interfaces.find((i) => i.id === record.interface);
    pins = body === undefined || iface === undefined ? [] : composePins(body, iface, library.vocab);
  }
  const { body, interface: iface, ...identity } = head;
  return {
    ...identity,
    pins: pins.map((p) => ({ ...p })),
    src,
    ...(body === undefined ? {} : { body }),
    ...(iface === undefined ? {} : { interface: iface }),
  };
}

/**
 * How a connector is terminated: its own `construction`, else its body's
 *. `undefined` when neither says.
 */
export function connectorConstruction(
  connector: Pick<ConnectorDefinition, 'construction' | 'body'>,
  bodies: readonly ConnectorBody[] | undefined,
): string | undefined {
  if (connector.construction !== undefined) return connector.construction;
  return (bodies ?? []).find((b) => b.id === connector.body)?.construction;
}

/** Every stored connector, composed — what `Db.connectors` holds. */
export function composeConnectors(records: readonly ConnectorRecord[], library: InterfaceLibrary): ConnectorDefinition[] {
  return records.map((r) => composeConnector(r, library));
}

function samePins(a: readonly ConnectorPin[], b: readonly ConnectorPin[], lenientSignal: boolean): boolean {
  if (a.length !== b.length) return false;
  return a.every((pin, i) => {
    const other = b[i];
    if (other === undefined) return false;
    const { signal: sa, ...ra } = pin;
    const { signal: sb, ...rb } = other;
    if (JSON.stringify(canonical(ra)) !== JSON.stringify(canonical(rb))) return false;
    // an editor that does not know the field may drop it: that is not an edit
    if (sa === undefined && lenientSignal) return true;
    return JSON.stringify(sa) === JSON.stringify(sb);
  });
}

function canonical(pin: Omit<ConnectorPin, 'signal'>): unknown {
  return {
    id: pin.id,
    label: pin.label,
    aliases: pin.aliases,
    note: pin.note,
  };
}

/**
 * The inverse of `composeConnector`, for a writer (the studio's definition
 * store): a connector whose pins are exactly its body + interface
 * composition is stored without them; anything else keeps its pins, so an
 * edit is never lost. A pin with no `signal` matches the composed pin's
 * signal — a form that drops unknown fields has not changed the pinout.
 */
export function decomposeConnector(def: ConnectorDefinition, library: InterfaceLibrary): ConnectorRecord {
  const { pins, ...rest } = def;
  if (def.body === undefined || def.interface === undefined) return def;
  const body = library.bodies.find((b) => b.id === def.body);
  const iface = library.interfaces.find((i) => i.id === def.interface);
  if (body === undefined || iface === undefined) return def;
  if (!samePins(pins, composePins(body, iface, library.vocab), true)) return def;
  const { src, body: b, interface: i, ...identity } = rest;
  return { ...identity, body: b, interface: i, src };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function issue(code: string, message: string, where: string, severity: Issue['severity'] = 'error'): Issue {
  return { code, severity, message, where };
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
}

/**
 * Everything wrong between connectors, bodies and interfaces:
 *
 * - `duplicate-id`, `missing-src` for the new records;
 * - `connector-body-unknown` / `connector-interface-unknown`: a reference that
 *   goes nowhere; `connector-interface-body`: the interface is not found on
 *   the connector's body; `connector-gender-mismatch`: the connector says one
 *   gender, its body the other;
 * - `interface-body-unknown`, `interface-position-unknown`: an interface that
 *   assigns a position none of its bodies has;
 * - `body-mates`: a mate that is unknown or the same gender (error), or one
 *   that does not mate back (warning — a pair is written one side at a time;
 *   the DIN-8 262°/270° hazard is a body fact: they never mate);
 * - `connector-construction-mismatch` (warning): the connector says one
 *   construction, its body another;
 * - `connector-pins-diverge` (warning): a connector that carries its own pins
 *   although it names a body + interface whose composition differs;
 * - `connector-part-number-mismatch` (warning): the connector and its body
 *   name different plug part numbers.
 *
 * Signals are checked by the vocab validator on the composed pins, and here
 * for interfaces no connector uses yet (the device).
 */
export function validateInterfaces(db: Db): Issue[] {
  // a db that does not carry the body/interface library (a fixture, a host
  // that only loads connectors) has nothing to check the references against
  if (db.bodies === undefined && db.interfaces === undefined) return [];
  const bodies = db.bodies ?? [];
  const interfaces = db.interfaces ?? [];
  const issues: Issue[] = [];
  for (const id of duplicates(bodies.map((b) => b.id))) issues.push(issue('duplicate-id', `duplicate body id '${id}'`, `bodies/${id}`));
  for (const id of duplicates(interfaces.map((i) => i.id))) issues.push(issue('duplicate-id', `duplicate interface id '${id}'`, `interfaces/${id}`));
  const bodyById = new Map(bodies.map((b) => [b.id, b]));

  for (const body of bodies) {
    const where = `bodies/${body.id}`;
    if (!body.src) issues.push(issue('missing-src', `record '${where}' has no src citation`, where, 'warning'));
    for (const id of duplicates(body.positions.map((p) => p.id))) {
      issues.push(issue('duplicate-terminal-id', `body '${body.id}' has duplicate position '${id}'`, where));
    }
    if (body.mates !== undefined) {
      const mate = bodyById.get(body.mates);
      if (mate === undefined) issues.push(issue('body-mates', `body '${body.id}' mates with unknown body '${body.mates}'`, where));
      else if (mate.gender === body.gender) issues.push(issue('body-mates', `body '${body.id}' mates with '${mate.id}', which is also ${body.gender}`, where));
      // one-sided is a warning, not an error: a pair is written one body at a
      // time, and no single write can make both sides agree (
      // writes the second side straight after the first)
      else if (mate.mates !== body.id) issues.push(issue('body-mates', `body '${mate.id}' does not name '${body.id}' as its mate`, where, 'warning'));
    }
  }

  for (const iface of interfaces) {
    const where = `interfaces/${iface.id}`;
    if (!iface.src) issues.push(issue('missing-src', `record '${where}' has no src citation`, where, 'warning'));
    const known = iface.bodies.map((id) => bodyById.get(id));
    iface.bodies.forEach((id, n) => {
      if (known[n] === undefined) issues.push(issue('interface-body-unknown', `interface '${iface.id}' names unknown body '${id}'`, where));
    });
    const positions = new Set(known.flatMap((b) => (b === undefined ? [] : b.positions.map((p) => p.id))));
    const maps = [iface.pins, ...(iface.modes ?? []).map((m) => m.pins)];
    for (const map of maps) {
      for (const [position, fn] of Object.entries(map)) {
        if (known.some((b) => b !== undefined) && !positions.has(position)) {
          issues.push(issue('interface-position-unknown', `interface '${iface.id}' assigns position '${position}', which none of its bodies has`, `${where}/${position}`));
        }
        if (typeof fn.signal !== 'string' && (!Array.isArray(fn.signal.oneOf) || fn.signal.oneOf.length === 0)) {
          issues.push(issue('vocab-unknown', 'a { oneOf } signal needs at least one signal', `${where}/${position}`));
        } else if (db.vocab?.['signals'] !== undefined) {
          for (const id of signalIds(fn.signal)) {
            if (vocabEntry(db.vocab, 'signals', id, { includePending: true }) === undefined) {
              issues.push(issue('vocab-unknown', `'${id}' is not in the 'signals' list`, `${where}/${position}`));
            }
          }
        }
      }
    }
  }

  const library: InterfaceLibrary = { bodies, interfaces, ...(db.vocab === undefined ? {} : { vocab: db.vocab }) };
  for (const connector of db.connectors) {
    const where = `connectors/${connector.id}`;
    if (connector.body === undefined && connector.interface === undefined) continue;
    const body = connector.body === undefined ? undefined : bodyById.get(connector.body);
    const iface = connector.interface === undefined ? undefined : interfaces.find((i) => i.id === connector.interface);
    if (connector.body === undefined || body === undefined) {
      issues.push(issue('connector-body-unknown', `connector '${connector.id}' names body '${connector.body ?? '(none)'}', which the library does not have`, where));
    }
    if (connector.interface === undefined || iface === undefined) {
      issues.push(issue('connector-interface-unknown', `connector '${connector.id}' names interface '${connector.interface ?? '(none)'}', which the library does not have`, where));
    }
    if (body === undefined || iface === undefined) continue;
    if (!iface.bodies.includes(body.id)) {
      issues.push(issue('connector-interface-body', `interface '${iface.id}' is not found on body '${body.id}'`, where));
    }
    if (connector.gender !== undefined && connector.gender !== body.gender) {
      issues.push(issue('connector-gender-mismatch', `connector '${connector.id}' is ${connector.gender}, its body '${body.id}' is ${body.gender}`, where));
    }
    if (connector.partNumber !== undefined && body.partNumber !== undefined && connector.partNumber !== body.partNumber) {
      issues.push(issue('connector-part-number-mismatch', `connector '${connector.id}' is part ${connector.partNumber}, its body '${body.id}' is ${body.partNumber}`, where, 'warning'));
    }
    if (connector.construction !== undefined && body.construction !== undefined && connector.construction !== body.construction) {
      issues.push(issue('connector-construction-mismatch', `connector '${connector.id}' is ${connector.construction}, its body '${body.id}' is ${body.construction}`, where, 'warning'));
    }
    if (!samePins(connector.pins, composePins(body, iface, library.vocab), false)) {
      issues.push(issue('connector-pins-diverge', `connector '${connector.id}' carries pins that differ from ${iface.id} on ${body.id}`, where, 'warning'));
    }
  }
  return issues;
}
