/**
 * The references a record makes (`specs/postgres-backend.md` §3.6): the
 * edges `ref_edge` holds, so the database can refuse to delete something
 * still used (a deferred FK, the backstop behind the model's own refusal).
 *
 * Vendored from the edges `@wirehub/model`'s `definitionUsage` (`usage.ts`)
 * walks — a design's instances, a board's integrated connectors, a
 * connector's body and pinout — plus the direct edges it reads transitively
 * or per kit: `interface-body`, `body-mate` and `kit-part`. Model links
 * (`model-record`) are `model_link.entity_id`, not edges.
 *
 * `usageFromEdges` answers "where used" from the edges alone, with the same
 * transitive rule as `definitionUsage`; a test holds the two equal over the
 * starter catalog (and the bundled packs), so the edges cannot drift from the
 * model. The model stays the answer (`/usage`); this is the backstop.
 */

import type { EntityKind } from '@wirehub/catalog/src/codec/index.ts';

export interface RefEdge {
  toKind: EntityKind;
  toSlug: string;
  role: string;
}

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null) as Json[]) : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const KIT_PART_KIND: Readonly<Record<string, EntityKind>> = {
  connector: 'connector',
  component: 'component',
  wire: 'wire',
  pcba: 'pcba',
  mechanical: 'mechanical',
};

/** Every reference a record of `kind` makes, deduplicated, in a stable order. */
export function referencesOf(kind: EntityKind, collection: string, value: unknown): RefEdge[] {
  const out = new Map<string, RefEdge>();
  const add = (toKind: EntityKind, toSlug: string | undefined, role: string): void => {
    if (toSlug === undefined) return;
    out.set(`${toKind}\u0000${toSlug}\u0000${role}`, { toKind, toSlug, role });
  };
  const v = (typeof value === 'object' && value !== null ? value : {}) as Json;
  if (kind === 'design' && collection === '') {
    const instances = (typeof v.instances === 'object' && v.instances !== null ? v.instances : {}) as Json;
    for (const i of list(instances.connectors)) add('connector', str(i.def), 'connector');
    for (const i of list(instances.components)) add('component', str(i.def), 'component');
    for (const i of list(instances.segments)) add('wire', str(i.def), 'wire');
    for (const i of list(instances.pcbas)) add('pcba', str(i.def), 'pcba');
    for (const i of list(instances.mechanical)) add('mechanical', str(i.def), 'mechanical');
  } else if (kind === 'pcba') {
    for (const entry of list(v.integratedConnectors)) add('connector', str(entry.connectorDefId), 'connector');
  } else if (kind === 'connector') {
    add('body', str(v.body), 'body');
    add('interface', str(v.interface), 'interface');
  } else if (kind === 'interface') {
    for (const body of Array.isArray(v.bodies) ? v.bodies : []) add('body', str(body), 'interface-body');
  } else if (kind === 'body') {
    add('body', str(v.mates), 'body-mate');
  } else if (kind === 'kit') {
    for (const line of list(v.contents)) {
      const part = (typeof line.part === 'object' && line.part !== null ? line.part : {}) as Json;
      const to = KIT_PART_KIND[String(part.kind)];
      if (to !== undefined) add(to, str(part.def), 'kit-part');
    }
  }
  return [...out.values()];
}

/** An edge with its source, for `usageFromEdges`. */
export interface SourcedEdge extends RefEdge {
  fromKind: EntityKind;
  fromSlug: string;
}

const USAGE_KIND: Readonly<Record<string, EntityKind>> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire',
  pcbas: 'pcba',
  bodies: 'body',
  interfaces: 'interface',
  mechanicals: 'mechanical',
  kits: 'kit',
};
const PLURAL: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(USAGE_KIND).map(([plural, kind]) => [kind, plural]));

/**
 * `definitionUsage`'s answer, computed from edges: designs (by id, labels
 * left to the caller) and definitions (`<kind>/<id>`), in the model's order
 * of discovery is not promised — callers compare sorted.
 */
export function usageFromEdges(edges: readonly SourcedEdge[], usageKind: string, id: string): { designs: string[]; definitions: string[] } {
  const kind = USAGE_KIND[usageKind];
  if (kind === undefined) return { designs: [], definitions: [] };
  const into = (toKind: EntityKind, toSlug: string, role?: string): SourcedEdge[] =>
    edges.filter((e) => e.toKind === toKind && e.toSlug === toSlug && (role === undefined || e.role === role));
  // a body or pinout is used through the connectors built on it, and the boards those connectors are soldered to
  const viaConnectors =
    kind === 'body' || kind === 'interface' ? into(kind, id, kind).filter((e) => e.fromKind === 'connector').map((e) => e.fromSlug) : [];
  const viaBoards = new Set(edges.filter((e) => e.fromKind === 'pcba' && e.toKind === 'connector' && viaConnectors.includes(e.toSlug)).map((e) => e.fromSlug));
  const designs = new Set<string>();
  for (const e of edges) {
    if (e.fromKind !== 'design') continue;
    if (e.toKind === kind && e.toSlug === id && e.role !== 'kit-part') designs.add(e.fromSlug);
    if (e.toKind === 'connector' && viaConnectors.includes(e.toSlug)) designs.add(e.fromSlug);
    if (e.toKind === 'pcba' && viaBoards.has(e.toSlug)) designs.add(e.fromSlug);
  }
  const definitions: string[] = [];
  if (kind === 'connector') for (const e of into('connector', id, 'connector')) if (e.fromKind === 'pcba') definitions.push(`pcbas/${e.fromSlug}`);
  if (kind === 'body' || kind === 'interface') definitions.push(...viaConnectors.map((c) => `connectors/${c}`));
  if (kind === 'body') {
    for (const e of into('body', id, 'interface-body')) definitions.push(`interfaces/${e.fromSlug}`);
    for (const e of into('body', id, 'body-mate')) definitions.push(`bodies/${e.fromSlug}`);
  }
  for (const e of into(kind, id, 'kit-part')) definitions.push(`${PLURAL.kit}/${e.fromSlug}`);
  return { designs: [...designs].sort(), definitions: [...new Set(definitions)].sort() };
}
