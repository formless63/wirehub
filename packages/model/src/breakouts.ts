/**
 * Breakouts: a point along the cable — a mould or
 * overmould — where a trunk segment end meets the ends of its legs, and what
 * becomes of every conductor there.
 *
 * Some wires pass right through the breakout and are not cut, while others
 * are terminated in the breakout and head to another connector. A conductor of a participating end is either
 *
 * - **through** — the same physical conductor continues, uncut, on a leg of
 *   the same stock (the BNC mould's red mini-coax line to its plug): the two
 *   ends are continuous copper, no joint;
 * - **terminated** — it ends in the mould, soldered there (a joint at that
 *   end, to a jack housed in the mould or spliced onto a leg's conductor);
 * - **nc** — cut back in the mould, landed nowhere, with a reason.
 *
 * Presentation-free: everything here is a pure read (or a pure edit) of the
 * design and its definitions.
 */

import {
  CURRENT_SCHEMA_VERSION,
  findMechanical,
  findWire,
  pigtailIdOf,
  type BreakoutConductor,
  type BreakoutFate,
  type BreakoutInstance,
  type CableDesign,
  type Db,
  type Issue,
  type Joint,
  type SegmentInstance,
  type TerminalRef,
  type WireDefinition,
} from './model.ts';
import { electricalPaths, isElectricalElement, resolveElementPath } from './paths.ts';

type End = 'a' | 'b';

/* ------------------------------------------------------------------ *
 * Scope — a leg that carries part of its trunk's stock
 * ------------------------------------------------------------------ */

/** Is element `path` carried by this segment (inside its `scope`, or no scope)? */
export function inScope(segment: Pick<SegmentInstance, 'scope'> | undefined, path: string): boolean {
  const scope = segment?.scope;
  if (scope === undefined) return true;
  return scope.some((s) => path === s || path.startsWith(`${s}.`));
}

/** The terminal-bearing element paths this segment actually carries, in tree order. */
export function segmentElectricalPaths(wire: WireDefinition, segment: Pick<SegmentInstance, 'scope'> | undefined): string[] {
  return electricalPaths(wire.structure).filter((path) => inScope(segment, path));
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

/** The design's breakouts (none when absent). */
export function breakoutsOf(design: Pick<CableDesign, 'instances'>): BreakoutInstance[] {
  return design.instances.breakouts ?? [];
}

/** The breakout a segment end sits in, and whether that end is its trunk or a leg. */
export function breakoutAt(
  design: Pick<CableDesign, 'instances'>,
  segment: string,
  end: End,
): { breakout: BreakoutInstance; role: 'trunk' | 'leg' } | undefined {
  for (const breakout of breakoutsOf(design)) {
    if (breakout.trunk.segment === segment && breakout.trunk.end === end) return { breakout, role: 'trunk' };
    if (breakout.legs.some((l) => l.segment === segment && l.end === end)) return { breakout, role: 'leg' };
  }
  return undefined;
}

/** The end of `segment` that sits in `breakout`, if any. */
export function breakoutEndOf(breakout: BreakoutInstance, segment: string): End | undefined {
  if (breakout.trunk.segment === segment) return breakout.trunk.end;
  return breakout.legs.find((l) => l.segment === segment)?.end;
}

/** The electrical element paths an entry stands for (a group → its conductors and screens). */
export function breakoutEntryPaths(wire: WireDefinition, entry: Pick<BreakoutConductor, 'path'>): string[] {
  const element = resolveElementPath(wire.structure, entry.path);
  if (element === undefined) return [];
  if (isElectricalElement(element)) return [entry.path];
  if (element.kind !== 'group') return [];
  return electricalPaths(wire.structure).filter((p) => p.startsWith(`${entry.path}.`));
}

/** One element's fate at a breakout, expanded from the entry that states it. */
export interface BreakoutElementFate {
  breakout: string;
  segment: string;
  end: End;
  path: string;
  fate: BreakoutFate;
  /** through: the other side of the pass-through (the leg end, or — seen from a leg — the trunk end) */
  peer?: TerminalRef;
  reason?: string;
  /** the entry stating it */
  entry: BreakoutConductor;
}

function key(segment: string, path: string, end: End): string {
  return `${segment}:${path}@${end}`;
}

/**
 * Every element end a breakout accounts for, keyed by terminal key
 * (`w1:core-red.center@b`). A through entry accounts for both its trunk end
 * and the leg end it continues on. Later duplicates do not overwrite earlier
 * ones (validation reports them).
 */
export function breakoutFates(design: Pick<CableDesign, 'instances'>, db: Db): Map<string, BreakoutElementFate> {
  const out = new Map<string, BreakoutElementFate>();
  const segments = new Map(design.instances.segments.map((s) => [s.id, s]));
  for (const breakout of breakoutsOf(design)) {
    for (const entry of breakout.conductors) {
      const segment = segments.get(entry.segment);
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      const end = breakoutEndOf(breakout, entry.segment);
      if (wire === undefined || end === undefined) continue;
      for (const path of breakoutEntryPaths(wire, entry)) {
        const k = key(entry.segment, path, end);
        const legEnd = entry.fate === 'through' && entry.leg !== undefined ? breakoutEndOf(breakout, entry.leg) : undefined;
        const peer: TerminalRef | undefined =
          legEnd === undefined || entry.leg === undefined ? undefined : { instance: entry.leg, terminal: path, end: legEnd };
        if (!out.has(k)) {
          out.set(k, {
            breakout: breakout.id,
            segment: entry.segment,
            end,
            path,
            fate: entry.fate,
            ...(peer === undefined ? {} : { peer }),
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
            entry,
          });
        }
        if (peer !== undefined) {
          const pk = key(peer.instance, path, peer.end!);
          if (!out.has(pk)) {
            out.set(pk, {
              breakout: breakout.id,
              segment: peer.instance,
              end: peer.end!,
              path,
              fate: 'through',
              peer: { instance: entry.segment, terminal: path, end },
              entry,
            });
          }
        }
      }
    }
  }
  return out;
}

/** A pass-through: the same conductor on both sides of a mould. */
export interface ThroughPair {
  breakout: string;
  /** the trunk side (the entry's own segment end) */
  from: TerminalRef;
  /** the leg it continues on */
  to: TerminalRef;
}

/** Every pass-through conductor of the design (valid ones: the leg carries the path). */
export function throughPairs(design: Pick<CableDesign, 'instances'>, db: Db): ThroughPair[] {
  const out: ThroughPair[] = [];
  const segments = new Map(design.instances.segments.map((s) => [s.id, s]));
  for (const breakout of breakoutsOf(design)) {
    for (const entry of breakout.conductors) {
      if (entry.fate !== 'through' || entry.leg === undefined) continue;
      const segment = segments.get(entry.segment);
      const leg = segments.get(entry.leg);
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      const end = breakoutEndOf(breakout, entry.segment);
      const legEnd = breakoutEndOf(breakout, entry.leg);
      if (wire === undefined || leg === undefined || end === undefined || legEnd === undefined || leg.def !== segment!.def) continue;
      for (const path of breakoutEntryPaths(wire, entry)) {
        if (!inScope(segment, path) || !inScope(leg, path)) continue;
        out.push({
          breakout: breakout.id,
          from: { instance: entry.segment, terminal: path, end },
          to: { instance: entry.leg, terminal: path, end: legEnd },
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function issue(code: string, message: string, where: string, severity: 'error' | 'warning' = 'error'): Issue {
  return { code, severity, message, where };
}

function refKey(ref: TerminalRef): string {
  return `${ref.instance}:${ref.terminal}${ref.end === undefined ? '' : `@${ref.end}`}`;
}

/** The landings (joint peers) of a segment terminal, direct or through a pigtail it is twisted into. */
function landingsOf(design: CableDesign, db: Db, segment: SegmentInstance, path: string, end: End): TerminalRef[] {
  const wire = findWire(db, segment.def);
  const own = refKey({ instance: segment.id, terminal: path, end });
  const tails = new Set<string>();
  for (const p of segment.pigtails ?? []) {
    if (p.end !== end) continue;
    const members = p.members ?? (wire === undefined ? [] : electricalPaths(wire.structure));
    if (members.includes(path)) tails.add(refKey({ instance: segment.id, terminal: `pigtail:${p.id}`, end }));
  }
  const out: TerminalRef[] = [];
  for (const joint of design.joints) {
    for (const [mine, far] of [[joint.a, joint.b], [joint.b, joint.a]] as const) {
      const k = refKey(mine);
      if (k === own || tails.has(k)) out.push(far);
    }
  }
  return out;
}

/**
 * The breakout rules: each participating end exists once; the mould and the
 * housed parts are instances; every conductor and screen (in scope) of the
 * trunk end and of each leg end is accounted for exactly once; a through
 * conductor continues on a leg of the same stock that carries it, and is
 * soldered to nothing at the mould; a terminated one lands; an NC one has a
 * reason and lands nowhere. A design with breakouts is schema v4.
 */
export function breakoutIssues(design: CableDesign, db: Db): Issue[] {
  const issues: Issue[] = [];
  const list = breakoutsOf(design);
  for (const segment of design.instances.segments) {
    if (segment.scope === undefined) continue;
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const path of segment.scope) {
      if (resolveElementPath(wire.structure, path) === undefined) {
        issues.push(issue('scope-unknown-path', `segment '${segment.id}' scope names '${path}', which is not an element of '${wire.id}'`, segment.id));
      }
    }
  }
  if (list.length === 0) return issues;
  const segments = new Map(design.instances.segments.map((s) => [s.id, s]));
  const usedEnds = new Map<string, string>();
  const mechanical = new Set((design.instances.mechanical ?? []).map((m) => m.id));
  const instanceIds = new Set([
    ...design.instances.connectors.map((i) => i.id),
    ...design.instances.segments.map((i) => i.id),
    ...design.instances.components.map((i) => i.id),
    ...design.instances.pcbas.map((i) => i.id),
    ...(design.instances.mechanical ?? []).map((i) => i.id),
  ]);
  const jointed = new Set<string>();
  for (const joint of design.joints) {
    jointed.add(refKey(joint.a));
    jointed.add(refKey(joint.b));
  }

  for (const breakout of list) {
    const where = breakout.id;
    if (breakout.mould !== undefined) {
      if (!mechanical.has(breakout.mould)) {
        issues.push(issue('breakout-mould-unknown', `breakout '${breakout.id}' names mould '${breakout.mould}', which is not a mechanical instance of this design`, where));
      }
    }
    for (const id of breakout.housed ?? []) {
      if (!instanceIds.has(id)) issues.push(issue('breakout-housed-unknown', `breakout '${breakout.id}' houses unknown instance '${id}'`, where));
    }
    const ends: { segment: string; end: End; role: 'trunk' | 'leg' }[] = [
      { ...breakout.trunk, role: 'trunk' },
      ...breakout.legs.map((l) => ({ ...l, role: 'leg' as const })),
    ];
    for (const e of ends) {
      if (!segments.has(e.segment)) {
        issues.push(issue('breakout-unknown-segment', `breakout '${breakout.id}' names unknown segment '${e.segment}'`, where));
        continue;
      }
      if (e.end !== 'a' && e.end !== 'b') {
        issues.push(issue('breakout-bad-end', `breakout '${breakout.id}': segment '${e.segment}' end must be 'a' or 'b'`, where));
        continue;
      }
      const k = `${e.segment}@${e.end}`;
      const prev = usedEnds.get(k);
      if (prev !== undefined) {
        issues.push(issue('breakout-segment-end-twice', `segment end ${k} is in breakout '${prev}' and again in '${breakout.id}'`, where));
      } else usedEnds.set(k, breakout.id);
    }
    if (breakout.legs.some((l) => l.segment === breakout.trunk.segment)) {
      issues.push(issue('breakout-leg-is-trunk', `breakout '${breakout.id}': its trunk '${breakout.trunk.segment}' is also one of its legs`, where));
    }

    // accounting
    const accounted = new Map<string, BreakoutFate>();
    const account = (k: string, fate: BreakoutFate, at: string): void => {
      if (accounted.has(k)) issues.push(issue('breakout-conductor-twice', `breakout '${breakout.id}' accounts for ${k} more than once`, at));
      else accounted.set(k, fate);
    };
    breakout.conductors.forEach((entry, index) => {
      const at = `${where}.conductors[${index}]`;
      const end = breakoutEndOf(breakout, entry.segment);
      const segment = segments.get(entry.segment);
      if (end === undefined) {
        issues.push(issue('breakout-not-participant', `breakout '${breakout.id}': '${entry.segment}' is neither its trunk nor one of its legs`, at));
        return;
      }
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      if (segment === undefined || wire === undefined) return;
      const paths = breakoutEntryPaths(wire, entry).filter((p) => inScope(segment, p));
      if (paths.length === 0) {
        issues.push(issue('breakout-unknown-path', `breakout '${breakout.id}': '${entry.path}' is not a conductor, screen or group of '${entry.segment}' (${wire.id}${segment.scope === undefined ? '' : `, scope ${segment.scope.join(', ')}`})`, at));
        return;
      }
      if (entry.fate === 'nc' && (entry.reason === undefined || entry.reason.trim() === '')) {
        issues.push(issue('breakout-nc-reason', `breakout '${breakout.id}': ${entry.segment}:${entry.path}@${end} is NC with no reason`, at));
      }
      if (entry.fate === 'through') {
        const leg = entry.leg === undefined ? undefined : segments.get(entry.leg);
        const legEnd = entry.leg === undefined ? undefined : breakoutEndOf(breakout, entry.leg);
        if (entry.leg === undefined || leg === undefined || legEnd === undefined || entry.leg === breakout.trunk.segment && entry.segment === breakout.trunk.segment) {
          issues.push(issue('breakout-through-leg', `breakout '${breakout.id}': ${entry.segment}:${entry.path} passes through but names no leg of this breakout to continue on`, at));
          return;
        }
        if (leg.def !== segment.def) {
          issues.push(issue('breakout-through-stock', `breakout '${breakout.id}': ${entry.segment}:${entry.path} passes through uncut onto '${leg.id}', which is a different stock (${leg.def}, not ${segment.def}) — a conductor that changes stock is terminated and spliced, not passed through`, at));
          return;
        }
        for (const path of paths) {
          if (!inScope(leg, path)) {
            issues.push(issue('breakout-through-scope', `breakout '${breakout.id}': ${path} passes through onto '${leg.id}', whose scope does not carry it`, at));
            continue;
          }
          account(key(entry.segment, path, end), 'through', at);
          account(key(leg.id, path, legEnd), 'through', at);
          for (const k of [key(entry.segment, path, end), key(leg.id, path, legEnd)]) {
            if (jointed.has(k)) issues.push(issue('breakout-through-jointed', `${k} passes through the mould uncut, so nothing can be soldered to it there`, at));
          }
        }
        return;
      }
      for (const path of paths) {
        account(key(entry.segment, path, end), entry.fate, at);
        const landings = landingsOf(design, db, segment, path, end);
        if (entry.fate === 'nc' && landings.length > 0) {
          issues.push(issue('breakout-nc-jointed', `${key(entry.segment, path, end)} is NC in breakout '${breakout.id}' but lands on ${landings.map(refKey).join(', ')} — mark it terminated`, at, 'warning'));
        }
        if (entry.fate === 'terminated') {
          if (landings.length === 0) {
            issues.push(issue('breakout-terminated-open', `${key(entry.segment, path, end)} is terminated in breakout '${breakout.id}' but lands on nothing there yet`, at, 'warning'));
          }
          const inside = (ref: TerminalRef): boolean =>
            (breakout.housed ?? []).includes(ref.instance) ||
            (ref.end !== undefined && breakoutEndOf(breakout, ref.instance) === ref.end);
          const outside = landings.filter((ref) => !inside(ref));
          if (outside.length > 0) {
            issues.push(
              issue(
                'breakout-terminated-outside',
                `${key(entry.segment, path, end)} is terminated in breakout '${breakout.id}' but lands on ${outside.map(refKey).join(', ')}, which is not housed in the mould nor a leg end there`,
                at,
                'warning',
              ),
            );
          }
        }
      }
    });
    for (const e of ends) {
      const segment = segments.get(e.segment);
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      if (segment === undefined || wire === undefined) continue;
      const missing = segmentElectricalPaths(wire, segment).filter((p) => !accounted.has(key(e.segment, p, e.end)));
      if (missing.length > 0) {
        issues.push(
          issue(
            'breakout-conductor-missing',
            `breakout '${breakout.id}' does not say what becomes of ${missing.map((p) => key(e.segment, p, e.end)).join(', ')} (pass-through, terminated, or NC with a reason)`,
            where,
          ),
        );
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Views: what a drawing needs, still presentation-free
 * ------------------------------------------------------------------ */

export interface BreakoutRow {
  segment: string;
  end: End;
  path: string;
  fate: BreakoutFate;
  /** through: where it continues; terminated: what it is soldered to in the mould */
  to: TerminalRef[];
  reason?: string;
}

export interface BreakoutLegView {
  segment: string;
  end: End;
  def: string;
  lengthMm?: number;
  scope?: string[];
  /** element paths that continue uncut from the trunk onto this leg */
  through: string[];
}

export interface BreakoutView {
  id: string;
  role?: string;
  note?: string;
  /** the mould part, when named: its mechanical instance and definition */
  mould?: { instance: string; def: string; label?: string; partNumber?: string };
  trunk: { segment: string; end: End; def: string };
  legs: BreakoutLegView[];
  housed: string[];
  /** one row per element of every participating end, trunk first */
  rows: BreakoutRow[];
}

/** Each breakout, spelled out per element for the views (schematic, canvas, docs). */
export function breakoutViews(design: CableDesign, db: Db): BreakoutView[] {
  const fates = breakoutFates(design, db);
  const segments = new Map(design.instances.segments.map((s) => [s.id, s]));
  return breakoutsOf(design).map((breakout) => {
    const mouldInst = breakout.mould === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === breakout.mould);
    const mouldDef = mouldInst === undefined ? undefined : findMechanical(db, mouldInst.def);
    const rows: BreakoutRow[] = [];
    const ends = [breakout.trunk, ...breakout.legs];
    for (const e of ends) {
      const segment = segments.get(e.segment);
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      if (segment === undefined || wire === undefined) continue;
      for (const path of segmentElectricalPaths(wire, segment)) {
        const fate = fates.get(key(e.segment, path, e.end));
        // a leg's through conductor is the trunk's row seen from the other side
        if (fate?.fate === 'through' && e !== breakout.trunk) continue;
        const to =
          fate === undefined ? [] : fate.fate === 'through' ? (fate.peer === undefined ? [] : [fate.peer]) : landingsOf(design, db, segment, path, e.end);
        rows.push({
          segment: e.segment,
          end: e.end,
          path,
          fate: fate?.fate ?? 'nc',
          to,
          ...(fate?.reason === undefined ? {} : { reason: fate.reason }),
        });
      }
    }
    const trunkSeg = segments.get(breakout.trunk.segment);
    return {
      id: breakout.id,
      ...(breakout.role === undefined ? {} : { role: breakout.role }),
      ...(breakout.note === undefined ? {} : { note: breakout.note }),
      ...(mouldInst === undefined
        ? {}
        : {
            mould: {
              instance: mouldInst.id,
              def: mouldInst.def,
              ...(mouldDef?.label === undefined ? {} : { label: mouldDef.label }),
              ...(mouldDef?.partNumber === undefined ? {} : { partNumber: mouldDef.partNumber }),
            },
          }),
      trunk: { ...breakout.trunk, def: trunkSeg?.def ?? '' },
      legs: breakout.legs.map((l) => {
        const seg = segments.get(l.segment);
        return {
          segment: l.segment,
          end: l.end,
          def: seg?.def ?? '',
          ...(seg?.lengthMm === undefined ? {} : { lengthMm: seg.lengthMm }),
          ...(seg?.scope === undefined ? {} : { scope: [...seg.scope] }),
          through: rows.filter((r) => r.fate === 'through' && r.to.some((t) => t.instance === l.segment)).map((r) => r.path),
        };
      }),
      housed: [...(breakout.housed ?? [])],
      rows,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Edits (pure: design in, design out) — the editor's breakout actions
 * ------------------------------------------------------------------ */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freshId(taken: ReadonlySet<string>, stem: string): string {
  for (let n = 1; ; n += 1) {
    const id = `${stem}${n}`;
    if (!taken.has(id)) return id;
  }
}

function allIds(design: CableDesign): Set<string> {
  return new Set([
    ...design.instances.connectors.map((i) => i.id),
    ...design.instances.segments.map((i) => i.id),
    ...design.instances.components.map((i) => i.id),
    ...design.instances.pcbas.map((i) => i.id),
    ...(design.instances.mechanical ?? []).map((i) => i.id),
    ...breakoutsOf(design).map((i) => i.id),
  ]);
}

/** One entry per top-level element the segment carries: a group stands for its conductors and screens. */
function topEntries(wire: WireDefinition, segment: SegmentInstance): string[] {
  const out: string[] = [];
  for (const child of wire.structure.children) {
    if (child.kind === 'insulation') continue;
    if (child.kind === 'group') {
      if (electricalPaths(wire.structure).some((p) => p.startsWith(`${child.id}.`) && inScope(segment, p))) {
        if (inScope(segment, child.id)) out.push(child.id);
        else for (const p of electricalPaths(wire.structure)) if (p.startsWith(`${child.id}.`) && inScope(segment, p)) out.push(p);
      }
    } else if (inScope(segment, child.id)) out.push(child.id);
  }
  return out;
}

export interface SplitOptions {
  /** where along the segment, mm from end `a` (the trunk keeps this length) */
  atMm?: number;
  /** the mould's mechanical definition, when there is one */
  mouldDef?: string;
}

/**
 * Split a segment at a point into a breakout: the segment keeps its end `a`
 * (and `atMm` of its length), a new segment of the same stock continues from
 * the breakout to where end `b` was — taking over every joint and pigtail
 * there — and every conductor passes through uncut. The start for marking
 * some terminated or NC and attaching legs. Schema v4.
 */
export function splitSegmentAtBreakout(design: CableDesign, db: Db, segmentId: string, options: SplitOptions = {}): CableDesign {
  const out = clone(design);
  const segment = out.instances.segments.find((s) => s.id === segmentId);
  if (segment === undefined) throw new Error(`no segment '${segmentId}'`);
  const wire = findWire(db, segment.def);
  if (wire === undefined) throw new Error(`unknown stock '${segment.def}'`);
  if (breakoutAt(out, segmentId, 'b') !== undefined) throw new Error(`${segmentId}@b is already in a breakout`);
  const ids = allIds(out);
  const legId = freshId(ids, 'w');
  ids.add(legId);
  const bkId = freshId(ids, 'bk');
  ids.add(bkId);
  const total = segment.lengthMm;
  const at = options.atMm;
  const leg: SegmentInstance = {
    id: legId,
    def: segment.def,
    ...(total !== undefined && at !== undefined && at < total ? { lengthMm: total - at } : {}),
    role: `continues from ${bkId}`,
    ...(segment.scope === undefined ? {} : { scope: [...segment.scope] }),
  };
  if (at !== undefined) segment.lengthMm = at;
  // everything that was at segment@b moves to the new leg's end b
  const move = (ref: TerminalRef): TerminalRef => (ref.instance === segmentId && ref.end === 'b' ? { ...ref, instance: legId } : ref);
  out.joints = out.joints.map((j) => ({ ...j, a: move(j.a), b: move(j.b) }));
  const kept = (segment.pigtails ?? []).filter((p) => p.end === 'a');
  const moved = (segment.pigtails ?? []).filter((p) => p.end === 'b');
  if (kept.length) segment.pigtails = kept;
  else delete segment.pigtails;
  if (moved.length) leg.pigtails = moved;
  const index = out.instances.segments.indexOf(segment);
  out.instances.segments.splice(index + 1, 0, leg);
  // move any other breakout that held segment@b onto the leg
  for (const b of breakoutsOf(out)) {
    for (const l of b.legs) if (l.segment === segmentId && l.end === 'b') l.segment = legId;
    for (const c of b.conductors) {
      if (c.segment === segmentId && breakoutEndOf(b, legId) === 'b') c.segment = legId;
      if (c.leg === segmentId) c.leg = legId;
    }
  }
  let mould: string | undefined;
  if (options.mouldDef !== undefined) {
    mould = freshId(ids, 'm-mould-');
    (out.instances.mechanical ??= []).push({ id: mould, def: options.mouldDef, qty: 1 });
  }
  const breakout: BreakoutInstance = {
    id: bkId,
    ...(mould === undefined ? {} : { mould }),
    trunk: { segment: segmentId, end: 'b' },
    legs: [{ segment: legId, end: 'a' }],
    conductors: topEntries(wire, segment).map((path) => ({ segment: segmentId, path, fate: 'through', leg: legId })),
  };
  (out.instances.breakouts ??= []).push(breakout);
  out.schemaVersion = CURRENT_SCHEMA_VERSION;
  return out;
}

/** Spell a group entry out per element, so one of its elements can change fate alone. */
function explode(breakout: BreakoutInstance, wire: WireDefinition, segment: string, path: string): void {
  const i = breakout.conductors.findIndex((c) => c.segment === segment && c.path !== path && path.startsWith(`${c.path}.`));
  if (i < 0) return;
  const entry = breakout.conductors[i]!;
  const parts = breakoutEntryPaths(wire, entry).map((p) => ({ ...entry, path: p }));
  breakout.conductors.splice(i, 1, ...parts);
}

export interface FateOptions {
  /** through: the leg to continue on (defaults to the one it already names, else the first leg of the same stock) */
  leg?: string;
  /** nc: why */
  reason?: string;
  /** terminated, from through: splice the cut conductor back onto its leg in the mould (default true) */
  splice?: boolean;
}

/**
 * Set what becomes of one conductor (or a whole group) of a breakout end.
 * Marking a through conductor terminated or NC cuts it: the leg side it
 * continued on is left NC ("cut at the breakout") until something lands on
 * it. Joints stay as they are — terminating something is then a matter of
 * soldering it (a joint), which validation asks for.
 */
export function setBreakoutFate(
  design: CableDesign,
  db: Db,
  breakoutId: string,
  segmentId: string,
  path: string,
  fate: BreakoutFate,
  options: FateOptions = {},
): CableDesign {
  const out = clone(design);
  const breakout = breakoutsOf(out).find((b) => b.id === breakoutId);
  if (breakout === undefined) throw new Error(`no breakout '${breakoutId}'`);
  const segment = out.instances.segments.find((s) => s.id === segmentId);
  const wire = segment === undefined ? undefined : findWire(db, segment.def);
  if (segment === undefined || wire === undefined) throw new Error(`no segment '${segmentId}'`);
  if (breakoutEndOf(breakout, segmentId) === undefined) throw new Error(`${segmentId} is not in breakout '${breakoutId}'`);
  // seen from a leg, a through conductor is stated on the trunk's side
  const stated = breakout.conductors.find(
    (c) => c.fate === 'through' && c.leg === segmentId && (c.path === path || path.startsWith(`${c.path}.`) || c.path.startsWith(`${path}.`)),
  );
  let owner = segmentId;
  if (stated !== undefined && stated.segment !== segmentId) {
    owner = stated.segment;
    if (fate === 'through') return out;
  }
  const ownerWire = findWire(db, out.instances.segments.find((s) => s.id === owner)!.def)!;
  explode(breakout, ownerWire, owner, path);
  const affected = new Set(breakoutEntryPaths(ownerWire, { path }));
  // entries of this segment wholly inside `path` go; the new one replaces them
  const previous = breakout.conductors.filter((c) => c.segment === owner && breakoutEntryPaths(ownerWire, c).every((p) => affected.has(p)));
  const wasThroughTo = new Set(previous.filter((c) => c.fate === 'through' && c.leg !== undefined).map((c) => c.leg!));
  breakout.conductors = breakout.conductors.filter((c) => !previous.includes(c));
  let leg = options.leg;
  if (fate === 'through' && leg === undefined) {
    leg = previous.find((c) => c.leg !== undefined)?.leg ?? breakout.legs.find((l) => out.instances.segments.find((s) => s.id === l.segment)?.def === segment.def && [...affected].every((p) => inScope(out.instances.segments.find((s) => s.id === l.segment), p)))?.segment;
    if (leg === undefined) throw new Error(`no leg of '${segment.def}' carrying ${path} to pass it through onto`);
  }
  const entry: BreakoutConductor = {
    segment: owner,
    path,
    fate,
    ...(fate === 'through' ? { leg: leg! } : {}),
    ...(fate === 'nc' ? { reason: options.reason ?? 'not used' } : {}),
  };
  const at = breakout.conductors.findIndex((c) => c.segment === owner);
  if (at < 0) breakout.conductors.push(entry);
  else breakout.conductors.splice(at, 0, entry);
  // a leg that lost its pass-through: its side is now cut in the mould — or,
  // terminated, spliced back onto the same conductor there (the default: a
  // conductor cut and re-joined in the mould is still continuous copper)
  const ownerEnd = breakoutEndOf(breakout, owner)!;
  for (const legId of wasThroughTo) {
    if (fate === 'through' && legId === leg) continue;
    const legEnd = breakoutEndOf(breakout, legId)!;
    for (const p of affected) {
      if (!inScope(out.instances.segments.find((s) => s.id === legId), p)) continue;
      if (fate === 'terminated' && options.splice !== false) {
        out.joints.push({ a: { instance: owner, terminal: p, end: ownerEnd }, b: { instance: legId, terminal: p, end: legEnd }, note: `spliced in ${breakout.id}` });
        breakout.conductors.push({ segment: legId, path: p, fate: 'terminated' });
      } else breakout.conductors.push({ segment: legId, path: p, fate: 'nc', reason: 'cut at the breakout' });
    }
  }
  // a conductor passed through again: the splice that stood in for it goes
  if (fate === 'through' && leg !== undefined) {
    const legEnd = breakoutEndOf(breakout, leg)!;
    const splice = (ref: TerminalRef, p: string, seg: string, e: End): boolean => ref.instance === seg && ref.terminal === p && ref.end === e;
    out.joints = out.joints.filter(
      (j) =>
        ![...affected].some(
          (p) =>
            (splice(j.a, p, owner, ownerEnd) && splice(j.b, p, leg, legEnd)) || (splice(j.b, p, owner, ownerEnd) && splice(j.a, p, leg, legEnd)),
        ),
    );
  }
  // a leg that gains a pass-through: its own entries for those paths go
  if (fate === 'through' && leg !== undefined) {
    breakout.conductors = breakout.conductors.filter((c) => !(c.segment === leg && breakoutEntryPaths(ownerWire, c).every((p) => affected.has(p))));
  }
  return out;
}

export interface LegOptions {
  /** the leg's stock (defaults to the trunk's) */
  def?: string;
  lengthMm?: number;
  /** only these elements (a pass-through leg that is part of the trunk) */
  scope?: string[];
  /** which end sits in the mould (default: the one facing away from the trunk's own end) */
  end?: End;
}

/**
 * Attach a new leg to a breakout: a segment whose end sits in the mould, its
 * conductors NC ("not used") until they are passed through or soldered.
 */
export function attachBreakoutLeg(design: CableDesign, db: Db, breakoutId: string, options: LegOptions = {}): CableDesign {
  const out = clone(design);
  const breakout = breakoutsOf(out).find((b) => b.id === breakoutId);
  if (breakout === undefined) throw new Error(`no breakout '${breakoutId}'`);
  const trunk = out.instances.segments.find((s) => s.id === breakout.trunk.segment);
  const def = options.def ?? trunk?.def;
  const wire = def === undefined ? undefined : findWire(db, def);
  if (wire === undefined || def === undefined) throw new Error(`unknown stock '${def ?? ''}'`);
  const ids = allIds(out);
  const id = freshId(ids, 'w');
  const end: End = options.end ?? (breakout.trunk.end === 'b' ? 'a' : 'b');
  const leg: SegmentInstance = {
    id,
    def,
    ...(options.lengthMm === undefined ? {} : { lengthMm: options.lengthMm }),
    role: `leg of ${breakout.id}`,
    ...(options.scope === undefined ? {} : { scope: [...options.scope] }),
  };
  out.instances.segments.push(leg);
  breakout.legs.push({ segment: id, end });
  for (const path of topEntries(wire, leg)) breakout.conductors.push({ segment: id, path, fate: 'nc', reason: 'not used' });
  return out;
}

/* ------------------------------------------------------------------ *
 * Stock: a pass-through run is cut from its trunk
 * ------------------------------------------------------------------ */

/** A leg that is its trunk continuing: every element it carries passes through uncut. */
export interface PassThroughRun {
  segment: string;
  breakout: string;
  /** the segment it continues (same stock) */
  trunk: string;
  lengthMm?: number;
}

/**
 * The legs that are no separate piece of wire: every element they carry is a
 * pass-through from the trunk (the BNC mould's four mini-coax lines, the
 * continuation of a split). Their stock is the trunk's own cut — the jacket
 * stripped back past the mould — so a BOM counts the trunk cut as the trunk
 * plus its longest run, not the runs as extra wire.
 */
export function passThroughRuns(design: CableDesign, db: Db): PassThroughRun[] {
  const fates = breakoutFates(design, db);
  const out: PassThroughRun[] = [];
  for (const breakout of breakoutsOf(design)) {
    for (const leg of breakout.legs) {
      const segment = design.instances.segments.find((s) => s.id === leg.segment);
      const wire = segment === undefined ? undefined : findWire(db, segment.def);
      if (segment === undefined || wire === undefined) continue;
      const paths = segmentElectricalPaths(wire, segment);
      const all =
        paths.length > 0 &&
        paths.every((p) => {
          const f = fates.get(key(segment.id, p, leg.end));
          return f?.fate === 'through' && f.peer?.instance === breakout.trunk.segment;
        });
      if (!all) continue;
      out.push({
        segment: segment.id,
        breakout: breakout.id,
        trunk: breakout.trunk.segment,
        ...(segment.lengthMm === undefined ? {} : { lengthMm: segment.lengthMm }),
      });
    }
  }
  return out;
}

/** The joints of a design that land in a breakout (on a terminated element end of it). */
export function breakoutJoints(design: CableDesign, db: Db, breakoutId: string): Joint[] {
  const fates = breakoutFates(design, db);
  return design.joints.filter((j) =>
    [j.a, j.b].some((ref) => {
      if (ref.end === undefined) return false;
      if (pigtailIdOf(ref.terminal) !== undefined) return breakoutAt(design, ref.instance, ref.end)?.breakout.id === breakoutId;
      const f = fates.get(refKey(ref));
      return f?.breakout === breakoutId;
    }),
  );
}

/**
 * Take a breakout out again, when it is only a split: one leg of the same
 * stock that every conductor passes straight through to. The trunk takes the
 * leg's far end back (its joints and pigtails) and its length; anything else
 * — a leg that is spliced, NC or of another stock — is the owner's to undo by
 * hand, and throws.
 */
export function removeBreakout(design: CableDesign, db: Db, breakoutId: string): CableDesign {
  const out = clone(design);
  const breakout = breakoutsOf(out).find((b) => b.id === breakoutId);
  if (breakout === undefined) throw new Error(`no breakout '${breakoutId}'`);
  const leg = breakout.legs[0];
  const trunk = out.instances.segments.find((s) => s.id === breakout.trunk.segment);
  const legSeg = leg === undefined ? undefined : out.instances.segments.find((s) => s.id === leg.segment);
  const runs = passThroughRuns(out, db).filter((r) => r.breakout === breakoutId);
  if (breakout.legs.length !== 1 || leg === undefined || trunk === undefined || legSeg === undefined || runs.length !== 1 || legSeg.def !== trunk.def || (legSeg.scope ?? []).join() !== (trunk.scope ?? []).join()) {
    throw new Error(`${breakoutId} is more than a split of ${breakout.trunk.segment}: undo its legs by hand first`);
  }
  const trunkEnd = breakout.trunk.end;
  const far: End = leg.end === 'a' ? 'b' : 'a';
  if (far !== trunkEnd) throw new Error(`${breakoutId}: the leg runs the other way round`);
  const move = (ref: TerminalRef): TerminalRef => (ref.instance === legSeg.id && ref.end === far ? { ...ref, instance: trunk.id, end: trunkEnd } : ref);
  out.joints = out.joints.filter((j) => j.a.instance !== legSeg.id || j.a.end === far).map((j) => ({ ...j, a: move(j.a), b: move(j.b) }));
  const kept = (trunk.pigtails ?? []).filter((p) => p.end !== trunkEnd);
  const moved = (legSeg.pigtails ?? []).filter((p) => p.end === far).map((p) => ({ ...p, end: trunkEnd }));
  if (kept.length + moved.length > 0) trunk.pigtails = [...kept, ...moved];
  else delete trunk.pigtails;
  if (trunk.lengthMm !== undefined && legSeg.lengthMm !== undefined) trunk.lengthMm += legSeg.lengthMm;
  out.instances.segments = out.instances.segments.filter((s) => s.id !== legSeg.id);
  out.instances.breakouts = breakoutsOf(out).filter((b) => b.id !== breakoutId);
  if (breakout.mould !== undefined) out.instances.mechanical = (out.instances.mechanical ?? []).filter((m) => m.id !== breakout.mould);
  if (out.instances.mechanical?.length === 0) delete out.instances.mechanical;
  if (out.instances.breakouts.length === 0) delete out.instances.breakouts;
  return out;
}
