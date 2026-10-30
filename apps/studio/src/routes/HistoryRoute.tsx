/**
 * `/history` — the hub's change history (cs-5k1.4): every change set (the
 * database backend) or commit (a git catalog), newest first, filtered by
 * person, date and kind. Selecting an entry opens what it changed, field by
 * field, beside the list; each record links to its page, where its own
 * History restores it. `?token=` narrows it to one agent checkpoint (an API
 * token's changes), which can be undone together (`CheckpointPanel`).
 */

import { Button, DataTable, Input, Page, PageBody, Select, SidePanel, Toolbar, type DataColumn } from '@wirehub/editor-react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
import { InfoTip } from '../shell/InfoTip.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { fetchCheckpoints, fetchHubHistory, historyTime, type HubHistoryQuery } from '../history.browser.ts';
import { CheckpointPanel } from '../history/CheckpointPanel.tsx';
import { EntryDetail } from '../history/HistoryPanel.tsx';
import { historyRaw, historySummary, historyTouchLabel, touchMeaning, type RecordNames } from '../history/labels.ts';
import { useRecordNames } from '../history/names.ts';
import { HISTORY_KINDS, parseSubject, type CheckpointSummary, type HistoryCapabilities, type HistoryEntry, type HistoryKind } from '../history/types.ts';

const KIND_LABEL: Readonly<Record<HistoryKind, string>> = { design: 'Designs', library: 'Library', vocab: 'Lists', builds: 'Board builds', other: 'Other' };
const URL_KIND: Readonly<Record<string, string>> = { pcbas: 'boards', mechanicals: 'hardware' };
const ALL_KINDS = 'all';
const ALL_TOKENS = 'all';

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

/** the records a change touched, readably: named records, then files counted, never a hash */
const touched = (entry: HistoryEntry, names: RecordNames): string => {
  const labels = [...new Set(entry.touches.filter((t) => { const m = touchMeaning(t); return m.hidden !== true && m.file !== true; }).map((t) => historyTouchLabel(t, names)))];
  const files = entry.touches.filter((t) => touchMeaning(t).file === true).length;
  return [...labels, ...(files === 0 ? [] : [`${files} ${files === 1 ? 'file' : 'files'}`])].join(', ');
};

const columnsOf = (names: RecordNames): DataColumn<HistoryEntry>[] => [
  { id: 'when', header: 'When', width: 140, cell: (e) => <span title={e.at}>{historyTime(e.at)}</span>, sortValue: (e) => e.at },
  { id: 'who', header: 'Who', width: 120, cell: (e) => <span title={e.by.email === undefined ? e.by.name : `${e.by.name} <${e.by.email}>`}>{e.by.name.replace(/ \(agent draft grant\)$/, '')}</span>, sortValue: (e) => e.by.name },
  { id: 'change', header: 'Change', width: 360, cell: (e) => <span title={historyRaw(e)}>{historySummary(e, names)}</span>, sortValue: (e) => historySummary(e, names) },
  { id: 'touches', header: 'Touched', width: 220, defaultHidden: true, cell: (e) => <span className="text-dim" title={touched(e, names)}>{touched(e, names)}{e.more === undefined ? '' : ` +${e.more} more`}</span> },
  { id: 'source', header: 'Source', width: 90, defaultHidden: true, cell: (e) => e.source, sortValue: (e) => e.source },
  { id: 'version', header: 'Version', width: 80, mono: true, defaultHidden: true, cell: (e) => (e.version === undefined ? '' : `v${e.version}`) },
];

export function HistoryRoute(): JSX.Element {
  const search = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const token = search.token;
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [filters, setFilters] = useState<HubHistoryQuery>({});
  const [people, setPeople] = useState<{ value: string; label: string }[]>([]);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [capabilities, setCapabilities] = useState<HistoryCapabilities>();
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string>();
  const names = useRecordNames();
  const columns = useMemo(() => columnsOf(names), [names]);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      const out = await fetchHubHistory({ ...filters, ...(token === undefined ? {} : { token }), ...(before === undefined ? {} : { before }) });
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
    [filters, token],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const loadCheckpoints = useCallback(async () => {
    const out = await fetchCheckpoints();
    setCheckpoints(out.ok ? out.value.checkpoints : []);
  }, []);
  useEffect(() => {
    void loadCheckpoints();
  }, [loadCheckpoints]);
  // everyone seen so far stays in the Who list while a filter narrows the entries
  useEffect(() => {
    setPeople((prev) => {
      const seen = new Map(prev.map((p) => [p.value, p]));
      for (const e of entries) if (e.via === undefined) seen.set(e.by.email ?? e.by.name, { value: e.by.email ?? e.by.name, label: e.by.name });
      return seen.size === prev.length ? prev : [...seen.values()].sort((x, y) => x.label.localeCompare(y.label));
    });
  }, [entries]);
  const whoOptions = useMemo(
    () => [
      { value: ALL_TOKENS, label: 'Everyone' },
      ...people.map((p) => ({ value: `person:${p.value}`, label: p.label })),
      // the token's own name (History's label is `Name via token <name> (…)`), and how many changes
      ...checkpoints.map((c) => ({ value: `token:${c.token}`, label: `Agent ${c.label.replace(/^.* via token /, '').replace(/ \(.*\)$/, '')} (${c.sets})` })),
      ...(token !== undefined && !checkpoints.some((c) => c.token === token) ? [{ value: `token:${token}`, label: 'Agent' }] : []),
      ...(filters.person !== undefined && !people.some((p) => p.value === filters.person) ? [{ value: `person:${filters.person}`, label: filters.person }] : []),
    ],
    [checkpoints, token, people, filters.person],
  );
  const who = token !== undefined ? `token:${token}` : filters.person !== undefined ? `person:${filters.person}` : ALL_TOKENS;
  const setFilter = (next: HubHistoryQuery): void => {
    setOpen(undefined);
    setFilters(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')) as HubHistoryQuery);
  };

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
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Who"
            className="w-52"
            value={who}
            disabled={f?.person === false && checkpoints.length === 0}
            options={whoOptions}
            onValueChange={(value) => {
              const { person: _drop, ...rest } = filters;
              if (value.startsWith('token:')) {
                setFilter(rest);
                void navigate({ to: '/history', search: { token: value.slice('token:'.length) } });
                return;
              }
              setFilter(value.startsWith('person:') ? { ...rest, person: value.slice('person:'.length) } : rest);
              if (token !== undefined) void navigate({ to: '/history', search: {} });
            }}
            data-testid="history-who"
          />
          <Input aria-label="From date" type="date" className="w-36" value={filters.from ?? ''} disabled={f?.date === false} onChange={(e) => setFilter({ ...filters, from: e.target.value })} />
          <Input aria-label="To date" type="date" className="w-36" value={filters.to ?? ''} disabled={f?.date === false} onChange={(e) => setFilter({ ...filters, to: e.target.value })} />
          <Select
            aria-label="Kind"
            className="w-36"
            value={filters.kind ?? ALL_KINDS}
            disabled={f?.kind === false}
            options={kindOptions}
            onValueChange={(value) => {
              const { kind: _drop, ...rest } = filters;
              setFilter(value === ALL_KINDS ? rest : { ...rest, kind: value as HistoryKind });
            }}
          />
          {filtered || token !== undefined ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFilter({});
                if (token !== undefined) void navigate({ to: '/history', search: {} });
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </Toolbar>
      {capabilities?.backend === 'none' ? (
        <p className="m-0 px-4 py-2 text-xs text-faint" data-testid="history-capabilities" data-backend={capabilities.backend}>
          {capabilities.note}
        </p>
      ) : null}
      {error !== undefined ? <div role="alert" className="px-4 py-2 text-err">{error}</div> : null}
      {token === undefined || capabilities?.checkpoints !== true ? null : (
        <CheckpointPanel
          key={token}
          token={token}
          onUndone={() => {
            void load();
            void loadCheckpoints();
          }}
        />
      )}
      <PageBody
        panel={
          entry === undefined ? undefined : (
            <SidePanel title={historySummary(entry, names)} subtitle={`${entry.by.name} · ${historyTime(entry.at)}${entry.version === undefined ? '' : ` · v${entry.version}`}`} onClose={() => setOpen(undefined)} label="Change details">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-x-2 text-xs text-dim">
                  {entry.touches
                    .filter((t) => t.subject.startsWith('design:') || t.subject.startsWith('definition:'))
                    .filter((t, i, all) => all.findIndex((x) => x.subject === t.subject) === i)
                    .map((t) => (
                      <SubjectLink key={t.subject} subject={t.subject} label={historyTouchLabel(t, names)} />
                    ))}
                </div>
                <EntryDetail id={entry.id} />
                <details className="text-xs text-dim" data-testid="history-raw">
                  <summary className="cursor-pointer text-faint">Raw</summary>
                  <pre className="m-0 mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-2xs">{historyRaw(entry)}{`\n\nby: ${entry.by.email === undefined ? entry.by.name : `${entry.by.name} <${entry.by.email}>`}\nsource: ${entry.source}\nat: ${entry.at}`}</pre>
                </details>
              </div>
            </SidePanel>
          )
        }
      >
        {capabilities?.backend === 'none' ? null : (
          <DataTable
            loading={loading && entries.length === 0}
            label="Changes"
            rows={entries}
            columns={columns}
            getRowId={(e) => e.id}
            selectedId={open}
            onSelect={(e) => setOpen(open === e.id ? undefined : e.id)}
            columnsKey="history"
            rowAttrs={(e) => ({ 'data-entry': e.id })}
            empty={
              error !== undefined ? null : filtered ? (
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
                  No changes yet.
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
