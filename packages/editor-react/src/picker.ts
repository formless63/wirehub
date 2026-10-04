/**
 * The node picker's compatibility and ranking (
 *): which definitions can join a given handle, and in
 * what order to offer them.
 *
 * **What may join is core's call.** `@cable-studio/model`'s `compat.ts` owns
 * the rules — terminal classes, shields only on ground, no pin-to-pin between
 * connectors that do not mate, no pad-to-pad between boards, no wire joined to
 * itself — and this module never second-guesses them: a terminal is
 * compatible exactly when `jointCompatibility` says so. A definition **fits**
 * the anchor when at least one of its terminals is compatible.
 *
 * **What is likely is ours.** Among the compatible terminals, `rankTerminals`
 * orders by, in turn:
 *
 * 1. class affinity — what usually lands on a terminal of the anchor's class
 *    in the real designs (wire ends on a board's cable pads; connector pins on
 *    its connector-side pads; wire ends or a board's connector-side pads on a
 *    free connector pin);
 * 2. signal — the anchor's label-derived signal against the candidate's
 *    (a red core onto `R`; `+5 V` onto blanking counts, that is how the
 *    blanking line is fed);
 * 3. wire end — for a wire stock, the end on the anchor's side of the cable
 *    (`a` beside a console-side part, `b` beside a destination part).
 *
 * The auto-wire-on-insert rule (`autoWireTerminal`) takes the top terminal
 * only when it is the **single** best — any tie and the part is placed and
 * selected for the user to wire by hand.
 */

import {
  electricalPaths,
  findComponent,
  findConnector,
  findPcba,
  findWire,
  jointCompatibility,
  profileDesignTerminal,
  profileTerminal,
  type CableDesign,
  type Db,
  type InstanceKind,
  type InstanceTerminal,
  type SignalHint,
  type TerminalClass,
  type TerminalRef,
} from '@cable-studio/model';

/** One terminal a fresh instance of a definition could be joined at. */
export interface CandidateTerminal {
  terminal: string;
  end?: 'a' | 'b';
}

/** A compatible candidate terminal and how likely it is (higher = likelier). */
export interface RankedTerminal extends CandidateTerminal {
  score: number;
}

/**
 * Every terminal a definition of `kind` exposes for joining — the same
 * terminals `derive.ts` turns into rows/handles for an instance of it. A wire
 * element is offered at both ends, since a joint always names one.
 */
export function defTerminals(kind: InstanceKind, def: string, db: Db): CandidateTerminal[] {
  switch (kind) {
    case 'connector': {
      const found = findConnector(db, def);
      return (found?.pins ?? []).map((pin) => ({ terminal: pin.id }));
    }
    case 'segment': {
      const found = findWire(db, def);
      if (found === undefined) return [];
      return electricalPaths(found.structure).flatMap((path) => [
        { terminal: path, end: 'a' as const },
        { terminal: path, end: 'b' as const },
      ]);
    }
    case 'component': {
      const found = findComponent(db, def);
      return (found?.terminals ?? []).map((terminal) => ({ terminal: terminal.id }));
    }
    case 'pcba': {
      const found = findPcba(db, def);
      if (found === undefined) return [];
      const pads = found.terminals.map((terminal) => ({ terminal: terminal.id }));
      const integrated = (found.integratedConnectors ?? []).flatMap((carried) => {
        const connector = findConnector(db, carried.connectorDefId);
        return (connector?.pins ?? []).map((pin) => ({ terminal: `${carried.terminalPrefix}.${pin.id}` }));
      });
      return [...pads, ...integrated];
    }
  }
}

/* ------------------------------------------------------------------ *
 * Ranking heuristics
 * ------------------------------------------------------------------ */

type Affinity = Partial<Record<TerminalClass, number>>;

/**
 * How usual each candidate class is at an anchor of a given class, read off
 * the catalog designs' joints (e.g. 646 conductor→cable-pad and 710
 * shield→cable-pad joints, against 13 pin→cable-pad). Missing = 0.
 */
const AFFINITY: Readonly<Record<TerminalClass, Affinity>> = {
  'board-cable-pad': { conductor: 3, shield: 3, drain: 3, 'connector-pin': 2, 'component-lead': 1 },
  'board-connector-pad': { 'connector-pin': 3, conductor: 2, shield: 2, drain: 2, 'component-lead': 1 },
  'connector-pin': {
    conductor: 3,
    shield: 3,
    drain: 3,
    'board-connector-pad': 3,
    'board-cable-pad': 2,
    'component-lead': 1,
    'connector-pin': 1,
  },
  conductor: {
    'board-cable-pad': 3,
    'connector-pin': 3,
    'board-connector-pad': 2,
    'component-lead': 2,
    conductor: 1,
  },
  shield: { 'board-cable-pad': 3, 'connector-pin': 3, 'board-connector-pad': 2, shield: 1, drain: 1, 'component-lead': 1 },
  drain: { 'board-cable-pad': 3, 'connector-pin': 3, 'board-connector-pad': 2, shield: 1, drain: 1, 'component-lead': 1 },
  'component-lead': {
    conductor: 2,
    'connector-pin': 2,
    'board-cable-pad': 2,
    'board-connector-pad': 1,
    'component-lead': 1,
  },
};

/** Signal families that go together on a real bench. */
const RELATED: ReadonlyArray<readonly [SignalHint, SignalHint]> = [
  // blanking / function switching is fed from the +5 V core
  ['power', 'switching'],
  // a mono audio pin takes either channel
  ['audio-mono', 'audio-l'],
  ['audio-mono', 'audio-r'],
];

/** 2 = same signal, 1 = unknown on either side, 0 = two different signals. */
function signalScore(x: SignalHint | undefined, y: SignalHint | undefined): number {
  if (x === undefined || y === undefined) return 1;
  if (x === y) return 2;
  return RELATED.some(([p, q]) => (p === x && q === y) || (p === y && q === x)) ? 2 : 0;
}

/**
 * Which end of a new wire belongs beside the anchor: the end the anchor's
 * instance already takes wires on (majority of its existing wire joints),
 * else what its role/note says (`source`/`console` = `a`, `destination` =
 * `b`), else `undefined` (both ends rank the same). An anchor that is itself a
 * wire end names no side — a splice can go either way.
 */
export function anchorSide(design: CableDesign, anchor: TerminalRef): 'a' | 'b' | undefined {
  if (anchor.end !== undefined) return undefined;
  let a = 0;
  let b = 0;
  for (const joint of design.joints) {
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mine.instance !== anchor.instance) continue;
      if (other.end === 'a') a += 1;
      else if (other.end === 'b') b += 1;
    }
  }
  if (a !== b) return a > b ? 'a' : 'b';
  const { connectors, pcbas, components } = design.instances;
  const described = [
    ...connectors.map((c) => ({ id: c.id, text: `${c.role ?? ''} ${c.note ?? ''}` })),
    ...pcbas.map((p) => ({ id: p.id, text: p.note ?? '' })),
    ...components.map((c) => ({ id: c.id, text: `${c.location ?? ''} ${c.note ?? ''}` })),
  ].find((candidate) => candidate.id === anchor.instance);
  const text = (described?.text ?? '').toLowerCase();
  if (/\bdestination\b/.test(text)) return 'b';
  if (/\bsource\b|\bconsole\b/.test(text)) return 'a';
  return undefined;
}

/**
 * The anchor as core profiles it, or `undefined` when it does not resolve —
 * in which case nothing fits it.
 */
function profileAnchor(design: CableDesign, db: Db, anchor: TerminalRef): InstanceTerminal | undefined {
  return profileDesignTerminal(design, db, anchor);
}

/**
 * Every terminal of a fresh `kind`/`def` instance that core allows onto
 * `anchor`, best first (ties keep definition order). Empty when the
 * definition has no terminals, the anchor does not resolve, or nothing may
 * legally land on it.
 */
export function rankTerminals(
  design: CableDesign,
  db: Db,
  anchor: TerminalRef,
  kind: InstanceKind,
  def: string,
): RankedTerminal[] {
  const at = profileAnchor(design, db, anchor);
  if (at === undefined) return [];
  return rankAgainst(design, db, anchor, at, kind, def);
}

function rankAgainst(
  design: CableDesign,
  db: Db,
  anchor: TerminalRef,
  at: InstanceTerminal,
  kind: InstanceKind,
  def: string,
): RankedTerminal[] {
  // a fresh instance never shares an id with anything on the canvas
  const freshId = `\u0000new:${kind}:${def}`;
  const side = kind === 'segment' ? anchorSide(design, anchor) : undefined;
  const affinity = AFFINITY[at.profile.class];
  const out: RankedTerminal[] = [];
  for (const candidate of defTerminals(kind, def, db)) {
    const profile = profileTerminal(db, kind, def, candidate.terminal);
    if (profile === undefined) continue;
    if (!jointCompatibility(at, { instance: freshId, kind, profile }).ok) continue;
    const score =
      (affinity[profile.class] ?? 0) * 100 +
      signalScore(at.profile.signal, profile.signal) * 10 +
      (side !== undefined && candidate.end === side ? 1 : 0);
    out.push({ ...candidate, score });
  }
  // stable: equal scores keep the definition's own order
  return out.sort((x, y) => y.score - x.score);
}

/** `rankTerminals` without the scores — every compatible terminal, best first. */
export function compatibleTerminals(
  design: CableDesign,
  db: Db,
  anchor: TerminalRef,
  kind: InstanceKind,
  def: string,
): CandidateTerminal[] {
  return rankTerminals(design, db, anchor, kind, def).map(({ score: _score, ...rest }) => rest);
}

/** Does at least one terminal of a fresh `kind`/`def` instance join `anchor`? */
export function fitsAnchor(
  design: CableDesign,
  db: Db,
  anchor: TerminalRef,
  kind: InstanceKind,
  def: string,
): boolean {
  return rankTerminals(design, db, anchor, kind, def).length > 0;
}

/**
 * The terminal to wire on insert: the top-ranked one, but only when it is the
 * single best — any tie at the top and the answer is `undefined` (place and
 * select, the user picks).
 */
export function autoWireTerminal(ranked: readonly RankedTerminal[]): CandidateTerminal | undefined {
  const [top, next] = ranked;
  if (top === undefined) return undefined;
  if (next !== undefined && next.score === top.score) return undefined;
  const { score: _score, ...rest } = top;
  return rest;
}

/** A definition the picker lists, as the palette names it. */
export interface PickerDefinition {
  kind: InstanceKind;
  def: string;
}

/**
 * Split `entries` into those that fit `anchor` — ordered by their best
 * terminal's score, ties in the given order — and the rest, in the given
 * order.
 */
export function rankDefinitions<T extends PickerDefinition>(
  design: CableDesign,
  db: Db,
  anchor: TerminalRef,
  entries: readonly T[],
): { fits: T[]; other: T[] } {
  const at = profileAnchor(design, db, anchor);
  if (at === undefined) {
    return { fits: [], other: [...entries] };
  }
  const scored: { entry: T; score: number }[] = [];
  const other: T[] = [];
  for (const entry of entries) {
    const best = rankAgainst(design, db, anchor, at, entry.kind, entry.def)[0];
    if (best === undefined) other.push(entry);
    else scored.push({ entry, score: best.score });
  }
  scored.sort((x, y) => y.score - x.score);
  return { fits: scored.map((item) => item.entry), other };
}
