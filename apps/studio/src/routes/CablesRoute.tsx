/**
 * `/cables` — the design list: a `DataTable` (sticky header, sortable columns, a column menu,
 * focusable rows, virtualised) over `CableListEntry[]` (`../cable-list.ts`), a text filter,
 * multi-select filter chips (Source / Destination / Wire / Board / Status), the unsaved dot, and
 * `New design`. Selecting a row (click, or Enter on it) opens the 360 px `SidePanel` with the
 * design's facts and actions; Enter again, a double click or the design's name opens it.
 *
 * Filtering and sorting live in the URL (`CablesSearch`, `router.tsx`), so a shared link or a
 * reload reopens the same view — see `specs/ui-redesign.md` "Information architecture".
 *
 * **New design.** The wizard is hosted once at the shell (`shell/NewCableWizardHost.tsx`, driven
 * by `studio.newCableOpen`) so the palette's "New design" command can open it from any route; this
 * button just calls `studio.openNewCableWizard()`.
 */

import { useMemo, useState, type JSX } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { IconFilter, IconStack2 } from '@tabler/icons-react';
import { Button, Chip, DataTable, FilterChip, FilterMenu, Input, KeyValues, Page, PageBody, Popover, SidePanel, Toolbar, type DataColumn, type FilterGroup } from '@wirehub/editor-react';
import { DESIGN_STATUSES } from '@wirehub/model';

import type { CableListEntry } from '../cable-list.ts';
import { offlineCopyFrom } from '../catalog.browser.ts';
import { useIsNarrow } from '../hooks/useIsNarrow.ts';
import { entryMatches } from '../pn-search.ts';
import { cableListKey, loadCableList } from '../queries.ts';
import { cablesRoute, type CableListSort, type CablesSearch } from '../router.tsx';
import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
import { NewHubStrip } from '../shell/NewHubStrip.tsx';
import { StatusChip } from '../shell/StatusChip.tsx';
import { RouteChip } from '../shell/RouteChip.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { RevChip } from '../versions/RevChip.tsx';
import { useStudio } from '../studio-context.tsx';
import { LockMarker } from '../locks/LockMarker.tsx';
import { designRecord } from '../locks/records.ts';

/** portrait phone widths: the row becomes a stacked card — title line, destination line, a small facts line */
const MOBILE_ROW_HEIGHT = 92;
const DESKTOP_ROW_HEIGHT = 30;

/** The chip/filter value of one trunk stock; a construction tag disambiguates, never the manufacturer. */
export function wireText(wire: CableListEntry['wires'][number]): string {
  return wire.name;
}

/** The trunk stock(s): the short name, construction-tagged where the family has more than one — never the manufacturer. */
function WireCell({ entry, className = '' }: { entry: CableListEntry; className?: string }): JSX.Element {
  const wires = entry.wires ?? [];
  if (wires.length === 0) return <span className={`text-faint ${className}`}>—</span>;
  return (
    <span className={`flex min-w-0 items-baseline gap-1 truncate ${className}`} title={wires.map((w) => w.title).join('\n')}>
      {wires.map((w, i) => (
        <span key={i} className="truncate">
          {i > 0 ? ' + ' : ''}
          {w.name}
        </span>
      ))}
    </span>
  );
}

/** Status, revision and the derived feature chips (`+ Breakout`, `+ 2 legs`). */
function NotesCell({ entry }: { entry: CableListEntry }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      <StatusChip status={entry.status} />
      <RouteChip route={entry.route} maker={entry.maker} />
      <RevChip rev={entry.rev} unreleased={entry.unreleased} />
      {(entry.features ?? []).map((f) => (
        <Chip key={f.text} title={f.title} className="shrink-0 whitespace-nowrap">
          {f.text}
        </Chip>
      ))}
    </span>
  );
}

function destinationText(entry: CableListEntry): string {
  return entry.destinationShort || entry.destinationMain;
}

function MobileRow({ entry, dirty }: { entry: CableListEntry; dirty: boolean }): JSX.Element {
  // retired designs read as muted everywhere they're shown, not just their
  // badge — they only appear at all once the Status filter asks for them
  const retired = entry.status === 'retired';
  return (
    <div className={`flex h-full min-w-0 flex-col justify-center gap-1 border-b border-line px-3 py-2 ${retired ? 'opacity-60' : ''}`}>
      <span className="flex min-w-0 items-start gap-1.5">
        <LockMarker record={designRecord(entry.id)} />
        {dirty ? (
          <span title="Unsaved changes" aria-label="Unsaved changes" className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
        ) : null}
        <span className="line-clamp-2 min-w-0 text-sm font-medium text-ink" title={`${entry.label}\n${entry.id}`}>
          {entry.label}
        </span>
        <span className="ml-auto shrink-0">
          <NotesCell entry={{ ...entry, features: [] }} />
        </span>
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-dim">
        <span className="shrink-0 text-faint">→</span>
        <span className="truncate" title={entry.destination}>
          {destinationText(entry) === '' ? '—' : destinationText(entry)}
        </span>
        <WireCell entry={entry} className="ml-auto shrink-0 text-xs" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-faint">
        {/* the design's own product PN — a small mono line, `—` when the design has none yet */}
        {(() => {
          const { text, tone, title } = partNumberDisplay(entry.partNumber);
          return (
            <span className="flex shrink-0 items-center gap-1">
              <span className={`text-2xs ${tone}`} title={title}>
                {text}
              </span>
            </span>
          );
        })()}
        <span className="min-w-0 truncate" title={(entry.products ?? []).map((p) => `${p.productLabel} · ${p.variantLabel}`).join('; ')} aria-label={(entry.products ?? []).length === 0 ? undefined : `Product: ${(entry.products ?? []).map((p) => `${p.productLabel} · ${p.variantLabel}`).join('; ')}`}>
          {(entry.products ?? []).map((p) => `${p.productLabel} · ${p.variantLabel}`).join('; ')}
        </span>
        {(entry.features ?? []).map((f) => (
          <span key={f.text} title={f.title} className="shrink-0 whitespace-nowrap text-dim">
            {f.text}
          </span>
        ))}
        <span className="ml-auto min-w-0 truncate font-mono text-2xs">{entry.boardLabels.join(' · ') || entry.id}</span>
      </span>
    </div>
  );
}

/**
 * "Place in…": start from a lead and put it into a harness as a sub-assembly.
 * A popover of the other designs; choosing one opens it with `place=<lead>`,
 * which the workspace turns into the sub-assembly (`CableRoute.tsx`).
 */
function PlaceInMenu({ entry, targets }: { entry: CableListEntry; targets: readonly CableListEntry[] }): JSX.Element {
  const navigate = useNavigate();
  const [needle, setNeedle] = useState('');
  const shown = targets.filter((t) => t.id !== entry.id && t.status !== 'retired' && entryMatches(t, needle)).slice(0, 40);
  return (
    <Popover
      align="start"
      aria-label="Designs to place it in"
      onOpenChange={(open) => (open ? undefined : setNeedle(''))}
      trigger={
        <Button title={`Place ${entry.id} in another design as a sub-assembly`} aria-label={`Place ${entry.id} in…`} icon={<IconStack2 size={14} aria-hidden />}>
          Place in…
        </Button>
      }
    >
      <div className="flex w-72 flex-col gap-1">
        <Input autoFocus aria-label="Find a design to place it in" placeholder="find a design…" value={needle} onChange={(event) => setNeedle(event.target.value)} />
        <div role="group" aria-label="designs to place it in" className="flex max-h-60 min-h-0 flex-col overflow-auto">
          {shown.length === 0 ? <p className="px-2 py-1 text-faint">No designs match.</p> : null}
          {shown.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => void navigate({ to: '/cables/$id', params: { id: target.id }, search: { view: 'build', place: entry.id } })}
              className="flex w-full flex-col items-start rounded-sm border-0 bg-transparent px-2 py-1 text-left text-ink hover:bg-hover"
            >
              <span className="max-w-full truncate">{target.label}</span>
              <span className="font-mono text-2xs text-faint">{target.id}</span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}

function truncated(className: string, text: string, title?: string): JSX.Element {
  return (
    <span className={`block truncate ${className}`} title={title ?? (text === '' ? undefined : text)}>
      {text === '' ? '—' : text}
    </span>
  );
}

/**
 * The Part Number cell's text and its tone: a resolved PN reads as ink
 * (mono); a drawing's length family reads as ink too (one number per
 * length); nothing else is the plain "—".
 */
function partNumberDisplay(resolved: CableListEntry['partNumber']): { text: string; tone: string; title: string } {
  if (resolved.pn !== undefined) return { text: resolved.pn, tone: 'font-mono text-ink', title: resolved.note };
  // a length family: a real product, one number per length
  if (resolved.family !== undefined) return { text: resolved.family, tone: 'font-mono text-ink', title: resolved.note };
  return { text: '—', tone: 'font-mono text-faint', title: resolved.note };
}

const productText = (row: CableListEntry): string => (row.products ?? []).map((p) => `${p.productLabel} · ${p.variantLabel}`).join('; ');

function columnsFor(dirtyIds: readonly string[]): DataColumn<CableListEntry>[] {
  return [
    {
      id: 'mark',
      header: 'Lock and unsaved state',
      hideHeader: true,
      fixed: true,
      width: 36,
      cell: (e) => (
        <span className="flex items-center justify-center">
          <LockMarker record={designRecord(e.id)} compact />
          {dirtyIds.includes(e.id) ? <span title="Unsaved changes" aria-label="Unsaved changes" className="h-[7px] w-[7px] rounded-full bg-accent" /> : null}
        </span>
      ),
    },
    {
      id: 'partNumber',
      header: 'PN',
      width: 100,
      sortValue: (r) => partNumberDisplay(r.partNumber).text,
      cell: (r) => {
        const { text, tone, title } = partNumberDisplay(r.partNumber);
        return (
          <span data-testid="part-number" className={`block truncate text-2xs ${tone}`} title={title}>
            {text}
          </span>
        );
      },
    },
    { id: 'product', header: 'Product', width: 130, sortValue: productText, cell: (r) => truncated('text-2xs text-dim', productText(r)) },
    {
      id: 'source',
      header: 'Design',
      width: 260,
      fixed: true,
      sortValue: (r) => r.label,
      cell: (r) => (
        <Link to="/cables/$id" params={{ id: r.id }} className="line-clamp-2 min-w-0 whitespace-normal text-sm leading-[13px] font-medium text-ink no-underline hover:underline" title={`${r.label}\n${r.id}`}>
          {r.label}
        </Link>
      ),
    },
    { id: 'destination', header: 'Destination', width: 110, sortValue: destinationText, cell: (r) => truncated('text-sm text-dim', destinationText(r), r.destination) },
    { id: 'wire', header: 'Wire', width: 140, sortValue: (r) => (r.wires ?? []).map(wireText).join(' + '), cell: (r) => <WireCell entry={r} className="text-xs text-dim" /> },
    {
      id: 'notes',
      header: 'Notes',
      width: 170,
      sortValue: (r) => [r.status === 'active' ? '' : r.status, ...(r.features ?? []).map((f) => f.text)].join(' '),
      cell: (r) => <NotesCell entry={r} />,
    },
    {
      id: 'boards',
      header: 'Boards',
      width: 120,
      sortValue: (r) => r.boardLabels.join(' · '),
      cell: (r) => truncated('font-mono text-2xs text-dim', r.boardLabels.join(' · '), `${r.boardLabels.join(' · ') || 'No boards'}\n${r.partCount} parts · ${r.jointCount} joints`),
    },
  ];
}

function uniqSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((v) => v !== '').sort((a, b) => a.localeCompare(b));
}

/** Drops empty/undefined keys so the URL never grows a bare `?dest=` from a cleared chip. */
function cleanSearch(next: CablesSearch): CablesSearch {
  const out: CablesSearch = {};
  if (next.q !== undefined && next.q !== '') out.q = next.q;
  if (next.sort !== undefined) out.sort = next.sort;
  if (next.dir !== undefined) out.dir = next.dir;
  if (next.dest !== undefined && next.dest.length > 0) out.dest = next.dest;
  if (next.wire !== undefined && next.wire.length > 0) out.wire = next.wire;
  if (next.board !== undefined && next.board.length > 0) out.board = next.board;
  if (next.source !== undefined && next.source.length > 0) out.source = next.source;
  if (next.status !== undefined && next.status.length > 0) out.status = next.status;
  return out;
}

export function CablesRoute(): JSX.Element {
  const studio = useStudio();
  const navigate = useNavigate();
  const search = cablesRoute.useSearch();
  const [selected, setSelected] = useState<string>();

  // live from the workbench; the build-time copy only when it cannot be
  // reached, and then flagged (`offline`) under a read-only banner
  const listQuery = useQuery({
    queryKey: cableListKey,
    queryFn: loadCableList,
  });
  const listOffline = listQuery.data?.offline === true;
  const entries = useMemo(() => listQuery.data?.entries ?? [], [listQuery.data]);

  const setSearch = (patch: Partial<CablesSearch>): void => {
    void navigate({
      to: cablesRoute.id,
      search: (prev: CablesSearch) => cleanSearch({ ...prev, ...patch }),
    });
  };

  const destOptions = useMemo(() => uniqSorted(entries.map(destinationText)), [entries]);
  const wireOptions = useMemo(() => uniqSorted(entries.flatMap((e) => (e.wires ?? []).map(wireText))), [entries]);
  const boardOptions = useMemo(() => uniqSorted(entries.flatMap((e) => e.boardLabels)), [entries]);
  const sourceOptions = useMemo(() => uniqSorted(entries.map((e) => e.source)), [entries]);

  const dest = search.dest ?? [];
  const wire = search.wire ?? [];
  const board = search.board ?? [];
  const source = search.source ?? [];
  const status = search.status ?? [];
  const q = search.q ?? '';

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((entry) => {
      if (dest.length > 0 && !dest.includes(destinationText(entry))) return false;
      if (wire.length > 0 && !(entry.wires ?? []).some((w) => wire.includes(wireText(w)))) return false;
      if (board.length > 0 && !entry.boardLabels.some((b) => board.includes(b))) return false;
      if (source.length > 0 && !source.includes(entry.source)) return false;
      // retired designs stay out of the list unless the Status filter asks for them
      if (status.length > 0 ? !status.includes(entry.status) : entry.status === 'retired') return false;
      if (needle === '') return true;
      // label, id, wire, board — and every PN the cable answers to (drawing, lengths, parts)
      return entryMatches(entry, q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, q, dest.join('\u0000'), wire.join('\u0000'), board.join('\u0000'), source.join('\u0000'), status.join('\u0000')]);

  // retired designs are hidden by default — split the count instead of folding them into the denominator.
  const retiredCount = useMemo(() => entries.filter((e) => e.status === 'retired').length, [entries]);
  const nonRetiredTotal = entries.length - retiredCount;
  const countTotal = status.length > 0 ? entries.length : nonRetiredTotal;
  const countLabel = filtered.length === countTotal ? `${countTotal} designs` : `${filtered.length} of ${countTotal} designs`;
  const showRetiredHint = status.length === 0 && retiredCount > 0;

  const columns = useMemo(() => columnsFor(studio.dirtyIds), [studio.dirtyIds]);
  const narrow = useIsNarrow();
  // below ~1100px the filter chips no longer fit the toolbar's one row: one Filters popover instead
  const toolbarCollapsed = useIsNarrow('(max-width: 1099px)');
  const sort = search.sort === undefined ? undefined : { id: search.sort, dir: search.dir ?? 'asc' };

  const filterGroups: FilterGroup[] = [
    { label: 'Source end', options: sourceOptions, selected: source, onChange: (next) => setSearch({ source: next }) },
    { label: 'Destination end', options: destOptions, selected: dest, onChange: (next) => setSearch({ dest: next }) },
    { label: 'Wire', options: wireOptions, selected: wire, onChange: (next) => setSearch({ wire: next }) },
    { label: 'Board', options: boardOptions, selected: board, onChange: (next) => setSearch({ board: next }) },
    { label: 'Status', options: [...DESIGN_STATUSES], selected: status, onChange: (next) => setSearch({ status: next }) },
  ];

  const chosen = entries.find((e) => e.id === selected);
  const open = (id: string): void => void navigate({ to: '/cables/$id', params: { id }, search: { view: 'build' } });
  const products = chosen === undefined ? '' : productText(chosen);

  return (
    <Page testId="cables">
      <RouteHeader
        title="Designs"
        count={listQuery.data === undefined ? 'Loading…' : countLabel}
        primary={
          <Button variant="primary" onClick={studio.openNewCableWizard} title="New design — the guided wizard">
            New design
          </Button>
        }
      />
      <Toolbar
        label="Design filters"
        end={
          <span className="flex shrink-0 items-baseline gap-1 font-mono text-2xs text-faint">
            {listOffline ? (
              <span role="status" data-testid="offline-banner" className="text-warn">
                offline copy from {offlineCopyFrom()} — read only
              </span>
            ) : null}
            {showRetiredHint ? (
              <button
                type="button"
                onClick={() => setSearch({ status: [...new Set([...status, 'retired'])] })}
                title="Show retired designs too — turns on the Status filter's Retired option"
                className="border-0 bg-transparent p-0 font-mono text-2xs text-faint underline decoration-dotted hover:text-ink"
              >
                {retiredCount} retired
              </button>
            ) : null}
          </span>
        }
      >
        <div className="relative flex min-w-[140px] flex-1 items-center sm:max-w-[280px] sm:flex-none">
          <IconFilter size={14} className="pointer-events-none absolute left-2 text-faint" aria-hidden />
          <Input
            value={q}
            onChange={(event) => setSearch({ q: event.target.value })}
            placeholder="Filter designs"
            aria-label="Filter designs"
            title="Filter by part number, label, id, destination, wire, notes or board — across every row, not just what's shown"
            style={{ paddingLeft: 26 }} className="w-full"
          />
        </div>
        {toolbarCollapsed ? <FilterMenu groups={filterGroups} /> : filterGroups.map((group) => <FilterChip key={group.label} group={group} />)}
      </Toolbar>

      <NewHubStrip firstDesign={entries[0]?.id} onNewDesign={studio.openNewCableWizard} />

      <PageBody
        panel={
          chosen === undefined ? undefined : (
            <SidePanel
              title={chosen.label}
              subtitle={chosen.id}
              label="Design details"
              onClose={() => setSelected(undefined)}
              chips={
                <>
                  <StatusChip status={chosen.status} />
                  <RouteChip route={chosen.route} maker={chosen.maker} />
                  <RevChip rev={chosen.rev} unreleased={chosen.unreleased} />
                </>
              }
              footer={
                <>
                  <Button variant="primary" onClick={() => open(chosen.id)}>
                    Open
                  </Button>
                  {listOffline ? null : <PlaceInMenu entry={chosen} targets={entries} />}
                </>
              }
            >
              <KeyValues
                items={[
                  ['Part number', partNumberDisplay(chosen.partNumber).text],
                  ['Product', products === '' ? '—' : products],
                  ['Source end', chosen.source || '—'],
                  ['Destination', destinationText(chosen) || '—'],
                  ['Wire', (chosen.wires ?? []).map(wireText).join(' + ') || '—'],
                  ['Boards', chosen.boardLabels.join(' · ') || '—'],
                  ['Size', `${chosen.partCount} parts · ${chosen.jointCount} joints`],
                ]}
              />
            </SidePanel>
          )
        }
      >
        <DataTable
          loading={listQuery.data === undefined && !listQuery.isError}
          label="Designs"
          testId="cable-list"
          rows={filtered}
          columns={columns}
          getRowId={(e) => e.id}
          selectedId={selected}
          onSelect={(e) => setSelected(e.id)}
          onActivate={(e) => open(e.id)}
          sort={sort}
          onSortChange={(next) => setSearch(next === undefined ? { sort: undefined, dir: undefined } : { sort: next.id as CableListSort, dir: next.dir })}
          columnsKey="designs"
          virtualize
          rowHeight={narrow ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT}
          rowClassName={(e) => (e.status === 'retired' ? 'is-muted' : undefined)}
          rowTitle={(e) => e.id}
          card={(entry) => (
            <Link to="/cables/$id" params={{ id: entry.id }} className="block text-ink no-underline">
              <MobileRow entry={entry} dirty={studio.dirtyIds.includes(entry.id)} />
            </Link>
          )}
          empty={
            entries.length === 0 ? (
              <EmptyState
                topic="new-design"
                action={
                  <button type="button" className={EMPTY_PRIMARY} onClick={studio.openNewCableWizard}>
                    New design
                  </button>
                }
              >
                No designs yet.
              </EmptyState>
            ) : (
              <div className="px-4 py-6 text-sm text-faint">Nothing matches this filter.</div>
            )
          }
        />
      </PageBody>
    </Page>
  );
}
