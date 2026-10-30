/**
 * What the device view loads besides the design: each enclosure's last generation (placements,
 * openings, its base and lid solids), each board's outline size and 3D model, each hardware
 * part's model. Everything comes from the existing endpoints (`/api/enclosures/:id`,
 * `/api/models/:kind/:id`, `/api/assets/:id`); nothing here is a second store.
 */

import { parametricModelFile, type DeviceModelFile, type ModelLinkView } from '@wirehub/editor-react';
import { deviceParts, openPlaced, type CableDesign, type Db, type DeviceEnclosureResult, type DeviceSceneNode, type DeviceVec3, type DeviceVersionPins, type ParametricShape } from '@wirehub/model';

import { workbenchModels } from '../models.browser.ts';
import { readEnclosure, type EnclosureRunView, type EnclosureView } from '../enclosures/enclosures.browser.ts';

export interface DeviceInputs {
  enclosures: Map<string, EnclosureView>;
  boardSizes: Map<string, DeviceVec3>;
  models: Map<string, DeviceModelFile>;
  /** hardware shape by mechanical id, when its model is parametric hardware */
  hardwareShapes: Map<string, ParametricShape>;
  /** why a model is missing, by model key */
  missing: Map<string, string>;
  /** a board drawn from its own native model because its linked one is not built here: what stands in, by model key */
  standIns: Map<string, string>;
  /**
   * A saved version's per-occurrence pins: scene path of a shell or board → the key
   * its pinned geometry is loaded under (`enclosures`, models) in place of its definition id.
   */
  at: Map<string, string>;
}

/** Every design the device reaches: itself and the placed designs that are devices too. */
function reach(design: CableDesign, db: Db, seen = new Set<string>(), rev?: number): { design: CableDesign; db: Db }[] {
  // a pinned placement is its saved version, read against that version's frozen library
  const key = `${design.id}@${rev ?? 'working'}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const out = [{ design, db }];
  for (const s of design.instances.subassemblies ?? []) {
    const placed = openPlaced(db, s);
    if (placed !== undefined) out.push(...reach({ ...placed.design, id: s.def }, placed.db, seen, placed.rev));
  }
  return out;
}

export const enclosureResult = (view: EnclosureView | undefined): DeviceEnclosureResult | undefined =>
  view?.run?.status === 'ok' ? (view.run.result as DeviceEnclosureResult | null) ?? undefined : undefined;

export function modelKeyOf(node: DeviceSceneNode, at?: ReadonlyMap<string, string>): string | undefined {
  // a pinned occurrence draws its own saved geometry (`DeviceInputs.at`)
  const scoped = at?.get(node.path.replace(/#lid$/, '')) ?? node.def;
  switch (node.kind) {
    case 'enclosure': return `enclosure:${scoped}:base`;
    case 'lid': return `enclosure:${scoped}:lid`;
    case 'board': return `pcbas:${scoped}`;
    case 'hardware': return `mechanicals:${node.def}`;
    default: return undefined;
  }
}

async function bytesOf(asset: string): Promise<ArrayBuffer | undefined> {
  const res = await fetch(`/api/assets/${encodeURIComponent(asset)}`, { credentials: 'same-origin' });
  return res.ok ? res.arrayBuffer() : undefined;
}

/** A saved version's pinned generation, shaped like the run `/api/enclosures/:id` answers with. */
function pinnedRunView(id: string, pin: DeviceVersionPins['enclosures'][string]): EnclosureRunView {
  return {
    enclosure: id, generatedAt: pin.generatedAt, status: 'ok', pack: pin.pack, packVersion: pin.packVersion, image: '', tool: {}, requestSha256: pin.requestSha256,
    inputs: { spec: null, sources: [] }, findings: [], outputs: pin.outputs, result: pin.result as EnclosureRunView['result'],
  };
}

/** `pins`: a saved version's geometry; its shells and boards draw as saved, not as generated since. */
export async function loadDeviceInputs(design: CableDesign, db: Db, pins?: DeviceVersionPins): Promise<DeviceInputs> {
  const designs = reach(design, db);
  const enclosures = new Map<string, EnclosureView>();
  const boardSizes = new Map<string, DeviceVec3>();
  const models = new Map<string, DeviceModelFile>();
  const hardwareShapes = new Map<string, ParametricShape>();
  const missing = new Map<string, string>();
  const standIns = new Map<string, string>();
  const at = new Map<string, string>();
  const adapter = workbenchModels();
  // a version saved with per-occurrence pins: each pinned occurrence loads under its own key; older ones pin by id
  const byId = pins?.occurrences === undefined ? pins : undefined;
  const pinnedShells = new Map<string, { id: string; pin: DeviceVersionPins['enclosures'][string] }>();
  const pinnedBoards = new Map<string, { id: string; glb: string }>();
  if (pins?.occurrences !== undefined) {
    for (const p of deviceParts(design, db)) {
      if (p.kind === 'shell') {
        const pin = pins.occurrences.enclosures[p.path];
        if (pin === undefined) continue;
        const key = `${p.def}@${pin.generatedAt}`;
        at.set(p.path, key);
        pinnedShells.set(key, { id: p.def, pin });
      } else {
        const glb = pins.occurrences.boards[p.path]?.glb;
        if (glb === undefined) continue;
        const key = `${p.def}@${glb}`;
        at.set(p.path, key);
        pinnedBoards.set(key, { id: p.def, glb });
      }
    }
  }

  const shells = new Set<string>();
  const shellSpecs = new Map<string, NonNullable<NonNullable<Db['mechanicals']>[number]['enclosure']>>();
  const boards = new Set<string>();
  const hardware = new Set<string>();
  for (const { design: d, db: within } of designs) {
    for (const m of d.instances.mechanical ?? []) {
      const def = (within.mechanicals ?? []).find((x) => x.id === m.def);
      if (def?.enclosure !== undefined) {
        shells.add(m.def);
        if (!shellSpecs.has(m.def)) shellSpecs.set(m.def, def.enclosure);
      } else hardware.add(m.def);
    }
    for (const b of d.instances.pcbas) boards.add(b.def);
  }

  const reads = new Map<string, ReturnType<typeof readEnclosure>>();
  const shellList: [key: string, id: string, pin: DeviceVersionPins['enclosures'][string] | undefined][] = [
    ...[...shells].map((id) => [id, id, byId?.enclosures[id]] as [string, string, DeviceVersionPins['enclosures'][string] | undefined]),
    ...[...pinnedShells].map(([key, { id, pin }]) => [key, id, pin] as [string, string, DeviceVersionPins['enclosures'][string]]),
  ];
  await Promise.all(shellList.map(async ([key, id, pin]) => {
    try {
      if (!reads.has(id)) reads.set(id, readEnclosure(id));
      const read = await reads.get(id)!;
      const view = pin === undefined ? read : { ...read, run: pinnedRunView(id, pin) };
      enclosures.set(key, view);
      const spec = shellSpecs.get(id);
      for (const b of spec?.boards ?? []) {
        if (boardSizes.has(b.pcba)) continue;
        const native = view.boards[b.pcba];
        if (native !== undefined && 'geometry' in native) boardSizes.set(b.pcba, [native.geometry.widthMm, native.geometry.lengthMm, native.geometry.thicknessMm]);
        else if (b.widthMm?.value != null && b.lengthMm?.value != null) boardSizes.set(b.pcba, [b.widthMm.value, b.lengthMm.value, b.thicknessMm?.value ?? 1.6]);
      }
      for (const [role, part, frame] of [['base-stl', 'base', 'stl-z-up'], ['lid-stl', 'lid', 'stl-flipped']] as const) {
        const asset = view.run?.outputs.find((o) => o.role === role)?.asset;
        const bytes = asset === undefined ? undefined : await bytesOf(asset);
        if (bytes === undefined) missing.set(`enclosure:${key}:${part}`, 'not generated');
        else models.set(`enclosure:${key}:${part}`, { bytes, mime: 'model/stl', frame });
      }
    } catch (error) {
      missing.set(`enclosure:${key}:base`, error instanceof Error ? error.message : String(error));
    }
  }));

  const modelOf = async (kind: 'pcbas' | 'mechanicals', id: string, scoped = id, glb?: string): Promise<void> => {
    const key = `${kind}:${scoped}`;
    const out = await adapter.get(kind, id);
    // a saved version's board draws the native 3D export it was saved with, not today's model link
    const pinned = glb ?? (kind === 'pcbas' ? byId?.boards[id]?.glb : undefined);
    if (pinned !== undefined) {
      const bytes = await bytesOf(pinned);
      if (bytes !== undefined) { models.set(key, { bytes, mime: 'model/gltf-binary', frame: 'glb-y-up', centre: true }); return; }
    }
    if (out.ok && out.value === null && kind === 'pcbas' && adapter.fetchNative !== undefined) {
      // no linked model: the board's own native board.glb is its model (a 404 when it has none)
      const native = await adapter.fetchNative(kind, id);
      if (native.ok) { models.set(key, { bytes: native.value.bytes, mime: 'model/gltf-binary', frame: 'glb-y-up', centre: true }); return; }
    }
    if (!out.ok || out.value === null) { missing.set(key, 'no 3D model'); return; }
    const link = out.value;
    if (link.parametric !== undefined) {
      if (kind === 'mechanicals') hardwareShapes.set(id, link.parametric.shape);
      try {
        const file = parametricModelFile(link.parametric);
        models.set(key, { ...file, frame: 'glb-y-up' });
      } catch (error) {
        missing.set(key, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (link.built === false && link.fallback !== undefined && adapter.fetchNative !== undefined) {
      // the linked model is not built here: the board's own native board.glb stands in
      const native = await adapter.fetchNative(kind, id);
      if (native.ok) {
        models.set(key, { bytes: native.value.bytes, mime: 'model/gltf-binary', frame: 'glb-y-up', centre: true });
        standIns.set(key, link.fallback.originalName);
        return;
      }
    }
    const bytes = link.built === false ? undefined : await bytesOf(link.asset);
    if (bytes === undefined) missing.set(key, 'model not built on this hub');
    // an attached native board.glb keeps its board-file coordinates: centre it on its outline;
    // a generated board model attached before links said so is one too
    else models.set(key, { bytes, mime: 'model/gltf-binary', frame: 'glb-y-up', ...(boardFileFrame(kind, link) ? { centre: true } : {}) });
  };
  await Promise.all([
    ...[...boards].map((id) => modelOf('pcbas', id)),
    ...[...pinnedBoards].map(([key, { id, glb }]) => modelOf('pcbas', id, key, glb)),
    ...[...hardware].map((id) => modelOf('mechanicals', id)),
  ]);
  return { enclosures, boardSizes, models, hardwareShapes, missing, standIns, at };
}

/** Is a linked model a board's native board.glb in its board-file coordinates? */
function boardFileFrame(kind: 'pcbas' | 'mechanicals', link: ModelLinkView): boolean {
  return link.frame === 'board-file' || (kind === 'pcbas' && link.sourceKind === 'generated');
}
