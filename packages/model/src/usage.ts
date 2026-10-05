/**
 * Who uses a definition — "where used".
 *
 * The studio's `GET /api/definitions/:kind/:id/usage` (the delete refusal and
 * the Library's usage chip) and the Library tables' "Used" column read this
 * one function, so the count in a table row and the list on the record's page
 * can never disagree.
 *
 * The edges: a design instantiates connectors, components, wire stocks,
 * boards and mechanicals; boards integrate connectors; a connector is built
 * on a body and carries a pinout, so a body or pinout is used by the designs
 * of every connector on it (and of every board those connectors are soldered
 * to); pinouts name their bodies; a body names its mate; kits ship parts;
 * a design's cavities hold contacts, seals and plugs, and a contact names the
 * tool that crimps it (`crimp.ts`).
 */

import { KIT_PART_KINDS, kitsContaining, type KitPartKind } from './kits.ts';
import type { CableDesign, Db } from './model.ts';

export type UsageKind = 'connectors' | 'components' | 'wires' | 'pcbas' | 'bodies' | 'interfaces' | 'mechanicals' | 'kits';

export interface DefinitionUse {
  designs: { id: string; label: string }[];
  /** other definitions that name it, as `pcbas/PCA-00110-rev4` */
  definitions: string[];
}

const KIT_PART_OF: Partial<Record<UsageKind, KitPartKind>> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire',
  pcbas: 'pcba',
  mechanicals: 'mechanical',
};

type DesignLike = Pick<CableDesign, 'id' | 'label' | 'instances'>;

/** Whether a design puts this part in a cavity (a contact, seal or plug). */
function inCavities(design: DesignLike, id: string): boolean {
  return design.instances.connectors.some((c) => (c.cavities ?? []).some((a) => a.contact === id || a.seal === id || a.plug === id));
}

/** Which instance list of a design points at this kind of definition. */
function instancesFor(design: DesignLike, kind: UsageKind): readonly { def: string }[] {
  switch (kind) {
    case 'connectors':
      return design.instances.connectors;
    case 'components':
      return design.instances.components;
    case 'wires':
      return design.instances.segments;
    case 'pcbas':
      return design.instances.pcbas;
    case 'mechanicals':
      return design.instances.mechanical ?? [];
    case 'bodies':
    case 'interfaces':
    case 'kits':
      return [];
  }
}

export function definitionUsage(db: Db, designs: readonly DesignLike[], kind: UsageKind, id: string): DefinitionUse {
  const viaConnectors =
    kind === 'bodies'
      ? db.connectors.filter((c) => c.body === id).map((c) => c.id)
      : kind === 'interfaces'
        ? db.connectors.filter((c) => c.interface === id).map((c) => c.id)
        : [];
  const viaBoards = db.pcbas
    .filter((pcba) => (pcba.integratedConnectors ?? []).some((entry) => viaConnectors.includes(entry.connectorDefId)))
    .map((pcba) => pcba.id);
  const used = designs
    .filter(
      (design) =>
        instancesFor(design, kind).some((instance) => instance.def === id) ||
        (kind === 'mechanicals' && inCavities(design, id)) ||
        design.instances.connectors.some((instance) => viaConnectors.includes(instance.def)) ||
        design.instances.pcbas.some((instance) => viaBoards.includes(instance.def)),
    )
    .map((design) => ({ id: design.id, label: design.label }));

  const definitions: string[] = [];
  if (kind === 'connectors') {
    for (const pcba of db.pcbas) {
      if ((pcba.integratedConnectors ?? []).some((entry) => entry.connectorDefId === id)) definitions.push(`pcbas/${pcba.id}`);
    }
  }
  if (kind === 'bodies' || kind === 'interfaces') definitions.push(...viaConnectors.map((c) => `connectors/${c}`));
  if (kind === 'bodies') {
    for (const iface of db.interfaces ?? []) if (iface.bodies.includes(id)) definitions.push(`interfaces/${iface.id}`);
    for (const body of db.bodies ?? []) if (body.mates === id) definitions.push(`bodies/${body.id}`);
  }
  if (kind === 'mechanicals') {
    for (const part of db.mechanicals ?? []) if (part.termination?.tool === id) definitions.push(`mechanicals/${part.id}`);
  }
  const partKind = KIT_PART_OF[kind];
  if (partKind !== undefined && KIT_PART_KINDS.includes(partKind)) {
    for (const kit of kitsContaining(db, { kind: partKind, def: id })) definitions.push(`kits/${kit.id}`);
  }
  return { designs: used, definitions };
}

/** `definitionUsage(…).designs.length + .definitions.length` for every id — a table's "Used" column. */
export function usageCounts(db: Db, designs: readonly DesignLike[], kind: UsageKind, ids: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    const use = definitionUsage(db, designs, kind, id);
    out.set(id, use.designs.length + use.definitions.length);
  }
  return out;
}
