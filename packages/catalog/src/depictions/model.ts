/**
 * Depiction asset model — the `meta.json` schema of `specs/depictions.md`.
 *
 * Depictions are **presentation assets, not truth**. Nothing in `core` or in
 * the catalog's electrical JSON ever references one: they are keyed by
 * definition id and the renderer picks them up opportunistically, falling back
 * to the abstract block when a definition has none.
 *
 * Storage layout (one directory per definition id):
 *
 *     packages/catalog/depictions/<def-id>/<view>.svg   the artwork
 *     packages/catalog/depictions/<def-id>/meta.json    the manifest below
 *
 * Everything here is plain JSON-serialisable data. No coordinates leak into
 * `core`; millimetres are the only unit that crosses the boundary, via
 * `mmPerUnit`.
 */

/* ------------------------------------------------------------------ *
 * Vocabularies
 * ------------------------------------------------------------------ */

/**
 * The view kinds a depiction may carry. `solder-side` and `board-bottom` are
 * the mirrored counterparts of `mating-face` and `board-top`; per the spec a
 * mirrored view is **never** hand-anchored — it declares `mirrorOf` and the
 * tool reflects the one anchor set into it.
 */
export const DEPICTION_VIEWS = [
  'schematic-symbol',
  'mating-face',
  'solder-side',
  'board-top',
  'board-bottom',
  'illustration',
] as const;

export type DepictionView = (typeof DEPICTION_VIEWS)[number];

export function isDepictionView(value: string): value is DepictionView {
  return (DEPICTION_VIEWS as readonly string[]).includes(value);
}

/** Vector art is inlined by the renderer; raster art is embedded as a data URI. */
export const ASSET_KINDS = ['vector', 'raster'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Where the artwork came from — the rungs of the spec's input ladder.
 * `gerber` is the production fabrication output rendered by
 * `scripts/import-gerbers.ts` (real outline, copper, mask, silk, drills; the
 * anchors still come from the `.kicad_pcb`).
 */
export const SOURCE_KINDS = [
  'kicad',
  'gerber',
  'dxf',
  'step',
  'svg',
  'pdf',
  'photo',
  'hand',
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Which axis a mirrored view is reflected across. `x` reflects horizontally
 * (left↔right, the board flipped about its vertical centre line — what looking
 * at the other side of a PCB actually does); `y` reflects vertically.
 */
export const MIRROR_AXES = ['x', 'y'] as const;

export type MirrorAxis = (typeof MIRROR_AXES)[number];

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

/**
 * One piece of artwork.
 *
 * `widthUnits` / `heightUnits` are the asset's frame in its own units (for an
 * SVG, the viewBox extent). They are what makes reflection possible, so a view
 * that declares `mirrorOf` must carry them; the generator always emits them.
 */
export interface DepictionAsset {
  /** File name inside the definition's depiction directory. No path separators. */
  file: string;
  kind: AssetKind;
  /** Millimetres per artwork unit. Board art is drawn mm-true, so 1. */
  mmPerUnit: number;
  sourceKind: SourceKind;
  /** Frame width in artwork units. */
  widthUnits?: number;
  /** Frame height in artwork units. */
  heightUnits?: number;
  /** This view is the reflection of the named view; its anchors derive. */
  mirrorOf?: DepictionView;
  /** Reflection axis for `mirrorOf`. Defaults to `x`. */
  mirrorAxis?: MirrorAxis;
  src: string;
}

/**
 * Where one logical pin/pad/terminal sits, in `anchorFrame`'s coordinates
 * (artwork units, origin top-left, +y down — SVG's own convention).
 *
 * `note` carries anchoring provenance the electrical model has no room for:
 * which physical pad of a collapsed terminal was chosen, or that two pins of
 * an edge-card connector share one x/y across layers.
 */
export interface PinAnchor {
  x: number;
  y: number;
  note?: string;
  /**
   * Which copper side the anchor's (primary) pad is on. Absent on depictions
   * that predate side-aware anchors (the pinmaps-generated tier): treat those
   * as "unknown side", drawn on the anchor frame only (`sideAnchors`).
   */
  side?: AnchorSide;
  /**
   * The direction a wire physically comes in to this (primary) pad —
   * degrees, standard math convention (0 = +x, 90 = +y, this frame's own +y
   * is down), same units as `x`/`y` (artwork units in `anchorFrame`, mm once
   * `anchorsMm` scales it — a pure rotation, so the angle itself is
   * unaffected by that scale). Repeats `pads[0].approach`.
   *
   * Gerber tier only, and only when the KiCad pad orientation says something
   * (`gerberPinAnchors`): the pad's own long axis (an elongated wire-landing
   * pad — a "finger" — points along the direction wires actually lay down on
   * it) rotated by the pad's absolute KiCad orientation; a square/round pad
   * (no long axis of its own) uses the same family's local +y convention.
   * Either way the sign is resolved to point *away* from the board's own
   * bounding-box centre — outward, off the board, where the wire comes from.
   * A mirrored view (`board-bottom`) reflects it exactly as it reflects
   * `x`/`y` (`anchors.ts`'s `reflect`). Absent on a legacy (pinmaps-tier)
   * anchor, or a pad the KiCad file gives no orientation for — the renderer
   * then keeps today's straight-in lead, unchanged.
   */
  approach?: number;
  /**
   * The pad's own extent parallel and perpendicular to `approach` — `[along,
   * across]`, artwork units, same scaling as `x`/`y` (mm once `anchorsMm`
   * scales it; unlike a position, a length is unchanged by mirroring or
   * turning, so this is the one field `anchors.ts` never transforms).
   * `along` is the long dimension of an elongated pad (the one `approach`'s
   * axis runs on); for a square/round pad they are equal. Present exactly
   * when `approach` is — a renderer needs a pad's own
   * footprint size to route another wire's lead clear of it.
   */
  size?: readonly [number, number];
  /**
   * Every physical pad that lands this terminal, **primary first** (so
   * `pads[0]` repeats `x`/`y`/`side`) — a collapsed terminal such as a GND
   * keeps every pad it lands on. Present on side-aware anchors; absent on
   * legacy ones (use `anchorPads`). Same frame as `x`/`y`; a mirrored view
   * reflects these too.
   *
   * Primary-pad rule (gerber tier): the first pad in the reviewed KiCad map's
   * order that is visible from the **top** (`top` or through-hole `both` — the
   * default `board-top` view shows it), else the first pad in map order.
   */
  pads?: AnchorPad[];
}

/**
 * Copper side of an anchored pad. `both` = a plated through-hole pad, reachable
 * from either side. Side-aware anchors are always authored in the `board-top`
 * frame (board seen from above); the `board-bottom` view (seen from below) is a
 * mirror about x, so its anchors derive by reflection (`anchorsFor`).
 */
export const ANCHOR_SIDES = ['top', 'bottom', 'both'] as const;

export type AnchorSide = (typeof ANCHOR_SIDES)[number];

/** One physical pad of a (possibly multi-pad) terminal anchor. */
export interface AnchorPad {
  /** Footprint reference, e.g. `GND4`. */
  ref: string;
  /** Pad number within the footprint. */
  pad: string;
  x: number;
  y: number;
  side: AnchorSide;
  /** See `PinAnchor.approach` — this pad's own wire-approach direction. */
  approach?: number;
  /** See `PinAnchor.size` — this pad's own `[along, across]` extent. */
  size?: readonly [number, number];
}

/** One file a depiction was derived from, pinned by content hash. */
export interface DepictionSourceFile {
  /** What the file is, e.g. `gerber-zip`, `kicad-pcb`. */
  role: string;
  /** Path relative to the board files root an importer reads. */
  path: string;
  sha256: string;
}

/**
 * The per-definition manifest: `packages/catalog/depictions/<defId>/meta.json`.
 *
 * One anchor set for the whole definition, expressed in `anchorFrame`'s
 * coordinates. Every other view either shares that frame or declares
 * `mirrorOf` and gets its anchors reflected (`anchorsFor`).
 */
export interface DepictionMeta {
  defId: string;
  /** Keyed by `DepictionView`; a plain record so unknown keys survive to validation. */
  views: Record<string, DepictionAsset>;
  pinAnchors: Record<string, PinAnchor>;
  /** The view whose frame `pinAnchors` is expressed in. Never a mirrored view. */
  anchorFrame: DepictionView;
  /**
   * Machine-readable provenance: the exact source files (and their sha256)
   * the artwork and anchors were rendered from. Gerber depictions carry it so
   * a later run can tell when the production files moved on. The prose `src`
   * cites the same files.
   */
  sources?: DepictionSourceFile[];
  /**
   * The parts mounted on the board **for this build**,
   * in the anchor frame (`board-top`, mm). Gerber tier only; presentation, not
   * truth — the electrical build facts stay in the definition.
   */
  components?: BoardComponents;
  /**
   * The board's ordered solder mask / silkscreen colour and copper finish,
   * baked into `board-top.svg`/`board-bottom.svg` at
   * generation (`recolorBoardSvg`) — this field is provenance, not a render
   * instruction. Gerber tier only.
   */
  color?: BoardColor;
  /**
   * Human-set wire entry guides for the board's angled pad rows.
   * Copied verbatim from the reviewed
   * `data/kicad-maps/<defId>.json` (`entryGuides`) — the hand-authored input
   * that survives regeneration — by `import-gerbers` and by the studio's
   * guide save. Presentation only.
   */
  entryGuides?: EntryGuide[];
  src: string;
}

/**
 * One angled pad row's wire entry guide: a line
 * segment in the anchor frame (`board-top`, mm), parallel to the row's board
 * edge and just outside the outline. A wire to one of `pads` reaches its slot
 * on this line (slots in `pads` order from `from` to `to`) off the board, then
 * runs straight to the pad — the only stretch drawn over the board.
 */
export interface EntryGuide {
  /** the face whose pads it serves; bottom pads are still in the top frame */
  side: 'top' | 'bottom';
  /** footprint refs of the pads it serves, in slot order from `from` to `to` */
  pads: string[];
  from: readonly [number, number];
  to: readonly [number, number];
  /** who set it, and when */
  src: string;
}

/**
 * The resolved, board-specific colour a gerber depiction carries (see
 * `depictions/color.ts` for the palette and the SVG recolouring).
 */
export interface BoardColor {
  /** KiCad colour name (`Purple`, `Green`, …), as ordered/stackup-configured. */
  mask: string;
  maskHex: string;
  silk: string;
  silkHex: string;
  copperFinish?: string;
  copperHex?: string;
  /** True when neither the stackup nor a reviewed README citation named a colour (the fab default was assumed). */
  inferred?: boolean;
  src: string;
}

/* ------------------------------------------------------------------ *
 * Board components (gerber tier)
 * ------------------------------------------------------------------ */

export const BOARD_PART_KINDS = [
  'resistor',
  'capacitor',
  'ic',
  'jumper',
  'switch',
  'connector',
  'diode',
  'inductor',
  'transistor',
] as const;

export type BoardPartKind = (typeof BOARD_PART_KINDS)[number];

/**
 * `fitted` — a part is placed. A solder jumper is `bridged` (a solder bridge,
 * or a 0 Ω part placed across it — then `label` is `0R`), `open`, or `unset`
 * when the build records no choice for it.
 */
export const BOARD_PART_STATES = ['fitted', 'bridged', 'open', 'unset'] as const;

export type BoardPartState = (typeof BOARD_PART_STATES)[number];

/**
 * The physical package family a part's footprint names:
 * what a renderer draws instead of a labelled box. Detected from the KiCad
 * library id (`Resistor_SMD:R_0805_2012Metric`, `Package_SO:SOIC-8_…`); a
 * kind/value combination the importer does not recognise carries no
 * `package` at all, and every renderer falls back to the plain outlined box
 * — the one house style every part has always had, never nothing.
 */
export const PART_PACKAGE_FAMILIES = [
  'chip-r',
  'chip-c',
  'tantalum',
  'electrolytic',
  'soic',
  'sot',
  'diode',
  'led',
] as const;

export type PartPackageFamily = (typeof PART_PACKAGE_FAMILIES)[number];

export interface PartPackage {
  family: PartPackageFamily;
  /** `soic`/`sot` only: pin count, from the footprint's real (non-mechanical) pads. */
  pins?: number;
  /** `soic`/`sot` only: lead pitch in mm, measured from the real pad spacing. */
  pitch?: number;
}

export interface BoardPart {
  /** Reference designator as the board file spells it (`R203`). */
  ref: string;
  kind: BoardPartKind;
  /** The copper side the part is mounted on. */
  side: 'top' | 'bottom';
  state: BoardPartState;
  /** The board file's Value, when it names the part (`180R`, `220uF`, `LM1881M_NOPB`). */
  value?: string;
  /** Short value for a drawing (`180R`, `220µ`, `0R`, `LM1881M`). */
  label?: string;
  /** Body centre, anchor frame. */
  x: number;
  y: number;
  /** Footprint rotation, degrees, counter-clockwise on screen (KiCad's sense). */
  rotation: number;
  /** Body outline: four corners, anchor frame, in order. */
  outline: [number, number][];
  /** Pin 1 (IC) / positive pad (polarised capacitor) / cathode (diode) centre, anchor frame. */
  pin1?: [number, number];
  /** The package a top-down drawing renders as a real body, not a box. */
  package?: PartPackage;
  /**
   * The footprint's numbered pads — each copper centre in the anchor frame, in
   * pad-number order: what a
   * drawing lands the part's pins on, so its orientation and position come
   * from the KiCad placement, never from a hand value or the body's aspect.
   */
  pads?: PartPad[];
}

/** One numbered pad of a mounted part (`BoardPart.pads`). */
export interface PartPad {
  /** pad number as the board file writes it (`"1"`) */
  pad: string;
  x: number;
  y: number;
}

export interface BoardComponents {
  /** The build these parts are populated for (`CPL Basic`, `as-designed`). */
  build: string;
  /**
   * `placement-file` — populated = the build's Fabrication CPL, less the
   * build's omitted parts; `as-designed` — the board has no placement file,
   * so every part on the board file counts as fitted unless the build omits it.
   */
  basis: 'placement-file' | 'as-designed';
  parts: BoardPart[];
  src: string;
}

/** Everything the catalog knows about depictions, keyed by definition id. */
export type DepictionIndex = Record<string, DepictionMeta>;

/* ------------------------------------------------------------------ *
 * House style
 * ------------------------------------------------------------------ */

/**
 * The one style guide the spec asks for. Every generated asset — and every
 * imported one, once `import-depiction` lands — is
 * normalised to it: monochrome line art on `currentColor`, mm-true, with
 * stroke weights that stay legible when a board is scaled into a schematic.
 *
 * All values are millimetres.
 */
export const HOUSE_STYLE = {
  /** Board / part outlines. */
  strokeOutline: 0.25,
  /** Pads, pins, anchorable copper. */
  strokePad: 0.15,
  /** Non-electrical detail: jumpers, component bodies, silkscreen. */
  strokeDetail: 0.12,
  /** Cable-side conductor pad. */
  padRadius: 0.75,
  /** Connector footprint pin, drawn square so it reads apart from a pad. */
  pinSize: 1.2,
  fontSize: 1.0,
  /** Gap between a pad centre and its label baseline. */
  labelOffset: 1.5,
  /** Distance from the outermost copper to the drawn outline. */
  outlinePadding: 2.0,
  /**
   * Extra frame outside the outline so a pad label on the board edge is not
   * clipped by the viewBox. Artwork, not board.
   */
  labelMargin: 1.0,
  /** Coordinates and lengths are rounded to this many decimal places. */
  precision: 2,
} as const;

/** Round to the house precision, normalising `-0` so output is byte-stable. */
export function round(value: number): number {
  const factor = 10 ** HOUSE_STYLE.precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}
