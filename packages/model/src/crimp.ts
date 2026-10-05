/**
 * Crimp terminations as parts: contacts, seals, cavity plugs and tooling.
 *
 * A crimp housing (a connector or body with a `housing`) has cavities — its
 * pin positions — and each takes a loose **contact** (the terminal crimped
 * onto the wire), optionally a **seal** (a single-wire seal on the
 * insulation), and an unused one in a sealed housing a **plug**. A contact is
 * crimped with a **tool** (a hand tool or an applicator). All four are
 * mechanical records (`MechanicalDefinition.kind` `contact` / `seal` / `plug` /
 * `tool`) with a `termination` block saying what they fit and the wire they
 * take; a design records which contact, seal and plug go in each cavity on
 * the connector instance (`ConnectorInstance.cavities`).
 *
 * Everything is optional. A solder-cup or PCB connector has no housing and no
 * cavities, and a design that records none validates exactly as before.
 *
 * Pure: records in, records out. Nothing here knows about drawings.
 */

import type {
  CableDesign,
  ConductorElement,
  ConnectorDefinition,
  ConnectorGender,
  ConnectorInstance,
  Db,
  Issue,
  MechanicalDefinition,
  MechanicalKind,
} from './model.ts';
import { findConnector, findMechanical, findWire } from './model.ts';
import { connectorConstruction } from './interfaces.ts';
import { resolveElementPath } from './paths.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The mechanical kinds that are crimp termination parts. */
export type TerminationPartKind = Extract<MechanicalKind, 'contact' | 'seal' | 'plug' | 'tool'>;

export const TERMINATION_PART_KINDS: readonly TerminationPartKind[] = ['contact', 'seal', 'plug', 'tool'];

/** A crimp height for one wire size, as the contact's datasheet tabulates it. */
export interface CrimpHeight {
  /** the conductor cross-section this height is for, mm² */
  wireMm2: number;
  /** crimp height over the conductor crimp, mm */
  heightMm: number;
  /** crimp width, mm, when the datasheet gives it */
  widthMm?: number;
}

/**
 * What a contact, seal, plug or tool fits and takes. Every field is optional:
 * a value no source states is left out, never guessed, and a check whose
 * value is absent is not made.
 */
export interface TerminationSpec {
  /**
   * The contact systems it belongs to — free kebab ids a housing names in its
   * own `systems` (`sealed-1-5`, `xh-2-5`). How a contact, seal or plug says
   * "this housing family".
   */
  systems?: string[];
  /** connector or body ids it fits outright, beyond its systems */
  housings?: string[];
  /** contact: smallest conductor cross-section it takes, mm² */
  wireMinMm2?: number;
  /** contact: largest conductor cross-section it takes, mm² */
  wireMaxMm2?: number;
  /** contact or seal: smallest insulation Ø it takes, mm */
  insulationMinMm?: number;
  /** contact or seal: largest insulation Ø it takes, mm */
  insulationMaxMm?: number;
  /** contact: a pin (`male`) or a socket (`female`) */
  gender?: ConnectorGender;
  /** contact: the plating (`tin`, `gold`, `silver`) */
  plating?: string;
  /** contact: insulation strip length, mm */
  stripMm?: number;
  /** contact: crimp heights per wire size */
  crimpHeights?: CrimpHeight[];
  /** contact: rated current per contact, A — the electrical rules use it over the connector's `contactRatingA` */
  ratedCurrentA?: number;
  /** contact: the tool or applicator that crimps it — a mechanical id of kind `tool` */
  tool?: string;
  src?: string;
}

/** A crimp housing's cavities. */
export interface HousingSpec {
  /** the contact systems its cavities take (see `TerminationSpec.systems`) */
  systems?: string[];
  /**
   * How the wires are sealed: `none` (an unsealed housing), `per-wire` (a
   * single-wire seal on each wire, so each used cavity takes a seal) or `mat`
   * (a mat seal moulded into the housing — no loose seals).
   */
  sealing?: 'none' | 'per-wire' | 'mat';
  /** unused cavities take a cavity plug (a sealed housing) */
  plugUnused?: boolean;
  /** the pin ids that are crimp cavities; absent = every pin but the shell */
  cavities?: string[];
  src?: string;
}

/** What goes into one cavity of a connector instance. */
export interface CavityAssignment {
  /** the connector pin id (the cavity) */
  pin: string;
  /** a mechanical id of kind `contact` */
  contact?: string;
  /** a mechanical id of kind `seal` */
  seal?: string;
  /** a mechanical id of kind `plug` — an unused cavity, closed */
  plug?: string;
  /** this cavity's crimp height when it differs from the contact's table, mm */
  crimpHeightMm?: number;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function isTerminationPart(part: Pick<MechanicalDefinition, 'kind'>): boolean {
  return (TERMINATION_PART_KINDS as readonly string[]).includes(part.kind);
}

/** The termination parts of one kind in the library, in library order. */
export function terminationParts(db: Pick<Db, 'mechanicals'>, kind: TerminationPartKind): MechanicalDefinition[] {
  return (db.mechanicals ?? []).filter((m) => m.kind === kind);
}

/** A connector's housing: its own `housing`, else its body's. */
export function housingOf(connector: Pick<ConnectorDefinition, 'housing' | 'body'>, db: Pick<Db, 'bodies'>): HousingSpec | undefined {
  if (connector.housing !== undefined) return connector.housing;
  return (db.bodies ?? []).find((b) => b.id === connector.body)?.housing;
}

/**
 * The pins of a connector that are crimp cavities: the housing's own list
 * when it gives one, else every pin that is not the shell (or a key) of its
 * body.
 */
export function cavityPins(connector: ConnectorDefinition, db: Pick<Db, 'bodies'>): string[] {
  const housing = housingOf(connector, db);
  if (housing?.cavities !== undefined) return connector.pins.map((p) => p.id).filter((id) => housing.cavities!.includes(id));
  const body = (db.bodies ?? []).find((b) => b.id === connector.body);
  const notCavity = new Set((body?.positions ?? []).filter((p) => p.kind === 'shell' || p.kind === 'key').map((p) => p.id));
  return connector.pins.map((p) => p.id).filter((id) => id !== 'shell' && !notCavity.has(id));
}

/**
 * Whether a termination part fits a connector's housing: `true` when the
 * part names the connector (or its body) or shares a system with the
 * housing, `false` when both sides say what they fit and nothing matches,
 * `undefined` when either side says nothing (nothing to check).
 */
export function fitsHousing(part: MechanicalDefinition, connector: ConnectorDefinition, db: Pick<Db, 'bodies'>): boolean | undefined {
  const spec = part.termination;
  const own = [...(spec?.housings ?? [])];
  if (own.includes(connector.id) || (connector.body !== undefined && own.includes(connector.body))) return true;
  const housing = housingOf(connector, db);
  const theirs = housing?.systems ?? [];
  const mine = spec?.systems ?? [];
  if (mine.some((s) => theirs.includes(s))) return true;
  if ((mine.length === 0 && own.length === 0) || theirs.length === 0) return undefined;
  return false;
}

/* ------------------------------------------------------------------ *
 * Wire sizes
 * ------------------------------------------------------------------ */

/** The nearest AWG to a cross-section in mm² (solid-equivalent). */
export function awgOfMm2(mm2: number): number {
  // d(n) = 0.127 mm × 92^((36 − n) / 39); area = π d² / 4
  const d = Math.sqrt((4 * mm2) / Math.PI);
  return Math.round(36 - 39 * Math.log(d / 0.127) / Math.log(92));
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** `0.5–1 mm² (20–18 AWG)`; `undefined` when the part gives no wire range. */
export function wireRangeText(spec: TerminationSpec | undefined): string | undefined {
  const lo = spec?.wireMinMm2;
  const hi = spec?.wireMaxMm2;
  if (lo === undefined && hi === undefined) return undefined;
  const mm = lo !== undefined && hi !== undefined ? `${round(lo)}–${round(hi)} mm²` : lo !== undefined ? `≥ ${round(lo)} mm²` : `≤ ${round(hi!)} mm²`;
  const awg = lo !== undefined && hi !== undefined ? `${awgOfMm2(lo)}–${awgOfMm2(hi)} AWG` : `${awgOfMm2((lo ?? hi)!)} AWG`;
  return `${mm} (${awg})`;
}

/** `Ø 1.2–2.1 mm insulation`; `undefined` when the part gives no insulation range. */
export function insulationRangeText(spec: TerminationSpec | undefined): string | undefined {
  const lo = spec?.insulationMinMm;
  const hi = spec?.insulationMaxMm;
  if (lo === undefined && hi === undefined) return undefined;
  return lo !== undefined && hi !== undefined ? `Ø ${lo}–${hi} mm insulation` : lo !== undefined ? `Ø ≥ ${lo} mm insulation` : `Ø ≤ ${hi!} mm insulation`;
}

/** One conductor landed in a cavity. */
export interface CavityWire {
  segment: string;
  path: string;
  end: 'a' | 'b';
  /** the stock definition id */
  stock: string;
  colour?: string;
  areaMm2?: number;
  insulationMm?: number;
}

/**
 * The conductors landed on one pin of a connector instance, from the joints
 * (a pin may take two wires — a double crimp).
 */
export function wiresAtPin(design: CableDesign, db: Db, instance: string, pin: string): CavityWire[] {
  const out: CavityWire[] = [];
  for (const joint of design.joints) {
    for (const [near, far] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (near.instance !== instance || near.terminal !== pin || far.end === undefined) continue;
      const segment = design.instances.segments.find((s) => s.id === far.instance);
      if (segment === undefined) continue;
      const wire = findWire(db, segment.def);
      const element = wire === undefined ? undefined : resolveElementPath(wire.structure, far.terminal);
      if (element?.kind !== 'conductor') continue;
      const conductor = element as ConductorElement;
      out.push({
        segment: segment.id,
        path: far.terminal,
        end: far.end,
        stock: segment.def,
        ...(conductor.color === undefined ? {} : { colour: conductor.color }),
        ...(conductor.areaMm2 === undefined ? {} : { areaMm2: conductor.areaMm2 }),
        ...(conductor.insulatedOdMm === undefined ? {} : { insulationMm: conductor.insulatedOdMm }),
      });
    }
  }
  return out;
}

/** Whether a pin has anything jointed to it at all (a wire, a component lead, a board pad). */
function pinUsed(design: CableDesign, instance: string, pin: string): boolean {
  return design.joints.some(
    (j) => (j.a.instance === instance && j.a.terminal === pin) || (j.b.instance === instance && j.b.terminal === pin),
  );
}

/** The total conductor cross-section in a cavity, when every wire in it says. */
function totalArea(wires: readonly CavityWire[]): number | undefined {
  if (wires.length === 0 || wires.some((w) => w.areaMm2 === undefined)) return undefined;
  return round(wires.reduce((sum, w) => sum + (w.areaMm2 ?? 0), 0));
}

/** The crimp height a contact's table gives for this cross-section (± 2 %), when it gives one. */
export function crimpHeightFor(contact: MechanicalDefinition | undefined, areaMm2: number | undefined): CrimpHeight | undefined {
  if (contact === undefined || areaMm2 === undefined) return undefined;
  return (contact.termination?.crimpHeights ?? []).find((h) => Math.abs(h.wireMm2 - areaMm2) <= Math.max(0.005, areaMm2 * 0.02));
}

/* ------------------------------------------------------------------ *
 * Cavity rows — what the build sheet, BOM and inspector read
 * ------------------------------------------------------------------ */

export interface CavityRow {
  /** connector instance id */
  instance: string;
  pin: string;
  label?: string;
  wires: CavityWire[];
  /** the pin has a joint (a wire or anything else) */
  used: boolean;
  contact?: MechanicalDefinition;
  seal?: MechanicalDefinition;
  plug?: MechanicalDefinition;
  tool?: MechanicalDefinition;
  stripMm?: number;
  /** the cavity's own height, else the contact table's for its wire */
  crimpHeightMm?: number;
  crimpWidthMm?: number;
  note?: string;
  /** the stored assignment, when there is one */
  assignment?: CavityAssignment;
}

/**
 * One row per cavity of a connector instance: the crimp cavities of its
 * housing, plus any pin an assignment names. Empty for a connector with no
 * housing and no assignments.
 */
export function cavityRows(design: CableDesign, db: Db, instanceId: string): CavityRow[] {
  const instance = design.instances.connectors.find((c) => c.id === instanceId);
  if (instance === undefined) return [];
  const connector = findConnector(db, instance.def);
  if (connector === undefined) return [];
  const assigned = instance.cavities ?? [];
  if (housingOf(connector, db) === undefined && assigned.length === 0) return [];
  const pins = cavityPins(connector, db);
  for (const a of assigned) if (!pins.includes(a.pin) && connector.pins.some((p) => p.id === a.pin)) pins.push(a.pin);
  return pins.map((pin): CavityRow => {
    const assignment = assigned.find((a) => a.pin === pin);
    const wires = wiresAtPin(design, db, instanceId, pin);
    const contact = assignment?.contact === undefined ? undefined : findMechanical(db, assignment.contact);
    const seal = assignment?.seal === undefined ? undefined : findMechanical(db, assignment.seal);
    const plug = assignment?.plug === undefined ? undefined : findMechanical(db, assignment.plug);
    const toolId = contact?.termination?.tool;
    const tool = toolId === undefined ? undefined : findMechanical(db, toolId);
    const table = crimpHeightFor(contact, totalArea(wires));
    const height = assignment?.crimpHeightMm ?? table?.heightMm;
    const label = connector.pins.find((p) => p.id === pin)?.label;
    return {
      instance: instanceId,
      pin,
      ...(label === undefined || label === pin ? {} : { label }),
      wires,
      used: pinUsed(design, instanceId, pin),
      ...(contact === undefined ? {} : { contact }),
      ...(seal === undefined ? {} : { seal }),
      ...(plug === undefined ? {} : { plug }),
      ...(tool === undefined ? {} : { tool }),
      ...(contact?.termination?.stripMm === undefined ? {} : { stripMm: contact.termination.stripMm }),
      ...(height === undefined ? {} : { crimpHeightMm: height }),
      ...(assignment?.crimpHeightMm === undefined && table?.widthMm !== undefined ? { crimpWidthMm: table.widthMm } : {}),
      ...(assignment?.note === undefined ? {} : { note: assignment.note }),
      ...(assignment === undefined ? {} : { assignment }),
    };
  });
}

/** Every connector instance's cavity rows, in instance order (only those with any). */
export function designCavities(design: CableDesign, db: Db): CavityRow[] {
  return design.instances.connectors.flatMap((c) => cavityRows(design, db, c.id));
}

/** The tools the design's contacts need, each once, in first-use order. */
export function designTools(design: CableDesign, db: Db): { tool: MechanicalDefinition; contacts: string[] }[] {
  const out = new Map<string, { tool: MechanicalDefinition; contacts: Set<string> }>();
  for (const row of designCavities(design, db)) {
    if (row.tool === undefined || row.contact === undefined) continue;
    const entry = out.get(row.tool.id) ?? { tool: row.tool, contacts: new Set<string>() };
    entry.contacts.add(row.contact.id);
    out.set(row.tool.id, entry);
  }
  return [...out.values()].map((e) => ({ tool: e.tool, contacts: [...e.contacts] }));
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function issue(code: string, message: string, where: string, severity: Issue['severity']): Issue {
  return { code, severity, message, where };
}

const SLOT_KIND: Readonly<Record<'contact' | 'seal' | 'plug', TerminationPartKind>> = { contact: 'contact', seal: 'seal', plug: 'plug' };

function inRange(value: number, lo: number | undefined, hi: number | undefined): boolean {
  const eps = 1e-9;
  return (lo === undefined || value >= lo - eps) && (hi === undefined || value <= hi + eps);
}

/**
 * The library checks on termination parts and housings:
 *
 * - `termination-range` (error): a minimum above its maximum;
 * - `termination-tool-unknown` (error): a contact's `tool` is not a
 *   mechanical of kind `tool`;
 * - `termination-on-non-part` (warning): a `termination` block on a shell,
 *   fastener or other part, where nothing reads it.
 */
export function terminationDbIssues(db: Db): Issue[] {
  const issues: Issue[] = [];
  for (const part of db.mechanicals ?? []) {
    const spec = part.termination;
    if (spec === undefined) continue;
    const where = `mechanicals/${part.id}`;
    if (!isTerminationPart(part)) {
      issues.push(issue('termination-on-non-part', `mechanical '${part.id}' is a ${part.kind} but carries a termination block — only contacts, seals, plugs and tools use one`, where, 'warning'));
    }
    if (spec.wireMinMm2 !== undefined && spec.wireMaxMm2 !== undefined && spec.wireMinMm2 > spec.wireMaxMm2) {
      issues.push(issue('termination-range', `mechanical '${part.id}': wire range ${spec.wireMinMm2}–${spec.wireMaxMm2} mm² runs backwards`, where, 'error'));
    }
    if (spec.insulationMinMm !== undefined && spec.insulationMaxMm !== undefined && spec.insulationMinMm > spec.insulationMaxMm) {
      issues.push(issue('termination-range', `mechanical '${part.id}': insulation range Ø ${spec.insulationMinMm}–${spec.insulationMaxMm} mm runs backwards`, where, 'error'));
    }
    if (spec.tool !== undefined && findMechanical(db, spec.tool)?.kind !== 'tool') {
      issues.push(issue('termination-tool-unknown', `mechanical '${part.id}' names tool '${spec.tool}', which is not a tool in the library`, where, 'error'));
    }
  }
  return issues;
}

/**
 * The per-cavity rules of a design. Structural problems are errors (they make
 * the BOM wrong): `cavity-unknown-pin`, `cavity-duplicate`,
 * `cavity-unknown-part` (the id is not in the library or not the right kind
 * of part) and `cavity-contact-and-plug`. The fit and size checks are
 * warnings: `cavity-not-crimp` (assignments on a connector that is not a
 * crimp part), `cavity-part-housing` (the part does not fit this housing),
 * `contact-wire-range` (the wire is outside the contact's range),
 * `contact-insulation-range` / `seal-wire-range` (the insulation Ø is),
 * `cavity-no-contact` (a wire lands in a cavity with no contact),
 * `cavity-no-seal` (a sealed housing's used cavity has no seal),
 * `cavity-unplugged` (an unused cavity of a housing that plugs them has no
 * plug), `cavity-plug-on-used` and `cavity-contact-unused`.
 *
 * A connector with no housing and no assignments raises nothing, so a design
 * that records no contacts validates exactly as before.
 */
export function cavityIssues(design: CableDesign, db: Db): Issue[] {
  const issues: Issue[] = [];
  for (const instance of design.instances.connectors) {
    issues.push(...instanceCavityIssues(design, db, instance));
  }
  return issues;
}

function instanceCavityIssues(design: CableDesign, db: Db, instance: ConnectorInstance): Issue[] {
  const issues: Issue[] = [];
  const connector = findConnector(db, instance.def);
  if (connector === undefined) return issues;
  const assigned = instance.cavities ?? [];
  const housing = housingOf(connector, db);
  if (housing === undefined && assigned.length === 0) return issues;
  const at = (pin: string): string => `${instance.id}:${pin}`;

  // structure
  const seen = new Set<string>();
  let structural = false;
  for (const a of assigned) {
    if (!connector.pins.some((p) => p.id === a.pin)) {
      issues.push(issue('cavity-unknown-pin', `connector '${instance.id}' (${connector.id}) has no pin '${a.pin}' for a cavity assignment`, at(a.pin), 'error'));
      structural = true;
    }
    if (seen.has(a.pin)) {
      issues.push(issue('cavity-duplicate', `connector '${instance.id}' assigns cavity '${a.pin}' twice`, at(a.pin), 'error'));
      structural = true;
    }
    seen.add(a.pin);
    for (const slot of ['contact', 'seal', 'plug'] as const) {
      const id = a[slot];
      if (id === undefined) continue;
      const part = findMechanical(db, id);
      if (part === undefined || part.kind !== SLOT_KIND[slot]) {
        issues.push(
          issue(
            'cavity-unknown-part',
            part === undefined
              ? `cavity ${at(a.pin)} names ${slot} '${id}', which is not in the library`
              : `cavity ${at(a.pin)} names '${id}' as its ${slot}, but it is a ${part.kind}`,
            at(a.pin),
            'error',
          ),
        );
        structural = true;
      }
    }
    if (a.contact !== undefined && a.plug !== undefined) {
      issues.push(issue('cavity-contact-and-plug', `cavity ${at(a.pin)} has both a contact and a plug — a plug closes an unused cavity`, at(a.pin), 'error'));
      structural = true;
    }
  }
  if (structural) return issues;

  const construction = connectorConstruction(connector, db.bodies);
  if (assigned.some((a) => a.contact !== undefined || a.seal !== undefined || a.plug !== undefined) && construction !== undefined && construction !== 'crimp') {
    issues.push(issue('cavity-not-crimp', `connector '${instance.id}' (${connector.id}) is ${construction}, not crimp, but has contacts or seals assigned`, instance.id, 'warning'));
  }

  for (const row of cavityRows(design, db, instance.id)) {
    const where = at(row.pin);
    for (const part of [row.contact, row.seal, row.plug]) {
      if (part !== undefined && fitsHousing(part, connector, db) === false) {
        issues.push(issue('cavity-part-housing', `${part.kind} '${part.id}' in cavity ${where} does not fit ${connector.id} (systems: ${(housing?.systems ?? []).join(', ') || 'none'})`, where, 'warning'));
      }
    }
    const area = totalArea(row.wires);
    const spec = row.contact?.termination;
    if (row.contact !== undefined && area !== undefined && !inRange(area, spec?.wireMinMm2, spec?.wireMaxMm2)) {
      issues.push(
        issue(
          'contact-wire-range',
          `cavity ${where}: ${area} mm² of wire (${row.wires.map((w) => `${w.segment}.${w.path}`).join(' + ')}) is outside contact '${row.contact.id}' range ${wireRangeText(spec) ?? ''}`.trimEnd(),
          where,
          'warning',
        ),
      );
    }
    for (const wire of row.wires) {
      if (wire.insulationMm === undefined) continue;
      if (row.contact !== undefined && !inRange(wire.insulationMm, spec?.insulationMinMm, spec?.insulationMaxMm)) {
        issues.push(issue('contact-insulation-range', `cavity ${where}: insulation Ø ${wire.insulationMm} mm of ${wire.segment}.${wire.path} is outside contact '${row.contact.id}' ${insulationRangeText(spec) ?? ''}`.trimEnd(), where, 'warning'));
      }
      const seal = row.seal?.termination;
      if (row.seal !== undefined && !inRange(wire.insulationMm, seal?.insulationMinMm, seal?.insulationMaxMm)) {
        issues.push(issue('seal-wire-range', `cavity ${where}: insulation Ø ${wire.insulationMm} mm of ${wire.segment}.${wire.path} is outside seal '${row.seal.id}' ${insulationRangeText(seal) ?? ''}`.trimEnd(), where, 'warning'));
      }
    }
    if (row.wires.length > 0 && row.contact === undefined) {
      issues.push(issue('cavity-no-contact', `cavity ${where} takes a wire but has no contact assigned`, where, 'warning'));
    }
    if (row.wires.length > 0 && housing?.sealing === 'per-wire' && row.seal === undefined) {
      issues.push(issue('cavity-no-seal', `cavity ${where} of a sealed housing takes a wire but has no seal`, where, 'warning'));
    }
    if (!row.used && housing?.plugUnused === true && row.plug === undefined) {
      issues.push(issue('cavity-unplugged', `unused cavity ${where} of a sealed housing has no plug`, where, 'warning'));
    }
    if (row.used && row.plug !== undefined) {
      issues.push(issue('cavity-plug-on-used', `cavity ${where} has a plug but something is landed on it`, where, 'warning'));
    }
    if (!row.used && row.contact !== undefined) {
      issues.push(issue('cavity-contact-unused', `cavity ${where} has contact '${row.contact.id}' but nothing lands on it`, where, 'warning'));
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Edits
 * ------------------------------------------------------------------ */

/** The design with one connector instance's cavity list replaced; an empty list removes the field. */
export function withCavities(design: CableDesign, instanceId: string, cavities: readonly CavityAssignment[]): CableDesign {
  const clean = cavities
    .map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== '')) as unknown as CavityAssignment)
    .filter((c) => c.contact !== undefined || c.seal !== undefined || c.plug !== undefined || c.crimpHeightMm !== undefined || c.note !== undefined);
  return {
    ...design,
    instances: {
      ...design.instances,
      connectors: design.instances.connectors.map((c) => {
        if (c.id !== instanceId) return c;
        const { cavities: _old, ...rest } = c;
        return clean.length === 0 ? rest : { ...rest, cavities: clean };
      }),
    },
  };
}

/** The design with one cavity's assignment patched (`undefined` / `''` clears a field). */
export function setCavity(
  design: CableDesign,
  instanceId: string,
  pin: string,
  patch: Partial<Omit<CavityAssignment, 'pin'>>,
): CableDesign {
  const instance = design.instances.connectors.find((c) => c.id === instanceId);
  if (instance === undefined) return design;
  const list = [...(instance.cavities ?? [])];
  const index = list.findIndex((c) => c.pin === pin);
  const merged = { ...(index < 0 ? { pin } : list[index]!), ...patch, pin } as CavityAssignment;
  if (index < 0) list.push(merged);
  else list[index] = merged;
  return withCavities(design, instanceId, list);
}

function span(spec: TerminationSpec | undefined, lo: 'wireMinMm2' | 'insulationMinMm', hi: 'wireMaxMm2' | 'insulationMaxMm'): number {
  const a = spec?.[lo];
  const b = spec?.[hi];
  return a === undefined || b === undefined ? Number.POSITIVE_INFINITY : b - a;
}

function pick(candidates: readonly MechanicalDefinition[], by: (m: MechanicalDefinition) => number): MechanicalDefinition | undefined {
  return [...candidates].sort((x, y) => by(x) - by(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
}

/**
 * "Fill all by wire gauge": every cavity of a connector instance chosen from
 * the library. A cavity a wire lands in gets the contact that fits the housing
 * and takes the wire's cross-section (and insulation Ø, where both say) — the
 * narrowest range wins, then the one of the connector's gender, then the id;
 * in a `per-wire` sealed housing, the seal for its insulation Ø. An unused
 * cavity of a housing that plugs them gets a plug that fits. A cavity
 * nothing fits is left as it was. Notes and crimp-height overrides are kept.
 */
export function fillCavities(design: CableDesign, db: Db, instanceId: string): CableDesign {
  const instance = design.instances.connectors.find((c) => c.id === instanceId);
  const connector = instance === undefined ? undefined : findConnector(db, instance.def);
  if (instance === undefined || connector === undefined) return design;
  const housing = housingOf(connector, db);
  const fitting = (kind: TerminationPartKind): MechanicalDefinition[] =>
    terminationParts(db, kind).filter((p) => fitsHousing(p, connector, db) === true);
  const contacts = fitting('contact');
  const seals = fitting('seal');
  const plugs = fitting('plug');
  const next: CavityAssignment[] = [];
  for (const row of cavityRows(design, db, instanceId)) {
    const keep: CavityAssignment = { ...(row.assignment ?? { pin: row.pin }) };
    if (row.wires.length > 0) {
      const area = totalArea(row.wires);
      const ods = row.wires.map((w) => w.insulationMm).filter((v): v is number => v !== undefined);
      const contact = pick(
        contacts.filter((c) => {
          const s = c.termination;
          if (area === undefined || !inRange(area, s?.wireMinMm2, s?.wireMaxMm2)) return false;
          return ods.every((od) => inRange(od, s?.insulationMinMm, s?.insulationMaxMm));
        }),
        (c) => span(c.termination, 'wireMinMm2', 'wireMaxMm2') * 10 + (c.termination?.gender === connector.gender ? 0 : 1),
      );
      if (contact !== undefined) keep.contact = contact.id;
      delete keep.plug;
      if (housing?.sealing === 'per-wire' && ods.length === row.wires.length && ods.length > 0) {
        const seal = pick(
          seals.filter((s) => ods.every((od) => inRange(od, s.termination?.insulationMinMm, s.termination?.insulationMaxMm))),
          (s) => span(s.termination, 'insulationMinMm', 'insulationMaxMm'),
        );
        if (seal !== undefined) keep.seal = seal.id;
      }
    } else if (!row.used && housing?.plugUnused === true) {
      const plug = pick(plugs, () => 0);
      if (plug !== undefined) {
        keep.plug = plug.id;
        delete keep.contact;
        delete keep.seal;
      }
    }
    next.push(keep);
  }
  // assignments on pins the rows do not cover (a bad pin) stay for validation to name
  for (const a of instance.cavities ?? []) if (!next.some((n) => n.pin === a.pin)) next.push(a);
  return withCavities(design, instanceId, next);
}
