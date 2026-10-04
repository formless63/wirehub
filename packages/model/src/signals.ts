/**
 * `signalOf()` — what a terminal carries, read from its vocab tags (data model
 * v2 §9 task 3).
 *
 * One reader for every consumer that asks "what is this pin / pad / core
 * for?": compat's joint rules and the new-cable wizard. Each reads the tags
 * first and falls back to reading the terminal's words against the
 * vocabulary (`signal-words.ts`) only for a terminal nobody has tagged yet (a
 * part just drawn in the Library, a fixture db with no tag table).
 *
 * Where a tag comes from, first match wins:
 *
 * - a connector pin: `ConnectorPin.signal`, then `Db.tags.connectors`;
 * - a board terminal: `PcbaTerminal.role` / `.signal`, then `Db.tags.pcbas`;
 *   a pin of a connector the board integrates (`j1.5`) is that pin;
 * - a wire conductor: its `lane` override, then `Db.tags.wires[..].lanes`,
 *   then the stock's colour code (`colourCode`, then the tag table) applied
 *   to its colour through the `colour-codes` list;
 * - a shield or a bare drain is a screen; a shield also names the lane of the
 *   core it wraps (the braid of a coax belongs with the signal its centre carries).
 *
 * `undefined` means untagged — never "carries nothing" (that is `nc`).
 * Pure: definitions in, tags out.
 */

import {
  findConnector,
  findPcba,
  findWire,
  pigtailIdOf,
  type Db,
  type Element,
  type GroupElement,
  type InstanceKind,
  type WireDefinition,
} from './model.ts';
import { isElectricalElement, resolveElementPath } from './paths.ts';
import { vocabEntry, type ColourCodeEntry, type SignalEntry, type SignalKind, type SignalRef } from './vocab.ts';

/** The vocab tags of one terminal. */
export interface TerminalTags {
  /** what it carries (vocab `signals`), for a pin or a pad */
  signal?: SignalRef;
  /** which pad it is for the cable (vocab `pad-roles`), for a board's cable pad */
  role?: string;
  /** the lane (vocab `lanes`) a conductor carries — or, for a shield, the lane of the core it wraps */
  lane?: string;
  /** a shield, a foil or a bare drain: at ground by construction */
  screen?: boolean;
}

/** The colour code a stock follows: its own, else the tag table's. */
export function colourCodeOf(db: Db, wire: WireDefinition): string | undefined {
  return wire.colourCode ?? db.tags?.wires?.[wire.id]?.colourCode;
}

function laneOfConductor(db: Db, wire: WireDefinition, path: string, element: Element): string | undefined {
  if (element.kind !== 'conductor') return undefined;
  const own = element.lane ?? db.tags?.wires?.[wire.id]?.lanes?.[path];
  if (own !== undefined) return own;
  const code = colourCodeOf(db, wire);
  if (code === undefined || element.color === undefined) return undefined;
  return vocabEntry<ColourCodeEntry>(db.vocab, 'colour-codes', code)?.lanes?.[element.color];
}

/** The core group a shield path sits in, and that core's conductor. */
function wrappedCore(wire: WireDefinition, path: string): { path: string; element: Element } | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  const parentPath = path.slice(0, dot);
  const parent = resolveElementPath(wire.structure, parentPath);
  if (parent?.kind !== 'group' || parent.role === 'cable' || parent.role === 'bundle') return undefined;
  const conductor = (parent as GroupElement).children.find((c) => c.kind === 'conductor');
  return conductor === undefined ? undefined : { path: `${parentPath}.${conductor.id}`, element: conductor };
}

function wireTags(db: Db, wire: WireDefinition, terminal: string): TerminalTags | undefined {
  if (pigtailIdOf(terminal) !== undefined) return { screen: true };
  const element = resolveElementPath(wire.structure, terminal);
  if (element === undefined || !isElectricalElement(element)) return undefined;
  if (element.kind === 'shield') {
    const core = wrappedCore(wire, terminal);
    const lane = core === undefined ? undefined : laneOfConductor(db, wire, core.path, core.element);
    return { screen: true, ...(lane === undefined ? {} : { lane }) };
  }
  if (element.bare === true) return { screen: true };
  const lane = laneOfConductor(db, wire, terminal, element);
  return lane === undefined ? undefined : { lane };
}

function pinTags(db: Db, connectorId: string, pinId: string): TerminalTags | undefined {
  const connector = findConnector(db, connectorId);
  const pin = connector?.pins.find((p) => p.id === pinId);
  if (pin === undefined) return undefined;
  const signal = pin.signal ?? db.tags?.connectors?.[connectorId]?.[pinId];
  return signal === undefined ? undefined : { signal };
}

/**
 * The vocab tags of terminal `terminal` of a `kind`/`def` definition, or
 * `undefined` when it is not tagged (or does not exist). Components carry no
 * signal tags: a lead is a lead.
 */
export function signalOf(db: Db, kind: InstanceKind, def: string, terminal: string): TerminalTags | undefined {
  switch (kind) {
    case 'connector':
      return pinTags(db, def, terminal);
    case 'segment': {
      const wire = findWire(db, def);
      return wire === undefined ? undefined : wireTags(db, wire, terminal);
    }
    case 'pcba': {
      const pcba = findPcba(db, def);
      if (pcba === undefined) return undefined;
      const own = pcba.terminals.find((t) => t.id === terminal);
      if (own !== undefined) {
        const table = db.tags?.pcbas?.[def]?.[terminal];
        const role = own.role ?? table?.role;
        const signal = own.signal ?? table?.signal;
        if (role === undefined && signal === undefined) return undefined;
        return { ...(role === undefined ? {} : { role }), ...(signal === undefined ? {} : { signal }) };
      }
      for (const integrated of pcba.integratedConnectors ?? []) {
        const prefix = `${integrated.terminalPrefix}.`;
        if (terminal.startsWith(prefix)) return pinTags(db, integrated.connectorDefId, terminal.slice(prefix.length));
      }
      return undefined;
    }
    case 'component':
      return undefined;
  }
}

/** The lane a pad role lands (vocab `pad-roles` `lane`), if it names one. */
export function laneOfPadRole(db: Db, role: string): string | undefined {
  return vocabEntry<{ id: string; label: string; src: string; lane?: string }>(db.vocab, 'pad-roles', role)?.lane;
}

/** A signal's `kind` from the list (`ground`, `power`, …), for ids no consumer has its own rule for. */
export function kindOfSignal(db: Db, id: string): SignalKind | undefined {
  return vocabEntry<SignalEntry>(db.vocab, 'signals', id)?.kind;
}
