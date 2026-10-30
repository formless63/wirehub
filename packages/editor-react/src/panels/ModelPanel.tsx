/**
 * A Library record's pictures in one place: a
 * 2D / 3D / Photo toggle over the record's drawn art, its 3D model and its
 * photo — whichever of them it has — plus Attach / Replace / Detach for the
 * model.
 *
 * The 3D view itself (three.js) is `ModelViewer3d`, loaded with
 * `React.lazy` the first time a model is shown, so the main bundle does not
 * carry it. A model's bytes come from the host's asset API through the
 * adapter; nothing here knows a URL.
 *
 * Attaching is a Library edit: the controls are disabled while someone else
 * holds the record's edit lock, opening the attach form counts as starting
 * an edit (the host's lock scope takes the lease), and the host's adapter
 * sends the link's version as If-Match.
 */

import { IconChevronRight } from '@tabler/icons-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';

import { assetCoverage } from '../asset-coverage.ts';
import type { ArtworkAdapter, ArtworkView } from '../artwork.ts';
import { classes } from '../context.ts';
import { Button, Field, FileDrop, Input, Select } from '../ui/index.ts';
import { parametricModelFile } from '../parametric-model.ts';
import { isModelFileNameFor, modelAccept, MODEL_SOURCE_LABEL, type ModelCoverAdapter, type ModelCoverCamera, type ModelLinkView, type ModelsAdapter, type ModelSourceKind, type StoredModel } from '../models.ts';
import { useEditLocked, useEditSession } from './edit-session.ts';
import { useRecordRefresh } from '../record-refresh.ts';

const ModelViewer3d = lazy(() => import('./ModelViewer3d.tsx'));

type ViewId = '2d' | '3d' | 'photo';

export interface ModelPanelProps {
  kind: string;
  id: string;
  label: string;
  models: ModelsAdapter;
  /** the record's depictions — its 2D art and any photo */
  artwork?: ArtworkAdapter;
  /** Read-only lookup order after this record, e.g. its shared body and body drawing. Writes still target `id`. */
  artworkFallbackIds?: readonly string[];
  /** 2D art the builder draws itself (a connector's face), when the record has no uploaded 2D view */
  builtIn2d?: ReactNode;
  /** read-only host (no definitions adapter) */
  readOnly?: boolean;
  /** Explicit source-model actions open their preview even if the main panel was folded. */
  initialOpen?: boolean;
  /** The host's shared cover: offers "Use this view as cover" in the 3D view for its kinds. */
  cover?: ModelCoverAdapter;
}

const OPEN_KEY = 'cs-model-panel-open';

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? 'true' : 'false');
  } catch {
    // a private window: the choice just is not remembered
  }
}

/** A depiction as an `<img>` source — an SVG stays inert inside `<img>`. */
export function artSrc(art: { kind: 'vector' | 'raster'; source?: string; dataUri?: string }): string | undefined {
  if (art.kind === 'raster') return art.dataUri;
  return art.source === undefined ? undefined : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(art.source)}`;
}

/** Drawn views, including bottom artwork whose anchors are derived by reflection. */
export function drawnViews(views: readonly ArtworkView[]): ArtworkView[] {
  const order = ['board-top', 'board-bottom', 'mating-face', 'solder-side', 'illustration'];
  const rank = (view: string): number => { const n = order.indexOf(view); return n < 0 ? order.length : n; };
  return views.filter((v) => v.sourceKind !== 'photo' && v.view !== 'schematic-symbol')
    .sort((a, b) => rank(a.view) - rank(b.view) || a.view.localeCompare(b.view));
}

/** The default 2D view, preferring the board's top when supplied. */
export function pick2d(views: readonly ArtworkView[]): ArtworkView | undefined {
  return drawnViews(views)[0];
}

/** The bytes never arrived (a connection failure): an alert with Retry, never the quiet "building" line. */
const MODEL_UNREACHABLE = 'The 3D model could not be loaded.';

function kb(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function ModelPanel(props: ModelPanelProps): JSX.Element {
  const { kind, id, models, artwork } = props;
  const locked = useEditLocked();
  const session = useEditSession();
  const [open, setOpen] = useState(() => props.initialOpen ?? readOpen());
  const [link, setLink] = useState<ModelLinkView | null | undefined>(undefined);
  const [model, setModel] = useState<{ bytes: ArrayBuffer; mime: string } | undefined>(undefined);
  const [modelError, setModelError] = useState<string | undefined>(undefined);
  const [linkError, setLinkError] = useState<string | undefined>();
  const [viewsError, setViewsError] = useState<string | undefined>();
  const [artError, setArtError] = useState<{ view: string; text: string } | undefined>();
  const [reload, setReload] = useState(0);
  const [modelRetry, setModelRetry] = useState(0);
  // the model shown is the record's own native model, because the linked one is not built here
  const [showingFallback, setShowingFallback] = useState(false);
  // no link, but the record's own native outputs made a model (a board's board.glb): shown as its 3D view
  const [native, setNative] = useState<StoredModel | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  const [artRetry, setArtRetry] = useState(0);
  const [viewsLoaded, setViewsLoaded] = useState(artwork === undefined);
  const [views, setViews] = useState<ArtworkView[]>([]);
  const [artworkOwner, setArtworkOwner] = useState<string | undefined>();
  const [art, setArt] = useState<{ view: string; src: string } | undefined>(undefined);
  const [drawnView, setDrawnView] = useState<string | undefined>();
  const [view, setView] = useState<ViewId | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | undefined>(undefined);
  const [savedCover, setSavedCover] = useState<{ camera: ModelCoverCamera; stale: boolean } | undefined>();
  const [coverRead, setCoverRead] = useState(0);
  const coverAdapter = props.cover !== undefined && props.cover.kinds.has(kind) ? props.cover : undefined;
  // A value key keeps a host's newly allocated fallback array from restarting requests.
  const artworkIdsKey = JSON.stringify([...new Set([id, ...(props.artworkFallbackIds ?? [])])]);
  // a job or an import elsewhere on the page changed this record: read it again
  const refresh = useRecordRefresh(kind, id);

  // the record's link and its art, afresh per record
  useEffect(() => {
    let live = true;
    setLink(undefined);
    setModel(undefined);
    setModelError(undefined);
    setLinkError(undefined);
    setViewsError(undefined);
    setArtError(undefined);
    setViews([]);
    setArtworkOwner(undefined);
    setViewsLoaded(artwork === undefined);
    setArt(undefined);
    setView(undefined);
    setDrawnView(undefined);
    setAttaching(false);
    setMessage(undefined);
    setNative(undefined);
    void models.get(kind, id).then((outcome) => {
      if (!live) return;
      if (outcome.ok) setLink(outcome.value);
      else setLinkError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
      if (outcome.ok && outcome.value === null && models.fetchNative !== undefined) {
        void models.outputs?.(kind, id).then((out) => { if (live && out.ok && out.value[0] !== undefined) setNative(out.value[0]); }, () => undefined);
      }
    }, () => { if (live) setLinkError('The model information could not be loaded.'); });
    if (artwork !== undefined) {
      void (async () => {
        try {
          // Like the renderer, inherit a whole manifest. An existing override,
          // even empty, wins; an unreadable override must not silently fall back.
          for (const candidate of JSON.parse(artworkIdsKey) as string[]) {
            const outcome = await artwork.detail(candidate);
            if (!live) return;
            if (!outcome.ok) {
              setViewsError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
              return;
            }
            if (outcome.value.exists) {
              setArtworkOwner(candidate);
              setViews(outcome.value.views);
              setViewsLoaded(true);
              return;
            }
          }
          if (live) setViewsLoaded(true);
        } catch {
          if (live) setViewsError('The picture information could not be loaded.');
        }
      })();
    }
    return () => {
      live = false;
    };
  }, [kind, id, models, artwork, artworkIdsKey, reload, refresh]);

  // a model the hub has not built yet (the model-cache job runs in the background): look again until it is;
  // one whose source files are not on this hub cannot be built here, so there is nothing to wait for
  const awaitingBuild = link !== undefined && link !== null && link.built === false && (link.missing ?? []).length === 0;
  useEffect(() => {
    if (!awaitingBuild) return;
    let live = true;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > 60) {
        clearInterval(timer);
        return;
      }
      void models.get(kind, id).then((outcome) => {
        if (live && outcome.ok && outcome.value !== null && outcome.value.built !== false) setLink(outcome.value);
      }, () => undefined);
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [awaitingBuild, models, kind, id]);

  // the saved cover camera (when the shared cover is a saved 3D view), re-read after a save
  useEffect(() => {
    if (coverAdapter === undefined || link === undefined || link === null) return;
    let live = true;
    void coverAdapter.saved(kind, id).then((saved) => { if (live) setSavedCover(saved); }, () => undefined);
    return () => { live = false; };
  }, [coverAdapter, kind, id, link, coverRead]);

  // the model's bytes, once there is a link (or a native output) and the 3D view is wanted
  useEffect(() => {
    if (link === undefined || !open) return;
    if (link === null) {
      if (native === undefined || models.fetchNative === undefined) return;
      let live = true;
      void models.fetchNative(kind, id).then((outcome) => {
        if (!live) return;
        if (outcome.ok) {
          setModel(outcome.value);
          setShowingFallback(true);
        } else setModelError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
      }, () => { if (live) setModelError(MODEL_UNREACHABLE); });
      return () => {
        live = false;
      };
    }
    let live = true;
    setModel(undefined);
    setModelError(undefined);
    setShowingFallback(false);
    if (link.built === false && link.fallback !== undefined && models.fetchNative !== undefined) {
      // not built here: show the record's own native model meanwhile, without touching the link
      void models.fetchNative(kind, id).then((outcome) => {
        if (!live) return;
        if (outcome.ok) {
          setModel(outcome.value);
          setShowingFallback(true);
        } else setModelError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
      }, () => { if (live) setModelError(MODEL_UNREACHABLE); });
      return () => {
        live = false;
      };
    }
    if (link.parametric !== undefined) {
      // drawn from its dimensions: nothing to fetch
      try {
        setModel(parametricModelFile(link.parametric));
      } catch (error) {
        setModelError(error instanceof Error ? error.message : 'The 3D model could not be drawn.');
      }
      return;
    }
    void models.fetchModel(link.asset).then((outcome) => {
      if (!live) return;
      if (outcome.ok) setModel(outcome.value);
      else setModelError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
    }, () => { if (live) setModelError(MODEL_UNREACHABLE); });
    return () => {
      live = false;
    };
  }, [link, native, models, open, modelRetry, kind, id]);

  /**
   * "Retry 3D model": read the link again and say what happens — the model is there now, it cannot be
   * built here (and which files are missing), or a build was asked for.
   */
  const retryModel = async (): Promise<void> => {
    setRetrying(true);
    setMessage(undefined);
    try {
      const outcome = await models.get(kind, id);
      if (!outcome.ok) {
        setMessage({ tone: 'err', text: `${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}` });
        return;
      }
      const next = outcome.value;
      setLink(next);
      setModelRetry((n) => n + 1);
      if (next === null || next.built !== false) {
        setMessage({ tone: 'ok', text: next === null ? 'This part has no 3D model now.' : 'Loaded the 3D model again.' });
        return;
      }
      const missing = next.missing ?? [];
      if (missing.length > 0) {
        setMessage({
          tone: 'err',
          text: `This hub cannot build the linked model: ${missing.length === 1 ? 'its source file is' : `${missing.length} source files are`} not here (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}). ${next.missingHint ?? 'Upload the model file, or mount the folder that holds it.'}`,
        });
        return;
      }
      // a host that cannot be asked to build: the bytes are simply read again
      if (models.build === undefined) return;
      const queued = await models.build();
      setMessage(queued.ok
        ? { tone: 'ok', text: 'A model build was queued. This view updates when it has run.' }
        : { tone: 'err', text: `${queued.message}${queued.hint === undefined ? '' : ` ${queued.hint}`}` });
    } finally {
      setRetrying(false);
    }
  };

  const drawings = useMemo(() => drawnViews(views), [views]);
  const twoD = drawings.find((v) => v.view === drawnView) ?? drawings[0];
  const photo = useMemo(() => views.find((v) => v.sourceKind === 'photo' && !v.derived), [views]);
  const available: ViewId[] = [
    ...(twoD !== undefined || props.builtIn2d !== undefined ? (['2d'] as const) : []),
    ...(link || native !== undefined ? (['3d'] as const) : []),
    ...(photo !== undefined ? (['photo'] as const) : []),
  ];
  // 3D first when there is a model — that is what the page is for
  const shown: ViewId | undefined = view !== undefined && available.includes(view) ? view : link || native !== undefined ? '3d' : available[0];

  // the 2D/photo bytes, when that view is shown
  const wantArt = shown === 'photo' ? photo : shown === '2d' ? twoD : undefined;
  useEffect(() => {
    if (artwork === undefined || artworkOwner === undefined || wantArt === undefined || !open) return;
    if (art?.view === wantArt.view) return;
    let live = true;
    setArtError(undefined);
    void artwork.artwork(artworkOwner, wantArt.view).then((outcome) => {
      if (!live) return;
      if (!outcome.ok) {
        setArtError({ view: wantArt.view, text: `${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}` });
        return;
      }
      const src = artSrc(outcome.value);
      if (src !== undefined) setArt({ view: wantArt.view, src });
      else setArtError({ view: wantArt.view, text: 'The picture data could not be read.' });
    }, () => { if (live) setArtError({ view: wantArt.view, text: 'The picture could not be loaded.' }); });
    return () => {
      live = false;
    };
  }, [artwork, artworkOwner, wantArt, open, art, artRetry]);

  const startAttach = useCallback((): void => {
    setAttaching(true);
    setMessage(undefined);
    // opening the form is the start of an edit: the host's scope takes the lease
    session.onDirtyChange?.(true);
  }, [session]);
  const endAttach = useCallback((): void => {
    setAttaching(false);
    session.onDirtyChange?.(false);
  }, [session]);

  const done = (next: ModelLinkView | null, text: string): void => {
    setLink(next);
    setView(next === null ? undefined : '3d');
    setMessage({ tone: 'ok', text });
    endAttach();
  };

  const detach = async (): Promise<void> => {
    setBusy(true);
    const outcome = await models.detach(kind, id);
    setBusy(false);
    if (outcome.ok) done(null, 'Detached. The stored model stays available to attach again.');
    else setMessage({ tone: 'err', text: `${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}` });
  };

  const hasBuiltIn2d = props.builtIn2d !== undefined;
  const coverage = useMemo(() => assetCoverage(kind, link, views, showingFallback ? undefined : model, hasBuiltIn2d, artwork !== undefined && viewsLoaded), [kind, link, views, model, showingFallback, hasBuiltIn2d, artwork, viewsLoaded]);
  const disabled = locked || props.readOnly === true || busy;
  const toggleOpen = (): void => {
    const next = !open;
    setOpen(next);
    writeOpen(next);
  };

  return (
    <section className={classes('cs-model-panel', !open && 'is-collapsed')} aria-label="Pictures of this part">
      <header className="cs-model-head">
        <button type="button" className="cs-model-fold" aria-expanded={open} onClick={toggleOpen} title={open ? 'Hide the pictures' : 'Show the pictures'}>
          <IconChevronRight size={12} aria-hidden /> Views
        </button>
        {available.length > 0 ? (
          <div className="cs-seg" role="group" aria-label="view">
            {(['2d', '3d', 'photo'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={classes(shown === v && 'is-active')}
                aria-pressed={shown === v}
                disabled={!available.includes(v)}
                title={available.includes(v) ? undefined : v === '3d' ? 'No 3D model yet — attach one' : v === 'photo' ? 'No photo in its artwork' : 'No 2D art'}
                onClick={() => {
                  setView(v);
                  if (!open) toggleOpen();
                }}
              >
                {v === '2d' ? '2D' : v === '3d' ? '3D' : 'Photo'}
              </button>
            ))}
          </div>
        ) : null}
        {link ? (
          <span className="cs-chip cs-model-source" title={link.src}>
            {MODEL_SOURCE_LABEL[link.sourceKind]}
            {link.revision === undefined ? '' : ` · ${link.revision}`}
            {link.built === false && (model === undefined || showingFallback) ? ' · not built yet' : ''}
          </span>
        ) : link === null && native !== undefined ? (
          <span className="cs-chip cs-model-source" title={native.src}>{native.originalName} · native output</span>
        ) : link === null ? (
          <span className="cs-model-none">No 3D model</span>
        ) : null}
        {props.readOnly ? null : <span className="cs-model-actions">
          {link === undefined ? null : (
            <button type="button" disabled={disabled} onClick={attaching ? endAttach : startAttach} title={locked ? 'Someone else is editing this part' : undefined}>
              {attaching ? 'Cancel' : link ? 'Replace model' : 'Attach model'}
            </button>
          )}
          {link ? (
            <button type="button" disabled={disabled} onClick={() => void detach()} title="Unlink the model from this part (the stored file stays)">
              Detach
            </button>
          ) : null}
        </span>}
      </header>
      <div className="cs-asset-coverage" role="group" aria-label="Asset coverage">
        <span className="cs-chip">{linkError !== undefined ? '3D status unavailable' : link === null && native !== undefined ? 'Native output' : coverage.model}</span>
        <span>{viewsError !== undefined ? 'Front artwork status unavailable' : viewsLoaded ? coverage.front : 'Front artwork loading'}</span>
        <span>{viewsError !== undefined ? 'Back artwork status unavailable' : viewsLoaded ? coverage.back : 'Back artwork loading'}</span>
        <span>{coverage.materials}</span>
        <details><summary>Source and limitations</summary><p>{coverage.explanation}</p>{link?.src ? <p>{link.src}</p> : null}</details>
      </div>
      {linkError === undefined && viewsError === undefined ? null : (
        <div className="cs-model-problem" role="alert">
          {linkError === undefined ? null : <p>{linkError}</p>}
          {viewsError === undefined ? null : <p>{viewsError}</p>}
          <button type="button" onClick={() => setReload((n) => n + 1)}>Retry pictures</button>
        </div>
      )}
      {message === undefined ? null : (
        <p className={classes('cs-model-message', message.tone === 'err' && 'is-error')} role="status">
          {message.text}
        </p>
      )}
      {open && shown === '2d' && drawings.length > 1 ? (
        <div className="cs-model-actions" role="group" aria-label="2D artwork view">
          <Field label="Inspect artwork"><Select aria-label="2D artwork view" value={twoD?.view} onValueChange={setDrawnView} options={drawings.map((v) => ({ value: v.view, label: v.view.replaceAll('-', ' ') }))} /></Field>
        </div>
      ) : null}
      {attaching ? <AttachForm {...props} disabled={disabled} onBusy={setBusy} onDone={done} onError={(text) => setMessage({ tone: 'err', text })} /> : null}
      {!open ? null : shown === '3d' ? (
        modelError !== undefined && modelError !== MODEL_UNREACHABLE && link?.built === false ? (
          // not built on this hub yet: one status line, the why on hover; the poll below reloads it
          <p className="cs-model-status" role="status" title={modelError} data-testid="model-not-built">
            {(link.missing ?? []).length > 0 ? 'Not built — source files missing' : <><span className="cs-model-spin" aria-hidden="true" /> 3D model building…</>}
            <button type="button" className="cs-link" disabled={retrying} onClick={() => void retryModel()}>{retrying ? 'Retrying…' : 'Retry'}</button>
          </p>
        ) : modelError !== undefined ? (
          <div className="cs-model-problem" role="alert">
            <p>{modelError}</p>
            <button type="button" disabled={retrying} onClick={() => void retryModel()}>{retrying ? 'Retrying…' : 'Retry 3D model'}</button>
          </div>
        ) : model === undefined ? (
          <p className="cs-model-loading">Loading the model…</p>
        ) : (
          <>
          {showingFallback && link?.fallback !== undefined ? (
            <p
              className="cs-model-status"
              role="status"
              data-testid="model-fallback"
              title={`Showing this board's native model, ${link.fallback.originalName} (${link.fallback.src}). The linked model (${MODEL_SOURCE_LABEL[link.sourceKind]}) is not built on this hub${(link.missing ?? []).length > 0 ? ': its source files are not here.' : ' yet.'} The link is unchanged.`}
            >
              {(link.missing ?? []).length > 0 ? 'Native model shown · linked model: source files missing' : <><span className="cs-model-spin" aria-hidden="true" /> Native model shown · linked model building…</>}
              <button type="button" className="cs-link" disabled={retrying} onClick={() => void retryModel()}>{retrying ? 'Retrying…' : 'Retry'}</button>
            </p>
          ) : null}
          <Suspense fallback={<p className="cs-model-loading">Loading the 3D view…</p>}>
            <ModelViewer3d
              bytes={model.bytes}
              mime={model.mime}
              label={props.label}
              {...(coverAdapter === undefined || link === undefined || link === null || showingFallback ? {} : {
                cover: {
                  ...(savedCover === undefined ? {} : { camera: savedCover.camera, stale: savedCover.stale }),
                  disabled: locked || props.readOnly === true,
                  onSave: async (capture) => {
                    const out = await coverAdapter.save(kind, id, { ...capture, modelAsset: link.asset });
                    setCoverRead((n) => n + 1);
                    return out.ok ? undefined : `${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`;
                  },
                },
              })}
            />
          </Suspense>
          </>
        )
      ) : shown === '2d' && twoD === undefined ? (
        <div className="cs-model-art">{props.builtIn2d}</div>
      ) : shown === '2d' || shown === 'photo' ? (
        artError !== undefined && artError.view === wantArt?.view ? (
          <div className="cs-model-problem" role="alert">
            <p>{artError?.text}</p>
            <button type="button" onClick={() => setArtRetry((n) => n + 1)}>Retry picture</button>
          </div>
        ) : art === undefined || art.view !== wantArt?.view ? (
          <p className="cs-model-loading">Loading…</p>
        ) : (
          <div className={classes('cs-model-art', shown === '2d' && 'is-drawing')}>
            <img src={art.src} alt={`${shown === 'photo' ? 'Photo' : '2D art'} of ${props.label}`} />
            {shown === '2d' ? <p className="cs-model-hint">{wantArt?.view.replaceAll('-', ' ')}</p> : null}
          </div>
        )
      ) : null}
    </section>
  );
}

const SOURCE_OPTIONS = [
  { value: 'uploaded', label: 'Uploaded' },
  { value: 'vendor', label: 'Vendor model' },
  { value: 'kicad-library', label: 'KiCad library' },
  { value: 'resin-print', label: 'Resin print' },
  { value: 'kicad-board', label: 'KiCad board' },
];

function AttachForm(
  props: ModelPanelProps & {
    disabled: boolean;
    onBusy: (busy: boolean) => void;
    onDone: (link: ModelLinkView, text: string) => void;
    onError: (text: string) => void;
  },
): JSX.Element {
  const { kind, id, models } = props;
  const [stored, setStored] = useState<StoredModel[] | undefined>(undefined);
  // the record's own native outputs (a board's board.glb), offered first
  const [outputs, setOutputs] = useState<StoredModel[]>([]);
  const [pick, setPick] = useState('');
  const [query, setQuery] = useState('');
  const [sourceKind, setSourceKind] = useState<ModelSourceKind>('uploaded');
  const [sourceCitation, setSourceCitation] = useState('');
  const [working, setWorking] = useState<string | undefined>(undefined);
  /** the file chosen: its source and citation are asked after, both optional */
  const [file, setFile] = useState<File | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void models.list().then((outcome) => {
      if (live) setStored(outcome.ok ? outcome.value.models : []);
    });
    void models.outputs?.(kind, id).then((outcome) => {
      if (live) setOutputs(outcome.ok ? outcome.value : []);
    });
    return () => {
      live = false;
    };
  }, [models, kind, id]);

  const matches = (m: StoredModel): boolean => `${m.originalName} ${m.src}`.toLowerCase().includes(query.trim().toLowerCase());
  const shownOutputs = outputs.filter(matches);
  const shownModels = (stored ?? []).filter(matches);

  const upload = async (file: File): Promise<void> => {
    if (!isModelFileNameFor(kind, file.name)) {
      props.onError(`${file.name} is not an STL, STEP or GLB file${kind === 'pcbas' ? ' or a KiCad board file' : ''}.`);
      return;
    }
    setWorking(/\.(step|stp)$/i.test(file.name) ? `Converting ${file.name} — a STEP file can take up to a minute…` : `Uploading ${file.name}…`);
    props.onBusy(true);
    // a KiCad board file builds the board's model from its footprints: its source is the board itself
    const kindOfFile: ModelSourceKind = /\.kicad_pcb$/i.test(file.name) ? 'kicad-board' : sourceKind;
    const outcome = await models.upload(kind, id, { name: file.name, bytes: await file.arrayBuffer() }, kindOfFile, sourceCitation.trim() || undefined);
    props.onBusy(false);
    setWorking(undefined);
    setFile(undefined);
    if (outcome.ok) {
      const stats = outcome.value.stats;
      props.onDone(
        outcome.value.link,
        `Attached ${file.name}${stats === undefined || stats.triangles === 0 ? '' : ` — ${stats.triangles.toLocaleString()} triangles${stats.simplified ? ` (simplified from ${stats.sourceTriangles.toLocaleString()})` : ''}`}.`,
      );
    } else {
      props.onError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
    }
  };

  const attach = async (chosen = pick): Promise<void> => {
    if (chosen === '') return;
    props.onBusy(true);
    const output = chosen.startsWith('output:') ? chosen.slice('output:'.length) : undefined;
    const outcome = output !== undefined && models.attachOutput !== undefined ? await models.attachOutput(kind, id, output) : await models.attach(kind, id, chosen);
    props.onBusy(false);
    if (outcome.ok) props.onDone(outcome.value, 'Attached.');
    else props.onError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
  };

  const options = [
    ...shownOutputs.map((m) => ({ value: `output:${m.id}`, name: m.originalName, note: `native output · ${kb(m.bytes)}`, title: m.src })),
    ...shownModels.map((m) => ({ value: m.id, name: m.originalName, note: kb(m.bytes), title: m.src })),
  ];
  return (
    <div className="cs-model-attach">
      <fieldset disabled={props.disabled}>
        {file === undefined ? (
          <FileDrop
            accept={modelAccept(kind)}
            onFiles={(files) => { if (files[0] !== undefined) setFile(files[0]); }}
            onReject={(files) => props.onError(`${files[0]?.name ?? 'That file'} is not an STL, STEP or GLB file${kind === 'pcbas' ? ' or a KiCad board file' : ''}.`)}
            hint={`STL, STEP or GLB, up to 24 MB${kind === 'pcbas' ? ' · or the .kicad_pcb' : ''}`}
          >
            Drop a model file or choose one
          </FileDrop>
        ) : (
          <div className="cs-model-attach-row">
            <span className="cs-mono cs-model-file">{file.name}</span>
            {/\.kicad_pcb$/i.test(file.name) ? null : (
              <Select aria-label="Source" size="sm" value={sourceKind} onValueChange={(value) => setSourceKind(value as ModelSourceKind)} options={SOURCE_OPTIONS} />
            )}
            <Input aria-label="Source citation (optional)" placeholder="Source, licence (optional)" value={sourceCitation} maxLength={4000} onChange={(event) => setSourceCitation(event.target.value)} />
            <Button size="sm" variant="primary" onClick={() => void upload(file)}>Attach</Button>
            <Button size="sm" variant="ghost" onClick={() => setFile(undefined)}>Cancel</Button>
          </div>
        )}
        {file !== undefined || (stored !== undefined && stored.length === 0 && outputs.length === 0) ? null : (
          <div className="cs-model-pick">
            <Input type="search" aria-label="Search stored models" placeholder="Or pick a stored model…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <ul role="listbox" aria-label="imported model">
              {stored === undefined ? <li className="cs-dim">Loading…</li> : null}
              {options.map((o) => (
                <li key={o.value} role="option" aria-selected={pick === o.value}>
                  <button type="button" className={classes(pick === o.value && 'is-on')} title={o.title} onClick={() => setPick(o.value)} onDoubleClick={() => { setPick(o.value); void attach(o.value); }}>
                    <span className="cs-mono">{o.name}</span>
                    <span className="cs-dim">{o.note}</span>
                  </button>
                </li>
              ))}
            </ul>
            <Button size="sm" disabled={pick === ''} onClick={() => void attach()}>Attach</Button>
          </div>
        )}
      </fieldset>
      {working === undefined ? null : (
        <p className="cs-model-loading" role="status">
          {working}
        </p>
      )}
    </div>
  );
}
