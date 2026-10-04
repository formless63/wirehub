/**
 * `/cables` — the cable list: a virtualized TanStack Table over
 * `CableListEntry[]` (`../cable-list.ts`), a text filter, multi-select filter
 * chips (Source / Destination / Wire / Board / Status — a `development` or
 * `legacy` design also carries a `StatusChip` beside its source), sortable headers,
 * the unsaved dot, row click → `/cables/$id`, and `New cable`.
 *
 * Filtering and sorting live in the URL (`CablesSearch`, `router.tsx`), so a
 * shared link or a reload reopens the same view — see
 * `specs/ui-redesign.md` "Information architecture" → Cable list, and the
 * mockup `specs/mockups/ui-redesign/cables-quickopen-light.png` (its
 * generator, `mockup-gen.mjs`'s CABLES section, is the exact column/size
 * reference — 30px rows, 10px mono caps header, `22px … 60px` grid).
 *
 * **New cable.** `@wirehub/editor-react` already exports
 * `NewCableWizard` standalone (`DesignActions.tsx` opens the very same
 * component for the "New…" button inside an open cable) — the modal itself
 * is hosted once at the shell (`shell/NewCableWizardHost.tsx`, driven by
 * `studio.newCableOpen`) so the quick-open "New cable" command
 * can open it from any route; this button just calls
 * `studio.openNewCableWizard()`.
 *
 * Rows are TanStack Table cells (sorting, column model) rendered through
 * TanStack Virtual (`@tanstack/react-virtual`) at a fixed 30px row height —
 * so the list stays fast as it grows.
 */

import { useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Popover } from 'radix-ui';
import {
  IconArrowDown,
  IconArrowUp,
  IconBox,
  IconCheck,
  IconChevronDown,
  IconFilter,
  IconPlus,
} from '@tabler/icons-react';
import { DESIGN_STATUSES } from '@wirehub/model';

import type { CableListEntry } from '../cable-list.ts';
import { offlineCopyFrom } from '../catalog.browser.ts';
import { useIsNarrow } from '../hooks/useIsNarrow.ts';
import { entryMatches } from '../pn-search.ts';
import { cableListKey, loadCableList } from '../queries.ts';
import { cablesRoute, type CableListSort, type CablesSearch } from '../router.tsx';
import { StatusChip } from '../shell/StatusChip.tsx';
import { RevChip } from '../versions/RevChip.tsx';
import { useStudio } from '../studio-context.tsx';
import { LockMarker } from '../locks/LockMarker.tsx';
import { designRecord } from '../locks/records.ts';

/** portrait phone widths: the fixed 30px grid row
 * becomes a stacked card — title line, destination line, a small facts
 * line — so nothing overlaps at ~360-430px. Desktop is untouched. */
const MOBILE_ROW_HEIGHT = 72;
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
      <RevChip rev={entry.rev} unreleased={entry.unreleased} />
      {(entry.features ?? []).map((f) => (
        <span
          key={f.text}
          title={f.title}
          className="shrink-0 rounded-sm border border-line2 px-1 text-[11px] leading-[16px] whitespace-nowrap text-dim"
        >
          {f.text}
        </span>
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
      <span className="flex min-w-0 items-baseline gap-1.5">
        <LockMarker record={designRecord(entry.id)} />
        {dirty ? (
          <span title="Unsaved changes" aria-label="Unsaved changes" className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
        ) : null}
        <span className="truncate text-[13px] font-medium text-ink" title={`${entry.label}\n${entry.id}`}>
          {entry.source}
        </span>
        <span className="ml-auto shrink-0">
          <NotesCell entry={{ ...entry, features: [] }} />
        </span>
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 text-[12px] text-dim">
        <span className="shrink-0 text-faint">→</span>
        <span className="truncate" title={entry.destination}>
          {destinationText(entry) === '' ? '—' : destinationText(entry)}
        </span>
        <WireCell entry={entry} className="ml-auto shrink-0 text-[11.5px]" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
        {/* the design's own product PN — a small mono line, `—` when the design has none yet */}
        {(() => {
          const { text, tone, title } = partNumberDisplay(entry.partNumber);
          return (
            <span className="flex shrink-0 items-center gap-1">
              <span className={`text-[10.5px] ${tone}`} title={title}>
                {text}
              </span>
            </span>
          );
        })()}
        {(entry.features ?? []).map((f) => (
          <span key={f.text} title={f.title} className="shrink-0 whitespace-nowrap text-dim">
            {f.text}
          </span>
        ))}
        <span className="ml-auto min-w-0 truncate font-mono text-[10.5px]">{entry.boardLabels.join(' · ') || entry.id}</span>
      </span>
    </div>
  );
}

/**
 * dot · part number · source · destination · wire · notes · boards. Each
 * flexible column carries a floor — a real minimum, not `minmax(0, …)`,
 * which let a column shrink to illegibility without ever triggering the
 * horizontal scrollbar. `TABLE_MIN_PX` is these floors' sum plus the row's
 * gap/padding, and is the width below which the table region scrolls
 * horizontally instead of squeezing further (see the scroll wrapper below).
 */
// column 1, Part Number: a fixed 92px slot ahead of Source — a PN is a
// known, near-constant shape, so it never needs to flex.
const GRID_COLS =
  '22px 92px minmax(210px, 1.6fr) minmax(90px, 0.6fr) minmax(108px, 0.55fr) minmax(150px, 0.9fr) minmax(118px, 0.85fr)';
const ROW_GAP_PX = 8; // gap-2
const ROW_PAD_PX = 12; // px-3, each side
const TABLE_MIN_PX = 22 + 92 + 210 + 90 + 108 + 150 + 118 + ROW_GAP_PX * 6 + ROW_PAD_PX * 2;
const RIGHT_ALIGNED = new Set<string>();
const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });
const columnHelper = createColumnHelper<typeof features, CableListEntry>();

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

const columns = columnHelper.columns([
  columnHelper.accessor((row) => partNumberDisplay(row.partNumber).text, {
    id: 'partNumber',
    header: 'PN',
    cell: (ctx) => {
      const resolved = ctx.row.original.partNumber;
      const { text, tone, title } = partNumberDisplay(resolved);
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span data-testid="part-number" className={`block truncate text-[11px] ${tone}`} title={title}>
            {text}
          </span>
        </span>
      );
    },
  }),
  columnHelper.accessor('source', {
    id: 'source',
    header: 'SOURCE',
    cell: (ctx) => (
      <span className="flex min-w-0 items-start gap-1.5">
        {/* full label on hover (owner 2026-09-25): no aggressive one-line
            ellipsis — the source title gets the space it needs, up to two
            lines, before it ever truncates */}
        <span className="line-clamp-2 min-w-0 flex-1 leading-[13px] text-[12.5px] font-medium text-ink" title={ctx.row.original.label}>
          {ctx.getValue()}
        </span>
      </span>
    ),
  }),
  columnHelper.accessor(destinationText, {
    id: 'destination',
    header: 'DESTINATION',
    cell: (ctx) => truncated('text-[12.5px] text-dim', ctx.getValue(), ctx.row.original.destination),
  }),
  columnHelper.accessor((row) => (row.wires ?? []).map(wireText).join(' + '), {
    id: 'wire',
    header: 'WIRE',
    cell: (ctx) => <WireCell entry={ctx.row.original} className="text-[12px] text-dim" />,
  }),
  columnHelper.accessor((row) => [row.status === 'active' ? '' : row.status, ...(row.features ?? []).map((f) => f.text)].join(' '), {
    id: 'notes',
    header: 'NOTES',
    cell: (ctx) => <NotesCell entry={ctx.row.original} />,
  }),
  columnHelper.accessor((row) => row.boardLabels.join(' · '), {
    id: 'boards',
    header: 'BOARDS',
    cell: (ctx) =>
      truncated(
        'font-mono text-[11px] text-dim',
        ctx.getValue(),
        `${ctx.getValue() || 'No boards'}\n${ctx.row.original.partCount} parts · ${ctx.row.original.jointCount} joints`,
      ),
  }),
]);

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

/** A dashed/solid toggle button (mockup's `filterBtn`) opening a checklist popover — Source/Destination/Wire/Board/Status. */
interface FilterGroupProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** what an option reads as (ids → short names); the value itself otherwise */
  optionLabel?: (value: string) => string;
}

/** The checklist a filter's popover shows — shared by `FilterChip` and the collapsed `FiltersMenu` (below ~900px, 50a.45). */
function FilterOptionList(props: FilterGroupProps): JSX.Element {
  const show = props.optionLabel ?? ((value: string) => value);
  const toggle = (value: string): void => {
    props.onChange(
      props.selected.includes(value)
        ? props.selected.filter((v) => v !== value)
        : [...props.selected, value],
    );
  };
  if (props.options.length === 0) return <p className="px-2 py-2 text-faint">Nothing to filter by yet.</p>;
  return (
    <>
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => toggle(option)}
          aria-pressed={props.selected.includes(option)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ink hover:bg-hover"
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-line2 text-accent">
            {props.selected.includes(option) ? <IconCheck size={11} /> : null}
          </span>
          <span className="truncate" title={show(option) === option ? undefined : option}>
            {show(option)}
          </span>
        </button>
      ))}
    </>
  );
}

/** A dashed/solid toggle button (mockup's `filterBtn`) opening a checklist popover — Source/Destination/Wire/Board/Status. */
export function FilterChip(props: FilterGroupProps): JSX.Element {
  const show = props.optionLabel ?? ((value: string) => value);
  const active = props.selected.length > 0;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={`Filter by ${props.label.toLowerCase()}`}
          className={`flex h-[26px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] ${
            active
              ? 'border-accent bg-accent-soft text-ink'
              : 'border-dashed border-line2 bg-transparent text-dim'
          }`}
        >
          {props.label}
          {active ? (
            <span className="font-semibold">
              {props.selected.length === 1 ? show(props.selected[0] as string) : props.selected.length}
            </span>
          ) : null}
          <IconChevronDown size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-20 max-h-72 w-60 overflow-auto rounded-md border border-line2 bg-panel p-1 text-[12.5px] shadow-lg"
        >
          <FilterOptionList {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Below ~900px the filter chips no longer fit the toolbar's one row —
 * collapsed
 * into one "Filters" popover holding every group, each under its own
 * heading, sharing `FilterOptionList` with the full-width chips so the two
 * never drift apart. `useIsNarrow('(max-width: 1099px)')` picks which of the
 * two renders — a JS branch, not a CSS `hidden` pair, so the DOM (and its
 * accessible names) never holds both at once.
 */
function FiltersMenu({ groups }: { groups: FilterGroupProps[] }): JSX.Element {
  const activeCount = groups.reduce((n, g) => n + g.selected.length, 0);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Filters"
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] ${
            activeCount > 0 ? 'border-accent bg-accent-soft text-ink' : 'border-line2 bg-panel text-ink'
          }`}
        >
          <IconFilter size={14} />
          Filters
          {activeCount > 0 ? <span className="font-semibold">{activeCount}</span> : null}
          <IconChevronDown size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-20 flex max-h-[70vh] w-64 flex-col gap-2 overflow-auto rounded-md border border-line2 bg-panel p-2 text-[12.5px] shadow-lg"
        >
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-1 px-1 font-mono text-[10px] tracking-wide text-faint uppercase">{group.label}</p>
              <FilterOptionList {...group} />
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function CablesRoute(): JSX.Element {
  const studio = useStudio();
  const navigate = useNavigate();
  const search = cablesRoute.useSearch();

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

  // retired designs are hidden by default (the `status` check above) — split
  // the count instead of quietly folding them into the denominator.
  const retiredCount = useMemo(() => entries.filter((e) => e.status === 'retired').length, [entries]);
  const nonRetiredTotal = entries.length - retiredCount;
  // once the Status filter is itself in play, retired is no longer implicit —
  // count against the full catalog like every other filter combination does
  const countTotal = status.length > 0 ? entries.length : nonRetiredTotal;
  const countLabel = filtered.length === countTotal ? `${countTotal} cables` : `${filtered.length} of ${countTotal} cables`;
  const showRetiredHint = status.length === 0 && retiredCount > 0;

  const sorting: SortingState = search.sort === undefined ? [] : [{ id: search.sort, desc: search.dir === 'desc' }];
  const onSortingChange = (updater: Updater<SortingState>): void => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    const first = next[0];
    setSearch(
      first === undefined
        ? { sort: undefined, dir: undefined }
        : { sort: first.id as CableListSort, dir: first.desc ? 'desc' : 'asc' },
    );
  };

  const table = useTable({
    features,
    columns,
    data: filtered,
    state: { sorting },
    onSortingChange,
    getRowId: (row) => row.id,
  });
  const rows = table.getRowModel().rows;

  const narrow = useIsNarrow();
  const rowHeight = narrow ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT;
  // below ~900px the toolbar's own filter chips and action labels no longer
  // fit one row — collapse chips into one Filters popover and action buttons
  // to icon-only instead of losing them
  const toolbarCollapsed = useIsNarrow('(max-width: 1099px)');

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 12,
  });
  // a narrow/wide flip changes every row's height — react-virtual only
  // re-measures rows it re-renders, so tell it the estimate itself moved
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);

  /**
   * Horizontal overflow: the table region itself (`scrollEl`, header
   * and rows together — see the JSX below) is the scroll container, with a
   * real scrollbar; `scrollEdges` drives an inset shadow that reads like the
   * left rail's crisp edge, only shown on the side there is more to scroll
   * to (the static `border-r` marks the region's right edge unconditionally,
   * scrollable or not, matching the rail's own `border-r` on the left).
   */
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  useEffect(() => {
    if (scrollEl === null || narrow) {
      setScrollEdges({ left: false, right: false });
      return;
    }
    const update = (): void => {
      setScrollEdges({
        left: scrollEl.scrollLeft > 1,
        right: scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 1,
      });
    };
    update();
    scrollEl.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener('scroll', update);
      resizeObserver.disconnect();
    };
  }, [scrollEl, narrow, filtered.length]);
  const edgeShadow =
    [scrollEdges.left ? 'inset 10px 0 8px -8px rgba(0,0,0,0.28)' : '', scrollEdges.right ? 'inset -10px 0 8px -8px rgba(0,0,0,0.28)' : '']
      .filter((s) => s !== '')
      .join(', ') || undefined;

  // one array so the inline chips and the collapsed Filters popover (below
  // ~900px) read from exactly the same groups — Source first
  const filterGroups: FilterGroupProps[] = [
    { label: 'Source', options: sourceOptions, selected: source, onChange: (next) => setSearch({ source: next }) },
    { label: 'Destination', options: destOptions, selected: dest, onChange: (next) => setSearch({ dest: next }) },
    { label: 'Wire', options: wireOptions, selected: wire, onChange: (next) => setSearch({ wire: next }) },
    { label: 'Board', options: boardOptions, selected: board, onChange: (next) => setSearch({ board: next }) },
    { label: 'Status', options: [...DESIGN_STATUSES], selected: status, onChange: (next) => setSearch({ status: next }) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        Every control here stays reachable at every width down to a phone.
        No fixed height (a `flex-wrap` row inside one
        used to overflow it, hiding whatever wrapped) and nothing is
        `hidden` outright — below ~900px the filter chips fold into one
        Filters popover (`toolbarCollapsed`, `FiltersMenu`) and the action
        buttons drop their text label (icon + `aria-label`/`title` only),
        rather than losing either.
      */}
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <div className="flex h-7 min-w-[140px] flex-1 items-center gap-2 rounded-md border border-line2 bg-bg px-2.5 sm:max-w-[280px] sm:flex-none">
          <IconFilter size={14} className="shrink-0 text-faint" />
          <input
            value={q}
            onChange={(event) => setSearch({ q: event.target.value })}
            placeholder="Filter cables"
            aria-label="Filter cables"
            title="Filter by part number, label, id, destination, wire, notes or board — across every row, not just what's shown"
            className="w-full border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
          />
        </div>
        {toolbarCollapsed ? (
          <FiltersMenu groups={filterGroups} />
        ) : (
          filterGroups.map((group) => <FilterChip key={group.label} {...group} />)
        )}
        <span className="grow" />
        <span className="flex shrink-0 items-baseline gap-1 font-mono text-[11px] text-faint">
          {listOffline ? (
            <span role="status" data-testid="offline-banner" className="text-warn">
              offline copy from {offlineCopyFrom()} — read only ·
            </span>
          ) : null}
          <span>{listQuery.data === undefined ? 'Loading…' : countLabel}</span>
          {showRetiredHint ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => setSearch({ status: [...new Set([...status, 'retired'])] })}
                title="Show retired designs too — turns on the Status filter's Retired option"
                className="border-0 bg-transparent p-0 font-mono text-[11px] text-faint underline decoration-dotted hover:text-ink"
              >
                {retiredCount} retired
              </button>
            </>
          ) : null}
        </span>
        <Link
          to="/library"
          title="Library"
          aria-label="Library"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line2 bg-panel px-2.5 text-[12.5px] text-ink no-underline"
        >
          <IconBox size={14} />
          <span className="max-[1099px]:hidden">Library</span>
        </Link>
        <button
          type="button"
          onClick={studio.openNewCableWizard}
          title="New cable — the guided wizard"
          aria-label="New cable"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-accent px-2.5 text-[12.5px] font-semibold text-accent-ink"
        >
          <IconPlus size={14} />
          <span className="max-[1099px]:hidden">New cable</span>
        </button>
      </div>

      {/*
        The table region: header and rows share one scroll container so a
        horizontal scrollbar carries both together (the header stays put only
        vertically, via `sticky`) — see the `scrollEdges` effect above. The
        inner wrapper's `minWidth` (skipped on the phone card layout) is what
        makes the columns hold their floor instead of squeezing forever, so
        overflow — and the scrollbar it needs — actually happens.
      */}
      <div
        ref={setScrollEl}
        style={{ boxShadow: edgeShadow }}
        className={`min-h-0 flex-1 overflow-auto ${narrow ? '' : 'border-r border-line'}`}
      >
        <div style={narrow ? undefined : { minWidth: TABLE_MIN_PX }}>
          <div
            role="row"
            style={{ gridTemplateColumns: GRID_COLS }}
            className="sticky top-0 z-10 grid h-7 shrink-0 items-center gap-2 border-b border-line bg-raised px-3 font-mono text-[10px] tracking-wide text-faint uppercase max-sm:hidden"
          >
            <span />
            {table.getHeaderGroups()[0]?.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              return (
                <button
                  key={header.id}
                  type="button"
                  onClick={header.column.getToggleSortingHandler()}
                  title={`Sort by ${String(header.column.columnDef.header)}`}
                  className={`flex items-center gap-1 border-0 bg-transparent p-0 font-mono text-[10px] tracking-wide uppercase hover:text-ink ${
                    sorted ? 'text-ink' : 'text-faint'
                  } ${RIGHT_ALIGNED.has(header.column.id) ? 'justify-end' : 'justify-start'}`}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {sorted === 'asc' ? <IconArrowUp size={11} /> : sorted === 'desc' ? <IconArrowDown size={11} /> : null}
                </button>
              );
            })}
          </div>

          {rows.length === 0 ? (
            <p className="px-4 py-6 text-[12.5px] text-faint">
              {entries.length === 0 ? 'No cables yet.' : 'Nothing matches this filter.'}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (row === undefined) return null;
                const entry = row.original;
                const dirty = studio.dirtyIds.includes(entry.id);
                const style = {
                  position: 'absolute' as const,
                  top: 0,
                  left: 0,
                  right: 0,
                  height: rowHeight,
                  transform: `translateY(${item.start}px)`,
                };
                if (narrow) {
                  return (
                    <Link
                      key={row.id}
                      to="/cables/$id"
                      params={{ id: entry.id }}
                      style={style}
                      className="block text-ink no-underline hover:bg-hover"
                    >
                      <MobileRow entry={entry} dirty={dirty} />
                    </Link>
                  );
                }
                return (
                  <Link
                    key={row.id}
                    to="/cables/$id"
                    params={{ id: entry.id }}
                    style={{ ...style, gridTemplateColumns: GRID_COLS }}
                    title={entry.id}
                    className={`group grid items-center gap-2 overflow-hidden border-b border-line px-3 text-ink no-underline hover:bg-hover ${
                      entry.status === 'retired' ? 'opacity-60' : ''
                    }`}
                  >
                    <span className="flex items-center justify-center">
                      <LockMarker record={designRecord(entry.id)} compact />
                      {dirty ? (
                        <span title="Unsaved changes" aria-label="Unsaved changes" className="h-[7px] w-[7px] rounded-full bg-accent" />
                      ) : null}
                    </span>
                    {row.getAllCells().map((cell) => (
                      <span key={cell.id} className="min-w-0">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </span>
                    ))}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
