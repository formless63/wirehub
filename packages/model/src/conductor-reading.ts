/**
 * What a wire stock's conductor carries, and how sure the stock is about it.
 *
 * A conductor is read by its own words first (its label, else the label of
 * the core group it sits in), then by a lane the stock names for it, then by
 * the lane its colour code reads off the insulation. The colour code is the
 * weakest of these: yellow is a supply in one code and a sync line in another.
 * So a conductor whose own words say something the vocabulary cannot read
 * ("Video Sync" on a hub with no plain "sync" entry) is `unread`, and the
 * colour code does not make it a supply or a ground. Only a conductor with no
 * words of its own takes a rail from its colour code.
 *
 * Pure: the catalog's vocabulary and the stock in, a reading out.
 */

import { hintOfSignal, signalFromLabel, type SignalHint } from './compat.ts';
import type { Db, WireDefinition } from './model.ts';
import { resolveElementPath } from './paths.ts';
import { readSignalWords, signalOfLane } from './signal-words.ts';
import { laneSourceOf } from './signals.ts';

/**
 * How a conductor's reading was reached:
 * - `words`: its own label, or its core's, names a signal of the vocabulary
 * - `lane`: the stock (or its tag table) names this conductor's lane
 * - `colour-code`: only the colour code gives a lane, and the conductor has no words of its own
 * - `construction`: a bare drain, at ground by construction
 * - `unread`: it has words of its own the vocabulary does not read
 * - `none`: no words of its own and no lane
 */
export type ConductorBasis = 'words' | 'lane' | 'colour-code' | 'construction' | 'unread' | 'none';

export interface ConductorReading {
  basis: ConductorBasis;
  /** the vocab signal id, when the words or the lane name one */
  signal?: string;
  /** the compat hint (`power`, `ground`, or a signal id); never set for `unread` or `none` */
  hint?: SignalHint;
  /** the words that were read (or could not be): the conductor's label, else its core's */
  words?: string;
  /** for `unread`: the lane the colour code would have given, which is not trusted for a rail */
  colourLane?: string;
}

/** Colour names, from the vocabulary's `colours` list. */
function colourNames(db: Db): Set<string> {
  const colours = new Set<string>();
  for (const entry of (db.vocab?.['colours']?.entries ?? []) as { id: string; label?: string; aliases?: string[] }[]) {
    for (const text of [entry.id, entry.label, ...(entry.aliases ?? [])]) {
      if (typeof text === 'string') colours.add(text.trim().toLowerCase());
    }
  }
  return colours;
}

/**
 * A wire label with its colour words taken out: parenthesised colours
 * ("Pair 1 (blue)") go, and a label made only of colours ("white/blue")
 * is nothing. `undefined` when nothing but colour is left.
 */
export function withoutColourWords(db: Db, label: string): string | undefined {
  const colours = colourNames(db);
  const isColour = (text: string): boolean => {
    const parts = text.toLowerCase().split(/[\s/,&+-]+/).filter((part) => part !== '');
    return parts.length > 0 && parts.every((part) => colours.has(part) || part === 'stripe' || part === 'striped');
  };
  const rest = label.replace(/\(([^)]*)\)/g, (whole, inner: string) => (isColour(inner) ? ' ' : whole)).replace(/\s+/g, ' ').trim();
  return rest === '' || isColour(rest) ? undefined : rest;
}

/** Words that say where a conductor is in the stock, never what it carries. */
const STRUCTURE_WORDS = new Set([
  'core', 'cores', 'conductor', 'conductors', 'cond', 'wire', 'centre', 'center', 'inner', 'outer',
  'coax', 'coaxial', 'pair', 'twisted', 'pin', 'no', 'strand', 'stranded', 'insulated', 'lead', 'stripe', 'striped',
]);

/**
 * Does this label say something about what the conductor carries, beyond its
 * colour and its place in the stock? "Core 4 (yellow)", "Red coax", "Pin 9"
 * do not; "Video Sync centre conductor" does, whether the vocabulary reads it
 * or not.
 */
export function hasOwnWords(db: Db, label: string | undefined): boolean {
  if (label === undefined) return false;
  const colours = colourNames(db);
  return label
    .toLowerCase()
    .split(/[^a-z0-9+-]+/)
    .map((part) => part.replace(/^[+-]+$/, ''))
    .some((part) => part !== '' && !/^\d+$/.test(part) && !colours.has(part) && !STRUCTURE_WORDS.has(part));
}

/**
 * Read conductor `path` of `wire`. `undefined` when the path is not a
 * conductor (a shield, an insulation, nothing).
 */
export function readConductor(db: Db, wire: WireDefinition, path: string): ConductorReading | undefined {
  const element = resolveElementPath(wire.structure, path);
  if (element === undefined || element.kind !== 'conductor') return undefined;
  if (element.bare === true) return { basis: 'construction', hint: 'ground' };
  const dot = path.lastIndexOf('.');
  const parent = dot === -1 ? undefined : resolveElementPath(wire.structure, path.slice(0, dot));
  const coreLabel = parent?.kind === 'group' && parent.role !== 'cable' && parent.role !== 'bundle' ? parent.label : undefined;

  for (const label of [element.label, coreLabel]) {
    const words = label === undefined ? undefined : withoutColourWords(db, label);
    if (words === undefined) continue;
    const signal = readSignalWords(db.vocab, words);
    const hint = signalFromLabel(words, db);
    if (hint !== undefined) return { basis: 'words', hint, words: label, ...(signal === undefined ? {} : { signal }) };
  }

  const lane = laneSourceOf(db, wire, path);
  const ownWords = [element.label, coreLabel].find((label) => hasOwnWords(db, label));
  if (ownWords !== undefined && lane?.from !== 'own') {
    // words the vocabulary cannot read: the colour code is not trusted to make it a supply or a ground
    return { basis: 'unread', words: ownWords, ...(lane === undefined ? {} : { colourLane: lane.lane }) };
  }
  if (lane === undefined) return { basis: 'none' };
  const signal = signalOfLane(db.vocab, lane.lane);
  const hint = laneHint(db, lane.lane, signal);
  return {
    basis: lane.from === 'own' ? 'lane' : 'colour-code',
    ...(signal === undefined ? {} : { signal }),
    ...(hint === undefined ? {} : { hint }),
  };
}

function laneHint(db: Db, lane: string, signal: string | undefined): SignalHint | undefined {
  if (signal !== undefined) return hintOfSignal(db, signal);
  if (lane === 'ground' || lane === 'power') return lane;
  return undefined;
}

/** Does the reading positively say supply or ground (`rail`), not just that a colour code guessed it? */
export function readsAsRail(reading: ConductorReading | undefined, rail: 'power' | 'ground'): boolean {
  return reading !== undefined && reading.basis !== 'unread' && reading.basis !== 'none' && reading.hint === rail;
}
