/**
 * The physical body of a design and the patch operations over it.
 *
 * A design's **body** is its `instances` + `joints`. What is compared is the
 * **physical** body: instance ids and defs, lengths, quantities, attachment,
 * component location, pigtail members, and every joint with its landing pad.
 * Prose — instance `role`/`note`, joint and pigtail notes — and the order of
 * lists are presentation; `materialiseBody` carries them over from a stored
 * body.
 *
 * `CableOverride` is a small patch language over a body (`applyOverrides`,
 * `diffBodies`): a module that derives bodies from higher-level choices (a
 * "recipe" engine) records hand differences as overrides, each with a reason.
 *
 * Everything here is pure: no rules, no catalog.
 */

import { CURRENT_SCHEMA_VERSION, SUBASSEMBLY_SCHEMA_VERSION } from './model.ts';
import type {
  BreakoutInstance,
  CableDesign,
  ComponentInstance,
  ConnectorInstance,
  DesignInstances,
  Joint,
  MechanicalInstance,
  PcbaInstance,
  Pigtail,
  SegmentInstance,
  TerminalRef,
} from './model.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * Why an override exists — a code the report groups by. `contradicts-rule:*`
 * codes mark a hand design that goes against a rule: the design is not
 * changed, a person decides.
 */
export type OverrideReason = string;

interface OverrideBase {
  reason: OverrideReason;
  /** free text: what the hand design does and why, when known */
  why?: string;
}

/** A physical joint as an override states it (no note — notes are prose). */
export interface OverrideJoint {
  a: TerminalRef;
  b: TerminalRef;
  /** the carrier hole the one solder point is made through (`Joint.through`) */
  through?: TerminalRef;
}

/** Which instance list an instance override addresses. */
export type InstanceListKey = 'connectors' | 'segments' | 'components' | 'pcbas' | 'mechanical' | 'breakouts';

export type CableOverride =
  | (OverrideBase & { op: 'add-joint'; joint: OverrideJoint })
  | (OverrideBase & { op: 'remove-joint'; key: string })
  /** the derived joint `key` keeps one landing and moves its other landing (`from`) to `to` */
  | (OverrideBase & { op: 'move-joint'; key: string; from: string; to: TerminalRef })
  /** add or replace (by id) an instance's physical fields; a segment carries its pigtails */
  | (OverrideBase & { op: 'put-instance'; list: InstanceListKey; instance: Record<string, unknown> & { id: string } })
  | (OverrideBase & { op: 'remove-instance'; list: InstanceListKey; id: string })
  /** add or replace (by id and end) a pigtail of a segment */
  | (OverrideBase & { op: 'put-pigtail'; segment: string; pigtail: Pigtail })
  | (OverrideBase & { op: 'remove-pigtail'; segment: string; id: string; end: 'a' | 'b' })
  /** no physical change: a finding the owner should see (a realisation the rules reject) */
  | (OverrideBase & { op: 'note'; key?: string; text: string });

/** The physical part of a design: its instances and joints. */
export interface DesignBody {
  instances: DesignInstances;
  joints: Joint[];
}

/**
 * The schema version to write a body at: `CURRENT_SCHEMA_VERSION`, or
 * `SUBASSEMBLY_SCHEMA_VERSION` when it places sub-assemblies (an older reader
 * must refuse it rather than drop them). The second argument is kept so
 * every writer still says what it is writing.
 */
export function schemaVersionFor(
  body: { instances: DesignInstances },
  _base?: 2 | 3,
): typeof CURRENT_SCHEMA_VERSION | typeof SUBASSEMBLY_SCHEMA_VERSION {
  return (body.instances.subassemblies ?? []).length > 0 ? SUBASSEMBLY_SCHEMA_VERSION : CURRENT_SCHEMA_VERSION;
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/** A landing: `instance:terminal@end[pad]` — the terminal key plus the pad it lands on. */
export function landingKey(ref: TerminalRef): string {
  return `${ref.instance}:${ref.terminal}${ref.end ? `@${ref.end}` : ''}${ref.pad ? `[${ref.pad}]` : ''}`;
}

/** An unordered joint key: the two landing keys, sorted, joined by ` -- `. */
export function jointKey(joint: { a: TerminalRef; b: TerminalRef }): string {
  return [landingKey(joint.a), landingKey(joint.b)].sort().join(' -- ');
}

/** Parse a landing key back into a terminal reference. */
export function parseLandingKey(key: string): TerminalRef {
  const m = /^([^:]+):(.+?)(?:@([ab]))?(?:\[([^\]]+)\])?$/.exec(key);
  if (m === null) throw new Error(`'${key}' is not a landing key`);
  return {
    instance: m[1]!,
    terminal: m[2]!,
    ...(m[3] === undefined ? {} : { end: m[3] as 'a' | 'b' }),
    ...(m[4] === undefined ? {} : { pad: m[4] }),
  };
}

/* ------------------------------------------------------------------ *
 * Physical view
 * ------------------------------------------------------------------ */

const LISTS: readonly InstanceListKey[] = ['connectors', 'segments', 'components', 'pcbas', 'mechanical', 'breakouts'];

/** Instance lists a design may omit entirely (absent = none). */
const OPTIONAL_LISTS: ReadonlySet<InstanceListKey> = new Set(['mechanical', 'breakouts']);

/** The physical fields of each instance kind (everything else is prose). */
const PHYSICAL: Readonly<Record<InstanceListKey, readonly string[]>> = {
  connectors: ['id', 'def'],
  segments: ['id', 'def', 'lengthMm', 'scope', 'pigtails'],
  components: ['id', 'def', 'location'],
  pcbas: ['id', 'def'],
  mechanical: ['id', 'def', 'qty', 'attachedTo'],
  breakouts: ['id', 'mould', 'trunk', 'legs', 'housed', 'conductors'],
};

type AnyInstance = ConnectorInstance | SegmentInstance | ComponentInstance | PcbaInstance | MechanicalInstance | BreakoutInstance;

function listOf(instances: DesignInstances, list: InstanceListKey): AnyInstance[] {
  return (OPTIONAL_LISTS.has(list) ? (instances[list as 'mechanical' | 'breakouts'] ?? []) : instances[list as 'connectors']) as AnyInstance[];
}

function physicalPigtail(p: Pigtail): Pigtail {
  return { id: p.id, end: p.end, ...(p.members === undefined ? {} : { members: [...p.members] }) };
}

/** An instance's physical fields only (a segment's pigtails without their notes). */
export function physicalInstance(list: InstanceListKey, inst: object): Record<string, unknown> & { id: string } {
  const out: Record<string, unknown> = {};
  const rec = inst as Record<string, unknown>;
  for (const k of PHYSICAL[list]) {
    const v = rec[k];
    if (v === undefined) continue;
    if (k === 'pigtails') {
      const pts = v as Pigtail[];
      if (pts.length) out[k] = pts.map(physicalPigtail);
    } else out[k] = v;
  }
  return out as Record<string, unknown> & { id: string };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function pigtailSig(p: Pigtail): string {
  return `${p.id}@${p.end}:${p.members === undefined ? '*' : [...p.members].sort().join(',')}`;
}

/** An instance's physical identity, order-free (pigtails as a set, members as a set). */
function instanceSig(list: InstanceListKey, inst: object): string {
  const phys = physicalInstance(list, inst);
  const { pigtails, ...rest } = phys as { pigtails?: Pigtail[] };
  return stable({ ...rest, ...(pigtails === undefined ? {} : { pigtails: pigtails.map(pigtailSig).sort() }) });
}

/**
 * The physical body in a normal form: instance lists sorted by id, pigtails
 * sorted, joints as sorted keys (a joint that appears twice appears twice).
 * Two bodies that build the same cable have the same normal form.
 */
export function physicalSignature(body: DesignBody): string {
  const lists = LISTS.map((l) => `${l}:${listOf(body.instances, l).map((i) => instanceSig(l, i)).sort().join('|')}`);
  const joints = body.joints.map(jointKey).sort();
  return `${lists.join('\n')}\n${joints.join('\n')}`;
}

/** Do the two bodies build the same cable (prose and order aside)? */
export function samePhysicalBody(a: DesignBody, b: DesignBody): boolean {
  return physicalSignature(a) === physicalSignature(b);
}

/* ------------------------------------------------------------------ *
 * Applying overrides
 * ------------------------------------------------------------------ */

function cloneBody(body: DesignBody): DesignBody {
  return JSON.parse(JSON.stringify(body)) as DesignBody;
}

/** Why an override could not be applied (its target is not in the derived body). */
export interface OverrideMiss {
  index: number;
  override: CableOverride;
  message: string;
}

/**
 * Apply overrides in order. An override whose target is missing (a joint key
 * the derivation no longer produces) is skipped and reported, never guessed.
 */
export function applyOverrides(body: DesignBody, overrides: readonly CableOverride[]): { body: DesignBody; misses: OverrideMiss[] } {
  const out = cloneBody(body);
  const misses: OverrideMiss[] = [];
  const miss = (index: number, override: CableOverride, message: string): void => {
    misses.push({ index, override, message });
  };
  overrides.forEach((o, index) => {
    switch (o.op) {
      case 'add-joint':
        out.joints.push({ a: { ...o.joint.a }, b: { ...o.joint.b }, ...(o.joint.through === undefined ? {} : { through: { ...o.joint.through } }) });
        break;
      case 'remove-joint': {
        const i = out.joints.findIndex((j) => jointKey(j) === o.key);
        if (i < 0) miss(index, o, `no joint ${o.key}`);
        else out.joints.splice(i, 1);
        break;
      }
      case 'move-joint': {
        const i = out.joints.findIndex((j) => jointKey(j) === o.key);
        const j = out.joints[i];
        if (j === undefined) {
          miss(index, o, `no joint ${o.key}`);
          break;
        }
        const through = j.through === undefined ? {} : { through: j.through };
        if (landingKey(j.a) === o.from) out.joints[i] = { a: { ...o.to }, b: j.b, ...through };
        else if (landingKey(j.b) === o.from) out.joints[i] = { a: j.a, b: { ...o.to }, ...through };
        else miss(index, o, `joint ${o.key} has no landing ${o.from}`);
        break;
      }
      case 'put-instance': {
        if (o.list === 'mechanical' && out.instances.mechanical === undefined) out.instances.mechanical = [];
        if (o.list === 'breakouts' && out.instances.breakouts === undefined) out.instances.breakouts = [];
        const arr = listOf(out.instances, o.list) as unknown as Record<string, unknown>[];
        const i = arr.findIndex((x) => x['id'] === o.instance.id);
        const next = JSON.parse(JSON.stringify(o.instance)) as Record<string, unknown>;
        if (i < 0) arr.push(next);
        else arr[i] = next;
        break;
      }
      case 'remove-instance': {
        const arr = listOf(out.instances, o.list) as unknown as Record<string, unknown>[];
        const i = arr.findIndex((x) => x['id'] === o.id);
        if (i < 0) miss(index, o, `no ${o.list} instance ${o.id}`);
        else arr.splice(i, 1);
        break;
      }
      case 'put-pigtail': {
        const seg = out.instances.segments.find((s) => s.id === o.segment);
        if (seg === undefined) {
          miss(index, o, `no segment ${o.segment}`);
          break;
        }
        const pts = (seg.pigtails ??= []);
        const i = pts.findIndex((p) => p.id === o.pigtail.id && p.end === o.pigtail.end);
        if (i < 0) pts.push(physicalPigtail(o.pigtail));
        else pts[i] = physicalPigtail(o.pigtail);
        break;
      }
      case 'remove-pigtail': {
        const seg = out.instances.segments.find((s) => s.id === o.segment);
        const i = seg?.pigtails?.findIndex((p) => p.id === o.id && p.end === o.end) ?? -1;
        if (seg === undefined || i < 0) miss(index, o, `no pigtail ${o.segment}:${o.id}@${o.end}`);
        else {
          seg.pigtails!.splice(i, 1);
          if (seg.pigtails!.length === 0) delete seg.pigtails;
        }
        break;
      }
      case 'note':
        break;
    }
  });
  return { body: out, misses };
}

/* ------------------------------------------------------------------ *
 * Diffing: the minimal overrides that turn one body into another
 * ------------------------------------------------------------------ */

/** An override before it is given a reason. */
export type UnreasonedOverride = CableOverride extends infer O ? (O extends CableOverride ? Omit<O, 'reason' | 'why'> : never) : never;

/**
 * The overrides that turn `from` into `to`, physically: instances removed and
 * put (a segment whose pigtails alone differ gets pigtail overrides), then
 * joints — a derived joint and a hand joint that share exactly one landing
 * become a `move-joint`, the rest `remove-joint` / `add-joint`. Returned
 * without reasons; the caller classifies them.
 */
export function diffBodies(from: DesignBody, to: DesignBody): UnreasonedOverride[] {
  const out: UnreasonedOverride[] = [];
  for (const list of LISTS) {
    const A = listOf(from.instances, list);
    const B = listOf(to.instances, list);
    const byIdA = new Map(A.map((i) => [i.id, i]));
    const byIdB = new Map(B.map((i) => [i.id, i]));
    for (const a of A) if (!byIdB.has(a.id)) out.push({ op: 'remove-instance', list, id: a.id });
    for (const b of B) {
      const a = byIdA.get(b.id);
      if (a === undefined) {
        out.push({ op: 'put-instance', list, instance: physicalInstance(list, b) });
        continue;
      }
      if (instanceSig(list, a) === instanceSig(list, b)) continue;
      if (list === 'segments') {
        const pa = physicalInstance(list, a);
        const pb = physicalInstance(list, b);
        const { pigtails: ptA, ...restA } = pa as { pigtails?: Pigtail[] };
        const { pigtails: ptB, ...restB } = pb as { pigtails?: Pigtail[] };
        if (stable(restA) !== stable(restB)) {
          out.push({ op: 'put-instance', list, instance: pb });
          continue;
        }
        const key = (p: Pigtail): string => `${p.id}@${p.end}`;
        const mA = new Map((ptA ?? []).map((p) => [key(p), p]));
        const mB = new Map((ptB ?? []).map((p) => [key(p), p]));
        for (const [k, p] of mA) if (!mB.has(k)) out.push({ op: 'remove-pigtail', segment: b.id, id: p.id, end: p.end });
        for (const [k, p] of mB) {
          const q = mA.get(k);
          if (q === undefined || pigtailSig(q) !== pigtailSig(p)) out.push({ op: 'put-pigtail', segment: b.id, pigtail: physicalPigtail(p) });
        }
        continue;
      }
      out.push({ op: 'put-instance', list, instance: physicalInstance(list, b) });
    }
  }
  // joints, as multisets of keys (a joint made through a carrier hole is its own fact)
  const physicalKey = (j: Joint): string => (j.through === undefined ? jointKey(j) : `${jointKey(j)} through ${landingKey(j.through)}`);
  const count = (js: readonly Joint[]): Map<string, { n: number; joint: Joint }> => {
    const m = new Map<string, { n: number; joint: Joint }>();
    for (const j of js) {
      const k = physicalKey(j);
      const e = m.get(k);
      if (e === undefined) m.set(k, { n: 1, joint: j });
      else e.n += 1;
    }
    return m;
  };
  const A = count(from.joints);
  const B = count(to.joints);
  const onlyA: Joint[] = [];
  const onlyB: Joint[] = [];
  for (const [k, e] of A) for (let i = B.get(k)?.n ?? 0; i < e.n; i += 1) onlyA.push(e.joint);
  for (const [k, e] of B) for (let i = A.get(k)?.n ?? 0; i < e.n; i += 1) onlyB.push(e.joint);
  const usedA = new Set<number>();
  const adds: Joint[] = [];
  for (const h of onlyB) {
    const hk = [landingKey(h.a), landingKey(h.b)];
    const i = onlyA.findIndex((d, n) => {
      if (usedA.has(n) || d.through !== undefined || h.through !== undefined) return false;
      const dk = [landingKey(d.a), landingKey(d.b)];
      const shared = dk.filter((x) => hk.includes(x));
      return shared.length === 1 && dk[0] !== dk[1] && hk[0] !== hk[1];
    });
    if (i < 0) {
      adds.push(h);
      continue;
    }
    usedA.add(i);
    const d = onlyA[i]!;
    const dk = [landingKey(d.a), landingKey(d.b)];
    const keep = dk.find((x) => hk.includes(x))!;
    const fromKey = dk.find((x) => x !== keep)!;
    const to = landingKey(h.a) === keep ? h.b : h.a;
    out.push({ op: 'move-joint', key: jointKey(d), from: fromKey, to: { ...to } });
  }
  onlyA.forEach((d, n) => {
    if (!usedA.has(n)) out.push({ op: 'remove-joint', key: jointKey(d) });
  });
  for (const h of adds) out.push({ op: 'add-joint', joint: { a: { ...h.a }, b: { ...h.b }, ...(h.through === undefined ? {} : { through: { ...h.through } }) } });
  return out;
}

/* ------------------------------------------------------------------ *
 * Materialising: carry prose and order over from the stored body
 * ------------------------------------------------------------------ */

function withKeyOrder(prev: Record<string, unknown> | undefined, phys: Record<string, unknown>, prose: readonly string[]): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...phys };
  if (prev !== undefined) {
    for (const k of prose) {
      if (prev[k] !== undefined) merged[k] = prev[k];
      else delete merged[k];
    }
  }
  if (prev === undefined) return merged;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(prev)) if (merged[k] !== undefined) out[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in out)) out[k] = merged[k];
  return out;
}

function ordered<T>(items: readonly T[], keyOf: (t: T) => string, previous: readonly string[]): T[] {
  const rank = new Map(previous.map((k, i) => [k, i]));
  return items
    .map((t, i) => ({ t, i, r: rank.get(keyOf(t)) }))
    .sort((x, y) => (x.r ?? Infinity) - (y.r ?? Infinity) || (x.r === undefined && y.r === undefined ? x.i - y.i : 0))
    .map((x) => x.t);
}

function refWithKeyOrder(prev: TerminalRef, next: TerminalRef): TerminalRef {
  return withKeyOrder(prev as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, []) as unknown as TerminalRef;
}

/**
 * The derived body, written the way the stored body writes it: lists in the
 * stored order (new entries after), each joint oriented as stored, and the
 * prose — instance `role`/`note`, pigtail and joint notes — taken from the
 * stored body. With no stored body the derived body is returned as is.
 */
export function materialiseBody(derived: DesignBody, previous?: DesignBody): DesignBody {
  if (previous === undefined) return cloneBody(derived);
  const prose: Readonly<Record<InstanceListKey, readonly string[]>> = {
    connectors: ['role', 'note'],
    segments: ['role', 'note'],
    components: ['note'],
    pcbas: ['note'],
    mechanical: ['note'],
    breakouts: ['role', 'note'],
  };
  const instances = {} as DesignInstances;
  const keys = Object.keys(previous.instances) as InstanceListKey[];
  const order = [...keys, ...LISTS.filter((l) => !keys.includes(l))];
  for (const list of order) {
    const prevList = listOf(previous.instances, list);
    const prevById = new Map(prevList.map((i) => [i.id, i as unknown as Record<string, unknown>]));
    const items = ordered(listOf(derived.instances, list), (i) => i.id, prevList.map((i) => i.id)).map((inst) => {
      const prev = prevById.get(inst.id);
      const phys = physicalInstance(list, inst);
      // derived-only prose (a default role) survives only on a new instance
      const base: Record<string, unknown> = prev === undefined ? { ...(inst as unknown as Record<string, unknown>) } : phys;
      const merged = withKeyOrder(prev, base, prose[list]);
      if (list === 'segments' && merged['pigtails'] !== undefined) {
        const prevPts = ((prev?.['pigtails'] as Pigtail[] | undefined) ?? []);
        const pk = (p: Pigtail): string => `${p.id}@${p.end}`;
        const prevByKey = new Map(prevPts.map((p) => [pk(p), p]));
        const fullDerived = ((inst as SegmentInstance).pigtails ?? []);
        merged['pigtails'] = ordered(fullDerived, pk, prevPts.map(pk)).map((p) => {
          const q = prevByKey.get(pk(p));
          const phys = physicalPigtail(p);
          if (q === undefined) return { ...p };
          // members in the stored order when they are the same set
          if (q.members !== undefined && phys.members !== undefined && [...q.members].sort().join() === [...phys.members].sort().join()) phys.members = [...q.members];
          return withKeyOrder(q as unknown as Record<string, unknown>, phys as unknown as Record<string, unknown>, ['note']) as unknown as Pigtail;
        });
      }
      return merged;
    });
    if (OPTIONAL_LISTS.has(list) && previous.instances[list as 'mechanical' | 'breakouts'] === undefined && items.length === 0) continue;
    (instances as unknown as Record<string, unknown>)[list] = items;
  }
  // joints: match stored joints by key (multiset), keep their orientation, key order and note
  const pool = new Map<string, Joint[]>();
  for (const j of previous.joints) {
    const k = jointKey(j);
    pool.set(k, [...(pool.get(k) ?? []), j]);
  }
  const matched: { joint: Joint; rank: number }[] = [];
  const fresh: Joint[] = [];
  const rankOf = new Map<Joint, number>(previous.joints.map((j, i) => [j, i]));
  for (const d of derived.joints) {
    const k = jointKey(d);
    const prev = pool.get(k)?.shift();
    if (prev === undefined) {
      fresh.push({ a: { ...d.a }, b: { ...d.b }, ...(d.through === undefined ? {} : { through: { ...d.through } }), ...(d.note === undefined ? {} : { note: d.note }) });
      continue;
    }
    const same = landingKey(prev.a) === landingKey(d.a);
    const [a, b] = same ? [d.a, d.b] : [d.b, d.a];
    // the hole a joint is made through is physical: the derivation's
    const through = d.through === undefined ? {} : { through: prev.through === undefined ? { ...d.through } : refWithKeyOrder(prev.through, d.through) };
    const joint = withKeyOrder(prev as unknown as Record<string, unknown>, { a: refWithKeyOrder(prev.a, a), b: refWithKeyOrder(prev.b, b), ...through }, ['note']) as unknown as Joint;
    matched.push({ joint, rank: rankOf.get(prev)! });
  }
  matched.sort((x, y) => x.rank - y.rank);
  return { instances, joints: [...matched.map((m) => m.joint), ...fresh] };
}

/** The body of a design (a view, not a copy). */
export function designBody(design: Pick<CableDesign, 'instances' | 'joints'>): DesignBody {
  return { instances: design.instances, joints: design.joints };
}
