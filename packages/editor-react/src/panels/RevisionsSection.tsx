/**
 * A library record's revisions (`docs/revisions.md`): what it is now against its saved revisions,
 * each revision with its note, number and where it is used (the design versions built with it),
 * the revisions an outside source supplies, Compare, and Save a revision — optionally under the
 * numbering scheme's next variant number. Saving keeps the record's drawn art and the content
 * address of its 3D model with the revision, so it can be compared later.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type { ArtworkAdapter } from '../artwork.ts';
import type { ModelsAdapter } from '../models.ts';
import { compareSideId, type RevisionsAdapter, type RevisionsView, type SaveRevisionInput } from '../revisions.ts';
import { pick2d } from './ModelPanel.tsx';

const day = (iso: string | undefined): string => (iso === undefined ? '' : iso.slice(0, 10));

export function RevisionsSection(props: {
  kind: string;
  id: string;
  revisions: RevisionsAdapter;
  artwork?: ArtworkAdapter;
  models?: ModelsAdapter;
  readOnly?: boolean;
  /** open the compare view on two sides (`<kind>/<id>` or `<kind>/<id>@<rev>`) */
  onCompare?: (a: string, b?: string) => void;
  /** the record changed (a new variant number) */
  onChanged?: () => void;
}): JSX.Element {
  const { kind, id } = props;
  const [view, setView] = useState<RevisionsView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState<{ note: string; label: string; renumber: boolean; next?: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [numberPending, setNumberPending] = useState(false);
  const suggestionRequest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const out = await props.revisions.list(kind, id);
    if (out.ok) {
      setView(out.value);
      setError(undefined);
    } else setError(out.message);
  }, [props.revisions, kind, id]);

  useEffect(() => {
    setView(undefined);
    setSaving(undefined);
    setNumberPending(false);
    suggestionRequest.current += 1;
    void reload();
    return () => { suggestionRequest.current += 1; };
  }, [reload]);

  const save = async (): Promise<void> => {
    if (saving === undefined || busy || numberPending) return;
    setBusy(true);
    const input: SaveRevisionInput = { note: saving.note, ...(saving.label.trim() === '' ? {} : { label: saving.label }), ...(saving.renumber ? { renumber: true } : {}) };
    // keep the drawn art and the model as they are now
    if (props.artwork !== undefined) {
      const detail = await props.artwork.detail(id);
      const pick = detail.ok ? pick2d(detail.value.views) : undefined;
      if (pick !== undefined && pick.kind === 'vector') {
        const art = await props.artwork.artwork(id, pick.view);
        if (art.ok && art.value.source !== undefined) input.art = { view: pick.view, svg: art.value.source };
      }
    }
    if (props.models !== undefined) {
      const link = await props.models.get(kind, id);
      if (link.ok && link.value !== null) input.model = { asset: link.value.asset };
    }
    const out = await props.revisions.save(kind, id, input);
    setBusy(false);
    if (!out.ok) {
      setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
      return;
    }
    setView(out.value);
    setSaving(undefined);
    setError(undefined);
    if (saving.renumber) props.onChanged?.();
  };

  const cancelSave = (): void => {
    suggestionRequest.current += 1;
    setNumberPending(false);
    setSaving(undefined);
  };
  const startSave = (): void => {
    suggestionRequest.current += 1;
    setNumberPending(false);
    setError(undefined);
    setSaving({ note: '', label: '', renumber: false });
  };
  const toggleRenumber = async (on: boolean): Promise<void> => {
    if (saving === undefined) return;
    const request = ++suggestionRequest.current;
    setNumberPending(on);
    setError(undefined);
    setSaving((current) => current === undefined ? undefined : { ...current, renumber: on, next: undefined });
    if (!on) return;
    try {
      const out = await props.revisions.nextNumber(kind, id);
      if (suggestionRequest.current !== request) return;
      setNumberPending(false);
      if (!out.ok) {
        setError(out.message);
        setSaving((current) => current === undefined ? undefined : { ...current, renumber: false });
        return;
      }
      setSaving((current) => current === undefined ? undefined : { ...current, renumber: true, next: out.value.suggestion.pn });
    } catch {
      if (suggestionRequest.current !== request) return;
      setNumberPending(false);
      setError('The next variant number could not be checked. Try again.');
      setSaving((current) => current === undefined ? undefined : { ...current, renumber: false });
    }
  };

  const usesOf = (rev: number) => view?.whereUsed.byRev[rev] ?? [];
  const now = compareSideId({ kind, id });
  return (
    <section className="cs-panel cs-revisions" data-testid="revisions" aria-label="Revisions">
      <h3>
        Revisions <span className="cs-count">{view?.revisions.length ?? ''}</span>
      </h3>
      {error === undefined ? null : (
        <p className="cs-err" role="alert">
          {error}
        </p>
      )}
      {view === undefined ? null : (
        <>
          <p className="cs-small" data-testid="revisions-now">
            {view.current.rev !== undefined
              ? `As it is now: revision ${view.current.rev}.`
              : view.current.changedSince !== undefined
                ? `Changed since revision ${view.current.changedSince}.`
                : 'No revision saved yet.'}
            {view.current.partNumber === undefined ? '' : ` Number ${view.current.partNumber}.`}
          </p>
          <ol className="cs-revision-list" reversed>
            {[...view.revisions].reverse().map((r) => (
              <li key={r.rev} data-rev={r.rev}>
                <b>rev {r.rev}</b>
                {r.label === undefined ? null : ` (${r.label})`} — {r.note === '' ? <em>no note</em> : r.note}
                <span className="cs-small">
                  {' '}
                  · {day(r.savedAt)}
                  {r.savedBy === undefined ? '' : ` · ${r.savedBy}`}
                  {r.partNumber === undefined ? '' : ` · ${r.partNumber}`}
                  {r.hasArt ? ' · art' : ''}
                  {r.model === undefined ? '' : ' · 3D'}
                </span>
                {usesOf(r.rev).length === 0 ? null : (
                  <div className="cs-small">
                    Used by:{' '}
                    {usesOf(r.rev)
                      .map((u) => `${u.label}${u.version === undefined ? ' (working copy)' : ` rev ${u.version}${u.released ? ', released' : ''}`}`)
                      .join('; ')}
                  </div>
                )}
                {props.onCompare === undefined ? null : (
                  <button type="button" className="cs-quiet" onClick={() => props.onCompare?.(compareSideId({ kind, id, rev: r.rev }), now)}>
                    Compare with now
                  </button>
                )}
              </li>
            ))}
          </ol>
          {view.whereUsed.unrecorded.length === 0 ? null : (
            <p className="cs-small" data-testid="revisions-unrecorded">
              Using a state no revision recorded: {view.whereUsed.unrecorded.map((u) => `${u.label}${u.version === undefined ? '' : ` rev ${u.version}`}`).join('; ')}
            </p>
          )}
          {view.external.map((source) => (
            <div key={`${source.module}/${source.source}`} className="cs-small" data-source={`${source.module}/${source.source}`}>
              <b>{source.label}</b>
              {source.error === undefined ? null : <span className="cs-err"> — could not be read: {source.error}</span>}
              <ul>
                {source.revisions.map((r) => (
                  <li key={r.rev}>
                    <b>{r.label ?? r.rev}</b>
                    {r.label === undefined || r.label === r.rev ? '' : ` · ${r.rev}`}
                    {r.partNumber === undefined ? '' : ` · ${r.partNumber}`}
                    {r.savedAt === undefined ? null : <span className="cs-small"> · {day(r.savedAt)}</span>}
                    {r.note === undefined || r.note === '' ? null : <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.note}</p>}
                    <details>
                      <summary>Source</summary>
                      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.src}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {props.readOnly ? null : saving === undefined ? (
            <button type="button" className="cs-quiet" onClick={startSave}>
              Save a revision…
            </button>
          ) : (
            <div className="cs-revision-save">
              <label className="cs-field is-wide">
                <span>Note</span>
                <textarea className="cs-textarea" rows={2} aria-label="Revision note" disabled={busy} value={saving.note} onChange={(e) => setSaving({ ...saving, note: e.target.value })} />
              </label>
              <label className="cs-field">
                <span>Name (optional)</span>
                <input className="cs-input" aria-label="Revision name" disabled={busy} value={saving.label} placeholder="Rev B" onChange={(e) => setSaving({ ...saving, label: e.target.value })} />
              </label>
              <label className="cs-small">
                <input type="checkbox" disabled={busy} checked={saving.renumber} onChange={(e) => void toggleRenumber(e.target.checked)} /> give it the next variant number
                {saving.renumber && saving.next !== undefined ? ` (${saving.next})` : ''}
              </label>
              {numberPending ? <p role="status">Checking the next variant number…</p> : null}
              <div className="cs-modal-actions">
                <button type="button" className="cs-quiet" disabled={busy} onClick={cancelSave}>
                  Cancel
                </button>
                <button type="button" className="cs-primary" disabled={busy || numberPending} onClick={() => void save()}>
                  {busy ? 'Saving revision…' : 'Save revision'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
