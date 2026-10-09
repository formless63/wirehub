/**
 * `/history` — the hub's change history (cs-5k1.4): every change set (the
 * database backend) or commit (a git catalog), newest first, filtered by
 * person, date and kind. Selecting an entry opens what it changed, field by
 * field, beside the list; each record links to its page, where its own
 * History restores it.
 */

import { Button, DataTable, Field, Input, KeyValues, Page, PageBody, Select, SidePanel, Toolbar, type DataColumn } from '@wirehub/editor-react';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
import { InfoTip } from '../shell/InfoTip.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { fetchHubHistory, historyTime, type HubHistoryQuery } from '../history.browser.ts';
import { EntryDetail } from '../history/HistoryPanel.tsx';
import { HISTORY_KINDS, parseSubject, type HistoryCapabilities, type HistoryEntry, type HistoryKind } from '../history/types.ts';

const KIND_LABEL: Readonly<Record<HistoryKind, string>> = { design: 'Designs', library: 'Library', vocab: 'Lists', builds: 'Board builds', other: 'Other' };
const URL_KIND: Readonly<Record<string, string>> = { pcbas: 'boards', mechanicals: 'hardware' };
const ALL_KINDS = 'all';

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

const touched = (entry: HistoryEntry): string => entry.touches.map((t) => t.label).join(', ');

const COLUMNS: DataColumn<HistoryEntry>[] = [
  { id: 'when', header: 'When', width: 140, cell: (e) => <span title={e.at}>{historyTime(e.at)}</span>, sortValue: (e) => e.at },
  { id: 'who', header: 'Who', width: 120, cell: (e) => <span title={e.by.email === undefined ? e.by.name : `${e.by.name} <${e.by.email}>`}>{e.by.name}</span>, sortValue: (e) => e.by.name },
  { id: 'change', header: 'Change', width: 300, cell: (e) => <span title={e.body === undefined ? e.message : `${e.message}\n\n${e.body}`}>{e.message}</span>, sortValue: (e) => e.message },
  { id: 'touches', header: 'Touched', width: 220, cell: (e) => <span className="text-dim" title={touched(e)}>{touched(e)}{e.more === undefined ? '' : ` +${e.more} more`}</span> },
  { id: 'source', header: 'Source', width: 90, defaultHidden: true, cell: (e) => e.source, sortValue: (e) => e.source },
  { id: 'version', header: 'Version', width: 80, mono: true, cell: (e) => (e.version === undefined ? '' : `v${e.version}`) },
];

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
  const entry = useMemo(() => entries.find((e) => e.id === open), [entries, open]);
  const kindOptions = useMemo(() => [{ value: ALL_KINDS, label: 'Everything' }, ...HISTORY_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))], []);
  const filtered = Object.values(filters).some((v) => v !== undefined && v !== '');
  return (
    <Page testId="history">
      <RouteHeader
        title="History"
        count={loading && entries.length === 0 ? undefined : `${entries.length}${next === undefined ? '' : '+'} ${entries.length === 1 ? 'change' : 'changes'}`}
      />
      {capabilities === undefined || capabilities.backend === 'none' ? null : (
        <span data-testid="history-capabilities" data-backend={capabilities.backend} className="sr-only">
          <InfoTip topic="history" text={capabilities.note} />
        </span>
      )}
      <Toolbar label="History filters">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(undefined);
            setFilters({ ...draft });
          }}
        >
          <Input aria-label="Person" className="w-40" value={draft.person ?? ''} placeholder="Person: name or email" disabled={f?.person === false} onChange={(e) => setDraft({ ...draft, person: e.target.value })} data-testid="history-person" />
          <Input aria-label="From date" type="date" className="w-36" value={draft.from ?? ''} disabled={f?.date === false} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <Input aria-label="To date" type="date" className="w-36" value={draft.to ?? ''} disabled={f?.date === false} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <Select
            aria-label="Kind"
            className="w-36"
            value={draft.kind ?? ALL_KINDS}
            disabled={f?.kind === false}
            options={kindOptions}
            onValueChange={(value) => {
              const { kind: _drop, ...rest } = draft;
              setDraft(value === ALL_KINDS ? rest : { ...rest, kind: value as HistoryKind });
            }}
          />
          <Button type="submit" variant="primary">Filter</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft({});
              setFilters({});
            }}
          >
            Clear
          </Button>
        </form>
      </Toolbar>
      {capabilities?.backend === 'none' ? (
        <p className="m-0 px-4 py-2 text-xs text-faint" data-testid="history-capabilities" data-backend={capabilities.backend}>
          {capabilities.note}
        </p>
      ) : null}
      {error !== undefined ? <div role="alert" className="px-4 py-2 text-err">{error}</div> : null}
      <PageBody
        panel={
          entry === undefined ? undefined : (
            <SidePanel title={entry.message} subtitle={`${entry.by.name} · ${historyTime(entry.at)}`} onClose={() => setOpen(undefined)} label="Change details">
              <div className="flex flex-col gap-3">
                <KeyValues items={[['Who', entry.by.email === undefined ? entry.by.name : `${entry.by.name} <${entry.by.email}>`], ['When', entry.at], ['Source', entry.source], ...(entry.version === undefined ? [] : [['Version', `v${entry.version}`] as const])]} />
                <div className="flex flex-wrap gap-x-2 text-xs text-dim">
                  {entry.touches
                    .filter((t) => t.subject.startsWith('design:') || t.subject.startsWith('definition:'))
                    .filter((t, i, all) => all.findIndex((x) => x.subject === t.subject) === i)
                    .map((t) => (
                      <SubjectLink key={t.subject} subject={t.subject} label={t.label.replace(/ \(.*\)$/, '')} />
                    ))}
                </div>
                <EntryDetail id={entry.id} />
              </div>
            </SidePanel>
          )
        }
      >
        {capabilities?.backend === 'none' ? null : (
          <DataTable
            label="Changes"
            rows={entries}
            columns={COLUMNS}
            getRowId={(e) => e.id}
            selectedId={open}
            onSelect={(e) => setOpen(open === e.id ? undefined : e.id)}
            columnsKey="history"
            rowAttrs={(e) => ({ 'data-entry': e.id })}
            empty={
              loading ? (
                <div className="px-4 py-3 text-faint">Loading…</div>
              ) : error !== undefined ? null : filtered ? (
                <div className="px-4 py-3 text-faint">No changes match.</div>
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
            }
          />
        )}
        {next === undefined ? null : (
          <div className="p-3">
            <Button disabled={loading} onClick={() => void load(next)}>
              Older…
            </Button>
          </div>
        )}
      </PageBody>
    </Page>
  );
}
