/**
 * The parts library, as an interface the editor is handed.
 *
 * `PersistenceAdapter` is how the host stores *designs*; this is how it stores
 * the *definitions* designs are made of — connectors, components, wire stocks,
 * boards. Same contract, same rules: the editor never persists anything and
 * never calls out, every method answers with an `Outcome` rather than throwing,
 * and no URL or `fetch` appears anywhere in this package.
 *
 * It is deliberately a second, separate adapter rather than more methods on the
 * first. A host can perfectly well let people edit cables while the parts
 * library stays read-only — that is what a shop floor terminal wants — and
 * expressing that as "no definitions adapter" is cleaner than an adapter whose
 * methods all say no. The Library view degrades to a browsable catalog when it
 * is missing, which is exactly right.
 */

import type {
  ComponentDefinition,
  ConnectorBody,
  ConnectorDefinition,
  Interface,
  KitDefinition,
  MechanicalDefinition,
  PcbaDefinition,
  WireDefinition,
} from '@wirehub/model';

import { problemOf, type LifecycleProblem, type Refusal } from './lifecycle.ts';
import type { Outcome } from './persistence.ts';

/**
 * Every editable file of the library, named as the host names them: the parts
 * a design instantiates, a connector's body and pinouts (edited inside the
 * connector journey —), shells and hardware, and kits
 *.
 */
export const DEFINITION_KINDS = [
  'connectors',
  'components',
  'wires',
  'pcbas',
  'bodies',
  'interfaces',
  'mechanicals',
  'kits',
] as const;

export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

/**
 * The Library's tabs. Bodies and pinouts are not tabs of their own: they are
 * the first two steps of a connector (data model v2 §8 J1), so they live on
 * the Connectors tab.
 */
export const LIBRARY_KINDS = ['connectors', 'components', 'wires', 'pcbas', 'mechanicals', 'kits'] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function isLibraryKind(value: unknown): value is LibraryKind {
  return typeof value === 'string' && (LIBRARY_KINDS as readonly string[]).includes(value);
}

export type DefinitionRecord =
  | ConnectorDefinition
  | ComponentDefinition
  | WireDefinition
  | PcbaDefinition
  | ConnectorBody
  | Interface
  | MechanicalDefinition
  | KitDefinition;

/** What each kind is called on screen. */
export const DEFINITION_LABELS: Record<DefinitionKind, string> = {
  connectors: 'Connectors',
  components: 'Components',
  wires: 'Wire stocks',
  pcbas: 'Boards',
  bodies: 'Bodies',
  interfaces: 'Pinouts',
  mechanicals: 'Shells & hardware',
  kits: 'Kits',
};

/** The singular, for a sentence that has to name one record. */
export const DEFINITION_NOUNS: Record<DefinitionKind, string> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire stock',
  pcbas: 'board',
  bodies: 'body',
  interfaces: 'pinout',
  mechanicals: 'part',
  kits: 'kit',
};

/** One line under each tab: what belongs in it, in the user's words. */
export const DEFINITION_BLURBS: Record<DefinitionKind, string> = {
  connectors: 'The plugs and sockets at the ends of a cable, and the pins each one has.',
  components: 'Loose parts soldered into a build — resistors, capacitors, switches.',
  wires: 'The cable stock itself: what the cores are made of, how thick, and the order they are laid in.',
  pcbas: 'The boards, with the pads a conductor lands on and what is joined inside.',
  bodies: 'The physical connector: shell, gender and numbered positions — no signal meaning.',
  interfaces: 'A named pinout: which signal each position of a body carries.',
  mechanicals: 'Printed shells, housings and the screws and nuts that close them.',
  kits: 'Orderable kits: one SKU and the parts it ships. Informational — cable BOMs list the parts.',
};

/** Who is using a definition — the answer the host's referential check gives. */
export interface DefinitionUsage {
  kind: DefinitionKind;
  id: string;
  designs: { id: string; label: string }[];
  /** other definitions that name it, as `pcbas/PCA-00110-rev4` */
  definitions: string[];
  count: number;
  /** connectors only: designs that mount it board-straddle vs direct-solder */
  mounting?: { straddle: number; direct: number };
}

/** One kind of definition as the host holds it. */
export interface DefinitionList {
  kind: DefinitionKind;
  /** the editable records, in the order the library grew */
  records: DefinitionRecord[];
  /** boards written by the importer: shown for reference, never edited here */
  generated?: DefinitionRecord[];
}

export interface DefinitionsAdapter {
  list(kind: DefinitionKind): Promise<Outcome<DefinitionList>>;
  /** store an existing record; the host validates the whole library before writing */
  save(kind: DefinitionKind, record: DefinitionRecord): Promise<Outcome<DefinitionRecord>>;
  /** store a record that does not exist yet; must refuse an id already in use */
  create(kind: DefinitionKind, record: DefinitionRecord): Promise<Outcome<DefinitionRecord>>;
  /**
   * Delete, with the record's own id echoed back as `confirm`. The host refuses
   * when anything still references it, and names what.
   */
  remove(kind: DefinitionKind, id: string, confirm: string): Promise<Outcome<{ id: string }>>;
  /** who uses this definition — what the "used by N designs" caution is built from */
  usage(kind: DefinitionKind, id: string): Promise<Outcome<DefinitionUsage>>;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/** What happened to the library, for the host that has to react to it. */
export type DefinitionChange =
  | { kind: 'definition-saved'; defKind: DefinitionKind; record: DefinitionRecord }
  | { kind: 'definition-created'; defKind: DefinitionKind; record: DefinitionRecord }
  | { kind: 'definition-deleted'; defKind: DefinitionKind; id: string };

export type DefinitionResult =
  | { ok: true; change: DefinitionChange; status: string }
  | { ok: false; problem: LifecycleProblem };

const ID_RULE = 'Ids are lowercase words joined by hyphens, like `scart-male` or `cap-220uf-tant`.';

function refuse(message: string, hint?: string): DefinitionResult {
  return { ok: false, problem: { message, ...(hint === undefined ? {} : { hint }), details: [] } };
}

/** The id rule, client-side — so a form can say "that will not work" while typing. */
export function isDefinitionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+|(?<=\d)\.\d[a-z0-9]*)*$/.test(value);
}

/**
 * The three things every definition owes, checked without a round trip. The
 * host checks them again and is the authority; this copy exists so the form can
 * answer immediately.
 */
export function checkDefinition(kind: DefinitionKind, record: DefinitionRecord): DefinitionResult | undefined {
  const noun = DEFINITION_NOUNS[kind];
  const id = String(record.id ?? '');
  if (!isDefinitionId(record.id)) {
    return refuse(
      id.trim() === '' ? `This ${noun} needs an id.` : `'${id}' cannot be used as an id.`,
      `${ID_RULE} The name field can suggest one for you.`,
    );
  }
  if (record.label.trim() === '') {
    return refuse(
      `This ${noun} needs a name.`,
      'Give it the words a builder will see on the schematic and the build sheet.',
    );
  }
  if (record.src.trim() === '') {
    return refuse(
      `This ${noun} needs to say where its information comes from.`,
      'Name the spec sheet, the measurement or the board you are working from — or say that the values are inferred.',
    );
  }
  return undefined;
}

function settle(
  outcome: Outcome<DefinitionRecord>,
  done: (record: DefinitionRecord) => DefinitionResult,
): DefinitionResult {
  return outcome.ok ? done(outcome.value) : { ok: false, problem: problemOf(outcome as Refusal) };
}

export async function saveDefinition(
  adapter: DefinitionsAdapter,
  kind: DefinitionKind,
  record: DefinitionRecord,
): Promise<DefinitionResult> {
  const bad = checkDefinition(kind, record);
  if (bad !== undefined) return bad;
  return settle(await adapter.save(kind, record), (saved) => ({
    ok: true,
    change: { kind: 'definition-saved', defKind: kind, record: saved },
    status: `saved ${saved.id}`,
  }));
}

export async function createDefinition(
  adapter: DefinitionsAdapter,
  kind: DefinitionKind,
  record: DefinitionRecord,
): Promise<DefinitionResult> {
  const bad = checkDefinition(kind, record);
  if (bad !== undefined) return bad;
  return settle(await adapter.create(kind, record), (created) => ({
    ok: true,
    change: { kind: 'definition-created', defKind: kind, record: created },
    status: `added ${created.id}`,
  }));
}

/**
 * Delete, confirmed.
 *
 * The confirm token is checked here so the dialog can refuse without a round
 * trip; the host's copy is what actually protects the file, and the host is
 * also the only one that can answer "is anything still using this?".
 */
export async function deleteDefinition(
  adapter: DefinitionsAdapter,
  kind: DefinitionKind,
  id: string,
  confirmation: string,
): Promise<DefinitionResult> {
  if (confirmation !== id) {
    return refuse(
      `Nothing was deleted — '${id}' was not confirmed.`,
      `To delete this ${DEFINITION_NOUNS[kind]}, confirm its id exactly: ${id}`,
    );
  }
  const outcome = await adapter.remove(kind, id, confirmation);
  if (!outcome.ok) return { ok: false, problem: problemOf(outcome as Refusal) };
  return {
    ok: true,
    change: { kind: 'definition-deleted', defKind: kind, id },
    status: `deleted ${id}`,
  };
}

/* ------------------------------------------------------------------ *
 * Saying it in words
 * ------------------------------------------------------------------ */

/**
 * The caution line above an editor: how many things an edit here will reach.
 *
 * Editing a definition is not like editing a cable — the record is shared, and
 * a change to it changes every design that names it. Saying so *before* the
 * user types is the difference between a tool that is safe to explore and one
 * that punishes exploration.
 */
export function usageSentence(usage: DefinitionUsage | undefined): string | undefined {
  if (usage === undefined || usage.count === 0) return undefined;
  const parts: string[] = [];
  if (usage.designs.length > 0) {
    parts.push(`${usage.designs.length} design${usage.designs.length === 1 ? '' : 's'}`);
  }
  if (usage.definitions.length > 0) {
    parts.push(
      `${usage.definitions.length} other definition${usage.definitions.length === 1 ? '' : 's'}`,
    );
  }
  return `Used by ${parts.join(' and ')} — changes here affect ${usage.count === 1 ? 'it' : 'them'}.`;
}

/** The referrers, named, for the caution line's detail and the delete dialog. */
export function usageNames(usage: DefinitionUsage | undefined): string[] {
  if (usage === undefined) return [];
  return [
    ...usage.designs.map((design) => `${design.id} — ${design.label}`),
    ...usage.definitions,
  ];
}
