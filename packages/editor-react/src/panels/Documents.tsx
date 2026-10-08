/**
 * The Documents view: build sheet, BOM and continuity spec for the design that
 * is open, printable, in the app.
 *
 * Three implementation choices worth defending:
 *
 * 1. **`<iframe srcdoc>`, not a mounted fragment.** Each document is a complete
 *    print-first HTML document with its own `@page` rule and stylesheet. An
 *    iframe keeps that intact and isolates styles in *both* directions — the
 *    editor's dark chrome cannot bleed onto white paper, and the sheet's own
 *    rules cannot restyle the editor. It is also what makes Print exact:
 *    printing the frame prints the document's own print CSS, so what the
 *    browser writes to PDF is the sheet, not a screenshot of the editor.
 *    `srcdoc` keeps it in-memory: no blob URL to revoke, no server round trip.
 * 2. **Debounced, and heavier than the schematic preview.** A build sheet is a
 *    BOM fold, a test-spec fold and two full layout passes; regenerating it per
 *    keystroke would make the editor feel slow. So it lags a little and says so
 *    ("updating…") rather than pretending it is live.
 * 3. **Lazy.** Only the sub-view being looked at is derived, and this component
 *    is only mounted once the user opens the tab — so first load pays nothing.
 */

import { knownPartNumbers, type CableDesign, type Db } from '@wirehub/model';
import { BASE_EXPORTS, PAPER_IDS, PAPERS, effectivePaper, paperSize, variationsOf, type DocumentFacts, type DrawingMeta, type FormatOptions, type PaperId, type TestParameters } from '@wirehub/docs';
import type { DepictionSource } from '@wirehub/render-svg';
import { IconDownload, IconMarkdown, IconPrinter, IconTools } from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type { AssetsAdapter } from '../assets.ts';
import { classes } from '../context.ts';
import { downloadOutput, type EditorExtensions, type ExtraExportContext, type ExtraExporter } from '../extensions.ts';
import {
  DOCUMENT_BLURBS,
  DOCUMENT_KINDS,
  DOCUMENT_LABELS,
  DRAWING_FIELD_LABELS,
  blockerSentence,
  copyText,
  describeConflictValue,
  documentBlockers,
  documentMarkdown,
  draftStatus,
  isEmptyDesign,
  isStaleWrite,
  renderExport,
  mergeDrawingMeta,
  mergeField,
  renderDocument,
  sheetRenderOptions,
  type DocumentKind,
  type DocumentResult,
  type DrawingAdapter,
  type DrawingConflict,
  type DrawingSidecar,
} from '../documents.ts';
import {
  defaultDocumentTarget,
  revisionTable,
  targetRevision,
  type DocumentRelease,
  type DocumentTarget,
} from '../release.ts';
import type { PartNumberData } from '../part-numbers.ts';
import { SegmentedControl } from '../ui/index.ts';
import { DrawingForm, drawingDate } from './DrawingForm.tsx';
import { SheetOptions } from './SheetOptions.tsx';
import { TestParametersRow } from './TestParametersRow.tsx';
import { JsonPane } from './JsonPane.tsx';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.ts';
import { useEditLocked } from './edit-session.ts';

/**
 * Longer than the preview's 250 ms on purpose: the documents are the heaviest
 * derivation in the editor and nobody reads a build sheet mid-keystroke.
 */
export const DOCUMENT_DEBOUNCE_MS = 600;

/** What a document action tells the host (a toast in the studio); without a host callback the pane says it inline. */
export interface DocumentReport {
  kind: 'success' | 'error';
  message: string;
  detail?: string;
}

export interface DocumentsProps {
  /** where saves, copies and exports report to: success, or an error with its detail */
  onReport?: (report: DocumentReport) => void;
  /** host-added panels and exports (`extensions.ts`) */
  extensions?: EditorExtensions;
  /** a read-only view (passed on to the panels) */
  readOnly?: boolean;
  /** The editor's guarded replacement callback; available only for the working draft. */
  onChange?: (design: CableDesign, description?: string) => void;
  /** the design as it stands in the editor — draft included */
  design: CableDesign;
  db: Db;
  /**
   * The design as the catalog holds it. Omitted means "never saved"; the pane
   * labels every document with which of the two it is showing.
   */
  saved?: CableDesign;
  /** `false` (default) abstract blocks · `true` the catalog tree (Node only) · a source */
  depictions?: boolean | DepictionSource;
  paper?: PaperId;
  debounceMs?: number;
  /**
   * The derivation, injectable. The pane calls this and nothing else, so a host
   * can wrap it (caching, a worker) and a test can watch it without a DOM.
   */
  render?: typeof renderDocument;
  /** where the drawing sheet's title-block details are kept; absent = preview only */
  drawings?: DrawingAdapter;
  /**
   * The shared asset library — given one, the
   * drawing photo field grows a "Choose from library…" button beside the
   * file input. Without one the field still uploads, exactly as before.
   */
  assets?: AssetsAdapter;
  /**
   * Saved revisions. Given one, the pane prints a
   * chosen target — by default the latest saved revision — with that
   * revision in the title block; the working copy prints with an UNRELEASED
   * mark. Without one, the pane prints the
   * design in the editor exactly as before.
   */
  release?: DocumentRelease;
  /**
   * The numbering scheme and the numbers in use: given them, the BOM flags
   * each unmapped part with the scheme's proposal.
   */
  partNumbers?: PartNumberData;
  /**
   * The host's short names for the title block — destination, sync, stock —
   * as its cable list shows them. Absent: derived.
   */
  facts?: (design: CableDesign, db: Db) => DocumentFacts;
  /** the organisation's default test parameters (under the design's own) */
  testDefaults?: TestParameters;
}

const EMPTY_SIDECAR: DrawingSidecar = { meta: {} };

function sameSidecar(a: DrawingSidecar, b: DrawingSidecar): boolean {
  return a.photo === b.photo && JSON.stringify(a.meta) === JSON.stringify(b.meta);
}

/**
 * The drawing sidecar for the open design: loaded once per design, edited as a
 * draft, saved on request. Kept in the pane — not in the editor store —
 * because none of it is part of the cable.
 */
function useDrawingSidecar(designId: string, adapter: DrawingAdapter | undefined, report?: (report: DocumentReport) => void) {
  const [draft, setDraft] = useState<DrawingSidecar>(EMPTY_SIDECAR);
  const [saved, setSaved] = useState<DrawingSidecar>(EMPTY_SIDECAR);
  const [status, setStatus] = useState<string>();
  // the organisation's test-parameter defaults, as the server's last answer carried them
  const [orgDefaults, setOrgDefaults] = useState<TestParameters>();
  // a failure worth a banner, not the small print — a load or save that did
  // not go through at all (unreachable, refused, not a stale write, or a
  // stale write whose re-fetch itself failed)
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // set when a save came back stale and could not be
  // merged away entirely on its own — a field, or the photo, changed both
  // here and on the server, to different values
  const [conflict, setConflict] = useState<DrawingConflict>();
  // bumps when a sidecar arrives, so the form re-reads its text boxes
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setDraft(EMPTY_SIDECAR);
    setSaved(EMPTY_SIDECAR);
    setStatus(undefined);
    setError(undefined);
    setConflict(undefined);
    if (adapter === undefined) return;
    let live = true;
    void adapter.load(designId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setDraft(result.value);
        setSaved(result.value);
        setOrgDefaults(result.value.testDefaults);
        setGeneration((g) => g + 1);
      } else {
        setError(`${result.message}${result.hint === undefined ? '' : ` ${result.hint}`}`);
      }
    });
    return () => {
      live = false;
    };
  }, [designId, adapter]);

  /**
   * Save, recovering from a stale write instead of just reporting it:
   * another action can rewrite this record behind
   * this form's back — most commonly a version save bumping the drawing's
   * `revision` — and the 409 that answers is not "someone edited the same
   * thing", it is "something else touched a field you never opened this
   * form to change". So a save that comes back stale re-fetches, merges
   * field-by-field (a field this form never touched silently takes the
   * server's value; one only this form touched keeps its edit), and retries
   * once — silently, when nothing conflicts. Only a field genuinely changed
   * on both sides, to different values, stops here for a person to pick.
   */
  const save = useCallback(async () => {
    if (adapter === undefined) return;
    setSaving(true);
    setError(undefined);
    setConflict(undefined);
    const base = saved;
    const mine = draft;
    let metaOutcome = await adapter.save(designId, mine.meta);
    // the server truth this save actually lands against — `base` unless a
    // stale-write forced a re-fetch, in which case it is what that found
    let effectiveBase = base;

    if (!metaOutcome.ok && isStaleWrite(metaOutcome)) {
      const fresh = await adapter.load(designId);
      if (!fresh.ok) {
        setSaving(false);
        setError(`${metaOutcome.message} The latest copy could not be fetched either: ${fresh.message}`);
        return;
      }
      const { merged, conflicts } = mergeDrawingMeta(base.meta, mine.meta, fresh.value.meta);
      const photoMerge = mergeField(base.photo, mine.photo, fresh.value.photo);
      effectiveBase = fresh.value;
      if (conflicts.length > 0 || photoMerge.conflict) {
        // keep the draft exactly as typed (nothing is thrown away) but move
        // the baseline forward, so the fields that *did* merge cleanly do
        // not ask again on the next attempt — only the listed ones remain
        setSaved(fresh.value);
        setConflict({
          fields: conflicts,
          ...(photoMerge.conflict ? { photo: { mine: mine.photo, theirs: fresh.value.photo } } : {}),
        });
        setSaving(false);
        return;
      }
      metaOutcome = await adapter.save(designId, merged);
    }

    if (!metaOutcome.ok) {
      setSaving(false);
      setError(`${metaOutcome.message}${metaOutcome.hint === undefined ? '' : ` ${metaOutcome.hint}`}`);
      return;
    }
    const photoWanted = mergeField(base.photo, mine.photo, effectiveBase.photo).value;
    let photo = effectiveBase.photo;
    if (photoWanted !== effectiveBase.photo) {
      const stored = await adapter.savePhoto(designId, photoWanted ?? null);
      if (!stored.ok) {
        setSaving(false);
        setError(`The details were saved but the photo was not: ${stored.message}`);
        setSaved({ meta: metaOutcome.value, ...(photo === undefined ? {} : { photo }) });
        return;
      }
      photo = stored.value.photo;
    }
    const next: DrawingSidecar = { meta: metaOutcome.value, ...(photo === undefined ? {} : { photo }) };
    setSaved(next);
    setDraft(next);
    setConflict(undefined);
    setSaving(false);
    const said = effectiveBase === base
      ? 'Saved beside the design.'
      : 'Saved — merged with a change made on disk (a version save, most likely) first.';
    if (report === undefined) setStatus(said);
    else report({ kind: 'success', message: 'Drawing details saved.', ...(effectiveBase === base ? {} : { detail: 'Merged with a change made on disk (a version save, most likely) first.' }) });
  }, [adapter, designId, draft, saved, report]);

  /** "Use the server's value" for one conflicting field — Save then applies it. */
  const resolveField = useCallback(
    (field: keyof DrawingMeta) => {
      const found = conflict?.fields.find((f) => f.field === field);
      if (conflict === undefined || found === undefined) return;
      setDraft((d) => {
        const meta = { ...d.meta };
        if (found.theirs === undefined) delete meta[field];
        else (meta as Record<string, unknown>)[field] = found.theirs;
        return { ...d, meta };
      });
      const fields = conflict.fields.filter((f) => f.field !== field);
      setConflict(fields.length === 0 && conflict.photo === undefined ? undefined : { ...conflict, fields });
    },
    [conflict],
  );

  /** "Use the server's photo" for a conflicting photo. */
  const resolvePhoto = useCallback(() => {
    if (conflict?.photo === undefined) return;
    const theirs = conflict.photo.theirs;
    setDraft((d) => (theirs === undefined ? { meta: d.meta } : { ...d, photo: theirs }));
    const { photo: _photo, ...rest } = conflict;
    setConflict(rest.fields.length === 0 ? undefined : rest);
  }, [conflict]);

  useUnsavedChangesGuard(!sameSidecar(draft, saved));
  return {
    draft,
    dirty: !sameSidecar(draft, saved),
    status,
    error,
    saving,
    conflict,
    resolveField,
    resolvePhoto,
    generation,
    orgDefaults,
    setMeta: (meta: DrawingMeta) => setDraft((d) => ({ ...d, meta })),
    setPhoto: (photo: string | undefined) =>
      setDraft((d) => (photo === undefined ? { meta: d.meta } : { ...d, photo })),
    save,
  };
}

/** The paper width is content width; native scrollbars and borders sit outside it. */
function frameAllowance(frame: HTMLIFrameElement): number {
  const page = frame.contentDocument?.documentElement;
  const view = frame.contentWindow;
  // Hidden/unmeasured frames (including jsdom) have no meaningful gutter.
  if (page === undefined || view === null || frame.clientWidth <= 0 || page.clientWidth <= 0) return 0;
  return Math.ceil(Math.max(0, frame.offsetWidth - frame.clientWidth))
    + Math.ceil(Math.max(0, view.innerWidth - page.clientWidth));
}

/**
 * Hand the print job to the frame's own window, so the browser prints the
 * document's print CSS — the whole reason these render in an iframe. Returns
 * whether the dialog could be asked for, so the UI can say so instead of
 * silently doing nothing.
 */
export function printDocumentFrame(frame: HTMLIFrameElement | null): boolean {
  const view = frame?.contentWindow;
  if (view === null || view === undefined || typeof view.print !== 'function') return false;
  view.focus();
  view.print();
  return true;
}

/** Where a reader was in one document — by design and document kind. */
export type FramePlaces = Map<string, { x: number; y: number }>;

/**
 * Keep the reader's place across a regeneration. Each
 * regeneration replaces the frame's `srcdoc`, which reloads it at the top;
 * call this from the frame's `load`: it scrolls the fresh document back to
 * where the reader was in this document, and records where they go next.
 */
export function keepFramePlace(
  view: Pick<Window, 'scrollTo' | 'scrollX' | 'scrollY' | 'addEventListener'> | null | undefined,
  places: FramePlaces,
  key: string,
): void {
  if (view === null || view === undefined) return;
  const saved = places.get(key);
  if (saved !== undefined) view.scrollTo(saved.x, saved.y);
  view.addEventListener('scroll', () => places.set(key, { x: view.scrollX, y: view.scrollY }), { passive: true });
}

export function DocumentsPane({
  design,
  db,
  saved,
  depictions = false,
  paper,
  debounceMs = DOCUMENT_DEBOUNCE_MS,
  render = renderDocument,
  drawings,
  assets,
  release,
  partNumbers,
  facts,
  testDefaults: testDefaultsProp,
  extensions,
  readOnly = false,
  onChange,
  onReport,
}: DocumentsProps): JSX.Element {
  const sidecar = useDrawingSidecar(design.id, drawings, onReport);
  const testDefaults = testDefaultsProp ?? sidecar.orgDefaults;
  // someone else holds this cable's edit lock: the forms stay, disabled
  const editLocked = useEditLocked();
  // which revision prints: the viewed rev, else the latest saved one
  const releaseKey = release === undefined ? '' : `${design.id}|${release.revisions.join(',')}|${release.showing.kind === 'rev' ? release.showing.rev : 'w'}`;
  const [target, setTarget] = useState<DocumentTarget>(() => defaultDocumentTarget(release));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the release's content
  useEffect(() => setTarget(defaultDocumentTarget(release)), [releaseKey]);
  const [loadedRev, setLoadedRev] = useState<{ rev: number; design: CableDesign; db: Db; depictions?: DepictionSource } | 'missing'>();
  const ownRev = release?.showing.kind === 'rev' ? release.showing.rev : undefined;
  useEffect(() => {
    setLoadedRev(undefined);
    if (release === undefined || target === 'working' || target === ownRev) return;
    let live = true;
    void release.load(target).then((found) => {
      if (live) setLoadedRev(found === undefined ? 'missing' : { rev: target, ...found });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the release's content
  }, [releaseKey, target]);
  const external = release !== undefined && target !== 'working' && target !== ownRev;
  const pending = external && (loadedRev === undefined || loadedRev === 'missing' || loadedRev.rev !== target);
  const shown = external && !pending && typeof loadedRev === 'object' ? loadedRev : undefined;
  const docDesign = shown?.design ?? design;
  const moduleEditable = !readOnly && !editLocked && (release === undefined || target === 'working') && onChange !== undefined;
  const moduleEditRef = useRef({ target, editable: moduleEditable, generation: 0, mounted: true });
  if (moduleEditRef.current.target !== target || moduleEditRef.current.editable !== moduleEditable) {
    moduleEditRef.current = { ...moduleEditRef.current, target, editable: moduleEditable, generation: moduleEditRef.current.generation + 1 };
  }
  useEffect(() => {
    moduleEditRef.current.mounted = true;
    return () => { moduleEditRef.current.mounted = false; };
  }, []);
  const moduleGeneration = moduleEditRef.current.generation;
  const moduleOnChange = (next: CableDesign, description?: string): void => {
    if (!moduleEditRef.current.mounted || !moduleEditRef.current.editable || moduleEditRef.current.generation !== moduleGeneration) return;
    onChange?.(next, description);
  };
  const docDb = shown?.db ?? db;
  // another saved revision prints with the artwork it was saved with
  const docDepictions = depictions !== false && shown?.depictions !== undefined ? shown.depictions : depictions;
  const unreleased = release !== undefined && target === 'working';
  const revisionFixed = release === undefined ? undefined : targetRevision(target);
  // `'json'` is a sub-view, not a `DocumentKind`: it does not go through
  // `@wirehub/docs`'s `renderDocument` at all — it is `JsonPane`, the
  // editor's own design-document export/import, kept reachable from here
  // rather than a bottom dock chrome="host" no longer draws ().
  const [kind, setKind] = useState<DocumentKind | 'json'>('build-sheet');
  const [boardScale, setBoardScale] = useState(1);
  // the drawing, the build sheet and the BOM read the sidecar (part number,
  // lengths, designer); the continuity spec does not, so its edits never re-render it
  const readsSidecar = kind === 'drawing' || kind === 'build-sheet' || kind === 'bom' || kind === 'formboard';
  const drawingInput = useMemo(
    () =>
      !readsSidecar
        ? undefined
        : revisionFixed === undefined
          ? sidecar.draft
          : { ...sidecar.draft, meta: { ...sidecar.draft.meta, revision: revisionFixed } },
    [readsSidecar, sidecar.draft, revisionFixed],
  );
  // a length family prints for all its variations, or for the one chosen here
  const { family, variations } = variationsOf(sidecar.draft.meta.partNumber ?? docDesign.productRef, sidecar.draft.meta.lengths);
  const [variation, setVariation] = useState<string>('');
  // the BOM's cost roll-up reads its quantity breaks at this many cables
  const [buildQtyText, setBuildQtyText] = useState('1');
  const buildQty = /^\d{1,5}$/.test(buildQtyText.trim()) && Number(buildQtyText) >= 1 ? Number(buildQtyText) : undefined;
  useEffect(() => setVariation(''), [design.id]);
  const chosenVariation = family !== undefined && variations.some((v) => v.suffix === variation) ? variation : undefined;
  const pnInputs = useMemo(
    () =>
      partNumbers === undefined
        ? undefined
        : {
            scheme: partNumbers.scheme,
            known: knownPartNumbers(docDb, partNumbers.designs ?? [], [
              ...Object.entries(partNumbers.drawings ?? {})
                .filter(([, meta]) => meta.partNumber !== undefined)
                .map(([id, meta]) => ({ pn: meta.partNumber as string, kind: 'design' as const, source: `drawings/${id}` })),
              ...(partNumbers.extra ?? []),
            ]),
          },
    [partNumbers, docDb],
  );
  const docFacts = useMemo(() => (facts === undefined ? undefined : facts(docDesign, docDb)), [facts, docDesign, docDb]);
  // the printed sheets' options — only the three sheets read them, and
  // only the fields that shape them re-render a document
  const sheetKind = kind === 'build-sheet' || kind === 'bom' || kind === 'test-spec';
  const { partNumber } = sidecar.draft.meta;
  const revision = revisionFixed ?? sidecar.draft.meta.revision;
  // a saved revision's number is the document's revision; the working copy is marked UNRELEASED
  const sheet =
    revisionFixed === undefined
      ? sidecar.draft.meta.sheet
      : (() => {
          const { revision: _own, ...rest } = sidecar.draft.meta.sheet ?? {};
          return { ...rest, status: unreleased ? 'UNRELEASED' : (rest.status ?? 'RELEASED') };
        })();
  const sheetKey = sheetKind ? JSON.stringify([sheet, partNumber, revision]) : '';
  const sheetInput = useMemo(
    () => (sheetKind ? sheetRenderOptions({ ...(sheet === undefined ? {} : { sheet }), ...(partNumber === undefined ? {} : { partNumber }), ...(revision === undefined ? {} : { revision }) }, docDesign, () => drawingDate(new Date())) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the sheet fields' content, not the draft's identity
    [sheetKey, docDesign.productRef],
  );
  // The preview is the sheet itself: the iframe is exactly one paper wide (the page the renderer
  // prints on, in CSS pixels) and as tall as the document, scaled as a whole by the zoom. The
  // drawing and the formboard are landscape, the other sheets portrait.
  const previewPaper: PaperId = effectivePaper(sheetInput.paper ?? sidecar.draft.meta.sheet?.paper ?? paper);
  const landscape = kind === 'drawing' || kind === 'formboard';
  const paperPx = useMemo(() => {
    const size = paperSize(previewPaper, landscape ? 'landscape' : 'portrait');
    return { width: Math.round((size.width * 96) / 25.4), height: Math.round((size.height * 96) / 25.4) };
  }, [previewPaper, landscape]);
  // the state every sheet carries in its title block and corner stamp: the working copy is UNRELEASED,
  // a saved revision RELEASED unless the sheet says otherwise
  const stateText = unreleased ? 'UNRELEASED' : revisionFixed !== undefined ? (sidecar.draft.meta.sheet?.status ?? 'RELEASED') : sidecar.draft.meta.sheet?.status;
  const revisions = useMemo(() => revisionTable(release, target), [release, target]);
  // tagged with the document it *is*, so switching sub-views never shows the
  // previous document under the new one's heading while the new one builds
  const [rendered, setRendered] = useState<{ kind: DocumentKind; result: DocumentResult }>();
  const [updating, setUpdating] = useState(true);
  const [printFailed, setPrintFailed] = useState(false);
  const [copyNote, setCopyNote] = useState<string>();
  /** tell the host (a toast) or, without one, the inline note beside the toolbar */
  const say = useCallback(
    (kind: 'success' | 'error', message: string, detail?: string): void => {
      if (onReport === undefined) setCopyNote(kind === 'success' && message === '' ? undefined : message);
      else if (message !== '') onReport({ kind, message, ...(detail === undefined ? {} : { detail }) });
    },
    [onReport],
  );
  const frame = useRef<HTMLIFrameElement | null>(null);
  const places = useRef<FramePlaces>(new Map());
  const body = useRef<HTMLDivElement | null>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | '100'>('fit');
  const [available, setAvailable] = useState(0);
  const [sheetHeight, setSheetHeight] = useState(0);
  const frameObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => () => {
    frameObserver.current?.disconnect();
    frameObserver.current = null;
  }, [design.id, kind]);
  // the room the sheet has: the preview region's width, less its padding
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    const measure = (): void => setAvailable(Math.max(0, element.clientWidth - 20));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [design.id, kind, rendered?.kind === kind]);
  /** the sheet fits the width up to 1.5x (a paper wider than that on a big screen stays a sheet, not a banner); 100% is CSS pixels */
  const zoom = zoomMode === '100' || available === 0 ? 1 : Math.min(1.5, Math.max(0.3, available / paperPx.width));
  const loadedFrame = (element: HTMLIFrameElement): void => {
    if (frame.current !== element) return;
    frameObserver.current?.disconnect();
    const measure = (): void => {
      if (frame.current !== element) return;
      const page = element.contentDocument?.documentElement;
      if (page !== undefined) setSheetHeight(Math.max(page.scrollHeight, paperPx.height));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      frameObserver.current = observer;
      const page = element.contentDocument?.documentElement;
      if (page !== undefined) observer.observe(page);
    }
    // a regeneration reloads the frame: the reader stays where they were in this document
    const place = places.current.get(`${design.id}|${kind}`);
    if (place !== undefined && body.current !== null) body.current.scrollTo(place.x, place.y);
  };

  const empty = isEmptyDesign(docDesign);
  const status = useMemo(
    () =>
      release === undefined || target === 'working'
        ? draftStatus(design, saved)
        : {
            state: 'saved' as const,
            label: `Rev ${target}`,
            detail: `Saved revision ${target}, drawn from the definitions frozen when it was saved.`,
          },
    [design, saved, release, target],
  );
  const blockers = useMemo(() => documentBlockers(docDesign, docDb), [docDesign, docDb]);

  useEffect(() => {
    if (kind === 'json') {
      setUpdating(false);
      return;
    }
    if (empty || pending) {
      setRendered(undefined);
      setUpdating(pending);
      return;
    }
    setUpdating(true);
    const timer = setTimeout(() => {
      const result = render(kind, docDesign, docDb, {
          depictions: docDepictions,
          paper: previewPaper,
          ...sheetInput,
          ...(sheetKind || stateText === undefined ? {} : { document: { status: stateText } }),
          ...(kind === 'drawing' && revisions !== undefined ? { revisions } : {}),
          ...(drawingInput === undefined ? {} : { drawing: drawingInput }),
          ...(pnInputs === undefined ? {} : { partNumbers: pnInputs }),
          ...(docFacts === undefined ? {} : { facts: docFacts }),
          ...(chosenVariation === undefined ? {} : { variation: chosenVariation }),
          ...(kind === 'formboard' ? { scale: boardScale } : {}),
          ...(kind === 'bom' && buildQty !== undefined && buildQty > 1 ? { buildQty } : {}),
          ...(typeof target === 'number' ? { revisionNumber: target } : {}),
          ...(kind === 'test-spec' && sidecar.draft.meta.test !== undefined ? { testParameters: sidecar.draft.meta.test } : {}),
          ...((kind === 'test-spec' || kind === 'build-sheet') && testDefaults !== undefined ? { testDefaults } : {}),
        });
      setRendered({ kind, result });
      setUpdating(false);
    }, debounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target only matters as the revision number
  }, [kind, docDesign, docDb, docDepictions, previewPaper, stateText, revisions, debounceMs, render, empty, pending, unreleased, drawingInput, sheetInput, pnInputs, docFacts, chosenVariation, boardScale, buildQty, typeof target === 'number' ? target : -1, kind === 'test-spec' ? sidecar.draft.meta.test : undefined, testDefaults]);

  const result = rendered?.kind === kind ? rendered.result : undefined;
  const html = result !== undefined && 'html' in result ? result.html : undefined;
  const markdownKind = kind === 'bom' || kind === 'test-spec';
  useEffect(() => setCopyNote(undefined), [kind, design.id]);
  const copyMarkdown = useCallback(async (): Promise<void> => {
    if (kind !== 'bom' && kind !== 'test-spec') return;
    const markdown = documentMarkdown(kind, docDesign, docDb, {
      ...sheetInput,
      ...(drawingInput === undefined ? {} : { drawing: drawingInput }),
      ...(pnInputs === undefined ? {} : { partNumbers: pnInputs }),
      ...(docFacts === undefined ? {} : { facts: docFacts }),
      ...(chosenVariation === undefined ? {} : { variation: chosenVariation }),
      ...(buildQty !== undefined && buildQty > 1 ? { buildQty } : {}),
      ...(docDepictions === false ? {} : { depictions: docDepictions }),
    });
    if (markdown === undefined) {
      say('error', 'this document could not be built');
      return;
    }
    if (await copyText(markdown)) say('success', onReport === undefined ? 'copied' : `${kind === 'bom' ? 'BOM' : 'Continuity spec'} copied as markdown.`);
    else say('error', 'the browser refused the copy');
  }, [say, onReport, kind, docDesign, docDb, sheetInput, drawingInput, pnInputs, docFacts, chosenVariation, buildQty, docDepictions]);
  const runExporter = useCallback(
    async (exporter: ExtraExporter): Promise<void> => {
      try {
        const context: ExtraExportContext = {
          ...(sidecar.draft.meta.test === undefined ? {} : { testParameters: sidecar.draft.meta.test }),
          ...(testDefaults === undefined ? {} : { testDefaults }),
        };
        // an exporter that wants no test parameters is called as it always was
        const output = await (Object.keys(context).length === 0 ? exporter.render(docDesign, docDb) : exporter.render(docDesign, docDb, context));
        downloadOutput(output);
        say('success', onReport === undefined ? '' : `${exporter.label} downloaded.`, output.fileName);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (onReport === undefined) setCopyNote(`${exporter.label}: ${reason}`);
        else onReport({ kind: 'error', message: `${exporter.label} failed.`, detail: reason });
      }
    },
    [say, onReport, docDesign, docDb, sidecar.draft.meta.test, testDefaults],
  );
  const downloadExport = useCallback(
    (id: string): void => {
      if (id === '') return;
      const meta = sidecar.draft.meta;
      const options: FormatOptions = {
        ...sheetRenderOptions(
          { ...(meta.sheet === undefined ? {} : { sheet: meta.sheet }), ...(meta.partNumber === undefined ? {} : { partNumber: meta.partNumber }), ...(revisionFixed ?? meta.revision) === undefined ? {} : { revision: (revisionFixed ?? meta.revision) as string } },
          docDesign,
          () => drawingDate(new Date()),
        ),
        drawing: meta,
        ...(pnInputs === undefined ? {} : { partNumbers: pnInputs }),
        ...(docFacts === undefined ? {} : { facts: docFacts }),
        ...(chosenVariation === undefined ? {} : { variation: chosenVariation }),
        ...(buildQty !== undefined && buildQty > 1 ? { buildQty } : {}),
        ...(typeof target === 'number' ? { revisionNumber: target } : {}),
        ...(meta.test === undefined ? {} : { testParameters: meta.test }),
        ...(testDefaults === undefined ? {} : { testDefaults }),
      };
      const made = renderExport(id, docDesign, docDb, options);
      if ('error' in made) say('error', made.error);
      else {
        downloadOutput(made.output);
        say('success', onReport === undefined ? '' : 'Export downloaded.', made.output.fileName);
      }
    },
    [say, onReport, sidecar.draft.meta, docDesign, docDb, pnInputs, docFacts, chosenVariation, buildQty, target, revisionFixed, testDefaults],
  );
  const tabLabel = kind === 'json' ? 'JSON' : DOCUMENT_LABELS[kind];

  return (
    <div className="cs-panel cs-documents">
      <h2>
        documents
        <span
          className={classes('cs-chip', status.state !== 'saved' && 'is-draft')}
          title={status.detail}
        >
          {status.label}
        </span>
        {updating ? <span className="cs-count cs-updating">updating…</span> : null}
      </h2>

      <nav className="cs-tabs cs-doc-tabs">
        {DOCUMENT_KINDS.map((each) => (
          <button
            key={each}
            type="button"
            className={classes(kind === each && 'is-active')}
            title={DOCUMENT_BLURBS[each]}
            onClick={() => setKind(each)}
          >
            {DOCUMENT_LABELS[each]}
          </button>
        ))}
        <button
          type="button"
          className={classes(kind === 'json' && 'is-active')}
          title="Advanced: the design document itself — export or import it here."
          onClick={() => setKind('json')}
        >
          JSON
        </button>
        <span className="cs-spacer" />
        {kind !== 'formboard' ? null : (
          <select
            className="cs-input cs-doc-variation"
            aria-label="Formboard scale"
            title="Print scale of the formboard pages: 1:1 is true length on the board; the overview sheet is always fitted to one page"
            value={String(boardScale)}
            onChange={(event) => setBoardScale(Number(event.target.value))}
          >
            {[1, 0.5, 0.25, 0.2, 0.1].map((value) => (
              <option key={value} value={String(value)}>
                {value === 1 ? '1:1' : `1:${Math.round(1 / value)}`}
              </option>
            ))}
          </select>
        )}
        {family === undefined || variations.length === 0 || (kind !== 'build-sheet' && kind !== 'bom' && kind !== 'formboard') ? null : (
          <select
            className="cs-input cs-doc-variation"
            aria-label="Variation to print"
            title={`${family}: print every variation, or one`}
            value={chosenVariation ?? ''}
            onChange={(event) => setVariation(event.target.value)}
          >
            <option value="">All variations</option>
            {variations.map((v) => (
              <option key={v.suffix} value={v.suffix}>
                {v.pn} · {v.feet}
              </option>
            ))}
          </select>
        )}
        {kind !== 'bom' ? null : (
          <input
            className="cs-input cs-mono"
            style={{ width: '5.5em' }}
            inputMode="numeric"
            aria-label="Build quantity"
            title="Cables in the build: quantity breaks in the cost are read at this many (the cost shows only where parts are priced)"
            value={buildQtyText}
            onChange={(event) => setBuildQtyText(event.target.value)}
          />
        )}
        {release === undefined ? null : (
          <select
            className={classes('cs-input cs-doc-target', unreleased && 'is-unreleased')}
            aria-label="Revision to print"
            title={
              unreleased
                ? 'The working copy — prints marked UNRELEASED and cannot be exported. Save a version to release it.'
                : 'Which saved revision these documents show'
            }
            value={String(target)}
            onChange={(event) => setTarget(event.target.value === 'working' ? 'working' : Number(event.target.value))}
          >
            {[...release.revisions].reverse().map((rev) => (
              <option key={rev} value={String(rev)}>
                Rev {rev}
                {rev === release.revisions[release.revisions.length - 1] ? ' · latest' : ''}
              </option>
            ))}
            {release.showing.kind === 'working' ? <option value="working">Working · unreleased</option> : null}
          </select>
        )}
        {copyNote === undefined ? null : (
          <span className="cs-count" role="status">
            {copyNote}
          </span>
        )}
        {markdownKind ? (
          <button
            type="button"
            className="cs-print"
            disabled={empty}
            title={`Copy the ${kind === 'bom' ? 'BOM' : 'continuity spec'} as markdown — for a work order or a purchase note`}
            onClick={() => void copyMarkdown()}
          >
            <IconMarkdown size={14} aria-hidden /> Copy
          </button>
        ) : null}
        <select
          className="cs-input cs-doc-export"
          aria-label="Export"
          title="Download the BOM, wire list, cut list, continuity data or wire labels as a file"
          disabled={empty || pending}
          value=""
          onChange={(event) => {
            downloadExport(event.target.value);
            event.target.value = '';
          }}
        >
          <option value="">Export…</option>
          {(['production', 'tester', 'labels'] as const).map((group) => (
            <optgroup key={group} label={{ production: 'Production', tester: 'Continuity tester', labels: 'Labels' }[group]}>
              {BASE_EXPORTS.filter((format) => format.group === group).map((format) => (
                <option key={format.id} value={format.id} title={format.description}>
                  {format.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {(extensions?.exporters ?? []).length + (extensions?.toolLinks ?? []).length === 0 ? null : (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button type="button" className="cs-print" disabled={empty || pending} data-testid="documents-tools" title="Exports and actions added by installed modules">
                <IconTools size={14} aria-hidden /> Tools
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="cs-doc-tools" sideOffset={3} align="end">
                <ul role="menu" aria-label="Module tools">
                  {(extensions?.exporters ?? []).map((exporter) => (
                    <li key={exporter.id} role="none">
                      <Popover.Close asChild>
                        <button
                          type="button"
                          role="menuitem"
                          className="cs-doc-tool"
                          data-exporter={exporter.id}
                          title={exporter.description ?? `Download ${exporter.label}`}
                          onClick={() => void runExporter(exporter)}
                        >
                          <IconDownload size={13} aria-hidden /> {exporter.label}
                        </button>
                      </Popover.Close>
                    </li>
                  ))}
                  {(extensions?.toolLinks ?? []).map((link) => (
                    <li key={link.id} role="none">
                      <Popover.Close asChild>
                        <button type="button" role="menuitem" className="cs-doc-tool" data-tool-link={link.id} onClick={() => link.open()}>
                          {link.label} →
                        </button>
                      </Popover.Close>
                    </li>
                  ))}
                </ul>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
        {html === undefined ? null : (
          <SegmentedControl
            aria-label="Zoom"
            size="sm"
            value={zoomMode}
            onValueChange={(next) => setZoomMode(next === '100' ? '100' : 'fit')}
            options={[
              { value: 'fit', label: 'Fit', 'aria-label': 'Fit the sheet to the width of the window' },
              { value: '100', label: '100%', 'aria-label': 'Show the sheet at 100 %' },
            ]}
          />
        )}
        <button
          type="button"
          className="cs-print"
          disabled={html === undefined}
          title={
            html === undefined
              ? 'nothing to print yet'
              : `Print the ${tabLabel.toLowerCase()} — choose “Save as PDF” for a file`
          }
          onClick={() => setPrintFailed(!printDocumentFrame(frame.current))}
        >
          <IconPrinter size={14} aria-hidden /> Print
        </button>
      </nav>

      {!empty && sidecar.conflict === undefined && sidecar.error !== undefined ? (
        <div className="cs-drawing-conflict" role="alert">
          <strong>{sidecar.error}</strong>
          <button type="button" onClick={() => void sidecar.save()} disabled={sidecar.saving}>
            {sidecar.saving ? 'saving…' : 'Retry save'}
          </button>
        </div>
      ) : null}

      {!empty && sidecar.conflict !== undefined ? (
        <div className="cs-drawing-conflict" role="alert">
          <strong>
            This drawing changed on disk — most likely a version save — since it was opened here. Nothing was
            written.
          </strong>
          <ul className="cs-list">
            {sidecar.conflict.fields.map((field) => (
              <li key={field.field}>
                <span className="cs-conflict-name">{DRAWING_FIELD_LABELS[field.field]}</span>: yours “
                {describeConflictValue(field.mine)}” — on disk “{describeConflictValue(field.theirs)}”{' '}
                <button type="button" onClick={() => sidecar.resolveField(field.field)}>
                  use the disk value
                </button>
              </li>
            ))}
            {sidecar.conflict.photo === undefined ? null : (
              <li>
                <span className="cs-conflict-name">Product photo</span>: the photo here differs from the one now
                stored.{' '}
                <button type="button" onClick={sidecar.resolvePhoto}>
                  use the stored photo
                </button>
              </li>
            )}
          </ul>
          <button type="button" onClick={() => void sidecar.save()} disabled={sidecar.saving}>
            {sidecar.saving ? 'saving…' : 'Retry save'}
          </button>
        </div>
      ) : null}

      {sheetKind && !empty ? (
        <fieldset className="cs-lock-fence" disabled={editLocked}>
        <SheetOptions
          key={`${design.id}:${sidecar.generation}`}
          design={docDesign}
          meta={sidecar.draft.meta}
          onMeta={sidecar.setMeta}
          defaultPaper={effectivePaper(paper)}
          {...(revisionFixed === undefined ? {} : { revisionFixed })}
          {...(drawings === undefined ? {} : { onSave: () => void sidecar.save() })}
          {...(sidecar.status === undefined ? {} : { status: sidecar.status })}
          dirty={sidecar.dirty}
          saving={sidecar.saving}
        />
        {kind === 'test-spec' ? <TestParametersRow meta={sidecar.draft.meta} onMeta={sidecar.setMeta} {...(testDefaults === undefined ? {} : { defaults: testDefaults })} /> : null}
        </fieldset>
      ) : null}

      {/* no narrative paragraph — the status chip's
          tooltip says whether this is the saved design or a draft */}
      {blockers.length === 0 ? null : (
        <div className="cs-doc-warning" role="alert">
          <strong>{blockerSentence(blockers)}</strong>
          <ul className="cs-list">
            {blockers.map((issue, index) => (
              <li key={`${issue.code}:${issue.where ?? ''}:${index}`}>
                {issue.message}
                {issue.where === undefined ? '' : ` (${issue.where})`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {kind === 'drawing' && !empty ? (
        <fieldset className="cs-lock-fence" disabled={editLocked}>
        <DrawingForm
          key={`${design.id}:${sidecar.generation}`}
          design={docDesign}
          db={docDb}
          {...(revisionFixed === undefined ? {} : { revisionFixed })}
          meta={sidecar.draft.meta}
          photo={sidecar.draft.photo}
          onMeta={sidecar.setMeta}
          onPhoto={sidecar.setPhoto}
          {...(assets === undefined ? {} : { assets })}
          {...(drawings === undefined ? {} : { onSave: () => void sidecar.save() })}
          {...(sidecar.status === undefined ? {} : { status: sidecar.status })}
          dirty={sidecar.dirty}
          saving={sidecar.saving}
        />
        </fieldset>
      ) : null}

      {printFailed ? (
        <p className="cs-error">
          this browser would not open a print dialog — use the browser’s own File → Print
        </p>
      ) : null}

      <div
        key={`${design.id}|${kind}`}
        ref={body}
        className="cs-doc-body"
        role="region"
        aria-label="Document preview"
        tabIndex={html === undefined ? undefined : 0}
        onScroll={(event) => places.current.set(`${design.id}|${kind}`, { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })}
      >
        {kind === 'json' ? (
          <JsonPane design={docDesign} />
        ) : pending ? (
          <p className="cs-empty">{loadedRev === 'missing' ? `Rev ${String(target)} could not be loaded.` : `loading Rev ${String(target)}…`}</p>
        ) : empty ? (
          <p className="cs-empty">
            Nothing to document yet. Drag a connector, a wire or a board onto the canvas and the
            build sheet, BOM and continuity spec appear here.
          </p>
        ) : result === undefined ? (
          <p className="cs-empty">building the {tabLabel.toLowerCase()}…</p>
        ) : 'error' in result ? (
          <div className="cs-doc-failed">
            <p className="cs-error">this document could not be built — {result.error}</p>
            <p className="cs-empty">
              The other two documents may still work. If this keeps happening, the design is asking
              for something the definition library does not have.
            </p>
          </div>
        ) : (
          // the document is generated by @wirehub/docs: deterministic,
          // script-free and self-contained by that package's own tests. The
          // sandbox keeps it that way — same-origin so Print can reach the
          // frame's window, modals so the print dialog may open, and no
          // allow-scripts at all. The frame is one paper wide and the height of the document,
          // scaled as a whole: the sheet keeps its proportion at any window width.
          <div
            className="cs-doc-paper"
            data-zoom={zoomMode}
            style={{ width: `${Math.round(paperPx.width * zoom)}px`, height: `${Math.round((sheetHeight || paperPx.height) * zoom)}px` }}
          >
            <iframe
              ref={frame}
              className="cs-doc-frame"
              style={{ width: `${paperPx.width}px`, height: `${sheetHeight || paperPx.height}px`, transform: `scale(${zoom})` }}
              title={`${tabLabel} — ${docDesign.label}`}
              sandbox="allow-same-origin allow-modals"
              srcDoc={html}
              onLoad={(event) => loadedFrame(event.currentTarget)}
            />
          </div>
        )}
      </div>

      {extensions?.documents === undefined ? null : (
        <div className="cs-extension-slot" data-slot="cable-documents">
          {extensions.documents({ design: docDesign, db: docDb, readOnly: readOnly || editLocked || target !== 'working' && release !== undefined, ...(moduleEditable ? { onChange: moduleOnChange } : {}) })}
        </div>
      )}
    </div>
  );
}
