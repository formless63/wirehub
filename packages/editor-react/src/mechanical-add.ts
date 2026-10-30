/**
 * Shells and hardware from the Parts palette: a mechanical
 * instance is not a canvas node, so adding one is a design edit of its own.
 * The same loose part added again counts up (four screws are one line with
 * `qty` 4); a part attached to something stays its own instance.
 */

import { designInstances, type CableDesign, type MechanicalDefinition } from '@wirehub/model';

/** The mechanical kinds the palette offers: the crimp parts (contact, seal, plug, tool) are picked per cavity instead. */
export const PALETTE_MECHANICAL_KINDS: ReadonlySet<MechanicalDefinition['kind']> = new Set(['shell', 'fastener', 'boot', 'other']);

export function addMechanical(design: CableDesign, def: string): { design: CableDesign; id: string; description: string } {
  const mechanicals = design.instances.mechanical ?? [];
  const loose = mechanicals.find((m) => m.def === def && m.attachedTo === undefined);
  if (loose !== undefined) {
    const qty = loose.qty + 1;
    return {
      design: { ...design, instances: { ...design.instances, mechanical: mechanicals.map((m) => (m === loose ? { ...m, qty } : m)) } },
      id: loose.id,
      description: `${def}: ${loose.id} now ${qty}`,
    };
  }
  const taken = new Set([...designInstances(design).map((i) => i.id), ...mechanicals.map((m) => m.id), ...(design.instances.breakouts ?? []).map((b) => b.id)]);
  let n = 1;
  while (taken.has(`m${n}`)) n += 1;
  const id = `m${n}`;
  return {
    design: { ...design, instances: { ...design.instances, mechanical: [...mechanicals, { id, def, qty: 1 }] } },
    id,
    description: `add hardware ${def} as ${id}`,
  };
}
