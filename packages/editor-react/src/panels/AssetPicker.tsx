/**
 * The shared asset picker: thumbnails, search by
 * name, recently used first — wherever an upload exists today, this is the
 * "or pick one you already have" alternative next to it.
 *
 * Selecting a thumbnail hands back the asset's own `dataUri` — already in
 * hand from `list()`, no second fetch — so a caller (`DrawingForm`'s photo
 * field today) can treat a pick exactly like a fresh upload: the same state,
 * the same draft-until-saved rule. The host's save path (`workbenchDrawings`
 * -> `PUT /api/drawings/:id/photo`) dedups those bytes against the very
 * asset the picker read them from, so nothing is written twice.
 */

import { useEffect, useMemo, useState, type JSX } from 'react';

import {
  formatAssetSize,
  matchesAssetQuery,
  orderAssets,
  type AssetsAdapter,
  type SharedAsset,
} from '../assets.ts';

export interface AssetPickerProps {
  assets: AssetsAdapter;
  onPick: (asset: SharedAsset) => void;
  onClose: () => void;
  /** the modal's heading — defaults to a generic one so every call site is not forced to repeat itself */
  title?: string;
}

export function AssetPicker(props: AssetPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; assets: SharedAsset[] }
  >({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    void props.assets.list().then((result) => {
      if (!live) return;
      setState(result.ok ? { kind: 'ready', assets: result.value } : { kind: 'error', message: result.message });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ordered = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return orderAssets(state.assets, props.assets.recentIds?.() ?? []);
  }, [state, props.assets]);

  const shown = ordered.filter((asset) => matchesAssetQuery(asset, query));

  const pick = (asset: SharedAsset): void => {
    props.assets.noteUsed?.(asset.id);
    props.onPick(asset);
  };

  return (
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label={props.title ?? 'Choose an asset'}>
      <div className="cs-modal-card cs-asset-picker">
        <h2>{props.title ?? 'Choose an asset'}</h2>
        <input
          className="cs-input"
          type="search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by filename…"
          aria-label="Search assets"
        />
        {state.kind === 'loading' ? <p className="cs-empty">Reading the asset library…</p> : null}
        {state.kind === 'error' ? <p className="cs-error">{state.message}</p> : null}
        {state.kind === 'ready' && shown.length === 0 ? (
          <p className="cs-empty">
            {state.assets.length === 0 ? 'Nothing has been uploaded yet.' : `Nothing matches “${query}”.`}
          </p>
        ) : null}
        {state.kind === 'ready' && shown.length > 0 ? (
          <ul className="cs-asset-grid">
            {shown.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  className="cs-asset-item"
                  onClick={() => pick(asset)}
                  title={`${asset.originalName} — ${asset.src}`}
                >
                  <img src={asset.dataUri} alt="" />
                  <span className="cs-asset-name">{asset.originalName}</span>
                  <span className="cs-asset-meta">{formatAssetSize(asset.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="cs-modal-actions">
          <button type="button" className="cs-quiet" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
