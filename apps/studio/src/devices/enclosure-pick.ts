/**
 * Putting a generated enclosure into a design (the device view's enclosure picker and the shell
 * record's "Use in design…"): the shell becomes a `mechanical` instance and the device frame, and
 * each board instance takes an enclosure occurrence of the same board, in order. What cannot be
 * matched stays unplaced and is said, never silently dropped.
 *
 * Pure: values in, design and reasons out.
 */

import type { CableDesign, Db, DeviceLayout, DevicePlacement, DeviceVec3, EnclosureSpec, MechanicalDefinition } from '@wirehub/model';

/** Shells that carry an enclosure spec (whether generated or not: the caller says). */
export function enclosureShells(db: Db): MechanicalDefinition[] {
  return (db.mechanicals ?? []).filter((m) => m.enclosure !== undefined);
}

/**
 * Board instance → enclosure occurrence, by board identity in instance order. Instances whose
 * board the enclosure does not hold (or whose occurrences are all taken) are left out.
 */
export function autoMapOccurrences(design: CableDesign, spec: EnclosureSpec | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const b of design.instances.pcbas) {
    const occ = spec?.occurrences.find((o) => o.pcba === b.def && !taken.has(o.id));
    if (occ === undefined) continue;
    taken.add(occ.id);
    out.set(b.id, occ.id);
  }
  return out;
}

function freeId(design: CableDesign, base: string): string {
  const used = new Set([
    ...design.instances.pcbas.map((x) => x.id), ...design.instances.connectors.map((x) => x.id), ...design.instances.segments.map((x) => x.id),
    ...(design.instances.mechanical ?? []).map((x) => x.id), ...(design.instances.subassemblies ?? []).map((x) => x.id),
    ...(design.instances.breakouts ?? []).map((x) => x.id),
  ]);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * The design with `shellId` as its enclosure: the existing enclosure instance is pointed at the
 * new shell (or a new `enc` instance added), and board instances are mapped to its occurrences.
 * Board placements already naming an occurrence of the old shell are replaced; hand positions kept.
 */
export function withEnclosure(design: CableDesign, db: Db, shellId: string): CableDesign {
  const shell = (db.mechanicals ?? []).find((m) => m.id === shellId);
  const mechanicals = [...(design.instances.mechanical ?? [])];
  const current = design.device?.enclosure === undefined ? undefined : mechanicals.find((m) => m.id === design.device!.enclosure);
  let instanceId: string;
  if (current !== undefined) {
    instanceId = current.id;
    mechanicals.splice(mechanicals.indexOf(current), 1, { ...current, def: shellId });
  } else {
    const existing = mechanicals.find((m) => m.def === shellId);
    instanceId = existing?.id ?? freeId(design, 'enc');
    if (existing === undefined) mechanicals.push({ id: instanceId, def: shellId, qty: 1 });
  }
  const map = autoMapOccurrences(design, shell?.enclosure);
  const old = design.device?.placements ?? [];
  const placements: DevicePlacement[] = old.filter((p) => p.instance !== instanceId && p.occurrence === undefined && !map.has(p.instance));
  for (const [instance, occurrence] of map) placements.push({ instance, occurrence });
  const layout: DeviceLayout = { ...(design.device ?? { placements: [] }), enclosure: instanceId, placements };
  return { ...design, instances: { ...design.instances, mechanical: mechanicals }, device: layout };
}

/** Why "Set up" placed less than everything: one plain sentence per reason. */
export function setupReasons(input: {
  design: CableDesign;
  db: Db;
  layout: DeviceLayout;
  /** whether the enclosure's shell has a generated run */
  generated: boolean | undefined;
  /** scene paths placed after setup */
  placed: ReadonlySet<string>;
}): string[] {
  const { design, db, layout } = input;
  const out: string[] = [];
  const label = (pcba: string): string => db.pcbas.find((p) => p.id === pcba)?.label ?? pcba;
  const shellInstance = layout.enclosure === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === layout.enclosure);
  const shell = shellInstance === undefined ? undefined : (db.mechanicals ?? []).find((m) => m.id === shellInstance.def);
  if (design.instances.pcbas.length === 0 && (design.instances.mechanical ?? []).length === 0 && (design.instances.subassemblies ?? []).length === 0) {
    out.push('This design has no boards, hardware or placed designs to place.');
    return out;
  }
  if (shell === undefined) {
    out.push('No enclosure: pick one above to place the boards in its slots. Until then the boards are laid out side by side.');
  } else if (input.generated === false) {
    out.push(`${shell.label} has not been generated yet: generate it on its record, then set up again.`);
  } else {
    const held = [...new Set((shell.enclosure?.occurrences ?? []).map((o) => o.pcba))];
    for (const b of design.instances.pcbas) {
      if (input.placed.has(b.id)) continue;
      const p = layout.placements.find((x) => x.instance === b.id);
      if (p !== undefined) continue;
      if (!held.includes(b.def)) out.push(`${b.id} (${label(b.def)}): ${shell.label} holds no ${label(b.def)}${held.length === 0 ? '' : ` (it holds ${held.map(label).join(', ')})`}; pick a slot for it below or give it a position.`);
      else out.push(`${b.id} (${label(b.def)}): every ${label(b.def)} slot of ${shell.label} is taken; add an occurrence on the enclosure record or give it a position.`);
    }
  }
  for (const m of design.instances.mechanical ?? []) {
    if (m.id === layout.enclosure || input.placed.has(m.id) || layout.placements.some((p) => p.instance === m.id)) continue;
    const label = (db.mechanicals ?? []).find((d) => d.id === m.def)?.label ?? m.def;
    out.push(`${m.id} (${label}) is not placed: only screws, standoffs and feet with a parametric model go to the enclosure's anchors. Give it a position below if it belongs in the device.`);
  }
  return out;
}

/** Boards without a placement get positions side by side along x, a small gap apart. */
export function sideBySide(design: CableDesign, layout: DeviceLayout, size: (pcba: string) => DeviceVec3 | undefined): DevicePlacement[] {
  const placed = new Set(layout.placements.map((p) => p.instance));
  let x = 0;
  for (const p of layout.placements) if (p.at !== undefined) x = Math.max(x, p.at[0] + 60);
  const out: DevicePlacement[] = [];
  for (const b of design.instances.pcbas) {
    if (placed.has(b.id)) continue;
    out.push({ instance: b.id, at: [Math.round(x), 0, 0] });
    x += (size(b.def)?.[0] ?? 50) + 15;
  }
  return out;
}
