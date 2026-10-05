/**
 * Ground pigtails by board face — the owner's rule, applied to a stored (v2)
 * design:
 *
 * > "we should indicate the rgb to the ground on their side of the board,
 * > sync and audio to their side, etc."
 *
 * Each coax braid lands on the GND pad on the **same board face as its own
 * signal's pad**, at both ends — the RGB braids to the GND pad on the RGB
 * face, the sync and audio braids to the GND pad on theirs. The drain (the
 * foil + drain mass of a mini-coax, shown only as the drain) goes with the
 * non-RGB face. The foil itself is never landed: it is trimmed back at both
 * ends (`isTrimmedFoil`), so it leaves every pigtail and loses its own joints.
 *
 * `regroupPigtailsByFace` re-derives, per segment end landing on a board, the
 * pigtails (and lone braid joints) from scratch: every screen landing on one
 * board terminal is pooled, the foil dropped, the rest split by the face of
 * each screen's signal pad, and each face's group lands on that face's wire
 * pad — the one nearest the group's signal pads when the face has several.
 * A face group of one screen is a lone joint, as the migration writes it.
 * Pure: design + db in, a new design and a report out.
 *
 * The port-level net partition must not split (`comparePortPartitions`, the
 * migration's own check) and the result must validate no worse than the
 * input; otherwise the design is returned untouched and the report says why.
 *
 * `assignShellPads` names the shell pad on joints landing a connector shell
 * on a board terminal whose pads include shell pads (the source device 2 / the source device: the
 * Mini-DIN body is soldered to both H11 and H12, so the one joint becomes one
 * per shell pad).
 */

import { isFullyBonded, isScreenPath, isTrimmedFoil, screenPaths } from './bonds.ts';
import { comparePortPartitions } from './migrate-bonds.ts';
import {
  findPcba,
  findWire,
  pigtailIdOf,
  pigtailTerminal,
  type CableDesign,
  type Db,
  type Joint,
  type PcbaPad,
  type Pigtail,
  type SegmentInstance,
  type TerminalRef,
  type WireDefinition,
} from './model.ts';
import { findInstance, terminalKey, validateDesign } from './validate.ts';

type Face = 'top' | 'bottom';

const RGB_CORES = ['core-red', 'core-green', 'core-blue'];
/** signal letters, for naming a face's pigtail */
const CORE_LETTERS: Readonly<Record<string, string>> = {
  'core-red': 'r',
  'core-green': 'g',
  'core-blue': 'b',
  'core-yellow': 's',
  'core-white': 'la',
  'core-black': 'ra',
};

export interface FaceRegroupReport {
  design: string;
  /** one line per regrouped landing */
  lines: string[];
  /** where the per-face rule could not be applied, and why */
  cannot: string[];
  /** where a face had several wire pads and the nearest was picked */
  nearest: string[];
  /** foil landings removed */
  foil: string[];
  /** false when the result was refused (net split / new validation errors) */
  ok: boolean;
  errors: string[];
}

export interface FaceRegroupResult {
  design: CableDesign;
  report: FaceRegroupReport;
  changed: boolean;
}

/** The core a screen belongs to: `core-red.shield` → `core-red`. */
function coreOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : path.slice(0, dot);
}

function padsOf(design: CableDesign, db: Db, ref: TerminalRef): PcbaPad[] {
  const instance = findInstance(design, ref.instance);
  if (instance?.kind !== 'pcba') return [];
  return findPcba(db, instance.def)?.terminals.find((t) => t.id === ref.terminal)?.pads ?? [];
}

/** Wire-landing pads (not the connector shell's). */
function wirePads(pads: readonly PcbaPad[]): PcbaPad[] {
  return pads.filter((pad) => pad.role !== 'shell');
}

/** The one face a signal terminal's pads sit on, if they agree. */
function faceOf(pads: readonly PcbaPad[]): Face | undefined {
  const sides = new Set(wirePads(pads).map((p) => p.side));
  if (sides.size !== 1) return undefined;
  const [side] = [...sides];
  return side === 'top' || side === 'bottom' ? side : undefined;
}

/** The pad of `candidates` nearest the centroid of `points` (first on a tie, or with no positions). */
export function nearestPad(
  candidates: readonly PcbaPad[],
  points: readonly { x: number; y: number }[],
): PcbaPad | undefined {
  if (candidates.length <= 1 || points.length === 0) return candidates[0];
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let best: PcbaPad | undefined;
  let distance = Infinity;
  for (const pad of candidates) {
    if (pad.x === undefined || pad.y === undefined) continue;
    const d = Math.hypot(pad.x - cx, pad.y - cy);
    if (d < distance - 1e-9) {
      best = pad;
      distance = d;
    }
  }
  return best ?? candidates[0];
}

/** One screen landing at a segment end: a pigtail's landing joint, or a lone screen joint. */
interface Item {
  index: number;
  /** which side of the joint the wire is on */
  side: 'a' | 'b';
  landing: TerminalRef;
  members: string[];
  pigtail?: Pigtail;
  note?: string;
}

function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sameMembers(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((m) => y.includes(m));
}

function pigtailName(members: readonly string[], rgbGroup: boolean): string {
  const letters = members
    .map((m) => {
      const core = coreOf(m);
      return core === undefined ? undefined : CORE_LETTERS[core];
    })
    .filter((l): l is string => l !== undefined)
    .join('');
  if (rgbGroup && letters === 'rgb') return 'rgb';
  if (letters === 'slara') return 'sla';
  return letters === '' ? 'gnd' : letters;
}

export function regroupPigtailsByFace(input: CableDesign, db: Db): FaceRegroupResult {
  const report: FaceRegroupReport = {
    design: input.id,
    lines: [],
    cannot: [],
    nearest: [],
    foil: [],
    ok: true,
    errors: [],
  };
  const design: CableDesign = structuredClone(input);
  // joint index → replacement joints (empty = drop)
  const replace = new Map<number, Joint[]>();

  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const mass = isFullyBonded(wire);
    const order = screenPaths(wire);
    for (const end of ['a', 'b'] as const) {
      if (mass) {
        massPads(design, db, segment, end, report);
        continue;
      }
      regroupEnd(design, db, segment, wire, end, order, replace, report);
    }
  }

  if (replace.size === 0 && report.lines.length === 0) return { design: input, report, changed: false };
  const joints: Joint[] = [];
  design.joints.forEach((joint, index) => {
    const next = replace.get(index);
    if (next === undefined) joints.push(joint);
    else joints.push(...next);
  });
  design.joints = joints;

  if (JSON.stringify(design) === JSON.stringify(input)) return { design: input, report, changed: false };

  const check = comparePortPartitions(input, design, db);
  if (check.splits.length > 0) {
    report.ok = false;
    report.errors.push(...check.splits);
    return { design: input, report, changed: false };
  }
  const before = new Set(
    validateDesign(input, db)
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.code}|${i.message}`),
  );
  const fresh = validateDesign(design, db).filter(
    (i) => i.severity === 'error' && !before.has(`${i.code}|${i.message}`),
  );
  if (fresh.length > 0) {
    report.ok = false;
    report.errors.push(...fresh.map((i) => `${i.code}: ${i.message}`));
    return { design: input, report, changed: false };
  }
  return { design, report, changed: true };
}

/**
 * A mass pigtail (bonded multi-core) landing on a two-faced board terminal with no
 * pad, or on a shell pad: the non-RGB face's wire pad (the face rule).
 */
function massPads(
  design: CableDesign,
  db: Db,
  segment: SegmentInstance,
  end: 'a' | 'b',
  report: FaceRegroupReport,
): void {
  for (const pigtail of (segment.pigtails ?? []).filter((p) => p.end === end)) {
    for (const joint of design.joints) {
      for (const [mine, other] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (mine.instance !== segment.id || mine.end !== end || mine.terminal !== pigtailTerminal(pigtail.id)) continue;
        const pads = padsOf(design, db, other);
        const wire = wirePads(pads);
        const current = pads.find((p) => p.ref === other.pad);
        if (wire.length < 2 || (current !== undefined && current.role !== 'shell')) continue;
        const faces = signalFaces(design, db, segment.id, end, other.instance);
        const rgb = rgbFace(faces.face);
        if (rgb === undefined) {
          report.cannot.push(`${segment.id}@${end} mass pigtail ${pigtail.id} → ${terminalKey(other)}: no RGB face to go opposite of`);
          continue;
        }
        const face: Face = rgb === 'top' ? 'bottom' : 'top';
        const candidates = wire.filter((p) => p.side === face);
        const pick = nearestPad(candidates, faces.pointsOn(face));
        if (pick === undefined) continue;
        other.pad = pick.ref;
        report.lines.push(`${segment.id}@${end} mass pigtail ${pigtail.id} → ${terminalKey(other)} pad ${pick.ref}`);
      }
    }
  }
}

/** The faces (and pad positions) of each core's signal landing on `board` at this end. */
function signalFaces(
  design: CableDesign,
  db: Db,
  segment: string,
  end: 'a' | 'b',
  board: string,
): { face: Map<string, Face>; points: Map<string, { x: number; y: number }[]>; pointsOn: (face: Face, cores?: readonly string[]) => { x: number; y: number }[] } {
  const wire = findWire(db, design.instances.segments.find((s) => s.id === segment)?.def ?? '');
  const face = new Map<string, Face>();
  const points = new Map<string, { x: number; y: number }[]>();
  for (const joint of design.joints) {
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mine.instance !== segment || mine.end !== end || other.instance !== board) continue;
      const core = coreOf(mine.terminal);
      if (core === undefined || wire === undefined || isScreenPath(wire, mine.terminal)) continue;
      const pads = padsOf(design, db, other);
      const f = faceOf(pads);
      if (f === undefined) continue;
      face.set(core, f);
      points.set(
        core,
        wirePads(pads).flatMap((p) => (p.x === undefined || p.y === undefined ? [] : [{ x: p.x, y: p.y }])),
      );
    }
  }
  const pointsOn = (f: Face, cores?: readonly string[]): { x: number; y: number }[] =>
    [...face.entries()]
      .filter(([core, side]) => side === f && (cores === undefined || cores.includes(core)))
      .flatMap(([core]) => points.get(core) ?? []);
  return { face, points, pointsOn };
}

function rgbFace(face: ReadonlyMap<string, Face>): Face | undefined {
  const faces = new Set(RGB_CORES.map((core) => face.get(core)).filter((f): f is Face => f !== undefined));
  return faces.size === 1 ? [...faces][0] : undefined;
}

function regroupEnd(
  design: CableDesign,
  db: Db,
  segment: SegmentInstance,
  wire: WireDefinition,
  end: 'a' | 'b',
  order: readonly string[],
  replace: Map<number, Joint[]>,
  report: FaceRegroupReport,
): void {
  const where = `${segment.id}@${end}`;
  const pigtails = (segment.pigtails ?? []).filter((p) => p.end === end);
  // 1 · every screen landing at this end
  const items: Item[] = [];
  const skipPigtails = new Set<string>();
  design.joints.forEach((joint, index) => {
    for (const side of ['a', 'b'] as const) {
      const mine = joint[side];
      const other = joint[side === 'a' ? 'b' : 'a'];
      if (mine.instance !== segment.id || mine.end !== end) continue;
      if (other.instance === segment.id) return;
      const id = pigtailIdOf(mine.terminal);
      if (id !== undefined) {
        const pigtail = pigtails.find((p) => p.id === id);
        if (pigtail?.members === undefined) return;
        items.push({
          index,
          side,
          landing: other,
          members: [...pigtail.members],
          pigtail,
          ...(pigtail.note === undefined ? {} : { note: pigtail.note }),
        });
        return;
      }
      if (!isScreenPath(wire, mine.terminal)) return;
      const otherInstance = findInstance(design, other.instance);
      if (otherInstance?.kind === 'segment') return; // screen spliced to screen: leave it
      items.push({ index, side, landing: other, members: [mine.terminal], ...(joint.note === undefined ? {} : { note: joint.note }) });
      return;
    }
  });
  // a pigtail landing twice is ambiguous: leave its end alone
  const landings = new Map<string, number>();
  for (const item of items) if (item.pigtail !== undefined) landings.set(item.pigtail.id, (landings.get(item.pigtail.id) ?? 0) + 1);
  for (const [id, count] of landings) {
    if (count > 1) {
      skipPigtails.add(id);
      report.cannot.push(`${where} pigtail ${id} lands ${count} times — left as is`);
    }
  }
  const usable = items.filter((item) => item.pigtail === undefined || !skipPigtails.has(item.pigtail.id));

  // 2 · pooled by landing terminal
  const groups = new Map<string, Item[]>();
  for (const item of usable) {
    const key = terminalKey(item.landing);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  }

  const newPigtails: Pigtail[] = [];
  const retired = new Set<string>();
  const taken = new Set(pigtails.filter((p) => skipPigtails.has(p.id)).map((p) => p.id));

  for (const [key, group] of groups) {
    const landing = (() => {
      const { pad: _pad, ...rest } = (group[0] as Item).landing;
      return rest as TerminalRef;
    })();
    const pooled = [...new Set(group.flatMap((item) => item.members))];
    const foil = pooled.filter((m) => isTrimmedFoil(wire, m));
    const members = order.filter((m) => pooled.includes(m) && !foil.includes(m));
    for (const m of pooled) if (!order.includes(m) && !members.includes(m)) members.push(m);
    if (members.length === 0) {
      // the foil is all that lands here: dropping it would unground the pin
      report.cannot.push(`${where} → ${key}: only the foil lands here — kept (dropping it would leave ${key} ungrounded; owner to decide)`);
      continue;
    }
    if (foil.length > 0) report.foil.push(`${where} ${foil.join(', ')} → ${key}: trimmed back, not landed`);

    const pads = padsOf(design, db, landing);
    const wire2 = wirePads(pads);
    const sides = new Set(wire2.map((p) => p.side));
    const twoFaced = sides.has('top') && sides.has('bottom');
    // [face, members][]
    let parts: { face?: Face; members: string[] }[] = [{ members }];
    const faces = signalFaces(design, db, segment.id, end, landing.instance);
    if (twoFaced && members.length > 0) {
      const rgb = rgbFace(faces.face);
      const known = new Set(
        members.map((m) => faces.face.get(coreOf(m) ?? '')).filter((f): f is Face => f !== undefined),
      );
      if (rgb === undefined && known.size < 2) {
        if (known.size === 1) {
          parts = [{ face: [...known][0] as Face, members }];
        } else {
          parts = [{ members }];
          report.cannot.push(`${where} → ${key}: no signal pad faces on this board — pad left as it was`);
        }
      } else {
        const other: Face | undefined = rgb === undefined ? undefined : rgb === 'top' ? 'bottom' : 'top';
        const faceOfMember = (m: string): Face | undefined => faces.face.get(coreOf(m) ?? '') ?? other;
        const unplaced = members.filter((m) => faceOfMember(m) === undefined);
        if (unplaced.length > 0) {
          report.cannot.push(`${where} → ${key}: ${unplaced.join(', ')} has no face (no RGB face to go opposite of)`);
        }
        // the RGB face first, as the bench (and the migration) lists them
        const faceOrder: Face[] = rgb === 'bottom' ? ['bottom', 'top'] : ['top', 'bottom'];
        parts = faceOrder
          .map((face) => ({ face, members: members.filter((m) => faceOfMember(m) === face) }))
          .filter((part) => part.members.length > 0);
        if (unplaced.length > 0) {
          const first = parts[0];
          if (first === undefined) parts = [{ members: unplaced }];
          else first.members.push(...unplaced);
        }
      }
    } else if (!twoFaced && members.length > 0) {
      const known = new Set(members.map((m) => faces.face.get(coreOf(m) ?? '')).filter((f) => f !== undefined));
      if (wire2.length > 0 && known.size > 1) {
        report.cannot.push(
          `${where} → ${key}: signals on both faces but ${landing.terminal} has wire pads on one face only (${wire2.map((p) => `${p.ref} ${p.side ?? '?'}`).join(', ')})`,
        );
      }
      if (wire2.length === 1 || wire2.length === 0) parts = [{ members }];
    }

    // 3 · a pad for each part
    const rgb = rgbFace(faces.face);
    const built: Joint[] = [];
    for (const part of parts) {
      let pad: string | undefined;
      if (wire2.length > 1) {
        const onFace =
          part.face === undefined
            ? wire2
            : [
                ...wire2.filter((p) => p.side === part.face),
                ...wire2.filter((p) => p.side === 'both'),
              ];
        const exact = part.face === undefined ? onFace : onFace.filter((p) => p.side === part.face);
        const pool = exact.length > 0 ? exact : onFace;
        const cores = part.members.map((m) => coreOf(m)).filter((c): c is string => c !== undefined);
        const points =
          part.face === undefined
            ? cores.flatMap((core) => faces.points.get(core) ?? [])
            : faces.pointsOn(part.face, cores.length > 0 ? cores : undefined);
        // a signal terminal with pads at several places (a breakout board's
        // in and out) says nothing about where its braid lands
        const spread = cores.some((core) => (faces.points.get(core)?.length ?? 0) > 1);
        // Scoped to items covering *this* part's screens — a group that
        // splits into several faced parts (: a stock GND
        // pooling a previously-split rgbs/lara pair) must not let one part's
        // already-decided pad block another's from being kept.
        const named = new Set(
          group.filter((item) => item.members.some((m) => part.members.includes(m))).map((item) => item.landing.pad),
        );
        const pick = pool.length === 0 || (spread && pool.length > 1) ? undefined : nearestPad(pool, points);
        if (pick === undefined && spread && pool.length > 1) {
          if (named.size === 1) pad = [...named][0];
          report.cannot.push(
            `${where} [${part.members.join(', ')}] → ${key}: ${pool.map((p) => p.ref).join('/')} on the ${part.face ?? 'same'} face and the signal terminals have pads at several places — pad left ${pad ?? 'unset'}`,
          );
        } else if (pick === undefined) {
          // keep a pad the landing already named, when every piece agreed on one
          if (named.size === 1) pad = [...named][0];
          report.cannot.push(
            `${where} [${part.members.join(', ')}] → ${key}: no wire pad on the ${part.face ?? '?'} face (${wire2.map((p) => `${p.ref} ${p.side ?? '?'}`).join(', ')})`,
          );
        } else {
          pad = pick.ref;
          if (pool.length > 1) {
            report.nearest.push(
              `${where} [${part.members.join(', ')}] → ${key}: ${pool.map((p) => p.ref).join('/')} on the ${part.face ?? 'same'} face — ${pick.ref} is nearest the group's signal pads`,
            );
          }
        }
      }
      const notes = [
        ...new Set(
          group
            .filter((item) => item.members.some((m) => part.members.includes(m)))
            .map((item) => item.note)
            .filter((n): n is string => n !== undefined && n !== ''),
        ),
      ];
      const land: TerminalRef = { ...landing, ...(pad === undefined ? {} : { pad }) };
      const first = group[0] as Item;
      if (part.members.length === 1) {
        const path = part.members[0] as string;
        const tail: TerminalRef = { instance: segment.id, terminal: path, end };
        const joint: Joint = first.side === 'a' ? { a: tail, b: land } : { a: land, b: tail };
        if (notes.length > 0) joint.note = notes.join('; ');
        built.push(joint);
        report.lines.push(`${where} ${path} → ${terminalKey(land)}${pad === undefined ? '' : ` pad ${pad}`}`);
        continue;
      }
      // keep an existing id when a pigtail already twists exactly these
      const same = group.find(
        (item) =>
          item.pigtail?.members !== undefined &&
          sameMembers(
            item.pigtail.members.filter((m) => !isTrimmedFoil(wire, m)),
            part.members,
          ),
      );
      let id = same?.pigtail?.id;
      if ((id === undefined || taken.has(id)) && parts.length === 1) {
        // not split: the name it had (bar the foil), else its landing's, as the migration names them
        const had = group.find((item) => item.pigtail !== undefined)?.pigtail?.id;
        id =
          had !== undefined && !taken.has(had)
            ? had
            : findInstance(design, landing.instance)?.kind === 'pcba'
              ? kebab(landing.terminal)
              : kebab(`${landing.instance}-${landing.terminal}`);
        for (let n = 2, base = id; taken.has(id) || newPigtails.some((p) => p.id === id); n += 1) id = `${base}-${n}`;
      }
      if (id === undefined || taken.has(id)) {
        const base = pigtailName(part.members, part.face !== undefined && part.face === rgb);
        id = base;
        for (let n = 2; taken.has(id) || newPigtails.some((p) => p.id === id); n += 1) id = `${base}-${n}`;
      }
      taken.add(id);
      const pigtail: Pigtail = { id, end, members: part.members };
      if (notes.length > 0) pigtail.note = notes.join('; ');
      newPigtails.push(pigtail);
      const tail: TerminalRef = { instance: segment.id, terminal: pigtailTerminal(id), end };
      built.push(first.side === 'a' ? { a: tail, b: land } : { a: land, b: tail });
      report.lines.push(`${where} pigtail ${id} [${part.members.join(', ')}] → ${terminalKey(land)}${pad === undefined ? '' : ` pad ${pad}`}`);
    }
    // 4 · the group's joints are replaced by `built`, placed where the first one was
    const indices = group.map((item) => item.index).sort((x, y) => x - y);
    indices.forEach((index, n) => replace.set(index, n === 0 ? built : []));
    for (const item of group) if (item.pigtail !== undefined) retired.add(item.pigtail.id);
  }

  // 5 · the end's pigtails: untouched ones, then the new ones, in id order of first appearance
  const kept = (segment.pigtails ?? []).filter((p) => p.end !== end || !retired.has(p.id));
  const all = [...kept, ...newPigtails];
  all.sort((x, y) => (x.end === y.end ? 0 : x.end === 'a' ? -1 : 1));
  if (all.length === 0) delete segment.pigtails;
  else segment.pigtails = all;
}

/**
 * Joints landing a connector's shell on a board terminal whose pads include
 * `role: 'shell'` pads, with no pad named: one joint per shell pad (the
 * Mini-DIN body soldered to both H11 and H12 on the source device 2 / the source device — owner,
 * 2026-09-25). A joint that already names a pad is left alone.
 */
export function assignShellPads(input: CableDesign, db: Db): { design: CableDesign; lines: string[] } {
  const lines: string[] = [];
  const joints: Joint[] = [];
  for (const joint of input.joints) {
    let out: Joint[] = [joint];
    for (const [mine, other] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (mine.terminal !== 'shell' || other.pad !== undefined) continue;
      if (findInstance(input, mine.instance)?.kind !== 'connector') continue;
      const shells = padsOf(input, db, other).filter((p) => p.role === 'shell');
      if (shells.length === 0) continue;
      out = shells.map((pad, n) => {
        const land: TerminalRef = { ...other, pad: pad.ref };
        const next: Joint = joint.a === other ? { ...joint, a: land } : { ...joint, b: land };
        if (n > 0) delete next.note;
        return next;
      });
      lines.push(`${terminalKey(mine)} → ${terminalKey(other)} pads ${shells.map((p) => p.ref).join(' + ')}`);
    }
    joints.push(...out);
  }
  if (lines.length === 0) return { design: input, lines };
  return { design: { ...input, joints }, lines };
}

/** Human-readable dry-run lines for one report. */
export function formatFaceRegroupReport(report: FaceRegroupReport): string[] {
  const out = [`${report.design}${report.ok ? '' : '  ✗ REFUSED'}`];
  for (const line of report.lines) out.push(`  ${line}`);
  for (const line of report.foil) out.push(`  foil: ${line}`);
  for (const line of report.nearest) out.push(`  nearest: ${line}`);
  for (const line of report.cannot) out.push(`  ⚠ ${line}`);
  for (const line of report.errors) out.push(`  ✗ ${line}`);
  return out;
}
