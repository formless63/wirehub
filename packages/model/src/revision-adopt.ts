/**
 * Adopting a newer revision of a part (`docs/revisions.md`, "Adopt a newer revision").
 *
 * A board's revisions are records of their own: one part number, one `revision` each
 * (`PCA-00001 Rev6` beside `PCA-00001 Rev7`); a shell or other mechanical part may carry a
 * revision the same way. A design places one of them by id. When a newer one exists, this says,
 * per design that places an older one, what switching would change — terminals added, removed or
 * renamed, landings that would lose their terminal or their pad, jumper states the new board no
 * longer has, the bill-of-materials line — and switches it: the placements point at the newer
 * record, landings on a renamed terminal follow it, and what the newer board cannot take (a
 * landing on a terminal it dropped, a pad it no longer declares, a jumper state) is removed —
 * every one of them listed in the impact first.
 *
 * Pure: designs and the library in, designs out. No review or approval record.
 */

import type { CableDesign, Db, DesignStatus, Joint, MechanicalDefinition, PcbaDefinition, TerminalRef } from './model.ts';
import { pcbaName } from './model.ts';
import { pcbaTerminalIds } from './validate.ts';

/** The library kinds whose records carry a part number and a revision of their own. */
export const ADOPT_KINDS = ['pcbas', 'mechanicals'] as const;
export type AdoptKind = (typeof ADOPT_KINDS)[number];
export const isAdoptKind = (kind: string): kind is AdoptKind => (ADOPT_KINDS as readonly string[]).includes(kind);

/** One revision of a part, as people name it. */
export interface RevisionSibling {
  id: string;
  /** `PCA-00001 Rev7` */
  name: string;
  partNumber: string;
  revision: string;
  status?: DesignStatus;
}

/** Revision order: `Rev6` < `Rev7` < `Rev10`, `A` < `B` < `AA` — digit runs compare as numbers. */
export function compareRevisions(a: string, b: string): number {
  const split = (s: string): (string | number)[] => (s.trim().toLowerCase().match(/\d+|\D+/g) ?? []).map((t) => (/^\d/.test(t) ? Number(t) : t));
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const p = x[i]!;
    const q = y[i]!;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'string' && typeof q === 'string') {
      // a longer letter run is later (`Z` < `AA`), then alphabetical
      if (/^[a-z]+$/.test(p) && /^[a-z]+$/.test(q) && p.length !== q.length) return p.length - q.length;
      return p < q ? -1 : 1;
    }
    return typeof p === 'number' ? -1 : 1;
  }
  return x.length - y.length;
}

type Revised = (PcbaDefinition | MechanicalDefinition) & { partNumber?: string; revision?: string; status?: DesignStatus };

function recordsOf(db: Db, kind: AdoptKind): readonly Revised[] {
  return kind === 'pcbas' ? db.pcbas : (db.mechanicals ?? []);
}

function siblingOf(kind: AdoptKind, r: Revised): RevisionSibling | undefined {
  const pn = typeof r.partNumber === 'string' ? r.partNumber.trim() : '';
  const rev = typeof r.revision === 'string' ? r.revision.trim() : '';
  if (pn === '' || rev === '') return undefined;
  const name = kind === 'pcbas' ? pcbaName(r as PcbaDefinition) : `${pn} ${rev}`;
  return { id: r.id, name, partNumber: pn, revision: rev, ...(r.status === undefined ? {} : { status: r.status }) };
}

/** Every revision of the part `id` is a revision of (same kind and part number), oldest first; empty when it has no number or revision. */
export function revisionFamily(db: Db, kind: AdoptKind, id: string): RevisionSibling[] {
  const own = recordsOf(db, kind).find((r) => r.id === id);
  const self = own === undefined ? undefined : siblingOf(kind, own);
  if (self === undefined) return [];
  return recordsOf(db, kind)
    .map((r) => siblingOf(kind, r))
    .filter((s): s is RevisionSibling => s !== undefined && s.partNumber === self.partNumber)
    .sort((a, b) => compareRevisions(a.revision, b.revision) || a.id.localeCompare(b.id));
}

/** The revision a design should move to: the newest one still built (not legacy or retired). */
export function newestRevision(family: readonly RevisionSibling[]): RevisionSibling | undefined {
  return [...family].reverse().find((s) => s.status !== 'retired' && s.status !== 'legacy');
}

/** The revisions of `family` older than `target`. */
export function olderRevisions(family: readonly RevisionSibling[], target: RevisionSibling): RevisionSibling[] {
  return family.filter((s) => s.id !== target.id && compareRevisions(s.revision, target.revision) < 0);
}

/* ------------------------------------------------------------------ *
 * Impact
 * ------------------------------------------------------------------ */

/** A terminal, as the board labels it. */
export interface TerminalName {
  id: string;
  label?: string;
}

/** One landing the newer revision cannot take as it is. */
export interface LostLanding {
  /** the placement (instance id) */
  instance: string;
  terminal: string;
  /** the pad it names, for a lost pad */
  pad?: string;
  /** what it is joined to, as `J1:3` */
  other: string;
}

/** What switching one design from `from` to `to` changes. */
export interface AdoptImpact {
  kind: AdoptKind;
  design: string;
  label: string;
  status?: DesignStatus;
  from: RevisionSibling;
  to: RevisionSibling;
  /** the placements switched */
  instances: string[];
  added: TerminalName[];
  removed: TerminalName[];
  /** a terminal of the older board under a new id on the newer one: its landings follow it */
  renamed: { from: string; to: string; label?: string }[];
  /** landings on a terminal the newer board does not have */
  lostTerminals: LostLanding[];
  /** landings naming a pad the newer board's terminal does not declare */
  lostPads: LostLanding[];
  /** jumper or switch states set on a placement for a part the newer board does not have */
  lostStates: { instance: string; ref: string }[];
  /** declared board links (continuity) added and removed */
  links: { added: number; removed: number };
  /** the bill-of-materials line: `PCA-00001 Rev6` → `PCA-00001 Rev7` */
  bom: { from: string; to: string };
}

/** The other side of a landing, as the design names it: `w1 pair-2.a`. */
const refText = (r: TerminalRef): string => `${r.instance} ${r.terminal}`;

function terminalsOf(board: PcbaDefinition | undefined, db: Db): Map<string, TerminalName & { pads: string[] }> {
  const out = new Map<string, TerminalName & { pads: string[] }>();
  if (board === undefined) return out;
  for (const t of board.terminals) out.set(t.id, { id: t.id, ...(t.label === undefined ? {} : { label: t.label }), pads: (t.pads ?? []).map((p) => p.ref) });
  for (const id of pcbaTerminalIds(board, db)) if (!out.has(id)) out.set(id, { id, pads: [] });
  return out;
}

/**
 * Terminals of `older` that `newer` carries under another id: matched by label (case aside), else
 * by the same set of pads — only when exactly one terminal of the newer board fits.
 */
function renames(older: Map<string, TerminalName & { pads: string[] }>, newer: Map<string, TerminalName & { pads: string[] }>): Map<string, string> {
  const out = new Map<string, string>();
  const fresh = [...newer.values()].filter((t) => !older.has(t.id));
  const taken = new Set<string>();
  const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
  const padKey = (pads: readonly string[]): string => [...pads].sort().join('|');
  for (const t of older.values()) {
    if (newer.has(t.id)) continue;
    let hits = norm(t.label) === '' ? [] : fresh.filter((n) => norm(n.label) === norm(t.label));
    if (hits.length !== 1 && t.pads.length > 0) hits = fresh.filter((n) => n.pads.length > 0 && padKey(n.pads) === padKey(t.pads));
    const hit = hits.length === 1 ? hits[0]! : undefined;
    if (hit !== undefined && !taken.has(hit.id)) {
      out.set(t.id, hit.id);
      taken.add(hit.id);
    }
  }
  return out;
}

const linkKey = (l: { from: string; to: string; via?: string }): string => `${[l.from, l.to].sort().join('~')}|${l.via ?? ''}`;

/** The placements of `fromId` in `design`: board instances, or mechanical instances and crimp cavities. */
function placements(design: CableDesign, kind: AdoptKind, fromId: string): string[] {
  if (kind === 'pcbas') return design.instances.pcbas.filter((i) => i.def === fromId).map((i) => i.id);
  const own = (design.instances.mechanical ?? []).filter((i) => i.def === fromId).map((i) => i.id);
  const cavities = design.instances.connectors.filter((c) => (c.cavities ?? []).some((a) => a.contact === fromId || a.seal === fromId || a.plug === fromId || a.tool === fromId)).map((c) => c.id);
  return [...own, ...cavities];
}

/** True when `design` places `fromId`. */
export function placesRecord(design: CableDesign, kind: AdoptKind, fromId: string): boolean {
  return placements(design, kind, fromId).length > 0;
}

/** What switching `design` from `fromId` to `toId` would change; `undefined` when it does not place `fromId` or either record is unknown. */
export function adoptImpact(db: Db, design: CableDesign, kind: AdoptKind, fromId: string, toId: string): AdoptImpact | undefined {
  const records = recordsOf(db, kind);
  const fromRec = records.find((r) => r.id === fromId);
  const toRec = records.find((r) => r.id === toId);
  if (fromRec === undefined || toRec === undefined) return undefined;
  const from = siblingOf(kind, fromRec) ?? { id: fromId, name: fromRec.label, partNumber: '', revision: '' };
  const to = siblingOf(kind, toRec) ?? { id: toId, name: toRec.label, partNumber: '', revision: '' };
  const instances = placements(design, kind, fromId);
  if (instances.length === 0) return undefined;
  const base: AdoptImpact = {
    kind,
    design: design.id,
    label: design.label,
    ...(design.status === undefined ? {} : { status: design.status }),
    from,
    to,
    instances,
    added: [],
    removed: [],
    renamed: [],
    lostTerminals: [],
    lostPads: [],
    lostStates: [],
    links: { added: 0, removed: 0 },
    bom: { from: from.name, to: to.name },
  };
  if (kind !== 'pcbas') return base;

  const older = terminalsOf(fromRec as PcbaDefinition, db);
  const newer = terminalsOf(toRec as PcbaDefinition, db);
  const moved = renames(older, newer);
  const movedTo = new Set(moved.values());
  base.renamed = [...moved].map(([f, t]) => ({ from: f, to: t, ...(older.get(f)?.label === undefined ? {} : { label: older.get(f)!.label! }) }));
  base.removed = [...older.values()].filter((t) => !newer.has(t.id) && !moved.has(t.id)).map(({ id, label }) => ({ id, ...(label === undefined ? {} : { label }) }));
  base.added = [...newer.values()].filter((t) => !older.has(t.id) && !movedTo.has(t.id)).map(({ id, label }) => ({ id, ...(label === undefined ? {} : { label }) }));

  const placed = new Set(instances);
  const visit = (ref: TerminalRef, other: TerminalRef): void => {
    if (!placed.has(ref.instance)) return;
    const id = moved.get(ref.terminal) ?? ref.terminal;
    const target = newer.get(id);
    if (target === undefined) {
      base.lostTerminals.push({ instance: ref.instance, terminal: ref.terminal, other: refText(other) });
      return;
    }
    if (ref.pad !== undefined && !target.pads.includes(ref.pad)) base.lostPads.push({ instance: ref.instance, terminal: ref.terminal, pad: ref.pad, other: refText(other) });
  };
  for (const j of design.joints) {
    visit(j.a, j.b);
    visit(j.b, j.a);
    if (j.through !== undefined) visit(j.through, j.a);
  }

  // a jumper or switch state is lost when the older board had the part and the newer one does not
  const refsOf = (b: PcbaDefinition): Set<string> =>
    new Set([...(b.netlist?.parts ?? []).map((p) => p.ref), ...b.internalLinks.flatMap((l) => (l.elements ?? []).map((e) => e.designator)).filter((d): d is string => d !== undefined)]);
  const hadRefs = refsOf(fromRec as PcbaDefinition);
  const hasRefs = refsOf(toRec as PcbaDefinition);
  for (const inst of design.instances.pcbas) {
    if (!placed.has(inst.id)) continue;
    for (const ref of Object.keys(inst.partStates ?? {})) if (hadRefs.has(ref) && !hasRefs.has(ref)) base.lostStates.push({ instance: inst.id, ref });
  }

  const oldLinks = new Set((fromRec as PcbaDefinition).internalLinks.map(linkKey));
  const newLinks = new Set((toRec as PcbaDefinition).internalLinks.map(linkKey));
  const rename = (k: string): string => {
    const [ends = '', via = ''] = k.split('|');
    return `${ends.split('~').map((t) => moved.get(t) ?? t).sort().join('~')}|${via}`;
  };
  const oldRenamed = new Set([...oldLinks].map(rename));
  base.links = { added: [...newLinks].filter((k) => !oldRenamed.has(k)).length, removed: [...oldRenamed].filter((k) => !newLinks.has(k)).length };
  return base;
}

/** Something the newer revision changes for this design that a person may want to look at (lost landings, pads or states). */
export function impactNeedsLook(impact: AdoptImpact): boolean {
  return impact.lostTerminals.length + impact.lostPads.length + impact.lostStates.length > 0;
}

/* ------------------------------------------------------------------ *
 * Adopt
 * ------------------------------------------------------------------ */

/**
 * `design` with its placements of `fromId` switched to `toId`: landings on terminals the newer
 * board renamed follow the new ids; a pad qualifier the newer terminal does not declare is
 * dropped (the landing stays on its terminal); a landing on a terminal the newer board does not
 * have, and a jumper state for a part it no longer has, go. The impact lists each of these before
 * anything is switched, and the design's history keeps what it was. Unchanged when it does not
 * place `fromId`.
 */
export function adoptRevision(db: Db, design: CableDesign, kind: AdoptKind, fromId: string, toId: string): CableDesign {
  const impact = adoptImpact(db, design, kind, fromId, toId);
  if (impact === undefined) return design;
  if (kind === 'mechanicals') {
    const swap = (v: string | undefined): string | undefined => (v === fromId ? toId : v);
    return {
      ...design,
      instances: {
        ...design.instances,
        ...(design.instances.mechanical === undefined ? {} : { mechanical: design.instances.mechanical.map((m) => (m.def === fromId ? { ...m, def: toId } : m)) }),
        connectors: design.instances.connectors.map((c) =>
          c.cavities === undefined
            ? c
            : {
                ...c,
                cavities: c.cavities.map((a) => {
                  const next = { ...a };
                  for (const key of ['contact', 'seal', 'plug', 'tool'] as const) {
                    const v = swap(a[key]);
                    if (v !== undefined) next[key] = v;
                  }
                  return next;
                }),
              },
        ),
      },
    };
  }
  const placed = new Set(impact.instances);
  const moved = new Map(impact.renamed.map((r) => [r.from, r.to]));
  const gone = new Set(impact.lostTerminals.map((l) => `${l.instance}\u0000${l.terminal}`));
  const padless = new Set(impact.lostPads.map((l) => `${l.instance}\u0000${l.terminal}\u0000${l.pad ?? ''}`));
  const lands = (ref: TerminalRef | undefined): boolean => ref !== undefined && placed.has(ref.instance) && gone.has(`${ref.instance}\u0000${ref.terminal}`);
  const follow = (ref: TerminalRef): TerminalRef => {
    if (!placed.has(ref.instance)) return ref;
    let next = ref;
    if (ref.pad !== undefined && padless.has(`${ref.instance}\u0000${ref.terminal}\u0000${ref.pad}`)) {
      const { pad: _dropped, ...rest } = next;
      next = rest;
    }
    const to = moved.get(ref.terminal);
    return to === undefined ? next : { ...next, terminal: to };
  };
  const joints: Joint[] = [];
  for (const j of design.joints) {
    // a landing on a terminal the newer board does not have goes (the impact listed it)
    if (lands(j.a) || lands(j.b)) continue;
    const a = follow(j.a);
    const b = follow(j.b);
    const through = j.through === undefined || lands(j.through) ? undefined : follow(j.through);
    if (a === j.a && b === j.b && through === j.through) {
      joints.push(j);
      continue;
    }
    const { through: _old, ...rest } = j;
    joints.push({ ...rest, a, b, ...(through === undefined ? {} : { through }) });
  }
  const lostStates = new Set(impact.lostStates.map((s) => `${s.instance}\u0000${s.ref}`));
  const pcbas = design.instances.pcbas.map((p) => {
    if (p.def !== fromId) return p;
    const states = Object.entries(p.partStates ?? {}).filter(([ref]) => !lostStates.has(`${p.id}\u0000${ref}`));
    const { partStates: _states, ...rest } = p;
    return { ...rest, def: toId, ...(states.length === 0 ? {} : { partStates: Object.fromEntries(states) }) };
  });
  return { ...design, instances: { ...design.instances, pcbas }, joints };
}

/**
 * For each part `design` places that has a newer revision: the newest one and what moving to it
 * changes. The editor's "newer revision" chip.
 */
export function newerRevisionsInDesign(db: Db, design: CableDesign): AdoptImpact[] {
  const out: AdoptImpact[] = [];
  for (const kind of ADOPT_KINDS) {
    const used = new Set<string>(
      kind === 'pcbas'
        ? design.instances.pcbas.map((p) => p.def)
        : [...(design.instances.mechanical ?? []).map((m) => m.def), ...design.instances.connectors.flatMap((c) => (c.cavities ?? []).flatMap((a) => [a.contact, a.seal, a.plug, a.tool]).filter((v): v is string => v !== undefined))],
    );
    for (const id of [...used].sort()) {
      const family = revisionFamily(db, kind, id);
      const target = newestRevision(family);
      if (target === undefined || target.id === id) continue;
      if (!olderRevisions(family, target).some((s) => s.id === id)) continue;
      const impact = adoptImpact(db, design, kind, id, target.id);
      if (impact !== undefined) out.push(impact);
    }
  }
  return out;
}

/** A one-line summary of an impact: `+2 −1 terminals · 1 renamed · 2 landings lose their pad`. */
export function impactSummary(impact: AdoptImpact): string {
  const parts: string[] = [];
  if (impact.added.length + impact.removed.length > 0) parts.push(`+${impact.added.length} −${impact.removed.length} terminals`);
  if (impact.renamed.length > 0) parts.push(`${impact.renamed.length} renamed`);
  if (impact.lostTerminals.length > 0) parts.push(`${impact.lostTerminals.length} landing${impact.lostTerminals.length === 1 ? '' : 's'} lose${impact.lostTerminals.length === 1 ? 's' : ''} its terminal`);
  if (impact.lostPads.length > 0) parts.push(`${impact.lostPads.length} landing${impact.lostPads.length === 1 ? '' : 's'} lose${impact.lostPads.length === 1 ? 's' : ''} its pad`);
  if (impact.lostStates.length > 0) parts.push(`${impact.lostStates.length} jumper state${impact.lostStates.length === 1 ? '' : 's'} dropped`);
  if (impact.links.added + impact.links.removed > 0) parts.push(`links +${impact.links.added} −${impact.links.removed}`);
  return parts.length === 0 ? 'no wiring change' : parts.join(' · ');
}
