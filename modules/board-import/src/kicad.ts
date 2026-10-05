/**
 * KiCad's open file formats read into one neutral board description
 * (`BoardSource`): the footprints with their pads and nets, and — from a
 * `.kicad_pcb` — where each pad sits and the board's Edge.Cuts outline.
 *
 * - `.kicad_pcb` (KiCad 6 and later; the 5-era `fp_text` properties too):
 *   footprints, pads (number, net, type, layers, position), attributes
 *   (`dnp`, `exclude_from_bom`, `board_only`), properties, the title block,
 *   the outline.
 * - `.net` (KiCad's own netlist export, version D/E): components and nets, no
 *   geometry — enough for terminals and internal links, not for art.
 *
 * Coordinates are KiCad's board frame: millimetres, y pointing down.
 * Pure: text in, data out.
 */

import { atom, atoms, child, children, head, numbers, parseSExpr, type SExpr } from './sexpr.ts';

export interface Point {
  x: number;
  y: number;
}

export type PadKind = 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect' | 'unknown';

export interface PadSource {
  /** the pad number as the footprint has it (`1`, `A3`, `` for an unnumbered mechanical pad) */
  number: string;
  /** the net's name (`/A`, `GND`, `Net-(R1-Pad2)`); absent for an unconnected pad */
  net?: string;
  kind: PadKind;
  shape?: string;
  /** board frame, mm (absent from a netlist) */
  x?: number;
  y?: number;
  /** pad size, mm, in the pad's own frame */
  w?: number;
  h?: number;
  /** degrees, absolute */
  angle?: number;
  /** drill diameter, mm (through-hole) */
  drill?: number;
  layers: string[];
}

export interface FootprintSource {
  /** `R1`, `J2`, `TP3` */
  ref: string;
  value?: string;
  /** the library id, `Resistor_SMD:R_0603_1608Metric` */
  lib: string;
  side: 'top' | 'bottom';
  x?: number;
  y?: number;
  rotation?: number;
  dnp: boolean;
  excludeFromBom: boolean;
  boardOnly: boolean;
  /** the footprint's own properties (`LCSC`, `MPN`, `Manufacturer` …), as written */
  properties: Record<string, string>;
  pads: PadSource[];
  /** 3D model paths, as the board names them */
  models: string[];
}

export interface BoardFrame {
  /** KiCad coordinate of the frame's top-left corner */
  x0: number;
  y0: number;
  width: number;
  height: number;
}

export interface BoardSource {
  format: 'kicad-pcb' | 'kicad-netlist';
  fileName: string;
  title?: string;
  revision?: string;
  company?: string;
  footprints: FootprintSource[];
  /** the outer Edge.Cuts loop (board frame), when the file has a closed one */
  outline?: Point[];
  /** further closed Edge.Cuts loops: cut-outs */
  cutouts?: Point[][];
  /** the art frame: the outline's bounding box (or the pads', with a margin, when there is no outline) */
  frame?: BoardFrame;
  /** mm */
  thickness?: number;
}

/* ------------------------------------------------------------------ *
 * .kicad_pcb
 * ------------------------------------------------------------------ */

function property(expr: SExpr[], name: string): string | undefined {
  for (const p of children(expr, 'property')) if (atom(p) === name) return atom(p, 2);
  for (const t of children(expr, 'fp_text')) if (atom(t) === name.toLowerCase()) return atom(t, 2);
  return undefined;
}

function netName(expr: SExpr[] | undefined): string | undefined {
  if (expr === undefined) return undefined;
  // `(net 3 "/A")` (KiCad ≤ 9) or `(net "/A")`
  const strings = atoms(expr).slice(1);
  const name = strings.length >= 2 ? strings[1] : strings[0] !== undefined && !/^\d+$/.test(strings[0]) ? strings[0] : undefined;
  return name === undefined || name === '' ? undefined : name;
}

/** A footprint-local point in the board frame (KiCad: y down, rotation counter-clockwise as drawn). */
export function toBoard(fp: { x: number; y: number; rotation: number }, local: Point): Point {
  const t = (fp.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: fp.x + local.x * c + local.y * s, y: fp.y - local.x * s + local.y * c };
}

const PAD_KINDS: readonly PadKind[] = ['smd', 'thru_hole', 'np_thru_hole', 'connect'];

function flagged(expr: SExpr[], name: string): boolean {
  const attr = child(expr, 'attr');
  if (attr !== undefined && atoms(attr).includes(name)) return true;
  const own = child(expr, name);
  return own !== undefined && atom(own) !== 'no';
}

function parseFootprint(expr: SExpr[]): FootprintSource {
  const at = numbers(child(expr, 'at'));
  const placement = { x: at[0] ?? 0, y: at[1] ?? 0, rotation: at[2] ?? 0 };
  const layer = atom(child(expr, 'layer')) ?? 'F.Cu';
  const properties: Record<string, string> = {};
  for (const p of children(expr, 'property')) {
    const name = atom(p);
    const value = atom(p, 2);
    if (name !== undefined && value !== undefined && name !== 'Reference' && name !== 'Value' && name !== 'Footprint' && value !== '' && value !== '~') properties[name] = value;
  }
  const pads: PadSource[] = [];
  for (const pad of children(expr, 'pad')) {
    const kindText = atom(pad, 2) ?? 'unknown';
    const kind = (PAD_KINDS as readonly string[]).includes(kindText) ? (kindText as PadKind) : 'unknown';
    const padAt = numbers(child(pad, 'at'));
    const local = { x: padAt[0] ?? 0, y: padAt[1] ?? 0 };
    const p = toBoard(placement, local);
    const size = numbers(child(pad, 'size'));
    const drill = numbers(child(pad, 'drill'));
    const net = netName(child(pad, 'net'));
    const shape = atom(pad, 3);
    pads.push({
      number: atom(pad) ?? '',
      ...(net === undefined ? {} : { net }),
      kind,
      ...(shape === undefined ? {} : { shape }),
      x: p.x,
      y: p.y,
      ...(size.length >= 2 ? { w: size[0]!, h: size[1]! } : {}),
      angle: padAt[2] ?? placement.rotation,
      ...(drill.length >= 1 ? { drill: drill[0]! } : {}),
      layers: atoms(child(pad, 'layers')).slice(1),
    });
  }
  const value = property(expr, 'Value');
  return {
    ref: property(expr, 'Reference') ?? '',
    ...(value === undefined ? {} : { value }),
    lib: atom(expr) ?? '',
    side: layer.startsWith('B.') ? 'bottom' : 'top',
    x: placement.x,
    y: placement.y,
    rotation: placement.rotation,
    dnp: flagged(expr, 'dnp'),
    excludeFromBom: flagged(expr, 'exclude_from_bom'),
    boardOnly: flagged(expr, 'board_only'),
    properties,
    pads,
    models: children(expr, 'model').map((m) => atom(m) ?? '').filter((m) => m !== ''),
  };
}

type Polyline = Point[];

function xy(expr: SExpr[] | undefined): Point | undefined {
  const n = numbers(expr);
  return n.length >= 2 ? { x: n[0]!, y: n[1]! } : undefined;
}

/** Points along the circle through `a`, `m`, `b`, from a to b through m. */
export function arcThrough(a: Point, m: Point, b: Point): Polyline {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return [a, b];
  const a2 = a.x * a.x + a.y * a.y;
  const m2 = m.x * m.x + m.y * m.y;
  const b2 = b.x * b.x + b.y * b.y;
  const cx = (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d;
  const cy = (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const ang = (p: Point): number => Math.atan2(p.y - cy, p.x - cx);
  const t0 = ang(a);
  const norm = (t: number): number => (((t - t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const toB = norm(ang(b));
  const sweep = toB === 0 ? 2 * Math.PI : norm(ang(m)) < toB ? toB : toB - 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const out: Polyline = [];
  for (let k = 0; k <= steps; k++) {
    const t = t0 + (sweep * k) / steps;
    out.push(k === 0 ? a : k === steps ? b : { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return out;
}

function circle(c: Point, e: Point): Polyline {
  const r = Math.hypot(e.x - c.x, e.y - c.y);
  const out: Polyline = [];
  for (let k = 0; k <= 48; k++) {
    const t = (2 * Math.PI * k) / 48;
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

function edgePolylines(expr: SExpr[], prefix: 'gr' | 'fp'): Polyline[] {
  const out: Polyline[] = [];
  for (const item of expr) {
    if (!Array.isArray(item)) continue;
    const name = head(item);
    if (name === undefined || !name.startsWith(`${prefix}_`)) continue;
    if (atom(child(item, 'layer')) !== 'Edge.Cuts') continue;
    const start = xy(child(item, 'start'));
    const end = xy(child(item, 'end'));
    switch (name.slice(3)) {
      case 'line':
        if (start && end) out.push([start, end]);
        break;
      case 'arc': {
        const mid = xy(child(item, 'mid'));
        if (start && mid && end) out.push(arcThrough(start, mid, end));
        break;
      }
      case 'rect':
        if (start && end) out.push([start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]);
        break;
      case 'circle': {
        const center = xy(child(item, 'center'));
        if (center && end) out.push(circle(center, end));
        break;
      }
      case 'poly': {
        const points = children(child(item, 'pts'), 'xy')
          .map((p) => xy(p))
          .filter((p): p is Point => p !== undefined);
        if (points.length >= 2) out.push([...points, points[0]!]);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const EPS = 0.01;
const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

export function polygonArea(loop: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Joins polylines end to end into closed loops, largest first; open chains are dropped. */
export function chainLoops(polylines: readonly Polyline[]): Point[][] {
  const pool = polylines.filter((p) => p.length >= 2).map((p) => [...p]);
  const loops: Point[][] = [];
  while (pool.length > 0) {
    const chain = pool.shift()!;
    let grew = true;
    while (!same(chain[0]!, chain[chain.length - 1]!) && grew) {
      grew = false;
      const tail = chain[chain.length - 1]!;
      for (let k = 0; k < pool.length; k++) {
        const next = pool[k]!;
        if (same(next[0]!, tail)) chain.push(...next.slice(1));
        else if (same(next[next.length - 1]!, tail)) chain.push(...[...next].reverse().slice(1));
        else continue;
        pool.splice(k, 1);
        grew = true;
        break;
      }
    }
    if (chain.length >= 4 && same(chain[0]!, chain[chain.length - 1]!)) {
      const loop = chain.slice(0, -1).filter((p, i, all) => i === 0 || !same(p, all[i - 1]!));
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}

export function boundsOf(points: readonly Point[]): BoardFrame | undefined {
  if (points.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

function titleBlock(top: SExpr[]): Pick<BoardSource, 'title' | 'revision' | 'company'> {
  const block = child(top, 'title_block');
  const title = atom(child(block, 'title'));
  const revision = atom(child(block, 'rev'));
  const company = atom(child(block, 'company'));
  return {
    ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }),
    ...(revision === undefined || revision.trim() === '' ? {} : { revision: revision.trim() }),
    ...(company === undefined || company.trim() === '' ? {} : { company: company.trim() }),
  };
}

export function parseKicadPcb(text: string, fileName: string): BoardSource {
  const top = parseSExpr(text).find((e) => head(e) === 'kicad_pcb');
  if (top === undefined || !Array.isArray(top)) throw new Error(`${fileName} is not a KiCad board file (it has no kicad_pcb list).`);
  const thickness = numbers(child(child(top, 'general'), 'thickness'))[0];
  const footprints: FootprintSource[] = [];
  const polylines: Polyline[] = edgePolylines(top, 'gr');
  for (const fp of children(top, 'footprint').concat(children(top, 'module'))) {
    const footprint = parseFootprint(fp);
    footprints.push(footprint);
    const placement = { x: footprint.x ?? 0, y: footprint.y ?? 0, rotation: footprint.rotation ?? 0 };
    for (const line of edgePolylines(fp, 'fp')) polylines.push(line.map((p) => toBoard(placement, p)));
  }
  const loops = chainLoops(polylines);
  const outline = loops[0];
  const padPoints = footprints.flatMap((f) => f.pads.filter((p) => p.x !== undefined && p.y !== undefined).map((p) => ({ x: p.x!, y: p.y! })));
  let frame = outline === undefined ? undefined : boundsOf(outline);
  if (frame === undefined) {
    const pads = boundsOf(padPoints);
    if (pads !== undefined) frame = { x0: pads.x0 - 2, y0: pads.y0 - 2, width: pads.width + 4, height: pads.height + 4 };
  }
  return {
    format: 'kicad-pcb',
    fileName,
    ...titleBlock(top),
    footprints: footprints.sort((a, b) => compareRefs(a.ref, b.ref)),
    ...(outline === undefined ? {} : { outline }),
    ...(loops.length > 1 ? { cutouts: loops.slice(1) } : {}),
    ...(frame === undefined ? {} : { frame }),
    ...(thickness === undefined ? {} : { thickness }),
  };
}

/* ------------------------------------------------------------------ *
 * .net (KiCad netlist export)
 * ------------------------------------------------------------------ */

export function parseKicadNetlist(text: string, fileName: string): BoardSource {
  const top = parseSExpr(text).find((e) => head(e) === 'export');
  if (top === undefined || !Array.isArray(top)) throw new Error(`${fileName} is not a KiCad netlist (it has no export list).`);
  const footprints = new Map<string, FootprintSource>();
  for (const comp of children(child(top, 'components'), 'comp')) {
    const ref = atom(child(comp, 'ref')) ?? '';
    if (ref === '') continue;
    const properties: Record<string, string> = {};
    for (const p of children(comp, 'property')) {
      const name = atom(child(p, 'name'));
      const value = atom(child(p, 'value'));
      if (name !== undefined && value !== undefined) properties[name] = value;
    }
    for (const field of children(child(comp, 'fields'), 'field')) {
      const name = atom(child(field, 'name'));
      const value = atom(field, 2);
      if (name !== undefined && value !== undefined && value !== '') properties[name] = value;
    }
    const value = atom(child(comp, 'value'));
    footprints.set(ref, {
      ref,
      ...(value === undefined ? {} : { value }),
      lib: atom(child(comp, 'footprint')) ?? '',
      side: 'top',
      dnp: 'dnp' in properties || /\bDNP\b/.test(value ?? ''),
      excludeFromBom: 'exclude_from_bom' in properties,
      boardOnly: 'exclude_from_board' in properties,
      properties: Object.fromEntries(Object.entries(properties).filter(([k]) => !['dnp', 'exclude_from_bom', 'exclude_from_board', 'Sheetname', 'Sheetfile'].includes(k))),
      pads: [],
      models: [],
    });
  }
  for (const net of children(child(top, 'nets'), 'net')) {
    const name = atom(child(net, 'name'));
    for (const node of children(net, 'node')) {
      const ref = atom(child(node, 'ref')) ?? '';
      const pin = atom(child(node, 'pin')) ?? '';
      const fp = footprints.get(ref);
      if (fp === undefined || pin === '') continue;
      fp.pads.push({ number: pin, ...(name === undefined || name === '' || /^unconnected-/.test(name) ? {} : { net: name }), kind: 'unknown', layers: [] });
    }
  }
  const sheet = child(child(top, 'design'), 'sheet');
  const block = child(sheet, 'title_block');
  const title = atom(child(block, 'title'));
  const revision = atom(child(block, 'rev'));
  const company = atom(child(block, 'company'));
  return {
    format: 'kicad-netlist',
    fileName,
    ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }),
    ...(revision === undefined || revision.trim() === '' ? {} : { revision: revision.trim() }),
    ...(company === undefined || company.trim() === '' ? {} : { company: company.trim() }),
    footprints: [...footprints.values()].sort((a, b) => compareRefs(a.ref, b.ref)),
  };
}

/** `R2` before `R10`; letters first, then the number. */
export function compareRefs(a: string, b: string): number {
  const ma = /^([A-Za-z_#]*)(\d*)(.*)$/.exec(a);
  const mb = /^([A-Za-z_#]*)(\d*)(.*)$/.exec(b);
  const pa = ma?.[1] ?? a;
  const pb = mb?.[1] ?? b;
  if (pa !== pb) return pa < pb ? -1 : 1;
  const na = ma?.[2] === '' || ma?.[2] === undefined ? -1 : Number(ma[2]);
  const nb = mb?.[2] === '' || mb?.[2] === undefined ? -1 : Number(mb[2]);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
