/**
 * Adopting a newer released revision of a pinned sub-assembly (`docs/revisions.md`, "Adopt a
 * newer revision"; boards and mechanical parts are `revision-adopt.ts`).
 *
 * A parent design may pin a placed design to a saved version (`SubassemblyInstance.rev`). When
 * a newer released version exists, this says, per parent, what re-pinning changes — the ports
 * (free ends) the newer version adds or no longer has, and the parent's landings on ports that
 * go — and re-pins: the references move to the newer version and the landings on ports it does
 * not have are removed, each one listed in the impact first.
 *
 * Pure: designs and the library (`Db.assemblies`, with the versions' content) in, designs out.
 */

import type { CableDesign, DesignStatus, Db, Joint, TerminalRef } from './model.ts';
import { placedDesign, releasedRevisions, subassembliesOf, subassemblyPorts, type SubassemblyPort } from './subassemblies.ts';

/** A port, as people name it: `J2 · 3`. */
export interface PortName {
  id: string;
  label: string;
}

/** What re-pinning one design's references to `placed` from `from` to `to` changes. */
export interface SubassemblyAdoptImpact {
  design: string;
  label: string;
  status?: DesignStatus;
  /** the placed design */
  placed: string;
  placedLabel: string;
  from: number;
  to: number;
  /** the sub-assembly instances pinned to `from` */
  instances: string[];
  added: PortName[];
  removed: PortName[];
  /** the parent's landings on a port the newer version does not have */
  lost: { instance: string; port: string; other: string }[];
}

const portName = (p: SubassemblyPort): PortName => ({ id: p.id, label: `${p.groupLabel} · ${p.label}` });

function portsAt(db: Db, parent: CableDesign, def: string, rev: number): SubassemblyPort[] | undefined {
  const opened = placedDesign(db, { id: `${def}@${rev}`, def, rev });
  if (opened === undefined || !opened.ok) return undefined;
  if (opened.placed.design.id === parent.id) return undefined;
  return subassemblyPorts(opened.placed.design, opened.placed.db, [parent.id]);
}

/** The newest released revision of `def`, when it is newer than `rev`. */
export function newerReleasedRevision(db: Db, def: string, rev: number | undefined): number | undefined {
  if (rev === undefined) return undefined;
  const released = releasedRevisions(db.assemblies, def);
  const newest = released[released.length - 1];
  return newest !== undefined && newest > rev ? newest : undefined;
}

/**
 * What moving `design`'s references to `def` pinned to `from` onto `to` changes; `undefined`
 * when none is pinned to `from` or either version cannot be opened (no library, not loaded).
 */
export function subassemblyAdoptImpact(db: Db, design: CableDesign, def: string, from: number, to: number): SubassemblyAdoptImpact | undefined {
  const instances = subassembliesOf(design).filter((s) => s.def === def && s.rev === from).map((s) => s.id);
  if (instances.length === 0 || from === to) return undefined;
  const older = portsAt(db, design, def, from);
  const newer = portsAt(db, design, def, to);
  if (older === undefined || newer === undefined) return undefined;
  const had = new Map(older.map((p) => [p.id, p]));
  const has = new Map(newer.map((p) => [p.id, p]));
  const placed = new Set(instances);
  const lost: SubassemblyAdoptImpact['lost'] = [];
  const visit = (ref: TerminalRef, other: TerminalRef): void => {
    if (placed.has(ref.instance) && !has.has(ref.terminal)) lost.push({ instance: ref.instance, port: had.has(ref.terminal) ? portName(had.get(ref.terminal)!).label : ref.terminal, other: `${other.instance} ${other.terminal}` });
  };
  for (const j of design.joints) {
    visit(j.a, j.b);
    visit(j.b, j.a);
    if (j.through !== undefined) visit(j.through, j.a);
  }
  const working = db.assemblies?.working.find((d) => d.id === def);
  return {
    design: design.id,
    label: design.label,
    ...(design.status === undefined ? {} : { status: design.status }),
    placed: def,
    placedLabel: working?.label ?? def,
    from,
    to,
    instances,
    added: newer.filter((p) => !had.has(p.id)).map(portName),
    removed: older.filter((p) => !has.has(p.id)).map(portName),
    lost,
  };
}

/** Per placed design and pinned revision in `design` that has a newer released one: what re-pinning changes. */
export function newerSubassemblyRevisions(db: Db, design: CableDesign): SubassemblyAdoptImpact[] {
  const seen = new Set<string>();
  const out: SubassemblyAdoptImpact[] = [];
  for (const sub of subassembliesOf(design)) {
    const key = `${sub.def}@${sub.rev ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const to = newerReleasedRevision(db, sub.def, sub.rev);
    if (to === undefined || sub.rev === undefined) continue;
    const impact = subassemblyAdoptImpact(db, design, sub.def, sub.rev, to);
    if (impact !== undefined) out.push(impact);
  }
  return out;
}

/**
 * `design` with its references to `def` pinned to `from` re-pinned to `to`; the landings on
 * ports `to` does not have go (the impact listed them). Unchanged when none is pinned to `from`
 * or the versions cannot be opened.
 */
export function adoptSubassemblyRevision(db: Db, design: CableDesign, def: string, from: number, to: number): CableDesign {
  const impact = subassemblyAdoptImpact(db, design, def, from, to);
  if (impact === undefined) return design;
  const placed = new Set(impact.instances);
  const newer = new Set((portsAt(db, design, def, to) ?? []).map((p) => p.id));
  const gone = (ref: TerminalRef | undefined): boolean => ref !== undefined && placed.has(ref.instance) && !newer.has(ref.terminal);
  const joints: Joint[] = [];
  for (const j of design.joints) {
    if (gone(j.a) || gone(j.b)) continue;
    if (j.through !== undefined && gone(j.through)) {
      const { through: _dropped, ...rest } = j;
      joints.push(rest);
      continue;
    }
    joints.push(j);
  }
  const subassemblies = subassembliesOf(design).map((s) => (placed.has(s.id) ? { ...s, rev: to } : s));
  return { ...design, instances: { ...design.instances, subassemblies }, joints };
}

/** A one-line summary: `Rev 2 → Rev 3 · +1 −2 ends · 1 landing goes`. */
export function subassemblyImpactSummary(impact: SubassemblyAdoptImpact): string {
  const parts: string[] = [];
  if (impact.added.length + impact.removed.length > 0) parts.push(`+${impact.added.length} −${impact.removed.length} free ends`);
  if (impact.lost.length > 0) parts.push(`${impact.lost.length} landing${impact.lost.length === 1 ? '' : 's'} removed`);
  return parts.length === 0 ? 'no wiring change' : parts.join(' · ');
}
