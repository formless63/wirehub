/**
 * Presentation fold for bonded screens (; foil never
 * drawn and copper representatives).
 *
 * `WireDefinition.bonded` (`specs/shield-bonding.md`) is a physical fact: the
 * members of a set are one copper mass for the whole length of the stock. The
 * data model already knows this — `deriveNets`/`trace` tie the mass together,
 * and a pigtail with no `members` already means "the whole mass". What this
 * module adds is purely how a bonded mass **draws**: there is no separate
 * track/ring-key/port for every member of a mass — the drain stands for the
 * bonded mass — so every consumer that draws one
 * line/port per electrical element (the schematic band, `tracks.ts`; the wire
 * end face's ports, `end-face.ts`) picks one **representative** member per set
 * and folds the rest into it. The cutaway's own rings stay untouched (they are
 * real geometry, not a diagram abstraction) — only its legend text folds,
 * in `cross-section.ts`.
 *
 * Nothing here changes what a joint may legally land on, or what the picker
 * offers: `compat.ts`/`terminalsOf` still see every element. This is drawing
 * only.
 */

import { isFullyBonded, resolveElementPath } from '@wirehub/model';
import type { WireBondedSet, WireDefinition } from '@wirehub/model';

/** Is the element at `path` a foil or tape shield (aluminium, not copper)? */
export function isFoilElement(wire: WireDefinition, path: string): boolean {
  const element = resolveElementPath(wire.structure, path);
  return element?.kind === 'shield' && (element.construction === 'foil' || element.construction === 'tape');
}

function isDrain(wire: WireDefinition, path: string): boolean {
  const element = resolveElementPath(wire.structure, path);
  return element?.kind === 'conductor' && element.bare === true;
}

/**
 * The one member of `set` that presentation keeps. Never the foil
 * (the foil gets no indication on drawings: it is trimmed back when the
 * wire is stripped, and the copper is what matters): a bare drain if the set
 * has one (mini-coax `overall-shield` + `drain` → `drain`; bonded multi-core → its
 * drain), else the first copper member (`bonded-8core`, which has no
 * drain → its first core's spiral, which then stands for — and is labelled
 * as — all of the stock's shielding, `bondedMassLabel`).
 */
export function bondedRepresentative(wire: WireDefinition, set: WireBondedSet): string {
  const drain = set.members.find((path) => isDrain(wire, path));
  if (drain !== undefined) return drain;
  const copper = set.members.find((path) => !isFoilElement(wire, path));
  return copper ?? set.members[0]!;
}

/**
 * Every electrical element of `wire` presentation drops: each bonded member
 * that is not its set's representative, and any foil at all. Empty for a
 * stock with neither.
 */
export function bondFoldedPaths(wire: WireDefinition): ReadonlySet<string> {
  const drop = new Set<string>();
  const reps = new Set<string>();
  for (const set of wire.bonded ?? []) {
    const rep = bondedRepresentative(wire, set);
    reps.add(rep);
    for (const member of set.members) if (member !== rep) drop.add(member);
  }
  for (const child of wire.structure.children) {
    if (child.kind === 'shield' && !reps.has(child.id) && isFoilElement(wire, child.id)) drop.add(child.id);
  }
  return drop;
}

/**
 * How the representative of a **fully bonded** stock's mass is labelled:
 * all of its shielding as one — "shields · 7 copper spirals + drain, bonded" —
 * never "foil" (all the shielding of a bonded multi-core is treated alike and
 * indicated together). `undefined` for a set
 * that is not the whole stock's screening (mini-coax: the drain keeps its own
 * label).
 */
export function bondedMassLabel(wire: WireDefinition, set: WireBondedSet): string | undefined {
  if (!isFullyBonded(wire)) return undefined;
  const copper = set.members.filter((path) => !isFoilElement(wire, path) && !isDrain(wire, path));
  const drain = set.members.some((path) => isDrain(wire, path));
  return `shields · ${copper.length} copper ${copper.length === 1 ? 'screen' : 'screens'}${drain ? ' + drain' : ''}, bonded`;
}

/** The mass label for `path` when it is the representative of a fully bonded set. */
export function representativeLabel(wire: WireDefinition, path: string): string | undefined {
  for (const set of wire.bonded ?? []) {
    if (bondedRepresentative(wire, set) === path) return bondedMassLabel(wire, set);
  }
  return undefined;
}
