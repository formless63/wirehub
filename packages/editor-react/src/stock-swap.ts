/**
 * "The same cable, on another stock": move a design's trunk from one wire
 * stock to another — individually shielded coax to a shielded multi-core,
 * one vendor's stock to the next.
 *
 * When two stocks carry the same colour-to-signal map the wiring is
 * identical by construction, so the swap is done by **colour**, never by
 * guess:
 *
 * - a core's conductor goes where the old core's conductor went;
 * - a core's own shield goes where the old core's shield went;
 * - a core that is plain in the old stock but shielded in the new one has
 *   its new shield landed on the same ground as the other shields at that end;
 * - the overall shield stays the overall shield; a drain the new stock does
 *   not have is dropped (on a fully bonded stock a drain would be
 *   electrically identical to the other ground material), and one it gains
 *   lands with the overall shield at the source end;
 * - a core the new stock adds is left unconnected at both ends;
 *   a core it loses is reported, not silently discarded;
 * - grounds travel as pigtails (shield bonding, `specs/shield-bonding.md`
 *   §2.5): the trunk's pigtails are opened out to one joint per screen, carried
 *   across by colour like everything else, and twisted up again for the new
 *   stock by `migrateShieldBonds` — coax to a bonded stock collapses to one mass
 *   pigtail per distinct landing; a bonded stock to coax gives every screen to the
 *   mass's landing, and when the mass landed more than once everything goes
 *   on the first and the swap says so.
 *
 * Pure: design in, design out, plus plain sentences for what it could not map.
 */

import { trunkSegment } from '@wirehub/docs';
import {
  findWire,
  isFullyBonded,
  migrateShieldBonds,
  pigtailMembers,
  pigtailOfTerminal,
  type CableDesign,
  type Db,
  type Element,
  type Joint,
  type TerminalRef,
  type WireDefinition,
} from '@wirehub/model';

export interface StockSwapResult {
  design: CableDesign;
  /** what did not carry across, in words */
  lost: string[];
}

interface CoreMap {
  /** colour → conductor path */
  conductor: Map<string, string>;
  /** colour → that core's own shield path */
  shield: Map<string, string>;
  overall?: string;
  drain?: string;
}

function mapOf(wire: WireDefinition): CoreMap {
  const map: CoreMap = { conductor: new Map(), shield: new Map() };
  const colourOf = (element: Element): string | undefined => {
    if (element.kind === 'conductor') return element.color;
    if (element.kind === 'group') {
      for (const child of element.children) {
        const c = child.kind === 'conductor' ? child.color : undefined;
        if (c !== undefined) return c;
      }
    }
    return undefined;
  };
  for (const child of wire.structure.children) {
    if (child.kind === 'conductor' && child.bare === true) map.drain = child.id;
    else if (child.kind === 'shield') map.overall = child.id;
    else if (child.kind === 'conductor') {
      const colour = child.color;
      if (colour !== undefined) map.conductor.set(colour, child.id);
    } else if (child.kind === 'group') {
      const colour = colourOf(child);
      if (colour === undefined) continue;
      for (const inner of child.children) {
        if (inner.kind === 'conductor' && inner.bare !== true) map.conductor.set(colour, `${child.id}.${inner.id}`);
        if (inner.kind === 'shield') map.shield.set(colour, `${child.id}.${inner.id}`);
      }
    }
  }
  return map;
}

function invert(m: Map<string, string>): Map<string, string> {
  return new Map([...m].map(([k, v]) => [v, k]));
}

export function withTrunkStock(design: CableDesign, db: Db, wireId: string): StockSwapResult {
  // the drawing sheet's own rule for which segment is the cable
  const trunk = trunkSegment(design, db);
  const from = trunk === undefined ? undefined : findWire(db, trunk.def);
  const to = findWire(db, wireId);
  const lost: string[] = [];
  if (trunk === undefined || from === undefined || to === undefined) {
    return { design, lost: ['the design has no trunk on a known stock, or the new stock is not in the catalog'] };
  }
  // already on that stock: nothing to move, and nothing to say about it
  if (from.id === to.id) return { design, lost };
  const a = mapOf(from);
  const b = mapOf(to);
  const conductorColour = invert(a.conductor);
  const shieldColour = invert(a.shield);

  // open the trunk's pigtails out to one joint per screen, so the colour map
  // below carries every screen; they are twisted up again at the end
  const opened = openPigtails(design, trunk.id, from, isFullyBonded(from) && !isFullyBonded(to), lost);

  const next: CableDesign = structuredClone(opened);
  next.instances.segments = next.instances.segments.map((s) => (s.id === trunk.id ? { ...s, def: wireId } : s));

  const translate = (ref: TerminalRef): TerminalRef | undefined => {
    if (ref.instance !== trunk.id) return ref;
    const path = ref.terminal;
    const move = (to: string | undefined): TerminalRef | undefined => (to === undefined ? undefined : { ...ref, terminal: to });
    if (path === a.overall) return move(b.overall);
    if (path === a.drain) return move(b.drain);
    const cc = conductorColour.get(path);
    if (cc !== undefined) {
      const moved = move(b.conductor.get(cc));
      if (moved === undefined) lost.push(`the ${cc} conductor (${path}@${ref.end}) — ${to.label} has no ${cc} core`);
      return moved;
    }
    const sc = shieldColour.get(path);
    if (sc !== undefined) {
      const moved = move(b.shield.get(sc));
      // a shield onto a stock whose core is plain: the ground still has the other shields
      return moved;
    }
    lost.push(`${path}@${ref.end} — no counterpart on ${to.label}`);
    return undefined;
  };

  const joints: Joint[] = [];
  for (const joint of opened.joints) {
    const ja = translate(joint.a);
    const jb = translate(joint.b);
    if (ja === undefined || jb === undefined) continue;
    const note = joint.note?.replace(/,? ?(and )?twisted together with the drain/i, '').replace(/drain terminated at the source end only/i, '').trim();
    joints.push({ a: ja, b: jb, ...(note === undefined || note === '' ? {} : { note }) });
  }

  // cores that gain a shield: land it with the other shields at each end
  const groundAt = (end: 'a' | 'b'): TerminalRef | undefined => {
    for (const joint of joints) {
      for (const [near, far] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (near.instance !== trunk.id || near.end !== end) continue;
        if (b.shield.has(shieldColourOfPath(b, near.terminal) ?? '') || near.terminal === b.overall) return far;
      }
    }
    return undefined;
  };
  for (const [colour, shieldPath] of b.shield) {
    if (a.shield.has(colour)) continue;
    const conductor = b.conductor.get(colour);
    for (const end of ['a', 'b'] as const) {
      const landed = joints.some((j) => [j.a, j.b].some((r) => r.instance === trunk.id && r.end === end && r.terminal === conductor));
      if (!landed) continue;
      const ground = groundAt(end);
      if (ground !== undefined) joints.push({ a: { instance: trunk.id, terminal: shieldPath, end }, b: ground, note: `${colour} core's own shield, onto the same ground as the others` });
    }
  }
  // a drain the new stock gains: with the overall shield, source end only
  if (b.drain !== undefined && a.drain === undefined) {
    const overall = joints.find((j) => [j.a, j.b].some((r) => r.instance === trunk.id && r.end === 'a' && r.terminal === b.overall));
    const ground = overall === undefined ? undefined : overall.a.instance === trunk.id ? overall.b : overall.a;
    if (ground !== undefined) joints.push({ a: { instance: trunk.id, terminal: b.drain, end: 'a' }, b: ground, note: 'drain terminated at the source end only' });
  }
  next.joints = joints;

  // notes that name trunk terminals (a stripped end lists every conductor it
  // leaves open) are rewritten to the new stock's paths; a conductor that
  // gains its own shield brings that shield into the same list
  const renamePaths = (note: string): string =>
    note.replace(new RegExp(`${trunk.id}:([A-Za-z0-9_.-]+)@([ab])`, 'g'), (whole, path: string, end: string) => {
      const colour = conductorColour.get(path);
      if (colour === undefined) return whole;
      const moved = b.conductor.get(colour);
      if (moved === undefined) return whole;
      const shield = !a.shield.has(colour) ? b.shield.get(colour) : undefined;
      return `${trunk.id}:${moved}@${end}${shield === undefined ? '' : `, ${trunk.id}:${shield}@${end}`}`;
    });
  // notes: the drain policy only means something on a stock with a drain
  const notes = (design.notes ?? [])
    .filter((note) => b.drain !== undefined || !/\bdrain\b/i.test(note) || /honest gap/i.test(note))
    .map(renamePaths);
  const added = [...b.conductor.keys()].filter((c) => !a.conductor.has(c));
  notes.push(
    `Trunk stock: ${to.label} (was ${from.label}). Wiring carried across by conductor colour${
      b.drain === undefined ? '; this stock has no drain wire — the core shields and the overall foil are the ground' : ''
    }${added.length > 0 ? `; ${added.join(', ')} ${added.length === 1 ? 'is a spare core' : 'are spare cores'}, unconnected at both ends` : ''}.`,
  );
  next.notes = notes;
  next.src = `${design.src} — trunk moved from ${from.id} to ${to.id} by conductor colour (withTrunkStock).`;
  // twist the grounds up again, the way the new stock is built
  const bonded = migrateShieldBonds(next, db);
  return { design: bonded.report.ok ? bonded.design : next, lost };
}

/**
 * The design with segment `segmentId`'s pigtails replaced by one joint per
 * member screen onto the pigtail's landing. `firstMassOnly`: a mass pigtail
 * going onto a stock that is not one mass — all its screens go to the first
 * mass landing at that end, and any further landing is reported in `lost`.
 */
function openPigtails(
  design: CableDesign,
  segmentId: string,
  wire: WireDefinition,
  firstMassOnly: boolean,
  lost: string[],
): CableDesign {
  const segment = design.instances.segments.find((s) => s.id === segmentId);
  if (segment?.pigtails === undefined || segment.pigtails.length === 0) return design;
  const next = structuredClone(design);
  const seenMass = new Set<string>();
  const joints: Joint[] = [];
  for (const joint of design.joints) {
    const side = [joint.a, joint.b].find(
      (ref) => pigtailOfTerminal(design, ref.instance, ref.terminal, ref.end) !== undefined && ref.instance === segmentId,
    );
    if (side === undefined || side.end === undefined) {
      joints.push(joint);
      continue;
    }
    const pigtail = pigtailOfTerminal(design, side.instance, side.terminal, side.end);
    if (pigtail === undefined) continue;
    const other = side === joint.a ? joint.b : joint.a;
    const { pad: _pad, ...landing } = other;
    if (pigtail.members === undefined && firstMassOnly) {
      if (seenMass.has(side.end)) {
        lost.push(
          `the shield mass's extra ground connection at end ${side.end} (pigtail ${pigtail.id} → ${other.instance} ${other.terminal}) — every screen now lands on the first one; review the grounds`,
        );
        continue;
      }
      seenMass.add(side.end);
    }
    const note = pigtail.note ?? joint.note;
    for (const path of pigtailMembers(wire, pigtail)) {
      joints.push({
        a: { instance: segmentId, terminal: path, end: side.end },
        b: landing,
        ...(note === undefined ? {} : { note }),
      });
    }
  }
  next.joints = joints;
  next.instances.segments = next.instances.segments.map((s) => {
    if (s.id !== segmentId) return s;
    const { pigtails: _pigtails, ...rest } = s;
    return rest;
  });
  return next;
}

function shieldColourOfPath(map: CoreMap, path: string): string | undefined {
  for (const [colour, p] of map.shield) if (p === path) return colour;
  return undefined;
}

/** Whether "copy on another stock" means anything for this design and `wireId`. */
export function canSwapTrunkStock(design: CableDesign, db: Db, wireId: string): boolean {
  const trunk = trunkSegment(design, db);
  return trunk !== undefined && trunk.def !== wireId && findWire(db, wireId) !== undefined;
}

/** The stocks "Make variant" offers: every other stock in the catalog `canSwapTrunkStock` accepts, in catalog order. */
export function swappableStocks(design: CableDesign, db: Db): WireDefinition[] {
  return db.wires.filter((w) => canSwapTrunkStock(design, db, w.id));
}

/** One conductor colour of the trunk and where it lands on the new stock. */
export interface TrunkMove {
  colour: string;
  from: string;
  /** the new stock's path for that colour; `undefined`: the new stock has no such core */
  to?: string;
}

/**
 * What moving the trunk to `wireId` would do, without doing it: the swapped design, what could
 * not carry across, and the conductor colours with their old and new paths — the preview the
 * Make-variant dialog shows before anything is created.
 */
export function previewTrunkStock(design: CableDesign, db: Db, wireId: string): StockSwapResult & { moves: TrunkMove[]; spare: string[] } {
  const result = withTrunkStock(design, db, wireId);
  const trunk = trunkSegment(design, db);
  const from = trunk === undefined ? undefined : findWire(db, trunk.def);
  const to = findWire(db, wireId);
  if (from === undefined || to === undefined) return { ...result, moves: [], spare: [] };
  const a = mapOf(from);
  const b = mapOf(to);
  const moves: TrunkMove[] = [...a.conductor].map(([colour, path]) => {
    const target = b.conductor.get(colour);
    return { colour, from: path, ...(target === undefined ? {} : { to: target }) };
  });
  return { ...result, moves, spare: [...b.conductor.keys()].filter((c) => !a.conductor.has(c)) };
}
