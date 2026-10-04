/**
 * Entry guides for angled pad rows — pure geometry
 * shared by the canvas (`editor-react/src/board-art.ts`), the schematic
 * (`board-faces.ts` → render-svg) and the Library guide editor.
 *
 * A board whose cable pads sit on a chamfered edge (the SCART family,
 * PCA-00113xx) cannot be wired with the usual "run in horizontally" lead — it
 * crosses the neighbouring pads. Instead a person sets, once per board face,
 * a line just outside the board edge (`EntryGuide`, stored in the reviewed
 * kicad-map and copied into `meta.json`). Every wire to a guided pad reaches
 * its **slot** on that line — slots in the guide's pad order — off the board,
 * then runs straight in to its pad. That last straight lead is the only
 * stretch drawn over the board.
 *
 * Everything here is in the depiction's anchor frame (`board-top`, mm, +y
 * down); a bottom-face guide is still in that frame, and callers reflect and
 * turn the results exactly as they reflect and turn the pads.
 */

import { boardOutlineFromSvg, outlineExit, type DepictionMeta, type EntryGuide } from '@cable-studio/catalog';

export interface GuideXY {
  x: number;
  y: number;
}

/** One physical copper pad, anchor frame. */
export interface CopperPad {
  terminal: string;
  ref?: string;
  x: number;
  y: number;
  side: 'top' | 'bottom' | 'both';
  /** pad long axis, degrees (absent: axis-aligned) */
  approach?: number;
  /** [along approach, across] mm */
  size: readonly [number, number];
}

/** A pad without a recorded size is drawn as this square (mm) — a THT/SMD pad of the usual size. */
const DEFAULT_PAD_MM = 1.7;
/** Clear air a lead keeps from another pad's copper (mm). */
export const LEAD_CLEARANCE_MM = 0.15;
/** Slots never closer than this along the guide (mm). */
export const SLOT_GAP_MM = 0.8;
/** How far outside the outline the default guide sits (mm). */
export const DEFAULT_GUIDE_OFFSET_MM = 1.5;
/** How far beyond the row's end pads the default guide runs (mm). */
const DEFAULT_GUIDE_OVERHANG_MM = 1.5;

const R = (value: number): number => Math.round(value * 100) / 100;

function unit(deg: number): GuideXY {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

const dot = (a: GuideXY, b: GuideXY): number => a.x * b.x + a.y * b.y;

function visibleFrom(side: CopperPad['side'], face: 'top' | 'bottom'): boolean {
  return side === face || side === 'both';
}

/** Every anchored pad copper visible from `face`, anchor frame. */
export function copperPads(meta: DepictionMeta, face: 'top' | 'bottom'): CopperPad[] {
  const out: CopperPad[] = [];
  for (const terminal of Object.keys(meta.pinAnchors).sort()) {
    const anchor = meta.pinAnchors[terminal];
    if (anchor === undefined) continue;
    const pads =
      anchor.pads !== undefined && anchor.pads.length > 0
        ? anchor.pads
        : [{ ...anchor, side: anchor.side ?? ('top' as const), ref: undefined }];
    for (const pad of pads) {
      if (!visibleFrom(pad.side, face)) continue;
      out.push({
        terminal,
        ...(pad.ref === undefined ? {} : { ref: pad.ref }),
        x: pad.x,
        y: pad.y,
        side: pad.side,
        ...(pad.approach === undefined ? {} : { approach: pad.approach }),
        size: pad.size ?? [DEFAULT_PAD_MM, DEFAULT_PAD_MM],
      });
    }
  }
  return out;
}

/** `copperPads` over a terminal → pads record (the schematic's `BoardFacesSource.pads`). */
export function copperFromPads(
  pads: Readonly<Record<string, readonly { x: number; y: number; side?: CopperPad['side']; ref?: string; approach?: number; size?: readonly [number, number] }[]>>,
  face: 'top' | 'bottom',
): CopperPad[] {
  const out: CopperPad[] = [];
  for (const terminal of Object.keys(pads).sort()) {
    for (const pad of pads[terminal] ?? []) {
      if (!visibleFrom(pad.side ?? 'top', face)) continue;
      out.push({
        terminal,
        ...(pad.ref === undefined ? {} : { ref: pad.ref }),
        x: pad.x,
        y: pad.y,
        side: pad.side ?? 'top',
        ...(pad.approach === undefined ? {} : { approach: pad.approach }),
        size: pad.size ?? [DEFAULT_PAD_MM, DEFAULT_PAD_MM],
      });
    }
  }
  return out;
}

/** A pad's copper as a rectangle (corners, anchor frame), grown by `grow` on every side. */
export function padPolygon(pad: CopperPad, grow = 0): GuideXY[] {
  const a = unit(pad.approach ?? 0);
  const n = { x: -a.y, y: a.x };
  const h = pad.size[0] / 2 + grow;
  const w = pad.size[1] / 2 + grow;
  return [
    { x: pad.x + a.x * h + n.x * w, y: pad.y + a.y * h + n.y * w },
    { x: pad.x - a.x * h + n.x * w, y: pad.y - a.y * h + n.y * w },
    { x: pad.x - a.x * h - n.x * w, y: pad.y - a.y * h - n.y * w },
    { x: pad.x + a.x * h - n.x * w, y: pad.y + a.y * h - n.y * w },
  ];
}

function cross(o: GuideXY, a: GuideXY, b: GuideXY): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Do segments p1p2 and q1q2 properly cross or touch? */
export function segmentsIntersect(p1: GuideXY, p2: GuideXY, q1: GuideXY, q2: GuideXY): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (o: GuideXY, a: GuideXY, b: GuideXY, d: number): boolean =>
    Math.abs(d) < 1e-9 &&
    Math.min(o.x, a.x) - 1e-9 <= b.x &&
    b.x <= Math.max(o.x, a.x) + 1e-9 &&
    Math.min(o.y, a.y) - 1e-9 <= b.y &&
    b.y <= Math.max(o.y, a.y) + 1e-9;
  return on(q1, q2, p1, d1) || on(q1, q2, p2, d2) || on(p1, p2, q1, d3) || on(p1, p2, q2, d4);
}

function insidePolygon(point: GuideXY, polygon: readonly GuideXY[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Does the segment touch the (convex or not) polygon — cross an edge, or lie inside it? */
export function segmentHitsPolygon(a: GuideXY, b: GuideXY, polygon: readonly GuideXY[]): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    if (segmentsIntersect(a, b, polygon[j]!, polygon[i]!)) return true;
  }
  return insidePolygon(a, polygon) || insidePolygon(b, polygon);
}

/** One guided pad's slot. */
export interface GuideSlot {
  ref: string;
  terminal: string;
  /** the pad centre, anchor frame */
  pad: GuideXY;
  /** where its wire meets the guide, anchor frame */
  slot: GuideXY;
  /** distance of the slot along the guide from `from`, mm */
  t: number;
  /** the lead runs square to the guide (along the pad's approach axis) */
  straight: boolean;
  /** the lead clears every other pad's copper */
  clear: boolean;
}

/** The guide as a unit direction, its length, and the side of it away from the board. */
export function guideFrame(guide: Pick<EntryGuide, 'from' | 'to'>): { from: GuideXY; e: GuideXY; length: number } {
  const from = { x: guide.from[0], y: guide.from[1] };
  const dx = guide.to[0] - guide.from[0];
  const dy = guide.to[1] - guide.from[1];
  const length = Math.hypot(dx, dy);
  return { from, e: length === 0 ? { x: 1, y: 0 } : { x: dx / length, y: dy / length }, length };
}

/**
 * The slot of every pad a guide serves, in the guide's pad order. A pad's
 * slot is where its perpendicular meets the guide (the guide is square to the
 * row's approach axis, so that *is* the approach axis); a pad set back behind
 * its neighbours whose perpendicular would run over their copper is aimed
 * through the nearest clear gap instead. Slots keep the listed order and at
 * least `SLOT_GAP_MM` apart, and stay on the drawn segment.
 */
export function guideSlots(meta: DepictionMeta, guide: EntryGuide): GuideSlot[] {
  const copper = copperPads(meta, guide.side);
  const { from, e, length } = guideFrame(guide);
  const at = (t: number): GuideXY => ({ x: from.x + e.x * t, y: from.y + e.y * t });
  const out: GuideSlot[] = [];
  let floor = -Infinity;
  const listed = guide.pads.flatMap((ref) => {
    const pad = copper.find((candidate) => candidate.ref === ref);
    return pad === undefined ? [] : [{ ref, pad }];
  });
  listed.forEach(({ ref, pad }, index) => {
    const next = listed[index + 1]?.pad;
    const ceiling = Math.min(
      length,
      next === undefined ? Infinity : dot({ x: next.x - from.x, y: next.y - from.y }, e) - SLOT_GAP_MM,
    );
    const obstacles = copper.filter((other) => other !== pad && other.ref !== ref).map((other) => padPolygon(other, LEAD_CLEARANCE_MM));
    const centre = { x: pad.x, y: pad.y };
    const clearAt = (t: number): boolean => {
      const slot = at(t);
      return obstacles.every((polygon) => !segmentHitsPolygon(centre, slot, polygon));
    };
    const natural = dot({ x: pad.x - from.x, y: pad.y - from.y }, e);
    const lo = Math.max(0, floor + SLOT_GAP_MM);
    const start = Math.min(length, Math.max(natural, lo));
    let t = start;
    let clear = clearAt(start);
    if (!clear) {
      // the nearest clear aim either way, never out of order or off the line…
      const step = 0.05;
      for (let d = step; d <= length; d += step) {
        const up = start + d;
        const down = start - d;
        if (down >= lo && clearAt(down)) {
          t = down;
          clear = true;
          break;
        }
        if (up <= length && clearAt(up)) {
          t = up;
          clear = true;
          break;
        }
      }
      // …then the middle of that gap, so the lead runs centred between the
      // neighbours it threads (held short of the next pad's own slot)
      if (clear) {
        let a = t;
        let b = t;
        while (a - step >= lo && clearAt(a - step)) a -= step;
        while (b + step <= Math.max(ceiling, t) && clearAt(b + step)) b += step;
        t = (a + b) / 2;
      }
    }
    floor = t;
    out.push({
      ref,
      terminal: pad.terminal,
      pad: centre,
      slot: at(t),
      t,
      straight: Math.abs(t - natural) < 1e-6,
      clear,
    });
  });
  return out;
}

/** The guided slot of pad `ref` on `face`, when a guide serves it. */
export function slotOfPad(
  meta: DepictionMeta,
  face: 'top' | 'bottom',
  ref: string | undefined,
): GuideSlot | undefined {
  if (ref === undefined) return undefined;
  for (const guide of meta.entryGuides ?? []) {
    if (guide.side !== face || !guide.pads.includes(ref)) continue;
    return guideSlots(meta, guide).find((slot) => slot.ref === ref);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The board outline, and the default guide
 * ------------------------------------------------------------------ */

/**
 * The board's Edge.Cuts outline from a gerber-tier `board-top.svg` — the
 * catalog's (`depictions/outline.ts`), which the gerber pipeline also reads
 * to point every pad's `approach` off the board.
 */
export { boardOutlineFromSvg, outlineExit };

/* ------------------------------------------------------------------ *
 * Exit slots: unguided pads that cannot run straight in (e5c.29)
 * ------------------------------------------------------------------ */

/** How far past the board outline an exit slot sits (mm). */
export const EXIT_CLEARANCE_MM = 0.5;
/** An approach this close to the wire's own direction runs straight in, as it always has (degrees). */
const STRAIGHT_IN_DEG = 20;

function angleBetween(a: GuideXY, b: GuideXY): number {
  const cos = Math.max(-1, Math.min(1, dot(a, b) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))));
  return (Math.acos(cos) * 180) / Math.PI;
}

function hitsOutline(a: GuideXY, b: GuideXY, outline: readonly GuideXY[]): boolean {
  for (let i = 0; i < outline.length; i += 1) {
    if (segmentsIntersect(a, b, outline[i]!, outline[(i + 1) % outline.length]!)) return true;
  }
  return false;
}

/**
 * Where the wire to an unguided cable pad leaves the board, when it cannot
 * simply run straight in toward the wire — the entry
 * guide's slot (e5c.28) without a guide: the router reaches the slot level
 * from the wire's side, then runs straight in to the pad. Anchor frame, like
 * everything here; `wire` is the direction (anchor frame, unit) the wire lies
 * in from this face, i.e. the face's turned "toward the wire" undone.
 *
 *  - A pad with its own axis (`approach`, pointed off the board) whose axis
 *    already runs toward the wire (within 20°) needs nothing: straight in, as
 *    ever. Otherwise its wire leaves off the end of the pad along the axis,
 *    to `EXIT_CLEARANCE_MM` past the outline — never in across the board.
 *  - A pad with no axis of its own (a round/square bodge pad) runs straight
 *    in when that run is clear of every other pad's copper; else it leaves
 *    square to the wire, whichever way reaches the outline sooner without
 *    crossing a pad.
 *
 * Either way the slot must see the wire: the run from it toward the wire may
 * not cross the board outline again. `undefined` when no such exit exists
 * (e.g. a pad on the far edge, pointing away from the wire) — the caller
 * keeps its old landing and the pad is a reviewed leftover.
 */
export function exitSlot(
  copper: readonly CopperPad[],
  pad: { x: number; y: number; approach?: number | undefined },
  wire: GuideXY,
  outline: readonly GuideXY[] | undefined,
): GuideXY | undefined {
  if (outline === undefined) return undefined;
  const centre = { x: pad.x, y: pad.y };
  const obstacles = copper
    .filter((other) => Math.hypot(other.x - pad.x, other.y - pad.y) > 1e-6)
    .map((other) => padPolygon(other, LEAD_CLEARANCE_MM));
  const clear = (a: GuideXY, b: GuideXY): boolean => obstacles.every((polygon) => !segmentHitsPolygon(a, b, polygon));
  const far = 1000;
  const seesWire = (slot: GuideXY): boolean =>
    !hitsOutline(slot, { x: slot.x + wire.x * far, y: slot.y + wire.y * far }, outline);
  const slotAlong = (d: GuideXY): GuideXY | undefined => {
    const exit = outlineExit(centre, d, outline);
    if (!Number.isFinite(exit)) return undefined;
    const reach = exit + EXIT_CLEARANCE_MM;
    return { x: R(centre.x + d.x * reach), y: R(centre.y + d.y * reach) };
  };
  if (pad.approach !== undefined) {
    const axis = unit(pad.approach);
    if (angleBetween(axis, wire) <= STRAIGHT_IN_DEG) return undefined;
    const slot = slotAlong(axis);
    return slot !== undefined && seesWire(slot) ? slot : undefined;
  }
  const straight = slotAlong(wire);
  if (straight === undefined || clear(centre, straight)) return undefined;
  const options = [
    { x: -wire.y, y: wire.x },
    { x: wire.y, y: -wire.x },
  ]
    .map((d) => ({ d, exit: outlineExit(centre, d, outline), slot: slotAlong(d) }))
    .filter((o): o is { d: GuideXY; exit: number; slot: GuideXY } => o.slot !== undefined && clear(centre, o.slot) && seesWire(o.slot))
    .sort((p, q) => p.exit - q.exit);
  return options[0]?.slot;
}

/** Is this approach genuinely angled (not a cardinal straight-in pad)? */
function angled(deg: number): boolean {
  const off = ((deg % 90) + 90) % 90;
  return off > 5 && off < 85;
}

/**
 * The cable pads of `face` on an angled row, and the row's outward axis (the
 * commonest approach among them) — what a default guide serves.
 */
export function angledRow(meta: DepictionMeta, face: 'top' | 'bottom'): { axis: number; pads: CopperPad[] } | undefined {
  const pads = copperPads(meta, face).filter(
    (pad) => !pad.terminal.includes('.') && pad.side === face && pad.ref !== undefined && pad.approach !== undefined && angled(pad.approach),
  );
  if (pads.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const pad of pads) counts.set(Math.round(pad.approach!), (counts.get(Math.round(pad.approach!)) ?? 0) + 1);
  const axis = [...counts.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0]![0];
  return { axis, pads };
}

/**
 * The starting guide for each face with an angled cable row: square to the
 * row's commonest approach axis, `DEFAULT_GUIDE_OFFSET_MM` outside whichever
 * reaches further out over the row's width — the Edge.Cuts outline (when
 * given) or the pads' own tips — and running `DEFAULT_GUIDE_OVERHANG_MM` past
 * the end pads. Pads ordered along it. A person then adjusts it; a stored
 * guide always wins over this.
 */
export function defaultEntryGuides(
  meta: DepictionMeta,
  outline: readonly GuideXY[] | undefined,
  src: string,
): EntryGuide[] {
  const out: EntryGuide[] = [];
  for (const face of ['top', 'bottom'] as const) {
    const row = angledRow(meta, face);
    if (row === undefined) continue;
    const a = unit(row.axis);
    const e = { x: -a.y, y: a.x };
    const lateral = row.pads.map((pad) => dot(pad, e));
    const lo = Math.min(...lateral) - DEFAULT_GUIDE_OVERHANG_MM;
    const hi = Math.max(...lateral) + DEFAULT_GUIDE_OVERHANG_MM;
    let reach = Math.max(...row.pads.map((pad) => dot(pad, a) + pad.size[0] / 2));
    if (outline !== undefined) {
      for (let i = 0; i < outline.length; i += 1) {
        const p = outline[i]!;
        const q = outline[(i + 1) % outline.length]!;
        for (let s = 0; s <= 40; s += 1) {
          const v = { x: p.x + ((q.x - p.x) * s) / 40, y: p.y + ((q.y - p.y) * s) / 40 };
          const u = dot(v, e);
          if (u >= lo && u <= hi) reach = Math.max(reach, dot(v, a));
        }
      }
    }
    const offset = reach + DEFAULT_GUIDE_OFFSET_MM;
    const point = (u: number): [number, number] => [R(e.x * u + a.x * offset), R(e.y * u + a.y * offset)];
    const ordered = [...row.pads].sort((p, q) => dot(p, e) - dot(q, e));
    out.push({ side: face, pads: ordered.map((pad) => pad.ref!), from: point(lo), to: point(hi), src });
  }
  return out;
}

/**
 * Move a guide square to itself so that it passes through `point` — the
 * editor's offset handle: the guide stays parallel to the row (its axis never
 * changes), only its distance from the edge does.
 */
export function offsetGuideTo(guide: EntryGuide, point: GuideXY): EntryGuide {
  const { from, e } = guideFrame(guide);
  const n = { x: -e.y, y: e.x };
  const shift = dot({ x: point.x - from.x, y: point.y - from.y }, n);
  return {
    ...guide,
    from: [R(guide.from[0] + n.x * shift), R(guide.from[1] + n.y * shift)],
    to: [R(guide.to[0] + n.x * shift), R(guide.to[1] + n.y * shift)],
  };
}

/** Move one end of a guide along its own line (the editor's end handles). */
export function extendGuideTo(guide: EntryGuide, end: 'from' | 'to', point: GuideXY): EntryGuide {
  const { from, e, length } = guideFrame(guide);
  const t = dot({ x: point.x - from.x, y: point.y - from.y }, e);
  if (end === 'from') {
    const clamped = Math.min(t, length - 1);
    return { ...guide, from: [R(from.x + e.x * clamped), R(from.y + e.y * clamped)] };
  }
  const clamped = Math.max(t, 1);
  return { ...guide, to: [R(from.x + e.x * clamped), R(from.y + e.y * clamped)] };
}
