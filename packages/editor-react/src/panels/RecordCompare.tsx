/**
 * The base's compare view: two records of one kind, or a record and one of its revisions, or two
 * revisions (`docs/revisions.md`).
 *
 * - **Fields**: a field diff (`record-diff.ts`), changed fields by default, unchanged on request.
 * - **2D**: each side's drawn art (a revision's as it was saved) side by side, or laid over each
 *   other in difference blending, where only what differs stays bright.
 * - **3D**: each side's model, when both have one (a revision's by its content address), side by
 *   side or laid over each other in two colours (`ModelOverlay3d`).
 *
 * A module's compare view (`CompareViewContribution`) replaces it for the kinds the module declares.
 */

import { lazy, Suspense, useEffect, useMemo, useState, type JSX } from 'react';
import type { Db } from '@wirehub/model';

import type { ArtworkAdapter } from '../artwork.ts';
import type { ModelsAdapter } from '../models.ts';
import { diffRecords, libraryRecord, libraryRecordIds } from '../record-diff.ts';
import { compareSideId, parseCompareSide, type CompareSide, type RevisionsAdapter, type RevisionSummary } from '../revisions.ts';
import { artSrc, pick2d } from './ModelPanel.tsx';

const ModelViewer3d = lazy(() => import('./ModelViewer3d.tsx'));
const ModelOverlay3d = lazy(() => import('./ModelOverlay3d.tsx'));

export interface RecordRef {
  kind: string;
  id: string;
  /** a saved revision of the record; absent = the record as it is */
  rev?: number;
}

interface Loaded {
  record?: unknown;
  art?: string;
  model?: string;
  missing?: string;
}

const sideText = (s: CompareSide): string => `${s.id}${s.rev === undefined ? '' : ` rev ${s.rev}`}`;

/** Everything one side shows: its fields, its 2D art as an image source, its model's content address. */
async function load(side: CompareSide, db: Db, adapters: { revisions?: RevisionsAdapter; artwork?: ArtworkAdapter; models?: ModelsAdapter }): Promise<Loaded> {
  if (side.rev !== undefined) {
    if (adapters.revisions === undefined) return { missing: 'this host keeps no revisions' };
    const got = await adapters.revisions.read(side.kind, side.id, side.rev);
    if (!got.ok) return { missing: got.message };
    const art = got.value.art === undefined ? undefined : artSrc({ kind: 'vector', source: got.value.art.svg });
    return { record: got.value.record, ...(art === undefined ? {} : { art }), ...(got.value.model === undefined ? {} : { model: got.value.model.asset }) };
  }
  const record = libraryRecord(db, side.kind, side.id);
  const out: Loaded = { ...(record === undefined ? { missing: `there is no ${side.kind} record ${side.id}` } : { record }) };
  if (adapters.artwork !== undefined) {
    const detail = await adapters.artwork.detail(side.id);
    const view = detail.ok ? pick2d(detail.value.views) : undefined;
    if (view !== undefined) {
      const art = await adapters.artwork.artwork(side.id, view.view);
      if (art.ok) {
        const src = artSrc(art.value);
        if (src !== undefined) out.art = src;
      }
    }
  }
  if (adapters.models !== undefined) {
    const link = await adapters.models.get(side.kind, side.id);
    if (link.ok && link.value !== null) out.model = link.value.asset;
  }
  return out;
}

function ArtSide({ side, loaded }: { side: CompareSide; loaded: Loaded }): JSX.Element {
  return (
    <figure style={{ flex: 1, margin: 0 }}>
      {loaded.art === undefined ? <p className="cs-modal-say">no drawn art</p> : <img src={loaded.art} alt={sideText(side)} style={{ width: '100%' }} />}
      <figcaption className="cs-small">{sideText(side)}</figcaption>
    </figure>
  );
}

export function RecordCompare(props: {
  db: Db;
  a: RecordRef;
  /** absent: the view asks for the second record */
  b?: RecordRef;
  onClose: () => void;
  revisions?: RevisionsAdapter;
  artwork?: ArtworkAdapter;
  models?: ModelsAdapter;
}): JSX.Element {
  const a: CompareSide = props.a;
  const [picked, setPicked] = useState<string | undefined>(props.b === undefined ? undefined : compareSideId(props.b));
  const b = parseCompareSide(picked);
  const [showSame, setShowSame] = useState(false);
  const [tab, setTab] = useState<'fields' | '2d' | '3d'>('fields');
  const [overlay, setOverlay] = useState(false);
  const [revs, setRevs] = useState<RevisionSummary[]>([]);
  const [left, setLeft] = useState<Loaded | undefined>(undefined);
  const [right, setRight] = useState<Loaded | undefined>(undefined);
  const [models, setModels] = useState<{ a?: { bytes: ArrayBuffer; mime: string }; b?: { bytes: ArrayBuffer; mime: string }; error?: string } | undefined>(undefined);
  const others = useMemo(() => libraryRecordIds(props.db, a.kind).filter((r) => r.id !== a.id), [props.db, a.kind, a.id]);
  const adapters = useMemo(
    () => ({ ...(props.revisions === undefined ? {} : { revisions: props.revisions }), ...(props.artwork === undefined ? {} : { artwork: props.artwork }), ...(props.models === undefined ? {} : { models: props.models }) }),
    [props.revisions, props.artwork, props.models],
  );

  // the record's own revisions, to compare against
  useEffect(() => {
    let live = true;
    if (props.revisions === undefined) return;
    void props.revisions.list(a.kind, a.id).then((out) => {
      if (live && out.ok) setRevs(out.value.revisions);
    });
    return () => {
      live = false;
    };
  }, [props.revisions, a.kind, a.id]);

  useEffect(() => {
    let live = true;
    setLeft(undefined);
    void load(a, props.db, adapters).then((x) => {
      if (live) setLeft(x);
    });
    return () => {
      live = false;
    };
  }, [a.kind, a.id, a.rev, props.db, adapters]);

  useEffect(() => {
    let live = true;
    setRight(undefined);
    setModels(undefined);
    const side = parseCompareSide(picked);
    if (side === undefined) return;
    void load(side, props.db, adapters).then((x) => {
      if (live) setRight(x);
    });
    return () => {
      live = false;
    };
  }, [picked, props.db, adapters]);

  // the models' bytes, once the 3D tab is opened
  const leftModel = left?.model;
  const rightModel = right?.model;
  useEffect(() => {
    if (tab !== '3d' || leftModel === undefined || rightModel === undefined || props.models === undefined) return;
    let live = true;
    const store = props.models;
    void Promise.all([store.fetchModel(leftModel), store.fetchModel(rightModel)]).then(([x, y]) => {
      if (!live) return;
      if (x.ok && y.ok) setModels({ a: x.value, b: y.value });
      else setModels({ error: !x.ok ? x.message : !y.ok ? y.message : 'unknown' });
    });
    return () => {
      live = false;
    };
  }, [tab, leftModel, rightModel, props.models]);

  const rows = useMemo(() => (left?.record === undefined || right?.record === undefined ? [] : diffRecords(left.record as never, right.record as never)), [left, right]);
  const shown = showSame ? rows : rows.filter((r) => r.status !== 'same');
  const differing = rows.filter((r) => r.status !== 'same').length;
  const has2d = left?.art !== undefined || right?.art !== undefined;
  const has3d = leftModel !== undefined && rightModel !== undefined;

  return (
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label="Compare records">
      <div className="cs-modal-card cs-compare">
        <h2>Compare</h2>
        <div className="cs-field">
          <span>
            <code>
              {a.kind}/{sideText(a)}
            </code>{' '}
            with
          </span>
          <select aria-label="Compare with" value={picked ?? ''} onChange={(e) => setPicked(e.target.value === '' ? undefined : e.target.value)}>
            <option value="">choose a record or a revision…</option>
            {a.rev === undefined ? null : <option value={compareSideId({ kind: a.kind, id: a.id })}>{a.id} as it is now</option>}
            {revs.length === 0 ? null : (
              <optgroup label={`Revisions of ${a.id}`}>
                {revs
                  .filter((r) => r.rev !== a.rev)
                  .map((r) => (
                    <option key={r.rev} value={compareSideId({ kind: a.kind, id: a.id, rev: r.rev })}>
                      rev {r.rev}
                      {r.label === undefined ? '' : ` (${r.label})`} — {r.note}
                    </option>
                  ))}
              </optgroup>
            )}
            <optgroup label="Other records">
              {others.map((r) => (
                <option key={r.id} value={compareSideId({ kind: a.kind, id: r.id })}>
                  {r.label} ({r.id})
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        {left?.missing === undefined ? null : <p className="cs-modal-say">{left.missing}.</p>}
        {right?.missing === undefined ? null : <p className="cs-modal-say">{right.missing}.</p>}
        {b === undefined || right === undefined || left === undefined ? null : (
          <>
            <nav className="cs-conn-tabs" role="tablist" aria-label="compare">
              <button type="button" role="tab" aria-selected={tab === 'fields'} className={tab === 'fields' ? 'is-active' : ''} onClick={() => setTab('fields')}>
                Fields
              </button>
              {has2d ? (
                <button type="button" role="tab" aria-selected={tab === '2d'} className={tab === '2d' ? 'is-active' : ''} onClick={() => setTab('2d')}>
                  2D
                </button>
              ) : null}
              {has3d ? (
                <button type="button" role="tab" aria-selected={tab === '3d'} className={tab === '3d' ? 'is-active' : ''} onClick={() => setTab('3d')}>
                  3D
                </button>
              ) : null}
            </nav>
            {tab === 'fields' ? (
              <>
                <label className="cs-small">
                  <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> show unchanged fields ({rows.length - differing})
                </label>
                {differing === 0 ? (
                  <p className="cs-modal-say" data-testid="compare-identical">
                    The two have the same fields.
                  </p>
                ) : null}
                <table className="cs-compare-table" aria-label="Field differences">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>{sideText(a)}</th>
                      <th>{sideText(b)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.path} data-status={r.status}>
                        <td>
                          <code>{r.path}</code>
                        </td>
                        <td>{r.a ?? <em>—</em>}</td>
                        <td>{r.b ?? <em>—</em>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
            {tab === '2d' ? (
              <div data-testid="compare-2d">
                <label className="cs-small">
                  <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> lay over each other (what differs stays bright)
                </label>
                {overlay && left.art !== undefined && right.art !== undefined ? (
                  <div style={{ position: 'relative', background: '#000', maxWidth: 480 }}>
                    <img src={left.art} alt={sideText(a)} style={{ width: '100%', display: 'block', filter: 'invert(1)' }} />
                    <img src={right.art} alt={sideText(b)} style={{ position: 'absolute', inset: 0, width: '100%', mixBlendMode: 'difference', filter: 'invert(1)' }} />
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <ArtSide side={a} loaded={left} />
                    <ArtSide side={b} loaded={right} />
                  </div>
                )}
              </div>
            ) : null}
            {tab === '3d' ? (
              <div data-testid="compare-3d">
                <label className="cs-small">
                  <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> lay over each other
                </label>
                {models === undefined ? (
                  <p className="cs-modal-say">Loading the models…</p>
                ) : models.a === undefined || models.b === undefined ? (
                  <p className="cs-modal-say">A model could not be loaded: {models.error}</p>
                ) : (
                  <Suspense fallback={<p className="cs-modal-say">Loading the 3D view…</p>}>
                    {overlay ? (
                      <ModelOverlay3d a={{ ...models.a, label: sideText(a) }} b={{ ...models.b, label: sideText(b) }} />
                    ) : (
                      <div style={{ display: 'flex', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <ModelViewer3d bytes={models.a.bytes} mime={models.a.mime} label={sideText(a)} height={280} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <ModelViewer3d bytes={models.b.bytes} mime={models.b.mime} label={sideText(b)} height={280} />
                        </div>
                      </div>
                    )}
                  </Suspense>
                )}
              </div>
            ) : null}
          </>
        )}
        <div className="cs-modal-actions">
          <button type="button" className="cs-quiet" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
