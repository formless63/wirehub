/**
 * "Set up as a device": a first layout from what the design already says. The generated shell
 * becomes the device frame, each board occurrence takes the next enclosure occurrence of the same
 * board, hardware goes to the anchor its shape suggests, and each cable is routed between the
 * openings its joints reach. Everything it picks is an ordinary, editable placement.
 */

import { deviceScene, type CableDesign, type Db, type DeviceAnchor, type DeviceEnclosureResult, type DeviceLayout, type DevicePlacement, type DeviceRoute, type ParametricShape } from '@wirehub/model';

export function suggestLayout(
  design: CableDesign,
  db: Db,
  enclosure: (shellId: string) => DeviceEnclosureResult | undefined,
  hardwareShapes: ReadonlyMap<string, ParametricShape>,
): DeviceLayout {
  const mechanicals = design.instances.mechanical ?? [];
  const isShell = (m: { def: string }): boolean => (db.mechanicals ?? []).find((d) => d.id === m.def)?.enclosure !== undefined;
  // the enclosure the design already names wins over the first shell found
  const named = mechanicals.find((m) => m.id === design.device?.enclosure && isShell(m));
  const shell = named ?? mechanicals.find(isShell);
  const placements: DevicePlacement[] = [];
  const spec = shell === undefined ? undefined : (db.mechanicals ?? []).find((d) => d.id === shell.def)?.enclosure;
  // a slot the user already gave a board (the mapping table) stays that board's
  const chosen = new Map((design.device?.placements ?? []).filter((p) => p.occurrence !== undefined && spec?.occurrences.some((o) => o.id === p.occurrence)).map((p) => [p.instance, p.occurrence!]));
  const taken = new Set<string>(chosen.values());
  for (const b of design.instances.pcbas) {
    const mine = chosen.get(b.id);
    if (mine !== undefined) { placements.push({ instance: b.id, occurrence: mine }); continue; }
    const occ = spec?.occurrences.find((o) => o.pcba === b.def && !taken.has(o.id));
    if (occ !== undefined) {
      taken.add(occ.id);
      placements.push({ instance: b.id, occurrence: occ.id });
    }
  }
  const used = new Set<DeviceAnchor>();
  for (const m of mechanicals) {
    if (m.id === shell?.id) continue;
    const shape = hardwareShapes.get(m.def);
    const anchor: DeviceAnchor | undefined = shape === 'foot' ? 'feet'
      : shape === 'standoff' ? 'board-supports'
        : shape === 'screw' ? (used.has('board-mounts') ? 'lid-screws' : 'board-mounts') : undefined;
    if (anchor === undefined) continue;
    used.add(anchor);
    placements.push({ instance: m.id, anchor });
  }
  // placed devices: side by side along y, a hand-sized gap apart (edit the positions after)
  let y = 0;
  for (const sub of design.instances.subassemblies ?? []) {
    const placed = db.assemblies?.working.find((d) => d.id === sub.def);
    if (placed?.device === undefined) continue;
    const shell = (placed.instances.mechanical ?? []).find((m) => m.id === placed.device?.enclosure);
    const outer = shell === undefined ? undefined : enclosure(shell.def)?.outer;
    placements.push({ instance: sub.id, at: [0, y, 0] });
    y += (outer?.y ?? 80) + 20;
  }
  const layout: DeviceLayout = { ...(shell === undefined ? {} : { enclosure: shell.id }), placements };
  // cables: the openings their joints reach
  const scene = deviceScene({ design: { ...design, device: layout }, db, enclosure });
  const routes: DeviceRoute[] = [];
  const cables = [...(design.instances.subassemblies ?? []).filter((s) => db.assemblies?.working.find((d) => d.id === s.def)?.device === undefined).map((s) => s.id), ...design.instances.segments.map((s) => s.id)];
  for (const id of cables) {
    const ends = scene.ports.filter((p) => p.cable?.instance === id).map((p) => p.opening);
    if (ends.length >= 2) routes.push({ instance: id, a: { opening: ends[0]! }, b: { opening: ends[1]! } });
  }
  return { ...layout, ...(routes.length === 0 ? {} : { routes }) };
}
