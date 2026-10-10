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

import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';

import { assetCoverage } from '../asset-coverage.ts';
import type { ArtworkAdapter, ArtworkView } from '../artwork.ts';
import { classes } from '../context.ts';
import { Field, Input, Select } from '../ui/index.ts';
import { parametricModelFile } from '../parametric-model.ts';
import { isModelFileName, MODEL_ACCEPT, MODEL_SOURCE_LABEL, type ModelLinkView, type ModelsAdapter, type ModelSourceKind, type StoredModel } from '../models.ts';
import { useEditLocked, useEditSession } from './edit-session.ts';

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
  // A value key keeps a host's newly allocated fallback array from restarting requests.
  const artworkIdsKey = JSON.stringify([...new Set([id, ...(props.artworkFallbackIds ?? [])])]);

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
    void models.get(kind, id).then((outcome) => {
      if (!live) return;
      if (outcome.ok) setLink(outcome.value);
      else setLinkError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
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
  }, [kind, id, models, artwork, artworkIdsKey, reload]);

  // the model's bytes, once there is a link and the 3D view is wanted
  useEffect(() => {
    if (link === undefined || link === null || !open) return;
    let live = true;
    setModel(undefined);
    setModelError(undefined);
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
    }, () => { if (live) setModelError('The 3D model could not be loaded.'); });
    return () => {
      live = false;
    };
  }, [link, models, open, modelRetry]);

  const drawings = useMemo(() => drawnViews(views), [views]);
  const twoD = drawings.find((v) => v.view === drawnView) ?? drawings[0];
  const photo = useMemo(() => views.find((v) => v.sourceKind === 'photo' && !v.derived), [views]);
  const available: ViewId[] = [
    ...(twoD !== undefined || props.builtIn2d !== undefined ? (['2d'] as const) : []),
    ...(link ? (['3d'] as const) : []),
    ...(photo !== undefined ? (['photo'] as const) : []),
  ];
  // 3D first when there is a model — that is what the page is for
  const shown: ViewId | undefined = view !== undefined && available.includes(view) ? view : link ? '3d' : available[0];

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
  const coverage = useMemo(() => assetCoverage(kind, link, views, model, hasBuiltIn2d, artwork !== undefined && viewsLoaded), [kind, link, views, model, hasBuiltIn2d, artwork, viewsLoaded]);
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
          {open ? '▾' : '▸'} Views
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
            {link.built === false && model === undefined ? ' · not built yet' : ''}
          </span>
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
        <span className="cs-chip">{linkError === undefined ? coverage.model : '3D status unavailable'}</span>
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
          <Field label="Artwork view"><Select aria-label="2D artwork view" value={twoD?.view} onValueChange={setDrawnView} options={drawings.map((v) => ({ value: v.view, label: v.view.replaceAll('-', ' ') }))} /></Field>
        </div>
      ) : null}
      {attaching ? <AttachForm {...props} disabled={disabled} onBusy={setBusy} onDone={done} onError={(text) => setMessage({ tone: 'err', text })} /> : null}
      {!open ? null : shown === '3d' ? (
        modelError !== undefined ? (
          <div className="cs-model-problem" role="alert">
            <p>{modelError}</p>
            <button type="button" onClick={() => setModelRetry((n) => n + 1)}>Retry 3D model</button>
          </div>
        ) : model === undefined ? (
          <p className="cs-model-loading">Loading the model…</p>
        ) : (
          <Suspense fallback={<p className="cs-model-loading">Loading the 3D view…</p>}>
            <ModelViewer3d bytes={model.bytes} mime={model.mime} label={props.label} />
          </Suspense>
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
          <div className="cs-model-art">
            <img src={art.src} alt={`${shown === 'photo' ? 'Photo' : '2D art'} of ${props.label}`} />
            {shown === '2d' ? <p className="cs-model-hint">{wantArt?.view.replaceAll('-', ' ')}</p> : null}
          </div>
        )
      ) : null}
    </section>
  );
}

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
  const [pick, setPick] = useState('');
  const [query, setQuery] = useState('');
  const [sourceKind, setSourceKind] = useState<ModelSourceKind>('uploaded');
  const [sourceCitation, setSourceCitation] = useState('');
  const [working, setWorking] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void models.list().then((outcome) => {
      if (live) setStored(outcome.ok ? outcome.value.models : []);
    });
    return () => {
      live = false;
    };
  }, [models]);

  const shownModels = (stored ?? []).filter((m) => `${m.originalName} ${m.src}`.toLowerCase().includes(query.trim().toLowerCase()));

  const upload = async (file: File): Promise<void> => {
    if (!isModelFileName(file.name)) {
      props.onError(`${file.name} is not an STL, STEP or GLB file.`);
      return;
    }
    setWorking(/\.(step|stp)$/i.test(file.name) ? `Converting ${file.name} — a STEP file can take up to a minute…` : `Uploading ${file.name}…`);
    props.onBusy(true);
    const outcome = await models.upload(kind, id, { name: file.name, bytes: await file.arrayBuffer() }, sourceKind, sourceCitation.trim() || undefined);
    props.onBusy(false);
    setWorking(undefined);
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

  const attach = async (): Promise<void> => {
    if (pick === '') return;
    props.onBusy(true);
    const outcome = await models.attach(kind, id, pick);
    props.onBusy(false);
    if (outcome.ok) props.onDone(outcome.value, 'Attached.');
    else props.onError(`${outcome.message}${outcome.hint === undefined ? '' : ` ${outcome.hint}`}`);
  };

  return (
    <div className="cs-model-attach">
      <fieldset disabled={props.disabled}>
        <Field label="Source citation (optional)" hint="Before choosing a file, add its source URL, license and attribution. These stay with the uploaded model.">
          <Input value={sourceCitation} maxLength={4000} onChange={(event) => setSourceCitation(event.target.value)} />
        </Field>
        <div className="cs-model-attach-row">
          <label>
            Upload a file
            <input
              type="file"
              accept={MODEL_ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void upload(file);
                event.target.value = '';
              }}
            />
          </label>
          <label>
            Source
            <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as ModelSourceKind)}>
              <option value="uploaded">Uploaded</option>
              <option value="vendor">Vendor model</option>
              <option value="kicad-library">KiCad library</option>
              <option value="resin-print">Resin print</option>
              <option value="kicad-board">KiCad board</option>
            </select>
          </label>
          <span className="cs-model-hint">STL, STEP or GLB, up to 24 MB. STEP is converted to GLB on the server.</span>
        </div>
        <div className="cs-model-attach-row">
          <label>
            Or pick an imported model
            <input type="search" placeholder="Search by part number or file" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select aria-label="imported model" size={Math.min(6, Math.max(2, shownModels.length))} value={pick} onChange={(event) => setPick(event.target.value)}>
            {stored === undefined ? <option disabled>Loading…</option> : null}
            {shownModels.map((m) => (
              <option key={m.id} value={m.id} title={m.src}>
                {m.originalName} · {kb(m.bytes)}
              </option>
            ))}
          </select>
          <button type="button" disabled={pick === ''} onClick={() => void attach()}>
            Attach
          </button>
        </div>
      </fieldset>
      {working === undefined ? null : (
        <p className="cs-model-loading" role="status">
          {working}
        </p>
      )}
    </div>
  );
}
