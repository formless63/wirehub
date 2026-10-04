/**
 * Pigtail editing — the Connection tab's New / Split / Merge / Move / pad
 * actions (specs/shield-bonding.md §2.5).
 *
 * Pure: design in, design out, or a sentence saying why not. The store runs
 * the result through `commit`, so the validator still has the last word; these
 * functions only keep the edit physically coherent — a screen twisted into a
 * pigtail loses its own joint at that end, a pigtail left with no members is
 * unsoldered with its landing, a merge only joins twists on one terminal.
 */

import {
  findWire,
  isScreenPath,
  isFullyBonded,
  pigtailTerminal,
  terminalKey,
  type CableDesign,
  type Db,
  type Joint,
  type Pigtail,
  type SegmentInstance,
  type TerminalRef,
} from '@wirehub/model';

export type PigtailEdit =
  /** twist `members` (omitted: the whole mass of a bonded stock) and land them on `landing` */
  | { op: 'new'; segment: string; end: 'a' | 'b'; members?: string[]; landing: TerminalRef; pad?: string }
  /** move `members` out of pigtail `id` into a new pigtail on the same landing */
  | { op: 'split'; segment: string; end: 'a' | 'b'; id: string; members: string[] }
  /** fold pigtail `from` into pigtail `into` (both on one terminal) */
  | { op: 'merge'; segment: string; end: 'a' | 'b'; from: string; into: string }
  /** move one screen from pigtail `from` to pigtail `to` */
  | { op: 'move'; segment: string; end: 'a' | 'b'; member: string; from: string; to: string }
  /** name the pad (or none) the pigtail's landing goes to */
  | { op: 'pad'; segment: string; end: 'a' | 'b'; id: string; pad?: string }
  /**
   * take `members` out of pigtail `id` — unsoldering braids one by one on the
   * canvas; a pigtail left empty goes with its landing
   */
  | { op: 'drop'; segment: string; end: 'a' | 'b'; id: string; members: string[] };

export type PigtailEditResult = { ok: true; design: CableDesign; description: string } | { ok: false; reason: string };

function kebab(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isLandingOf(ref: TerminalRef, segment: string, id: string, end: 'a' | 'b'): boolean {
  return ref.instance === segment && ref.end === end && ref.terminal === pigtailTerminal(id);
}

/** The joint landing a pigtail, and which side of it the pigtail is on. */
export function pigtailLanding(
  design: CableDesign,
  segment: string,
  id: string,
  end: 'a' | 'b',
): { index: number; landing: TerminalRef } | undefined {
  const index = design.joints.findIndex(
    (joint) => isLandingOf(joint.a, segment, id, end) || isLandingOf(joint.b, segment, id, end),
  );
  const joint = design.joints[index];
  if (joint === undefined) return undefined;
  return { index, landing: isLandingOf(joint.a, segment, id, end) ? joint.b : joint.a };
}

/** A pigtail id free at this end: `base`, else `base-2`, … */
export function freePigtailId(segment: SegmentInstance, end: 'a' | 'b', base: string): string {
  const used = new Set((segment.pigtails ?? []).filter((p) => p.end === end).map((p) => p.id));
  const root = kebab(base) || 'gnd';
  let id = root;
  for (let n = 2; used.has(id); n += 1) id = `${root}-${n}`;
  return id;
}

function withSegment(design: CableDesign, id: string, change: (segment: SegmentInstance) => SegmentInstance): CableDesign {
  return {
    ...design,
    instances: {
      ...design.instances,
      segments: design.instances.segments.map((segment) => (segment.id === id ? change(segment) : segment)),
    },
  };
}

function setPigtails(segment: SegmentInstance, pigtails: Pigtail[]): SegmentInstance {
  const { pigtails: _old, ...rest } = segment;
  return pigtails.length === 0 ? rest : { ...rest, pigtails };
}

export function editPigtails(design: CableDesign, db: Db, edit: PigtailEdit): PigtailEditResult {
  const segment = design.instances.segments.find((s) => s.id === edit.segment);
  if (segment === undefined) return { ok: false, reason: `no segment '${edit.segment}'` };
  const wire = findWire(db, segment.def);
  if (wire === undefined) return { ok: false, reason: `segment '${segment.id}' has no known stock` };
  const pigtails = [...(segment.pigtails ?? [])];
  const find = (id: string): Pigtail | undefined => pigtails.find((p) => p.id === id && p.end === edit.end);
  const where = `${segment.id} @${edit.end}`;

  switch (edit.op) {
    case 'new': {
      const mass = edit.members === undefined;
      if (mass && !isFullyBonded(wire)) return { ok: false, reason: `${wire.label} is not one shield mass — pick the screens to twist` };
      if (!mass && (edit.members ?? []).length === 0) return { ok: false, reason: 'pick at least one screen to twist' };
      // named after its landing, as the migration names them: `gnd`, `j4-13`
      const onBoard = design.instances.pcbas.some((p) => p.id === edit.landing.instance);
      const id = freePigtailId(
        segment,
        edit.end,
        onBoard ? edit.landing.terminal : `${edit.landing.instance}-${edit.landing.terminal}`,
      );
      const pigtail: Pigtail = { id, end: edit.end, ...(mass ? {} : { members: [...(edit.members ?? [])] }) };
      // the screens it twists stop being jointed on their own at this end,
      // and leave any other pigtail they were in; one emptied by that goes
      const twisted = new Set(edit.members ?? []);
      const thinned = pigtails.map((p) =>
        p.end !== edit.end || p.members === undefined ? p : { ...p, members: p.members.filter((m) => !twisted.has(m)) },
      );
      const nextPigtails = thinned.filter((p) => p.members === undefined || p.members.length > 0);
      const dropped = thinned.filter((p) => p.members !== undefined && p.members.length === 0);
      const joints: Joint[] = design.joints.filter((joint) => {
        for (const ref of [joint.a, joint.b]) {
          if (ref.instance === segment.id && ref.end === edit.end && twisted.has(ref.terminal)) return false;
          if (dropped.some((p) => isLandingOf(ref, segment.id, p.id, p.end))) return false;
        }
        return true;
      });
      const land: TerminalRef = { ...edit.landing, ...(edit.pad === undefined ? {} : { pad: edit.pad }) };
      joints.push({ a: { instance: segment.id, terminal: pigtailTerminal(id), end: edit.end }, b: land });
      const next = withSegment({ ...design, joints }, segment.id, (s) => setPigtails(s, [...nextPigtails, pigtail]));
      return { ok: true, design: next, description: `new pigtail ${id} at ${where} → ${terminalKey(edit.landing)}` };
    }
    case 'split': {
      const from = find(edit.id);
      if (from?.members === undefined) return { ok: false, reason: `pigtail '${edit.id}' has no member list to split` };
      const moving = from.members.filter((m) => edit.members.includes(m));
      if (moving.length === 0) return { ok: false, reason: 'tick the screens to split off' };
      if (moving.length === from.members.length) return { ok: false, reason: 'leave at least one screen behind — that is a move, not a split' };
      const landed = pigtailLanding(design, segment.id, from.id, edit.end);
      if (landed === undefined) return { ok: false, reason: `pigtail '${edit.id}' has no landing to split onto` };
      const id = freePigtailId(segment, edit.end, `${from.id}-split`);
      const nextPigtails = pigtails.map((p) => (p === from ? { ...p, members: from.members!.filter((m) => !moving.includes(m)) } : p));
      nextPigtails.push({ id, end: edit.end, members: moving });
      const { pad: _pad, ...landing } = landed.landing;
      const joints = [...design.joints, { a: { instance: segment.id, terminal: pigtailTerminal(id), end: edit.end }, b: landing }];
      const next = withSegment({ ...design, joints }, segment.id, (s) => setPigtails(s, nextPigtails));
      return { ok: true, design: next, description: `split ${moving.length} screen(s) off pigtail ${from.id} at ${where}` };
    }
    case 'merge': {
      const from = find(edit.from);
      const into = find(edit.into);
      if (from === undefined || into === undefined || from === into) return { ok: false, reason: 'pick two pigtails to merge' };
      const a = pigtailLanding(design, segment.id, from.id, edit.end);
      const b = pigtailLanding(design, segment.id, into.id, edit.end);
      if (a === undefined || b === undefined || terminalKey(a.landing) !== terminalKey(b.landing)) {
        return { ok: false, reason: 'only pigtails landing on one terminal merge' };
      }
      const members =
        from.members === undefined || into.members === undefined ? undefined : [...into.members, ...from.members];
      const nextPigtails = pigtails
        .filter((p) => p !== from)
        .map((p) => {
          if (p !== into) return p;
          const { members: _m, ...rest } = p;
          return members === undefined ? rest : { ...rest, members };
        });
      const joints = design.joints.filter((_, index) => index !== a.index);
      const next = withSegment({ ...design, joints }, segment.id, (s) => setPigtails(s, nextPigtails));
      return { ok: true, design: next, description: `merge pigtail ${from.id} into ${into.id} at ${where}` };
    }
    case 'move': {
      const from = find(edit.from);
      const to = find(edit.to);
      if (from?.members === undefined || to?.members === undefined || from === to) return { ok: false, reason: 'pick the pigtail to move it to' };
      if (!from.members.includes(edit.member)) return { ok: false, reason: `'${edit.member}' is not in pigtail ${from.id}` };
      let nextPigtails = pigtails.map((p) => {
        if (p === from) return { ...p, members: from.members!.filter((m) => m !== edit.member) };
        if (p === to) return { ...p, members: [...to.members!, edit.member] };
        return p;
      });
      let joints = design.joints;
      // a pigtail emptied by the move is unsoldered with its landing
      const emptied = nextPigtails.find((p) => p.end === edit.end && p.id === from.id && p.members?.length === 0);
      if (emptied !== undefined) {
        nextPigtails = nextPigtails.filter((p) => p !== emptied);
        joints = joints.filter((joint) => !isLandingOf(joint.a, segment.id, from.id, edit.end) && !isLandingOf(joint.b, segment.id, from.id, edit.end));
      }
      const next = withSegment({ ...design, joints }, segment.id, (s) => setPigtails(s, nextPigtails));
      return { ok: true, design: next, description: `move ${edit.member} from pigtail ${from.id} to ${to.id} at ${where}` };
    }
    case 'pad': {
      const landed = pigtailLanding(design, segment.id, edit.id, edit.end);
      if (landed === undefined) return { ok: false, reason: `pigtail '${edit.id}' has no landing` };
      const joints = design.joints.map((joint, index) => {
        if (index !== landed.index) return joint;
        const side = isLandingOf(joint.a, segment.id, edit.id, edit.end) ? 'b' : 'a';
        const { pad: _pad, ...ref } = joint[side];
        const nextRef = edit.pad === undefined || edit.pad === '' ? ref : { ...ref, pad: edit.pad };
        return side === 'a' ? { ...joint, a: nextRef } : { ...joint, b: nextRef };
      });
      return { ok: true, design: { ...design, joints }, description: `pigtail ${edit.id} at ${where} → pad ${edit.pad ?? 'unset'}` };
    }
    case 'drop': {
      const from = find(edit.id);
      if (from?.members === undefined) return { ok: false, reason: `pigtail '${edit.id}' has no member list to take braids out of` };
      const leaving = new Set(edit.members.filter((m) => from.members!.includes(m)));
      if (leaving.size === 0) return { ok: false, reason: `none of ${edit.members.join(', ')} is in pigtail ${from.id}` };
      const left = from.members.filter((m) => !leaving.has(m));
      const nextPigtails = left.length === 0 ? pigtails.filter((p) => p !== from) : pigtails.map((p) => (p === from ? { ...p, members: left } : p));
      const joints =
        left.length === 0
          ? design.joints.filter((joint) => !isLandingOf(joint.a, segment.id, from.id, edit.end) && !isLandingOf(joint.b, segment.id, from.id, edit.end))
          : design.joints;
      const next = withSegment({ ...design, joints }, segment.id, (s) => setPigtails(s, nextPigtails));
      return {
        ok: true,
        design: next,
        description: left.length === 0 ? `unsolder pigtail ${from.id} at ${where}` : `unsolder ${[...leaving].join(', ')} from pigtail ${from.id} at ${where}`,
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * A joint drawn by hand onto a braid or a pigtail
 * ------------------------------------------------------------------ */

function samePlace(x: TerminalRef, y: TerminalRef): boolean {
  return terminalKey(x) === terminalKey(y) && (x.pad === undefined || y.pad === undefined || x.pad === y.pad);
}

/** The side of a joint that is a screen of `segment` at `end`, and the other. */
function screenJointAt(joint: Joint, segment: string, end: 'a' | 'b'): { screen: string; other: TerminalRef } | undefined {
  for (const [mine, other] of [
    [joint.a, joint.b],
    [joint.b, joint.a],
  ] as const) {
    if (mine.instance === segment && mine.end === end && !mine.terminal.startsWith('pigtail:')) return { screen: mine.terminal, other };
  }
  return undefined;
}

/**
 * A joint drawn by hand (dragging a braid onto a pad on the canvas, the
 * Connection tab's add row) that touches a screen already twisted into a
 * pigtail, or a pigtail that already lands, is read as what the person means
 * — one physically coherent edit, applied whole, so no intermediate state
 * trips the validator (: the owner "was getting validation
 * errors" doing exactly this):
 *
 * - a braid dragged onto the pad another pigtail at its end lands on moves
 *   into that pigtail;
 * - a braid dragged onto any other pad leaves its pigtail (an emptied one
 *   goes with its landing) and lands there — twisted into a new pigtail with
 *   a braid of the same end already landed alone on that pad, else on its own;
 * - a braid of a bonded mass (bonded multi-core) dragged onto a pad adds a ground
 *   connection from the mass there;
 * - a pigtail dragged onto another pad of the terminal it lands on moves its
 *   landing to that pad.
 *
 * `undefined` when the joint is none of these: add it as it is.
 */
export function connectTerminals(
  design: CableDesign,
  db: Db,
  a: TerminalRef,
  b: TerminalRef,
): PigtailEditResult | undefined {
  for (const [mine, other] of [
    [a, b],
    [b, a],
  ] as const) {
    if (mine.end === undefined || other.instance === mine.instance) continue;
    const segment = design.instances.segments.find((s) => s.id === mine.instance);
    if (segment === undefined) continue;
    if (design.instances.segments.some((s) => s.id === other.instance)) continue;
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const end = mine.end;
    const pigtails = (segment.pigtails ?? []).filter((p) => p.end === end);
    const landingOf = (id: string): TerminalRef | undefined => pigtailLanding(design, segment.id, id, end)?.landing;

    // a pigtail onto another pad of the terminal it lands on: move the landing
    const own = pigtails.find((p) => mine.terminal === pigtailTerminal(p.id));
    if (own !== undefined) {
      const landing = landingOf(own.id);
      if (landing === undefined || terminalKey(landing) !== terminalKey(other)) return undefined;
      if (other.pad === undefined || other.pad === landing.pad) {
        return { ok: false, reason: `pigtail ${own.id} already lands on ${terminalKey(other)}${landing.pad === undefined ? '' : ` (pad ${landing.pad})`}` };
      }
      return editPigtails(design, db, { op: 'pad', segment: segment.id, end, id: own.id, pad: other.pad });
    }

    // a screen of this end
    const screen = mine.terminal;
    if (!isScreen(wire, screen)) continue;
    const mass = isFullyBonded(wire);
    const landsHere = (p: Pigtail): boolean => {
      const landing = landingOf(p.id);
      return landing !== undefined && samePlace(landing, other);
    };
    if (mass) {
      // any screen of a bonded mass stands for the whole mass: another ground
      // connection from it, unless one lands there already
      const there = pigtails.find(landsHere);
      if (there !== undefined) return { ok: false, reason: `the shield mass already lands on ${terminalKey(other)} (pigtail ${there.id})` };
      const { pad, ...bare } = other;
      return editPigtails(design, db, { op: 'new', segment: segment.id, end, landing: bare, ...(pad === undefined ? {} : { pad }) });
    }
    const current = pigtails.find((p) => p.members?.includes(screen) === true);
    if (current === undefined) {
      // a loose braid: into the pigtail that lands on that pad, if any…
      const into = pigtails.find((p) => p.members !== undefined && landsHere(p));
      if (into !== undefined) {
        const withMember = withSegment(design, segment.id, (s) =>
          setPigtails(s, (s.pigtails ?? []).map((p) => (p === into ? { ...p, members: [...(p.members ?? []), screen] } : p))),
        );
        // its own joint at this end, if it had one, gives way to the twist
        const joints = withMember.joints.filter((joint) => screenJointAt(joint, segment.id, end)?.screen !== screen);
        return { ok: true, design: { ...withMember, joints }, description: `twist ${screen} into pigtail ${into.id} at ${segment.id} @${end}` };
      }
      // …else twisted with a braid of this end already alone on that pad
      const alone = design.joints.findIndex((joint) => {
        const hit = screenJointAt(joint, segment.id, end);
        return hit !== undefined && hit.screen !== screen && isScreen(wire, hit.screen) && samePlace(hit.other, other);
      });
      if (alone === -1) return undefined;
      const hit = screenJointAt(design.joints[alone] as Joint, segment.id, end) as { screen: string; other: TerminalRef };
      const landing: TerminalRef = other.pad === undefined && hit.other.pad !== undefined ? { ...other, pad: hit.other.pad } : other;
      const { pad, ...bare } = landing;
      return editPigtails(design, db, {
        op: 'new',
        segment: segment.id,
        end,
        members: [hit.screen, screen],
        landing: bare,
        ...(pad === undefined ? {} : { pad }),
      });
    }
    const target = pigtails.find((p) => {
      const landing = landingOf(p.id);
      return p.members !== undefined && landing !== undefined && samePlace(landing, other);
    });
    if (target === current) {
      return { ok: false, reason: `${screen} is already twisted into pigtail ${current.id}, which lands on ${terminalKey(other)}` };
    }
    if (target !== undefined) {
      return editPigtails(design, db, { op: 'move', segment: segment.id, end, member: screen, from: current.id, to: target.id });
    }
    // out of its twist, onto the new pad — with a braid already alone there, or on its own
    const dropped = editPigtails(design, db, { op: 'drop', segment: segment.id, end, id: current.id, members: [screen] });
    if (!dropped.ok) return dropped;
    const again = connectTerminals(dropped.design, db, mine, other);
    if (again !== undefined) {
      return again.ok ? { ...again, description: `move ${screen} out of pigtail ${current.id}; ${again.description}` } : again;
    }
    return {
      ok: true,
      design: { ...dropped.design, joints: [...dropped.design.joints, { a: mine, b: other }] },
      description: `move ${screen} out of pigtail ${current.id} onto ${terminalKey(other)}${other.pad === undefined ? '' : ` pad ${other.pad}`}`,
    };
  }
  return undefined;
}

function isScreen(wire: NonNullable<ReturnType<typeof findWire>>, path: string): boolean {
  return isScreenPath(wire, path);
}
