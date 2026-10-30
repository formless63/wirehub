/**
 * Devices (WF-ASM): a design that also says where its parts sit in space. A device is an
 * ordinary design — its board occurrences are `pcbas` instances, its cables are segments or placed
 * designs (`subassemblies`), its enclosure shell and screws are `mechanical` instances — plus a
 * `device` layout: one canonical placement per instance, in millimetres, z up.
 *
 * - A board occurrence placed by an enclosure names the enclosure occurrence; its matrix is the
 *   generator's (`result.json` placements), never re-derived here.
 * - A hardware instance (`qty` screws) is placed at an anchor the enclosure defines (board
 *   mounts, lid screws, feet): one copy per anchor point, each its own identity.
 * - A placed design that is itself a device is composed recursively in its own frame: two
 *   copies of one sub-device keep distinct paths (`left/board-1`, `right/board-1`).
 * - A cable is drawn as a schematic route between port positions: an estimate, labelled so,
 *   with its declared length beside it.
 *
 * Views (exploded, section) are presentation over this result and never change it.
 *
 * Pure: values in, scene out.
 */

import { findPcba, type CableDesign, type Db, type TerminalRef } from './model.ts';
import { wireDisplayName } from './wire-display.ts';
import type { EnclosurePort } from './enclosure.ts';
import { openPlaced } from './subassemblies.ts';

export type Vec3 = [number, number, number];
/** Row-major 4×4, as the enclosure generator writes it. */
export type Mat4 = number[][];

export const DEVICE_ANCHORS = ['board-mounts', 'board-supports', 'lid-screws', 'feet'] as const;
export type DeviceAnchor = (typeof DEVICE_ANCHORS)[number];

/** Where one instance sits. Exactly one of `occurrence`, `anchor` or `at` says how. */
export interface DevicePlacement {
  instance: string;
  /** a board placed by the enclosure: the enclosure occurrence id */
  occurrence?: string;
  /** hardware: one copy at each of the enclosure's anchor points */
  anchor?: DeviceAnchor;
  /** an explicit position in the device frame, mm */
  at?: Vec3;
  /** rotation, degrees about x, then y, then z */
  rotDeg?: Vec3;
}

/** One end of a schematic cable route. */
export type DeviceRouteEnd = { opening: string } | { at: Vec3 };

/** A cable (a segment or a placed design) drawn between two port positions. */
export interface DeviceRoute {
  instance: string;
  a: DeviceRouteEnd;
  b: DeviceRouteEnd;
  /** extra bend points, device frame */
  via?: Vec3[];
}

export interface DeviceLayout {
  /** the mechanical instance that is the generated enclosure; its frame is the device frame */
  enclosure?: string;
  placements: DevicePlacement[];
  routes?: DeviceRoute[];
}

/** The part of the enclosure generator's `result.json` a device reads. */
export interface DeviceEnclosureResult {
  outer?: { x: number; y: number; z: number };
  interior?: { x: number; y: number; z: number; floorTop?: number };
  lid?: { mode?: string; explodedLift?: number };
  placements?: { occurrence: string; board: string; matrix?: Mat4; offset?: number[]; rotation?: number }[];
  /** `kind` and `z` from pack 0.2.0: a standoff under a board hole, or a corner pad under a board without holes */
  supports?: { occurrence: string; x: number; y: number; kind?: 'board-hole' | 'corner-pad'; z?: number }[];
  /** a flat lid's screw posts, screw axis (pack 0.2.0); absent in older results */
  lidPosts?: { x: number; y: number; size?: number; screwZ?: number }[];
  openings?: { id: string; occurrence?: string; port?: string; label?: string; face: string; u: number; z: number; width: number; height: number; shape?: string; manual?: boolean }[];
  params?: { wall?: number; floor?: number; standoffHeight?: number; lidThickness?: number; lid?: { mode?: string; screws?: boolean; postSize?: number } };
}

export type SceneNodeKind = 'enclosure' | 'lid' | 'board' | 'hardware' | 'assembly' | 'cable' | 'part';

/** One placed thing, with its own identity. */
export interface SceneNode {
  /** unique path: `board-1`, `screws#3`, `left/board-1`, `shell#lid` */
  path: string;
  /** the path of the node it belongs to (a lid to its shell, a copy to its sub-assembly) */
  parent?: string;
  /** the instance in the design that owns it (top level: the BOM line's provenance) */
  instance: string;
  /** the top-level instance it rolls up under in this design's BOM */
  bomInstance: string;
  kind: SceneNodeKind;
  /** the definition: a pcbas / mechanicals / designs id */
  def: string;
  label: string;
  /** device frame, row-major; absent for cables (they carry `points`) */
  matrix?: Mat4;
  /** board outline size (mm), for frame alignment and declared boxes */
  size?: Vec3;
  points?: Vec3[];
  /** why a node is shown approximately (no model, no generation, estimated route) */
  provisional?: string;
  /** for cables: declared and drawn length */
  lengthMm?: { declared?: number; route: number };
}

/** An external port: an enclosure opening, the board connector behind it and what plugs in. */
export interface DevicePortRow {
  opening: string;
  /** short: the board occurrence and connector (`board-1 · J2`), or the manual opening's label */
  label: string;
  /** the generator's own words for the opening (the footprint it was cut for) */
  detail?: string;
  face: string;
  /** opening centre and outward normal, device frame */
  centre: Vec3;
  normal: Vec3;
  board?: { path: string; instance: string; port: string; ref?: string; terminals: string[] };
  cable?: { path: string; instance: string; via: 'route' | 'joint'; terminal?: string };
  /** every cable jointed to the opening's pins, with the conductors that land there (`cable` is the first) */
  cables?: { path: string; instance: string; via: 'route' | 'joint'; terminals: string[] }[];
}

/** Advisory, like the enclosure generator's findings: a device is never refused for these. */
export interface DeviceFinding {
  code: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  /** the scene path it is about */
  where?: string;
}

export interface DeviceScene {
  nodes: SceneNode[];
  ports: DevicePortRow[];
  issues: DeviceFinding[];
}

export interface DeviceSceneInput {
  design: CableDesign;
  db: Db;
  /** the last generation of a shell, by mechanical id; `path` is the shell node's scene path (a saved version pins per occurrence) */
  enclosure: (shellId: string, path: string) => DeviceEnclosureResult | undefined;
  /** board outline size (x, y, thickness) by pcba id, when known */
  boardSize?: (pcbaId: string) => Vec3 | undefined;
}

/* ------------------------------------------------------------------ math */

export const IDENTITY: Mat4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

export function mul(a: Mat4, b: Mat4): Mat4 {
  return a.map((row) => [0, 1, 2, 3].map((j) => row[0]! * b[0]![j]! + row[1]! * b[1]![j]! + row[2]! * b[2]![j]! + row[3]! * b[3]![j]!));
}

export function translate(v: Vec3): Mat4 {
  return [[1, 0, 0, v[0]], [0, 1, 0, v[1]], [0, 0, 1, v[2]], [0, 0, 0, 1]];
}

/** Rotation by x, then y, then z degrees (R = Rz · Ry · Rx). */
export function rotate(deg: Vec3): Mat4 {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180) as Vec3;
  const rx: Mat4 = [[1, 0, 0, 0], [0, Math.cos(x), -Math.sin(x), 0], [0, Math.sin(x), Math.cos(x), 0], [0, 0, 0, 1]];
  const ry: Mat4 = [[Math.cos(y), 0, Math.sin(y), 0], [0, 1, 0, 0], [-Math.sin(y), 0, Math.cos(y), 0], [0, 0, 0, 1]];
  const rz: Mat4 = [[Math.cos(z), -Math.sin(z), 0, 0], [Math.sin(z), Math.cos(z), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  return mul(rz, mul(ry, rx));
}

export function apply(m: Mat4, p: Vec3): Vec3 {
  return [0, 1, 2].map((i) => m[i]![0]! * p[0] + m[i]![1]! * p[1] + m[i]![2]! * p[2] + m[i]![3]!) as Vec3;
}

function applyDir(m: Mat4, v: Vec3): Vec3 {
  return [0, 1, 2].map((i) => m[i]![0]! * v[0] + m[i]![1]! * v[1] + m[i]![2]! * v[2]) as Vec3;
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const round = (n: number): number => Math.round(n * 1000) / 1000;

export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  return round(total);
}

function placementMatrix(p: DevicePlacement): Mat4 {
  return mul(translate(p.at ?? [0, 0, 0]), rotate(p.rotDeg ?? [0, 0, 0]));
}

/* ------------------------------------------------------------------ problems */

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural problems that make a layout unrepresentable (the save gate); everything else is a finding. */
export function deviceLayoutProblems(value: unknown): string[] {
  if (!isObj(value)) return ['The device layout is not in the right form ({ enclosure?, placements, routes? }).'];
  const out: string[] = [];
  if (value['enclosure'] !== undefined && (typeof value['enclosure'] !== 'string' || !ID.test(value['enclosure']))) out.push('The device enclosure names no instance.');
  const placements = value['placements'];
  if (!Array.isArray(placements)) out.push('The device layout has no placements list.');
  const seen = new Set<string>();
  for (const [i, p] of (Array.isArray(placements) ? placements : []).entries()) {
    const at = `Placement ${i + 1}`;
    if (!isObj(p) || typeof p['instance'] !== 'string' || !ID.test(p['instance'])) { out.push(`${at} names no instance.`); continue; }
    if (seen.has(p['instance'])) out.push(`${at}: ${p['instance']} is placed twice.`);
    seen.add(p['instance']);
    const how = ['occurrence', 'anchor', 'at'].filter((k) => p[k] !== undefined);
    if (how.length > 1) out.push(`${at}: say one of occurrence, anchor or at.`);
    if (p['occurrence'] !== undefined && typeof p['occurrence'] !== 'string') out.push(`${at}: occurrence is an enclosure occurrence id.`);
    if (p['anchor'] !== undefined && !(DEVICE_ANCHORS as readonly unknown[]).includes(p['anchor'])) out.push(`${at}: anchor is one of ${DEVICE_ANCHORS.join(', ')}.`);
    if (p['at'] !== undefined && !isVec(p['at'])) out.push(`${at}: at is [x, y, z] in millimetres.`);
    if (p['rotDeg'] !== undefined && !isVec(p['rotDeg'])) out.push(`${at}: rotDeg is [x, y, z] in degrees.`);
  }
  const routes = value['routes'];
  if (routes !== undefined) {
    if (!Array.isArray(routes)) out.push('Routes is a list.');
    else for (const [i, r] of routes.entries()) {
      const at = `Route ${i + 1}`;
      if (!isObj(r) || typeof r['instance'] !== 'string') { out.push(`${at} names no cable.`); continue; }
      for (const end of ['a', 'b']) {
        const e = r[end];
        if (!isObj(e) || (typeof e['opening'] !== 'string' && !isVec(e['at']))) out.push(`${at} end ${end} is { opening } or { at: [x, y, z] }.`);
      }
      if (r['via'] !== undefined && !(Array.isArray(r['via']) && r['via'].every(isVec))) out.push(`${at}: via is a list of [x, y, z].`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ scene */

const PLUG_MM = 12;
const LEAD_MM = 25;

interface Ctx {
  input: DeviceSceneInput;
  nodes: SceneNode[];
  ports: DevicePortRow[];
  issues: DeviceFinding[];
  stack: string[];
}

/** Anchor points of an enclosure, enclosure frame. */
export function enclosureAnchors(result: DeviceEnclosureResult, anchor: DeviceAnchor, boardTop: (occurrence: string) => number | undefined): Vec3[] {
  const p = result.params ?? {};
  const floor = p.floor ?? 2;
  const standoff = p.standoffHeight ?? 5;
  const outer = result.outer;
  const interior = result.interior;
  const wall = p.wall ?? 2;
  switch (anchor) {
    case 'board-mounts':
      // a screw goes through a board hole; a corner pad has none (older results do not say: all of them)
      return (result.supports ?? []).filter((s) => s.kind !== 'corner-pad').map((s) => [s.x, s.y, boardTop(s.occurrence) ?? floor + standoff + 1.6]);
    case 'board-supports':
      return (result.supports ?? []).map((s) => [s.x, s.y, floor]);
    case 'lid-screws': {
      if (result.lidPosts !== undefined) return result.lidPosts.map((q) => [q.x, q.y, q.screwZ ?? outer?.z ?? 0]);
      if (interior === undefined || outer === undefined || p.lid?.screws === false || p.lid?.mode === 'split') return [];
      // results from before pack 0.2.0: the pack's own post formula
      const s = p.lid?.postSize ?? 6;
      return [[s / 2, s / 2], [interior.x - s / 2, s / 2], [s / 2, interior.y - s / 2], [interior.x - s / 2, interior.y - s / 2]].map(([x, y]) => [x!, y!, outer.z]);
    }
    case 'feet': {
      if (outer === undefined || interior === undefined) return [];
      const inset = 8;
      const x0 = -wall + inset, x1 = interior.x + wall - inset, y0 = -wall + inset, y1 = interior.y + wall - inset;
      return [[x0, y0, 0], [x1, y0, 0], [x0, y1, 0], [x1, y1, 0]];
    }
  }
}

/** The centre and outward normal of an opening, enclosure frame. */
export function openingFrame(result: DeviceEnclosureResult, o: NonNullable<DeviceEnclosureResult['openings']>[number]): { centre: Vec3; normal: Vec3 } | undefined {
  const W = result.params?.wall ?? 2;
  const ix = result.interior?.x;
  const iy = result.interior?.y;
  const top = result.outer?.z;
  if (ix === undefined || iy === undefined || top === undefined) return undefined;
  switch (o.face) {
    case 'front': return { centre: [o.u, -W, o.z], normal: [0, -1, 0] };
    case 'back': return { centre: [o.u, iy + W, o.z], normal: [0, 1, 0] };
    case 'left': return { centre: [-W, o.u, o.z], normal: [-1, 0, 0] };
    case 'right': return { centre: [ix + W, o.u, o.z], normal: [1, 0, 0] };
    case 'lid': return { centre: [o.u, o.z, top], normal: [0, 0, 1] };
    default: return undefined;
  }
}

function composeDesign(ctx: Ctx, design: CableDesign, db: Db, frame: Mat4, prefix: string, bomOwner: string | undefined): void {
  const layout = design.device;
  const pre = (id: string): string => (prefix === '' ? id : `${prefix}/${id}`);
  const issue = (code: string, severity: 'error' | 'warning' | 'info', message: string, where?: string): void => {
    ctx.issues.push({ code, level: severity, message, ...(where === undefined ? {} : { where: pre(where) }) });
  };
  if (layout === undefined) return;
  const placements = new Map(layout.placements.map((p) => [p.instance, p]));
  const mechanicals = design.instances.mechanical ?? [];
  const subs = design.instances.subassemblies ?? [];
  const bomOf = (id: string): string => bomOwner ?? id;

  // ---- enclosure ----
  let encFrame = frame;
  let result: DeviceEnclosureResult | undefined;
  const shellInstance = layout.enclosure === undefined ? undefined : mechanicals.find((m) => m.id === layout.enclosure);
  if (layout.enclosure !== undefined && shellInstance === undefined) issue('device-unknown-enclosure', 'warning', `The device's enclosure '${layout.enclosure}' is not a mechanical instance of this design.`);
  if (shellInstance !== undefined) {
    const shell = (db.mechanicals ?? []).find((m) => m.id === shellInstance.def);
    const own = placements.get(shellInstance.id);
    encFrame = mul(frame, own === undefined ? IDENTITY : placementMatrix(own));
    result = ctx.input.enclosure(shellInstance.def, pre(shellInstance.id));
    const label = shell?.label ?? shellInstance.def;
    const provisional = result === undefined ? 'Not generated yet: generate the enclosure on its shell record.' : undefined;
    if (shell?.enclosure === undefined) issue('device-shell-not-generated', 'warning', `${label} carries no enclosure parameters.`, shellInstance.id);
    else if (result === undefined) issue('device-shell-not-generated', 'info', `${label} has not been generated; boards placed by it are not shown.`, shellInstance.id);
    const path = pre(shellInstance.id);
    ctx.nodes.push({ path, instance: shellInstance.id, bomInstance: bomOf(shellInstance.id), kind: 'enclosure', def: shellInstance.def, label: `${label} (base)`, matrix: encFrame, ...(provisional === undefined ? {} : { provisional }), ...(prefix === '' ? {} : { parent: prefix }) });
    if (result !== undefined) ctx.nodes.push({ path: `${path}#lid`, parent: path, instance: shellInstance.id, bomInstance: bomOf(shellInstance.id), kind: 'lid', def: shellInstance.def, label: `${label} (lid)`, matrix: encFrame });
  }

  // ---- boards ----
  const boardTop = new Map<string, number>();
  const occurrenceNode = new Map<string, { path: string; instance: string }>();
  for (const b of design.instances.pcbas) {
    const def = db.pcbas.find((p) => p.id === b.def);
    const label = def === undefined ? b.def : `${def.label}`;
    const place = placements.get(b.id);
    const size = ctx.input.boardSize?.(b.def);
    let matrix: Mat4 | undefined;
    let provisional: string | undefined;
    if (place?.occurrence !== undefined) {
      const pl = result?.placements?.find((p) => p.occurrence === place.occurrence);
      if (pl?.matrix === undefined) {
        if (result !== undefined) issue('device-unknown-occurrence', 'warning', `${b.id} is placed in an enclosure slot the last generation does not have: pick another slot.`, b.id);
        continue;
      }
      if (pl.board !== b.def) issue('device-occurrence-board', 'warning', `${b.id} is a ${label} but its enclosure slot holds ${db.pcbas.find((p) => p.id === pl.board)?.label ?? pl.board}.`, b.id);
      matrix = mul(encFrame, pl.matrix);
      occurrenceNode.set(place.occurrence, { path: pre(b.id), instance: b.id });
      const local = pl.matrix;
      boardTop.set(place.occurrence, local[2]![3]! + (size?.[2] ?? 1.6));
    } else if (place?.at !== undefined) {
      matrix = mul(frame, placementMatrix(place));
    } else {
      issue('device-unplaced', 'info', `${b.id} (${label}) has no placement; it is listed but not drawn.`, b.id);
      continue;
    }
    if (size === undefined) provisional = 'Board size unknown: drawn as a placeholder.';
    ctx.nodes.push({ path: pre(b.id), instance: b.id, bomInstance: bomOf(b.id), kind: 'board', def: b.def, label: `${b.id} · ${label}`, matrix, ...(size === undefined ? {} : { size }), ...(provisional === undefined ? {} : { provisional }), ...(prefix === '' ? {} : { parent: prefix }) });
  }
  // boards that occupy the same space (two placed at one position): a finding, never a refusal
  const placedBoards = ctx.nodes.filter((n) => n.kind === 'board' && n.matrix !== undefined && (n.parent ?? '') === prefix);
  const boxes = placedBoards.map((n) => boxOf(n.matrix!, n.size ?? [50, 30, 1.6]));
  for (let i = 0; i < placedBoards.length; i += 1) {
    for (let j = i + 1; j < placedBoards.length; j += 1) {
      if (!overlaps(boxes[i]!, boxes[j]!)) continue;
      const a = placedBoards[i]!.instance;
      const b = placedBoards[j]!.instance;
      issue('device-board-overlap', 'warning', `${a} and ${b} overlap: move one of them.`, a);
    }
  }

  // ---- hardware and other mechanicals ----
  for (const m of mechanicals) {
    if (m.id === shellInstance?.id) continue;
    const def = (db.mechanicals ?? []).find((d) => d.id === m.def);
    const label = def?.label ?? m.def;
    const place = placements.get(m.id);
    if (place === undefined) continue;
    let points: Mat4[] = [];
    if (place.anchor !== undefined) {
      if (result === undefined) { issue('device-anchor-unavailable', 'info', `${m.id} is placed at the enclosure's ${place.anchor}, which needs a generated enclosure.`, m.id); continue; }
      points = enclosureAnchors(result, place.anchor, (o) => boardTop.get(o)).map((p) => mul(encFrame, translate(p)));
      if (points.length !== m.qty) issue('device-hardware-count', 'warning', `${m.id}: the enclosure has ${points.length} ${place.anchor.replace('-', ' ')} but the design lists ${m.qty} ${label}.`, m.id);
    } else {
      points = [mul(frame, placementMatrix(place))];
    }
    points.forEach((matrix, i) => {
      ctx.nodes.push({ path: points.length === 1 ? pre(m.id) : `${pre(m.id)}#${i + 1}`, instance: m.id, bomInstance: bomOf(m.id), kind: 'hardware', def: m.def, label: points.length === 1 ? label : `${label} #${i + 1}`, matrix, ...(prefix === '' ? {} : { parent: prefix }) });
    });
  }

  // ---- ports: openings ↔ board connectors ----
  const openings = new Map<string, Pick<DevicePortRow, 'centre' | 'normal'>>();
  for (const o of result?.openings ?? []) {
    const f = openingFrame(result!, o);
    if (f === undefined) continue;
    const centre = apply(encFrame, f.centre);
    const normal = applyDir(encFrame, f.normal);
    openings.set(o.id, { centre, normal });
    const row: DevicePortRow = { opening: pre(o.id), label: o.label ?? o.id, face: o.face, centre, normal };
    const node = o.occurrence === undefined ? undefined : occurrenceNode.get(o.occurrence);
    if (node !== undefined && o.port !== undefined) {
      const inst = design.instances.pcbas.find((p) => p.id === node.instance)!;
      const shell = (db.mechanicals ?? []).find((d) => d.id === shellInstance?.def);
      const port: EnclosurePort | undefined = shell?.enclosure?.boards.find((b) => b.pcba === inst.def)?.ports?.find((q) => q.id === o.port);
      const def = db.pcbas.find((p) => p.id === inst.def);
      const keys = [o.port, port?.ref].filter((k): k is string => k !== undefined).map((k) => k.toLowerCase());
      const terminals = (def?.terminals ?? []).filter((t) => keys.some((k) => t.id.toLowerCase().startsWith(`${k}.`) || t.id.toLowerCase() === k || (t.pads ?? []).some((pad) => pad.ref.toLowerCase() === k || pad.ref.toLowerCase().startsWith(`${k}.`)))).map((t) => t.id);
      for (const ic of def?.integratedConnectors ?? []) if (keys.includes(ic.terminalPrefix.toLowerCase())) for (const t of def!.terminals) if (t.id.startsWith(`${ic.terminalPrefix}.`) && !terminals.includes(t.id)) terminals.push(t.id);
      row.label = `${node.path} · ${port?.ref ?? o.port}`;
      if (o.label !== undefined) row.detail = o.label;
      row.board = { path: node.path, instance: node.instance, port: o.port, ...(port?.ref === undefined ? {} : { ref: port.ref }), terminals };
      // the cables jointed to those terminals, each with every conductor that lands there;
      // a run whose every joint lands on this device's own boards is internal wiring, not something plugged in
      const near = new Set(terminals);
      const boardIds = new Set(design.instances.pcbas.map((p) => p.id));
      const internal = (run: string): boolean => {
        const others = design.joints.flatMap((j) => (j.a.instance === run ? [j.b.instance] : j.b.instance === run ? [j.a.instance] : []));
        return others.length > 0 && others.every((o) => boardIds.has(o));
      };
      const found = new Map<string, string[]>();
      for (const j of design.joints) {
        for (const [x, y] of [[j.a, j.b], [j.b, j.a]] as [TerminalRef, TerminalRef][]) {
          if (x.instance !== node.instance || !near.has(x.terminal)) continue;
          const isRun = design.instances.segments.some((s) => s.id === y.instance);
          if (!(subs.some((s) => s.id === y.instance) || isRun || design.instances.connectors.some((c) => c.id === y.instance))) continue;
          if (isRun && internal(y.instance)) continue;
          const list = found.get(y.instance) ?? [];
          if (!list.includes(y.terminal)) list.push(y.terminal);
          found.set(y.instance, list);
        }
      }
      if (found.size > 0) {
        row.cables = [...found].map(([instance, ts]) => ({ path: pre(instance), instance, via: 'joint' as const, terminals: ts }));
        const first = row.cables[0]!;
        row.cable = { path: first.path, instance: first.instance, via: 'joint', terminal: first.terminals[0]! };
      }
    }
    ctx.ports.push(row);
  }

  // ---- placed designs: nested devices ----
  for (const s of subs) {
    const place = placements.get(s.id);
    const routed = (layout.routes ?? []).some((r) => r.instance === s.id);
    // a pinned reference draws that saved version, read against its own frozen library
    const opened = openPlaced(db, s);
    const placed = opened?.design;
    if (opened !== undefined && placed?.device !== undefined) {
      if (ctx.stack.includes(s.def)) { issue('device-cycle', 'error', `${s.id} places ${s.def}, which contains this device.`, s.id); continue; }
      const m = mul(frame, place === undefined ? IDENTITY : placementMatrix(place));
      const path = pre(s.id);
      ctx.nodes.push({ path, instance: s.id, bomInstance: bomOf(s.id), kind: 'assembly', def: s.def, label: `${s.id} · ${placed.label}`, matrix: m, ...(prefix === '' ? {} : { parent: prefix }) });
      ctx.stack.push(s.def);
      composeDesign(ctx, placed, opened.db, m, path, bomOwner ?? s.id);
      ctx.stack.pop();
    } else if (!routed && place === undefined) {
      issue('device-unplaced', 'info', `${s.id} (${placed?.label ?? s.def}) has no placement or route; it is listed but not drawn.`, s.id);
    }
  }

  // ---- cables: schematic routes ----
  for (const r of layout.routes ?? []) {
    const end = (e: DeviceRouteEnd): { p: Vec3; n?: Vec3 } | undefined => {
      if ('at' in e) return { p: apply(frame, e.at) };
      const o = openings.get(e.opening);
      return o === undefined ? undefined : { p: o.centre, n: o.normal };
    };
    const a = end(r.a);
    const b = end(r.b);
    if (a === undefined || b === undefined) { issue('device-route-end', 'warning', `Route of ${r.instance}: an end names an opening the enclosure does not have.`, r.instance); continue; }
    const pts: Vec3[] = [a.p];
    if (a.n !== undefined) pts.push(add(a.p, a.n, PLUG_MM), add(a.p, a.n, PLUG_MM + LEAD_MM));
    for (const v of r.via ?? []) pts.push(apply(frame, v));
    const tail: Vec3[] = b.n === undefined ? [b.p] : [add(b.p, b.n, PLUG_MM + LEAD_MM), add(b.p, b.n, PLUG_MM), b.p];
    if ((r.via ?? []).length === 0 && a.n !== undefined && b.n !== undefined) {
      // a loose loop between the two leads, sagging away from both faces
      const s = pts[pts.length - 1]!;
      const e = tail[0]!;
      const out = add(a.n, b.n);
      const len = Math.hypot(...out);
      const dir: Vec3 = len < 0.5 ? [0, 0, -1] : [out[0] / len, out[1] / len, out[2] / len];
      pts.push(add(add(s, e).map((c) => c / 2) as Vec3, dir, Math.max(20, dist(s, e) * 0.25)));
    }
    pts.push(...tail);
    const sub = subs.find((x) => x.id === r.instance);
    const seg = design.instances.segments.find((x) => x.id === r.instance);
    let declared: number | undefined = seg?.lengthMm;
    let label = r.instance;
    let def = seg?.def ?? sub?.def ?? r.instance;
    if (sub !== undefined) {
      const placed = openPlaced(db, sub)?.design;
      const lengths = (placed?.instances.segments ?? []).map((x) => x.lengthMm).filter(isNum);
      if (lengths.length > 0) declared = Math.max(...lengths);
      label = `${r.instance} · ${placed?.label ?? sub.def}`;
      def = sub.def;
    } else if (seg === undefined) {
      issue('device-route-unknown', 'warning', `Route names '${r.instance}', which is not a segment or placed design here.`, r.instance);
    }
    const route = polylineLength(pts);
    if (declared !== undefined && declared + 1 < route) issue('device-route-short', 'warning', `${r.instance}: declared length ${declared} mm is shorter than its schematic route (${Math.round(route)} mm).`, r.instance);
    if (declared === undefined) issue('device-route-length', 'info', `${r.instance}: no declared length; the schematic route is about ${Math.round(route)} mm.`, r.instance);
    ctx.nodes.push({ path: pre(r.instance), instance: r.instance, bomInstance: bomOf(r.instance), kind: 'cable', def, label, points: pts, provisional: 'Schematic routing: shows which ports it joins, not its real path.', lengthMm: { ...(declared === undefined ? {} : { declared }), route }, ...(prefix === '' ? {} : { parent: prefix }) });
    for (const e of [r.a, r.b]) {
      if (!('opening' in e)) continue;
      const row = ctx.ports.find((p) => p.opening === pre(e.opening));
      if (row !== undefined && row.cable === undefined) {
        row.cable = { path: pre(r.instance), instance: r.instance, via: 'route' };
        row.cables = [{ path: pre(r.instance), instance: r.instance, via: 'route', terminals: [] }];
      }
    }
  }

  // ---- cables with neither a route nor a placement ----
  const boardIds = new Set(design.instances.pcbas.map((p) => p.id));
  for (const s of design.instances.segments) {
    if (placements.has(s.id) || (layout.routes ?? []).some((r) => r.instance === s.id)) continue;
    const others = design.joints.flatMap((j) => (j.a.instance === s.id ? [j.b.instance] : j.b.instance === s.id ? [j.a.instance] : []));
    const board = others.find((o) => boardIds.has(o));
    // a cable from a board to something that is not one of this device's boards leaves the enclosure
    const leaves = board !== undefined && others.some((o) => !boardIds.has(o));
    const opening = ctx.ports.some((row) => row.cables?.some((c) => c.instance === s.id) === true);
    // designators are what the technician reads on the part; the name says which part it is
    const cable = `${s.id.toUpperCase()} ${wireDisplayName(db, s.def)}`;
    if (leaves && shellInstance !== undefined && result !== undefined && !opening) {
      const def = design.instances.pcbas.find((p) => p.id === board)?.def;
      const boardName = def === undefined ? undefined : findPcba(db, def)?.label;
      issue('device-cable-no-opening', 'warning', `${cable} leaves ${(board ?? '').toUpperCase()}${boardName === undefined ? '' : ` ${boardName}`}, but the enclosure has no opening for it.`, s.id);
    } else {
      issue('device-cable-unplaced', 'info', `${cable} is not placed: pick the openings it runs between.`, s.id);
    }
  }

  for (const p of layout.placements) {
    const known = design.instances.pcbas.some((x) => x.id === p.instance) || mechanicals.some((x) => x.id === p.instance) || subs.some((x) => x.id === p.instance) || design.instances.segments.some((x) => x.id === p.instance);
    if (!known) issue('device-unknown-instance', 'warning', `A placement names '${p.instance}', which is not an instance of this design.`, p.instance);
  }
}

/** The device-frame bounding box of a board outline box ([0, size] in its own frame). */
function boxOf(m: Mat4, size: Vec3): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [0, size[0]]) for (const y of [0, size[1]]) for (const z of [0, Math.max(size[2], 0.8)]) {
    for (let k = 0; k < 3; k += 1) {
      const row = m[k]!;
      const v = row[0]! * x + row[1]! * y + row[2]! * z + row[3]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

/** Overlapping by more than a tenth of a millimetre on every axis (touching is not overlapping). */
function overlaps(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  return [0, 1, 2].every((k) => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!) > 0.1);
}

/** A shell (a mechanical with an enclosure spec) or board a device holds at any depth, by its scene path. */
export interface DevicePart {
  kind: 'shell' | 'board';
  /** the scene path of its node (`b1`, `sub1/enc`) */
  path: string;
  def: string;
  /** the library the design that places it reads (a pinned placement: its frozen one) */
  db: Db;
  /** the nearest pinned placement above it: that design, its revision and its path */
  pinned?: { def: string; rev: number; prefix: string };
}

/** Every shell and board occurrence of a device and the designs it places, recursively. */
export function deviceParts(design: CableDesign, db: Db): DevicePart[] {
  const out: DevicePart[] = [];
  const walk = (d: CableDesign, within: Db, prefix: string, pinned: DevicePart['pinned'], stack: string[]): void => {
    const pre = (id: string): string => (prefix === '' ? id : `${prefix}/${id}`);
    const at = pinned === undefined ? {} : { pinned };
    for (const m of d.instances.mechanical ?? []) {
      if ((within.mechanicals ?? []).some((x) => x.id === m.def && x.enclosure !== undefined)) out.push({ kind: 'shell', path: pre(m.id), def: m.def, db: within, ...at });
    }
    for (const b of d.instances.pcbas) out.push({ kind: 'board', path: pre(b.id), def: b.def, db: within, ...at });
    for (const s of d.instances.subassemblies ?? []) {
      if (stack.includes(s.def)) continue;
      const placed = openPlaced(within, s);
      if (placed === undefined) continue;
      const path = pre(s.id);
      walk(placed.design, placed.db, path, placed.rev === undefined ? pinned : { def: s.def, rev: placed.rev, prefix: path }, [...stack, s.def]);
    }
  };
  walk(design, db, '', undefined, [design.id]);
  return out;
}

/** Every placed thing of a device, its external ports and findings. Never refuses: what it cannot place it reports. */
export function deviceScene(input: DeviceSceneInput): DeviceScene {
  const ctx: Ctx = { input, nodes: [], ports: [], issues: [], stack: [input.design.id] };
  if (input.design.device === undefined) return { nodes: [], ports: [], issues: [] };
  composeDesign(ctx, input.design, input.db, IDENTITY, '', undefined);
  return { nodes: ctx.nodes, ports: ctx.ports, issues: ctx.issues };
}

/** The scene paths a top-level instance accounts for (a BOM line's provenance → highlighted nodes). */
export function nodesOfInstances(scene: Pick<DeviceScene, 'nodes'>, instances: readonly string[]): string[] {
  const set = new Set(instances);
  return scene.nodes.filter((n) => set.has(n.bomInstance)).map((n) => n.path);
}
