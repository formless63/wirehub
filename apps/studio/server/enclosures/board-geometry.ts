/**
 * What an enclosure needs from a board's native source: the Edge.Cuts outline, thickness,
 * mounting holes, each footprint's extent and side, and suggested port openings for edge
 * connectors. Read from a `.kicad_pcb` (the board's model source, `models/api.ts`), turned into
 * the enclosure pack's board-local frame: millimetres, origin at the outline's bounding-box
 * minimum, **y toward the back** (KiCad's y points down, so it is flipped).
 *
 * Pure: text in, plain data out. Heights are never invented here: a footprint's height is unknown
 * unless the enclosure record states it; a suggested port's height is an estimate and says so.
 */

import type { EnclosureFact, EnclosurePort } from '@wirehub/model';

import { parseKicadPcb, type OutlinePoint } from '../models/kicad-pcb.ts';
import { atom, child, children, head, numbers, type SExpr } from '../models/sexpr.ts';
import { estimateFootprintHeight, padsOnly } from './footprint-heights.ts';

export interface NativeFootprint {
  ref: string;
  footprint: string;
  side: 'top' | 'bottom';
  /** board-local extent, mm */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** courtyard when the footprint has one, else pads */
  extentFrom: 'courtyard' | 'pads';
  /** a height the footprint itself states (a `Height` property), mm */
  heightMm?: number;
  /** 3D model paths the footprint shows (hidden ones left out) */
  models?: string[];
  /** footprint attributes (`smd`, `through_hole`, `board_only`, `exclude_from_bom`, …) */
  attrs?: string[];
}

/**
 * Facts the board's own source states, each with `basis: 'native'` ("from KiCad source"): the
 * thickness from the board setup, part heights from the 3D export's model bounds (or a
 * footprint's `Height` property). What the source does not say is left out — unknown, never guessed.
 */
export interface NativeBoardFacts {
  thicknessMm?: EnclosureFact;
  heightAboveMm?: EnclosureFact;
  heightBelowMm?: EnclosureFact;
  componentHeights: Record<string, EnclosureFact>;
  /** footprints whose height the source does not state */
  unknownHeights: string[];
  /** footprints nothing stands on (landing pads, mounting holes, fiducials …: `padsOnly`), at 0 mm: not parts */
  noPart?: string[];
}

export interface NativeBoardGeometry {
  /** board-local outline, y toward the back */
  outline: [number, number][];
  widthMm: number;
  lengthMm: number;
  thicknessMm: number;
  holes: { xMm: number; yMm: number; diameterMm: number; ref: string }[];
  footprints: NativeFootprint[];
  /** edge connectors as port suggestions: position and width from the footprint, height estimated */
  suggestedPorts: EnclosurePort[];
  /** inner Edge.Cuts loops (cut-outs) that the enclosure does not model yet */
  innerLoops: number;
  /** what the source states about thickness and heights (`nativeFacts`) */
  facts?: NativeBoardFacts;
}

const HEIGHT_PROPERTY = /^(height|component[ _]height|max[ _]?height|body[ _]height)$/i;

/** `3.5`, `3.5mm`, `3,5 mm` → 3.5; anything else → undefined. */
function mmOf(text: string | undefined): number | undefined {
  const m = text === undefined ? null : /^\s*(\d+(?:[.,]\d+)?)\s*(mm)?\s*$/i.exec(text);
  const v = m === null ? undefined : Number(m[1]!.replace(',', '.'));
  return v !== undefined && Number.isFinite(v) && v > 0 && v < 300 ? v : undefined;
}

/**
 * The board's facts: thickness from the board file; each footprint's height from the 3D export
 * (`glb`, per reference, mm) when it has that part, else its `Height` property (both `native`),
 * else an estimate read from the footprint's name or model (`estimated`, `footprint-heights.ts`),
 * else unknown.
 */
export function nativeFacts(g: Pick<NativeBoardGeometry, 'thicknessMm' | 'footprints'>, glb?: { heights: Record<string, { mm: number; side: 'top' | 'bottom'; through?: number }>; label: string }): NativeBoardFacts {
  const componentHeights: Record<string, EnclosureFact> = {};
  const through: Record<string, number> = {};
  for (const f of g.footprints) {
    const fromGlb = glb?.heights[f.ref];
    if (fromGlb !== undefined) {
      componentHeights[f.ref] = { value: fromGlb.mm, basis: 'native', note: `from KiCad source: 3D model bounds (${glb!.label})` };
      // a top-side part's through-hole leads reach below the underside too
      if (fromGlb.through !== undefined) through[f.ref] = fromGlb.through;
    } else if (f.heightMm !== undefined) {
      componentHeights[f.ref] = { value: f.heightMm, basis: 'native', note: 'from KiCad source: the footprint\'s Height property' };
    } else {
      const e = estimateFootprintHeight({ footprint: f.footprint, models: f.models ?? [], attrs: f.attrs ?? [] });
      if (e !== undefined) componentHeights[f.ref] = { value: e.mm, basis: 'estimated', note: e.note };
    }
  }
  return {
    ...(g.thicknessMm > 0 ? { thicknessMm: { value: g.thicknessMm, basis: 'native' as const, note: 'from KiCad source: board setup thickness' } } : {}),
    ...tallestParts(g.footprints, componentHeights, through),
    componentHeights,
    unknownHeights: g.footprints.filter((f) => componentHeights[f.ref]?.value == null).map((f) => f.ref),
    ...noPartOf(g.footprints, glb),
  };
}

function noPartOf(footprints: readonly NativeFootprint[], glb?: { heights: Record<string, unknown> }): Pick<NativeBoardFacts, 'noPart'> {
  const refs = footprints.filter((f) => glb?.heights[f.ref] === undefined && f.heightMm === undefined && padsOnly({ footprint: f.footprint, models: f.models ?? [], attrs: f.attrs ?? [] })).map((f) => f.ref);
  return refs.length === 0 ? {} : { noPart: refs };
}

/**
 * The tallest part above and below, from per-footprint heights (record overrides included by the
 * caller). A fact only when every part's height is known; `estimated` when any part on that side is
 * estimated above 0 mm (it may be taller than its estimate), else the basis of the tallest part.
 */
export function tallestParts(footprints: readonly Pick<NativeFootprint, 'ref' | 'side'>[], heights: Record<string, EnclosureFact>, through: Record<string, number> = {}): Pick<NativeBoardFacts, 'heightAboveMm' | 'heightBelowMm'> {
  if (footprints.length === 0 || footprints.some((f) => heights[f.ref]?.value == null)) return {};
  const pick = (side: 'top' | 'bottom', withLeads: boolean): EnclosureFact => {
    let best: { mm: number; ref: string; basis: EnclosureFact['basis'] } | undefined;
    let estimated = false;
    for (const f of footprints) {
      const h = heights[f.ref]!;
      const mm = f.side === side ? h.value! : withLeads && through[f.ref] !== undefined ? through[f.ref]! : undefined;
      if (mm === undefined) continue;
      // a pads-only footprint's estimated 0 mm does not make the side's tallest part an estimate
      if (h.basis === 'estimated' && mm > 0) estimated = true;
      if (best === undefined || mm > best.mm) best = { mm, ref: f.side === side ? f.ref : `${f.ref} leads`, basis: h.basis };
    }
    if (best === undefined) return { value: 0, basis: 'native', note: `from KiCad source: no part on the ${side === 'top' ? 'top' : 'underside'}` };
    const basis = estimated ? 'estimated' : best.basis;
    return { value: best.mm, basis, note: `${basis === 'native' ? 'from KiCad source' : basis === 'estimated' ? 'estimated (some part heights are estimates)' : basis}: ${best.ref}` };
  };
  return { heightAboveMm: pick('top', false), heightBelowMm: pick('bottom', true) };
}

/** Footprints whose reference prefix marks a connector a cable plugs into. */
const CONNECTOR_REF = /^(J|P|CN|USB|X)\d/i;
/** How close to the outline's bounding box an edge connector has to sit (mm). */
const EDGE_REACH = 3;

function rotate(x: number, y: number, deg: number): OutlinePoint {
  // KiCad: angles counter-clockwise as drawn, y down → a CCW rotation is (x, y) → (x cos + y sin, −x sin + y cos)
  const t = (deg * Math.PI) / 180;
  return { x: x * Math.cos(t) + y * Math.sin(t), y: -x * Math.sin(t) + y * Math.cos(t) };
}

function extentOf(fp: SExpr[], fx: number, fy: number, frot: number): { pts: OutlinePoint[]; from: 'courtyard' | 'pads'; holes: { x: number; y: number; d: number }[] } {
  const court: OutlinePoint[] = [];
  const pads: OutlinePoint[] = [];
  const holes: { x: number; y: number; d: number }[] = [];
  const place = (lx: number, ly: number): OutlinePoint => { const r = rotate(lx, ly, frot); return { x: fx + r.x, y: fy + r.y }; };
  for (const item of fp) {
    if (!Array.isArray(item)) continue;
    const name = head(item);
    if (name === 'pad') {
      const at = numbers(child(item, 'at'));
      const size = numbers(child(item, 'size'));
      const lx = at[0] ?? 0;
      const ly = at[1] ?? 0;
      // pad `at` angle is absolute in the file; its local extent turns by (pad angle − footprint angle)
      const prot = (at[2] ?? frot) - frot;
      const w = (size[0] ?? 0) / 2;
      const h = (size[1] ?? 0) / 2;
      for (const [dx, dy] of [[-w, -h], [w, -h], [w, h], [-w, h]] as const) {
        const r = rotate(dx, dy, prot);
        pads.push(place(lx + r.x, ly + r.y));
      }
      const type = atom(item, 2);
      const drill = child(item, 'drill');
      const d = drill === undefined ? undefined : (numbers(drill)[0] ?? undefined);
      const footprintName = atom(fp) ?? '';
      if (d !== undefined && d >= 2 && (type === 'np_thru_hole' || /MountingHole/i.test(footprintName))) {
        const c = place(lx, ly);
        holes.push({ x: c.x, y: c.y, d });
      }
      continue;
    }
    if (name !== undefined && name.startsWith('fp_') && /CrtYd/.test(atom(child(item, 'layer')) ?? '')) {
      const start = numbers(child(item, 'start'));
      const end = numbers(child(item, 'end'));
      if (name === 'fp_rect' && start.length >= 2 && end.length >= 2) {
        for (const [x, y] of [[start[0]!, start[1]!], [end[0]!, start[1]!], [end[0]!, end[1]!], [start[0]!, end[1]!]] as const) court.push(place(x, y));
      } else if (name === 'fp_poly') {
        for (const p of children(child(item, 'pts') ?? [], 'xy')) { const n = numbers(p); if (n.length >= 2) court.push(place(n[0]!, n[1]!)); }
      } else if (name === 'fp_circle') {
        const c = numbers(child(item, 'center'));
        if (c.length >= 2 && end.length >= 2) {
          const r = Math.hypot(end[0]! - c[0]!, end[1]! - c[1]!);
          for (const [x, y] of [[c[0]! - r, c[1]! - r], [c[0]! + r, c[1]! + r]] as const) court.push(place(x, y));
        }
      } else if (start.length >= 2 && end.length >= 2) {
        court.push(place(start[0]!, start[1]!), place(end[0]!, end[1]!));
      }
    }
  }
  return court.length >= 2 ? { pts: court, from: 'courtyard', holes } : { pts: pads, from: 'pads', holes };
}

export function nativeBoardGeometry(text: string): NativeBoardGeometry {
  const board = parseKicadPcb(text);
  const loop = board.outlines[0];
  if (loop === undefined) throw new Error('the board file has no closed Edge.Cuts outline');
  const minX = Math.min(...loop.map((p) => p.x));
  const maxX = Math.max(...loop.map((p) => p.x));
  const minY = Math.min(...loop.map((p) => p.y));
  const maxY = Math.max(...loop.map((p) => p.y));
  const local = (p: OutlinePoint): [number, number] => [round(p.x - minX), round(maxY - p.y)];
  const width = maxX - minX;
  const length = maxY - minY;

  const top = board.tree[0];
  const footprints: NativeFootprint[] = [];
  const holes: NativeBoardGeometry['holes'] = [];
  const suggestedPorts: EnclosurePort[] = [];
  const fpExprs = Array.isArray(top) ? children(top, 'footprint') : [];
  for (const [i, fp] of fpExprs.entries()) {
    const placement = board.footprints[i];
    if (placement === undefined) continue;
    const { pts, from, holes: fpHoles } = extentOf(fp, placement.x, placement.y, placement.rotation);
    for (const h of fpHoles) {
      const [x, y] = local(h);
      holes.push({ xMm: x, yMm: y, diameterMm: h.d, ref: placement.reference });
    }
    if (pts.length === 0 || /MountingHole/i.test(placement.footprint)) continue;
    const lx = pts.map((p) => p.x - minX);
    const ly = pts.map((p) => maxY - p.y);
    const f: NativeFootprint = {
      ref: placement.reference || `fp${i + 1}`, footprint: placement.footprint, side: placement.bottom ? 'bottom' : 'top',
      x0: round(Math.min(...lx)), y0: round(Math.min(...ly)), x1: round(Math.max(...lx)), y1: round(Math.max(...ly)), extentFrom: from,
    };
    const heightProperty = children(fp, 'property').find((p) => HEIGHT_PROPERTY.test(atom(p) ?? ''));
    const stated = mmOf(heightProperty === undefined ? undefined : atom(heightProperty, 2));
    if (stated !== undefined) f.heightMm = stated;
    const models = children(fp, 'model').filter((m) => !isHidden(m)).map((m) => atom(m) ?? '').filter((m) => m !== '');
    if (models.length > 0) f.models = models;
    const attrs = (child(fp, 'attr') ?? []).slice(1).filter((a): a is string => typeof a === 'string');
    if (attrs.length > 0) f.attrs = attrs;
    footprints.push(f);
    if (!CONNECTOR_REF.test(f.ref) || f.side !== 'top') continue;
    const reach: [EnclosurePort['edge'], number][] = [['front', f.y0], ['back', length - f.y1], ['left', f.x0], ['right', width - f.x1]];
    const [edge, gap] = reach.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (gap > EDGE_REACH) continue;
    const along = edge === 'front' || edge === 'back';
    const span = along ? f.x1 - f.x0 : f.y1 - f.y0;
    // no height in a footprint: estimate a squat body proportional to its width, clearly labelled
    const height = round(Math.min(Math.max(span * 0.6, 3), 11));
    suggestedPorts.push({
      id: f.ref.toLowerCase(), label: `${f.ref} (${f.footprint.split(':').pop() ?? f.footprint})`, ref: f.ref, edge,
      atMm: round(along ? (f.x0 + f.x1) / 2 : (f.y0 + f.y1) / 2), zMm: round(height / 2), widthMm: round(span), heightMm: height,
      shape: 'rect', protrudeMm: round(Math.max(-gap, 0)), basis: 'estimated',
    });
  }
  const geometry = {
    outline: loop.map(local), widthMm: round(width), lengthMm: round(length), thicknessMm: board.thickness,
    holes, footprints, suggestedPorts, innerLoops: Math.max(board.outlines.length - 1, 0),
  };
  return withFacts(geometry, nativeFacts(geometry));
}

/** The geometry with its stated facts, and each suggested port as tall as its part's stated height. */
export function withFacts(g: NativeBoardGeometry, facts: NativeBoardFacts): NativeBoardGeometry {
  const suggestedPorts = g.suggestedPorts.map((q) => {
    const f = q.ref === undefined ? undefined : facts.componentHeights[q.ref];
    const h = f?.value;
    return h === undefined || h === null || h <= 0 ? q : { ...q, heightMm: round(h), zMm: round(h / 2), basis: f!.basis === 'estimated' ? 'estimated' as const : 'native' as const };
  });
  return { ...g, suggestedPorts, facts };
}

/** `(model "…" hide …)` (older files) or `(model "…" (hide yes) …)` */
function isHidden(model: SExpr[]): boolean {
  return model.includes('hide') || atom(child(model, 'hide') ?? []) === 'yes';
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
