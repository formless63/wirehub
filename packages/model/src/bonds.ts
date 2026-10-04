/**
 * Shield bonding — bonded stocks and ground pigtails (* `specs/shield-bonding.md`).
 *
 * Two physical facts live in the model:
 *
 * - a **bonded set** on a wire stock (`WireDefinition.bonded`): screens that
 *   touch for the whole length, so they are one copper mass (every bonded multi-core
 *   spiral shield, its foil and its drain; a mini-coax drain on its foil);
 * - a **pigtail** on a segment instance (`SegmentInstance.pigtails`): screens
 *   twisted together at one end and landed once. It is a terminal of the
 *   segment, `pigtail:<id>` at its end, and its landing is an ordinary joint.
 *
 * A *screen* is a shield or a bare conductor (a drain). Everything here is a
 * pure read of the design and its definitions.
 */

import {
  findWire,
  pigtailIdOf,
  pigtailTerminal,
  type CableDesign,
  type Db,
  type Pigtail,
  type SegmentInstance,
  type WireBondedSet,
  type WireDefinition,
} from './model.ts';
import { elementPaths, resolveElementPath } from './paths.ts';
import { terminalKey } from './validate.ts';
import { breakoutFates, inScope } from './breakouts.ts';

/** Is the element at `path` a screen — a shield, or a bare conductor (drain)? */
export function isScreenPath(wire: WireDefinition, path: string): boolean {
  const element = resolveElementPath(wire.structure, path);
  if (element === undefined) return false;
  return element.kind === 'shield' || (element.kind === 'conductor' && element.bare === true);
}

/** Every screen of a stock, in tree order. */
export function screenPaths(wire: WireDefinition): string[] {
  return elementPaths(wire.structure)
    .filter((entry) => isScreenPath(wire, entry.path))
    .map((entry) => entry.path);
}

/** The bonded set a screen belongs to, if any. */
export function bondedSetOf(wire: WireDefinition, path: string): WireBondedSet | undefined {
  return (wire.bonded ?? []).find((set) => set.members.includes(path));
}

/**
 * True when every screen of the stock is in one bonded set — the stock is one
 * shield mass, so a pigtail on it needs no member list (bonded multi-core).
 */
export function isFullyBonded(wire: WireDefinition): boolean {
  const screens = screenPaths(wire);
  if (screens.length === 0) return false;
  return (wire.bonded ?? []).some((set) => screens.every((path) => set.members.includes(path)));
}

/**
 * The screens a pigtail carries: its `members`, or — for a mass pigtail on a
 * fully bonded stock — every screen of the stock. An empty list when the
 * pigtail is a mass pigtail on a stock that has no mass.
 */
export function pigtailMembers(wire: WireDefinition, pigtail: Pigtail): string[] {
  if (pigtail.members !== undefined) return [...pigtail.members];
  return isFullyBonded(wire) ? screenPaths(wire) : [];
}

/** The pigtails of one segment at one end, in declaration order. */
export function pigtailsAt(segment: SegmentInstance, end: 'a' | 'b'): Pigtail[] {
  return (segment.pigtails ?? []).filter((p) => p.end === end);
}

/** A segment's pigtail by id and end. */
export function findPigtail(
  segment: SegmentInstance,
  id: string,
  end: 'a' | 'b',
): Pigtail | undefined {
  return (segment.pigtails ?? []).find((p) => p.id === id && p.end === end);
}

/** A segment's pigtail named by a terminal ref (`pigtail:rgb` at an end). */
export function pigtailOfTerminal(
  design: CableDesign,
  instance: string,
  terminal: string,
  end: 'a' | 'b' | undefined,
): Pigtail | undefined {
  const id = pigtailIdOf(terminal);
  if (id === undefined || end === undefined) return undefined;
  const segment = design.instances.segments.find((s) => s.id === instance);
  return segment === undefined ? undefined : findPigtail(segment, id, end);
}

/** The terminal key of a pigtail: `w1:pigtail:rgb@b`. */
export function pigtailKey(segment: string, pigtail: Pigtail): string {
  return terminalKey({ instance: segment, terminal: pigtailTerminal(pigtail.id), end: pigtail.end });
}

/** How a screen end is terminated, when it is. */
export type ScreenTermination = 'joint' | 'pigtail' | 'bonded' | 'through';

/**
 * Every screen end of the design that is terminated, keyed by terminal key
 * (`w1:core-red.shield@a`):
 *
 * - `joint`   — a joint lands on it directly;
 * - `pigtail` — it is a member of a pigtail that has a landing;
 * - `bonded`  — another member of its bonded set is terminated at that end,
 *   so the mass is (the cut bonded multi-core drain, the mini-coax drain on the foil);
 * - `through` — it passes uncut through a breakout mould and continues on a
 *   leg: terminated wherever that leg is.
 */
export function screenTerminations(design: CableDesign, db: Db): Map<string, ScreenTermination> {
  const jointed = new Set<string>();
  for (const joint of design.joints) {
    jointed.add(terminalKey(joint.a));
    jointed.add(terminalKey(joint.b));
  }
  const out = new Map<string, ScreenTermination>();
  const fates = breakoutFates(design, db);
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const screens = screenPaths(wire).filter((path) => inScope(segment, path));
    for (const end of ['a', 'b'] as const) {
      const key = (path: string): string => terminalKey({ instance: segment.id, terminal: path, end });
      for (const path of screens) if (jointed.has(key(path))) out.set(key(path), 'joint');
      for (const path of screens) if (!out.has(key(path)) && fates.get(key(path))?.fate === 'through') out.set(key(path), 'through');
      for (const pigtail of pigtailsAt(segment, end)) {
        if (!jointed.has(pigtailKey(segment.id, pigtail))) continue;
        for (const path of pigtailMembers(wire, pigtail)) {
          if (!out.has(key(path))) out.set(key(path), 'pigtail');
        }
      }
      for (const set of wire.bonded ?? []) {
        if (!set.members.some((path) => out.has(key(path)))) continue;
        for (const path of set.members) if (!out.has(key(path))) out.set(key(path), 'bonded');
      }
    }
  }
  return out;
}

/** Is this element a foil or tape shield (aluminium, not copper)? */
export function isFoilPath(wire: WireDefinition, path: string): boolean {
  const element = resolveElementPath(wire.structure, path);
  return element?.kind === 'shield' && (element.construction === 'foil' || element.construction === 'tape');
}

/**
 * A foil the bench trims back and never lands (owner, 2026-09-25,
 *: "the foil doesn't typically get any indication on our
 * drawings as, since it's electrically identical to the drain wire on coax
 * […] we trim it back when we are stripping the wire"). True for a foil or
 * tape shield bonded to a bare drain on a stock that is **not** one shield
 * mass (mini-coax): the drain is what gets soldered, and only where it is
 * kept (the source end). On a fully bonded stock (bonded multi-core) the foil is
 * part of the mass a mass pigtail lands, which needs no member list at all.
 */
export function isTrimmedFoil(wire: WireDefinition, path: string): boolean {
  if (!isFoilPath(wire, path) || isFullyBonded(wire)) return false;
  const set = bondedSetOf(wire, path);
  return (
    set !== undefined &&
    set.members.some((member) => {
      const element = resolveElementPath(wire.structure, member);
      return element?.kind === 'conductor' && element.bare === true;
    })
  );
}
