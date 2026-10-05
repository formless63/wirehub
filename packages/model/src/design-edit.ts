/**
 * Pure `CableDesign → CableDesign` edits — the primitives every writer of a
 * design document needs (the editor, an importer, a future ERP writer):
 * adding and removing instances and joints, patching an instance's editable
 * fields, the shop's own instance-naming scheme, and the "is this even a
 * design document" shape check on an untrusted upload.
 *
 * None of this touches presentation (no coordinates, no React Flow) and none
 * of it is editor-specific, so it lives here rather than in
 * `@wirehub/editor-react`'s store (moved by) — every
 * consumer needs the same semantics, notably that removing an instance
 * removes the joints that land on it.
 */

import { isReadableSchemaVersion, upgradeDesignSchema } from './migrate-schema.ts';
import { designInstances, terminalKey } from './validate.ts';
import type {
  CableDesign,
  ComponentInstance,
  ConnectorInstance,
  InstanceKind,
  Joint,
  PcbaInstance,
  SegmentInstance,
  TerminalRef,
} from './model.ts';

const ID_PREFIX: Record<InstanceKind, string> = {
  connector: 'j',
  segment: 'w',
  component: 'x',
  pcba: 'u',
};

/** `j1`, `w2`, `u3`, `r1`/`c1` for components — the shop's own naming. */
export function nextInstanceId(design: CableDesign, kind: InstanceKind, def: string): string {
  const prefix =
    kind === 'component'
      ? def.startsWith('r-')
        ? 'r'
        : def.startsWith('cap')
          ? 'c'
          : ID_PREFIX.component
      : ID_PREFIX[kind];
  const taken = new Set(designInstances(design).map((instance) => instance.id));
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addInstance(
  design: CableDesign,
  kind: InstanceKind,
  def: string,
  id: string,
): CableDesign {
  const instances = { ...design.instances };
  switch (kind) {
    case 'connector':
      instances.connectors = [...instances.connectors, { id, def } satisfies ConnectorInstance];
      break;
    case 'segment':
      instances.segments = [...instances.segments, { id, def } satisfies SegmentInstance];
      break;
    case 'component':
      instances.components = [...instances.components, { id, def } satisfies ComponentInstance];
      break;
    case 'pcba':
      instances.pcbas = [...instances.pcbas, { id, def } satisfies PcbaInstance];
      break;
  }
  return { ...design, instances };
}

/** Removing an instance removes the joints that land on it — a joint to a part
 * that is not there is not a fact, it is a dangling reference. The same goes
 * for what hangs off it: mechanical parts attached to it (a shell, and the
 * screws attached to that shell) and a breakout whose trunk, legs or housed
 * parts include it. Every other instance list is kept as it is. */
export function removeInstance(design: CableDesign, id: string): CableDesign {
  const gone = new Set([id]);
  const mechanical = design.instances.mechanical;
  if (mechanical !== undefined) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of mechanical) {
        if (m.attachedTo !== undefined && gone.has(m.attachedTo) && !gone.has(m.id)) {
          gone.add(m.id);
          grew = true;
        }
      }
    }
  }
  const breakouts = design.instances.breakouts?.filter(
    (b) =>
      b.id !== id &&
      b.trunk.segment !== id &&
      !b.legs.some((leg) => leg.segment === id) &&
      !(b.housed ?? []).includes(id),
  );
  return dropUnlandedPigtails({
    ...design,
    instances: {
      ...design.instances,
      connectors: design.instances.connectors.filter((i) => i.id !== id),
      segments: design.instances.segments.filter((i) => i.id !== id),
      components: design.instances.components.filter((i) => i.id !== id),
      pcbas: design.instances.pcbas.filter((i) => i.id !== id),
      ...(mechanical !== undefined ? { mechanical: mechanical.filter((m) => !gone.has(m.id)) } : {}),
      ...(breakouts !== undefined ? { breakouts } : {}),
    },
    joints: design.joints.filter(
      (joint) => joint.a.instance !== id && joint.b.instance !== id,
    ),
  });
}

/**
 * The design without the pigtails that no joint lands any more: unsoldering a
 * pigtail's landing undoes the twist too (shield bonding) — a twist that goes
 * nowhere is not something the bench builds, and the validator refuses it.
 */
export function dropUnlandedPigtails(design: CableDesign): CableDesign {
  const landed = new Set(design.joints.flatMap((joint) => [terminalKey(joint.a), terminalKey(joint.b)]));
  let changed = false;
  const segments = design.instances.segments.map((segment) => {
    if (segment.pigtails === undefined) return segment;
    const kept = segment.pigtails.filter((pigtail) =>
      landed.has(terminalKey({ instance: segment.id, terminal: `pigtail:${pigtail.id}`, end: pigtail.end })),
    );
    if (kept.length === segment.pigtails.length) return segment;
    changed = true;
    const { pigtails: _gone, ...rest } = segment;
    return kept.length === 0 ? rest : { ...rest, pigtails: kept };
  });
  return changed ? { ...design, instances: { ...design.instances, segments } } : design;
}

export function addJoint(design: CableDesign, a: TerminalRef, b: TerminalRef): CableDesign {
  return { ...design, joints: [...design.joints, { a, b } satisfies Joint] };
}

export function removeJoint(design: CableDesign, index: number): CableDesign {
  return dropUnlandedPigtails({ ...design, joints: design.joints.filter((_, at) => at !== index) });
}

export function removeJoints(design: CableDesign, indices: readonly number[]): CableDesign {
  const gone = new Set(indices);
  return dropUnlandedPigtails({ ...design, joints: design.joints.filter((_, at) => !gone.has(at)) });
}

/** One end of one joint, re-landed on another terminal (see `moveJointEnds`). */
export interface JointEndMove {
  /** index into `design.joints` */
  index: number;
  side: 'a' | 'b';
  to: TerminalRef;
}

/**
 * Re-land joint ends: the same joint — same place in the joint list, same
 * other end — now soldered to `to` on the moved side. This is what dragging a
 * wire's end from one pin to another means: a move, not
 * an unsolder and a fresh joint at the bottom of the list.
 *
 * The joint's note does not move with it: a note says why *that* landing is what it is, and after a
 * re-pin it would describe a pin the wire no longer goes to. The old note
 * belongs in the change history (`describeJointMove`, the version diff), never
 * on the builder.
 *
 * A pigtail whose landing moved elsewhere stays landed; one that was the moved
 * end's *old* terminal and no longer lands anywhere goes, as for a removal.
 * Out-of-range indices are ignored; validity (the pin exists, the joint is not
 * a duplicate) is the validator's to judge on the result.
 */
export function moveJointEnds(design: CableDesign, moves: readonly JointEndMove[]): CableDesign {
  if (moves.length === 0) return design;
  const joints = design.joints.map((joint, index) => {
    let next: Joint = joint;
    for (const move of moves) {
      if (move.index !== index) continue;
      next = move.side === 'a' ? { ...next, a: move.to } : { ...next, b: move.to };
    }
    if (next !== joint && next.note !== undefined) {
      const { note: _cleared, ...rest } = next;
      next = rest;
    }
    return next;
  });
  return dropUnlandedPigtails({ ...design, joints });
}

/**
 * One re-pin as a change-log line — what the editor's history, the recipe's
 * hand-edit override and the backup commit say about it:
 *
 *   moved w1:core-purple.center@b from j1:15 to j1:4 (note was: "…")
 *
 * The wire end named is the joint's *other* end — the thing that moved —
 * and the note is the one `moveJointEnds` clears. `undefined` for an index
 * that is not a joint.
 */
export function describeJointMove(design: CableDesign, move: JointEndMove): string | undefined {
  const joint = design.joints[move.index];
  if (joint === undefined) return undefined;
  const from = joint[move.side];
  const other = joint[move.side === 'a' ? 'b' : 'a'];
  return jointMoveText(terminalKey(other), landingText(from), landingText(move.to), joint.note);
}

function landingText(ref: TerminalRef): string {
  return `${terminalKey(ref)}${ref.pad === undefined ? '' : ` [${ref.pad}]`}`;
}

/** The shared wording of a moved joint end (`describeJointMove`, `diffVersions`). */
export function jointMoveText(what: string, from: string, to: string, note: string | undefined): string {
  const was = note === undefined || note.trim() === '' ? '' : ` (note was: "${note.replace(/\s+/g, ' ').trim()}")`;
  return `moved ${what} from ${from} to ${to}${was}`;
}

export type InstancePatch = {
  role?: string | undefined;
  note?: string | undefined;
  lengthMm?: number | undefined;
  location?: string | undefined;
};

function applyPatch<T extends object>(
  instance: T,
  patch: InstancePatch,
  fields: (keyof InstancePatch)[],
): T {
  const next: Record<string, unknown> = { ...(instance as Record<string, unknown>) };
  for (const field of fields) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === undefined || value === '') delete next[field];
    else next[field] = value;
  }
  return next as T;
}

export function updateInstance(
  design: CableDesign,
  id: string,
  patch: InstancePatch,
): CableDesign {
  return {
    ...design,
    instances: {
      ...design.instances,
      connectors: design.instances.connectors.map((i) =>
        i.id === id ? applyPatch(i, patch, ['role', 'note']) : i,
      ),
      segments: design.instances.segments.map((i) =>
        i.id === id ? applyPatch(i, patch, ['role', 'lengthMm']) : i,
      ),
      components: design.instances.components.map((i) =>
        i.id === id ? applyPatch(i, patch, ['note', 'location']) : i,
      ),
      pcbas: design.instances.pcbas.map((i) =>
        i.id === id ? applyPatch(i, patch, ['note']) : i,
      ),
    },
  };
}

export type ParseResult =
  | { ok: true; design: CableDesign }
  | { ok: false; message: string };

/** Parse an uploaded/pasted document far enough to hand it to the validator. */
export function parseDesignJson(json: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, message: `not JSON — ${(error as Error).message}` };
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, message: 'not a design document — expected an object' };
  }
  const candidate = value as Partial<CableDesign>;
  if (!isReadableSchemaVersion(candidate.schemaVersion)) {
    return { ok: false, message: `unsupported schemaVersion ${String(candidate.schemaVersion)}` };
  }
  for (const field of ['id', 'label', 'src'] as const) {
    if (typeof candidate[field] !== 'string') {
      return { ok: false, message: `design is missing '${field}'` };
    }
  }
  const instances = candidate.instances;
  if (
    instances === undefined ||
    !Array.isArray(instances.connectors) ||
    !Array.isArray(instances.segments) ||
    !Array.isArray(instances.components) ||
    !Array.isArray(instances.pcbas)
  ) {
    return { ok: false, message: "design is missing 'instances' (connectors/segments/components/pcbas)" };
  }
  if (!Array.isArray(candidate.joints)) {
    return { ok: false, message: "design is missing 'joints'" };
  }
  // an older document is read at the current version (migrate-schema.ts)
  return { ok: true, design: upgradeDesignSchema(value as CableDesign).design };
}
