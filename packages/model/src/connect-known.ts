/**
 * "Connect known pins": propose the joints a partly wired design lacks, from
 * what the catalog already says its terminals carry — and nothing else.
 *
 * Three kinds of proposal, all read through the vocabulary (`signals.ts`,
 * `compat.ts`), never a hard-coded signal name:
 *
 * - **signal** — a trunk conductor end and one connector pin or board cable pad on that
 *   end of the cable that carry the same signal (the exact signal id when both name one,
 *   else the same hint: a rail with a rail, a return with a return);
 * - **ground** — the same rule for a return conductor onto the return pin, with the pin's
 *   own ground signal preferred over any other ground (a shell is not the return);
 * - **footprint** — a connector mounted on a board: its pin `n` and the footprint pad `<prefix>.n`
 *   of the board, only when the tags of at least one pair agree and none disagree.
 *
 * Never a guess. A landing is proposed only when it is the *only* candidate for its
 * conductor and that conductor is the *only* one that could take it; every other case is
 * returned as `ambiguous` with its candidates, for a person to decide. Screens (shields,
 * drains, pigtails) are not proposed: they are landed by the shield-bonding rules.
 * Pure: design and library in, a plan out; applying it is the caller's one change.
 */

import { assemblySides } from './assembly.ts';
import { profileTerminal, type SignalHint } from './compat.ts';
import type { CableDesign, Db, InstanceKind, Joint, TerminalRef } from './model.ts';
import { laneOfPadRole, signalOf } from './signals.ts';
import { signalOfLane } from './signal-words.ts';
import { unwiredTerminals } from './assembly.ts';
import { terminalKey, type ResolvedTerminal } from './validate.ts';

export type ProposalKind = 'signal' | 'ground' | 'footprint';

export interface JointProposal {
  kind: ProposalKind;
  joint: Joint;
  /** one sentence a person can check */
  why: string;
}

export interface AmbiguousLanding {
  /** the terminal that could not be placed (a trunk conductor end, or a connector pin on a footprint) */
  terminal: TerminalRef;
  /** every terminal it could go to */
  candidates: TerminalRef[];
  why: string;
}

export interface ConnectPlan {
  proposals: JointProposal[];
  ambiguous: AmbiguousLanding[];
}

interface Tagged {
  t: ResolvedTerminal;
  hint: SignalHint;
  /** the vocab signal id, when the tags name one exactly */
  exact?: string;
}

/** The exact signal id a terminal's tags name: its own signal, else the lane its pad role or conductor lane carries. */
function exactSignalOf(db: Db, kind: InstanceKind, def: string, terminal: string): string | undefined {
  const tags = signalOf(db, kind, def, terminal);
  if (tags === undefined) return undefined;
  if (typeof tags.signal === 'string') return tags.signal;
  const lane = tags.role !== undefined ? laneOfPadRole(db, tags.role) : tags.lane;
  return lane === undefined ? undefined : signalOfLane(db.vocab, lane);
}

function tagged(db: Db, t: ResolvedTerminal, classes: readonly string[]): Tagged | undefined {
  const profile = profileTerminal(db, t.instanceKind, t.def, t.terminal);
  if (profile === undefined || profile.signal === undefined || !classes.includes(profile.class)) return undefined;
  const exact = exactSignalOf(db, t.instanceKind, t.def, t.terminal);
  return { t, hint: profile.signal, ...(exact === undefined ? {} : { exact }) };
}

const refOf = (t: ResolvedTerminal): TerminalRef => ({ instance: t.instance, terminal: t.terminal, ...(t.end === undefined ? {} : { end: t.end }) });
const show = (ref: TerminalRef): string => `${ref.instance}:${ref.terminal}${ref.end === undefined ? '' : `@${ref.end}`}`;

/** The joint, written the way the editor writes one: the source-end part first. */
function jointOf(wire: TerminalRef, landing: TerminalRef): Joint {
  return wire.end === 'a' ? { a: landing, b: wire } : { a: wire, b: landing };
}

export function proposeKnownJoints(design: CableDesign, db: Db): ConnectPlan {
  const proposals: JointProposal[] = [];
  const ambiguous: AmbiguousLanding[] = [];
  const open = unwiredTerminals(design, db);
  const sides = assemblySides(design);

  /* ---- signal and ground: trunk conductor ends onto pins and board cable pads ---- */
  const wires = open.flatMap((t) => (t.instanceKind === 'segment' && t.end !== undefined ? [tagged(db, t, ['conductor'])] : [])).filter((x): x is Tagged => x !== undefined);
  const landings = open
    .flatMap((t) => (t.instanceKind === 'connector' || t.instanceKind === 'pcba' ? [tagged(db, t, ['connector-pin', 'board-cable-pad'])] : []))
    .filter((x): x is Tagged => x !== undefined);

  const candidatesFor = (w: Tagged): { list: Tagged[]; tier: 'exact' | 'hint' } => {
    const here = landings.filter((l) => {
      const side = sides.get(l.t.instance) ?? 'unassigned';
      return side === 'both' || side === 'unassigned' || side === w.t.end;
    });
    if (w.exact !== undefined) {
      const exact = here.filter((l) => l.exact === w.exact);
      if (exact.length > 0) return { list: exact, tier: 'exact' };
    }
    return { list: here.filter((l) => l.hint === w.hint), tier: 'hint' };
  };

  const choice = new Map<string, { w: Tagged; list: Tagged[]; tier: 'exact' | 'hint' }>();
  const claimed = new Map<string, Tagged[]>();
  for (const w of wires) {
    const c = candidatesFor(w);
    if (c.list.length === 0) continue;
    choice.set(w.t.key, { w, ...c });
    for (const l of c.list) claimed.set(l.t.key, [...(claimed.get(l.t.key) ?? []), w]);
  }
  for (const { w, list, tier } of choice.values()) {
    const sole = list.length === 1 ? list[0]! : undefined;
    const wireRef = refOf(w.t);
    if (sole !== undefined && (claimed.get(sole.t.key)?.length ?? 0) === 1) {
      const ground = w.hint === 'ground';
      proposals.push({
        kind: ground ? 'ground' : 'signal',
        joint: jointOf(wireRef, refOf(sole.t)),
        why: `${show(wireRef)} and ${show(refOf(sole.t))} both carry ${tier === 'exact' ? (w.exact ?? w.hint) : w.hint}, and nothing else on that end could take either`,
      });
    } else {
      ambiguous.push({
        terminal: wireRef,
        candidates: list.map((l) => refOf(l.t)),
        why:
          list.length > 1
            ? `${show(wireRef)} could go to ${list.length} terminals that carry ${w.hint}`
            : `${show(wireRef)} could go to ${show(refOf(list[0]!.t))}, but another conductor could too`,
      });
    }
  }

  /* ---- footprint: a connector mounted on a board, pin n onto pad <prefix>.n ---- */
  const connectors = design.instances.connectors.map((c) => c.id);
  const boards = design.instances.pcbas.map((p) => p.id);
  const byInstance = new Map<string, ResolvedTerminal[]>();
  for (const t of open) byInstance.set(t.instance, [...(byInstance.get(t.instance) ?? []), t]);
  for (const cid of connectors) {
    const pins = (byInstance.get(cid) ?? []).filter((t) => t.instanceKind === 'connector');
    if (pins.length === 0) continue;
    interface Mate { board: string; prefix: string; pairs: { pin: ResolvedTerminal; pad: ResolvedTerminal; agree: boolean; clash: boolean }[] }
    const mates: Mate[] = [];
    for (const bid of boards) {
      const pads = (byInstance.get(bid) ?? []).filter((t) => t.instanceKind === 'pcba' && t.terminal.includes('.'));
      const prefixes = [...new Set(pads.map((p) => p.terminal.slice(0, p.terminal.indexOf('.'))))];
      for (const prefix of prefixes) {
        const pairs: Mate['pairs'] = [];
        for (const pin of pins) {
          const pad = pads.find((p) => p.terminal === `${prefix}.${pin.terminal}`);
          if (pad === undefined) continue;
          const a = tagged(db, pin, ['connector-pin']);
          const b = tagged(db, pad, ['board-connector-pad']);
          const both = a !== undefined && b !== undefined;
          pairs.push({ pin, pad, agree: both && a.hint === b.hint, clash: both && a.hint !== b.hint });
        }
        if (pairs.some((p) => p.agree) && !pairs.some((p) => p.clash)) mates.push({ board: bid, prefix, pairs });
      }
    }
    if (mates.length === 1) {
      const m = mates[0]!;
      for (const { pin, pad } of m.pairs) {
        proposals.push({
          kind: 'footprint',
          joint: { a: refOf(pin), b: refOf(pad) },
          why: `${cid} is mounted on ${m.board}'s ${m.prefix} footprint: pin ${pin.terminal} is pad ${m.prefix}.${pin.terminal}, and the tagged pairs agree`,
        });
      }
    } else if (mates.length > 1) {
      for (const pin of pins) {
        ambiguous.push({
          terminal: refOf(pin),
          candidates: mates.flatMap((m) => m.pairs.filter((p) => p.pin.key === pin.key).map((p) => refOf(p.pad))),
          why: `${cid} could be mounted on more than one footprint (${mates.map((m) => `${m.board} ${m.prefix}`).join(', ')})`,
        });
      }
    }
  }

  // a terminal two proposals both want is not a safe proposal after all
  const wanted = new Map<string, JointProposal[]>();
  for (const p of proposals) for (const ref of [p.joint.a, p.joint.b]) wanted.set(terminalKey(ref), [...(wanted.get(terminalKey(ref)) ?? []), p]);
  const safe: JointProposal[] = [];
  for (const p of proposals) {
    const clash = [p.joint.a, p.joint.b].some((ref) => (wanted.get(terminalKey(ref))?.length ?? 0) > 1);
    if (!clash) safe.push(p);
    else
      ambiguous.push({
        terminal: p.kind === 'footprint' ? p.joint.a : p.joint.a.end === undefined ? p.joint.b : p.joint.a,
        candidates: [p.kind === 'footprint' ? p.joint.b : p.joint.a.end === undefined ? p.joint.a : p.joint.b],
        why: `${p.why} — but another proposal wants one of the same terminals`,
      });
  }
  return { proposals: safe, ambiguous };
}
