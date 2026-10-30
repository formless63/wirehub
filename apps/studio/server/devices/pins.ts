/**
 * A device version's pinned geometry: when a design with a device layout is saved as
 * a version, the generation of each shell it holds and each board's native 3D export are recorded
 * in the version file (`device`), so the revision's Device view and exports draw what was there at
 * save time, not a later generation.
 *
 * A shell's outputs are assets already (the enclosure job keeps them), so its run is copied without
 * its log. A board's `board-3d` outputs are derived data the tool-output store prunes, so the STEP
 * and GLB are copied into the assets (content-addressed: an unchanged export costs nothing).
 * Type-only imports: versions.ts calls this, and nothing here reaches api.ts.
 */

import { devicePinAt, deviceParts, openPlaced, stableJson, type CableDesign, type Db, type DesignVersionFile, type DeviceVersionPins, type PinnedEnclosureRun } from '@wirehub/model';

import type { AssetStore } from '../assets.ts';
import type { EnclosureRun } from '../enclosures/run.ts';
import type { Awaitable } from '../storage/change-set.ts';
import type { DocStore } from '../storage/doc-store.ts';
import type { ToolOutputStore } from '../tools/outputs.ts';

export interface PinDeps {
  docs?: DocStore;
  /** a pinned placement's own saved geometry (its version's `device`) */
  versions?: { read(id: string, rev: number): Awaitable<DesignVersionFile | undefined> };
  assets?: AssetStore;
  toolOutputs?: ToolOutputStore;
}

/** where the enclosure job keeps a shell's last generation (`enclosures/run.ts`, not imported: a leaf) */
const runPath = (id: string): string => `data/enclosures/${id}.json`;

/** One design a device reaches, opened: a pinned placement is its saved version with that version's frozen library. */
export interface ReachedDesign {
  design: CableDesign;
  db: Db;
  /** the saved revision a placement pins (absent: the root, or a working-copy placement) */
  rev?: number;
}

/**
 * Every design a device reaches: itself and the designs it places, recursively. A pinned
 * placement is resolved at its saved version (never the newer working copy); two placements of
 * one design at different revisions are both kept.
 */
export function reachDevices(design: CableDesign, db: Db, seen = new Set<string>(), rev?: number): ReachedDesign[] {
  const key = `${design.id}@${rev ?? 'working'}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const out: ReachedDesign[] = [{ design, db, ...(rev === undefined ? {} : { rev }) }];
  for (const s of design.instances.subassemblies ?? []) {
    const placed = openPlaced(db, s);
    if (placed !== undefined) out.push(...reachDevices({ ...placed.design, id: s.def }, placed.db, seen, placed.rev));
  }
  return out;
}

async function pinBoard(deps: PinDeps, pcba: string): Promise<DeviceVersionPins['boards'][string] | undefined> {
  if (deps.toolOutputs === undefined) return undefined;
  const run = (await deps.toolOutputs.runs(`pcbas/${pcba}`, { limit: 20 })).find((r) => r.op === 'board-3d' && r.status === 'ok');
  if (run === undefined) return undefined;
  const out: DeviceVersionPins['boards'][string] = { from: `${run.tool.name} ${run.tool.version}, ${run.createdAt.slice(0, 10)}` };
  if (deps.assets === undefined) return undefined;
  for (const [role, key, mime] of [['model-step', 'step', 'model/step'], ['model-glb', 'glb', 'model/gltf-binary']] as const) {
    const o = run.outputs.find((x) => x.role === role);
    const file = o === undefined ? undefined : await deps.toolOutputs.file(o.sha256);
    if (o === undefined || file === undefined) continue;
    let bytes = file.bytes;
    if (key === 'glb') {
      // the view draws the board's native GLB in millimetres, as `/api/models/pcbas/:id/native` serves it
      try {
        const { convertModel } = await import('../models/convert.ts');
        bytes = (await convertModel(file.bytes, 'board.glb')).glb;
      } catch {
        continue;
      }
    }
    // content-addressed: an earlier save of the same export is already there
    const stored = await deps.assets.put(Buffer.from(bytes), mime, `${pcba}-board.${key}`, `Board 3D export of ${pcba} (${out.from}), kept for a device version`);
    out[key] = stored.id;
  }
  return out.step === undefined && out.glb === undefined ? undefined : out;
}

/**
 * The pins for a version of `design` (undefined: no device layout, or nothing to pin), per
 * occurrence and, for older readers, by id (the first occurrence's). A part of
 * the root or of a working-copy placement pins today's generation; a part under a pinned placement
 * takes the geometry that placement's saved version pinned for it, or today's only when its frozen
 * definition is still the live one (else it is left unpinned rather than given newer geometry).
 */
export async function captureDevicePins(deps: PinDeps, design: CableDesign, db: Db): Promise<DeviceVersionPins | undefined> {
  if (design.device === undefined) return undefined;
  type BoardPin = DeviceVersionPins['boards'][string];
  const enclosures: DeviceVersionPins['enclosures'] = {};
  const boards: DeviceVersionPins['boards'] = {};
  const at: NonNullable<DeviceVersionPins['occurrences']> = { enclosures: {}, boards: {} };
  const same = (a: unknown, b: unknown): boolean => a !== undefined && b !== undefined && stableJson(a) === stableJson(b);
  const savedPins = new Map<string, Promise<DeviceVersionPins | undefined>>();
  const savedOf = (def: string, rev: number): Promise<DeviceVersionPins | undefined> => {
    const key = `${def}@${rev}`;
    if (!savedPins.has(key)) savedPins.set(key, Promise.resolve(deps.versions?.read(def, rev)).then((f) => f?.device));
    return savedPins.get(key)!;
  };
  // today's generation of a shell or board, read once
  const todays = new Map<string, Promise<PinnedEnclosureRun | BoardPin | undefined>>();
  const today = (kind: 'shell' | 'board', id: string): Promise<PinnedEnclosureRun | BoardPin | undefined> => {
    const key = `${kind}:${id}`;
    if (!todays.has(key)) {
      todays.set(key, kind === 'board' ? pinBoard(deps, id) : (async () => {
        const run = (await deps.docs?.read(runPath(id))) as EnclosureRun | undefined;
        if (run?.status !== 'ok') return undefined;
        return { generatedAt: run.generatedAt, pack: run.pack, packVersion: run.packVersion, requestSha256: run.requestSha256, outputs: run.outputs, result: run.result };
      })());
    }
    return todays.get(key)!;
  };
  for (const p of deviceParts(design, db)) {
    const kind = p.kind === 'shell' ? 'enclosures' : 'boards';
    let pin: PinnedEnclosureRun | BoardPin | undefined;
    if (p.pinned === undefined) pin = await today(p.kind, p.def);
    else {
      const saved = devicePinAt(await savedOf(p.pinned.def, p.pinned.rev), kind, p.path.slice(p.pinned.prefix.length + 1), p.def);
      const list = (x: Db): { id: string }[] => (p.kind === 'shell' ? x.mechanicals ?? [] : x.pcbas);
      if (saved !== undefined) pin = saved;
      else if (same(list(p.db).find((x) => x.id === p.def), list(db).find((x) => x.id === p.def))) pin = await today(p.kind, p.def);
    }
    if (pin === undefined) continue;
    (at[kind] as Record<string, unknown>)[p.path] = pin;
    const byId = (kind === 'enclosures' ? enclosures : boards) as Record<string, unknown>;
    if (!(p.def in byId)) byId[p.def] = pin;
  }
  const sorted = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (Object.keys(at.enclosures).length === 0 && Object.keys(at.boards).length === 0) return undefined;
  return { enclosures: sorted(enclosures), boards: sorted(boards), occurrences: { enclosures: sorted(at.enclosures), boards: sorted(at.boards) } };
}

/** A pinned generation, shaped as the enclosure run readers expect (no log, no inputs: the version froze the spec). */
export function pinnedRun(shell: string, pin: PinnedEnclosureRun): EnclosureRun {
  return {
    enclosure: shell, generatedAt: pin.generatedAt, status: 'ok', pack: pin.pack, packVersion: pin.packVersion, image: '', tool: {},
    requestSha256: pin.requestSha256, inputs: { spec: undefined as unknown as EnclosureRun['inputs']['spec'], sources: [] }, findings: [], outputs: pin.outputs, result: pin.result, log: '',
  };
}
