/**
 * Sub-assemblies: a design placed inside another design (schema v5).
 *
 * A harness made of cables, a Y made of two leads: the parent places the
 * other design (`instances.subassemblies`, by id, optionally pinned to a
 * saved version `rev`) and lands its own joints on the placed design's
 * **ports** — its unconnected ends:
 *
 * - every pin of every connector, including a board's integrated connector
 *   (a connector is a mating face whatever is soldered behind it);
 * - the conductors and screens of a wire end nothing is soldered to, that is
 *   in no breakout and twists no pigtail (a **flying lead**);
 * - the ports of its own sub-assemblies that it does not land anything on.
 *
 * A port is named by `subassemblyPortId`: `j1:3`, `u1:scart.15`,
 * `w1@b:red`, `lead-1:j2:1` (nested). In the parent it is an ordinary
 * terminal: `{ instance: 'lead-1', terminal: 'w1@b:red' }`.
 *
 * The placed designs come from `Db.assemblies` (an `AssemblyLibrary` the
 * host fills: the working copies and saved versions the references reach).
 * Without one, references are not checked and ports resolve unverified, so a
 * frozen version still validates against its own definitions alone.
 *
 * `flattenSubassemblies` is the one place the hierarchy is undone: every
 * placed design's instances, re-identified `<sub>/<id>`, its joints, and the
 * parent's joints moved from the ports onto what they stand for. Nets, trace
 * and the continuity spec run on that flat design; the BOM and the build
 * sheet keep the sub-assembly as one part.
 *
 * Pure and deterministic, like the rest of the model.
 */

import {
  findConnector,
  findWire,
  findPcba,
  type CableDesign,
  type ComponentDefinition,
  type ConnectorDefinition,
  type Db,
  type Issue,
  type Joint,
  type MechanicalDefinition,
  type PcbaDefinition,
  type SubassemblyInstance,
  type TerminalRef,
  type WireDefinition,
} from './model.ts';
import type { FrozenDefinitions } from './versions.ts';
import { breakoutsOf, segmentElectricalPaths } from './breakouts.ts';
import { pigtailsAt } from './bonds.ts';

/* ------------------------------------------------------------------ *
 * The library a host supplies
 * ------------------------------------------------------------------ */

/** One saved version of a placed design, as the host knows it. */
export interface AssemblyVersion {
  designId: string;
  rev: number;
  /** approved (release approvals on), or saved (approvals off) */
  released: boolean;
  /** the saved design; absent when only its existence is known */
  design?: CableDesign;
  /** its frozen definitions; absent with `design` */
  definitions?: FrozenDefinitions;
}

/** The designs a design's sub-assembly references can reach (`Db.assemblies`). */
export interface AssemblyLibrary {
  /** working copies, by id */
  working: CableDesign[];
  /** saved versions of those designs: every revision, with the content of the ones pinned */
  versions?: AssemblyVersion[];
}

/** `db` with `library` as its sub-assembly library. */
export function withAssemblies(db: Db, library: AssemblyLibrary): Db {
  return { ...db, assemblies: library };
}

/** The separator of a flattened instance id: `lead-1/j1`. */
export const SUBASSEMBLY_ID_SEPARATOR = '/';

/** The design's sub-assembly instances (none when absent). */
export function subassembliesOf(design: Pick<CableDesign, 'instances'>): SubassemblyInstance[] {
  return design.instances.subassemblies ?? [];
}

export function hasSubassemblies(design: Pick<CableDesign, 'instances'>): boolean {
  return subassembliesOf(design).length > 0;
}

/** The designs `design` places, by id, sorted, each once. */
export function placedDesignIds(design: Pick<CableDesign, 'instances'>): string[] {
  return [...new Set(subassembliesOf(design).map((s) => s.def))].sort();
}

/** Working copies that place `id` as a sub-assembly — "where used" for a design. */
export function subassemblyParents(designs: readonly CableDesign[], id: string): { id: string; label: string; instances: string[] }[] {
  return designs
    .map((design) => ({ design, instances: subassembliesOf(design).filter((s) => s.def === id).map((s) => s.id) }))
    .filter((entry) => entry.instances.length > 0)
    .map(({ design, instances }) => ({ id: design.id, label: design.label, instances }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The released revisions of `designId` in the library, ascending. */
export function releasedRevisions(library: AssemblyLibrary | undefined, designId: string): number[] {
  return (library?.versions ?? [])
    .filter((v) => v.designId === designId && v.released)
    .map((v) => v.rev)
    .sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ *
 * Resolving a reference
 * ------------------------------------------------------------------ */

/** A placed design, opened: its document and the library it reads against. */
export interface PlacedDesign {
  design: CableDesign;
  db: Db;
  /** the pinned revision, when the reference is pinned */
  rev?: number;
}

export type PlacedResult = { ok: true; placed: PlacedDesign } | { ok: false; issue: Issue };

/** The db a saved version reads against: its frozen definitions over the live ones (`versionDb`'s rule). */
function frozenDb(definitions: FrozenDefinitions, live: Db): Db {
  const overlay = <T extends { id: string }>(frozen: readonly T[], current: readonly T[] | undefined): T[] => {
    const ids = new Set(frozen.map((item) => item.id));
    return [...frozen, ...(current ?? []).filter((item) => !ids.has(item.id))];
  };
  return {
    ...live,
    connectors: overlay(definitions.connectors, live.connectors),
    wires: overlay(definitions.wires, live.wires),
    components: overlay(definitions.components, live.components),
    pcbas: overlay(definitions.pcbas, live.pcbas),
    mechanicals: overlay(definitions.mechanicals, live.mechanicals),
    bodies: overlay(definitions.bodies, live.bodies),
    interfaces: overlay(definitions.interfaces, live.interfaces),
    ...(definitions.tags === undefined
      ? {}
      : {
          tags: {
            src: definitions.tags.src,
            connectors: { ...(live.tags?.connectors ?? {}), ...(definitions.tags.connectors ?? {}) },
            pcbas: { ...(live.tags?.pcbas ?? {}), ...(definitions.tags.pcbas ?? {}) },
            wires: { ...(live.tags?.wires ?? {}), ...(definitions.tags.wires ?? {}) },
          },
        }),
  };
}

/**
 * Open the design a sub-assembly instance places: the pinned version (read
 * against its own frozen definitions), else the working copy. `undefined`
 * when `db` carries no library (nothing can be checked).
 */
export function placedDesign(db: Db, sub: Pick<SubassemblyInstance, 'id' | 'def' | 'rev'>): PlacedResult | undefined {
  const library = db.assemblies;
  if (library === undefined) return undefined;
  const fail = (code: string, message: string, severity: 'error' | 'warning' = 'error'): PlacedResult => ({
    ok: false,
    issue: { code, severity, message, where: sub.id },
  });
  const working = library.working.find((d) => d.id === sub.def);
  const versions = (library.versions ?? []).filter((v) => v.designId === sub.def);
  if (working === undefined && versions.length === 0) {
    return fail('subassembly-unknown-design', `sub-assembly '${sub.id}' places design '${sub.def}', which does not exist`);
  }
  if (sub.rev === undefined) {
    if (working === undefined) return fail('subassembly-unknown-design', `sub-assembly '${sub.id}' places design '${sub.def}', which has no working copy`);
    return { ok: true, placed: { design: working, db } };
  }
  const version = versions.find((v) => v.rev === sub.rev);
  if (version === undefined) {
    const revs = versions.map((v) => v.rev).sort((a, b) => a - b);
    return fail(
      'subassembly-unknown-rev',
      `sub-assembly '${sub.id}' is pinned to Rev ${sub.rev} of '${sub.def}', which has ${revs.length === 0 ? 'no saved versions' : `only Rev ${revs.join(', ')}`}`,
    );
  }
  if (version.design === undefined || version.definitions === undefined) {
    return fail('subassembly-rev-unloaded', `Rev ${sub.rev} of '${sub.def}' (sub-assembly '${sub.id}') was not loaded, so its ports cannot be checked`, 'warning');
  }
  return { ok: true, placed: { design: version.design, db: frozenDb(version.definitions, db), rev: sub.rev } };
}

/* ------------------------------------------------------------------ *
 * Ports
 * ------------------------------------------------------------------ */

export type SubassemblyPortKind = 'pin' | 'lead';

/** One unconnected end a placed design exposes. */
export interface SubassemblyPort {
  /** the port's terminal id in the parent: `j1:3`, `w1@b:red`, `lead-1:j2:1` */
  id: string;
  kind: SubassemblyPortKind;
  /** the terminal it is, in the placed design */
  ref: TerminalRef;
  /** the end it belongs to, for grouping: `j1`, `u1.scart`, `w1@b`, `lead-1/j2` */
  group: string;
  /** that end, for people: the connector's label, `w1 end b (flying)` */
  groupLabel: string;
  /** the pin's or conductor's own label */
  label: string;
}

/** A port's terminal id in the parent: `instance:terminal`, or `instance@end:path` for a wire end. */
export function subassemblyPortId(ref: TerminalRef): string {
  return ref.end === undefined ? `${ref.instance}:${ref.terminal}` : `${ref.instance}@${ref.end}:${ref.terminal}`;
}

/** The terminal a port id names in the placed design, or `undefined` when it is not one. */
export function parseSubassemblyPortId(id: string): TerminalRef | undefined {
  const colon = id.indexOf(':');
  if (colon <= 0 || colon === id.length - 1) return undefined;
  const head = id.slice(0, colon);
  const terminal = id.slice(colon + 1);
  const at = /^(.+)@([ab])$/.exec(head);
  if (at !== null) return { instance: at[1]!, terminal, end: at[2] as 'a' | 'b' };
  return { instance: head, terminal };
}

function keyOf(ref: TerminalRef): string {
  return ref.end === undefined ? `${ref.instance}:${ref.terminal}` : `${ref.instance}:${ref.terminal}@${ref.end}`;
}

const PORT_CACHE = new WeakMap<Db, Map<string, SubassemblyPort[]>>();

/**
 * Every port of `design` (read against `db`), in a fixed order: connectors,
 * boards' integrated connectors, flying wire ends, then nested
 * sub-assemblies' free ports. `stack` guards against a cycle (the ids of the
 * designs being opened above this one).
 */
export function subassemblyPorts(design: CableDesign, db: Db, stack: readonly string[] = []): SubassemblyPort[] {
  const ports: SubassemblyPort[] = [];
  const jointed = new Set<string>();
  for (const joint of design.joints) {
    jointed.add(keyOf(joint.a));
    jointed.add(keyOf(joint.b));
    if (joint.through !== undefined) jointed.add(keyOf(joint.through));
  }
  const endsTouched = new Set<string>();
  for (const joint of design.joints) {
    for (const ref of [joint.a, joint.b, ...(joint.through === undefined ? [] : [joint.through])]) {
      if (ref.end !== undefined) endsTouched.add(`${ref.instance}@${ref.end}`);
    }
  }
  for (const breakout of breakoutsOf(design)) {
    endsTouched.add(`${breakout.trunk.segment}@${breakout.trunk.end}`);
    for (const leg of breakout.legs) endsTouched.add(`${leg.segment}@${leg.end}`);
  }

  for (const instance of design.instances.connectors) {
    const def = findConnector(db, instance.def);
    const groupLabel = instance.label ?? def?.label ?? instance.id;
    for (const pin of def?.pins ?? []) {
      const ref: TerminalRef = { instance: instance.id, terminal: pin.id };
      ports.push({ id: subassemblyPortId(ref), kind: 'pin', ref, group: instance.id, groupLabel, label: pin.label || pin.id });
    }
  }
  for (const instance of design.instances.pcbas) {
    const pcba = findPcba(db, instance.def);
    for (const integrated of pcba?.integratedConnectors ?? []) {
      const connector = findConnector(db, integrated.connectorDefId);
      const group = `${instance.id}.${integrated.terminalPrefix}`;
      for (const pin of connector?.pins ?? []) {
        const ref: TerminalRef = { instance: instance.id, terminal: `${integrated.terminalPrefix}.${pin.id}` };
        ports.push({ id: subassemblyPortId(ref), kind: 'pin', ref, group, groupLabel: connector?.label ?? group, label: pin.label || pin.id });
      }
    }
  }
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const end of ['a', 'b'] as const) {
      const group = `${segment.id}@${end}`;
      if (endsTouched.has(group) || pigtailsAt(segment, end).length > 0) continue;
      for (const path of segmentElectricalPaths(wire, segment)) {
        const ref: TerminalRef = { instance: segment.id, terminal: path, end };
        ports.push({ id: subassemblyPortId(ref), kind: 'lead', ref, group, groupLabel: `${segment.label ?? segment.id} end ${end} (flying)`, label: labelOfPath(wire, path) });
      }
    }
  }
  for (const nested of subassembliesOf(design)) {
    const opened = placedDesign(db, nested);
    if (opened === undefined || !opened.ok || stack.includes(opened.placed.design.id) || opened.placed.design.id === design.id) continue;
    for (const port of cachedPorts(db, nested, opened.placed, [...stack, design.id])) {
      const ref: TerminalRef = { instance: nested.id, terminal: port.id };
      if (jointed.has(keyOf(ref))) continue;
      ports.push({
        id: subassemblyPortId(ref),
        kind: port.kind,
        ref,
        group: `${nested.id}${SUBASSEMBLY_ID_SEPARATOR}${port.group}`,
        groupLabel: `${nested.label ?? nested.id} · ${port.groupLabel}`,
        label: port.label,
      });
    }
  }
  return ports;
}

function labelOfPath(wire: WireDefinition, path: string): string {
  let children = wire.structure.kind === 'group' ? wire.structure.children : [];
  let label: string | undefined;
  for (const id of path.split('.')) {
    const element = children.find((c) => c.id === id);
    if (element === undefined) return path;
    label = element.label;
    children = element.kind === 'group' ? element.children : [];
  }
  return label ?? path;
}

function cachedPorts(db: Db, sub: Pick<SubassemblyInstance, 'def' | 'rev'>, placed: PlacedDesign, stack: readonly string[]): SubassemblyPort[] {
  let cache = PORT_CACHE.get(db);
  if (cache === undefined) {
    cache = new Map();
    PORT_CACHE.set(db, cache);
  }
  const key = `${sub.def}@${sub.rev ?? 'working'}|${stack.join('>')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const ports = subassemblyPorts(placed.design, placed.db, stack);
  cache.set(key, ports);
  return ports;
}

/**
 * The ports of the design a sub-assembly instance places, or `undefined`
 * when it cannot be opened (no library, a missing design or version, a
 * cycle — `subassemblyIssues` reports which).
 */
export function portsOfSubassembly(design: CableDesign, db: Db, instanceId: string): SubassemblyPort[] | undefined {
  const sub = subassembliesOf(design).find((s) => s.id === instanceId);
  if (sub === undefined) return undefined;
  const opened = placedDesign(db, sub);
  if (opened === undefined || !opened.ok) return undefined;
  if (opened.placed.design.id === design.id || reaches(db, opened.placed.design, design.id, new Set())) return undefined;
  return cachedPorts(db, sub, opened.placed, [design.id]);
}

/* ------------------------------------------------------------------ *
 * Cycles
 * ------------------------------------------------------------------ */

/** Whether `from` (or anything it places, transitively) places `target`. */
function reaches(db: Db, from: CableDesign, target: string, seen: Set<string>): boolean {
  for (const sub of subassembliesOf(from)) {
    if (sub.def === target) return true;
    const key = `${sub.def}@${sub.rev ?? 'working'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const opened = placedDesign(db, sub);
    if (opened !== undefined && opened.ok && reaches(opened.placed.db, opened.placed.design, target, seen)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * The sub-assembly rules: the design placed exists (and the pinned version
 * does), the placing makes no cycle, a pin is to a released version and the
 * newest one (warnings otherwise), and a design placing any is schema v5.
 * Joints to ports that are not there are `resolveTerminal`'s
 * `subassembly-unknown-port`. Silent on the references without a library.
 */
export function subassemblyIssues(design: CableDesign, db: Db): Issue[] {
  const subs = subassembliesOf(design);
  if (subs.length === 0) return [];
  const issues: Issue[] = [];
  if (design.schemaVersion < 5) {
    issues.push({
      code: 'subassembly-schema',
      severity: 'warning',
      message: `a design placing sub-assemblies is schema version 5, not ${design.schemaVersion} (saving it raises the number)`,
      where: 'schemaVersion',
    });
  }
  const library = db.assemblies;
  if (library === undefined) return issues;
  for (const sub of subs) {
    if (sub.rev !== undefined && (!Number.isInteger(sub.rev) || sub.rev < 0)) {
      issues.push({ code: 'subassembly-unknown-rev', severity: 'error', message: `sub-assembly '${sub.id}' is pinned to '${String(sub.rev)}', which is not a revision number`, where: sub.id });
      continue;
    }
    if (sub.def === design.id) {
      issues.push({ code: 'subassembly-cycle', severity: 'error', message: `sub-assembly '${sub.id}' places '${design.id}' inside itself`, where: sub.id });
      continue;
    }
    const opened = placedDesign(db, sub);
    if (opened === undefined) continue;
    if (!opened.ok) {
      issues.push(opened.issue);
      continue;
    }
    if (reaches(opened.placed.db, opened.placed.design, design.id, new Set())) {
      issues.push({
        code: 'subassembly-cycle',
        severity: 'error',
        message: `sub-assembly '${sub.id}' places '${sub.def}', which places '${design.id}' in turn — a design cannot contain itself`,
        where: sub.id,
      });
      continue;
    }
    if (sub.rev !== undefined) {
      const version = (library.versions ?? []).find((v) => v.designId === sub.def && v.rev === sub.rev);
      const released = releasedRevisions(library, sub.def);
      if (version !== undefined && !version.released) {
        issues.push({ code: 'subassembly-rev-unreleased', severity: 'warning', message: `sub-assembly '${sub.id}' is pinned to Rev ${sub.rev} of '${sub.def}', which is not released`, where: sub.id });
      }
      const newest = released[released.length - 1];
      if (newest !== undefined && newest > sub.rev) {
        issues.push({
          code: 'subassembly-newer-rev',
          severity: 'warning',
          message: `sub-assembly '${sub.id}' is pinned to Rev ${sub.rev} of '${sub.def}'; Rev ${newest} is released`,
          where: sub.id,
        });
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Freezing on save version
 * ------------------------------------------------------------------ */

/**
 * `design` with every unpinned sub-assembly pinned to the placed design's
 * newest released revision — what a saved version records, so it always
 * means the same parts. A reference with nothing released is left unpinned
 * and reported (`subassembly-not-released`, an error: a version cannot
 * stand on a working copy).
 */
export function pinSubassemblies(design: CableDesign, db: Db): { design: CableDesign; issues: Issue[]; pinned: { id: string; rev: number }[] } {
  const subs = subassembliesOf(design);
  if (subs.length === 0 || db.assemblies === undefined) return { design, issues: [], pinned: [] };
  const issues: Issue[] = [];
  const pinned: { id: string; rev: number }[] = [];
  const next = subs.map((sub) => {
    if (sub.rev !== undefined) return sub;
    const released = releasedRevisions(db.assemblies, sub.def);
    const rev = released[released.length - 1];
    if (rev === undefined) {
      issues.push({
        code: 'subassembly-not-released',
        severity: 'error',
        message: `sub-assembly '${sub.id}' follows the working copy of '${sub.def}', which has no released version to freeze — save (and release) a version of '${sub.def}' first`,
        where: sub.id,
      });
      return sub;
    }
    pinned.push({ id: sub.id, rev });
    return { ...sub, rev };
  });
  if (pinned.length === 0) return { design, issues, pinned };
  return { design: { ...design, instances: { ...design.instances, subassemblies: next } }, issues, pinned };
}

/* ------------------------------------------------------------------ *
 * Flattening
 * ------------------------------------------------------------------ */

export interface FlatDesign {
  /** the design with every sub-assembly replaced by its parts (`<sub>/<id>`); no `subassemblies` */
  design: CableDesign;
  /** the library those parts read against (a pinned version's frozen definitions, renamed where they differ) */
  db: Db;
  /** what could not be flattened (a missing design, a cycle, a port that is not there) */
  issues: Issue[];
  /** a port of the parent (`lead-1:w1@b:red`, a terminal key) → the flat terminal it is */
  ports: Map<string, TerminalRef>;
}

type DefList = 'connectors' | 'wires' | 'components' | 'pcbas' | 'mechanicals' | 'bodies' | 'interfaces';

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * The design with its sub-assemblies (all the way down) replaced by their
 * parts. A design without any comes back as itself. Instance ids of a placed
 * design gain its instance's id as a prefix (`lead-1/w1`); the parent's
 * joints to a port land on the terminal behind it. A pinned version's frozen
 * definition that differs from the live one of the same id is carried under
 * `<id>@<design>.<rev>`; nested references inside definitions (a connector's
 * body, a board's integrated connector) keep resolving against the live ones.
 */
export function flattenSubassemblies(design: CableDesign, db: Db): FlatDesign {
  return flatten(design, db, [design.id]);
}

function flatten(design: CableDesign, db: Db, stack: readonly string[]): FlatDesign {
  const subs = subassembliesOf(design);
  if (subs.length === 0) return { design, db, issues: [], ports: new Map() };
  const issues: Issue[] = [];
  const ports = new Map<string, TerminalRef>();
  const { subassemblies: _subs, ...ownInstances } = design.instances;
  const instances = {
    ...ownInstances,
    connectors: [...design.instances.connectors],
    segments: [...design.instances.segments],
    components: [...design.instances.components],
    pcbas: [...design.instances.pcbas],
    ...(design.instances.mechanical === undefined ? {} : { mechanical: [...design.instances.mechanical] }),
    ...(design.instances.breakouts === undefined ? {} : { breakouts: [...design.instances.breakouts] }),
  };
  const lists: Record<DefList, { id: string }[]> = {
    connectors: [...db.connectors],
    wires: [...db.wires],
    components: [...db.components],
    pcbas: [...db.pcbas],
    mechanicals: [...(db.mechanicals ?? [])],
    bodies: [...(db.bodies ?? [])],
    interfaces: [...(db.interfaces ?? [])],
  };
  const joints: Joint[] = [];

  for (const sub of subs) {
    if (sub.def === design.id || stack.includes(sub.def)) {
      issues.push({ code: 'subassembly-cycle', severity: 'error', message: `sub-assembly '${sub.id}' places '${sub.def}', which contains '${design.id}'`, where: sub.id });
      continue;
    }
    const opened = placedDesign(db, sub);
    if (opened === undefined) {
      issues.push({ code: 'subassembly-no-library', severity: 'warning', message: `sub-assembly '${sub.id}' ('${sub.def}') cannot be opened here: no design library was given`, where: sub.id });
      continue;
    }
    if (!opened.ok) {
      issues.push(opened.issue);
      continue;
    }
    const placed = opened.placed;
    const inner = flatten(placed.design, placed.db, [...stack, placed.design.id]);
    issues.push(...inner.issues.map((i) => ({ ...i, where: `${sub.id}${SUBASSEMBLY_ID_SEPARATOR}${i.where ?? ''}` })));
    const prefix = `${sub.id}${SUBASSEMBLY_ID_SEPARATOR}`;
    const id = (local: string): string => `${prefix}${local}`;
    const ref = (r: TerminalRef): TerminalRef => ({ ...r, instance: id(r.instance) });
    const suffix = `@${placed.design.id}.${placed.rev ?? 'working'}`;

    /** the def id to use in the flat db for child def `defId` of `list` */
    const carry = (list: DefList, defId: string): string => {
      const source = (list === 'mechanicals' ? inner.db.mechanicals : (inner.db[list] as { id: string }[] | undefined)) ?? [];
      const def = source.find((d) => d.id === defId);
      if (def === undefined) return defId;
      const target = lists[list];
      const same = target.find((d) => d.id === defId);
      if (same === undefined) {
        target.push(def);
        return defId;
      }
      if (same === def || stable(same) === stable(def)) return defId;
      const renamed = `${defId}${suffix}`;
      if (!target.some((d) => d.id === renamed)) target.push({ ...def, id: renamed });
      return renamed;
    };

    const fi = inner.design.instances;
    for (const c of fi.connectors) {
      const defId = carry('connectors', c.def);
      const connector = (inner.db.connectors as ConnectorDefinition[]).find((d) => d.id === c.def);
      if (connector?.body !== undefined) carry('bodies', connector.body);
      if (connector?.interface !== undefined) carry('interfaces', connector.interface);
      instances.connectors.push({
        ...c,
        id: id(c.id),
        def: defId,
        ...(c.cavities === undefined
          ? {}
          : {
              cavities: c.cavities.map((cavity) => ({
                ...cavity,
                ...(cavity.contact === undefined ? {} : { contact: carry('mechanicals', cavity.contact) }),
                ...(cavity.seal === undefined ? {} : { seal: carry('mechanicals', cavity.seal) }),
                ...(cavity.plug === undefined ? {} : { plug: carry('mechanicals', cavity.plug) }),
              })),
            }),
      });
    }
    for (const s of fi.segments) instances.segments.push({ ...s, id: id(s.id), def: carry('wires', s.def) });
    for (const c of fi.components) instances.components.push({ ...c, id: id(c.id), def: carry('components', c.def) });
    for (const p of fi.pcbas) {
      const pcba = (inner.db.pcbas as PcbaDefinition[]).find((d) => d.id === p.def);
      for (const integrated of pcba?.integratedConnectors ?? []) carry('connectors', integrated.connectorDefId);
      instances.pcbas.push({ ...p, id: id(p.id), def: carry('pcbas', p.def) });
    }
    for (const m of fi.mechanical ?? []) {
      (instances.mechanical ??= []).push({ ...m, id: id(m.id), def: carry('mechanicals', m.def), ...(m.attachedTo === undefined ? {} : { attachedTo: id(m.attachedTo) }) });
    }
    for (const b of fi.breakouts ?? []) {
      (instances.breakouts ??= []).push({
        ...b,
        id: id(b.id),
        ...(b.mould === undefined ? {} : { mould: id(b.mould) }),
        trunk: { ...b.trunk, segment: id(b.trunk.segment) },
        legs: b.legs.map((leg) => ({ ...leg, segment: id(leg.segment) })),
        ...(b.housed === undefined ? {} : { housed: b.housed.map(id) }),
        conductors: b.conductors.map((c) => ({ ...c, segment: id(c.segment), ...(c.leg === undefined ? {} : { leg: id(c.leg) }) })),
      });
    }
    for (const joint of inner.design.joints) {
      joints.push({ ...joint, a: ref(joint.a), b: ref(joint.b), ...(joint.through === undefined ? {} : { through: ref(joint.through) }) });
    }
    // the placed design's ports, as flat terminals
    for (const port of subassemblyPorts(placed.design, placed.db, stack)) {
      const nestedTarget = subassembliesOf(placed.design).some((n) => n.id === port.ref.instance) ? inner.ports.get(keyOf(port.ref)) : port.ref;
      if (nestedTarget === undefined) continue;
      ports.set(keyOf({ instance: sub.id, terminal: port.id }), ref(nestedTarget));
    }
  }

  const subIds = new Set(subs.map((s) => s.id));
  const land = (r: TerminalRef, where: string): TerminalRef | undefined => {
    if (!subIds.has(r.instance)) return r;
    const target = ports.get(keyOf({ instance: r.instance, terminal: r.terminal }));
    if (target === undefined) {
      if (!issues.some((i) => i.where === r.instance && i.severity === 'error')) {
        issues.push({ code: 'subassembly-unknown-port', severity: 'error', message: `${keyOf(r)} is not a port of sub-assembly '${r.instance}'`, where });
      }
      return undefined;
    }
    return { ...target, ...(r.pad === undefined ? {} : { pad: r.pad }) };
  };
  // the parent's own joints first, in their order, then the placed designs'
  const own: Joint[] = [];
  design.joints.forEach((joint, index) => {
    const where = `joints[${index}]`;
    const a = land(joint.a, where);
    const b = land(joint.b, where);
    if (a === undefined || b === undefined) return;
    const through = joint.through === undefined ? undefined : land(joint.through, where);
    const { through: _t, ...rest } = joint;
    own.push({ ...rest, a, b, ...(through === undefined ? {} : { through }) });
  });
  const flatJoints = [...own, ...joints];

  const flatDb: Db = {
    ...db,
    connectors: lists.connectors as ConnectorDefinition[],
    wires: lists.wires as WireDefinition[],
    components: lists.components as ComponentDefinition[],
    pcbas: lists.pcbas as PcbaDefinition[],
    mechanicals: lists.mechanicals as MechanicalDefinition[],
    bodies: lists.bodies as NonNullable<Db['bodies']>,
    interfaces: lists.interfaces as NonNullable<Db['interfaces']>,
  };
  return {
    design: { ...design, instances, joints: flatJoints },
    db: flatDb,
    issues,
    ports,
  };
}

/** The flat terminal a parent terminal stands for: a port's target, else the terminal itself. */
export function flatTerminal(flat: Pick<FlatDesign, 'ports'>, ref: TerminalRef): TerminalRef {
  return flat.ports.get(keyOf(ref)) ?? ref;
}
