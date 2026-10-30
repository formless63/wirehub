/**
 * A device → the `device-assemble` request the enclosure pack reads (`tools/enclosure/assemble.py`).
 *
 * The placement is the model's: `deviceScene` composes the design (its working copy or one saved
 * version) with each shell's last ok generation, exactly as the Device view draws it. This file only
 * says what to draw each node with, best first:
 *
 * - enclosure base / lid: the generation's own STEP solids (`base-step`, `lid-step`);
 * - a board: its native STEP from the newest ok `board-3d` run of the `kicad` pack, else the
 *   outline and footprint boxes the enclosure request is built from, else a box of its declared size;
 * - hardware: its parametric model (screw, standoff, foot), else a small marked box;
 * - a cable: its schematic route as a tube.
 *
 * What is drawn approximately is marked `provisional` on the part and said in a finding; nothing is
 * refused for missing a model. The bytes are pinned by sha256 here and fetched by the job.
 */

import {
  devicePinAt, deviceParts, deviceScene, enclosureAnchors, openingFrame, openPlaced, versionDb,
  type CableDesign, type Db, type DeviceEnclosureResult, type DeviceSceneNode, type DeviceVec3, type DeviceVersionPins,
} from '@wirehub/model';
import { deriveBom } from '@wirehub/docs';

import type { WorkbenchDeps } from '../api.ts';
import { withDesignLibrary } from '../assemblies.ts';
import { nativeLookupOf } from '../enclosures/api.ts';
import { buildEnclosureRequest } from '../enclosures/request.ts';
import { enclosureRunPath, type EnclosureRun } from '../enclosures/run.ts';
import { pinnedRun } from './pins.ts';

/** Where the job reads an input's bytes from. */
export type DeviceInputSource = { kind: 'asset'; id: string } | { kind: 'tool-output'; sha256: string };

export interface DeviceExportInput {
  /** path under /work/in */
  path: string;
  sha256: string;
  /** what it is, for the run's sources: `enclosure-base`, `enclosure-lid`, `board-step` */
  role: string;
  /** the record it came from (`mechanicals/<id>`, `pcbas/<id>`) */
  record: string;
  from: DeviceInputSource;
}

export interface DeviceFindingOut { level: 'info' | 'warn' | 'error'; message: string }

export interface DeviceExportRequest {
  design: { id: string; rev?: number };
  label: string;
  params: Record<string, unknown>;
  inputs: DeviceExportInput[];
  findings: DeviceFindingOut[];
  by?: string;
}

const isStep = (o: { role: string }): boolean => o.role === 'base-step' || o.role === 'lid-step';

/** The design (working copy or saved version) and the library it renders against. */
export async function deviceDesign(deps: WorkbenchDeps, id: string, rev?: number): Promise<{ design: CableDesign; db: Db; savedAt?: string; pins?: DeviceVersionPins } | { missing: string }> {
  const live = await deps.loadDb();
  if (rev !== undefined) {
    const file = await deps.versions?.read(id, rev);
    if (file === undefined) return { missing: `'${id}' has no saved Rev ${rev}.` };
    const db = await withDesignLibrary(deps, file.design, versionDb(file.definitions, live));
    return { design: file.design, db, savedAt: file.savedAt, ...(file.device === undefined ? {} : { pins: file.device }) };
  }
  const design = await deps.designs.read(id);
  if (design === undefined) return { missing: `There is no design '${id}'.` };
  return { design, db: await withDesignLibrary(deps, design, live) };
}

/** Every design a device reaches (itself and the placed designs that are devices too). */
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

const round = (n: number): number => Math.round(n * 1000) / 1000;

export async function buildDeviceExport(deps: WorkbenchDeps, design: CableDesign, db: Db, rev: number | undefined, today: string, pins?: DeviceVersionPins): Promise<DeviceExportRequest | { problem: string }> {
  if (design.device === undefined) return { problem: 'This design has no device layout yet: open its Device view and set it up first.' };
  const findings: DeviceFindingOut[] = [];
  const native = nativeLookupOf(deps);
  const designs = reach(design, db);
  const held = deviceParts(design, db);

  // ---- each shell's last generation (a saved version: its pin per occurrence), its board dummies and the boards' sizes ----
  const runs = new Map<string, EnclosureRun>();
  const dummies = new Map<string, Record<string, unknown>>();
  const sizes = new Map<string, DeviceVec3>();
  // shell id → its spec as the design that places it reads it (a pinned placement: its frozen one)
  const shells = new Map<string, { spec: NonNullable<NonNullable<Db['mechanicals']>[number]['enclosure']>; db: Db }>();
  for (const p of held) {
    const spec = p.kind === 'shell' ? (p.db.mechanicals ?? []).find((x) => x.id === p.def)?.enclosure : undefined;
    if (spec !== undefined && !shells.has(p.def)) shells.set(p.def, { spec, db: p.db });
  }
  const live = new Map<string, EnclosureRun | undefined>();
  for (const p of held) {
    if (p.kind !== 'shell') continue;
    // a saved version draws the generation it was saved with
    const pinned = devicePinAt(pins, 'enclosures', p.path, p.def);
    if (pinned === undefined && !live.has(p.def)) live.set(p.def, (await deps.docs?.read(enclosureRunPath(p.def))) as EnclosureRun | undefined);
    const run = pinned !== undefined ? pinnedRun(p.def, pinned) : live.get(p.def);
    if (run?.status === 'ok') runs.set(p.path, run);
  }
  for (const [, { spec, db: shellDb }] of shells) {
    const built = await buildEnclosureRequest(spec, shellDb.pcbas, native);
    for (const b of (built.params['boards'] as Record<string, unknown>[]) ?? []) {
      const id = String(b['id']);
      if (!dummies.has(id)) dummies.set(id, b);
      if (!sizes.has(id)) {
        const xs = (b['outline'] as [number, number][]).map((p) => p[0]);
        const ys = (b['outline'] as [number, number][]).map((p) => p[1]);
        sizes.set(id, [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Number(b['thickness'] ?? 1.6)]);
      }
    }
  }
  const enclosure = (_id: string, path: string): DeviceEnclosureResult | undefined => (runs.get(path)?.result ?? undefined) as DeviceEnclosureResult | undefined;
  const scene = deviceScene({ design, db, enclosure, boardSize: (id) => sizes.get(id) });
  for (const i of scene.issues) if (i.level !== 'info') findings.push({ level: 'warn', message: i.message });

  // ---- inputs, deduplicated by content ----
  const inputs = new Map<string, DeviceExportInput>();
  const input = (sha256: string, role: string, record: string, from: DeviceInputSource): string => {
    const path = `inputs/${role}-${sha256.slice(0, 16)}.step`;
    if (!inputs.has(path)) inputs.set(path, { path, sha256, role, record, from });
    return path;
  };
  const boardStep = new Map<string, { sha256: string; label: string; asset?: boolean } | null>();
  const boardStepOf = async (pcba: string, path: string): Promise<{ sha256: string; label: string; asset?: boolean } | null> => {
    const pin = devicePinAt(pins, 'boards', path, pcba);
    if (pin?.step !== undefined) return { sha256: pin.step, label: `board.step of ${pin.from}`, asset: true };
    if (boardStep.has(pcba)) return boardStep.get(pcba)!;
    let found: { sha256: string; label: string } | null = null;
    const runs3d = deps.toolOutputs === undefined ? [] : (await deps.toolOutputs.runs(`pcbas/${pcba}`, { limit: 20 })).filter((r) => r.op === 'board-3d' && r.status === 'ok');
    for (const r of runs3d) {
      const out = r.outputs.find((o) => o.role === 'model-step');
      if (out !== undefined) { found = { sha256: out.sha256, label: `${r.tool.name} ${r.tool.version} board.step of ${r.createdAt.slice(0, 10)}` }; break; }
    }
    boardStep.set(pcba, found);
    return found;
  };
  const hardware = new Map<string, Record<string, unknown> | null>();
  const hardwareOf = async (def: string): Promise<Record<string, unknown> | null> => {
    if (hardware.has(def)) return hardware.get(def)!;
    const link = await deps.modelLinks?.get(`mechanicals/${def}`);
    const p = link?.parametric;
    const value = p !== undefined && (p.shape === 'screw' || p.shape === 'standoff' || p.shape === 'foot') ? { type: 'hardware', shape: p.shape, params: p.params } : null;
    hardware.set(def, value);
    return value;
  };

  const parts: Record<string, unknown>[] = [];
  const approximate: string[] = [];
  const groupOf = (node: DeviceSceneNode): string | undefined => (node.path.includes('/') ? node.path.split('/')[0] : undefined);
  for (const node of scene.nodes) {
    if (node.kind === 'assembly') continue;
    const base = {
      path: node.path, kind: node.kind, label: node.label, def: node.def,
      ...(groupOf(node) === undefined ? {} : { group: groupOf(node) }),
      ...(node.matrix === undefined ? {} : { matrix: node.matrix.map((r) => r.map(round)) }),
    };
    if (node.kind === 'enclosure' || node.kind === 'lid') {
      const run = runs.get(node.kind === 'lid' ? node.path.replace(/#lid$/, '') : node.path);
      const out = run?.outputs.find((o) => isStep(o) && o.role === (node.kind === 'lid' ? 'lid-step' : 'base-step'));
      if (out?.asset === undefined) {
        findings.push({ level: 'warn', message: `${node.label}: the enclosure has no generated ${node.kind === 'lid' ? 'lid' : 'base'} STEP; generate it on its record, then export again.` });
        continue;
      }
      const path = input(out.sha256, node.kind === 'lid' ? 'enclosure-lid' : 'enclosure-base', `mechanicals/${node.def}`, { kind: 'asset', id: out.asset });
      parts.push({ ...base, geometry: { type: 'step', input: path, frame: 'as-is' } });
      continue;
    }
    if (node.kind === 'board') {
      const step = await boardStepOf(node.def, node.path);
      if (step !== null) {
        const path = input(step.sha256, 'board-step', `pcbas/${node.def}`, step.asset === true ? { kind: 'asset', id: step.sha256 } : { kind: 'tool-output', sha256: step.sha256 });
        parts.push({ ...base, ...(node.size === undefined ? {} : { size: node.size }), geometry: { type: 'step', input: path, frame: 'board' } });
        continue;
      }
      const dummy = dummies.get(node.def);
      if (dummy !== undefined) {
        parts.push({ ...base, provisional: 'no board STEP: drawn from its outline and part boxes', geometry: { type: 'board', outline: dummy['outline'], thickness: dummy['thickness'], components: dummy['components'] } });
      } else {
        const size = node.size ?? [50, 30, 1.6];
        parts.push({ ...base, provisional: node.size === undefined ? 'size unknown: a placeholder box' : 'no board model: a box of its declared size', geometry: { type: 'box', size } });
      }
      approximate.push(node.path);
      continue;
    }
    if (node.kind === 'hardware') {
      const g = await hardwareOf(node.def);
      if (g !== null) parts.push({ ...base, geometry: g });
      else {
        parts.push({ ...base, provisional: 'no parametric model: a marker box', geometry: { type: 'box', size: [3, 3, 3] } });
        approximate.push(node.path);
      }
      continue;
    }
    if (node.kind === 'cable' && node.points !== undefined && node.points.length >= 2) {
      parts.push({ ...base, provisional: 'schematic route', geometry: { type: 'tube', points: node.points.map((p) => p.map(round)), radius: 2.2 } });
    }
  }
  if (parts.length === 0) return { problem: 'Nothing in this device can be drawn yet: place its boards or generate its enclosure first.' };
  const boards = new Set(scene.nodes.filter((n) => n.kind === 'board').map((n) => n.def));
  const withoutStep = [...boards].filter((b) => boardStep.get(b) === null);
  if (withoutStep.length > 0) findings.push({ level: 'info', message: `No native board STEP for ${withoutStep.join(', ')}: drawn from the outline${deps.toolOutputs === undefined ? '' : '; run the board\'s 3D output (Native outputs on its record) for its real parts'}.` });

  let items: { qty: number | string; label: string }[] = [];
  try {
    items = deriveBom(design, db).lines.map((l) => ({ qty: l.qty, label: `${l.label}${(l.partNumber ?? '') === '' ? '' : ` · ${l.partNumber}`}` }));
  } catch {
    // a design the BOM cannot derive still exports; its sheet has no parts list
  }
  // the sheet's tables: each enclosure's openings, board standoffs, lid screws and the feet, in the sheet's frame
  const mul = (m: number[][], p: [number, number, number]): number[] => [0, 1, 2].map((i) => round(m[i]![0]! * p[0] + m[i]![1]! * p[1] + m[i]![2]! * p[2] + m[i]![3]!));
  const turn = (m: number[][], v: [number, number, number]): number[] => [0, 1, 2].map((i) => m[i]![0]! * v[0] + m[i]![1]! * v[1] + m[i]![2]! * v[2]);
  const compose = (a: number[][], b: number[][]): number[][] => [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => [0, 1, 2, 3].reduce((acc, k) => acc + (a[i]?.[k] ?? (i === k ? 1 : 0)) * (b[k]?.[j] ?? (k === j ? 1 : 0)), 0)));
  // a placement is rotation + translation: its inverse is the transposed rotation and the turned-back offset
  const invert = (m: number[][]): number[][] => {
    const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j]![i]!));
    const t = [0, 1, 2].map((i) => -(r[i]![0]! * m[0]![3]! + r[i]![1]! * m[1]![3]! + r[i]![2]! * m[2]![3]!));
    return [[...r[0]!, t[0]!], [...r[1]!, t[1]!], [...r[2]!, t[2]!], [0, 0, 0, 1]];
  };
  const FACES: [string, number[]][] = [['front', [0, -1, 0]], ['back', [0, 1, 0]], ['left', [-1, 0, 0]], ['right', [1, 0, 0]], ['lid', [0, 0, 1]]];
  const ownerOf = (node: DeviceSceneNode): CableDesign | undefined => {
    if (node.parent === undefined) return design;
    const sub = scene.nodes.find((n) => n.path === node.parent && n.kind === 'assembly');
    return sub === undefined ? undefined : designs.find((d) => d.design.id === sub.def)?.design;
  };
  const tables = async (within: (n: DeviceSceneNode) => boolean, frame: number[][]): Promise<Record<string, Record<string, unknown>[]>> => {
    const openings: Record<string, unknown>[] = [];
    const mounts: Record<string, unknown>[] = [];
    const fasteners: Record<string, unknown>[] = [];
    for (const node of scene.nodes) {
      if (!within(node) || node.matrix === undefined) continue;
      const m = compose(frame, node.matrix);
      if (node.kind === 'hardware') {
        const g = await hardwareOf(node.def);
        const anchor = ownerOf(node)?.device?.placements.find((p) => p.instance === node.instance)?.anchor;
        if (anchor !== 'feet' && g?.['shape'] !== 'foot') continue;
        const d = g?.['shape'] === 'foot' ? Number((g['params'] as Record<string, unknown> | undefined)?.['diameterMm']) : NaN;
        fasteners.push({ kind: 'foot', label: node.label, at: mul(m, [0, 0, 0]), ...(Number.isFinite(d) ? { d } : {}) });
        continue;
      }
      if (node.kind !== 'enclosure') continue;
      const result = enclosure(node.def, node.path);
      if (result === undefined) continue;
      for (const o of result.openings ?? []) {
        const f = openingFrame(result, o);
        if (f === undefined) continue;
        const n = turn(m, f.normal);
        const face = FACES.reduce((best, cur) => (cur[1].reduce((a, v, i) => a + v * n[i]!, 0) > best[1].reduce((a, v, i) => a + v * n[i]!, 0) ? cur : best))[0];
        openings.push({ label: o.label ?? o.id, face, center: mul(m, f.centre), width: o.width, height: o.height, shape: o.shape ?? 'rect' });
      }
      for (const sup of result.supports ?? []) {
        if (sup.kind !== 'board-hole') continue;
        const d = (sup as { pilotDiameter?: number }).pilotDiameter;
        mounts.push({ label: sup.occurrence, at: mul(m, [sup.x, sup.y, sup.z ?? 0]), ...(d === undefined ? {} : { d }) });
      }
      const posts = (result.lidPosts ?? []) as { pilotDiameter?: number }[];
      enclosureAnchors(result, 'lid-screws', () => undefined).forEach((p, i) => {
        const d = posts[i]?.pilotDiameter;
        fasteners.push({ kind: 'lid-screw', label: `${node.label} lid screw ${i + 1}`, at: mul(m, p), ...(d === undefined ? {} : { d }) });
      });
    }
    return { ...(openings.length === 0 ? {} : { openings }), ...(mounts.length === 0 ? {} : { mounts }), ...(fasteners.length === 0 ? {} : { fasteners }) };
  };
  const IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const main = await tables(() => true, IDENTITY);
  // a sheet per nested sub-device (any depth): its own parts in its own frame, its own parts list
  const sheets: Record<string, unknown>[] = [];
  for (const sub of scene.nodes) {
    if (sub.kind !== 'assembly' || sub.matrix === undefined) continue;
    const inner = (n: DeviceSceneNode): boolean => n.path.startsWith(`${sub.path}/`);
    if (!scene.nodes.some((n) => inner(n) && n.kind !== 'assembly' && n.kind !== 'cable')) continue;
    const reached = designs.find((d) => d.design.id === sub.def);
    const placed = reached?.design;
    let subItems: { qty: number | string; label: string }[] = [];
    try {
      if (reached !== undefined) subItems = deriveBom(reached.design, reached.db).lines.map((l) => ({ qty: l.qty, label: `${l.label}${(l.partNumber ?? '') === '' ? '' : ` · ${l.partNumber}`}` }));
    } catch {
      // no parts list on that sheet
    }
    const frame = invert(sub.matrix);
    sheets.push({
      path: sub.path,
      frame: frame.map((r) => r.map(round)),
      title: placed?.label ?? sub.label,
      subtitle: `as ${sub.path} in ${design.label}`,
      items: subItems,
      ...(await tables(inner, frame)),
    });
  }
  const revision = rev === undefined ? 'unreleased' : `Rev ${rev}`;
  return {
    design: { id: design.id, ...(rev === undefined ? {} : { rev }) },
    label: design.label,
    params: {
      title: design.label,
      date: today,
      parts,
      drawing: {
        title: design.label,
        subtitle: `${revision} · ${scene.nodes.filter((n) => n.kind === 'board').length} board(s)`,
        revision,
        date: today,
        source: 'WireHub device layout',
        items,
        ...main,
        ...(sheets.length === 0 ? {} : { sheets }),
      },
    },
    inputs: [...inputs.values()],
    findings,
  };
}
