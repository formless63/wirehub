/**
 * Depiction resolution for the layout pass.
 *
 * A depiction is **presentation artwork, not truth** (`specs/depictions.md`):
 * board layouts and connector faces, keyed by definition id, with one anchor
 * per logical pin. When a block's definition has usable artwork the layout
 * draws it at true size and puts the block's ports on the real pad positions;
 * when anything at all is missing or unreadable it falls back to the abstract
 * pin-row block, which is always correct. **Nothing here ever throws**: every
 * failure comes back as a diagnostic and a fallback.
 *
 * Layout only needs three facts from an asset — its frame size, its anchors,
 * and whether the file can be read at all — because all three change the
 * block's geometry. The bytes themselves are the renderer's business; it asks
 * the same `DepictionSource` for them.
 */

import { boardOutlineFromSvg, guideSlots } from './entry-guides.ts';
import type { BoardPart, DepictionMeta, PadPosition, PinAnchor } from '@wirehub/catalog';
import type { BoardFacesSource } from './board-faces.ts';
import {
  anchorPads,
  anchorsFor,
  componentsFor,
  loadDepictions,
  readDepictionAsset,
  readDepictionAssetDataUri,
} from '@wirehub/catalog';

/* ------------------------------------------------------------------ *
 * Source
 * ------------------------------------------------------------------ */

/** One view's artwork, in the form the renderer can embed self-containedly. */
export interface DepictionArtwork {
  kind: 'vector' | 'raster';
  /** SVG source, for vector art the renderer inlines as a `<g>` */
  source?: string;
  /** `data:image/png;base64,…`, for raster art the renderer embeds as `<image>` */
  dataUri?: string;
}

/**
 * Where depictions come from. The default implementation reads the catalog's
 * committed `depictions/` tree; tests and future editors can hand in their own
 * without either package growing a new dependency.
 */
export interface DepictionSource {
  /** The manifest for a definition id, or `undefined` when it has none. */
  meta(defId: string): DepictionMeta | undefined;
  /** One view's artwork, or `undefined` when the file cannot be read. */
  artwork(defId: string, view: string): DepictionArtwork | undefined;
}

/**
 * Cached view of the catalog's depiction tree.
 *
 * Deliberately memoised across calls: the tree is committed, read-only
 * presentation data, and a schematic render would otherwise re-read every
 * `meta.json` in the package for every design on the page. Nothing mutates
 * what comes back, so the cache cannot leak between callers the way a shared
 * *electrical* singleton would.
 *
 * The loader's own issues are dropped here on purpose. A manifest too broken
 * to parse simply never enters the index, and every block that wanted it falls
 * back — which is the right behaviour for a *drawing*. Catching that the
 * committed tree is broken at all is the catalog's job, and its
 * `depictions.test.ts` fails the build over exactly that.
 */
let cachedSource: DepictionSource | undefined;

export function catalogDepictions(): DepictionSource {
  cachedSource ??= depictionsFromRoot();
  return cachedSource;
}

/**
 * A depiction source over one depiction tree on disk — the catalog's own
 * (the default) or another laid out the same way, such as the frozen fixture
 * catalog's (`fixtureDepictionsRoot()`). Artwork reads
 * are memoised per source.
 */
export function depictionsFromRoot(root?: string): DepictionSource {
  const { index } = loadDepictions(undefined, ...(root === undefined ? [] : [root]));
  const artworkCache = new Map<string, DepictionArtwork | undefined>();
  return {
    meta: (defId) => index[defId],
    artwork: (defId, view) => {
      const cacheKey = `${defId} ${view}`;
      if (artworkCache.has(cacheKey)) return artworkCache.get(cacheKey);
      const meta = index[defId];
      const asset = meta?.views[view];
      let artwork: DepictionArtwork | undefined;
      if (meta !== undefined && asset !== undefined) {
        if (asset.kind === 'raster') {
          const dataUri = root === undefined ? readDepictionAssetDataUri(meta, view) : readDepictionAssetDataUri(meta, view, root);
          artwork = dataUri === undefined ? undefined : { kind: 'raster', dataUri };
        } else {
          const source = root === undefined ? readDepictionAsset(meta, view) : readDepictionAsset(meta, view, root);
          artwork = source === undefined ? undefined : { kind: 'vector', source };
        }
      }
      artworkCache.set(cacheKey, artwork);
      return artwork;
    },
  };
}

/**
 * Several depiction sources read as one: the first that has a manifest for a
 * definition (or body) id supplies its artwork. A catalog's own tree goes
 * first, so what a deployment draws itself wins over a pack's.
 */
export function layeredDepictions(...sources: readonly DepictionSource[]): DepictionSource {
  const owner = (defId: string): DepictionSource | undefined => sources.find((source) => source.meta(defId) !== undefined);
  return {
    meta: (defId) => owner(defId)?.meta(defId),
    artwork: (defId, view) => owner(defId)?.artwork(defId, view),
  };
}

/** Drop the memoised catalog tree. Only tests that rewrite assets need this. */
export function resetDepictionCache(): void {
  cachedSource = undefined;
}

/* ------------------------------------------------------------------ *
 * View selection
 * ------------------------------------------------------------------ */

/**
 * Which view a block uses when its depiction offers several, most wanted
 * first.
 *
 * A **PCBA** is drawn `board-top`: that is the side the installer looks at
 * while soldering the cable on, and it is the frame the generated anchors are
 * authored in. A **connector** prefers its `mating-face` — the view whose pin
 * numbering a builder checks against the part in their hand.
 *
 * Mirrored views (`board-bottom`, `solder-side`) are never auto-selected. They
 * exist so a solder-side sheet can ask for one explicitly; picking one by
 * accident is exactly the mirrored-pinout error the anchor rules exist to
 * prevent. Connectors ship no depictions yet, so in practice every depicted
 * block today is a `board-top`.
 */
export const DEPICTION_VIEW_PREFERENCE: Readonly<
  Record<'connector' | 'pcba', readonly string[]>
> = {
  pcba: ['board-top', 'illustration', 'schematic-symbol'],
  connector: ['mating-face', 'schematic-symbol', 'illustration'],
};

/**
 * The best view for this block kind that the depiction actually offers, has a
 * frame size for, and can place anchors in.
 */
export function pickDepictionView(
  kind: 'connector' | 'pcba',
  meta: DepictionMeta,
  preference: readonly string[] = DEPICTION_VIEW_PREFERENCE[kind],
): string | undefined {
  for (const view of preference) {
    const asset = meta.views[view];
    if (asset === undefined) continue;
    if (asset.widthUnits === undefined || asset.heightUnits === undefined) continue;
    if (anchorsFor(meta, view) === undefined) continue;
    return view;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** Used pins of a connector face closer than this, measured down the (turned) face, cannot each have a wire of their own. */
const MIN_PIN_GAP_MM = 1;

/** Why a block that could have been depicted is not. */
export type DepictionStatus =
  | 'drawn'
  | 'no-depiction'
  | 'no-usable-view'
  | 'unreadable-asset'
  | 'unanchored-pin'
  | 'crowded-anchors';

/** Everything layout needs about a resolved depiction, in artwork units. */
export interface ResolvedDepiction {
  defId: string;
  view: string;
  kind: 'vector' | 'raster';
  widthUnits: number;
  heightUnits: number;
  mmPerUnit: number;
  anchors: Record<string, PinAnchor>;
  /** a connector face turned a quarter clockwise (see `DiagramDepiction.turn`); frame and anchors are the turned ones */
  turn?: 90;
  /** the build's mounted parts seen in this view, its frame (gerber boards) */
  parts: BoardPart[];
  /**
   * Present for a PCBA whose depiction is a gerber-tier board with both faces
   * (`board-top` + its mirror `board-bottom`, side-aware anchors, both assets
   * readable): the schematic then draws both faces, stacked, each pad on the
   * face it is on. Absent → the single view above.
   */
  board?: BoardFacesSource;
}

export interface DepictionResolution {
  status: DepictionStatus;
  depiction?: ResolvedDepiction;
  /** ids of the used pins the artwork has no anchor for */
  missing?: string[];
  detail?: string;
}

/**
 * Resolve one block's depiction, or say precisely why it falls back.
 *
 * `requiredIds` are the terminals the drawing *must* be able to land a wire
 * on — the used ones. A terminal that is only shown because an internal link
 * mentions it may go unanchored: the caller drops that row rather than losing
 * the whole picture.
 */
export function resolveDepiction(
  source: DepictionSource,
  kind: 'connector' | 'pcba',
  definitionId: string,
  requiredIds: readonly string[],
  alsoTry: readonly string[] = [],
): DepictionResolution {
  // the definition's own artwork first, then the art of the physical part it
  // is built on (a connector's body, or the body its `drawing` names): one
  // face serves every pinout on a body, and its anchors are the body's
  // position ids, which a connector's pins carry
  const defId = [definitionId, ...alsoTry].find((id) => source.meta(id) !== undefined) ?? definitionId;
  const meta = source.meta(defId);
  if (meta === undefined) return { status: 'no-depiction' };

  const view = pickDepictionView(kind, meta);
  if (view === undefined) {
    return {
      status: 'no-usable-view',
      detail: `depiction has no ${kind === 'pcba' ? 'board-top' : 'mating-face'}-class view with a frame and resolvable anchors`,
    };
  }

  const asset = meta.views[view];
  const anchors = anchorsFor(meta, view);
  if (asset?.widthUnits === undefined || asset.heightUnits === undefined || anchors === undefined) {
    return { status: 'no-usable-view', detail: `view '${view}' lost its frame or anchors` };
  }

  const artwork = source.artwork(defId, view);
  const usable =
    artwork !== undefined &&
    (artwork.kind === 'vector' ? artwork.source !== undefined : artwork.dataUri !== undefined);
  if (!usable) {
    return { status: 'unreadable-asset', detail: `view '${view}' file '${asset.file}' could not be read` };
  }

  const missing = [...requiredIds].filter((id) => anchors[id] === undefined).sort();
  if (missing.length > 0) return { status: 'unanchored-pin', missing };

  const board = kind === 'pcba' ? twoFacedBoard(source, defId, meta) : undefined;

  // a connector face is drawn long axis down the page (as the built-in faces
  // are), so its pins sit level with their wires: turn one whose pins spread
  // across the page rather than down it a quarter
  let widthUnits = asset.widthUnits;
  let heightUnits = asset.heightUnits;
  let placed = anchors;
  let turn: 90 | undefined;
  // judged on the pins the drawing must land wires on (a shell contact off to one side must not decide it)
  const judged = (requiredIds.length > 0 ? requiredIds.map((id) => anchors[id]) : Object.values(anchors)).filter((a): a is PinAnchor => a !== undefined);
  const xs = judged.map((a) => a.x);
  const ys0 = judged.map((a) => a.y);
  const spreadX = xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
  const spreadY = ys0.length === 0 ? 0 : Math.max(...ys0) - Math.min(...ys0);
  if (kind === 'connector' && artwork.kind === 'vector' && spreadX > spreadY) {
    turn = 90;
    widthUnits = asset.heightUnits;
    heightUnits = asset.widthUnits;
    placed = Object.fromEntries(Object.entries(anchors).map(([id, a]) => [id, { x: asset.heightUnits! - a.y, y: a.x }]));
  }
  if (kind === 'connector') {
    // wires leave level with their pins: two used pins closer than a millimetre
    // down the page would run on one line
    const ys = requiredIds.map((id) => placed[id]?.y).filter((y): y is number => y !== undefined).sort((a, b) => a - b);
    const tight = ys.some((y, i) => i > 0 && (y - (ys[i - 1] as number)) * asset.mmPerUnit < MIN_PIN_GAP_MM);
    if (tight) return { status: 'crowded-anchors', detail: `used pins sit closer than ${MIN_PIN_GAP_MM} mm down the face, so their wires would share a line` };
  }
  return {
    status: 'drawn',
    depiction: {
      defId,
      view,
      kind: artwork.kind,
      widthUnits,
      heightUnits,
      mmPerUnit: asset.mmPerUnit,
      anchors: placed,
      ...(turn === undefined ? {} : { turn }),
      parts: componentsFor(meta, view) ?? [],
      ...(board === undefined ? {} : { board }),
    },
  };
}

/**
 * The two-faced form of a board depiction, or `undefined` when it is not one:
 * a gerber-tier `board-top` (the anchor frame) with a `board-bottom` that
 * mirrors it, both vector and both readable. The same test the canvas's board
 * node applies (`board-art.ts` `isGerberBoard`), so the build view and the
 * schematic draw the same boards two-faced.
 */
function twoFacedBoard(
  source: DepictionSource,
  defId: string,
  meta: DepictionMeta,
): BoardFacesSource | undefined {
  const top = meta.views['board-top'];
  const bottom = meta.views['board-bottom'];
  if (top === undefined || bottom === undefined) return undefined;
  if (top.sourceKind !== 'gerber' || top.kind !== 'vector' || bottom.kind !== 'vector') return undefined;
  if (meta.anchorFrame !== 'board-top' || bottom.mirrorOf !== 'board-top') return undefined;
  if (top.widthUnits === undefined || top.heightUnits === undefined) return undefined;
  for (const view of ['board-top', 'board-bottom']) {
    const artwork = source.artwork(defId, view);
    if (artwork?.kind !== 'vector' || artwork.source === undefined || artwork.source === '') {
      return undefined;
    }
  }
  const pads: Record<string, PadPosition[]> = {};
  for (const terminal of Object.keys(meta.pinAnchors).sort()) {
    const anchor = meta.pinAnchors[terminal];
    if (anchor !== undefined) pads[terminal] = anchorPads(anchor);
  }
  // the human-set entry guides' slots, per face, by pad ref
  const slots: Record<'top' | 'bottom', Record<string, { x: number; y: number }>> = { top: {}, bottom: {} };
  let guided = false;
  for (const guide of meta.entryGuides ?? []) {
    for (const slot of guideSlots(meta, guide)) {
      slots[guide.side][slot.ref] = slot.slot;
      guided = true;
    }
  }
  const outline = boardOutlineFromSvg(source.artwork(defId, 'board-top')?.source ?? '');
  return {
    frame: { width: top.widthUnits, height: top.heightUnits },
    mirrorAxis: bottom.mirrorAxis ?? 'x',
    pads,
    ...(guided ? { slots } : {}),
    ...(outline === undefined ? {} : { outline }),
    parts: {
      top: componentsFor(meta, 'board-top') ?? [],
      bottom: componentsFor(meta, 'board-bottom') ?? [],
    },
  };
}
