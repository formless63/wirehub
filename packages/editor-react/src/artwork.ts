/**
 * Artwork: uploading a depiction and placing its pin anchors, as rules.
 *
 * Everything in this file is a pure function or a plain type — no React, no
 * `fetch`, no DOM. Two things live here that are worth the separation:
 *
 * 1. **The screen ↔ artwork coordinate mapping.** An anchor is a position on a
 *    picture, in that picture's own units, and the user places it by clicking a
 *    zoomed, panned, scaled rendering of that picture. Getting the mapping
 *    wrong does not look wrong — it looks like a pin that is *nearly* right,
 *    which is exactly the class of error a wiring document must not have. So
 *    the mapping is a function with a test, not arithmetic sprinkled through an
 *    event handler.
 *
 * 2. **The mirror rule.** `specs/depictions.md` is emphatic that the solder
 *    side is never hand-entered: a human mirroring a pinout by eye is the
 *    classic wiring error. The editor shows the flip happening, live, from the
 *    one anchor set the user really authored — `derivedAnchors` is that flip,
 *    and it is the same reflection `catalog/src/depictions/anchors.ts` performs
 *    when the renderer asks for a mirrored view.
 *
 * The transport is somebody else's problem, exactly as it is for designs: the
 * editor is handed an `ArtworkAdapter` and never learns a URL.
 */

import type { Issue } from '@cable-studio/model';
import type { DepictionArtwork, DepictionSource } from '@cable-studio/render-svg';

/* ------------------------------------------------------------------ *
 * Types, borrowed rather than re-declared
 * ------------------------------------------------------------------ */

/**
 * The manifest shape, taken from the source the editor is already handed. This
 * package does not depend on `@cable-studio/catalog` and should not start:
 * `DepictionSource` already names the type, so the type comes from there.
 */
export type DepictionMeta = NonNullable<ReturnType<DepictionSource['meta']>>;
/** One angled row's entry guide. */
export type EntryGuide = NonNullable<DepictionMeta['entryGuides']>[number];

/** One anchor: a position in the anchor frame's own units, plus a note. */
export type PinAnchor = DepictionMeta['pinAnchors'][string];

/** The answer to any artwork request; a failure is a sentence, never a throw. */
export type ArtworkOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      hint?: string;
      /** the validator's own findings, when a write was refused on its merits */
      issues?: Issue[];
      /**
       * The input ladder's advice, one line each, **shown verbatim**. A refused
       * upload's whole value is this paragraph: it names the rung the file is
       * on and the one command that gets it onto a rung the tool supports.
       */
      guidance?: string[];
    };

/* ------------------------------------------------------------------ *
 * What the host tells the editor about a depiction
 * ------------------------------------------------------------------ */

export interface ArtworkTerminal {
  id: string;
  label?: string;
  /** other ids the same physical pin answers to; anchoring any one is enough */
  aliases?: string[];
}

export interface ArtworkDefinition {
  kind: 'connector' | 'component' | 'pcba';
  id: string;
  label: string;
  /** every anchorable terminal, in the order the definition declares them */
  terminals: ArtworkTerminal[];
}

/** One view of a depiction, as the Artwork screen needs it. */
export interface ArtworkView {
  view: string;
  file: string;
  kind: 'vector' | 'raster';
  mmPerUnit: number;
  sourceKind: string;
  widthUnits?: number;
  heightUnits?: number;
  mirrorOf?: string;
  mirrorAxis?: 'x' | 'y';
  src: string;
  /** this view's anchors are a reflection of another's — never authored here */
  derived: boolean;
  /** the anchor set as it lands in *this* view */
  anchors: Record<string, PinAnchor>;
}

export interface ArtworkDetail {
  defId: string;
  /** a manifest exists on the host */
  exists: boolean;
  meta?: DepictionMeta;
  views: ArtworkView[];
  anchorFrame?: string;
  pinAnchors: Record<string, PinAnchor>;
  /** terminals with no anchor yet, as the host counts them */
  unanchored: string[];
  /**
   * terminal → the catalog designs that solder to it;
   * absent when the host does not scan designs
   */
  usedBy?: Record<string, string[]>;
  issues: Issue[];
  /** the views the host will accept an upload for */
  uploadableViews: string[];
  definition?: ArtworkDefinition;
}

export interface UploadReport {
  defId: string;
  view: string;
  file: string;
  format: string;
  kind: 'vector' | 'raster';
  frame: { widthUnits?: number; heightUnits?: number; mmPerUnit: number };
  /** what normalisation changed, in plain sentences */
  warnings: string[];
  unanchored: string[];
  anchored: number;
  issues: Issue[];
}

/** A file to upload, in whichever form the host can carry. */
export interface UploadFile {
  name: string;
  /** the browser's own `File`; a host that has one sends it as multipart */
  blob?: unknown;
  /** the bytes, for a host (or a test) with no `File` to hand */
  bytes?: Uint8Array;
}

export interface UploadRequest {
  file: UploadFile;
  /** the real width of the part in millimetres — the raster tier needs a scale */
  widthMm?: number;
  mmPerUnit?: number;
  sourceKind?: string;
  /** "where does this information come from?" — provenance is an input */
  src?: string;
}

export interface AnchorWrite {
  anchorFrame: string;
  pinAnchors: Record<string, PinAnchor>;
  src?: string;
}

/**
 * How this host stores artwork. The studio implements it over the workbench
 * API; a host app may implement it over its own store; the tests implement it
 * with an object literal. No URL appears in this package.
 */
export interface ArtworkAdapter {
  /** the manifest, its views, and the definition's terminal checklist */
  detail(defId: string): Promise<ArtworkOutcome<ArtworkDetail>>;
  upload(defId: string, view: string, request: UploadRequest): Promise<ArtworkOutcome<UploadReport>>;
  saveAnchors(defId: string, write: AnchorWrite): Promise<ArtworkOutcome<ArtworkDetail>>;
  /**
   * Write a gerber board's human-set entry guides into
   * its reviewed kicad-map (and the manifest copy). Optional: a host without
   * it shows the guides read-only.
   */
  saveEntryGuides?(defId: string, guides: readonly EntryGuide[]): Promise<ArtworkOutcome<ArtworkDetail>>;
  /** one view's bytes, in the form the renderer embeds */
  artwork(defId: string, view: string): Promise<ArtworkOutcome<DepictionArtwork>>;
}

/* ------------------------------------------------------------------ *
 * Views and the mirror rule
 * ------------------------------------------------------------------ */

/**
 * The view each view is the flip of. Reflection is symmetric, so this table is
 * its own inverse — and it is deliberately short: `schematic-symbol` and
 * `illustration` have no other side to be seen from.
 */
const COUNTERPART: Readonly<Record<string, string>> = {
  'mating-face': 'solder-side',
  'solder-side': 'mating-face',
  'board-top': 'board-bottom',
  'board-bottom': 'board-top',
};

/** The view that is this one seen from the other side, when there is one. */
export function mirrorCounterpart(view: string): string | undefined {
  return COUNTERPART[view];
}

/**
 * Reflect one anchor inside a frame — the same arithmetic
 * `catalog/src/depictions/anchors.ts` runs, so what the editor shows is what
 * the renderer will draw. `x` is the flip that turning a board over performs.
 */
export function reflectAnchor(
  anchor: PinAnchor,
  axis: 'x' | 'y',
  frame: Frame,
): PinAnchor {
  return {
    x: roundUnits(axis === 'x' ? frame.widthUnits - anchor.x : anchor.x),
    y: roundUnits(axis === 'y' ? frame.heightUnits - anchor.y : anchor.y),
    ...(anchor.note === undefined ? {} : { note: anchor.note }),
  };
}

/**
 * The whole anchor set as it lands on the other side. **This is generated —
 * the user never enters it**, and the editor shows it precisely so that rule
 * is visible rather than merely documented.
 */
export function derivedAnchors(
  anchors: Record<string, PinAnchor>,
  axis: 'x' | 'y',
  frame: Frame,
): Record<string, PinAnchor> {
  const out: Record<string, PinAnchor> = {};
  for (const id of Object.keys(anchors).sort()) {
    const anchor = anchors[id];
    if (anchor !== undefined) out[id] = reflectAnchor(anchor, axis, frame);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Screen ↔ artwork
 * ------------------------------------------------------------------ */

export interface XY {
  x: number;
  y: number;
}

/** An asset's own frame, in its own units. */
export interface Frame {
  widthUnits: number;
  heightUnits: number;
}

/** The visible box the artwork is drawn into, in CSS pixels. */
export interface Stage {
  width: number;
  height: number;
}

/** Where the user has the picture: `zoom` multiplies the fit, pan is in pixels. */
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export const IDENTITY_VIEW: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

/** Below 1× the picture is smaller than the box; above 20× a pad fills it. */
export const ZOOM_RANGE = { min: 0.25, max: 20 } as const;

/**
 * Anchor coordinates are rounded to two decimals, matching the house precision
 * the catalog writes with (`HOUSE_STYLE.precision`). Pixel-perfect clicking is
 * a fiction anyway, and a stable number keeps the JSON diff honest. `-0` is
 * normalised so a value on the frame edge does not flip sign between saves.
 */
export function roundUnits(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** The scale at which the whole frame just fits the stage. */
export function fitScale(frame: Frame, stage: Stage): number {
  if (frame.widthUnits <= 0 || frame.heightUnits <= 0) return 1;
  if (stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(stage.width / frame.widthUnits, stage.height / frame.heightUnits);
}

/**
 * Where the artwork's origin lands and how big one artwork unit is, given the
 * user's zoom and pan.
 *
 * The picture is *centred* in the stage at every zoom and pan is measured from
 * that centre, so zooming out never strands the artwork in a corner and a fresh
 * view (`IDENTITY_VIEW`) needs no initial pan to look right.
 */
export interface Placement {
  /** CSS pixels per artwork unit */
  scale: number;
  /** stage-space position of the artwork's (0, 0), in pixels */
  offsetX: number;
  offsetY: number;
}

export function placement(frame: Frame, stage: Stage, view: ViewTransform): Placement {
  const scale = fitScale(frame, stage) * view.zoom;
  return {
    scale,
    offsetX: view.panX + (stage.width - frame.widthUnits * scale) / 2,
    offsetY: view.panY + (stage.height - frame.heightUnits * scale) / 2,
  };
}

/** Artwork units → stage pixels. */
export function toStage(point: XY, place: Placement): XY {
  return { x: point.x * place.scale + place.offsetX, y: point.y * place.scale + place.offsetY };
}

/** Stage pixels → artwork units. The inverse of `toStage`, exactly. */
export function toArtwork(point: XY, place: Placement): XY {
  if (place.scale === 0) return { x: 0, y: 0 };
  return { x: (point.x - place.offsetX) / place.scale, y: (point.y - place.offsetY) / place.scale };
}

/** A point pulled inside the frame and rounded — what actually gets stored. */
export function clampToFrame(point: XY, frame: Frame): XY {
  return {
    x: roundUnits(Math.min(Math.max(point.x, 0), frame.widthUnits)),
    y: roundUnits(Math.min(Math.max(point.y, 0), frame.heightUnits)),
  };
}

/** Stage pixels → a storable anchor position, in one step. */
export function anchorAt(point: XY, frame: Frame, place: Placement): XY {
  return clampToFrame(toArtwork(point, place), frame);
}

/**
 * Zoom by `factor` about a fixed point on the stage — the wheel gesture.
 *
 * The artwork position under the cursor must not move, which is the whole
 * reason this is a function: the new pan is *solved* for that invariant rather
 * than guessed. Zoom is clamped, and when the clamp bites the pan is solved for
 * the clamped zoom, so the picture still does not jump.
 */
export function zoomAbout(
  view: ViewTransform,
  stagePoint: XY,
  factor: number,
  frame: Frame,
  stage: Stage,
): ViewTransform {
  const before = placement(frame, stage, view);
  const held = toArtwork(stagePoint, before);
  const zoom = Math.min(Math.max(view.zoom * factor, ZOOM_RANGE.min), ZOOM_RANGE.max);
  const scale = fitScale(frame, stage) * zoom;
  // offset' = cursor - held * scale', and pan is offset minus the centring term
  return {
    zoom,
    panX: stagePoint.x - held.x * scale - (stage.width - frame.widthUnits * scale) / 2,
    panY: stagePoint.y - held.y * scale - (stage.height - frame.heightUnits * scale) / 2,
  };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy };
}

/* ------------------------------------------------------------------ *
 * The anchoring state machine
 * ------------------------------------------------------------------ */

export interface AnchoringState {
  anchors: Record<string, PinAnchor>;
  /** the terminal the next click on the artwork places */
  armed?: string;
  /** the terminal currently being dragged */
  dragging?: string;
}

export function beginAnchoring(anchors: Record<string, PinAnchor>): AnchoringState {
  return { anchors: { ...anchors } };
}

/** Whether this terminal is covered — by its own id or by one of its aliases. */
export function isAnchored(
  terminal: ArtworkTerminal,
  anchors: Record<string, PinAnchor>,
): boolean {
  if (anchors[terminal.id] !== undefined) return true;
  return (terminal.aliases ?? []).some((alias) => anchors[alias] !== undefined);
}

export interface AnchorProgress {
  anchored: string[];
  todo: string[];
  complete: boolean;
  /** anchors that name nothing the definition has — a rename left them behind */
  stray: string[];
}

export function anchorProgress(
  terminals: readonly ArtworkTerminal[],
  anchors: Record<string, PinAnchor>,
): AnchorProgress {
  const anchored: string[] = [];
  const todo: string[] = [];
  const known = new Set<string>();
  for (const terminal of terminals) {
    known.add(terminal.id);
    for (const alias of terminal.aliases ?? []) known.add(alias);
    (isAnchored(terminal, anchors) ? anchored : todo).push(terminal.id);
  }
  return {
    anchored,
    todo,
    complete: todo.length === 0 && terminals.length > 0,
    stray: Object.keys(anchors).filter((id) => !known.has(id)).sort(),
  };
}

/**
 * The next terminal still waiting, starting *after* `after` and wrapping once.
 * Placing an anchor arms the next one, so a 21-pin connector is 21 clicks and
 * not 42.
 */
export function nextUnanchored(
  terminals: readonly ArtworkTerminal[],
  anchors: Record<string, PinAnchor>,
  after?: string,
): string | undefined {
  if (terminals.length === 0) return undefined;
  const start = after === undefined ? 0 : terminals.findIndex((t) => t.id === after) + 1;
  for (let step = 0; step < terminals.length; step += 1) {
    const terminal = terminals[(start + step) % terminals.length];
    if (terminal !== undefined && !isAnchored(terminal, anchors)) return terminal.id;
  }
  return undefined;
}

/** Arm a terminal for placement; arming the armed one disarms it. */
export function armTerminal(state: AnchoringState, id: string): AnchoringState {
  const armed = state.armed === id ? undefined : id;
  return { anchors: state.anchors, ...(armed === undefined ? {} : { armed }) };
}

/**
 * Place the armed terminal at `point` and arm whatever is still waiting. With
 * nothing armed a click on the artwork does nothing at all — clicking a picture
 * must never invent an anchor.
 */
export function placeArmed(
  state: AnchoringState,
  point: XY,
  terminals: readonly ArtworkTerminal[],
): AnchoringState {
  if (state.armed === undefined) return state;
  const anchors = { ...state.anchors, [state.armed]: { x: point.x, y: point.y } };
  const armed = nextUnanchored(terminals, anchors, state.armed);
  return { anchors, ...(armed === undefined ? {} : { armed }) };
}

/** Move an anchor that already exists. Used by the drag, and by nothing else. */
export function moveAnchor(state: AnchoringState, id: string, point: XY): AnchoringState {
  if (state.anchors[id] === undefined) return state;
  const previous = state.anchors[id];
  return {
    ...state,
    anchors: {
      ...state.anchors,
      [id]: {
        x: point.x,
        y: point.y,
        ...(previous.note === undefined ? {} : { note: previous.note }),
      },
    },
  };
}

export function startDrag(state: AnchoringState, id: string): AnchoringState {
  return state.anchors[id] === undefined ? state : { ...state, dragging: id };
}

export function endDrag(state: AnchoringState): AnchoringState {
  return { anchors: state.anchors, ...(state.armed === undefined ? {} : { armed: state.armed }) };
}

/** Take an anchor back off the picture, and arm that terminal again. */
export function clearAnchor(state: AnchoringState, id: string): AnchoringState {
  if (state.anchors[id] === undefined) return state;
  const anchors = { ...state.anchors };
  delete anchors[id];
  return { anchors, armed: id };
}

/** Whether the working set says anything the stored set does not. */
export function anchorsDiffer(
  draft: Record<string, PinAnchor>,
  stored: Record<string, PinAnchor>,
): boolean {
  const keys = Object.keys(draft).sort();
  const other = Object.keys(stored).sort();
  if (keys.length !== other.length || keys.some((key, index) => key !== other[index])) return true;
  return keys.some((key) => {
    const a = draft[key];
    const b = stored[key];
    return a === undefined || b === undefined || a.x !== b.x || a.y !== b.y || a.note !== b.note;
  });
}

/**
 * The unanchored-pin situation, said the way a builder would say it.
 *
 * The renderer's rule is blunt — a depicted block with an unanchored *used* pin
 * falls back to the abstract pin table for that instance — and a person needs
 * to know that is what the missing anchors cost, not that a validator counted
 * something.
 */
export function unanchoredSentence(
  progress: AnchorProgress,
  label: string,
  /** terminal → designs soldering to it; given, only pins cables use count (50a.25) */
  usedBy?: Record<string, readonly string[]>,
): string | undefined {
  if (progress.todo.length === 0) return undefined;
  if (usedBy !== undefined) {
    const used = progress.todo.filter((id) => (usedBy[id]?.length ?? 0) > 0);
    if (used.length === 0) return undefined;
    const shown = used.slice(0, 8).join(', ');
    const more = used.length > 8 ? `, and ${used.length - 8} more` : '';
    const cables = new Set(used.flatMap((id) => usedBy[id] ?? [])).size;
    return `${used.length === 1 ? 'One pin' : `${used.length} pins`} that cables solder to ${used.length === 1 ? 'has' : 'have'} no spot yet (${shown}${more}) — ${cables === 1 ? 'that cable draws' : `those ${cables} cables draw`} the pin table.`;
  }
  const shown = progress.todo.slice(0, 8).join(', ');
  const more = progress.todo.length > 8 ? `, and ${progress.todo.length - 8} more` : '';
  return progress.anchored.length === 0
    ? `Nothing on ${label} is anchored yet. Until a pin has a spot on the picture, every cable that uses it is drawn as the plain pin table instead of the artwork.`
    : `${progress.todo.length} of ${progress.todo.length + progress.anchored.length} pins still have no spot on the picture (${shown}${more}). A cable that solders to one of those is drawn as the plain pin table instead of this artwork.`;
}

/* ------------------------------------------------------------------ *
 * Keeping the schematic honest after a save
 * ------------------------------------------------------------------ */

/**
 * Artwork the page has been told about *since it loaded*.
 *
 * The studio's `DepictionSource` is a build-time glob: it holds the artwork
 * that existed when the page was compiled, and a file uploaded a minute ago is
 * not in it. Rather than ask the user to reload — the honest fallback, but a
 * bad one when the whole point of the screen is to see the anchor you just
 * placed — the editor keeps this overlay and layers it over the bundled source.
 */
export interface ArtworkOverlay {
  meta: Record<string, DepictionMeta>;
  /** keyed `<defId>/<view>` */
  artwork: Record<string, DepictionArtwork>;
}

export const EMPTY_OVERLAY: ArtworkOverlay = { meta: {}, artwork: {} };

export function overlayWith(
  overlay: ArtworkOverlay,
  defId: string,
  meta: DepictionMeta | undefined,
  assets: Record<string, DepictionArtwork> = {},
): ArtworkOverlay {
  const artwork = { ...overlay.artwork };
  for (const [view, art] of Object.entries(assets)) artwork[`${defId}/${view}`] = art;
  return {
    meta: meta === undefined ? overlay.meta : { ...overlay.meta, [defId]: meta },
    artwork,
  };
}

export function overlayIsEmpty(overlay: ArtworkOverlay): boolean {
  return Object.keys(overlay.meta).length === 0 && Object.keys(overlay.artwork).length === 0;
}

/**
 * The bundled source with the overlay layered on top.
 *
 * A definition the overlay knows about answers from the overlay's manifest; a
 * view whose bytes the overlay does not hold still falls back to the bundle, so
 * uploading a `mating-face` never hides an already-bundled `board-top`. Nothing
 * here throws and nothing mutates the base — the same manners the loader has.
 */
export function overlaySource(
  base: DepictionSource | undefined,
  overlay: ArtworkOverlay,
): DepictionSource {
  return {
    meta: (defId) => overlay.meta[defId] ?? base?.meta(defId),
    artwork: (defId, view) => overlay.artwork[`${defId}/${view}`] ?? base?.artwork(defId, view),
  };
}
