/**
 * `/history` — the hub's change history (cs-5k1.4): every change set (the
 * database backend) or commit (a git catalog), newest first, filtered by
 * person, date and kind. An entry opens to what it changed, field by field;
 * each record links to its page, where its own History restores it.
 */

import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type JSX } from 'react';

import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
import { fetchHubHistory, type HubHistoryQuery } from '../history.browser.ts';
import { EntryDetail, EntrySummary } from '../history/HistoryPanel.tsx';
import { HISTORY_KINDS, parseSubject, type HistoryCapabilities, type HistoryEntry, type HistoryKind } from '../history/types.ts';

const KIND_LABEL: Readonly<Record<HistoryKind, string>> = { design: 'Cables', library: 'Library', vocab: 'Lists', builds: 'Board builds', other: 'Other' };
const URL_KIND: Readonly<Record<string, string>> = { pcbas: 'boards', mechanicals: 'hardware' };
const INPUT = 'h-7 min-w-0 rounded-md border border-line2 bg-bg px-2 text-[12.5px] text-ink outline-none placeholder:text-faint focus:border-accent';

/** A link to the record a subject names, when it has a page. */
function SubjectLink(props: { subject: string; label: string }): JSX.Element {
  const subject = parseSubject(props.subject);
  if (subject?.type === 'design') {
    return (
      <Link to="/cables/$id" params={{ id: subject.id }} search={{ view: 'build' }} className="underline">
        {props.label}
      </Link>
    );
  }
  if (subject?.type === 'definition') {
    return (
      <Link to="/library/$kind/$id" params={{ kind: URL_KIND[subject.kind] ?? subject.kind, id: subject.id }} className="underline">
        {props.label}
      </Link>
    );
  }
  return <span>{props.label}</span>;
}

export function HistoryRoute(): JSX.Element {
  const [filters, setFilters] = useState<HubHistoryQuery>({});
  const [draft, setDraft] = useState<HubHistoryQuery>({});
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [capabilities, setCapabilities] = useState<HistoryCapabilities>();
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string>();

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      const out = await fetchHubHistory({ ...filters, ...(before === undefined ? {} : { before }) });
      setLoading(false);
      if (!out.ok) {
        setError(`${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}`);
        return;
      }
      setError(undefined);
      setCapabilities(out.value.capabilities);
      setEntries((prev) => (before === undefined ? out.value.entries : [...prev, ...out.value.entries]));
      setNext(out.value.next);
    },
    [filters],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const f = capabilities?.filters;
  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="history">
      <h1 className="mb-1 text-[14px] font-semibold">History</h1>
      {capabilities === undefined ? null : (
        <p className="mb-3 mt-0 max-w-3xl text-[11.5px] text-faint" data-testid="history-capabilities" data-backend={capabilities.backend}>
          {capabilities.note}
        </p>
      )}
      <form
        className="mb-3 flex max-w-4xl flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setOpen(undefined);
          setFilters({ ...draft });
        }}
      >
        <label className="flex flex-col gap-0.5 text-[11px] text-dim">
          Person
          <input className={INPUT} value={draft.person ?? ''} placeholder="name or email" disabled={f?.person === false} onChange={(e) => setDraft({ ...draft, person: e.target.value })} data-testid="history-person" />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-dim">
          From
          <input className={INPUT} type="date" value={draft.from ?? ''} disabled={f?.date === false} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-dim">
          To
          <input className={INPUT} type="date" value={draft.to ?? ''} disabled={f?.date === false} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-dim">
          Kind
          <select
            className={INPUT}
            value={draft.kind ?? ''}
            disabled={f?.kind === false}
            onChange={(e) => {
              const value = e.target.value;
              const { kind: _drop, ...rest } = draft;
              setDraft(value === '' ? rest : { ...rest, kind: value as HistoryKind });
            }}
            data-testid="history-kind"
          >
            <option value="">Everything</option>
            {HISTORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-7 rounded-md border border-line2 bg-raised px-2.5 text-[12px] text-ink hover:bg-hover">
          Filter
        </button>
        <button
          type="button"
          className="h-7 rounded-md border-0 bg-transparent px-1 text-[12px] text-dim underline"
          onClick={() => {
            setDraft({});
            setFilters({});
          }}
        >
          Clear
        </button>
      </form>
      {error !== undefined ? <div role="alert" className="text-err">{error}</div> : null}
      {!loading && error === undefined && entries.length === 0 && capabilities?.backend !== 'none' ? (
        Object.values(filters).some((v) => v !== undefined && v !== '') ? (
          <div className="text-faint">No changes match.</div>
        ) : (
          <EmptyState
            topic="history"
            action={
              <Link to="/cables" className={`${EMPTY_PRIMARY} inline-flex items-center`}>
                Open designs
              </Link>
            }
          >
            No changes yet. Saving a design or a part records it here.
          </EmptyState>
        )
      ) : null}
      <ol className="m-0 max-w-4xl list-none space-y-1 p-0">
        {entries.map((entry) => (
          <li key={entry.id} className={`rounded border px-2 py-1 ${open === entry.id ? 'border-accent' : 'border-line'} bg-bg`} data-entry={entry.id}>
            <button type="button" className="block w-full min-w-0 border-0 bg-transparent p-0 text-left" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? undefined : entry.id)}>
              <EntrySummary entry={entry} />
            </button>
            {open === entry.id ? (
              <div className="mt-1 space-y-1 border-t border-line pt-1">
                <div className="flex flex-wrap gap-x-2 text-[11.5px] text-dim">
                  {entry.touches
                    .filter((t) => t.subject.startsWith('design:') || t.subject.startsWith('definition:'))
                    .filter((t, i, all) => all.findIndex((x) => x.subject === t.subject) === i)
                    .map((t) => (
                      <SubjectLink key={t.subject} subject={t.subject} label={t.label.replace(/ \(.*\)$/, '')} />
                    ))}
                </div>
                <EntryDetail id={entry.id} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {next === undefined ? null : (
        <button type="button" className="mt-2 h-7 rounded-md border border-line2 bg-raised px-2.5 text-[12px] text-ink hover:bg-hover" disabled={loading} onClick={() => void load(next)}>
          Older…
        </button>
      )}
    </div>
  );
}
