/**
 * `wireModel(wire, options)` — a wire stock as the pieces a 3D view draws
 *. Owner, 2026-09-29: "create the coaxial and
 * bonded multi-core wires as models where the different parts and pieces were able
 * to be manipulated? Like showing different lengths, stripped back at
 * different layers, etc."
 *
 * Pure: no three.js, no DOM. Out comes a list of swept tubes — each a
 * centreline, an outer and inner radius, a material kind and a colour name —
 * that the lazy viewer chunk turns into meshes. The positions and diameters
 * are the 2D cross-section's (`crossSectionLayout` at 1 mm = 1 unit), so the
 * 3D model and the drawings can never disagree about the lay.
 *
 * The frame: the cable axis is +x, end `a` (source) at x = 0 and end `b`
 * (destination) at x = length; +y is up; looking into the cut face the
 * stock's lay order was read from, the cross-section appears as drawn.
 * Angles are about +x, right-handed (three.js `makeRotationX`): a core at
 * angle φ sits at (y, z) = (r cos φ, r sin φ).
 *
 * The owner's grounding rules are geometry here, not styling:
 *
 * - **The foil is never shown** (and neither is a tape): it is trimmed back
 *   to the jacket and never landed. It still sizes the jacket's bore.
 * - **bonded multi-core's shielding is one copper mass**: when every core screen is
 *   in one bonded set, the screens gather into a single pigtail at each
 *   stripped end, never one per core.
 * - **Coax braids stay separate strands**: each is trimmed (SW "Stripping
 *   Coax": ~80 % cut off) and twisted into its own short lead that stays on
 *   its own core — folded back along it, or (a design's build) bent toward
 *   the board face its pigtail lands on. Nothing converges on a point in
 *   space (owner 2026-09-29). The drain follows the
 *   strip's own per-end rule (used at the source end only), coming out of
 *   the bundle through a valley and lying along it.
 *
 * Only what can be seen is emitted: a layer inside an opaque one is cut short
 * a millimetre or two inside it (unless the jacket is shown x-ray), so a
 * 6 ft cable is one jacket tube plus two short stripped ends, not eight
 * 1.8 m helices nobody can see. Every tube's segment count is capped.
 *
 * Deterministic: arithmetic over the declared order, no clock, no randomness.
 */

import type { StripPractice, WireDefinition } from '@wirehub/model';

import { crossSectionLayout } from './cross-section.ts';
import type { CrossSection, CrossSectionCore, CrossSectionRing } from './model.ts';

export type Vec3 = readonly [number, number, number];

/** What a piece is, as a builder would name it. */
export type WirePieceKind =
  | 'conductor'
  | 'dielectric'
  | 'insulation'
  | 'sheath'
  | 'shield'
  | 'fold'
  | 'slug'
  | 'drain'
  | 'jacket'
  | 'filler'
  | 'web'
  | 'pigtail';

/** What it looks like: the renderer keeps one material per kind. */
export type WireMaterialKind = 'copper' | 'tinned' | 'pvc' | 'pe' | 'braid' | 'spiral' | 'filler' | 'bore';

export type CapKind = 'ring' | 'disk' | 'none';

export interface WirePiece {
  /** unique and stable: `core-red:sheath:a` */
  id: string;
  /** the element it draws (`core-red.shield`, `jacket`, `mass`) */
  elementPath: string;
  kind: WirePieceKind;
  material: WireMaterialKind;
  /** a catalog colour name (`red`) for coloured PVC; absent = the material's own */
  colorName?: string;
  /** mm */
  rOuter: number;
  /** mm; 0 = solid */
  rInner: number;
  /** centreline before `rotateDeg`, mm, at least two points */
  points: Vec3[];
  /** turn about the cable axis (+x) applied to `points`, degrees */
  rotateDeg: number;
  /** pieces with the same key have the same geometry — draw them as instances */
  shapeKey: string;
  radialSegments: number;
  caps: { start: CapKind; end: CapKind };
  /** the stripped end it belongs to; absent = the body of the cable */
  end?: 'a' | 'b';
  /** 0 = jacket, 1 = a core's outermost layer, … inward */
  depth: number;
  /** a screen's lay length for its texture, mm */
  layMm?: number;
  /** a screen's metal (a braid or spiral is copper or tinned copper) */
  metal?: 'copper' | 'tinned';
  /** 0–1, for a see-through jacket */
  opacity?: number;
}

/** How one end is stripped. Every length is measured back from the tip. */
export interface StripEnd {
  /** overall jacket (and the foil, filler and strings under it) taken off, mm */
  jacketMm: number;
  /** a coax's own sheath taken off, mm */
  sheathMm: number;
  shield: 'trim' | 'fold' | 'gather' | 'keep';
  /** `trim`: the share of the exposed screen left on, % */
  shieldKeepPct: number;
  /** insulation / dielectric taken off — the bare conductor, mm */
  insulationMm: number;
  /** > 0: the stripped insulation is left on, slid this far toward the tip, mm */
  insulationSlidMm: number;
  drain: 'land' | 'cut';
  /** cores (element paths) cut back flush with the jacket at this end: spares, not landed */
  cutCores?: string[];
  /**
   * The board face each twisted lead is soldered on, from a design's bench
   * plan: keyed by core group (`core-red`), `drain`, or `mass` (a bonded
   * bonded multi-core mass). A lead with a face bends toward it (+y = top); without
   * one it is folded back along its core.
   */
  leads?: Partial<Record<string, 'top' | 'bottom'>>;
}

/** Nothing stripped: a clean cut. */
export const BARE_END: StripEnd = {
  jacketMm: 0,
  sheathMm: 0,
  shield: 'keep',
  shieldKeepPct: 100,
  insulationMm: 0,
  insulationSlidMm: 0,
  drain: 'cut',
};

export type WireEndShown = 'a' | 'b' | 'both';

export interface WireModelOptions {
  /** the cable's length, mm (default 300) */
  lengthMm?: number;
  /** which end is shown: one end (a window of cable behind it) or the whole length (default `both`) */
  show?: WireEndShown;
  /** a one-end view: cable shown behind the deepest strip, mm (default 60) */
  windowMm?: number;
  strip?: { a?: StripEnd; b?: StripEnd };
  /** radial: stripped cores splay out this far past the jacket mouth; axial: each layer's end piece is pulled out this far per layer, mm */
  explode?: { radialMm?: number; axialMm?: number };
  /** lay the cores as a helix (default false: straight) */
  twist?: boolean;
  /** the assembly lay length, mm — the recipe's `lay.layLengthMm`; absent: 16 × Ø, INFERRED */
  layLengthMm?: number;
  hand?: 'S' | 'Z';
  /** the stock has a filler / strings (a recipe's `overall.filler`): shown in the jacket mouths */
  filler?: boolean;
  /** see-through jacket: the cores are drawn inside it too */
  xray?: boolean;
  /** cap on any one tube's length segments (default 160) */
  maxSegments?: number;
  /** length segments per turn of a helix (default 24) */
  segmentsPerTurn?: number;
}

export interface WireModel {
  wire: string;
  label: string;
  lengthMm: number;
  odMm: number;
  /** the x range drawn */
  span: [number, number];
  /** the largest distance of anything from the axis, mm */
  reach: number;
  pieces: WirePiece[];
  /** elements deliberately not drawn, with why (`overall-shield: foil — never shown`) */
  omitted: string[];
  /** the lay used when twisted, and whether it was assumed */
  layLengthMm: number;
  layInferred: boolean;
  /** Σ over pieces of length segments × radial segments × walls × 2 (+ caps) */
  triangles: number;
}

/** A named strip, both ends. */
export interface StripPreset {
  id: string;
  label: string;
  src: string;
  /** some of its numbers are not stated by the source */
  inferred: boolean;
  strip: { a: StripEnd; b: StripEnd };
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

/**
 * What a strip practice is matched on: `coax` when the cores are built as
 * coax, `bonded-mass` when every core screen is in one bonded set
 * (bonded multi-core), else the first core group's role (`shielded-core`), if any.
 */
export function coreConstruction(wire: WireDefinition): string | undefined {
  const groups = wire.structure.children.filter((c) => c.kind === 'group');
  if (groups.some((g) => g.role === 'coax')) return 'coax';
  const screens = groups.flatMap((g) => g.children.filter((c) => c.kind === 'shield').map((c) => `${g.id}.${c.id}`));
  if (screens.length > 0 && (wire.bonded ?? []).some((set) => screens.every((p) => set.members.includes(p)))) return 'bonded-mass';
  return groups[0]?.role;
}

/** One practice record as a strip for both ends of `wire`. */
export function stripFromPractice(practice: StripPractice): { a: StripEnd; b: StripEnd } {
  const base = {
    jacketMm: practice.jacketMm,
    sheathMm: practice.sheathMm ?? 0,
    shield: practice.shield,
    shieldKeepPct: practice.shieldKeepPct ?? (practice.shield === 'trim' ? 20 : 100),
    insulationMm: practice.insulationMm,
    insulationSlidMm: practice.insulationSlidMm ?? 0,
  };
  return {
    a: { ...base, drain: practice.drain.source },
    b: { ...base, drain: practice.drain.destination },
  };
}

/**
 * The presets that fit `wire`: always "Bare cut", then every practice record
 * written for its construction (or for any stock), in file order.
 */
export function stripPresets(wire: WireDefinition, practice: readonly StripPractice[]): StripPreset[] {
  const role = coreConstruction(wire);
  const out: StripPreset[] = [
    { id: 'bare', label: 'Bare cut', src: 'Nothing stripped: the stock cut square.', inferred: false, strip: { a: BARE_END, b: BARE_END } },
  ];
  for (const p of practice) {
    if (p.appliesTo !== 'any' && p.appliesTo !== role) continue;
    out.push({ id: p.id, label: p.label, src: p.src, inferred: (p.inferred ?? []).length > 0, strip: stripFromPractice(p) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------ */

const DEG = 180 / Math.PI;
const EPS = 1.5; // mm a hidden layer runs on inside the layer over it
const STUB = 1; // mm a cut-back core shows past the jacket mouth
const SPLAY_RAMP = 12; // mm over which stripped cores splay out
const LIP = 0.4; // mm of screen left showing at a sheath mouth, where the strands leave it
const MIN_LEAD = 3; // mm: a trimmed screen lead is never shorter than this
/** stripped cores fan out this share of the jacket radius as they leave the mouth */
const FAN = 0.3;
const r4 = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r; // never -0: the model is compared and serialised as data
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smooth = (t: number): number => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};

/** Materials from the element's own words. */
function conductorMaterial(material: string | undefined): WireMaterialKind {
  return /tinn|\bTC\b/i.test(material ?? '') ? 'tinned' : 'copper';
}

/* ------------------------------------------------------------------ *
 * The layers of one core
 * ------------------------------------------------------------------ */

type LayerRole = 'conductor' | 'insulation' | 'dielectric' | 'shield' | 'sheath';

interface Layer {
  ring: CrossSectionRing;
  role: LayerRole;
  material: WireMaterialKind;
  metal?: 'copper' | 'tinned';
  colorName?: string;
}

interface CoreGeo {
  core: CrossSectionCore;
  /** polar position on the face */
  r: number;
  phi: number;
  /** innermost first */
  layers: Layer[];
  drain: boolean;
}

function layersOf(core: CrossSectionCore, elementMaterial: (path: string) => string | undefined): Layer[] {
  const rings = core.rings.filter((ring) => ring.construction !== 'foil' && ring.construction !== 'tape');
  const out: Layer[] = [];
  rings.forEach((ring, index) => {
    const hasShieldInside = rings.slice(0, index).some((inner) => inner.kind === 'shield');
    if (ring.kind === 'conductor') {
      out.push({ ring, role: 'conductor', material: conductorMaterial(elementMaterial(ring.elementPath)) });
      return;
    }
    if (ring.kind === 'shield') {
      const metal = conductorMaterial(elementMaterial(ring.elementPath)) === 'tinned' ? 'tinned' : 'copper';
      out.push({ ring, role: 'shield', material: ring.construction === 'braid' ? 'braid' : 'spiral', metal });
      return;
    }
    const id = ring.elementPath.split('.').pop() ?? '';
    const role: LayerRole = hasShieldInside || ring.jacket === true ? 'sheath' : id === 'dielectric' ? 'dielectric' : 'insulation';
    const words = elementMaterial(ring.elementPath) ?? '';
    const material: WireMaterialKind = role === 'dielectric' && /PE|PPE|foam/i.test(words) && !/PVC/i.test(words) ? 'pe' : 'pvc';
    out.push({ ring, role, material, ...(ring.colorName === undefined ? {} : { colorName: ring.colorName }) });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * wireModel
 * ------------------------------------------------------------------ */

interface Interval {
  x0: number;
  x1: number;
  end?: 'a' | 'b';
}

/**
 * The pieces of `wire`, or `undefined` when its geometry is not documented
 * well enough to draw (the same test as the 2D cutaway: a jacket Ø and core
 * diameters).
 */
export function wireModel(wire: WireDefinition, options: WireModelOptions = {}): WireModel | undefined {
  const cs = crossSectionLayout(wire, { scale: 1, origin: { x: 0, y: 0 } });
  if (cs === undefined) return undefined;
  return buildModel(wire, cs, options);
}

function buildModel(wire: WireDefinition, cs: CrossSection, options: WireModelOptions): WireModel {
  const length = Math.max(1, options.lengthMm ?? 300);
  const show = options.show ?? 'both';
  const radial = Math.max(0, options.explode?.radialMm ?? 0);
  const axial = Math.max(0, options.explode?.axialMm ?? 0);
  // a figure-8's legs are moulded side by side: they never lay up
  const twist = options.twist === true && cs.outline === undefined;
  const layInferred = options.layLengthMm === undefined || options.layLengthMm <= 0;
  const lay = layInferred ? 16 * cs.odMm : (options.layLengthMm as number);
  const handSign = (options.hand ?? 'S') === 'S' ? -1 : 1; // S = left-hand helix
  const k = twist ? (handSign * 2 * Math.PI) / lay : 0;
  const maxSeg = Math.max(2, Math.floor(options.maxSegments ?? 160));
  const perTurn = Math.max(6, Math.floor(options.segmentsPerTurn ?? 24));
  const xray = options.xray === true;

  // which ends are stripped, and the x range drawn
  const stripA = show === 'b' ? BARE_END : (options.strip?.a ?? BARE_END);
  const stripB = show === 'a' ? BARE_END : (options.strip?.b ?? BARE_END);
  const deepest = (s: StripEnd): number => Math.max(s.jacketMm, s.sheathMm, s.insulationMm);
  const window = Math.max(10, options.windowMm ?? 60);
  let span: [number, number] = [0, length];
  if (show === 'a') span = [0, Math.min(length, deepest(stripA) + window)];
  if (show === 'b') span = [Math.max(0, length - deepest(stripB) - window), length];
  const breakA = span[0] > 0; // the drawn span starts at a break, not an end
  const breakB = span[1] < length;
  const [X0, X1] = span;

  // x of a distance back from a tip, clamped into the cable
  const fromTip = (end: 'a' | 'b', d: number): number => (end === 'a' ? clamp(d, 0, length) : clamp(length - d, 0, length));
  const stripOf = (end: 'a' | 'b'): StripEnd => (end === 'a' ? stripA : stripB);

  // the face: layout coordinates → polar about the axis
  const viewedB = wire.layOrder?.viewedFrom === 'destination';
  const polarOf = (px: number, py: number): { r: number; phi: number } => {
    const dx = px - cs.cx;
    const dy = py - cs.cy;
    const y = -dy;
    const z = viewedB ? -dx : dx;
    return { r: Math.hypot(y, z), phi: Math.atan2(z, y) };
  };

  const elementMaterial = (path: string): string | undefined => {
    let node: { kind: string; id: string; children?: unknown[]; material?: string } | undefined = wire.structure as never;
    for (const id of path.split('.')) {
      const children = (node?.children ?? []) as { kind: string; id: string; children?: unknown[]; material?: string }[];
      node = children.find((c) => c.id === id);
      if (node === undefined) return undefined;
    }
    return node?.material;
  };

  const cores: CoreGeo[] = cs.cores.map((core) => {
    const { r, phi } = polarOf(core.cx, core.cy);
    return { core, r: r < 1e-6 ? 0 : r, phi: r < 1e-6 ? 0 : phi, layers: layersOf(core, elementMaterial), drain: core.layIndex === -2 };
  });

  const jacketR = cs.jacket.r;
  const figure8 = cs.outline !== undefined;
  const jacketInner = figure8 ? 0 : Math.max(0, cs.jacket.rInner);
  const omitted: string[] = [];
  const overallShieldRing = cs.overallShield;
  const overallFoil = overallShieldRing !== undefined && (overallShieldRing.construction === 'foil' || overallShieldRing.construction === 'tape');
  if (overallFoil && overallShieldRing !== undefined) omitted.push(`${overallShieldRing.elementPath}: ${overallShieldRing.construction} — never shown`);
  for (const core of cs.cores) {
    for (const ring of core.rings) {
      if (ring.construction === 'foil' || ring.construction === 'tape') omitted.push(`${ring.elementPath}: ${ring.construction} — never shown`);
    }
  }

  // one copper mass: every core screen in one bonded set (bonded multi-core)
  const coreScreens = cores.flatMap((c) => c.layers.filter((l) => l.role === 'shield').map((l) => l.ring.elementPath));
  const massSet = (wire.bonded ?? []).find((set) => coreScreens.length > 0 && coreScreens.every((p) => set.members.includes(p)));
  const mass = massSet !== undefined;

  const pieces: WirePiece[] = [];

  /* --- centrelines ------------------------------------------------- */

  // the radius of a core at x: its lay radius plus the splay past a jacket mouth
  // (a figure-8's legs are its jacket: their strip is the jacket strip)
  const mouthX = (end: 'a' | 'b'): number => fromTip(end, stripOf(end).jacketMm);
  // a gentle, natural fan past each mouth (cores leave the lay and ease apart),
  // plus the explode's splay; a function of x only, so the cores still instance
  const fan = figure8 ? 0 : FAN * cs.jacket.r;
  const fanRamp = (end: 'a' | 'b'): number => clamp(stripOf(end).jacketMm * 0.8, 4, 18);
  const splayAt = (x: number): number => {
    let s = 0;
    for (const end of ['a', 'b'] as const) {
      if ((end === 'a' && show === 'b') || (end === 'b' && show === 'a') || stripOf(end).jacketMm <= 0) continue;
      const past = end === 'a' ? mouthX('a') - x : x - mouthX('b');
      if (past <= 0) continue;
      // eases out of the mouth, then keeps opening slowly: a slight bend, not a kink
      const t = past / fanRamp(end);
      s = Math.max(s, fan * (smooth(t) * 0.8 + 0.2 * Math.min(1, past / Math.max(1, stripOf(end).jacketMm))) + radial * smooth(past / SPLAY_RAMP));
    }
    return s;
  };

  /** sample positions along [x0, x1]: helix turns, the splay ramps, and the ends */
  const samples = (x0: number, x1: number, rBase: number): number[] => {
    const xs = new Set<number>([r4(x0), r4(x1)]);
    if (rBase > 0 && twist) {
      const n = Math.min(maxSeg, Math.ceil((Math.abs(x1 - x0) / lay) * perTurn));
      for (let i = 1; i < n; i += 1) xs.add(r4(x0 + ((x1 - x0) * i) / n));
    }
    if (rBase > 0 && (radial > 0 || fan > 0)) {
      for (const end of ['a', 'b'] as const) {
        if ((end === 'a' && (show === 'b' || stripA.jacketMm <= 0)) || (end === 'b' && (show === 'a' || stripB.jacketMm <= 0))) continue;
        const m = mouthX(end);
        const reach = Math.max(SPLAY_RAMP, stripOf(end).jacketMm);
        const far = end === 'a' ? m - reach : m + reach;
        for (let i = 0; i <= 8; i += 1) {
          const x = m + ((far - m) * i) / 8;
          if (x > Math.min(x0, x1) && x < Math.max(x0, x1)) xs.add(r4(x));
        }
      }
    }
    let list = [...xs].sort((p, q) => p - q);
    if (list.length - 1 > maxSeg) {
      // decimate evenly, keeping both ends
      const keep: number[] = [];
      for (let i = 0; i <= maxSeg; i += 1) keep.push(list[Math.round((i * (list.length - 1)) / maxSeg)] as number);
      list = keep;
    }
    return list;
  };

  /** a core's centreline over [x0, x1], canonical (angle 0) */
  const coreLine = (rBase: number, x0: number, x1: number): Vec3[] =>
    samples(x0, x1, rBase).map((x) => {
      const r = rBase + (rBase > 0 ? splayAt(x) : 0);
      const a = k * x;
      return [x, r4(r * Math.cos(a)), r4(r * Math.sin(a))] as Vec3;
    });

  /** world position on a core's centreline */
  const coreAt = (geo: CoreGeo, x: number, outward = 0): Vec3 => {
    const r = geo.r + (geo.r > 0 ? splayAt(x) : 0) + outward;
    const a = k * x + (geo.r > 0 ? geo.phi : 0);
    return [x, r * Math.cos(a), r * Math.sin(a)];
  };

  const radialFor = (kind: WirePieceKind, r: number): number => {
    if (kind === 'jacket' || kind === 'filler' || kind === 'web') return 40;
    if (kind === 'pigtail') return 8;
    return r < 0.3 ? 8 : r < 0.8 ? 12 : 16;
  };

  const push = (piece: Omit<WirePiece, 'shapeKey' | 'radialSegments'> & { radialSegments?: number }, keyExtra: string): void => {
    const radialSegments = piece.radialSegments ?? radialFor(piece.kind, piece.rOuter);
    const shapeKey = [piece.kind, piece.material, r4(piece.rOuter), r4(piece.rInner), radialSegments, piece.caps.start, piece.caps.end, keyExtra].join('|');
    pieces.push({ ...piece, radialSegments, shapeKey });
  };

  /* --- per-core cut distances -------------------------------------- */

  interface Cuts {
    /** distance back from the tip each layer (innermost first) ends at */
    cut: number[];
    /** the shield stub's cut, when trimmed / folded / gathered */
    shieldIndex: number;
    foldLen: number;
    /** a trimmed / gathered screen's twisted lead, mm (0: none) */
    leadLen: number;
    slug: { from: number; to: number } | undefined;
    cutBack: boolean;
  }

  const cutsFor = (geo: CoreGeo, end: 'a' | 'b'): Cuts => {
    const s = stripOf(end);
    const J = figure8 ? 0 : s.jacketMm;
    const n = geo.layers.length;
    const cut = new Array<number>(n).fill(0);
    const cutBack =
      (s.cutCores ?? []).includes(geo.core.elementPath) || (geo.drain && s.drain === 'cut' && J > 0);
    if (cutBack) {
      const flush = Math.max(0, J - STUB);
      return { cut: cut.map(() => flush), shieldIndex: -1, foldLen: 0, leadLen: 0, slug: undefined, cutBack: true };
    }
    let shieldIndex = -1;
    let foldLen = 0;
    let leadLen = 0;
    // outermost first; each inner layer ends no further back than the one over it
    let outer = figure8 ? s.jacketMm : J;
    for (let i = n - 1; i >= 0; i -= 1) {
      const layer = geo.layers[i] as Layer;
      let c: number;
      if (layer.role === 'sheath') {
        c = figure8 ? s.jacketMm : Math.min(s.sheathMm, J > 0 ? J : s.sheathMm);
      } else if (layer.role === 'shield') {
        shieldIndex = i;
        const exposedTo = s.insulationMm;
        const unwound = Math.max(0, outer - exposedTo);
        if (s.shield === 'keep') c = exposedTo;
        else if (mass) c = outer;
        else if (s.shield === 'fold') {
          c = outer;
          foldLen = clamp(unwound, 0, 12);
        } else {
          // unwound off the dielectric right back to the sheath mouth (a lip of
          // it still showing there) and twisted into a lead: gathered whole, or
          // trimmed to its keep share (SW: ~80 % cut off)
          c = Math.max(exposedTo, outer - LIP);
          const keep = s.shield === 'gather' ? 1 : clamp(s.shieldKeepPct, 0, 100) / 100;
          leadLen = keep <= 0 || unwound <= 0 ? 0 : Math.max(MIN_LEAD, keep * unwound);
        }
      } else if (layer.role === 'conductor') {
        // a landed drain runs to the jacket mouth and on as a pigtail strand
        c = geo.drain && J > 0 ? J : 0;
      } else {
        c = s.insulationMm;
      }
      c = clamp(c, 0, outer);
      cut[i] = c;
      outer = c;
    }
    let slug: Cuts['slug'];
    // the SW leaves the stripped coax PE on; a plain core's PVC comes off
    const insIndex = geo.layers.findIndex((l) => l.role === 'dielectric');
    if (s.insulationSlidMm > 0 && insIndex >= 0) {
      const stripped = cut[insIndex] as number;
      const slide = Math.min(s.insulationSlidMm, stripped / 2);
      if (stripped > 0 && slide > 0) slug = { from: -slide, to: stripped - slide };
    }
    return { cut, shieldIndex, foldLen, leadLen, slug, cutBack: false };
  };

  /* --- visible intervals --------------------------------------------- */

  const clip = (iv: Interval): Interval | undefined => {
    const x0 = Math.max(iv.x0, X0);
    const x1 = Math.min(iv.x1, X1);
    return x1 - x0 > 1e-3 ? { ...iv, x0, x1 } : undefined;
  };

  /** [x0, x1] minus the part hidden inside [h0, h1] (shrunk by EPS) */
  const visible = (x0: number, x1: number, h0: number, h1: number, hidden: boolean): Interval[] => {
    if (!hidden || h1 - h0 <= 2 * EPS) return [{ x0, x1 }];
    const out: Interval[] = [];
    const a1 = Math.min(x1, h0 + EPS);
    if (a1 > x0) out.push({ x0, x1: a1, end: 'a' });
    const b0 = Math.max(x0, h1 - EPS);
    if (x1 > b0) out.push({ x0: b0, x1, end: 'b' });
    return out;
  };

  const shiftFor = (end: 'a' | 'b' | undefined, depth: number): number => (end === undefined || axial <= 0 ? 0 : (end === 'a' ? -1 : 1) * axial * depth);
  const moved = (points: Vec3[], dx: number): Vec3[] => (dx === 0 ? points : points.map(([x, y, z]) => [r4(x + dx), y, z] as Vec3));

  /* --- the cores ------------------------------------------------------ */

  const jacketRange: [number, number] = [fromTip('a', figure8 ? 0 : stripA.jacketMm), fromTip('b', figure8 ? 0 : stripB.jacketMm)];

  for (const geo of cores) {
    const cutsA = cutsFor(geo, 'a');
    const cutsB = cutsFor(geo, 'b');
    const n = geo.layers.length;
    const rotateDeg = r4(geo.phi * DEG);
    // the enclosing range for the outermost layer: the jacket, unless x-ray (or none: figure-8)
    let enclosing: [number, number] = jacketRange;
    let enclosingHides = !figure8 && !xray;
    for (let i = n - 1; i >= 0; i -= 1) {
      const layer = geo.layers[i] as Layer;
      const depth = n - i;
      const x0 = fromTip('a', cutsA.cut[i] as number);
      const x1 = fromTip('b', cutsB.cut[i] as number);
      if (x1 - x0 > 1e-3) {
        const kind: WirePieceKind = geo.drain ? 'drain' : layer.role;
        const rOuter = r4(layer.ring.r);
        const rInner = layer.role === 'conductor' ? 0 : r4(layer.ring.rInner);
        const layMm = layer.role === 'shield' ? 7 : undefined;
        visible(x0, x1, enclosing[0], enclosing[1], enclosingHides).forEach((iv, index) => {
          const c = clip(iv);
          if (c === undefined) return;
          const dx = shiftFor(c.end, depth);
          const cap: CapKind = rInner > 0 ? 'ring' : 'disk';
          const caps = { start: cap, end: cap };
          push(
            {
              id: `${geo.core.elementPath}:${layer.ring.elementPath.split('.').slice(1).join('.') || layer.role}:${layer.role}:${c.end ?? 'body'}${index > 0 && c.end === undefined ? `-${index}` : ''}`,
              elementPath: layer.ring.elementPath,
              kind,
              material: layer.material,
              ...(layer.colorName === undefined ? {} : { colorName: layer.colorName }),
              rOuter,
              rInner,
              points: moved(coreLine(geo.r, c.x0, c.x1), dx),
              rotateDeg,
              caps,
              ...(c.end === undefined ? {} : { end: c.end }),
              depth,
              ...(layMm === undefined ? {} : { layMm }),
              ...(layer.metal === undefined ? {} : { metal: layer.metal }),
            },
            `${r4(geo.r)}|${r4(c.x0)}|${r4(c.x1)}|${r4(dx)}`,
          );
        });
      }
      // the next layer in is hidden by this one (opaque), wherever this one is
      enclosing = [x0, x1];
      enclosingHides = true;
    }

    // folded screens, slugs and pigtail strands, per stripped end
    for (const end of ['a', 'b'] as const) {
      if ((end === 'a' && show === 'b') || (end === 'b' && show === 'a')) continue;
      const cuts = end === 'a' ? cutsA : cutsB;
      const s = stripOf(end);
      if (cuts.cutBack) continue;
      if (cuts.shieldIndex >= 0 && s.shield === 'fold' && cuts.foldLen > 0 && !mass) {
        const shield = geo.layers[cuts.shieldIndex] as Layer;
        const over = geo.layers[cuts.shieldIndex + 1];
        if (over !== undefined) {
          const edge = cuts.cut[cuts.shieldIndex] as number;
          const a = fromTip(end, edge);
          const b = fromTip(end, edge + cuts.foldLen);
          const thick = Math.max(0.05, shield.ring.r - shield.ring.rInner);
          const depth = n - cuts.shieldIndex;
          push(
            {
              id: `${geo.core.elementPath}:fold:${end}`,
              elementPath: shield.ring.elementPath,
              kind: 'fold',
              material: shield.material,
              rOuter: r4(over.ring.r + thick * 1.5),
              rInner: r4(over.ring.r),
              points: moved(coreLine(geo.r, Math.min(a, b), Math.max(a, b)), shiftFor(end, depth)),
              rotateDeg,
              caps: { start: 'ring', end: 'ring' },
              end,
              depth,
              layMm: 7,
              ...(shield.metal === undefined ? {} : { metal: shield.metal }),
            },
            `${r4(geo.r)}|${r4(Math.min(a, b))}|${r4(Math.max(a, b))}|${end}`,
          );
        }
      }
      if (cuts.slug !== undefined) {
        const insIndex = geo.layers.findIndex((l) => l.role === 'dielectric');
        const ins = geo.layers[insIndex] as Layer;
        const a = end === 'a' ? cuts.slug.from : length - cuts.slug.to;
        const b = end === 'a' ? cuts.slug.to : length - cuts.slug.from;
        const depth = n - insIndex;
        push(
          {
            id: `${geo.core.elementPath}:slug:${end}`,
            elementPath: ins.ring.elementPath,
            kind: 'slug',
            material: ins.material,
            ...(ins.colorName === undefined ? {} : { colorName: ins.colorName }),
            rOuter: r4(ins.ring.r),
            rInner: r4(ins.ring.rInner),
            points: moved(coreLine(geo.r, a, b), shiftFor(end, depth)),
            rotateDeg,
            // solid where it overhangs the tip: no hollow end
            caps: end === 'a' ? { start: 'disk', end: 'ring' } : { start: 'ring', end: 'disk' },
            end,
            depth,
          },
          `${r4(geo.r)}|${r4(a)}|${r4(b)}|${end}`,
        );
      }
    }
  }

  /* --- leads: each screen twisted on its own core; the drain; a bonded mass --- */

  const drainGeo = cores.find((g) => g.drain);
  const rootScreen = !overallFoil && overallShieldRing !== undefined ? overallShieldRing : undefined;
  // the outer ring of cores, for the valleys a drain or a mass comes out through
  const pitch = cores.reduce((m, g) => (g.drain ? m : Math.max(m, g.r)), 0);
  const ring = cores.filter((g) => !g.drain && pitch > 0 && g.r > pitch * 0.75);
  const ringCoreR = ring.reduce((m, g) => Math.max(m, g.layers.at(-1)?.ring.r ?? 0), 0);
  /** the valley between two outer cores nearest `phi` */
  const valleyNear = (phi: number): number => {
    const angles = ring.map((g) => ((g.phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((p, q) => p - q);
    if (angles.length < 2) return phi;
    let best = phi;
    let bestGap = Infinity;
    angles.forEach((a, i) => {
      const next = i + 1 < angles.length ? (angles[i + 1] as number) : (angles[0] as number) + 2 * Math.PI;
      const mid = (a + next) / 2;
      const gap = Math.abs(Math.atan2(Math.sin(mid - phi), Math.cos(mid - phi)));
      if (gap < bestGap) {
        bestGap = gap;
        best = Math.atan2(Math.sin(mid), Math.cos(mid));
      }
    });
    return best;
  };
  /**
   * Where a gathered lead (a bonded mass, an overall screen) leaves the
   * bundle: toward the board face it lands on, else the drain's valley (it
   * is twisted in), else the near side a default view looks at (+z).
   */
  const gatherVia = (face: 'top' | 'bottom' | undefined): number =>
    valleyNear(face === 'top' ? 0 : face === 'bottom' ? Math.PI : drainGeo !== undefined ? drainGeo.phi : Math.PI / 2);

  /** a point `off` mm straight out from a core's centreline, `d` mm back from the tip — canonical (before its turn) */
  const onCore = (rBase: number, end: 'a' | 'b', d: number, off: number): Vec3 => {
    const x = fromTip(end, d);
    const r = rBase + (rBase > 0 ? splayAt(x) : 0) + off;
    const a = k * x;
    return [r4(x), r4(r * Math.cos(a)), r4(r * Math.sin(a))];
  };
  const aimSign = (face: 'top' | 'bottom' | undefined): number => (face === 'top' ? 1 : face === 'bottom' ? -1 : 0);
  const leadArea = (ring: CrossSectionRing, fill: number): number => Math.PI * (ring.r ** 2 - ring.rInner ** 2) * fill;

  /**
   * A lead out of the jacket mouth through the valley nearest `fromPhi`, then
   * along the outside of the bundle toward the tip, ending `reachD` mm from
   * it — a landed drain, a gathered mass. World frame. `bend` mm: the last
   * stretch eases toward the board face (+y top, −y bottom).
   */
  const mouthLead = (end: 'a' | 'b', fromR: number, fromPhi: number, radius: number, reachD: number, bend: number): Vec3[] => {
    const J = stripOf(end).jacketMm;
    const via = valleyNear(fromPhi);
    const outR = Math.max(fromR, pitch + ringCoreR + radius * 0.9);
    const exitD = Math.max(reachD + 1, J - 5);
    const stops: [number, number, number][] = [
      [J + EPS * 0.6, fromR, fromPhi],
      [J - 0.4, fromR, fromPhi],
      [Math.max(exitD, J - 2.5), (fromR + outR) / 2, via],
      [exitD, outR, via],
      [reachD, outR + 0.3, via],
    ];
    const pts: Vec3[] = [];
    for (let i = 0; i < stops.length - 1; i += 1) {
      const [d0, r0, p0] = stops[i] as [number, number, number];
      const [d1, r1, p1] = stops[i + 1] as [number, number, number];
      if (i > 0 && Math.abs(d1 - d0) < 1e-3) continue;
      const steps = i === 0 ? 1 : Math.max(2, Math.min(6, Math.round(Math.abs(d0 - d1) / 2)));
      for (let j = i === 0 ? 0 : 1; j <= steps; j += 1) {
        const t = smooth(j / steps);
        const d = d0 + (d1 - d0) * (j / steps);
        const x = fromTip(end, d);
        const r = r0 + (r1 - r0) * t + (d < J ? splayAt(x) : 0);
        const dp = Math.atan2(Math.sin(p1 - p0), Math.cos(p1 - p0));
        const phi = p0 + dp * t;
        const lift = d < exitD ? bend * smooth((exitD - d) / Math.max(1, exitD - reachD)) : 0;
        pts.push([r4(x), r4(r * Math.cos(phi) + lift), r4(r * Math.sin(phi))]);
      }
    }
    return pts;
  };

  for (const end of ['a', 'b'] as const) {
    if ((end === 'a' && show === 'b') || (end === 'b' && show === 'a')) continue;
    const s = stripOf(end);
    if (s.jacketMm <= 0 || figure8) continue;
    const J = s.jacketMm;
    const faces = s.leads ?? {};

    if (mass) {
      if (s.shield === 'keep') continue;
      // one copper mass: every core screen unwound back to the jacket and
      // twisted into ONE lead (owner: "indicate it together, once")
      let area = 0;
      let metal: 'copper' | 'tinned' = 'copper';
      for (const g of cores) {
        for (const l of g.layers) {
          if (l.role !== 'shield') continue;
          area += leadArea(l.ring, 0.5);
          if (/tinn/i.test(elementMaterial(l.ring.elementPath) ?? '')) metal = 'tinned';
        }
      }
      if (drainGeo !== undefined) area += Math.PI * (drainGeo.layers[0]?.ring.r ?? 0) ** 2;
      const r = Math.max(0.25, Math.sqrt(area / Math.PI));
      const reach = clamp(J * 0.45, s.insulationMm + 2, J - 4);
      push(
        {
          id: `mass:pigtail:${end}`,
          elementPath: 'mass',
          kind: 'pigtail',
          material: 'spiral',
          metal,
          layMm: 4,
          rOuter: r4(r),
          rInner: 0,
          points: moved(mouthLead(end, jacketInner * 0.5, gatherVia(faces['mass']), r, reach, aimSign(faces['mass']) * 2), shiftFor(end, 1)),
          rotateDeg: 0,
          caps: { start: 'disk', end: 'disk' },
          end,
          depth: 1,
        },
        `mass:pigtail:${end}`,
      );
      continue;
    }

    for (const g of cores) {
      const cuts = cutsFor(g, end);
      if (cuts.cutBack) continue;
      if (g.drain) {
        if (s.drain !== 'land') continue;
        // out through its valley and along the bundle, ready to twist in with the leads
        const rd = Math.max(0.12, g.layers[0]?.ring.r ?? 0.18);
        const reach = Math.min(s.sheathMm > 0 ? s.sheathMm + 1 : s.insulationMm + 3, J - 6);
        push(
          {
            id: `${g.core.elementPath}:pigtail:${end}`,
            elementPath: g.core.elementPath,
            kind: 'pigtail',
            material: 'spiral',
            metal: g.layers[0]?.material === 'tinned' ? 'tinned' : 'copper',
            layMm: 1.6,
            rOuter: r4(rd),
            rInner: 0,
            points: moved(mouthLead(end, g.r, g.phi, rd, Math.max(0.5, reach), aimSign(faces['drain']) * 1.5), shiftFor(end, 1)),
            rotateDeg: 0,
            caps: { start: 'disk', end: 'disk' },
            end,
            depth: 1,
          },
          `${g.core.elementPath}:pigtail:${end}`,
        );
        continue;
      }
      if (cuts.shieldIndex < 0 || cuts.leadLen <= 0) continue;
      const shield = g.layers[cuts.shieldIndex] as Layer;
      const over = g.layers[cuts.shieldIndex + 1];
      const rD = shield.ring.rInner;
      const rS = (over ?? shield).ring.r;
      const rl = Math.max(0.15, Math.sqrt(leadArea(shield.ring, 0.8) / Math.PI));
      const edge = cuts.cut[cuts.shieldIndex] as number;
      const depth = g.layers.length - cuts.shieldIndex;
      const face = faces[g.core.elementPath];
      const look = { material: 'spiral' as const, metal: shield.metal ?? ('copper' as const), layMm: 2.2 };
      if (face === undefined) {
        // trimmed and folded back: off the lip, over the sheath mouth, back along the sheath
        const mouth = edge + LIP;
        const back = Math.max(mouth + 1, Math.min(mouth + cuts.leadLen, J - 1));
        // a soft U-turn, then lying on the sheath and easing off it toward its cut end
        const profile: [number, number][] = [
          [edge, rD + rl * 0.5],
          [edge - 0.3, (rD + rS) / 2 + rl * 0.6],
          [edge - 0.2, rS + rl * 0.5],
          [mouth + 0.1, rS + rl * 0.95],
          [mouth + 0.7, rS + rl * 0.9],
        ];
        for (let i = 1; i <= 3; i += 1) profile.push([mouth + 0.7 + ((back - mouth - 0.7) * i) / 3, rS + rl * (0.9 + 0.25 * i)]);
        push(
          {
            id: `${g.core.elementPath}:pigtail:${end}`,
            elementPath: shield.ring.elementPath,
            kind: 'pigtail',
            ...look,
            rOuter: r4(rl),
            rInner: 0,
            points: moved(
              profile.map(([d, off]) => onCore(g.r, end, d, off)),
              shiftFor(end, depth),
            ),
            rotateDeg: r4(g.phi * DEG),
            caps: { start: 'disk', end: 'disk' },
            end,
            depth,
          },
          `lead|${r4(g.r)}|${r4(edge)}|${r4(back)}|${end}`,
        );
        continue;
      }
      // a design's build: off the lip, forward and over toward the face its pigtail lands on
      const sign = aimSign(face);
      const tipD = Math.max(0.5, edge - cuts.leadLen);
      const pts: Vec3[] = [];
      for (let i = 0; i <= 6; i += 1) {
        const t = i / 6;
        const d = edge + (tipD - edge) * t;
        const x = fromTip(end, d);
        const [, cy, cz] = coreAt(g, x);
        const off = rD * 0.8 + (rS + rl + 0.8 - rD * 0.8) * smooth(t * 1.3);
        pts.push([r4(x), r4(cy + sign * off), r4(cz)]);
      }
      push(
        {
          id: `${g.core.elementPath}:pigtail:${end}`,
          elementPath: shield.ring.elementPath,
          kind: 'pigtail',
          ...look,
          rOuter: r4(rl),
          rInner: 0,
          points: moved(pts, shiftFor(end, depth)),
          rotateDeg: 0,
          caps: { start: 'disk', end: 'disk' },
          end,
          depth,
        },
        `${g.core.elementPath}:pigtail:${end}`,
      );
    }
    if (rootScreen !== undefined && s.shield !== 'keep') {
      const r = Math.max(0.2, Math.sqrt(leadArea(rootScreen, 0.6) / Math.PI));
      push(
        {
          id: `${rootScreen.elementPath}:pigtail:${end}`,
          elementPath: rootScreen.elementPath,
          kind: 'pigtail',
          material: 'spiral',
          metal: 'tinned',
          layMm: 4,
          rOuter: r4(r),
          rInner: 0,
          points: moved(mouthLead(end, rootScreen.rInner, gatherVia(faces['mass']), r, clamp(J * 0.45, s.insulationMm + 2, J - 4), 0), shiftFor(end, 1)),
          rotateDeg: 0,
          caps: { start: 'disk', end: 'disk' },
          end,
          depth: 1,
        },
        `${rootScreen.elementPath}:pigtail:${end}`,
      );
    }
  }

  /* --- the overall copper screen (a braid or spiral, never a foil) ------ */

  if (rootScreen !== undefined) {
    const x0 = fromTip('a', stripA.jacketMm);
    const x1 = fromTip('b', stripB.jacketMm);
    for (const iv of visible(x0, x1, x0, x1, !xray)) {
      const c = clip(iv);
      if (c === undefined) continue;
      push(
        {
          id: `${rootScreen.elementPath}:shield:${c.end ?? 'body'}`,
          elementPath: rootScreen.elementPath,
          kind: 'shield',
          material: rootScreen.construction === 'braid' ? 'braid' : 'spiral',
          rOuter: r4(rootScreen.r),
          rInner: r4(rootScreen.rInner),
          points: [
            [r4(c.x0), 0, 0],
            [r4(c.x1), 0, 0],
          ],
          rotateDeg: 0,
          caps: { start: 'ring', end: 'ring' },
          ...(c.end === undefined ? {} : { end: c.end }),
          depth: 1,
          layMm: 7,
          metal: conductorMaterial(elementMaterial(rootScreen.elementPath)) === 'tinned' ? 'tinned' : 'copper',
        },
        `${r4(c.x0)}|${r4(c.x1)}`,
      );
    }
  }

  /* --- the jacket, the web, the filler --------------------------------- */

  const straight = (x0: number, x1: number): Vec3[] => [
    [r4(x0), 0, 0],
    [r4(x1), 0, 0],
  ];
  if (!figure8) {
    const c = clip({ x0: jacketRange[0], x1: jacketRange[1] });
    if (c !== undefined) {
      push(
        {
          id: 'jacket',
          elementPath: cs.jacket.elementPath,
          kind: 'jacket',
          material: 'pvc',
          ...(cs.jacket.colorName === undefined ? {} : { colorName: cs.jacket.colorName }),
          rOuter: r4(jacketR),
          rInner: r4(jacketInner),
          points: straight(c.x0, c.x1),
          rotateDeg: 0,
          // a break (a one-end view) is a solid face, not a hollow tube
          caps: { start: breakA ? 'disk' : 'ring', end: breakB ? 'disk' : 'ring' },
          depth: 0,
          ...(xray ? { opacity: 0.28 } : {}),
        },
        'jacket',
      );
    }
    // the cut face: the filler and strings cut off just inside the mouth (a
    // recipe's `overall.filler`), else the shadowed bore between the cores —
    // never an empty tube to look down
    if (options.filler === true || !xray) {
      for (const end of ['a', 'b'] as const) {
        if ((end === 'a' && show === 'b') || (end === 'b' && show === 'a')) continue;
        if (stripOf(end).jacketMm <= 0) continue;
        const m = fromTip(end, stripOf(end).jacketMm);
        const filled = options.filler === true;
        const inward = end === 'a' ? 1 : -1;
        const near = m + inward * (filled ? 0.5 : 1.2);
        const far = near + inward * 0.3;
        const f = clip({ x0: Math.min(near, far), x1: Math.max(near, far) });
        if (f === undefined) continue;
        push(
          {
            id: `filler:${end}`,
            elementPath: 'filler',
            kind: 'filler',
            material: filled ? 'filler' : 'bore',
            rOuter: r4(Math.max(0, jacketInner - 0.02)),
            rInner: 0,
            points: straight(f.x0, f.x1),
            rotateDeg: 0,
            caps: { start: 'disk', end: 'disk' },
            end,
            depth: 0,
          },
          `filler|${end}`,
        );
      }
    }
  } else if (cs.outline !== undefined) {
    // the web between a figure-8's legs, as far as the legs' jackets run
    const legs = cores.filter((g) => !g.drain && g.core.layIndex >= 0);
    const web = cs.outline.webHalf;
    const x0 = fromTip('a', stripA.jacketMm);
    const x1 = fromTip('b', stripB.jacketMm);
    const c = clip({ x0, x1 });
    if (c !== undefined && legs.length === 2 && web > 0) {
      push(
        {
          id: 'web',
          elementPath: cs.jacket.elementPath,
          kind: 'web',
          material: 'pvc',
          ...(cs.jacket.colorName === undefined ? {} : { colorName: cs.jacket.colorName }),
          rOuter: r4(web),
          rInner: 0,
          points: straight(c.x0, c.x1),
          rotateDeg: 0,
          caps: { start: 'disk', end: 'disk' },
          depth: 0,
        },
        'web',
      );
    }
  }

  /* --- totals ----------------------------------------------------------- */

  let reach = jacketR;
  let triangles = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pieces) {
    for (const [x, y, z] of p.points) {
      reach = Math.max(reach, Math.hypot(y, z) + p.rOuter);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    const walls = p.rInner > 0 ? 2 : 1;
    const capTris = (kind: CapKind): number => (kind === 'none' ? 0 : kind === 'ring' && p.rInner > 0 ? 2 : 1);
    triangles += (p.points.length - 1) * p.radialSegments * 2 * walls + (capTris(p.caps.start) + capTris(p.caps.end)) * p.radialSegments;
  }

  return {
    wire: wire.id,
    label: wire.label,
    lengthMm: length,
    odMm: cs.odMm,
    span: pieces.length === 0 ? span : [r4(Math.min(minX, span[0])), r4(Math.max(maxX, span[1]))],
    reach: r4(reach),
    pieces,
    omitted,
    layLengthMm: r4(lay),
    layInferred,
    triangles,
  };
}
