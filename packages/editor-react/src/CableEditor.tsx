/**
 * `<CableEditor design={…} db={…} />` — the whole authoring surface.
 *
 * The component owns an `EditorState` whose `design` is a `CableDesign` and
 * nothing else. React Flow is handed *derived* nodes and edges on every render
 * and hands back *intentions* (a connection, a deletion, a drag), which are
 * turned into candidate designs and run past `validateDesign` before anything
 * changes. React Flow's own graph is never read as truth.
 */

import {
  deriveNets,
  netForTerminal,
  parseTerminalKey,
  terminalKey,
  type CableDesign,
  type Db,
  type InstanceKind,
  type StripPractice,
  type TerminalRef,
} from '@cable-studio/model';
import type { DocumentFacts } from '@cable-studio/docs';
import type { DepictionSource } from '@cable-studio/render-svg';
import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import {
  IconBox,
  IconHandStop,
  IconLayoutDistributeHorizontal,
  IconLayoutSidebarRight,
  IconMaximize,
  IconPointer,
  IconSearch,
  IconTag,
  IconX,
} from '@tabler/icons-react';
import {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type Ref,
} from 'react';

import {
  EMPTY_OVERLAY,
  overlayIsEmpty,
  overlaySource,
  type ArtworkAdapter,
  type ArtworkOverlay,
} from './artwork.ts';
import { EditorContext, classes } from './context.ts';
import { SEMANTIC_TOKENS, type SemanticTokens } from './tokens.ts';
import type { DefinitionChange, DefinitionsAdapter } from './definitions.ts';
import { terminalKeyOfHandle } from './board-art.ts';
import { deriveFlow, type EditorEdgeData } from './derive.ts';
import { LOD_ZOOM, cardSize, partsFlow, type CanvasDetail, type CardNodeData } from './lod.ts';
import { estimateNodeSize } from './layout-size.ts';
import { REPIN_GRIP_RADIUS, edgeTypes } from './edges.tsx';
import { changedHandleNodes, handleSignatures } from './handle-sync.ts';
import { reconnectMoves, reconnectableEnds } from './repin.ts';
import type { EditorLayoutStore } from './layout-store.ts';
import { useRememberedPositions } from './remember.ts';
import { Splitter, usePanes } from './panels/Splitter.tsx';
import { ArtworkPane } from './panels/Artwork.tsx';
import type { CatalogChange } from './lifecycle.ts';
import type { DesignSummary, Outcome, PersistenceAdapter } from './persistence.ts';
import { DesignActions } from './panels/DesignActions.tsx';
import { DesignLifecycleDialogs } from './panels/DesignLifecycleDialogs.tsx';
import { useDesignLifecycle, type LifecycleAction } from './panels/useDesignLifecycle.ts';
import { nodeTypes } from './nodes/index.tsx';
import { ConnectionPanel, PartPanel } from './panels/Inspector.tsx';
import { IssuesPanel, NetsPanel } from './panels/Derived.tsx';
import { NotesPanel } from './panels/Notes.tsx';
import { PinSearch } from './panels/PinSearch.tsx';
import { NetHover } from './net-hover.tsx';
import { ConfirmDeleteDialog, deletePlan, type DeletePlan } from './panels/ConfirmDeleteDialog.tsx';
import type { AssetsAdapter } from './assets.ts';
import type { DrawingAdapter } from './documents.ts';
import type { DocumentRelease } from './release.ts';
import { JsonPane } from './panels/JsonPane.tsx';
import { NodePicker } from './panels/NodePicker.tsx';
import { PART_MIME, Palette } from './panels/Palette.tsx';
import { PreviewPane } from './panels/Preview.tsx';
import { SchematicPane } from './panels/Schematic.tsx';
import { SPLITTER_SIZE } from './splitters.ts';
import { PartNumberContext, partNumberScope, type PartNumberData } from './part-numbers.ts';
import { HoverContext, createHoverStore } from './hover.ts';
import {
  editorReducer,
  initialEditorState,
  redoDescription,
  undoDescription,
  type EditorAction,
  type EditorState,
} from './store.ts';
import { useUnsavedChangesGuard } from './panels/useUnsavedChangesGuard.ts';
import { useEditLocked } from './panels/edit-session.ts';

export interface CableEditorProps {
  /** the design to author — the editor keeps its own committed copy */
  design: CableDesign;
  /** the definition library */
  db: Db;
  /** called with every accepted design; never called for a rejected edit */
  onDesignChange?: (design: CableDesign) => void;
  /** the bench's strip steps (the host's wire library) — a segment's 3D view strips by them (50a.58) */
  stripPractice?: () => Promise<Outcome<StripPractice[]>>;
  /** draw depictions in the preview from the catalog tree (needs a filesystem) */
  previewDepictions?: boolean;
  /**
   * Artwork for the preview from somewhere other than the filesystem — how a
   * browser host gets real board pictures (the studio assembles one from the
   * catalog's committed tree at build time). Wins over `previewDepictions`;
   * blocks whose definition it has nothing for fall back to abstract ones,
   * exactly as the command-line renderer does.
   */
  depictionSource?: DepictionSource;
  /**
   * Where the drawing sheet's title-block details (part number, revision,
   * lengths, photo) are kept. Omitted, the Drawing sheet still renders and its
   * form still drives the preview — there is just no Save.
   */
  drawings?: DrawingAdapter;
  /**
   * The owner's part-number scheme and register. Given
   * them, the drawing form's part-number box grows a Suggest button — the
   * same proposal the reconciliation report makes for this cable.
   */
  partNumbers?: PartNumberData;
  /**
   * The title-block short names the Documents view prints (destination, sync,
   * stock) — the host's cable-list rule. Absent: derived.
   */
  documentFacts?: (design: CableDesign, db: Db) => DocumentFacts;
  /**
   * The shared, reusable image library — given one,
   * the drawing sheet's photo field grows a "Choose from library…" picker
   * beside the upload. Omitted, uploading still works; there is just
   * nothing to pick from.
   */
  assets?: AssetsAdapter;
  /**
   * The design as the host has it **stored**. The Documents view labels every
   * document with whether it shows this or the unsaved draft in the editor.
   * Omitted, the editor uses the last design handed in through `design`, which
   * is the right answer for a host that reloads after each save.
   */
  savedDesign?: CableDesign;
  /**
   * How this host stores designs. Given one, the editor grows the design
   * lifecycle — Save, Revert, New, Duplicate, Rename, Delete — against
   * `savedDesign` as the baseline. Left out, it is the read-and-edit surface
   * it has always been.
   *
   * The editor never learns *where* designs are kept: no URL, no `fetch`, no
   * file path appears in this package. The studio implements this over the
   * workbench API, the ERP will implement it over its own store, and the tests
   * implement it with a `Map`.
   */
  persistence?: PersistenceAdapter;
  /** what the host has in its picker, so a suggested new id avoids the taken ones */
  designs?: DesignSummary[];
  /**
   * A design was saved, created, copied, renamed or deleted. The host refreshes
   * its list, updates its baseline, drops its unsaved buffer and opens whatever
   * the change implies — the editor never navigates on its own.
   */
  onCatalogChange?: (change: CatalogChange) => void;
  /**
   * How this host stores **artwork**. Given one, the editor grows the Artwork
   * view: drop a picture of a connector or board in, and click its pins onto
   * it. Left out, the editor draws whatever artwork already exists and offers
   * no way to add more — which is the right answer for a read-only host.
   *
   * Same contract as `persistence`: no URL and no `fetch` appears in this
   * package. See `artwork.ts`.
   */
  artwork?: ArtworkAdapter;
  /**
   * How this host stores the **parts library** — connectors, components, wire
   * stocks, boards. Given one, the Library view can add and change definitions;
   * without one it is still there, as a browsable catalog of what `db` holds.
   *
   * Same contract again: no URL and no `fetch` in this package. See
   * `definitions.ts`.
   */
  definitions?: DefinitionsAdapter;
  /**
   * A definition was added, changed or deleted. The host re-reads its library
   * and hands a fresh `db` back down — the editor does not reload on its own,
   * exactly as it does not navigate on its own.
   */
  onDefinitionsChange?: (change: DefinitionChange) => void;
  /**
   * How this host remembers the *look* of the workbench: where the parts of
   * each design were dragged to, and how big the panes were made. Given one,
   * an arrangement survives a save, a reload and a reboot; without one it
   * survives everything but the page, which is the editor's own state.
   *
   * Same contract as `persistence`: no `window`, no storage key and no JSON in
   * this package. See `layout-store.ts`.
   */
  layout?: EditorLayoutStore;
  className?: string;
  /**
   * Which of Canvas / Documents / Library / Artwork is on screen, for a host
   * that owns navigation (apps/studio's router puts this in the URL). Given a
   * value, the editor stops managing `view` itself and hides its own tabs —
   * the host is the single source of truth for what is showing, exactly as it
   * already is for `design`. Left out, the editor keeps the tabs and its
   * uncontrolled `view` state, exactly as before (tests rely on this).
   */
  view?: View;
  /**
   * The editor asking to change what is showing. Only fires today in
   * response to `view` itself changing — nothing inside a controlled editor
   * switches views on its own yet — but a controlled host should still wire
   * it up, the same way any controlled input's `onChange` is wired up.
   */
  onViewChange?: (view: View) => void;
  /**
   * Error/warning/part/joint counts, recomputed with every accepted edit.
   * A host with its own status bar (apps/studio's 26px footer) reads them
   * from here rather than re-deriving them from `design` — issues in
   * particular are cheap to get wrong by hand (severity, generated-part
   * exclusions, …) and this is already the one place that computes them.
   */
  onStatusChange?: (status: EditorStatus) => void;
  /**
   * `'full'` (the default): the editor draws its own header — doc id/label,
   * the design-lifecycle button row, undo/redo, auto-arrange, the error/
   * joint/last-edit chips — exactly as it always has, so nothing embedding
   * the editor bare (the existing tests, a future ERP that has not built its
   * own chrome yet) sees any change.
   *
   * `'host'` ( — apps/studio's workspace header): that
   * whole row disappears. The host drives the same operations through the
   * imperative `EditorHandle` a `ref` receives, and reads what the header
   * needs to render (dirty, undo/redo labels, saving, which variants exist)
   * from `onChromeStateChange`. The lifecycle **dialogs** — New/Duplicate/
   * Rename/Delete/the warnings gate — still render
   * from inside the editor in this mode (`EditorHandle.openLifecycle` opens
   * them); only the buttons that used to trigger them move to the host.
   */
  chrome?: 'full' | 'host';
  /**
   * `chrome="host"`'s state feed for the host's own header — see `chrome`.
   * Fires whenever any of it changes; a host with no header of its own
   * (`chrome="full"`, the default) never needs this.
   */
  onChromeStateChange?: (state: EditorChromeState) => void;
  /**
   * An edit was rejected (`store.ts`'s `commit`), in `chrome="host"` — the
   * editor's own in-canvas alert (`cs-rejection`) is `chrome="full"` only;
   * a host with its own toast surface (apps/studio's `sonner`) reads this
   * instead and shows it there. Never fires in `chrome="full"`.
   */
  onEditRejected?: (message: string) => void;
  /**
   * A look, not an edit (a preview inside another flow):
   * no connecting, deleting, dropping or picker, no inspector column. Pair it
   * with `chrome="host"` and no `persistence`.
   */
  readOnly?: boolean;
  /**
   * Saved revisions: given one, Documents prints a saved
   * revision (default the latest) and marks the working copy UNRELEASED —
   * see `release.ts`. Omitted, Documents prints the design in the editor.
   */
  release?: DocumentRelease;
}

/** What a host's status bar needs — see `onStatusChange`. */
export interface EditorStatus {
  errorCount: number;
  warningCount: number;
  partCount: number;
  jointCount: number;
}

/**
 * The imperative surface `chrome="host"` drives through a `ref` — every
 * operation the old `cs-toolbar` row used to trigger by itself, now callable
 * from wherever the host puts its own buttons. Reuses exactly the store
 * actions and the `useDesignLifecycle` state machine the editor's own chrome
 * (`DesignActions`) drives — nothing here is a second implementation of Save,
 * undo, or the New/Duplicate/Rename/Delete dialogs.
 */
export interface EditorHandle {
  /** the exact gate the old Save button applied: no-op when clean, opens the
   * warnings dialog when there are any, writes straight through otherwise */
  save: () => void;
  /** throws away the unsaved draft and reloads the stored design; no-op without a baseline */
  revert: () => void;
  undo: () => void;
  redo: () => void;
  /** lay the canvas out again from scratch, left to right */
  autoArrange: () => void;
  fitView: () => void;
  /** switches the canvas toolbar's select/pan tool — what V/H drive */
  setTool: (tool: CanvasTool) => void;
  /** opens the issues panel (switching to the canvas view first if needed) */
  showIssues: () => void;
  /** opens one of the lifecycle dialogs — what the host's cable/overflow/variant menus call */
  openLifecycle: (action: LifecycleAction) => void;
  /** opens the node picker at the viewport centre, listing every part — what the app's "Add part…" command calls */
  openPicker: () => void;
  /** opens the canvas's find-a-pin box (udy.6) — what `/` drives */
  findPin: () => void;
}

/** the canvas toolbar's mode — `derive.ts`'s node drag stays on in `'select'`, off in `'pan'` */
export type CanvasTool = 'select' | 'pan';

/** `chrome="host"`'s state feed — see `CableEditorProps.onChromeStateChange`. */
export interface EditorChromeState {
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  undoLabel: string | undefined;
  canRedo: boolean;
  redoLabel: string | undefined;
  /** the last lifecycle status sentence ("saved …", "went back to the saved …") */
  statusMessage: string | undefined;
  tool: CanvasTool;
}

/**
 * The whole content area belongs to one of these; documents get all of it.
 *
 * **Merge point** — when the definition-Library view lands it belongs in this
 * union too, and the Artwork surface is a better fit *inside* a library
 * definition's detail than as a peer tab: a part's picture is one of its facts.
 * Until then it stands on its own, and `ArtworkPane` is written to be dropped
 * into a detail pane unchanged (it takes a `defId` and an adapter, nothing else).
 *
 * `schematic`: the render-svg schematic, full size,
 * with its own pan/zoom — `panels/Schematic.tsx`. Distinct from `canvas`'s
 * old bottom dock tab of the same drawing, which `chrome="host"` no longer
 * draws at all (see `CableEditor`'s canvas body, below).
 */
export type View = 'canvas' | 'schematic' | 'documents' | 'library' | 'artwork';

// the Documents and Library views load on first use, not with the canvas
// (review fix, 2026-09-26: a 5.8 MB main chunk)
const DocumentsPane = lazy(() => import('./panels/Documents.tsx').then((m) => ({ default: m.DocumentsPane })));
const Library = lazy(() => import('./panels/Library.tsx').then((m) => ({ default: m.Library })));
const VIEW_LOADING = <div className="cs-empty">Loading…</div>;

const VIEW_LABELS: Record<View, string> = {
  canvas: 'Canvas',
  schematic: 'Schematic',
  documents: 'Documents',
  library: 'Library',
  artwork: 'Artwork',
};
type DockTab = 'preview' | 'json';
/** The right panel's tabs (spec: ui-redesign, Canvas v2 item 6 — e5c.5). */
type SideTab = 'connection' | 'part' | 'nets' | 'issues' | 'notes';
const SIDE_TABS: readonly SideTab[] = ['connection', 'part', 'nets', 'issues', 'notes'];
const SIDE_TAB_LABELS: Record<SideTab, string> = {
  connection: 'Connection',
  part: 'Part',
  nets: 'Nets',
  issues: 'Issues',
  notes: 'Notes',
};

/**
 * The minimap's colours: the same four the palette and the node badges use, so
 * the overview reads as the cable — board, wire, connector — and not as a grey
 * smudge. Anything unexpected gets the dim ink rather than white.
 *
 * These are CSS custom property references (`tokens.css`, `.cs-editor`'s
 * scope), not literal colours — the browser resolves them from the cascade,
 * same as any other `var()`, so the minimap repaints with the theme.
 */
/**
 * The minimap's colours, by node kind: the same hues the node badges use, so
 * the overview reads as the cable. React Flow writes these into SVG `fill`
 * attributes, where `var(--token)` does not resolve, so they are read off the
 * cascade in `useMinimapColors` and handed over as plain colours.
 */
const MINIMAP_TOKENS = {
  connector: ['--conn-kind', 'connKind'],
  segment: ['--wire-kind', 'wireKind'],
  component: ['--comp-kind', 'compKind'],
  pcba: ['--board', 'board'],
  fallback: ['--dim', 'dim'],
  canvas: ['--canvas', 'canvas'],
  scrim: ['--scrim', 'scrim'],
  accent: ['--accent', 'accent'],
} as const satisfies Record<string, readonly [string, keyof SemanticTokens]>;

type MinimapColors = Record<keyof typeof MINIMAP_TOKENS, string>;

/** Where the cascade has no tokens (a host without tokens.css, jsdom): the dark set. */
const MINIMAP_DEFAULTS = Object.fromEntries(
  Object.entries(MINIMAP_TOKENS).map(([name, [, key]]) => [name, SEMANTIC_TOKENS.dark[key]]),
) as MinimapColors;

/** Token colours resolved from `host`, re-read whenever the theme changes. */
function useMinimapColors(host: { current: HTMLElement | null }): MinimapColors {
  const [colors, setColors] = useState<MinimapColors>(MINIMAP_DEFAULTS);
  useEffect(() => {
    const read = (): void => {
      const element = host.current;
      if (element === null) return;
      const style = getComputedStyle(element);
      const next = {} as MinimapColors;
      for (const [name, [token]] of Object.entries(MINIMAP_TOKENS)) {
        const value = style.getPropertyValue(token).trim();
        next[name as keyof MinimapColors] = value === '' ? MINIMAP_DEFAULTS[name as keyof MinimapColors] : value;
      }
      setColors(next);
    };
    read();
    // the theme is an attribute on <html> (or the system preference)
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
    media?.addEventListener('change', read);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', read);
    };
  }, [host]);
  return colors;
}

/**
 * A field the browser already gives an undo stack of its own. Ctrl+Z there
 * means "put my typing back", not "reverse the last committed edit", so the
 * editor keeps its hands off.
 */
/** The joints an edge draws: one, or every member of a ground bundle. */
function jointsOfEdge(edge: Edge): number[] {
  const data = edge.data as EditorEdgeData | undefined;
  if (data === undefined) return [];
  if (Array.isArray(data.joints) && data.joints.length > 0) return data.joints;
  return typeof data.jointIndex === 'number' ? [data.jointIndex] : [];
}

function isTextEntry(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

const CableEditorInner = forwardRef(function CableEditorInner(
  props: CableEditorProps,
  ref: Ref<EditorHandle>,
): JSX.Element {
  const chrome = props.chrome ?? 'full';
  const readOnly = props.readOnly === true;
  /**
   * Someone else holds this cable's edit lock ( via the
   * host's edit session): unlike `readOnly` (a look — no inspector at all),
   * everything stays on screen with its controls disabled, and any edit that
   * still reaches the reducer is refused (below).
   */
  const editLocked = useEditLocked();
  const canEdit = !readOnly && !editLocked;
  const lockedRef = useRef(editLocked);
  lockedRef.current = editLocked;
  const reducer = useCallback((current: EditorState, action: EditorAction): EditorState => {
    const next = editorReducer(current, action);
    if (!lockedRef.current || next.design === current.design || action.type === 'load-design') return next;
    return { ...current, rejection: 'Read only — someone else is editing this cable' };
  }, []);
  const [tool, setTool] = useState<CanvasTool>('select');
  /**
   * The Parts drawer: `chrome="full"` already has the
   * palette pinned open beside the canvas; `chrome="host"` (apps/studio's
   * Build view) has no room for a permanent one (3pn.3 — two columns, not
   * five), so it gets a toggleable one instead. Same `Palette` component,
   * same `PART_MIME` drag onto `.cs-canvas`'s existing `onDrop` below — one
   * `add-instance` dispatch either way, so dragging a part in is exactly as
   * undoable as picking one from the node picker.
   */
  const [partsOpen, setPartsOpen] = useState(false);
  const [pinSearchOpen, setPinSearchOpen] = useState(false);
  /**
   * The right panel, at portrait phone widths: `.cs-side`
   * is a fixed drawer there instead of a squeezed permanent column (see
   * `editor.css`'s `@media (max-width: 639px)` block) — closed by default,
   * opened by a selection with something to show, or by `cs-side-toggle`
   * (bottom-right of the canvas, mobile-only). No effect at desktop widths:
   * the CSS that reads `is-open` only exists inside that same media query.
   */
  const [sideOpen, setSideOpen] = useState(false);
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    // the host's remembered arrangement, if it has one; a design nobody has
    // ever arranged is the only design that gets auto-arranged
    initialEditorState(
      props.design,
      props.db,
      props.layout?.positions(props.design.id),
      props.depictionSource,
    ),
  );
  const [uncontrolledView, setUncontrolledView] = useState<View>('canvas');
  // controlled when the host hands in `view`; otherwise the editor's own tabs
  // (hidden in the controlled case — see the `cs-viewtabs` nav below) drive it
  const view = props.view ?? uncontrolledView;
  const { onViewChange } = props;
  const changeView = useCallback(
    (next: View): void => {
      if (props.view === undefined) setUncontrolledView(next);
      onViewChange?.(next);
    },
    [props.view, onViewChange],
  );
  /**
   * Artwork this session has uploaded or re-anchored.
   *
   * A browser host's `depictionSource` is assembled once, at build time — the
   * studio globs the catalog's committed tree into its bundle — so a file
   * uploaded a minute ago is not in it, and neither is an anchor saved a second
   * ago. Rather than tell the user to reload the page (honest, but a poor
   * answer on a screen whose whole point is watching the anchor land), the
   * Artwork pane hands back what it just read from the host and the editor
   * layers it over the bundled source. The overlay is presentation only and
   * dies with the page; the files on disk are the truth.
   */
  const [overlay, setOverlay] = useState<ArtworkOverlay>(EMPTY_OVERLAY);
  const [dock, setDock] = useState<DockTab>('preview');
  const [side, setSide] = useState<SideTab>('issues');
  const sideTabs: readonly SideTab[] = SIDE_TABS;
  /** the node picker; `undefined` means it is closed */
  const [picker, setPicker] = useState<{ anchor?: TerminalRef } | undefined>(undefined);
  const openPicker = useCallback((anchor?: TerminalRef): void => setPicker({ anchor }), []);
  const closePicker = useCallback((): void => setPicker(undefined), []);
  const panes = usePanes(props.layout);
  const flow = useReactFlow();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const minimap = useMinimapColors(canvasRef);
  const loaded = useRef(props.design);
  const loadedDb = useRef(props.db);
  const emitted = useRef(state.design);

  // a new design handed in from outside replaces the committed one
  useEffect(() => {
    if (loaded.current === props.design) return;
    loaded.current = props.design;
    // the host's store is read here, not watched: it answers for the design
    // being opened, and the answer is what that design is arranged as
    const stored = props.layout?.positions(props.design.id);
    dispatch({
      type: 'load-design',
      design: props.design,
      ...(stored === undefined ? {} : { positions: stored }),
    });
  }, [props.design, props.layout]);

  // …and a new library replaces the one every derived view reads through, which
  // is how a connector added in the Library reaches the palette and the canvas
  // without the page being reloaded
  useEffect(() => {
    if (loadedDb.current === props.db) return;
    loadedDb.current = props.db;
    dispatch({ type: 'load-db', db: props.db });
  }, [props.db]);

  const { onDesignChange } = props;
  useEffect(() => {
    if (emitted.current === state.design) return;
    emitted.current = state.design;
    // A host that stores what the editor hands it and passes it straight back
    // down — which is what the studio does, and what any controlled host does —
    // would otherwise hand this very document back as "a new design from
    // outside" one render later, and the editor would re-open it: arrangement
    // auto-laid out again, undo history thrown away, on **every accepted edit**.
    // What we emitted is what we already have open; record it as loaded.
    loaded.current = state.design;
    onDesignChange?.(state.design);
  }, [state.design, onDesignChange]);

  // the arrangement, back to the host that can outlive the page — but only
  // once the user has actually moved something. See `remember.ts`.
  useRememberedPositions(props.layout, state.design.id, state.positions);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.15 }));
    return () => cancelAnimationFrame(frame);
  }, [state.design.id, flow]);

  // Ctrl+Z / ⌘Z, Ctrl+Shift+Z / ⌘⇧Z, and Ctrl+Y for the Windows hand.
  // `chrome="host"` skips this: the host's own command registry owns Ctrl+Z/
  // Ctrl+Y there (through `EditorHandle.undo`/`redo`) and this listener would
  // otherwise fire the same keystroke a second time.
  useEffect(() => {
    if (chrome !== 'full') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      if (isTextEntry(event.target)) return;
      event.preventDefault();
      dispatch({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chrome]);

  const selectedTerminalKey =
    state.selection?.kind === 'terminal' ? terminalKey(state.selection.ref) : undefined;

  const netKeys = useMemo(() => {
    if (selectedTerminalKey === undefined) return undefined;
    const net = netForTerminal(deriveNets(state.design, state.db), selectedTerminalKey);
    return net === undefined ? undefined : new Set(net.terminals.map((t) => t.key));
  }, [selectedTerminalKey, state.design, state.db]);

  // nodes and edges come from one derivation: the edges leave the port
  // columns the breakout router placed on the wire nodes (`breakout.ts`)
  const { nodes, edges } = useMemo(
    () =>
      deriveFlow(state.design, state.db, {
        positions: state.positions,
        depictions: state.depictions,
        ...(selectedTerminalKey === undefined ? {} : { selectedTerminalKey }),
        ...(netKeys === undefined ? {} : { netKeys }),
        ...(state.selection?.kind === 'instance'
          ? { selectedInstanceId: state.selection.id }
          : {}),
        ...(state.selection?.kind === 'joint'
          ? { selectedJointIndex: state.selection.index }
          : state.selection?.kind === 'joints'
            ? { selectedJoints: state.selection.indices }
            : {}),
      }),
    [
      state.design,
      state.db,
      state.positions,
      state.depictions,
      state.selection,
      selectedTerminalKey,
      netKeys,
    ],
  );

  /**
   * Level of detail (`lod.ts`): the toggle, remembered by the host when it
   * can, and zoom — below `LOD_ZOOM` the canvas draws Parts whatever the
   * toggle says.
   */
  const [detailChoice, setDetailChoice] = useState<CanvasDetail>(() => props.layout?.detail?.() ?? 'pins');
  const { layout } = props;
  const chooseDetail = useCallback(
    (next: CanvasDetail): void => {
      setDetailChoice(next);
      layout?.saveDetail?.(next);
    },
    [layout],
  );
  const zoomedOut = useStore((s) => s.transform[2] < LOD_ZOOM);
  const detail: CanvasDetail = detailChoice === 'parts' || zoomedOut ? 'parts' : 'pins';
  const parts = useMemo(() => (detail === 'parts' ? partsFlow({ nodes, edges }) : undefined), [detail, nodes, edges]);

  /**
   * "Part labels": off by default — a populated
   * board's parts print no ref/value over the artwork until the viewer asks
   * for it, hover always shows the same facts as a tooltip either way.
   * Remembered per viewer, the same way the Parts | Pins choice is.
   */
  const [partLabelsVisible, setPartLabelsVisible] = useState<boolean>(() => props.layout?.partLabels?.() ?? false);
  const togglePartLabels = useCallback((): void => {
    setPartLabelsVisible((was) => {
      const next = !was;
      layout?.savePartLabels?.(next);
      return next;
    });
  }, [layout]);

  /**
   * What React Flow measured, per node and detail. The nodes are derived
   * afresh on every edit, so a size React Flow reports ('dimensions') has to
   * be kept and handed back as `measured` — without it React Flow treats
   * every derived node as never measured: the minimap draws no nodes (it
   * reads the node's own `measured`), and handle bounds are thrown away and
   * re-read on every render. Until the first measurement, `initialWidth` /
   * `initialHeight` are the sizes `layout-size.ts` computes.
   */
  const [measured, setMeasured] = useState<ReadonlyMap<string, { width: number; height: number }>>(() => new Map());
  const flowNodes = useMemo((): Node[] => {
    const list: Node[] = parts?.nodes ?? nodes;
    return list.map((node) => {
      const size = measured.get(`${detail}:${node.id}`);
      if (size !== undefined) return { ...node, measured: size };
      const estimate =
        node.type === 'card' ? cardSize(node.data as CardNodeData) : estimateNodeSize((node as (typeof nodes)[number]).data);
      return { ...node, initialWidth: estimate.width, initialHeight: estimate.height };
    });
  }, [parts, nodes, measured, detail]);
  /**
   * Re-pin grips: a selected wire, in Pins detail and
   * with editing allowed, can have its ends dragged to another pin. Only the
   * selected wire is reconnectable, so dragging from a pin keeps meaning "new
   * wire" everywhere else — the two gestures never compete for one spot.
   */
  const flowEdges: Edge[] = useMemo(() => {
    if (parts !== undefined) return parts.edges;
    if (!canEdit) return edges;
    return edges.map((edge) => {
      if (edge.selected !== true) return edge;
      const ends = reconnectableEnds(state.design, edge);
      if (ends === false) return edge;
      const grips: EditorEdgeData['grips'] = ends === true ? 'both' : ends;
      // above everything, a mating face (zIndex 2) included: its grip sits on
      // a pin inside the face, and must be the thing under the pointer there
      return { ...edge, reconnectable: ends, zIndex: 3, data: { ...edge.data!, grips } };
    });
  }, [parts, edges, canEdit, state.design]);

  /**
   * A recipe edit can swap what an instance *is* under
   * the same id — `w1` from mini-coax to bonded multi-core, a pigtail more or less —
   * so the node keeps its id while its handles change. React Flow caches a
   * node's handle positions by id; without being told, it keeps the old ones
   * and every edge to a new handle silently disappears. Tell it, and forget
   * the old sizes, whenever the parts' definitions or pigtails change.
   */
  const updateNodeInternals = useUpdateNodeInternals();
  const partSignatures = useMemo(() => {
    const out = new Map<string, string>();
    const i = state.design.instances;
    for (const x of [...i.connectors, ...i.components, ...i.pcbas]) out.set(x.id, x.def);
    for (const x of i.segments) out.set(x.id, `${x.def}|${(x.pigtails ?? []).map((p) => `${p.id}@${p.end}`).join(',')}`);
    return out;
  }, [state.design.instances]);
  const lastSignatures = useRef(partSignatures);
  useEffect(() => {
    const before = lastSignatures.current;
    lastSignatures.current = partSignatures;
    // only a part that is still there under the same id but is now something else
    const changed = [...partSignatures].filter(([id, sig]) => before.has(id) && before.get(id) !== sig).map(([id]) => id);
    if (changed.length === 0) return;
    setMeasured((previous) => new Map([...previous].filter(([key]) => !changed.includes(key.slice(key.indexOf(':') + 1)))));
    const frame = requestAnimationFrame(() => updateNodeInternals(changed));
    return () => cancelAnimationFrame(frame);
  }, [partSignatures, updateNodeInternals]);

  /**
   * Handles that moved inside a node of unchanged size:
   * deleting a wire re-spaces its end's port column and can turn the face,
   * and React Flow — which re-reads handles only when a node resizes — keeps
   * drawing every other edge from where its handle *used* to be. Re-read the
   * nodes whose handles moved.
   */
  const handleSigs = useMemo(
    () => (detail === 'pins' ? handleSignatures(nodes, edges) : new Map<string, string>()),
    [detail, nodes, edges],
  );
  const lastHandleSigs = useRef(handleSigs);
  useEffect(() => {
    const before = lastHandleSigs.current;
    lastHandleSigs.current = handleSigs;
    const changed = changedHandleNodes(before, handleSigs);
    if (changed.length > 0) updateNodeInternals(changed);
  }, [handleSigs, updateNodeInternals]);

  const offsets = useRef<ReadonlyMap<string, { x: number; y: number }> | undefined>(undefined);
  offsets.current = parts?.offsets;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const sizes: [string, { width: number; height: number }][] = [];
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) {
        // a card sits centred on its part's box: move the part, not the card
        const offset = offsets.current?.get(change.id) ?? { x: 0, y: 0 };
        dispatch({
          type: 'move-node',
          id: change.id,
          position: { x: change.position.x - offset.x, y: change.position.y - offset.y },
        });
      } else if (change.type === 'dimensions' && change.dimensions !== undefined) {
        sizes.push([`${detailRef.current}:${change.id}`, change.dimensions]);
      }
    }
    if (sizes.length === 0) return;
    setMeasured((previous) => {
      const same = sizes.every(([key, size]) => {
        const had = previous.get(key);
        return had !== undefined && had.width === size.width && had.height === size.height;
      });
      if (same) return previous;
      const next = new Map(previous);
      for (const [key, size] of sizes) next.set(key, size);
      return next;
    });
  }, []);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // a board pad's secondary handles carry a suffix; every one of them is the
  // same terminal — but the pad dropped on is the pad the joint names, when
  // the terminal has several (: braid to the GND pad on
  // its own face)
  const refOf = useCallback((instance: string, handleId: string): TerminalRef => {
    const ref = parseTerminalKey(terminalKeyOfHandle(handleId));
    const node = nodesRef.current.find((candidate) => candidate.id === instance);
    if (node?.data.kind !== 'pcba' || node.data.board === undefined) return ref;
    const handles = node.data.board.handles.filter((handle) => handle.key === terminalKeyOfHandle(handleId));
    const pad = handles.find((handle) => handle.id === handleId)?.ref;
    return pad === undefined || new Set(handles.map((handle) => handle.ref)).size < 2 ? ref : { ...ref, pad };
  }, []);
  const onConnect: OnConnect = useCallback((connection: Connection) => {
    const { sourceHandle, targetHandle } = connection;
    if (sourceHandle === null || targetHandle === null) return;
    dispatch({
      type: 'add-joint',
      a: refOf(connection.source, sourceHandle),
      b: refOf(connection.target, targetHandle),
    });
  }, [refOf]);

  // a wire's end dragged by its grip onto another handle: move that end
  const [repinning, setRepinning] = useState(false);
  const designRef = useRef(state.design);
  designRef.current = state.design;
  const onReconnect = useCallback(
    (edge: Edge, connection: Connection) => {
      const moves = reconnectMoves(designRef.current, edge as Edge<EditorEdgeData>, connection, refOf);
      if (moves !== undefined) dispatch({ type: 'move-joint-ends', moves });
    },
    [refOf],
  );

  /**
   * Safe part delete: a part with wires on it asks
   * first, in the app (`ConfirmDeleteDialog` — `window.confirm` does not work
   * in every host); one without goes at once. Either way it is one
   * `delete-instances` dispatch, one undo step — even when a board's docked
   * connector rides along (see `keepDockedConnectors` in the store).
   */
  const [pendingDelete, setPendingDelete] = useState<DeletePlan | undefined>(undefined);
  const requestDelete = useCallback((ids: readonly string[]) => {
    const plan = deletePlan(designRef.current, ids);
    if (plan.ids.length === 0) return;
    if (plan.joints.length === 0) dispatch({ type: 'delete-instances', ids: plan.ids });
    else setPendingDelete(plan);
  }, []);
  /**
   * React Flow's Delete key on a selected node: never let it remove the node
   * and its connected edges as two edits (`onEdgesDelete` + `onNodesDelete`)
   * — hand the node ids to `requestDelete` and tell React Flow to do nothing.
   * A delete of edges alone goes ahead as before.
   */
  const onBeforeDelete = useCallback(
    async ({ nodes: doomed }: { nodes: Node[]; edges: Edge[] }): Promise<boolean> => {
      if (doomed.length === 0) return true;
      requestDelete(doomed.map((node) => node.id));
      return false;
    },
    [requestDelete],
  );

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    // a ground bundle is one edge for several joints: all of them go, as one
    // undoable step
    // …and a pigtail's braid edge takes just that braid out of the twist
    const braids = deleted.flatMap((edge) => {
      const braid = (edge.data as EditorEdgeData | undefined)?.braid;
      return braid === undefined ? [] : [{ segment: braid.segment, end: braid.end, id: braid.id, member: braid.member }];
    });
    const indices = deleted
      .filter((edge) => (edge.data as EditorEdgeData | undefined)?.braid === undefined)
      .flatMap((edge) => jointsOfEdge(edge));
    if (braids.length > 0) dispatch({ type: 'delete-joints', indices, braids });
    else if (indices.length > 0) dispatch({ type: 'delete-joints', indices });
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!canEdit) return;
      const payload = event.dataTransfer.getData(PART_MIME);
      if (payload === '') return;
      const part = JSON.parse(payload) as { kind: InstanceKind; def: string };
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      dispatch({ type: 'add-instance', kind: part.kind, def: part.def, position });
    },
    [flow, canEdit],
  );

  // the hovered ground pigtail: shared by its wire node and its edge
  const [hoverStore] = useState(createHoverStore);

  // the strip practice, once, for the segment 3D view (50a.58)
  const [stripPractice, setStripPractice] = useState<StripPractice[] | undefined>(undefined);
  const loadPractice = props.stripPractice;
  useEffect(() => {
    if (loadPractice === undefined) return;
    let live = true;
    void loadPractice().then((outcome) => {
      if (live && outcome.ok) setStripPractice(outcome.value);
    });
    return () => {
      live = false;
    };
  }, [loadPractice]);

  const api = useMemo(
    () => ({
      dispatch: dispatch as (action: EditorAction) => void,
      selection: state.selection,
      openPicker,
      partLabelsVisible,
      requestDelete,
      ...(stripPractice === undefined ? {} : { stripPractice }),
    }),
    [state.selection, openPicker, partLabelsVisible, requestDelete, stripPractice],
  );

  // the drawing form's Suggest (hdy.9): one scope per catalog, like the Library's
  const partNumbers = props.partNumbers;
  const pnScope = useMemo(() => (partNumbers === undefined ? undefined : partNumberScope(partNumbers, state.db)), [partNumbers, state.db]);

  /**
   * What the preview and the documents draw artwork from: the host's source
   * with this session's uploads layered on top. `true` means "read the catalog
   * tree off disk", which only a Node host can do and which no upload path
   * reaches, so it is passed through untouched.
   */
  const depictions = useMemo(() => {
    const base = props.depictionSource ?? props.previewDepictions ?? false;
    if (base === true || overlayIsEmpty(overlay)) return base;
    return overlaySource(base === false ? undefined : base, overlay);
  }, [props.depictionSource, props.previewDepictions, overlay]);

  // the canvas draws boards from the same artwork, when it is a source it can
  // read without a filesystem (`true` means "the catalog tree on disk")
  const canvasDepictions = typeof depictions === 'object' ? depictions : undefined;
  useEffect(() => {
    dispatch({ type: 'set-depictions', depictions: canvasDepictions });
  }, [canvasDepictions]);

  const status = useMemo<EditorStatus>(
    () => ({
      errorCount: state.issues.filter((issue) => issue.severity === 'error').length,
      warningCount: state.issues.filter((issue) => issue.severity === 'warning').length,
      partCount:
        state.design.instances.connectors.length +
        state.design.instances.segments.length +
        state.design.instances.components.length +
        state.design.instances.pcbas.length,
      jointCount: state.design.joints.length,
    }),
    [state.issues, state.design],
  );
  const { onStatusChange } = props;
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  const errorCount = status.errorCount;
  const undoable = undoDescription(state);
  const redoable = redoDescription(state);

  /**
   * The design lifecycle, called unconditionally (rules of hooks: `chrome`
   * does not change for a mounted editor) so `chrome="host"` can drive it
   * through the imperative handle below. `chrome="full"` also calls this —
   * harmlessly, its own `dialog`/`problem` state just never renders, because
   * `DesignActions` (the header, `chrome="full"` only) owns its *own* copy of
   * this same hook for its button row. Passing `dispatch` explicitly (rather
   * than through `useEditorApi()`) is what makes that safe: this call sits in
   * the same component that *renders* `EditorContext.Provider` below, which
   * cannot read its own provider's value back out through context.
   */
  const lifecycle = useDesignLifecycle({
    design: state.design,
    persistence: props.persistence,
    db: state.db,
    depictions,
    dispatch: dispatch as (action: EditorAction) => void,
    ...(props.savedDesign === undefined ? {} : { baseline: props.savedDesign }),
    ...(props.designs === undefined ? {} : { designs: props.designs }),
    ...(props.onCatalogChange === undefined ? {} : { onCatalogChange: props.onCatalogChange }),
  });

  const showIssues = useCallback((): void => {
    changeView('canvas');
    setSide('issues');
  }, [changeView]);

  /**
   * The right panel follows the selection, the way the old always-visible
   * Inspector did: an edge or a ground bundle is a connection, so its tab
   * comes forward; a part is a part. Nets and Issues are never picked for
   * you — they stay wherever the user last left them until a selection with
   * an opinion arrives.
   */
  const selectionKind = state.selection?.kind;
  useEffect(() => {
    if (selectionKind === 'instance') setSide('part');
    else if (selectionKind === 'joint' || selectionKind === 'joints' || selectionKind === 'terminal') {
      setSide('connection');
    }
    // a selection with something to show is also what opens the mobile
    // drawer (50a.35) — inert at desktop widths, see `.cs-side`'s own CSS
    if (selectionKind !== undefined) setSideOpen(true);
  }, [selectionKind]);

  /**
   * `useDesignLifecycle` hands back fresh closures every render (it is not
   * memoized — `DesignActions`, its other caller, never needed it to be).
   * A `useImperativeHandle` whose factory depended on those directly would
   * detach and reattach the ref (calling a host's `ref` with `null`, then
   * with a new handle) on **every render**, not only when a cable opens or
   * closes — and a host that resets its own state on `null` (exactly what
   * `chrome="host"`'s `EditorChromeState` is for) would see it flicker back
   * to defaults after every accepted edit. A ref that always reads the
   * latest lifecycle through this ref, instead of closing over it, keeps the
   * handle object itself stable for the component's whole lifetime, so the
   * host's `ref` callback fires only on a real mount/unmount.
   */
  /**
   * Find a pin (udy.6): select the terminal — its net lights — and centre the
   * view on it. In Parts detail the pins are not drawn, so switch to Pins
   * first and look again on the next frame.
   */
  const focusPin = (key: string): void => {
    dispatch({ type: 'select', selection: { kind: 'terminal', ref: parseTerminalKey(key) } });
    const sel = `[data-terminal="${key.replace(/["\\]/g, (c) => `\\${c}`)}"], .react-flow__handle[data-handleid="${key.replace(/["\\]/g, (c) => `\\${c}`)}"]`;
    const centre = (tries: number): void => {
      const el = canvasRef.current?.querySelector(sel);
      if (el === null || el === undefined) {
        if (tries > 0) {
          if (detail === 'parts') chooseDetail('pins');
          requestAnimationFrame(() => centre(tries - 1));
        }
        return;
      }
      const box = el.getBoundingClientRect();
      const at = flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      void flow.setCenter(at.x, at.y, { zoom: Math.max(flow.getZoom(), 1), duration: 250 });
    };
    requestAnimationFrame(() => centre(3));
  };

  const latest = useRef({ lifecycle, flow, showIssues, openPicker });
  latest.current = { lifecycle, flow, showIssues, openPicker };

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      save: () => latest.current.lifecycle.requestSave(),
      revert: () => latest.current.lifecycle.revert(),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      autoArrange: () => dispatch({ type: 'auto-arrange' }),
      fitView: () => void latest.current.flow.fitView({ padding: 0.15 }),
      setTool,
      showIssues: () => latest.current.showIssues(),
      openLifecycle: (action) => latest.current.lifecycle.openLifecycle(action),
      openPicker: () => latest.current.openPicker(undefined),
      findPin: () => setPinSearchOpen(true),
    }),
    [],
  );

  // a reload or tab close with unsaved edits asks first
  useUnsavedChangesGuard(lifecycle.dirty && props.readOnly !== true);

  const { onChromeStateChange } = props;
  useEffect(() => {
    if (chrome !== 'host') return;
    onChromeStateChange?.({
      // a read-only view (a locked revision, an offline copy) has nothing to save
      dirty: lifecycle.dirty && !readOnly,
      saving: lifecycle.busy && lifecycle.dialog === undefined,
      canUndo: undoable !== undefined,
      undoLabel: undoable,
      canRedo: redoable !== undefined,
      redoLabel: redoable,
      statusMessage: lifecycle.status,
      tool,
    });
  }, [
    chrome,
    onChromeStateChange,
    lifecycle.dirty,
    readOnly,
    lifecycle.busy,
    lifecycle.dialog,
    lifecycle.status,
    undoable,
    redoable,
    tool,
  ]);

  // `chrome="full"` keeps the in-canvas alert below; `chrome="host"` reports
  // the rejection to the studio's own toast surface instead and clears it —
  // there is nothing left for an in-canvas alert to show in that mode.
  const { onEditRejected } = props;
  useEffect(() => {
    if (chrome !== 'host' || state.rejection === undefined) return;
    onEditRejected?.(state.rejection);
    dispatch({ type: 'dismiss-rejection' });
  }, [chrome, state.rejection, onEditRejected]);

  return (
    <EditorContext.Provider value={api}>
      <HoverContext.Provider value={hoverStore}>
      <div className={classes('cs-editor', props.className)}>
        {chrome !== 'full' ? null : (
          <header className="cs-toolbar">
            <span className="cs-doc-id">{state.design.id}</span>
            <span className="cs-doc-label">{state.design.label}</span>
            {props.persistence === undefined ? null : (
              <DesignActions
                design={state.design}
                persistence={props.persistence}
                // the wizard needs the library to offer parts and work the joints
                // out; without it New falls back to the plain name-and-id dialog
                db={state.db}
                depictions={depictions}
                {...(props.savedDesign === undefined ? {} : { baseline: props.savedDesign })}
                {...(props.designs === undefined ? {} : { designs: props.designs })}
                {...(props.onCatalogChange === undefined
                  ? {}
                  : { onCatalogChange: props.onCatalogChange })}
              />
            )}
            <span className="cs-spacer" />
            {/* the only button that moves parts the user placed — the arrangement
                is theirs, and nothing else is allowed to touch it */}
            <button
              type="button"
              className="cs-arrange"
              title="Lay the parts out again from scratch, left to right. Your own arrangement is replaced."
              onClick={() => dispatch({ type: 'auto-arrange' })}
            >
              ⇹ auto-arrange
            </button>
            <button
              type="button"
              className="cs-history"
              disabled={undoable === undefined}
              title={undoable === undefined ? 'nothing to undo' : `Undo: ${undoable}`}
              aria-label={undoable === undefined ? 'nothing to undo' : `Undo: ${undoable}`}
              onClick={() => dispatch({ type: 'undo' })}
            >
              ↶ {undoable === undefined ? 'undo' : `undo ${undoable}`}
            </button>
            <button
              type="button"
              className="cs-history"
              disabled={redoable === undefined}
              title={redoable === undefined ? 'nothing to redo' : `Redo: ${redoable}`}
              aria-label={redoable === undefined ? 'nothing to redo' : `Redo: ${redoable}`}
              onClick={() => dispatch({ type: 'redo' })}
            >
              ↷ {redoable === undefined ? 'redo' : `redo ${redoable}`}
            </button>
            <span className={classes('cs-chip', errorCount > 0 && 'is-error')}>
              {errorCount} error{errorCount === 1 ? '' : 's'}
            </span>
            <span className="cs-chip">{state.design.joints.length} joints</span>
            <span className="cs-chip">{state.lastAccepted ?? 'no edits yet'}</span>
          </header>
        )}

        {chrome !== 'full' || state.rejection === undefined ? null : (
          <div className="cs-rejection" role="alert">
            <strong>edit rejected</strong>
            <span>{state.rejection}</span>
            <button type="button" onClick={() => dispatch({ type: 'dismiss-rejection' })}>
              dismiss
            </button>
          </div>
        )}

        {chrome !== 'host' || props.persistence === undefined ? null : (
          <DesignLifecycleDialogs
            api={lifecycle}
            design={state.design}
            persistence={props.persistence}
            db={state.db}
            depictions={depictions}
            {...(props.designs === undefined ? {} : { designs: props.designs })}
          />
        )}

        {/* the content area belongs to one view at a time: the canvas is the
            authoring surface, documents are the deliverables. Documents are
            mounted only once asked for, so a first load derives nothing.
            A host that controls `view` (apps/studio's top bar switch) owns
            this choice instead, so the editor's own tabs step aside. */}
        {props.view !== undefined ? null : (
          <nav className="cs-tabs cs-viewtabs" aria-label="editor view">
            {(
              [
                'canvas',
                'schematic',
                'documents',
                'library',
                ...(props.artwork === undefined ? [] : ['artwork']),
              ] as View[]
            ).map((tab) => (
              <button
                key={tab}
                type="button"
                className={classes(view === tab && 'is-active')}
                aria-pressed={view === tab}
                onClick={() => changeView(tab)}
              >
                {VIEW_LABELS[tab]}
              </button>
            ))}
          </nav>
        )}

        {view === 'library' ? (
          <Suspense fallback={VIEW_LOADING}>
          <Library
            db={state.db}
            {...(props.definitions === undefined ? {} : { definitions: props.definitions })}
            {...(props.onDefinitionsChange === undefined
              ? {}
              : { onDefinitionsChange: props.onDefinitionsChange })}
          />
          </Suspense>
        ) : view === 'artwork' && props.artwork !== undefined ? (
          <ArtworkPane db={state.db} adapter={props.artwork} onOverlayChange={setOverlay} />
        ) : view === 'schematic' ? (
          <SchematicPane
            design={state.design}
            db={state.db}
            depictions={depictions}
            partLabels={partLabelsVisible}
            onTogglePartLabels={togglePartLabels}
          />
        ) : view === 'documents' ? (
          <PartNumberContext.Provider value={pnScope}>
          <Suspense fallback={VIEW_LOADING}>
          <DocumentsPane
            design={state.design}
            db={state.db}
            // the design the host handed in is the stored one until it says
            // otherwise; everything the editor has committed on top is draft
            saved={props.savedDesign ?? props.design}
            depictions={depictions}
            {...(props.drawings === undefined ? {} : { drawings: props.drawings })}
            {...(props.assets === undefined ? {} : { assets: props.assets })}
            {...(props.release === undefined ? {} : { release: props.release })}
            {...(props.partNumbers === undefined ? {} : { partNumbers: props.partNumbers })}
            {...(props.documentFacts === undefined ? {} : { facts: props.documentFacts })}
          />
          </Suspense>
          </PartNumberContext.Provider>
        ) : (
          <div
            // `cs-body-host`: lets the mobile media
            // query zero out the right columns without guessing which of
            // the two very different grid shapes (2 host columns vs 5 full
            // ones) is on screen
            className={classes('cs-body', chrome === 'host' && 'cs-body-host')}
            ref={panes.bodyRef}
            style={
              // the Build layout in host chrome has no left Parts palette
              // (spec: ui-redesign, mockups) — two columns, not five
              readOnly
                ? { gridTemplateColumns: 'minmax(0, 1fr)' }
                : chrome === 'host'
                ? { gridTemplateColumns: `minmax(0, 1fr) ${SPLITTER_SIZE}px ${panes.sizes.side}px` }
                : panes.bodyStyle
            }
          >
            {chrome !== 'full' ? null : (
              <>
                <Palette db={state.db} />

                <Splitter
                  axis="x"
                  sign={1}
                  size={panes.sizes.palette}
                  label="drag to resize the parts palette"
                  onResize={(size) => panes.resize('palette', size)}
                  onReset={() => panes.reset('palette')}
                />
              </>
            )}

            <div className="cs-centre" ref={panes.centreRef}>
              <div
                className="cs-canvas"
                ref={canvasRef}
                tabIndex={0}
                onDrop={onDrop}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }}
                onKeyDown={(event) => {
                  if (isTextEntry(event.target)) return;
                  if (event.key === '/' && chrome === 'full') {
                    event.preventDefault();
                    setPinSearchOpen(true);
                    return;
                  }
                  if (!canEdit || event.key !== 'Tab' || picker !== undefined) return;
                  event.preventDefault();
                  openPicker(state.selection?.kind === 'terminal' ? state.selection.ref : undefined);
                }}
              >
                <NetHover design={state.design} db={state.db} container={canvasRef} />
                {!pinSearchOpen ? null : (
                  <PinSearch
                    design={state.design}
                    db={state.db}
                    onPick={focusPin}
                    onClose={() => setPinSearchOpen(false)}
                  />
                )}
                {/* select / pan, auto-arrange, fit view — top-centre, per the
                    mockup. Zoom stays on React Flow's own bottom-left
                    `<Controls>`; Parts | Pins is the level of detail
                    (`lod.ts`). */}
                <div className="cs-canvas-toolbar" role="toolbar" aria-label="canvas tools">
                  {chrome !== 'host' || readOnly ? null : (
                    <>
                      <button
                        type="button"
                        className={classes('cs-tool-btn', partsOpen && 'is-active')}
                        aria-pressed={partsOpen}
                        title="Parts — drag one onto the canvas, or press Tab for the picker"
                        aria-label="Parts"
                        disabled={editLocked}
                        onClick={() => setPartsOpen((open) => !open)}
                      >
                        <IconBox size={15} />
                      </button>
                      <span className="cs-tool-divider" aria-hidden="true" />
                    </>
                  )}
                  <button
                    type="button"
                    className={classes('cs-tool-btn', tool === 'select' && 'is-active')}
                    aria-pressed={tool === 'select'}
                    title="Select — V"
                    aria-label="Select tool"
                    onClick={() => setTool('select')}
                  >
                    <IconPointer size={15} />
                  </button>
                  <button
                    type="button"
                    className={classes('cs-tool-btn', tool === 'pan' && 'is-active')}
                    aria-pressed={tool === 'pan'}
                    title="Pan — H"
                    aria-label="Pan tool"
                    onClick={() => setTool('pan')}
                  >
                    <IconHandStop size={15} />
                  </button>
                  <span className="cs-tool-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="cs-tool-btn"
                    title="Auto-arrange — Shift A"
                    aria-label="Auto-arrange"
                    onClick={() => dispatch({ type: 'auto-arrange' })}
                  >
                    <IconLayoutDistributeHorizontal size={15} />
                  </button>
                  <button
                    type="button"
                    className="cs-tool-btn"
                    title="Fit view — Shift 1"
                    aria-label="Fit view"
                    onClick={() => void flow.fitView({ padding: 0.15 })}
                  >
                    <IconMaximize size={15} />
                  </button>
                  <button
                    type="button"
                    className={classes('cs-tool-btn', pinSearchOpen && 'is-active')}
                    aria-pressed={pinSearchOpen}
                    title="Find a pin — /"
                    aria-label="Find a pin"
                    onClick={() => setPinSearchOpen((open) => !open)}
                  >
                    <IconSearch size={15} />
                  </button>
                  <span className="cs-tool-divider" aria-hidden="true" />
                  <div className="cs-lod" role="group" aria-label="level of detail">
                    {(['parts', 'pins'] as const).map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={classes(
                          'cs-lod-btn',
                          detail === level && 'is-active',
                          level === 'parts' && zoomedOut && detailChoice === 'pins' && 'is-auto',
                        )}
                        aria-pressed={detail === level}
                        title={
                          level === 'parts'
                            ? zoomedOut && detailChoice === 'pins'
                              ? 'Parts — zoomed out; zoom in for pins'
                              : 'Parts: one card per part, one bundle per connection'
                            : 'Pins: every pad, face and pin'
                        }
                        onClick={() => chooseDetail(level)}
                      >
                        {level === 'parts' ? 'Parts' : 'Pins'}
                      </button>
                    ))}
                  </div>
                  <span className="cs-tool-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className={classes('cs-tool-btn', partLabelsVisible && 'is-active')}
                    aria-pressed={partLabelsVisible}
                    title={
                      partLabelsVisible
                        ? 'Part labels — showing every populated part’s ref/value; hover a part for its details either way'
                        : 'Part labels — hidden; hover a part for its ref/value/package'
                    }
                    aria-label="Part labels"
                    onClick={togglePartLabels}
                  >
                    <IconTag size={15} />
                  </button>
                </div>

                {/* portrait phone widths only (50a.35) — reopens the
                    inspector drawer after it has been closed; the CSS that
                    shows this button lives inside the same media query as
                    `.cs-side`'s drawer behaviour, so it is inert on desktop */}
                {readOnly ? null : (
                <button
                  type="button"
                  className="cs-side-toggle"
                  title="Inspector"
                  aria-label="Inspector"
                  aria-pressed={sideOpen}
                  onClick={() => setSideOpen((open) => !open)}
                >
                  <IconLayoutSidebarRight size={16} />
                </button>
                )}

                {chrome !== 'host' || !partsOpen ? null : (
                  <div className="cs-parts-drawer" role="region" aria-label="Parts">
                    <div className="cs-parts-drawer-head">
                      <span>Parts</span>
                      <button
                        type="button"
                        title="Close"
                        aria-label="Close parts"
                        onClick={() => setPartsOpen(false)}
                      >
                        <IconX size={14} />
                      </button>
                    </div>
                    <Palette db={state.db} />
                  </div>
                )}

                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodesConnectable={canEdit && detail === 'pins'}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  nodesDraggable={tool === 'select'}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={() => dispatch({ type: 'begin-move' })}
                  onNodeDragStop={() => dispatch({ type: 'end-move' })}
                  onConnect={onConnect}
                  edgesReconnectable={false}
                  onReconnect={onReconnect}
                  onReconnectStart={() => setRepinning(true)}
                  onReconnectEnd={() => setRepinning(false)}
                  {...(repinning ? { className: 'cs-repinning' } : {})}
                  reconnectRadius={REPIN_GRIP_RADIUS}
                  onBeforeDelete={onBeforeDelete}
                  onEdgesDelete={onEdgesDelete}
                  onPaneClick={() => dispatch({ type: 'select', selection: undefined })}
                  onEdgeClick={(_, edge) => {
                    const indices = jointsOfEdge(edge);
                    const [index] = indices;
                    if (index === undefined) return;
                    dispatch({
                      type: 'select',
                      selection:
                        indices.length === 1
                          ? { kind: 'joint', index }
                          : { kind: 'joints', indices },
                    });
                  }}
                  connectionMode={ConnectionMode.Loose}
                  deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
                  minZoom={0.05}
                  maxZoom={4}
                  proOptions={{ hideAttribution: false }}
                  fitView
                >
                  <Background gap={24} />
                  <Controls />
                  {/* the minimap is drawn, not defaulted: React Flow's own
                      colours are a white card, which on this canvas read as a
                      blank rectangle someone forgot to style (50a.21). Nodes
                      keep the palette's kind colours, so the map is a legend
                      of the cable as much as a viewport. */}
                  <MiniMap
                    pannable
                    zoomable
                    className="cs-minimap"
                    style={{ width: 150, height: 100 }}
                    bgColor={minimap.canvas}
                    maskColor={minimap.scrim}
                    maskStrokeColor={minimap.accent}
                    maskStrokeWidth={1}
                    nodeColor={(node: Node) => {
                      const kind = node.type === 'card' ? (node.data as CardNodeData).part : node.type;
                      return minimap[(kind ?? '') as 'connector' | 'segment' | 'component' | 'pcba'] ?? minimap.fallback;
                    }}
                    nodeStrokeColor={minimap.canvas}
                    nodeBorderRadius={3}
                    ariaLabel="canvas overview"
                  />
                </ReactFlow>
              </div>

              {/* the Build layout in host chrome has no bottom schematic/JSON
                  dock (spec: ui-redesign, mockups) — the schematic is its own
                  full-size view (`view="schematic"`) and JSON moved to the
                  Documents view's own tab; `chrome="full"` is unchanged. */}
              {chrome !== 'full' ? null : (
                <>
                  <Splitter
                    axis="y"
                    sign={-1}
                    size={panes.sizes.dock}
                    label="drag to resize the schematic preview"
                    onResize={(size) => panes.resize('dock', size)}
                    onReset={() => panes.reset('dock')}
                  />

                  <div className="cs-dock" style={panes.dockStyle}>
                    <nav className="cs-tabs">
                      <button
                        type="button"
                        className={classes(dock === 'preview' && 'is-active')}
                        onClick={() => setDock('preview')}
                      >
                        schematic
                      </button>
                      <button
                        type="button"
                        className={classes(dock === 'json' && 'is-active')}
                        onClick={() => setDock('json')}
                      >
                        JSON
                      </button>
                    </nav>
                    {dock === 'preview' ? (
                      <PreviewPane design={state.design} db={state.db} depictions={depictions} />
                    ) : (
                      <JsonPane design={state.design} />
                    )}
                  </div>
                </>
              )}
            </div>

            {readOnly ? null : (
            <>
            <Splitter
              axis="x"
              sign={-1}
              size={panes.sizes.side}
              label="drag to resize the inspector"
              onResize={(size) => panes.resize('side', size)}
              onReset={() => panes.reset('side')}
            />

            <div className={classes('cs-side', sideOpen && 'is-open')}>
              <nav className="cs-conn-tabs" role="tablist" aria-label="connection inspector">
                {sideTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={side === tab}
                    className={classes(side === tab && 'is-active')}
                    onClick={() => setSide(tab)}
                  >
                    {SIDE_TAB_LABELS[tab]}
                    {tab === 'issues' && state.issues.length > 0 ? (
                      <span className="cs-conn-tab-badge">{state.issues.length}</span>
                    ) : null}
                  </button>
                ))}
                {/* portrait phone widths only (50a.35) — `.cs-side-close` is
                    `display: none` outside that media query */}
                <button
                  type="button"
                  className="cs-side-close"
                  title="Close"
                  aria-label="Close inspector"
                  onClick={() => setSideOpen(false)}
                >
                  <IconX size={14} />
                </button>
              </nav>
              <fieldset className="cs-lock-fence" disabled={editLocked}>
              {side === 'connection' ? <ConnectionPanel state={state} nodes={nodes} /> : null}
              {side === 'part' ? <PartPanel state={state} /> : null}
              {side === 'nets' ? <NetsPanel state={state} /> : null}
              {side === 'issues' ? <IssuesPanel state={state} depictions={depictions} /> : null}
              {side === 'notes' ? <NotesPanel state={state} /> : null}
              </fieldset>
            </div>
            </>
            )}
          </div>
        )}

        {pendingDelete === undefined ? null : (
          <ConfirmDeleteDialog
            design={state.design}
            plan={pendingDelete}
            onCancel={() => setPendingDelete(undefined)}
            onConfirm={() => {
              dispatch({ type: 'delete-instances', ids: pendingDelete.ids });
              setPendingDelete(undefined);
            }}
          />
        )}

        {picker === undefined ? null : (
          <NodePicker
            design={state.design}
            db={state.db}
            onClose={closePicker}
            {...(picker.anchor === undefined ? {} : { anchor: picker.anchor })}
          />
        )}
      </div>
      </HoverContext.Provider>
    </EditorContext.Provider>
  );
});

export const CableEditor = forwardRef(function CableEditor(
  props: CableEditorProps,
  ref: Ref<EditorHandle>,
): JSX.Element {
  return (
    <ReactFlowProvider>
      <CableEditorInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
