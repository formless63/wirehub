/**
 * The Library's logic, with no React in it.
 *
 * Everything the definition editors do to a record happens here: turning a
 * stored definition into the rows and boxes a form shows, turning those back
 * into a definition, and saying what is wrong with a half-finished one. The
 * components in `panels/` hold state and paint; they decide nothing.
 *
 * Two shapes of the same fact, and why:
 *
 * - **A draft is all strings.** A diameter half-typed is `"1."`, which is not a
 *   number and must not be one — turning it into `NaN` mid-keystroke is how
 *   forms eat what people type. Text is the state; numbers happen at the
 *   boundary, once.
 * - **The mapping is a round trip, and the tests hold it to that.**
 *   `wireDefinitionOf(wireFormOf(stock))` gives back the stock, field for
 *   field, for every stock in the catalog. That is the whole guarantee behind
 *   showing a structured form instead of the JSON: the form is not a lossy
 *   view of the record, it *is* the record.
 *
 * **The wire form's deliberate limit.** A `WireDefinition`'s structure is an
 * arbitrary tree, and this form is not. It edits the shape the catalog actually
 * uses and the cross-section renderer actually draws: a cable of cores — coax
 * (conductor · dielectric · shield · sheath), shielded (conductor · insulation
 * · shield) or plain (an insulated conductor) — optionally wrapped in an
 * overall shield, a drain wire and a jacket. Anything deeper or differently
 * nested is left alone: `wireFormOf` answers `undefined`, and the UI says so
 * and points at the JSON. Constraining the *editor* rather than the *model* is
 * the right trade — the model has to describe every cable that exists, the form
 * only has to describe the ones people type in.
 */

import {
  LAY_ARRANGEMENT_RING_COUNT,
  validateDb,
  viaText,
  errors,
  type ComponentDefinition,
  type ComponentTerminal,
  type ConductorElement,
  type ConnectorDefinition,
  type ConnectorPin,
  type Db,
  type Element,
  type GroupElement,
  type InsulationElement,
  type Issue,
  type PcbaDefinition,
  type PcbaInternalLink,
  type PcbaLinkElement,
  type PcbaTerminal,
  type ShieldElement,
  type SignalRef,
  type WireDefinition,
  type WireLayOrder,
  type PartCost,
  type WireBondedSet,
  type WireProfile,
  type WireVendorDoc,
  type PcbaPad,
  type PcbaTerminalTags,
  type SignalTags,
  type ConnectorBody,
  type Interface,
  type KitDefinition,
  type KitLine,
  type KitPartKind,
  type MechanicalDefinition,
  type ConnectorGender,
} from '@wirehub/model';

import { DEFINITION_NOUNS, type DefinitionKind, type DefinitionRecord, type LibraryKind } from './definitions.ts';
import { signalRefOf, signalText, type RecordTags } from './vocab.ts';
import { suggestDesignId } from './persistence.ts';

/**
 * A new definition's id follows its name, the way the
 * design dialogs do: while the id is blank or still the suggestion for the
 * previous name, a name edit re-suggests it (`suggestDesignId`, unique across
 * `taken` — the whole library, since ids are unique across it). The moment
 * the user types an id of their own it stops following.
 */
export function followNameId<T extends { id: string; label: string }>(prev: T, next: T, taken: Iterable<string>): T {
  if (next.label === prev.label || next.id !== prev.id) return next;
  const used = [...taken];
  if (prev.id !== '' && prev.id !== suggestDesignId(prev.label, used)) return next;
  return { ...next, id: suggestDesignId(next.label, used) };
}

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

/** One row of the library list: what a person scans for. */
export interface DefinitionSummary {
  kind: DefinitionKind;
  id: string;
  label: string;
  /** the one-line fact that tells two records of the same kind apart */
  detail: string;
  src: string;
  /** generated boards are shown, but not editable */
  readOnly?: boolean;
  /** a board's production status when it is not active (legacy / retired revisions — hidden unless asked for) */
  status?: 'development' | 'legacy' | 'retired';
}

/** Legacy and retired board revisions: kept for reference, hidden unless the list is asked for them. */
export function isOldRevision(summary: Pick<DefinitionSummary, 'status'>): boolean {
  return summary.status === 'legacy' || summary.status === 'retired';
}

export function definitionSummary(
  kind: DefinitionKind,
  record: DefinitionRecord,
  readOnly = false,
): DefinitionSummary {
  const status = kind === 'pcbas' ? (record as PcbaDefinition).status : undefined;
  return {
    kind,
    id: record.id,
    label: record.label,
    detail: definitionDetail(kind, record),
    src: record.src,
    ...(readOnly ? { readOnly: true } : {}),
    ...(status === undefined || status === 'active' ? {} : { status }),
  };
}

/** The human summary of what one record holds — pins, value, structure. */
export function definitionDetail(kind: DefinitionKind, record: DefinitionRecord): string {
  switch (kind) {
    case 'connectors': {
      const connector = record as ConnectorDefinition;
      return [
        connector.family,
        connector.gender,
        `${connector.pins.length} pin${connector.pins.length === 1 ? '' : 's'}`,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
    }
    case 'components': {
      const component = record as ComponentDefinition;
      return [
        component.kind,
        component.value,
        component.partNumber,
        `${component.terminals.length} terminal${component.terminals.length === 1 ? '' : 's'}`,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
    }
    case 'wires': {
      const wire = record as WireDefinition;
      const cores = wire.structure.children.filter(
        (child) => child.kind === 'group' || (child.kind === 'conductor' && child.bare !== true),
      ).length;
      // never the manufacturer here — it stays inside
      // the wire's own detail view (`WireStockDetail.tsx`), not this list line
      return [
        wire.partNumber,
        `${cores} core${cores === 1 ? '' : 's'}`,
        wire.profile !== undefined
          ? `${wire.profile.widthMm} × ${wire.profile.heightMm} mm figure-8`
          : wire.odMm === undefined
            ? undefined
            : `Ø ${wire.odMm} mm`,
        wire.layOrder === undefined ? undefined : `lay ${wire.layOrder.direction.toUpperCase()}`,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
    }
    case 'pcbas': {
      const pcba = record as PcbaDefinition;
      return [
        pcba.partNumber,
        pcba.revision,
        pcba.build,
        `${pcba.terminals.length} pad${pcba.terminals.length === 1 ? '' : 's'}`,
        `${pcba.internalLinks.length} link${pcba.internalLinks.length === 1 ? '' : 's'}`,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
    }
    case 'bodies': {
      const body = record as ConnectorBody;
      return [body.family, body.gender, `${body.positions.length} positions`, body.partNumber]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
    }
    case 'interfaces': {
      const iface = record as Interface;
      const count = Object.keys(iface.pins).length;
      return [`${count} pin${count === 1 ? '' : 's'}`, iface.bodies.join(', ')].join(' · ');
    }
    case 'mechanicals': {
      const part = record as MechanicalDefinition;
      return [part.kind, part.partNumber, part.revision].filter((bit) => bit !== undefined && bit !== '').join(' · ');
    }
    case 'kits': {
      const kit = record as KitDefinition;
      const count = kit.contents.length;
      return [kit.sku, `${count} part${count === 1 ? '' : 's'}`].join(' · ');
    }
  }
}

/** Every list is searchable (spec, "Non-technical UX rules"). */
export function matchesDefinition(summary: DefinitionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return `${summary.id} ${summary.label} ${summary.detail} ${summary.src}`
    .toLowerCase()
    .includes(needle);
}

/* ------------------------------------------------------------------ *
 * Rows — the shared list-builder
 * ------------------------------------------------------------------ */

export type RowAction<T> =
  | { type: 'add'; row?: T }
  | { type: 'remove'; index: number }
  /** `by` is -1 for up, +1 for down; a move off either end does nothing */
  | { type: 'move'; index: number; by: number }
  | { type: 'update'; index: number; patch: Partial<T> }
  | { type: 'set'; rows: T[] };

/**
 * The add/remove/reorder/edit reducer every row list in the Library shares —
 * connector pins, component terminals, board pads, internal links.
 *
 * It is a reducer and not four handlers because a row list is exactly the place
 * a form goes wrong: a splice that forgets to copy, a move that runs off the
 * end, an index captured in a closure. One implementation, tested once.
 */
export function rowsReducer<T>(blank: () => T) {
  return function reduce(rows: T[], action: RowAction<T>): T[] {
    switch (action.type) {
      case 'add':
        return [...rows, action.row ?? blank()];
      case 'remove':
        return rows.filter((_, index) => index !== action.index);
      case 'move': {
        const to = action.index + action.by;
        if (action.index < 0 || action.index >= rows.length || to < 0 || to >= rows.length) {
          return rows;
        }
        const next = [...rows];
        const [moved] = next.splice(action.index, 1);
        next.splice(to, 0, moved as T);
        return next;
      }
      case 'update':
        return rows.map((row, index) =>
          index === action.index ? { ...row, ...action.patch } : row,
        );
      case 'set':
        return action.rows;
    }
  };
}

/** Ids typed more than once, trimmed — what "this pin already exists" reads off. */
export function duplicateRowIds(rows: { id: string }[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const row of rows) {
    const id = row.id.trim();
    if (id === '') continue;
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

/* ------------------------------------------------------------------ *
 * Text ↔ values
 * ------------------------------------------------------------------ */

/** Blank means "not stated"; anything else has to be a real number. */
export function isNumberField(text: string): boolean {
  return text.trim() === '' || Number.isFinite(Number(text.trim()));
}

/** The number a field holds, or `undefined` for blank *and* for nonsense. */
export function numberOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** A millimetre value as a field holds it — `1.4`, never `1.4 mm`. */
export function mmField(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function text(value: string | undefined): string {
  return value ?? '';
}

/**
 * The fields of `record` a form does not show, kept as read so a save gives
 * them back. A record grows fields faster than its form does (data model v2
 * adds `signal`, `role`, `body`, `interface` …); a form that rebuilt the
 * record field by field would silently drop every one it had not heard of.
 */
function extrasOf(record: object, known: readonly string[]): Record<string, unknown> | undefined {
  const rest = Object.entries(record).filter(([key]) => !known.includes(key));
  return rest.length === 0 ? undefined : structuredClone(Object.fromEntries(rest));
}

/** Drop the keys whose fields were left blank, so a record has no empty strings. */
function some<T extends object>(entries: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''),
  ) as Partial<T>;
}

/**
 * The colours the cross-section and the schematic know how to paint. Offered as
 * suggestions, never enforced — a stock printed in a colour this list has never
 * heard of is still a fact, and it draws in neutral grey.
 */
export const KNOWN_COLORS = [
  'red',
  'green',
  'blue',
  'yellow',
  'white',
  'black',
  'brown',
  'orange',
  'violet',
  'grey',
  'pink',
] as const;

/* ------------------------------------------------------------------ *
 * Connectors
 * ------------------------------------------------------------------ */

export interface PinRow {
  id: string;
  label: string;
  /** the other names this pin goes by, comma separated in the form */
  aliases: string;
  note: string;
  /**
   * What the pin carries — a vocab `signals` id, or `a|b` for "one of" (the
   * `signalText` codec). Blank is untagged. Under data model v2 §1.2 it comes
   * from the connector's interface (composed pins); an edit is saved with the
   * connector, whose store keeps an edited pinout as the connector's own pins.
   */
  signal: string;
  /** fields of the pin the form does not show, kept as read */
  extra?: Record<string, unknown>;
}

export function blankPinRow(): PinRow {
  return { id: '', label: '', aliases: '', note: '', signal: '' };
}

export const pinRowsReducer = rowsReducer<PinRow>(blankPinRow);

export interface ConnectorDraft {
  id: string;
  label: string;
  family: string;
  gender: '' | ConnectorGender;
  /** the bare plug/socket as a stock item; blank where there is nothing to buy */
  partNumber: string;
  src: string;
  pins: PinRow[];
  /** the body + interface pair the pins compose from (data model v2 §1.2); carried, not yet edited */
  body: string;
  interface: string;
  /** fields of the record the form does not show, kept as read */
  extra?: Record<string, unknown>;
}

const CONNECTOR_FIELDS = ['id', 'label', 'family', 'gender', 'partNumber', 'src', 'pins', 'body', 'interface'] as const;
const PIN_FIELDS = ['id', 'label', 'aliases', 'note', 'signal'] as const;

/**
 * A connector as a draft. `tags` is the side table (`Db.tags`): a pin with no
 * signal of its own shows the table's, so the form edits what the rest of the
 * studio reads.
 */
export function connectorDraftOf(connector: ConnectorDefinition, tags?: SignalTags): ConnectorDraft {
  const table = tags?.connectors?.[connector.id] ?? {};
  const extra = extrasOf(connector, CONNECTOR_FIELDS);
  return {
    id: connector.id,
    label: connector.label,
    family: connector.family,
    gender: connector.gender ?? '',
    partNumber: text(connector.partNumber),
    src: connector.src,
    pins: connector.pins.map((pin) => {
      const pinExtra = extrasOf(pin, PIN_FIELDS);
      return {
        id: pin.id,
        label: pin.label,
        aliases: (pin.aliases ?? []).join(', '),
        note: text(pin.note),
        // composed pins carry their interface's signal; the tag table is
        // only a fallback for a connector with neither
        signal: signalText(pin.signal ?? table[pin.id]),
        ...(pinExtra === undefined ? {} : { extra: pinExtra }),
      };
    }),
    body: text(connector.body),
    interface: text(connector.interface),
    ...(extra === undefined ? {} : { extra }),
  };
}

export function blankConnectorDraft(): ConnectorDraft {
  return {
    id: '',
    label: '',
    family: '',
    gender: '',
    partNumber: '',
    src: '',
    pins: [blankPinRow()],
    body: '',
    interface: '',
  };
}

export function connectorOf(draft: ConnectorDraft): ConnectorDefinition {
  const pins: ConnectorPin[] = draft.pins
    .filter((pin) => pin.id.trim() !== '')
    .map((pin) => {
      const aliases = pin.aliases
        .split(',')
        .map((alias) => alias.trim())
        .filter((alias) => alias !== '');
      const signal = signalRefOf(pin.signal);
      return {
        id: pin.id.trim(),
        label: pin.label.trim(),
        ...(aliases.length === 0 ? {} : { aliases }),
        ...some({ note: pin.note.trim() }),
        ...(signal === undefined ? {} : { signal }),
        ...(pin.extra ?? {}),
      };
    });
  // key order follows the committed files, so an edit diffs as one field
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    family: draft.family.trim(),
    ...(draft.gender === '' ? {} : { gender: draft.gender }),
    ...some({ partNumber: draft.partNumber.trim() }),
    src: draft.src.trim(),
    pins,
    ...some({ body: draft.body.trim(), interface: draft.interface.trim() }),
    ...(draft.extra ?? {}),
  };
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

export const COMPONENT_KINDS = ['resistor', 'capacitor', 'ic', 'switch', 'other'] as const;

export interface TerminalRow {
  id: string;
  label: string;
  polarity: '' | '+' | '-';
  /** fields of the terminal the form does not show, kept as read */
  extra?: Record<string, unknown>;
}

export function blankTerminalRow(): TerminalRow {
  return { id: '', label: '', polarity: '' };
}

export const terminalRowsReducer = rowsReducer<TerminalRow>(blankTerminalRow);

export interface ComponentDraft {
  id: string;
  label: string;
  kind: ComponentDefinition['kind'];
  value: string;
  partNumber: string;
  src: string;
  terminals: TerminalRow[];
  /** fields of the record the form does not show, kept as read */
  extra?: Record<string, unknown>;
}

const COMPONENT_FIELDS = ['id', 'label', 'kind', 'value', 'partNumber', 'terminals', 'src'] as const;
const TERMINAL_FIELDS = ['id', 'label', 'polarity'] as const;

export function componentDraftOf(component: ComponentDefinition): ComponentDraft {
  const extra = extrasOf(component, COMPONENT_FIELDS);
  return {
    id: component.id,
    label: component.label,
    kind: component.kind,
    value: text(component.value),
    partNumber: text(component.partNumber),
    src: component.src,
    terminals: component.terminals.map((terminal) => {
      const terminalExtra = extrasOf(terminal, TERMINAL_FIELDS);
      return {
        id: terminal.id,
        label: text(terminal.label),
        polarity: terminal.polarity ?? '',
        ...(terminalExtra === undefined ? {} : { extra: terminalExtra }),
      };
    }),
    ...(extra === undefined ? {} : { extra }),
  };
}

export function blankComponentDraft(): ComponentDraft {
  return {
    id: '',
    label: '',
    kind: 'resistor',
    value: '',
    partNumber: '',
    src: '',
    terminals: [
      { id: 'a', label: '', polarity: '' },
      { id: 'b', label: '', polarity: '' },
    ],
  };
}

export function componentOf(draft: ComponentDraft): ComponentDefinition {
  const terminals: ComponentTerminal[] = draft.terminals
    .filter((terminal) => terminal.id.trim() !== '')
    .map((terminal) => ({
      id: terminal.id.trim(),
      ...some({ label: terminal.label.trim() }),
      ...(terminal.polarity === '' ? {} : { polarity: terminal.polarity }),
      ...(terminal.extra ?? {}),
    }));
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    kind: draft.kind,
    ...some({ value: draft.value.trim(), partNumber: draft.partNumber.trim() }),
    terminals,
    src: draft.src.trim(),
    ...(draft.extra ?? {}),
  };
}

/* ------------------------------------------------------------------ *
 * Wire stocks
 * ------------------------------------------------------------------ */

export type CoreKind = 'coax' | 'shielded-core' | 'plain';

export interface ConductorDraft {
  id: string;
  label: string;
  color: string;
  material: string;
  formation: string;
  areaMm2: string;
  odMm: string;
  /** diameter over this conductor's own insulation, for cores with no separate layer */
  insulatedOdMm: string;
  bare: boolean;
  src: string;
  /** the lane override (vocab `lanes`), kept as read — no form control yet */
  lane?: string;
}

export interface InsulationDraft {
  id: string;
  label: string;
  material: string;
  odMm: string;
  color: string;
  src: string;
}

export interface ShieldDraft {
  id: string;
  label: string;
  construction: ShieldElement['construction'];
  material: string;
  coveragePct: string;
  odMm: string;
  src: string;
}

export interface CoreDraft {
  /** the group's id, or the conductor's own id for a plain core */
  id: string;
  label: string;
  kind: CoreKind;
  /** the group's provenance; a plain core has none of its own */
  src: string;
  conductor: ConductorDraft;
  /** coax: the dielectric · shielded: the insulation · plain: absent */
  insulation?: InsulationDraft;
  shield?: ShieldDraft;
  /** coax only: the coloured sheath over the braid */
  sheath?: InsulationDraft;
}

export interface WireDraft {
  id: string;
  label: string;
  partNumber: string;
  specRef: string;
  /** vocab `manufacturers` id, '' = not known */
  manufacturer: string;
  /** the manufacturer's own documents, kept as read — edited in the builder */
  vendorDocs?: WireVendorDoc[];
  /** a figure-8's outline, kept as read — derived by the builder's compile */
  profile?: WireProfile;
  odMm: string;
  src: string;
  /** the root group — normally the same id as the stock */
  structureId: string;
  structureLabel: string;
  structureSrc: string;
  cores: CoreDraft[];
  overallShield?: ShieldDraft;
  drain?: ConductorDraft;
  jacket?: InsulationDraft;
  /** bonded screen sets (shield bonding), kept as read — no form control yet */
  bonded?: WireBondedSet[];
  /** the part's price (cs-5k1.17), edited in the stock form's Cost section */
  cost?: PartCost;
  /** the colour code on the record itself (vocab `colour-codes`), kept as read — no form control yet */
  colourCode?: string;
  lay?: {
    arrangement: WireLayOrder['arrangement'];
    direction: 'cw' | 'ccw';
    /** which end's cut face `direction` describes, kept as read (no form control yet) */
    viewedFrom?: WireLayOrder['viewedFrom'];
    /** element paths, in lay order */
    ring: string[];
    /** the core on the axis, or '' for none */
    center: string;
    /** a centre pair and the like, kept as read (no form control yet) */
    inner?: string[];
    src: string;
  };
}

function conductorDraftOf(element: ConductorElement): ConductorDraft {
  return {
    id: element.id,
    label: text(element.label),
    color: text(element.color),
    material: text(element.material),
    formation: text(element.formation),
    areaMm2: mmField(element.areaMm2),
    odMm: mmField(element.odMm),
    insulatedOdMm: mmField(element.insulatedOdMm),
    bare: element.bare === true,
    src: text(element.src),
    ...(element.lane === undefined ? {} : { lane: element.lane }),
  };
}

function conductorOf(draft: ConductorDraft): ConductorElement {
  return {
    kind: 'conductor',
    id: draft.id.trim(),
    ...some({
      label: draft.label.trim(),
      color: draft.color.trim(),
      material: draft.material.trim(),
      formation: draft.formation.trim(),
    }),
    ...(numberOf(draft.areaMm2) === undefined ? {} : { areaMm2: numberOf(draft.areaMm2) as number }),
    ...(numberOf(draft.odMm) === undefined ? {} : { odMm: numberOf(draft.odMm) as number }),
    ...(numberOf(draft.insulatedOdMm) === undefined
      ? {}
      : { insulatedOdMm: numberOf(draft.insulatedOdMm) as number }),
    ...(draft.bare ? { bare: true } : {}),
    ...some({ src: draft.src.trim() }),
    ...(draft.lane === undefined ? {} : { lane: draft.lane }),
  };
}

function insulationDraftOf(element: InsulationElement): InsulationDraft {
  return {
    id: element.id,
    label: text(element.label),
    material: text(element.material),
    odMm: mmField(element.odMm),
    color: text(element.color),
    src: text(element.src),
  };
}

function insulationOf(draft: InsulationDraft): InsulationElement {
  return {
    kind: 'insulation',
    id: draft.id.trim(),
    ...some({ label: draft.label.trim(), material: draft.material.trim() }),
    ...(numberOf(draft.odMm) === undefined ? {} : { odMm: numberOf(draft.odMm) as number }),
    ...some({ color: draft.color.trim(), src: draft.src.trim() }),
  };
}

function shieldDraftOf(element: ShieldElement): ShieldDraft {
  return {
    id: element.id,
    label: text(element.label),
    construction: element.construction,
    material: text(element.material),
    coveragePct: text(element.coveragePct),
    odMm: mmField(element.odMm),
    src: text(element.src),
  };
}

function shieldOf(draft: ShieldDraft): ShieldElement {
  return {
    kind: 'shield',
    id: draft.id.trim(),
    ...some({ label: draft.label.trim() }),
    construction: draft.construction,
    ...some({ material: draft.material.trim(), coveragePct: draft.coveragePct.trim() }),
    ...(numberOf(draft.odMm) === undefined ? {} : { odMm: numberOf(draft.odMm) as number }),
    ...some({ src: draft.src.trim() }),
  };
}

function coreDraftOf(element: Element): CoreDraft | undefined {
  if (element.kind === 'conductor') {
    return {
      id: element.id,
      label: text(element.label),
      kind: 'plain',
      src: '',
      conductor: conductorDraftOf(element),
    };
  }
  if (element.kind !== 'group') return undefined;
  if (element.role !== 'coax' && element.role !== 'shielded-core') return undefined;
  const [first, second, third, fourth, ...rest] = element.children;
  if (rest.length > 0) return undefined;
  if (first?.kind !== 'conductor') return undefined;
  if (second !== undefined && second.kind !== 'insulation') return undefined;
  if (third !== undefined && third.kind !== 'shield') return undefined;
  if (fourth !== undefined && fourth.kind !== 'insulation') return undefined;
  return {
    id: element.id,
    label: text(element.label),
    kind: element.role,
    src: text(element.src),
    conductor: conductorDraftOf(first),
    ...(second === undefined ? {} : { insulation: insulationDraftOf(second) }),
    ...(third === undefined ? {} : { shield: shieldDraftOf(third) }),
    ...(fourth === undefined ? {} : { sheath: insulationDraftOf(fourth) }),
  };
}

function coreOf(draft: CoreDraft): Element {
  if (draft.kind === 'plain') {
    return conductorOf({ ...draft.conductor, id: draft.id, label: draft.label });
  }
  return {
    kind: 'group',
    id: draft.id.trim(),
    ...some({ label: draft.label.trim() }),
    role: draft.kind,
    ...some({ src: draft.src.trim() }),
    children: [
      conductorOf(draft.conductor),
      ...(draft.insulation === undefined ? [] : [insulationOf(draft.insulation)]),
      ...(draft.shield === undefined ? [] : [shieldOf(draft.shield)]),
      ...(draft.sheath === undefined ? [] : [insulationOf(draft.sheath)]),
    ],
  } as GroupElement;
}

/**
 * A stock as a form, or `undefined` when its tree is richer than the form can
 * hold. The caller shows the JSON pane instead and says why — never a form that
 * would silently flatten a structure on save.
 */
export function wireFormOf(wire: WireDefinition): WireDraft | undefined {
  const cores: CoreDraft[] = [];
  let overallShield: ShieldDraft | undefined;
  let drain: ConductorDraft | undefined;
  let jacket: InsulationDraft | undefined;

  for (const child of wire.structure.children) {
    if (child.kind === 'conductor' && child.bare === true) {
      if (drain !== undefined) return undefined;
      drain = conductorDraftOf(child);
      continue;
    }
    if (child.kind === 'shield') {
      if (overallShield !== undefined || jacket !== undefined) return undefined;
      overallShield = shieldDraftOf(child);
      continue;
    }
    if (child.kind === 'insulation') {
      if (jacket !== undefined) return undefined;
      jacket = insulationDraftOf(child);
      continue;
    }
    // a core has to come before the wrapping, exactly as the file lists it
    if (overallShield !== undefined || drain !== undefined || jacket !== undefined) return undefined;
    const core = coreDraftOf(child);
    if (core === undefined) return undefined;
    cores.push(core);
  }

  const draft: WireDraft = {
    id: wire.id,
    label: wire.label,
    partNumber: text(wire.partNumber),
    specRef: text(wire.specRef),
    manufacturer: text(wire.manufacturer),
    ...(wire.vendorDocs === undefined ? {} : { vendorDocs: wire.vendorDocs.map((doc) => ({ ...doc })) }),
    ...(wire.profile === undefined ? {} : { profile: { ...wire.profile } }),
    ...(wire.cost === undefined ? {} : { cost: structuredClone(wire.cost) }),
    odMm: mmField(wire.odMm),
    src: wire.src,
    structureId: wire.structure.id,
    structureLabel: text(wire.structure.label),
    structureSrc: text(wire.structure.src),
    cores,
    ...(overallShield === undefined ? {} : { overallShield }),
    ...(drain === undefined ? {} : { drain }),
    ...(jacket === undefined ? {} : { jacket }),
    ...(wire.bonded === undefined
      ? {}
      : { bonded: wire.bonded.map((set) => ({ members: [...set.members], src: set.src })) }),
    ...(wire.colourCode === undefined ? {} : { colourCode: wire.colourCode }),
    ...(wire.layOrder === undefined
      ? {}
      : {
          lay: {
            arrangement: wire.layOrder.arrangement,
            direction: wire.layOrder.direction,
            ...(wire.layOrder.viewedFrom === undefined ? {} : { viewedFrom: wire.layOrder.viewedFrom }),
            ring: [...wire.layOrder.ring],
            center: text(wire.layOrder.center),
            ...(wire.layOrder.inner === undefined ? {} : { inner: [...wire.layOrder.inner] }),
            src: wire.layOrder.src,
          },
        }),
  };
  // the root group's role is fixed: this form only edits whole cable stocks
  return wire.structure.role === 'cable' ? draft : undefined;
}

export function blankWireDraft(): WireDraft {
  return {
    id: '',
    label: '',
    partNumber: '',
    specRef: '',
    manufacturer: '',
    odMm: '',
    src: '',
    structureId: '',
    structureLabel: '',
    structureSrc: '',
    cores: [],
  };
}

/** A new core, pre-filled the way the catalog's cores look. */
export function blankCoreDraft(kind: CoreKind, id = ''): CoreDraft {
  const conductor: ConductorDraft = {
    id: kind === 'plain' ? id : 'center',
    label: '',
    color: '',
    material: '',
    formation: '',
    areaMm2: '',
    odMm: '',
    insulatedOdMm: '',
    bare: false,
    src: '',
  };
  if (kind === 'plain') return { id, label: '', kind, src: '', conductor };
  return {
    id,
    label: '',
    kind,
    src: '',
    conductor,
    insulation: {
      id: kind === 'coax' ? 'dielectric' : 'insulation',
      label: '',
      material: '',
      odMm: '',
      color: '',
      src: '',
    },
    shield: {
      id: 'shield',
      label: '',
      construction: kind === 'coax' ? 'braid' : 'spiral',
      material: '',
      coveragePct: '',
      odMm: '',
      src: '',
    },
    ...(kind === 'coax'
      ? {
          sheath: { id: 'sheath', label: '', material: '', odMm: '', color: '', src: '' },
        }
      : {}),
  };
}

export const coreRowsReducer = rowsReducer<CoreDraft>(() => blankCoreDraft('coax'));

export function wireDefinitionOf(draft: WireDraft): WireDefinition {
  const structure: GroupElement = {
    kind: 'group',
    id: (draft.structureId.trim() === '' ? draft.id : draft.structureId).trim(),
    ...some({ label: draft.structureLabel.trim() }),
    role: 'cable',
    ...some({ src: draft.structureSrc.trim() }),
    children: [
      ...draft.cores.map(coreOf),
      ...(draft.overallShield === undefined ? [] : [shieldOf(draft.overallShield)]),
      ...(draft.drain === undefined ? [] : [conductorOf({ ...draft.drain, bare: true })]),
      ...(draft.jacket === undefined ? [] : [insulationOf(draft.jacket)]),
    ],
  } as GroupElement;

  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    ...some({ partNumber: draft.partNumber.trim(), specRef: draft.specRef.trim(), manufacturer: draft.manufacturer.trim() }),
    ...(draft.vendorDocs === undefined || draft.vendorDocs.length === 0 ? {} : { vendorDocs: draft.vendorDocs.map((doc) => ({ ...doc })) }),
    ...(numberOf(draft.odMm) === undefined ? {} : { odMm: numberOf(draft.odMm) as number }),
    ...(draft.profile === undefined ? {} : { profile: { ...draft.profile } }),
    ...(draft.cost === undefined ? {} : { cost: structuredClone(draft.cost) }),
    src: draft.src.trim(),
    ...(draft.lay === undefined
      ? {}
      : {
          layOrder: {
            arrangement: draft.lay.arrangement,
            direction: draft.lay.direction,
            ...(draft.lay.viewedFrom === undefined ? {} : { viewedFrom: draft.lay.viewedFrom }),
            ring: draft.lay.ring.filter((member) => member.trim() !== ''),
            ...some({ center: draft.lay.center.trim() }),
            ...(draft.lay.inner === undefined || draft.lay.inner.length === 0 ? {} : { inner: [...draft.lay.inner] }),
            src: draft.lay.src.trim(),
          },
        }),
    ...(draft.bonded === undefined
      ? {}
      : { bonded: draft.bonded.map((set) => ({ members: [...set.members], src: set.src })) }),
    ...(draft.colourCode === undefined ? {} : { colourCode: draft.colourCode }),
    structure,
  };
}

/** Every core's element path, for the lay-order pickers. */
export function corePaths(draft: WireDraft): string[] {
  return draft.cores.map((core) => core.id.trim()).filter((id) => id !== '');
}

/**
 * What is wrong with a wire form *right now*, in the words of the form itself.
 *
 * This is the immediate half of the discipline: cheap, per-keystroke checks
 * that catch the mistakes a diameter field invites, so the user is not told
 * about them by a round trip. The host still validates the whole library and is
 * still the gate — nothing here decides whether a save is allowed.
 */
export interface FieldIssue {
  /** which box it is about, e.g. `core-red · shield` */
  where: string;
  message: string;
}

export function wireFormIssues(draft: WireDraft): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const say = (where: string, message: string): void => void issues.push({ where, message });

  for (const id of duplicateRowIds(draft.cores)) {
    say(id, `Two cores are both called '${id}'. Every core needs its own name.`);
  }

  const checkMm = (where: string, what: string, field: string): number | undefined => {
    if (!isNumberField(field)) {
      say(where, `The ${what} is not a number. Diameters are millimetres — 1.4, not "1.4 mm".`);
      return undefined;
    }
    const value = numberOf(field);
    if (value !== undefined && value <= 0) {
      say(where, `The ${what} is ${value} mm. A diameter has to be more than zero.`);
      return undefined;
    }
    return value;
  };

  for (const core of draft.cores) {
    const where = core.id.trim() === '' ? 'a core with no name' : core.id.trim();
    if (core.id.trim() === '') say(where, 'This core has no name. Call it something like `core-red`.');
    const layers: { what: string; mm: number | undefined }[] = [
      { what: 'conductor diameter', mm: checkMm(where, 'conductor diameter', core.conductor.odMm) },
      {
        what: 'insulated diameter',
        mm: checkMm(where, 'insulated diameter', core.conductor.insulatedOdMm),
      },
      ...(core.insulation === undefined
        ? []
        : [{ what: 'insulation diameter', mm: checkMm(where, 'insulation diameter', core.insulation.odMm) }]),
      ...(core.shield === undefined
        ? []
        : [{ what: 'shield diameter', mm: checkMm(where, 'shield diameter', core.shield.odMm) }]),
      ...(core.sheath === undefined
        ? []
        : [{ what: 'sheath diameter', mm: checkMm(where, 'sheath diameter', core.sheath.odMm) }]),
    ];
    const stated = layers.filter((layer) => layer.mm !== undefined);
    for (let index = 1; index < stated.length; index += 1) {
      const inner = stated[index - 1] as { what: string; mm: number };
      const outer = stated[index] as { what: string; mm: number };
      if (outer.mm <= inner.mm) {
        say(
          where,
          `The ${outer.what} (${outer.mm} mm) is not bigger than the ${inner.what} (${inner.mm} mm) inside it.`,
        );
      }
    }
  }

  if (draft.overallShield !== undefined) checkMm('overall shield', 'diameter', draft.overallShield.odMm);
  if (draft.drain !== undefined) checkMm('drain', 'diameter', draft.drain.odMm);
  const jacketMm = draft.jacket === undefined ? undefined : checkMm('jacket', 'diameter', draft.jacket.odMm);
  const overall = checkMm('the stock', 'overall diameter', draft.odMm);
  if (jacketMm !== undefined && overall !== undefined && Math.abs(jacketMm - overall) > 0.001) {
    say(
      'jacket',
      `The jacket is Ø ${jacketMm} mm but the stock says it measures Ø ${overall} mm overall. The jacket is the outside of the cable, so these should agree.`,
    );
  }

  if (draft.lay !== undefined) {
    const paths = new Set(corePaths(draft));
    const members = [
      ...draft.lay.ring,
      ...(draft.lay.center.trim() === '' ? [] : [draft.lay.center]),
      ...(draft.lay.inner ?? []),
    ];
    for (const member of members) {
      if (member.trim() !== '' && !paths.has(member.trim())) {
        say('lay order', `The lay order names '${member}', which is not one of the cores.`);
      }
    }
    for (const duplicate of duplicateRowIds(members.map((id) => ({ id })))) {
      say('lay order', `'${duplicate}' is laid twice. Each core sits in one place.`);
    }
    const named = draft.lay.ring.filter((member) => member.trim() !== '').length;
    const expected = LAY_ARRANGEMENT_RING_COUNT[draft.lay.arrangement];
    if (named !== expected) {
      say(
        'lay order',
        `A ${draft.lay.arrangement} lay has ${expected === 7 ? 'seven' : 'six'} cores in the ring, and this one names ${named}. Fill the ring in, or turn the lay order off.`,
      );
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Boards
 * ------------------------------------------------------------------ */

export interface PadRow {
  id: string;
  label: string;
  note: string;
  /** the physical pads behind the terminal, kept as read (no form control yet) */
  pads?: PcbaPad[];
  /** which pad it is for the cable — a vocab `pad-roles` id; blank is untagged */
  role: string;
  /** what it carries — a vocab `signals` id (or `a|b`); blank is untagged */
  signal: string;
  /** role/signal are written on the terminal itself, not in the side table */
  tagsOnRecord?: boolean;
  /** fields of the terminal the form does not show, kept as read */
  extra?: Record<string, unknown>;
}

export function blankPadRow(): PadRow {
  return { id: '', label: '', note: '', role: '', signal: '' };
}

export const padRowsReducer = rowsReducer<PadRow>(blankPadRow);

export interface LinkRow {
  from: string;
  to: string;
  /** what sits in the path — "C1 220 µF"; blank means plain copper */
  via: string;
  note: string;
  /** the link's structured parts (6n6.7), kept while `via` still spells them */
  elements?: PcbaLinkElement[];
}

export function blankLinkRow(): LinkRow {
  return { from: '', to: '', via: '', note: '' };
}

export const linkRowsReducer = rowsReducer<LinkRow>(blankLinkRow);

export interface IntegratedRow {
  connectorDefId: string;
  terminalPrefix: string;
}

export function blankIntegratedRow(): IntegratedRow {
  return { connectorDefId: '', terminalPrefix: '' };
}

export const integratedRowsReducer = rowsReducer<IntegratedRow>(blankIntegratedRow);

export interface PcbaDraft {
  id: string;
  label: string;
  partNumber: string;
  revision: string;
  build: string;
  kicadProject: string;
  src: string;
  terminals: PadRow[];
  integrated: IntegratedRow[];
  links: LinkRow[];
  /** fields of the record the form does not show, kept as read */
  extra?: Record<string, unknown>;
}

const PCBA_FIELDS = [
  'id',
  'label',
  'partNumber',
  'revision',
  'build',
  'kicadProject',
  'src',
  'terminals',
  'integratedConnectors',
  'internalLinks',
] as const;
const PAD_FIELDS = ['id', 'label', 'note', 'pads', 'role', 'signal'] as const;

/** A board as a draft; `tags` (the side table) fills pads with no tags of their own. */
export function pcbaDraftOf(pcba: PcbaDefinition, tags?: SignalTags): PcbaDraft {
  const table = tags?.pcbas?.[pcba.id] ?? {};
  const extra = extrasOf(pcba, PCBA_FIELDS);
  return {
    id: pcba.id,
    label: pcba.label,
    partNumber: pcba.partNumber,
    revision: pcba.revision,
    build: text(pcba.build),
    kicadProject: text(pcba.kicadProject),
    src: pcba.src,
    terminals: pcba.terminals.map((terminal) => {
      const onRecord = terminal.role !== undefined || terminal.signal !== undefined;
      const tagged: PcbaTerminalTags = onRecord ? terminal : (table[terminal.id] ?? {});
      const padExtra = extrasOf(terminal, PAD_FIELDS);
      return {
        id: terminal.id,
        label: text(terminal.label),
        note: text(terminal.note),
        ...(terminal.pads === undefined ? {} : { pads: terminal.pads.map((pad) => ({ ...pad })) }),
        role: text(tagged.role),
        signal: signalText(tagged.signal),
        ...(onRecord ? { tagsOnRecord: true } : {}),
        ...(padExtra === undefined ? {} : { extra: padExtra }),
      };
    }),
    integrated: (pcba.integratedConnectors ?? []).map((entry) => ({ ...entry })),
    links: pcba.internalLinks.map((link) => ({
      from: link.from,
      to: link.to,
      via: text(link.via),
      note: text(link.note),
      ...(link.elements === undefined ? {} : { elements: link.elements }),
    })),
    ...(extra === undefined ? {} : { extra }),
  };
}

export function blankPcbaDraft(): PcbaDraft {
  return {
    id: '',
    label: '',
    partNumber: '',
    revision: '',
    build: '',
    kicadProject: '',
    src: '',
    terminals: [blankPadRow()],
    integrated: [],
    links: [],
  };
}

export function pcbaOf(draft: PcbaDraft): PcbaDefinition {
  const terminals: PcbaTerminal[] = draft.terminals
    .filter((row) => row.id.trim() !== '')
    .map((row) => {
      const signal = row.tagsOnRecord === true ? signalRefOf(row.signal) : undefined;
      return {
        id: row.id.trim(),
        ...some({ label: row.label.trim(), note: row.note.trim() }),
        ...(row.pads === undefined ? {} : { pads: row.pads.map((pad) => ({ ...pad })) }),
        ...(row.tagsOnRecord === true ? some({ role: row.role.trim() }) : {}),
        ...(signal === undefined ? {} : { signal }),
        ...(row.extra ?? {}),
      };
    });
  const internalLinks: PcbaInternalLink[] = draft.links
    .filter((row) => row.from.trim() !== '' || row.to.trim() !== '')
    .map((row) => ({
      from: row.from.trim(),
      to: row.to.trim(),
      ...some({ via: row.via.trim() }),
      // an edited `via` drops the structure it no longer spells; the parse takes over
      ...(row.elements !== undefined && viaText(row.elements) === row.via.trim() ? { elements: row.elements } : {}),
      ...some({ note: row.note.trim() }),
    }));
  const integrated = draft.integrated.filter((row) => row.connectorDefId.trim() !== '');
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    partNumber: draft.partNumber.trim(),
    revision: draft.revision.trim(),
    ...some({ build: draft.build.trim(), kicadProject: draft.kicadProject.trim() }),
    src: draft.src.trim(),
    terminals,
    ...(integrated.length === 0
      ? {}
      : {
          integratedConnectors: integrated.map((row) => ({
            connectorDefId: row.connectorDefId.trim(),
            terminalPrefix: row.terminalPrefix.trim(),
          })),
        }),
    internalLinks,
    ...(draft.extra ?? {}),
  };
}

/**
 * Every terminal a board's links may name: its own pads, plus the pins of the
 * connectors soldered to it, prefixed. The link rows offer these as a list, so
 * a typo is something you have to work at rather than something you fall into.
 */
export function pcbaTerminalChoices(draft: PcbaDraft, db: Db): string[] {
  const own = draft.terminals.map((row) => row.id.trim()).filter((id) => id !== '');
  const integrated = draft.integrated.flatMap((row) => {
    const connector = db.connectors.find((candidate) => candidate.id === row.connectorDefId.trim());
    if (connector === undefined) return [];
    return connector.pins.map((pin) => `${row.terminalPrefix.trim()}.${pin.id}`);
  });
  return [...own, ...integrated];
}

/* ------------------------------------------------------------------ *
 * Shells and hardware
 * ------------------------------------------------------------------ */

export const MECHANICAL_KINDS = ['shell', 'fastener', 'other'] as const;

export interface MechanicalDraft {
  id: string;
  label: string;
  kind: MechanicalDefinition['kind'];
  partNumber: string;
  revision: string;
  src: string;
  extra?: Record<string, unknown>;
}

const MECHANICAL_FIELDS = ['id', 'label', 'partNumber', 'revision', 'kind', 'src'] as const;

export function mechanicalDraftOf(part: MechanicalDefinition): MechanicalDraft {
  const extra = extrasOf(part, MECHANICAL_FIELDS);
  return {
    id: part.id,
    label: part.label,
    kind: part.kind,
    partNumber: text(part.partNumber),
    revision: text(part.revision),
    src: part.src,
    ...(extra === undefined ? {} : { extra }),
  };
}

export function blankMechanicalDraft(): MechanicalDraft {
  return { id: '', label: '', kind: 'shell', partNumber: '', revision: '', src: '' };
}

export function mechanicalOf(draft: MechanicalDraft): MechanicalDefinition {
  // key order follows mechanicals.json
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    ...some({ partNumber: draft.partNumber.trim(), revision: draft.revision.trim() }),
    kind: draft.kind,
    src: draft.src.trim(),
    ...(draft.extra ?? {}),
  };
}

/* ------------------------------------------------------------------ *
 * Kits (data model v2 §7.1)
 * ------------------------------------------------------------------ */

export interface KitLineRow {
  kind: KitPartKind;
  def: string;
  qty: string;
  /** '' = every stock */
  stock: '' | 'coax' | 'bonded';
  inferred: boolean;
  note: string;
  src: string;
  extra?: Record<string, unknown>;
}

export function blankKitLineRow(): KitLineRow {
  return { kind: 'connector', def: '', qty: '1', stock: '', inferred: false, note: '', src: '' };
}

export const kitLineRowsReducer = rowsReducer<KitLineRow>(blankKitLineRow);

export interface KitDraft {
  id: string;
  label: string;
  sku: string;
  src: string;
  lines: KitLineRow[];
  extra?: Record<string, unknown>;
}

const KIT_FIELDS = ['id', 'label', 'sku', 'contents', 'src'] as const;
const KIT_LINE_FIELDS = ['part', 'qty', 'when', 'inferred', 'note', 'src'] as const;

export function kitDraftOf(kit: KitDefinition): KitDraft {
  const extra = extrasOf(kit, KIT_FIELDS);
  return {
    id: kit.id,
    label: kit.label,
    sku: kit.sku,
    src: kit.src,
    lines: kit.contents.map((line) => {
      const lineExtra = extrasOf(line, KIT_LINE_FIELDS);
      return {
        kind: line.part.kind,
        def: line.part.def,
        qty: String(line.qty),
        stock: line.when?.stockFamily ?? '',
        inferred: line.inferred === true,
        note: text(line.note),
        src: text(line.src),
        ...(lineExtra === undefined ? {} : { extra: lineExtra }),
      };
    }),
    ...(extra === undefined ? {} : { extra }),
  };
}

export function blankKitDraft(): KitDraft {
  return { id: '', label: '', sku: '', src: '', lines: [blankKitLineRow()] };
}

export function kitOf(draft: KitDraft): KitDefinition {
  const contents: KitLine[] = draft.lines
    .filter((line) => line.def.trim() !== '')
    .map((line) => {
      const qty = Number(line.qty.trim());
      return {
        part: { kind: line.kind, def: line.def.trim() },
        qty: Number.isFinite(qty) && line.qty.trim() !== '' ? qty : 0,
        ...(line.stock === '' ? {} : { when: { stockFamily: line.stock } }),
        ...(line.inferred ? { inferred: true } : {}),
        ...some({ note: line.note.trim(), src: line.src.trim() }),
        ...(line.extra ?? {}),
      };
    });
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    sku: draft.sku.trim(),
    contents,
    src: draft.src.trim(),
    ...(draft.extra ?? {}),
  };
}

/** The kit-line kind a Library tab's records are, when a kit can ship them. */
export const KIT_PART_KIND_OF: Partial<Record<DefinitionKind, KitPartKind>> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire',
  pcbas: 'pcba',
  mechanicals: 'mechanical',
};

/** `kit` with one more line for `part` (qty 1), or unchanged when it already ships it. */
export function kitWithPart(kit: KitDefinition, part: { kind: KitPartKind; def: string }): KitDefinition {
  if (kit.contents.some((line) => line.part.kind === part.kind && line.part.def === part.def)) return kit;
  return { ...kit, contents: [...kit.contents, { part: { ...part }, qty: 1 }] };
}

/** `kit` without any line for `part`. */
export function kitWithoutPart(kit: KitDefinition, part: { kind: KitPartKind; def: string }): KitDefinition {
  return { ...kit, contents: kit.contents.filter((line) => !(line.part.kind === part.kind && line.part.def === part.def)) };
}

/* ------------------------------------------------------------------ *
 * One draft, whatever kind it is
 * ------------------------------------------------------------------ */

/**
 * The four drafts as one value, so the Library can hold "what is being edited"
 * in a single piece of state and keep the save discipline — candidate,
 * validate, save or refuse whole — in one place instead of four.
 */
export type DefinitionDraft =
  | { kind: 'connectors'; value: ConnectorDraft }
  | { kind: 'components'; value: ComponentDraft }
  | { kind: 'wires'; value: WireDraft }
  | { kind: 'pcbas'; value: PcbaDraft }
  | { kind: 'mechanicals'; value: MechanicalDraft }
  | { kind: 'kits'; value: KitDraft };

/**
 * A stored record as a draft, or `undefined` when this editor cannot hold it —
 * today only a wire stock whose tree is richer than the form. The caller says
 * so and offers the JSON instead.
 */
export function draftOfRecord(
  kind: DefinitionKind,
  record: DefinitionRecord,
  tags?: SignalTags,
): DefinitionDraft | undefined {
  switch (kind) {
    case 'connectors':
      return { kind, value: connectorDraftOf(record as ConnectorDefinition, tags) };
    case 'components':
      return { kind, value: componentDraftOf(record as ComponentDefinition) };
    case 'pcbas':
      return { kind, value: pcbaDraftOf(record as PcbaDefinition, tags) };
    case 'wires': {
      const value = wireFormOf(record as WireDefinition);
      return value === undefined ? undefined : { kind, value };
    }
    case 'mechanicals':
      return { kind, value: mechanicalDraftOf(record as MechanicalDefinition) };
    case 'kits':
      return { kind, value: kitDraftOf(record as KitDefinition) };
    // bodies and pinouts are edited inside the connector journey, never as a form of their own
    case 'bodies':
    case 'interfaces':
      return undefined;
  }
}

export function blankDraftOf(kind: LibraryKind): DefinitionDraft {
  switch (kind) {
    case 'mechanicals':
      return { kind, value: blankMechanicalDraft() };
    case 'kits':
      return { kind, value: blankKitDraft() };
    case 'connectors':
      return { kind, value: blankConnectorDraft() };
    case 'components':
      return { kind, value: blankComponentDraft() };
    case 'wires':
      return { kind, value: blankWireDraft() };
    case 'pcbas':
      return { kind, value: blankPcbaDraft() };
  }
}

/** The candidate record a draft describes — what Save is asked to store. */
export function recordOfDraft(draft: DefinitionDraft): DefinitionRecord {
  switch (draft.kind) {
    case 'connectors':
      return connectorOf(draft.value);
    case 'components':
      return componentOf(draft.value);
    case 'wires':
      return wireDefinitionOf(draft.value);
    case 'pcbas':
      return pcbaOf(draft.value);
    case 'mechanicals':
      return mechanicalOf(draft.value);
    case 'kits':
      return kitOf(draft.value);
  }
}

/**
 * The side-table tags a draft describes — every row whose tags are not on the
 * record, as `{ row id: tag | null }`. `undefined` for a kind the form has no
 * tag columns for. The Library compares it with the table to know the tags
 * are dirty, and sends what changed to the host's tag save.
 */
export function tagsOfDraft(draft: DefinitionDraft): RecordTags | undefined {
  // a connector's pin signals are the connector's (composed from its
  // interface, data model v2 §1.2) and are saved with it, never to the table
  if (draft.kind === 'pcbas') {
    const tags: Record<string, { role: string | null; signal: SignalRef | null }> = {};
    for (const pad of draft.value.terminals) {
      const id = pad.id.trim();
      if (id === '' || pad.tagsOnRecord === true) continue;
      tags[id] = { role: pad.role.trim() === '' ? null : pad.role.trim(), signal: signalRefOf(pad.signal) ?? null };
    }
    return { kind: 'pcbas', id: draft.value.id.trim(), tags };
  }
  return undefined;
}

/**
 * The same shape read off the side table as it stands — the baseline
 * `tagsOfDraft` is compared with. Rows are the draft's, so a pin the table
 * has never tagged reads `null` on both sides.
 */
export function tableTagsFor(draft: DefinitionDraft, tags: SignalTags | undefined): RecordTags | undefined {
  const mine = tagsOfDraft(draft);
  if (mine === undefined) return undefined;
  if (mine.kind === 'connectors') {
    const table = tags?.connectors?.[mine.id] ?? {};
    return {
      kind: 'connectors',
      id: mine.id,
      tags: Object.fromEntries(Object.keys(mine.tags).map((pin) => [pin, table[pin] ?? null])),
    };
  }
  if (mine.kind === 'pcbas') {
    const table = tags?.pcbas?.[mine.id] ?? {};
    return {
      kind: 'pcbas',
      id: mine.id,
      tags: Object.fromEntries(
        Object.keys(mine.tags).map((pad) => [pad, { role: table[pad]?.role ?? null, signal: table[pad]?.signal ?? null }]),
      ),
    };
  }
  return mine;
}

/** Only the rows whose tags differ from the table — what a tag save sends; `undefined` when none do. */
export function changedTags(draft: DefinitionDraft, tags: SignalTags | undefined): RecordTags | undefined {
  const mine = tagsOfDraft(draft);
  const table = tableTagsFor(draft, tags);
  if (mine === undefined || table === undefined) return undefined;
  const before = table.tags as Record<string, unknown>;
  const changed = Object.fromEntries(
    Object.entries(mine.tags as Record<string, unknown>).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key]),
    ),
  );
  if (Object.keys(changed).length === 0) return undefined;
  return { ...mine, tags: changed } as RecordTags;
}

/** The per-field checks a draft can answer instantly; only wires have any yet. */
export function draftFieldIssues(draft: DefinitionDraft): FieldIssue[] {
  if (draft.kind === 'wires') return wireFormIssues(draft.value);
  if (draft.kind === 'mechanicals') return [];
  if (draft.kind === 'kits') {
    return draft.value.lines.flatMap((line, index): FieldIssue[] => {
      const qty = line.qty.trim();
      if (line.def.trim() === '') return [];
      return /^[1-9]\d*$/.test(qty)
        ? []
        : [{ where: `line ${index + 1}`, message: `Quantity '${qty}' is not a whole number of parts.` }];
    });
  }
  const rows =
    draft.kind === 'connectors'
      ? draft.value.pins
      : draft.kind === 'components'
        ? draft.value.terminals
        : draft.value.terminals;
  const noun = draft.kind === 'connectors' ? 'pin' : draft.kind === 'components' ? 'terminal' : 'pad';
  return duplicateRowIds(rows).map((id) => ({
    where: `${noun} ${id}`,
    message: `Two ${noun}s are both called '${id}'. Change one of them — every ${noun} needs its own name.`,
  }));
}

/* ------------------------------------------------------------------ *
 * The immediate half of the gate
 * ------------------------------------------------------------------ */

/** `record` in place of the one with its id, or appended when it is new. */
function swapIn<T extends { id: string }>(records: T[], record: T): T[] {
  return records.some((existing) => existing.id === record.id)
    ? records.map((existing) => (existing.id === record.id ? record : existing))
    : [...records, record];
}

/** The library as it would stand with `record` in place of the stored one. */
export function candidateDb(db: Db, kind: DefinitionKind, record: DefinitionRecord): Db {
  switch (kind) {
    case 'connectors':
      return { ...db, connectors: swapIn(db.connectors, record as ConnectorDefinition) };
    case 'components':
      return { ...db, components: swapIn(db.components, record as ComponentDefinition) };
    case 'wires':
      return { ...db, wires: swapIn(db.wires, record as WireDefinition) };
    case 'pcbas':
      return { ...db, pcbas: swapIn(db.pcbas, record as PcbaDefinition) };
    case 'mechanicals':
      return { ...db, mechanicals: swapIn(db.mechanicals ?? [], record as MechanicalDefinition) };
    case 'kits':
      return { ...db, kits: swapIn(db.kits ?? [], record as KitDefinition) };
    case 'bodies':
      return { ...db, bodies: swapIn(db.bodies ?? [], record as ConnectorBody) };
    case 'interfaces':
      return { ...db, interfaces: swapIn(db.interfaces ?? [], record as Interface) };
  }
}

function issueKey(issue: Issue): string {
  return `${issue.code} ${issue.where ?? ''} ${issue.message}`;
}

/**
 * What saving this draft would break in the rest of the library, checked here
 * so the answer arrives while the user is still looking at the field.
 *
 * Only what the edit *introduces* is reported — the library is allowed to have
 * pre-existing problems elsewhere, and holding them against this record would
 * be blaming the wrong person. The host runs the same comparison over the
 * designs as well, which this side cannot see, and is the real gate.
 */
export function draftIssues(db: Db, kind: DefinitionKind, record: DefinitionRecord): Issue[] {
  const before = new Set(errors(validateDb(db)).map(issueKey));
  return errors(validateDb(candidateDb(db, kind, record))).filter(
    (issue) => !before.has(issueKey(issue)),
  );
}

/** "3 connectors", "1 wire stock" — a count that reads like a sentence. */
export function countLabel(kind: DefinitionKind, count: number): string {
  const noun = DEFINITION_NOUNS[kind];
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
