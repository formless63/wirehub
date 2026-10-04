/**
 * The **diagram model** — pure positioned data, no SVG.
 *
 * `layoutSchematic(design, db)` turns the canonical electrical model into the
 * shapes below; `@wirehub/render-svg` turns those into a drawing. Nothing
 * here knows about strokes, colours or fonts: a track carries the conductor's
 * *colour name* from the catalog, never a hex value, and the renderer decides
 * how to paint it. All coordinates are millimetres, origin top-left, y down.
 */

import type { Issue } from '@wirehub/model';
import type { BoardPart } from '@wirehub/catalog';

import type { ArtLabel, ArtShape, ArtView, ConnectorPinArt } from './connector-art.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which face of a block/symbol/track-end a wire leaves from. */
export type Side = 'left' | 'right';

/** Where an instance sits in the left→right source→destination story. */
export type Zone = 'source' | 'dest' | 'branch';

/* ------------------------------------------------------------------ *
 * Anchors
 * ------------------------------------------------------------------ */

/**
 * The single point in the drawing that represents one electrical terminal.
 * Every joint is routed between two anchors, and every joint dot sits on one.
 */
export interface Anchor {
  /** core terminal key: `j1:6`, `w1:core-red.center@a`, `u2:scart.15` */
  key: string;
  x: number;
  y: number;
  /** the direction a wire leaves in: -1 = leftwards, +1 = rightwards */
  dir: -1 | 1;
  owner: 'block' | 'track' | 'component';
  instance: string;
  /** the physical pad of a multi-pad board terminal this anchor stands for */
  pad?: string;
}

/* ------------------------------------------------------------------ *
 * Blocks — connectors and PCBAs
 * ------------------------------------------------------------------ */

/**
 * A pin callout beside a depicted block: the textual truth for one port,
 * parked in a gutter clear of the artwork and tied back to its pad by a
 * leader. Artwork augments the labels; it never replaces them.
 */
export interface DiagramCallout {
  /** `id` for a connector pin, `id · label` when the label says more */
  text: string;
  /** text origin in the gutter */
  x: number;
  /** text baseline */
  y: number;
  anchor: 'start' | 'end';
  /** gutter → pad, drawn as a leader line (empty: the text sits on its wire) */
  leader: Point[];
  /** `pad`: a two-faced board's pad name, printed just over its own wire */
  kind?: 'pad';
}

/** A pin/pad row of a block. Ports are where wires attach. */
export interface DiagramPort {
  key: string;
  /** pin id / pad id as printed on the part */
  terminal: string;
  label: string;
  /** `cable` = faces the wire bundle, `integrated` = the PCBA's own connector */
  column: 'cable' | 'integrated';
  side: Side;
  /** attach point on the block outline */
  x: number;
  y: number;
  /** inner end of the row, where internal links start */
  innerX: number;
  /** text origin of the pin-number gutter */
  idX: number;
  /** text origin of the pin label */
  labelX: number;
  /** SVG text-anchor for both texts of this row */
  textAnchor: 'start' | 'end';
  /**
   * Present only on a **depicted** block, where `x`/`y` is the port's true pad
   * position inside the artwork rather than a row on the outline, so the pin
   * text lives in a gutter instead of a column.
   */
  callout?: DiagramCallout;
  note?: string;
  /** a two-faced board's port: which face the pad is drawn on, and which pad */
  face?: 'top' | 'bottom';
  pad?: string;
  /** galvanic net id (core `deriveNets`), for trace highlighting */
  net?: string;
  /**
   * The direction a wire physically comes in to this pad,
   * degrees standard math convention, diagram page space — present only for a
   * two-faced board's pad whose row sits at a real angle to the board edge
   * (`board-faces.ts`'s `FacePad.approach`, already turned/mirrored, filtered
   * to genuinely angled pads only). `render-svg` draws the edge landing on it
   * a short lead along this axis instead of square to the block.
   */
  approach?: number;
  /**
   * The pad's slot on its row's human-set entry guide,
   * page mm, outside the board: the route lands here (the port's anchor is
   * the slot) and render-svg draws the one straight lead on to the pad.
   */
  slot?: { x: number; y: number };
  /**
   * A connector drawn as itself (`DiagramBlock.connectorArt`, wirehub-
   * 7xo.11): the wire's own run inside the block, page mm, from its `slot`
   * (the row on the block's cable edge the route lands at) on to the drawn
   * pin at `x`/`y` — the points between the two, in order. The pin's text
   * prints on the row, over the wire.
   */
  lead?: Point[];
}

/**
 * A connector block drawn as the real connector: the
 * shared connector art (`connector-art.ts`) — its mating face, or a side
 * profile for RCA/TRS/BNC — in art units, placed at `rect` by `scale`. The
 * block's ports sit on the drawn pins; their rows (pin number and signal)
 * stay on the cable edge, each wire running on from its row to its pin.
 */
export interface DiagramConnectorArt {
  defId: string;
  view: ArtView;
  /** `DB-23`, `SCART`, `RCA` */
  short: string;
  /** where the drawing lands on the page */
  rect: Rect;
  /** page mm per art unit */
  scale: number;
  /** the drawing's own frame, art units */
  width: number;
  height: number;
  shapes: ArtShape[];
  /** every pin the drawing has, `used` when a wire lands on it */
  pins: (ConnectorPinArt & { used: boolean })[];
  labels: ArtLabel[];
  /** `MATING FACE` / `SIDE VIEW`, baseline, centred over the drawing */
  caption: { text: string; x: number; y: number };
  /** pin positions follow the family's general shape, not a drawing */
  approximate: boolean;
}

/**
 * The artwork a depicted block draws in place of its pin rows.
 *
 * `rect` is where the asset's frame lands on the page and `scale` is page
 * millimetres per artwork unit, so the renderer's whole job is
 * `translate(rect.x, rect.y) scale(scale)`. The asset's own coordinates are
 * +y **down** — SVG's convention, and the one the pinmap-derived board frames
 * are authored in — which is the same sense as the diagram's, so mapping an
 * anchor is a scale and a translate with no flip anywhere.
 *
 * Only the identity of the asset travels in the model, never its bytes: the
 * renderer fetches those from the same `DepictionSource` the layout used.
 */
export interface DiagramDepiction {
  defId: string;
  view: string;
  kind: 'vector' | 'raster';
  rect: Rect;
  /** page mm per artwork unit — the asset's `mmPerUnit` times the magnification */
  scale: number;
  widthUnits: number;
  heightUnits: number;
  /**
   * The build's mounted parts seen in this view, in artwork units (catalog
   * `componentsFor`;) — absent when the board has none.
   */
  parts?: BoardPart[];
  /**
   * A gerber-tier board draws **both** faces, stacked:
   * then `rect`/`scale` describe the whole art column and each face draws
   * itself from here. Absent on single-view artwork.
   */
  faces?: DiagramBoardFace[];
  /** board part ref → the nets its internal links join (trace highlighting) */
  partNets?: Record<string, string[]>;
}

/** One face of a two-faced board, turned so its cable edge faces the wire. */
export interface DiagramBoardFace {
  side: 'top' | 'bottom';
  view: 'board-top' | 'board-bottom';
  /** where the turned face lands on the page */
  rect: Rect;
  /** counter-clockwise quarter-turn on the page */
  rotation: 0 | 90 | 180 | 270;
  /** the face's own (unturned) frame, artwork units */
  frame: { width: number; height: number };
  /** page mm per artwork unit */
  scale: number;
  /** `TOP` / `BOTTOM` caption, baseline */
  caption: { text: string; x: number; y: number; anchor: 'start' | 'end' };
  /** the build's parts on this face, artwork units of the turned frame (upright) */
  parts?: BoardPart[];
}

/** A PCBA `internalLink`, drawn inside the block outline. */
export interface DiagramInternalLink {
  from: string;
  to: string;
  /**
   * Opaque annotation text straight from the catalog (`R203 180 Ω blanking`).
   * Never parsed or matched on — it is display content only.
   */
  via?: string;
  points: Point[];
  /** pre-wrapped annotation lines, anchored at `annotX`/`annotY` */
  annotation: string[];
  annotX: number;
  annotY: number;
  /** `middle` on a depicted block, where the annotation sits on the trace */
  annotAnchor: 'start' | 'end' | 'middle';
  /** the nets the link joins (one for plain copper, two across a `via`) */
  nets?: string[];
  /** board parts the link runs through (`via` names them), by ref */
  parts?: string[];
  /** the face a two-faced board draws it on */
  face?: 'top' | 'bottom';
  /** link ends whose pad is on the other face: drawn as a hollow ring */
  ghosts?: Point[];
}

export interface DiagramBlock {
  id: string;
  kind: 'connector' | 'pcba';
  def: string;
  title: string;
  subtitle?: string;
  rect: Rect;
  /** height of the title area; port rows start below it */
  headerHeight: number;
  /** small column captions, e.g. `pads` / `scart.n` */
  captions?: { cable?: string; integrated?: string };
  /** side the wire bundle is on */
  cableSide: Side;
  ports: DiagramPort[];
  internalLinks: DiagramInternalLink[];
  /** wrapped "not used: …" lines drawn under the block */
  footnoteLines: string[];
  zone: Zone;
  /**
   * Set when this block draws real artwork. Its ports then sit at true pad
   * positions inside `depiction.rect` and carry a `callout`; when it is absent
   * the block is the abstract pin-row table, which is always correct.
   */
  depiction?: DiagramDepiction;
  /** set when this connector draws as itself (shared connector art) */
  connectorArt?: DiagramConnectorArt;
  note?: string;
}

/**
 * What became of one block's artwork. Recorded for every connector and PCBA on
 * the page whenever depictions are enabled — including the ordinary
 * `no-depiction` case — so a build can answer "why is this block abstract?"
 * without re-deriving anything. Only the cases that are genuinely *wrong*
 * (artwork exists but cannot be used) also raise an `Issue`.
 */
export interface DepictionDiagnostic {
  instance: string;
  def: string;
  kind: 'connector' | 'pcba';
  status: 'drawn' | 'no-depiction' | 'no-usable-view' | 'unreadable-asset' | 'unanchored-pin';
  view?: string;
  /** used pin ids the artwork has no anchor for */
  missing?: string[];
  detail?: string;
}

/* ------------------------------------------------------------------ *
 * Wire bands
 * ------------------------------------------------------------------ */

export type TrackRole =
  | 'center'
  | 'shield'
  | 'overall-shield'
  | 'drain'
  | 'plain';

export interface DiagramTrackEnd {
  key: string;
  end: 'a' | 'b';
  x: number;
  y: number;
  dir: -1 | 1;
  /** false = deliberately cut / left floating at this end */
  connected: boolean;
  /** 1-based footnote number explaining a deliberate cut end */
  noteRef?: number;
}

export interface DiagramTrack {
  /** `w1:core-red.center` — the terminal key without the end suffix */
  key: string;
  segment: string;
  elementPath: string;
  kind: 'conductor' | 'shield';
  role: TrackRole;
  /** colour *name* from the catalog (`red`, `brown`); renderer maps to paint */
  colorName?: string;
  /** `bare: true` conductors — drawn as bare copper */
  bare: boolean;
  label: string;
  y: number;
  x1: number;
  x2: number;
  /** id of the coax / shielded-core group this track belongs to */
  groupId?: string;
  a: DiagramTrackEnd;
  b: DiagramTrackEnd;
  /** galvanic net id, for trace highlighting */
  net?: string;
}

/** The bracket + label that binds a coax's centre and shield together. */
export interface DiagramTrackGroup {
  id: string;
  label: string;
  role: string;
  x: number;
  y1: number;
  y2: number;
  labelX: number;
  labelY: number;
}

/**
 * A pigtail (specs/shield-bonding.md): screens of one segment end twisted
 * together and landed once. Drawn as a bracket that gathers the member
 * tracks' ends and one lead out to `anchor`, where its landing joint starts.
 */
export interface DiagramPigtail {
  /** the pigtail's terminal key, `w1:pigtail:rgb@b` — its anchor key */
  key: string;
  segment: string;
  id: string;
  end: 'a' | 'b';
  /** track keys (no end suffix) of the screens it gathers */
  members: string[];
  /** x of the band edge the member tracks end at */
  edgeX: number;
  /** x of the vertical bracket */
  x: number;
  y1: number;
  y2: number;
  /** y of each member track */
  memberYs: number[];
  anchor: Point;
  dir: -1 | 1;
  /** prep note, as the design gives it */
  note?: string;
  net?: string;
}

export interface DiagramBand {
  segment: string;
  def: string;
  /** stock label + length, drawn above the jacket outline (cut to the band's width) */
  label: string;
  /** the whole label, when `label` had to be cut */
  fullLabel?: string;
  role?: string;
  rect: Rect;
  labelX: number;
  labelY: number;
  /** x where each track's own label starts, inboard of the group brackets */
  trackLabelX: number;
  tracks: DiagramTrack[];
  groups: DiagramTrackGroup[];
  /** the segment's pigtails, at both ends */
  pigtails: DiagramPigtail[];
  /** which physical end of the segment sits at `rect.x` */
  leftEnd: 'a' | 'b';
  zone: Zone;
}

/* ------------------------------------------------------------------ *
 * Discrete components
 * ------------------------------------------------------------------ */

export type ComponentSymbol =
  | 'resistor'
  | 'capacitor'
  | 'capacitor-polarized'
  | 'generic';

export interface DiagramComponentTerminal {
  key: string;
  terminal: string;
  x: number;
  y: number;
  dir: -1 | 1;
  polarity?: '+' | '-';
}

export interface DiagramComponent {
  id: string;
  def: string;
  symbol: ComponentSymbol;
  /** `r1 · 330 Ω` */
  label: string;
  labelX: number;
  labelY: number;
  /** the symbol body; terminals sit on its left/right edges */
  rect: Rect;
  terminals: DiagramComponentTerminal[];
  location?: string;
  note?: string;
  /** the nets of its two leads */
  nets?: string[];
}

/* ------------------------------------------------------------------ *
 * Joints
 * ------------------------------------------------------------------ */

/** One `design.joints[i]`, routed orthogonally between its two anchors. */
export interface DiagramEdge {
  /** index into `design.joints` */
  index: number;
  a: string;
  b: string;
  points: Point[];
  note?: string;
  /** the pad each end landed on, when the terminal has several */
  padA?: string;
  padB?: string;
  net?: string;
}

/** A filled dot: a terminal that at least one joint lands on. */
export interface DiagramJointDot {
  key: string;
  x: number;
  y: number;
  /** how many joints share this dot — 3-way bonds draw heavier */
  degree: number;
  /** the pad, when the terminal has several and this dot is on one of them */
  pad?: string;
  net?: string;
}

/** A wire end that is deliberately cut and left unconnected. */
export interface DiagramCutEnd {
  key: string;
  x: number;
  y: number;
  dir: -1 | 1;
  noteRef?: number;
  net?: string;
}

/* ------------------------------------------------------------------ *
 * Cross-section cutaway
 * ------------------------------------------------------------------ */

/**
 * One concentric ring of the cutaway: an element of the stock seen end-on.
 * `r`/`rInner` are paper millimetres; `odMm` is the cable dimension they came
 * from, so a reader can check the drawing against the spec sheet. Rings tile
 * the radial space with no gaps — a ring's inner radius is the outer radius of
 * whatever it is extruded over — so the annulus widths are exactly what the
 * documented diameters imply and nothing is invented.
 */
export interface CrossSectionRing {
  /** element path this ring draws (`core-red.shield`, `jacket`) */
  elementPath: string;
  kind: 'conductor' | 'insulation' | 'shield';
  label: string;
  cx: number;
  cy: number;
  /** outer radius */
  r: number;
  /** inner radius; 0 = solid disc */
  rInner: number;
  /** the cable diameter this ring was computed from, mm */
  odMm: number;
  /** colour *name* from the catalog; the renderer maps it to paint */
  colorName?: string;
  bare?: boolean;
  construction?: 'braid' | 'spiral' | 'foil' | 'tape';
  /**
   * this ring is (part of) the cable's outer jacket — a figure-8 leg's own
   * jacket paints like the jacket, not like the core's colour
   */
  jacket?: boolean;
}

/**
 * A stock that is not one round jacket: the outline
 * the renderers fill and stroke instead of the jacket circle. Only
 * `figure-8` today — two lobes (the legs' jackets) joined by a web.
 */
export interface CrossSectionOutline {
  shape: 'figure-8';
  /** the two legs' jacket circles, left then right */
  lobes: { cx: number; cy: number; r: number }[];
  /** half the web's thickness */
  webHalf: number;
  /** the union's outline as an SVG path (`figure8Path`) */
  d: string;
  widthMm: number;
  heightMm: number;
}

/** A core (or the drain) in the lay, with its rings and its callout. */
export interface CrossSectionCore {
  /** element path of the core (`core-red`, `drain`) */
  elementPath: string;
  label: string;
  /** the callout tag: `1`…`6` in lay order, `C` centre, `D` drain */
  tag: string;
  /** position in the lay: 0-based on the pitch circle, -1 centre, -2 drain */
  layIndex: number;
  /** axis angle, degrees counter-clockwise from 12 o'clock */
  angleDeg: number;
  cx: number;
  cy: number;
  /** outer radius of the whole core */
  r: number;
  colorName?: string;
  rings: CrossSectionRing[];
  /** radial leader from the core out past the jacket, then the tag */
  leader: Point[];
  tagX: number;
  tagY: number;
  tagAnchor: 'start' | 'middle' | 'end';
}

/** One line of the panel's key: swatch, tag, text. */
export interface CrossSectionKeyEntry {
  tag: string;
  text: string;
  kind: 'core' | 'shield' | 'jacket';
  colorName?: string;
  construction?: 'braid' | 'spiral' | 'foil' | 'tape';
  swatchX: number;
  swatchY: number;
  swatchR: number;
  tagX: number;
  textX: number;
  textY: number;
}

/**
 * The whole cutaway panel, positioned. Coordinates are absolute (the panel is
 * laid out at its `origin`), so the renderer never needs a transform and every
 * number can be rounded the same way as the rest of the drawing.
 */
export interface CrossSection {
  /** wire definition id */
  wire: string;
  title: string;
  subtitle: string;
  rect: Rect;
  titleX: number;
  titleY: number;
  subtitleY: number;
  /** the cable axis */
  cx: number;
  cy: number;
  /** paper mm per cable mm */
  scale: number;
  /** cable outer diameter, mm */
  odMm: number;
  /** lay direction the ring cores are numbered in */
  direction: 'ccw' | 'cw';
  arrangement: string;
  /** the jacket; for a figure-8 its bounding circle (Ø = the width) — draw `outline` instead */
  jacket: CrossSectionRing;
  /** the outline of a stock that is not one round jacket (figure-8) */
  outline?: CrossSectionOutline;
  overallShield?: CrossSectionRing;
  /** ring cores in lay order, then the centre core, then the drain */
  cores: CrossSectionCore[];
  key: CrossSectionKeyEntry[];
  /** the jacket OD dimension callout under the circle */
  dimension: {
    y: number;
    x1: number;
    x2: number;
    label: string;
    labelX: number;
    labelY: number;
  };
  /** a true millimetre ruler, so the drawing can be measured */
  ruler: {
    x: number;
    y: number;
    /** drawn length */
    length: number;
    /** what that length is in cable millimetres */
    spanMm: number;
    /** tick x positions */
    ticks: number[];
    label: string;
    labelX: number;
    labelY: number;
  };
}

/* ------------------------------------------------------------------ *
 * The diagram
 * ------------------------------------------------------------------ */

export interface DiagramNote {
  /** 1-based footnote number */
  index: number;
  lines: string[];
  x: number;
  y: number;
}

export interface Diagram {
  designId: string;
  title: string;
  subtitle: string;
  width: number;
  height: number;
  /** header banner: source end on the left, destination on the right */
  direction: { leftLabel: string; rightLabel: string; y: number; x1: number; x2: number };
  /** baseline of the symbol legend, under the direction banner */
  legend: { y: number; x1: number; x2: number };
  blocks: DiagramBlock[];
  bands: DiagramBand[];
  /** the trunk stock's cutaway, drawn as an inset under the trunk column */
  crossSection?: CrossSection;
  components: DiagramComponent[];
  edges: DiagramEdge[];
  jointDots: DiagramJointDot[];
  cutEnds: DiagramCutEnd[];
  notes: DiagramNote[];
  notesHeading?: { x: number; y: number };
  /** anchors by terminal key, for downstream consumers and tests */
  anchors: Record<string, Anchor>;
  /** one entry per depictable block, in block order; empty when depictions are off */
  depictions: DepictionDiagnostic[];
  /** whatever `validateDesign` reported; the renderer surfaces errors */
  issues: Issue[];
  /** breakout moulds on the trunk; absent when there are none */
  breakouts?: DiagramBreakout[];
}

/* ------------------------------------------------------------------ *
 * Breakouts
 * ------------------------------------------------------------------ */

/** One trunk track entering a breakout mould, and what becomes of it there. */
export interface DiagramBreakoutRow {
  /** the trunk terminal key at the mould end: `w1:core-red.center@b` */
  key: string;
  y: number;
  /** where the end sits when it is not on the trunk's edge (a leg's NC end), and which way it faces */
  x?: number;
  dir?: -1 | 1;
  /** `through`: drawn straight across the mould; `terminated`: ends on a solder dot inside it; `nc`: cut back */
  fate: 'through' | 'terminated' | 'nc';
  role: TrackRole;
  colorName?: string;
  bare: boolean;
  /** nc: the reason, as the design gives it */
  reason?: string;
  net?: string;
}

/** A conductor passing uncut out of the mould onto its leg: mould edge → the leg's end. */
export interface DiagramThrough {
  /** trunk terminal key */
  from: string;
  /** leg terminal key */
  to: string;
  points: Point[];
  role: TrackRole;
  colorName?: string;
  bare: boolean;
  net?: string;
}

/**
 * A connector `breakout.housed` names ( — the owner,
 * 2026-09-29: "the female TRS is female and inside the breakout"): drawn as
 * itself, inside the mould's own outline, its opening facing the same way
 * the mould's legs run. `connectorArt` is absent only for a definition or
 * family the schematic has no drawing for.
 */
export interface DiagramMouldJack {
  instanceId: string;
  /** `3.5 mm TRS jack (female)` */
  label: string;
  connectorArt?: DiagramConnectorArt;
  /** one stub per trunk terminal (or pigtail) landing on it, all inside the mould */
  leads: { from: string; terminal: string; points: Point[] }[];
}

export interface DiagramBreakout {
  id: string;
  /** `bk1 · Overmold breakout` */
  label: string;
  /** the mould part, when named */
  sublabel?: string;
  /** `sublabel` wrapped to the mould's width, printed under it */
  sublabelLines?: string[];
  /** the mould outline; the trunk band's end sits inside it */
  rect: Rect;
  /** x of the trunk band's end, where every row starts */
  edgeX: number;
  /** +1: the mould is on the trunk's right (end at the band's right edge) */
  dir: -1 | 1;
  rows: DiagramBreakoutRow[];
  throughs: DiagramThrough[];
  /** connectors housed in this mould — drawn here, not as a block on a lead */
  jacks: DiagramMouldJack[];
}
