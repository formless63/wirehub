/**
 * `migrateShieldBonds` — rewrite a v1 design's per-screen ground joints as
 * pigtails (specs/shield-bonding.md §3). Pure: design + db in, a new design
 * and a report out; nothing is written anywhere.
 *
 * For each segment × end:
 *
 * 1. the joints with a screen of this segment on one side are grouped by the
 *    terminal they land on;
 * 2. on a **fully bonded stock** (bonded multi-core) each landing becomes one mass
 *    pigtail and one joint — and when the landings are several ground pins of
 *    one bare connector head, the mass lands once and the head's ground pins
 *    are bridged by joints instead;
 * 3. on any other stock a landing of two or more screens becomes one pigtail
 *    with those members; a single screen keeps its joint. Where the landing is
 *    a board terminal with pads on both faces, the screens split by the face
 *    their signal pads are on — "RGB grounds to the pad on the RGB face, the
 *    S/LA/RA grounds to the pad on their own side", with the foil and drain
 *    landing with S/LA/RA;
 * 4. matching joint notes move onto the pigtail; differing ones are joined
 *    and flagged.
 *
 * The port-level net partition before and after is compared: a split is a
 * migration bug and is reported as `ok: false`; a merge is only possible
 * through a bonded set, and is listed as a physically true merge.
 */

import {
  CURRENT_SCHEMA_VERSION,
  findPcba,
  findWire,
  pigtailTerminal,
  type CableDesign,
  type Db,
  type Joint,
  type PcbaPad,
  type Pigtail,
  type SegmentInstance,
  type TerminalRef,
} from './model.ts';
import { isFullyBonded, isScreenPath } from './bonds.ts';
import { regroupPigtailsByFace } from './ground-faces.ts';
import { deriveNets } from './nets.ts';
import { findInstance, terminalKey } from './validate.ts';

/** One pigtail (or kept joint) the migration produced. */
export interface BondMigrationEntry {
  segment: string;
  end: 'a' | 'b';
  /** joints this entry replaces */
  joints: number;
  /** `pigtail` = new pigtail + one landing joint; `kept` = a lone screen joint left as it was */
  action: 'pigtail' | 'kept';
  pigtail?: string;
  /** screens covered; `mass` for a pigtail on a fully bonded stock */
  members: string[] | 'mass';
  landing: string;
  pad?: string;
}

export interface BondMigrationReport {
  design: string;
  jointsBefore: number;
  jointsAfter: number;
  entries: BondMigrationEntry[];
  /** landings whose pad the board data could not decide */
  padsUnassigned: string[];
  /** things for a human to look at */
  flags: string[];
  /** nets that merged — true copper through a bonded set */
  merges: string[];
  /** false when the port partition split (a migration bug; do not write) */
  ok: boolean;
  /** why `ok` is false */
  errors: string[];
}

export interface BondMigrationResult {
  design: CableDesign;
  report: BondMigrationReport;
  /** false when the design had nothing to migrate */
  changed: boolean;
}

type Face = 'top' | 'bottom';

const RGB_CORES = ['core-red', 'core-green', 'core-blue'];
/** the signal letters used to name a split pigtail, by core */
const CORE_LETTERS: Readonly<Record<string, string>> = {
  'core-red': 'r',
  'core-green': 'g',
  'core-blue': 'b',
  'core-yellow': 's',
  'core-white': 'la',
  'core-black': 'ra',
};

function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The core a screen belongs to: `core-red.shield` → `core-red`; none for a top-level screen. */
function coreOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : path.slice(0, dot);
}

/** The pads of a PCBA terminal, if the ref is one and the board declares them. */
function padsOf(design: CableDesign, db: Db, ref: TerminalRef): PcbaPad[] {
  const instance = findInstance(design, ref.instance);
  if (instance?.kind !== 'pcba') return [];
  return findPcba(db, instance.def)?.terminals.find((t) => t.id === ref.terminal)?.pads ?? [];
}

/** The single face a terminal's (non-shell) pads sit on, if they agree. */
function faceOf(pads: PcbaPad[]): Face | undefined {
  const sides = new Set(pads.filter((p) => p.role !== 'shell').map((p) => p.side));
  if (sides.size !== 1) return undefined;
  const [side] = [...sides];
  return side === 'top' || side === 'bottom' ? side : undefined;
}

/** The one wire-landing pad of a terminal on this face, if exactly one. */
function padOnFace(pads: PcbaPad[], face: Face): string | undefined {
  const candidates = pads.filter((p) => p.side === face && p.role !== 'shell');
  return candidates.length === 1 ? candidates[0]?.ref : undefined;
}

/** Does this terminal have wire-landing pads on both faces? */
function twoFaced(pads: PcbaPad[]): boolean {
  const sides = new Set(pads.filter((p) => p.role !== 'shell').map((p) => p.side));
  return sides.has('top') && sides.has('bottom');
}

export function migrateShieldBonds(input: CableDesign, db: Db): BondMigrationResult {
  const design: CableDesign = structuredClone(input);
  const report: BondMigrationReport = {
    design: design.id,
    jointsBefore: design.joints.length,
    jointsAfter: design.joints.length,
    entries: [],
    padsUnassigned: [],
    flags: [],
    merges: [],
    ok: true,
    errors: [],
  };

  // joint index → replacement (undefined = drop); untouched joints are absent
  const replace = new Map<number, Joint[]>();
  const handled = new Set<number>();

  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const mass = isFullyBonded(wire);
    const pigtails: Pigtail[] = [...(segment.pigtails ?? [])];
    const usedIds = new Set(pigtails.map((p) => `${p.end}:${p.id}`));
    const newId = (end: 'a' | 'b', base: string): string => {
      let id = base === '' ? 'gnd' : base;
      for (let n = 2; usedIds.has(`${end}:${id}`); n += 1) id = `${base}-${n}`;
      usedIds.add(`${end}:${id}`);
      return id;
    };

    for (const end of ['a', 'b'] as const) {
      // 1 · screen joints of this segment end, grouped by landing
      interface Hit {
        index: number;
        screen: string;
        /** which side of the joint the screen is on */
        side: 'a' | 'b';
        landing: TerminalRef;
      }
      const groups = new Map<string, Hit[]>();
      design.joints.forEach((joint, index) => {
        if (handled.has(index)) return;
        for (const side of ['a', 'b'] as const) {
          const ref = joint[side];
          const other = joint[side === 'a' ? 'b' : 'a'];
          if (ref.instance !== segment.id || ref.end !== end) continue;
          if (!isScreenPath(wire, ref.terminal)) continue;
          const otherInstance = findInstance(design, other.instance);
          const otherWire =
            otherInstance?.kind === 'segment' ? findWire(db, otherInstance.def) : undefined;
          if (otherWire !== undefined && isScreenPath(otherWire, other.terminal)) {
            report.flags.push(
              `${terminalKey(ref)} ↔ ${terminalKey(other)}: screen spliced to screen — kept as a joint`,
            );
            return;
          }
          if (other.instance === segment.id) return;
          const key = terminalKey(other);
          const hit: Hit = { index, screen: ref.terminal, side, landing: other };
          const list = groups.get(key);
          if (list === undefined) groups.set(key, [hit]);
          else list.push(hit);
          return;
        }
      });
      if (groups.size === 0) continue;

      // faces of the signal pads at this end, per core (for the RGB/SLA split)
      const coreFace = new Map<string, Face>();
      for (const joint of design.joints) {
        for (const side of ['a', 'b'] as const) {
          const ref = joint[side];
          const other = joint[side === 'a' ? 'b' : 'a'];
          if (ref.instance !== segment.id || ref.end !== end) continue;
          const core = coreOf(ref.terminal);
          if (core === undefined || isScreenPath(wire, ref.terminal)) continue;
          const face = faceOf(padsOf(design, db, other));
          if (face !== undefined) coreFace.set(`${other.instance}|${core}`, face);
        }
      }
      const rgbFaceOn = (instance: string): Face | undefined => {
        const faces = new Set(
          RGB_CORES.map((core) => coreFace.get(`${instance}|${core}`)).filter((f) => f !== undefined),
        );
        return faces.size === 1 ? [...faces][0] : undefined;
      };

      const noteFor = (hits: Hit[], where: string): string | undefined => {
        const notes = [
          ...new Set(
            hits
              .map((h) => design.joints[h.index]?.note)
              .filter((n): n is string => n !== undefined && n !== '')
              // "X's own shield, onto the same ground as the others" only
              // explains one braid's joint — the pigtail says it for all
              .filter((n) => !/own shield, onto the same ground as the others/.test(n)),
          ),
        ];
        if (notes.length === 0) return undefined;
        if (notes.length > 1) report.flags.push(`${where}: differing joint notes joined`);
        return notes.join('; ');
      };

      const landingJoint = (
        hits: Hit[],
        pigtail: Pigtail,
        landing: TerminalRef,
        pad: string | undefined,
      ): Joint => {
        const first = hits[0] as Hit;
        const tail: TerminalRef = { instance: segment.id, terminal: pigtailTerminal(pigtail.id), end };
        const land: TerminalRef = { ...landing, ...(pad === undefined ? {} : { pad }) };
        return first.side === 'a' ? { a: tail, b: land } : { a: land, b: tail };
      };

      const place = (hits: Hit[], joints: Joint[]): void => {
        const [first, ...rest] = hits.map((h) => h.index).sort((x, y) => x - y);
        if (first === undefined) return;
        replace.set(first, [...(replace.get(first) ?? []), ...joints]);
        for (const index of rest) if (!replace.has(index)) replace.set(index, []);
        for (const h of hits) handled.add(h.index);
      };

      const landingName = (landing: TerminalRef): string => {
        const instance = findInstance(design, landing.instance);
        return instance?.kind === 'pcba'
          ? kebab(landing.terminal)
          : kebab(`${landing.instance}-${landing.terminal}`);
      };

      if (mass) {
        // 2 · bonded stock: one mass pigtail per landing, or one per bare head
        const all = [...groups.values()];
        const heads = new Set(all.map((hits) => (hits[0] as Hit).landing.instance));
        const onOneConnector =
          all.length >= 2 &&
          heads.size === 1 &&
          findInstance(design, [...heads][0] ?? '')?.kind === 'connector';
        if (onOneConnector) {
          const ranked = [...all].sort(
            (x, y) => y.length - x.length || (x[0] as Hit).index - (y[0] as Hit).index,
          );
          const main = ranked[0] as Hit[];
          const landing = (main[0] as Hit).landing;
          const hits = all.flat();
          const pigtail: Pigtail = { id: newId(end, landingName(landing)), end };
          const note = noteFor(hits, `${segment.id}@${end}`);
          if (note !== undefined) pigtail.note = note;
          pigtails.push(pigtail);
          const bridges: Joint[] = ranked.slice(1).map((group) => ({
            a: { ...landing },
            b: { ...(group[0] as Hit).landing },
            note: 'ground pins bridged in the head; the shield mass lands once',
          }));
          place(hits, [landingJoint(main, pigtail, landing, undefined), ...bridges]);
          report.entries.push({
            segment: segment.id,
            end,
            joints: hits.length,
            action: 'pigtail',
            pigtail: pigtail.id,
            members: 'mass',
            landing: `${terminalKey(landing)} + ${bridges.length} bridge(s) to ${bridges.map((b) => b.b.terminal).join(', ')}`,
          });
          continue;
        }
        for (const hits of all) {
          const landing = (hits[0] as Hit).landing;
          const pigtail: Pigtail = { id: newId(end, landingName(landing)), end };
          const note = noteFor(hits, `${segment.id}@${end} → ${terminalKey(landing)}`);
          if (note !== undefined) pigtail.note = note;
          // foil and drain land with S/LA/RA: the mass goes to the non-RGB face pad
          const pads = padsOf(design, db, landing);
          let pad: string | undefined;
          if (pads.length > 1) {
            const rgbFace = rgbFaceOn(landing.instance);
            if (rgbFace !== undefined) pad = padOnFace(pads, rgbFace === 'top' ? 'bottom' : 'top');
            if (pad === undefined) {
              report.padsUnassigned.push(
                `${design.id} ${segment.id}@${end} pigtail ${pigtail.id} → ${terminalKey(landing)} (pads ${pads.map((p) => `${p.ref} ${p.side ?? '?'}`).join(', ')})`,
              );
            }
          }
          pigtails.push(pigtail);
          place(hits, [landingJoint(hits, pigtail, landing, pad)]);
          report.entries.push({
            segment: segment.id,
            end,
            joints: hits.length,
            action: 'pigtail',
            pigtail: pigtail.id,
            members: 'mass',
            landing: terminalKey(landing),
            ...(pad === undefined ? {} : { pad }),
          });
        }
        continue;
      }

      // 3 · other stock: twist groups of two or more, split by board face
      for (const hits of groups.values()) {
        const landing = (hits[0] as Hit).landing;
        const pads = padsOf(design, db, landing);
        const rgbFace = rgbFaceOn(landing.instance);
        let parts: { face?: Face; hits: Hit[] }[] = [{ hits }];
        if (hits.length >= 2 && pads.length > 1 && twoFaced(pads) && rgbFace !== undefined) {
          const other: Face = rgbFace === 'top' ? 'bottom' : 'top';
          const faceOfHit = (h: Hit): Face => {
            const core = coreOf(h.screen);
            const face = core === undefined ? undefined : coreFace.get(`${landing.instance}|${core}`);
            return face === rgbFace ? rgbFace : other;
          };
          parts = [rgbFace, other]
            .map((face) => ({ face, hits: hits.filter((h) => faceOfHit(h) === face) }))
            .filter((part) => part.hits.length > 0);
        } else if (pads.length > 1) {
          // one face only: the signal pads of these screens decide it
          const faces = new Set(
            hits.map((h) => {
              const core = coreOf(h.screen);
              return core === undefined ? undefined : coreFace.get(`${landing.instance}|${core}`);
            }),
          );
          const [only] = [...faces];
          if (faces.size === 1 && only !== undefined) parts = [{ face: only, hits }];
        }
        for (const part of parts) {
          const pad = part.face === undefined || pads.length <= 1 ? undefined : padOnFace(pads, part.face);
          const members = part.hits.map((h) => h.screen);
          const label = `${design.id} ${segment.id}@${end} [${members.join(', ')}] → ${terminalKey(landing)}`;
          if (pads.length > 1 && pad === undefined) {
            report.padsUnassigned.push(
              `${label} (pads ${pads.map((p) => `${p.ref} ${p.side ?? '?'}`).join(', ')})`,
            );
          }
          if (part.hits.length === 1) {
            const only = part.hits[0] as Hit;
            const joint = structuredClone(design.joints[only.index] as Joint);
            if (pad !== undefined) {
              const land = only.side === 'a' ? joint.b : joint.a;
              land.pad = pad;
            }
            place(part.hits, [joint]);
            report.entries.push({
              segment: segment.id,
              end,
              joints: 1,
              action: 'kept',
              members,
              landing: terminalKey(landing),
              ...(pad === undefined ? {} : { pad }),
            });
            continue;
          }
          let base = landingName(landing);
          if (part.face !== undefined && parts.length > 1) {
            const letters = members.map((m) => {
              const core = coreOf(m);
              return core === undefined ? undefined : CORE_LETTERS[core];
            });
            const cores = letters.filter((l): l is string => l !== undefined);
            base = part.face === rgbFace ? (cores.join('') === 'rgb' ? 'rgb' : cores.join('')) : cores.join('') === 'slara' ? 'sla' : cores.join('') || 'gnd';
          }
          const pigtail: Pigtail = { id: newId(end, base), end, members };
          const note = noteFor(part.hits, label);
          if (note !== undefined) pigtail.note = note;
          pigtails.push(pigtail);
          place(part.hits, [landingJoint(part.hits, pigtail, landing, pad)]);
          report.entries.push({
            segment: segment.id,
            end,
            joints: part.hits.length,
            action: 'pigtail',
            pigtail: pigtail.id,
            members,
            landing: terminalKey(landing),
            ...(pad === undefined ? {} : { pad }),
          });
        }
      }
    }

    if (pigtails.length > 0) {
      pigtails.sort((x, y) => (x.end === y.end ? 0 : x.end === 'a' ? -1 : 1));
      (segment as SegmentInstance).pigtails = pigtails;
    }
  }

  const changed = report.entries.some((e) => e.action === 'pigtail' || e.pad !== undefined);
  if (!changed) return { design: input, report, changed: false };

  const joints: Joint[] = [];
  design.joints.forEach((joint, index) => {
    const replacement = replace.get(index);
    if (replacement === undefined) joints.push(joint);
    else joints.push(...replacement);
  });
  design.joints = joints;
  design.schemaVersion = CURRENT_SCHEMA_VERSION;
  report.jointsAfter = joints.length;

  // 5 · the port-level net partition must not split
  const check = comparePortPartitions(input, design, db);
  report.merges = check.merges;
  if (check.splits.length > 0) {
    report.ok = false;
    report.errors.push(...check.splits);
    return { design, report, changed: true };
  }
  // 6 · the owner's as-built ground rules on top: the
  // foil trimmed back and never landed, every braid to the GND pad on its own
  // signal's face at both ends, the pad nearest the group where a face has
  // several — so the wizard and the stock swaps store what the catalog does
  const faces = regroupPigtailsByFace(design, db);
  if (faces.changed) {
    report.jointsAfter = faces.design.joints.length;
    report.flags.push(...faces.report.cannot);
    return { design: faces.design, report, changed: true };
  }
  return { design, report, changed: true };
}

/** Ports: the terminals a bench can probe — everything that is not a wire end. */
function portGroups(design: CableDesign, db: Db): Map<string, string> {
  const out = new Map<string, string>();
  for (const net of deriveNets(design, db)) {
    const ports = net.terminals.filter((t) => t.instanceKind !== 'segment').map((t) => t.key).sort();
    const id = ports[0];
    if (id === undefined) continue;
    for (const key of ports) out.set(key, id);
  }
  return out;
}

/**
 * Compare two designs' port-level net partitions. `splits` lists ports that
 * shared a net before and do not after; `merges` lists nets that joined.
 * Ports that only appear on one side (a newly used pad) are ignored.
 */
export function comparePortPartitions(
  before: CableDesign,
  after: CableDesign,
  db: Db,
): { splits: string[]; merges: string[] } {
  const x = portGroups(before, db);
  const y = portGroups(after, db);
  const splits: string[] = [];
  const merges = new Set<string>();
  const byBefore = new Map<string, string[]>();
  for (const [key, group] of x) {
    const list = byBefore.get(group);
    if (list === undefined) byBefore.set(group, [key]);
    else list.push(key);
  }
  for (const members of byBefore.values()) {
    const after = new Set(members.map((key) => y.get(key)).filter((g) => g !== undefined));
    if (after.size > 1) splits.push(`net {${members.join(', ')}} split after migration`);
  }
  const byAfter = new Map<string, string[]>();
  for (const [key, group] of y) {
    if (!x.has(key)) continue;
    const list = byAfter.get(group);
    if (list === undefined) byAfter.set(group, [key]);
    else list.push(key);
  }
  for (const members of byAfter.values()) {
    const before = new Set(members.map((key) => x.get(key)));
    if (before.size > 1) merges.add(`{${members.join(', ')}} (was ${before.size} nets)`);
  }
  return { splits, merges: [...merges] };
}

/** Human-readable dry-run lines for one report. */
export function formatBondMigrationReport(report: BondMigrationReport): string[] {
  const lines = [`${report.design.padEnd(44)} joints ${report.jointsBefore} → ${report.jointsAfter}${report.ok ? '' : '  ✗ ABORT'}`];
  for (const e of report.entries) {
    const members = e.members === 'mass' ? 'mass' : `[${e.members.join(', ')}]`;
    lines.push(
      `  ${e.segment}@${e.end}  ${e.joints} joint(s) → ${e.action === 'pigtail' ? `pigtail ${e.pigtail ?? ''}` : 'kept'} ${members} → ${e.landing}${e.pad === undefined ? '' : ` pad ${e.pad}`}`,
    );
  }
  for (const m of report.merges) lines.push(`  merge (physically true, bonded): ${m}`);
  for (const f of report.flags) lines.push(`  ⚠ ${f}`);
  for (const p of report.padsUnassigned) lines.push(`  pad unset: ${p}`);
  for (const e of report.errors) lines.push(`  ✗ ${e}`);
  return lines;
}
