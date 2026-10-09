/**
 * The one table: sticky header, sortable columns, a column menu, focusable rows and keyboard
 * navigation (Up/Down/Home/End move, Enter or Space selects, Enter on the selected row activates).
 * The row and column model is TanStack Table; selection is the host's (`selectedId`), and a
 * selection is what opens a `SidePanel`. Sorting is internal (by each column's `sortValue`) unless
 * the host passes `sort` + `onSortChange`, in which case the host sorts the rows it hands in.
 * Long lists virtualize with `virtualize` (fixed `rowHeight`).
 */

import { IconArrowDown, IconArrowUp, IconCheck, IconColumns3 } from '@tabler/icons-react';
import {
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';

import { IconButton } from './Button.tsx';
import { Skeleton } from './Feedback.tsx';
import { cx } from './cx.ts';
import { Popover } from './Overlays.tsx';
import { usePref } from './prefs.ts';

export interface DataColumn<T> {
  id: string;
  header: string;
  /** tooltip on the header (what the column is, how it sorts) */
  title?: string;
  cell: (row: T) => ReactNode;
  /** makes the column sortable (when the host does not sort for itself) */
  sortValue?: (row: T) => string | number | null | undefined;
  /** min width in px; the column also takes its share of the rest */
  width?: number;
  /** the header is read by screen readers but not shown (an actions or status column) */
  hideHeader?: boolean;
  /** a fixed column cannot be hidden from the column menu */
  fixed?: boolean;
  /** hidden until the column menu turns it on */
  defaultHidden?: boolean;
  numeric?: boolean;
  mono?: boolean;
}

export interface DataSort {
  id: string;
  dir: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  /** the table's accessible name */
  label: string;
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  getRowId: (row: T) => string;
  selectedId?: string | undefined;
  /** a row was selected (click, Enter or Space) */
  onSelect?: (row: T) => void;
  /** Enter on the selected row, or a double click: open the thing */
  onActivate?: (row: T) => void;
  /** controlled sort: the host sorts `rows`; the header only reports clicks */
  sort?: DataSort | undefined;
  onSortChange?: (sort: DataSort | undefined) => void;
  /** the host has already sorted `rows` (its own comparator); the table only shows the sort state */
  manualSort?: boolean;
  /** remember the visible columns in this browser under this key (`wirehub:cols:<key>`) */
  columnsKey?: string;
  /** show only the fixed columns (a detail pane is open beside the table) */
  compact?: boolean;
  /** the rows are on their way: skeleton rows with the table's own columns instead of an empty message, so nothing jumps when they arrive */
  loading?: boolean;
  /** what an empty table says */
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  /** extra attributes on each row, e.g. a test id */
  rowAttrs?: (row: T) => Record<string, string | undefined>;
  /** tooltip on the row */
  rowTitle?: (row: T) => string | undefined;
  /** fixed row height in px; needed by `virtualize` */
  rowHeight?: number;
  virtualize?: boolean;
  /** replaces the cells with one stacked card below 640 px (without one, the first column becomes the title and the others stack as label and value) */
  card?: (row: T) => ReactNode;
  /** hide the column-menu button */
  noColumnMenu?: boolean;
  className?: string;
  testId?: string;
}

const features = tableFeatures({ rowSortingFeature, columnVisibilityFeature, sortedRowModel: createSortedRowModel() });
type Features = typeof features;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function useNarrow(): boolean {
  const query = '(max-width: 639px)';
  const read = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const on = (): void => setNarrow(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return narrow;
}

function blank(node: ReactNode): boolean {
  return node === null || node === undefined || node === false || node === '';
}

/** the phone card when the host gave none: the first column is the title, the rest stack as label and value */
function AutoCard<T>({ row, columns }: { row: T; columns: readonly DataColumn<T>[] }): JSX.Element {
  const [first, ...rest] = columns;
  const fields = rest.map((c) => ({ c, node: c.cell(row) })).filter((f) => !blank(f.node));
  const actions = fields.filter((f) => f.c.header === '' || f.c.hideHeader === true);
  const data = fields.filter((f) => !(f.c.header === '' || f.c.hideHeader === true));
  return (
    <div className="cs-ui-dt-autocard">
      <div className="cs-ui-dt-autocard-title">{first === undefined ? null : first.cell(row)}</div>
      {data.length === 0 ? null : (
        <dl className="cs-ui-dt-autocard-fields">
          {data.map(({ c, node }) => (
            <div key={c.id} data-col={c.id}>
              <dt>{c.header}</dt>
              <dd className={cx(c.mono === true && 'is-mono')}>{node}</dd>
            </div>
          ))}
        </dl>
      )}
      {actions.length === 0 ? null : <div className="cs-ui-dt-autocard-actions">{actions.map(({ c, node }) => <span key={c.id}>{node}</span>)}</div>}
    </div>
  );
}

export function DataTable<T extends object>(props: DataTableProps<T>): JSX.Element {
  const { rows, columns, getRowId, selectedId, onSelect, onActivate, compact = false, rowHeight = 30 } = props;
  const controlled = props.onSortChange !== undefined;
  const manual = props.manualSort === true;
  const narrow = useNarrow();
  const useCard = narrow;

  const [innerSort, setInnerSort] = useState<SortingState>([]);
  const sorting: SortingState = controlled ? (props.sort === undefined ? [] : [{ id: props.sort.id, desc: props.sort.dir === 'desc' }]) : innerSort;
  const onSortingChange = (updater: Updater<SortingState>): void => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    if (!controlled) {
      setInnerSort(next);
      return;
    }
    const first = next[0];
    props.onSortChange?.(first === undefined ? undefined : { id: first.id, dir: first.desc ? 'desc' : 'asc' });
  };

  const defaultHidden = useMemo(() => columns.filter((c) => c.defaultHidden === true).map((c) => c.id), [columns]);
  // the person's column choice: kept with their other preferences (`prefs.ts`), so it follows the account
  const [hidden, setHidden] = usePref<string[]>(props.columnsKey === undefined ? undefined : `cols.${props.columnsKey}`, defaultHidden, isStrings);
  const visibility = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const c of columns) out[c.id] = compact ? c.fixed === true : c.fixed === true || !hidden.includes(c.id);
    return out;
  }, [columns, hidden, compact]);

  const defs = useMemo(
    (): ColumnDef<Features, T>[] =>
      columns.map((c) => ({
        id: c.id,
        header: c.header,
        accessorFn: (row: T) => c.sortValue?.(row) ?? '',
        enableSorting: c.sortValue !== undefined || (manual && controlled),
        enableHiding: c.fixed !== true,
      })) as ColumnDef<Features, T>[],
    [columns, controlled, manual],
  );

  const table = useTable({
    features,
    columns: defs,
    data: rows as T[],
    state: { sorting, columnVisibility: visibility },
    onSortingChange,
    manualSorting: manual,
    getRowId,
  });
  const modelRows = table.getRowModel().rows;
  const shown = columns.filter((c) => visibility[c.id] === true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const virtual = props.virtualize === true;
  const virtualizer = useVirtualizer({
    count: virtual ? modelRows.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => (useCard ? 92 : rowHeight),
    getItemKey: (i) => modelRows[i]?.id ?? i,
    overscan: 12,
  });
  useEffect(() => {
    if (virtual) virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCard, virtual]);
  const items = virtual ? virtualizer.getVirtualItems() : modelRows.map((_, index) => ({ index }));
  const padTop = virtual && items.length > 0 ? (virtualizer.getVirtualItems()[0]?.start ?? 0) : 0;
  const padBottom = virtual && items.length > 0 ? virtualizer.getTotalSize() - (virtualizer.getVirtualItems().at(-1)?.end ?? 0) : 0;

  // roving tabindex: the selected row, else the first, is the one tab stop
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const stopId = modelRows.some((r) => r.id === (focusId ?? selectedId)) ? (focusId ?? selectedId) : modelRows[0]?.id;

  const focusIndex = (index: number): void => {
    const target = modelRows[Math.max(0, Math.min(modelRows.length - 1, index))];
    if (target === undefined) return;
    setFocusId(target.id);
    if (virtual) virtualizer.scrollToIndex(Math.max(0, Math.min(modelRows.length - 1, index)));
    const find = (): HTMLElement | null => scrollRef.current?.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(target.id)}"]`) ?? null;
    const el = find();
    if (el !== null) el.focus();
    else requestAnimationFrame(() => find()?.focus());
  };

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: T, id: string): void => {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusIndex(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusIndex(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        event.preventDefault();
        focusIndex(modelRows.length - 1);
        break;
      case 'PageDown':
        event.preventDefault();
        focusIndex(index + 10);
        break;
      case 'PageUp':
        event.preventDefault();
        focusIndex(index - 10);
        break;
      case 'Enter':
        event.preventDefault();
        if (selectedId === id && onActivate !== undefined) onActivate(row);
        else (onSelect ?? onActivate)?.(row);
        break;
      case ' ':
        event.preventDefault();
        onSelect?.(row);
        break;
      default:
    }
  };

  const toggleColumn = (id: string): void => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
  };
  const hideable = columns.filter((c) => c.fixed !== true);
  const menu = props.noColumnMenu === true || compact || hideable.length === 0 ? null : (
    <Popover
      align="end"
      aria-label="Columns"
      trigger={<IconButton label="Columns" size="xs" icon={<IconColumns3 size={14} aria-hidden />} />}
    >
      <div role="group" aria-label="Show columns" className="cs-ui-dt-menu">
        {hideable.map((c) => {
          const on = visibility[c.id] === true;
          return (
            <button key={c.id} type="button" role="menuitemcheckbox" aria-checked={on} className="cs-ui-dt-menu-row" onClick={() => toggleColumn(c.id)}>
              <span className="cs-ui-dt-box">{on ? <IconCheck size={11} aria-hidden /> : null}</span>
              {c.header}
            </button>
          );
        })}
      </div>
    </Popover>
  );

  const minWidth = compact || useCard ? undefined : shown.reduce((sum, c) => sum + (c.width ?? 90), 0);
  const colCount = useCard ? 1 : shown.length;

  return (
    <div ref={setScroll} className={cx('cs-ui-dt', props.className)} data-testid={props.testId} data-compact={compact || undefined}>
      <table className="cs-ui-dt-table" aria-label={props.label} aria-busy={props.loading === true ? true : undefined} aria-rowcount={modelRows.length} style={minWidth === undefined ? undefined : { minWidth }}>
        {useCard ? null : (
          <>
            <colgroup>
              {shown.map((c) => (
                <col key={c.id} style={c.width === undefined ? undefined : { minWidth: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {shown.map((c, i) => {
                  const column = table.getColumn(c.id);
                  const sortable = column?.getCanSort() === true;
                  const state = column?.getIsSorted();
                  return (
                    <th
                      key={c.id}
                      scope="col"
                      data-col={c.id}
                      className={cx(c.numeric === true && 'is-num')}
                      aria-sort={state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : undefined}
                    >
                      <span className="cs-ui-dt-head">
                        {sortable ? (
                          <button type="button" className="cs-ui-dt-sort" title={c.title ?? `Sort by ${c.header.toLowerCase()}`} onClick={column?.getToggleSortingHandler()}>
                            {c.hideHeader === true ? <span className="cs-ui-sr">{c.header}</span> : c.header}
                            {state === 'asc' ? <IconArrowUp size={11} aria-hidden /> : state === 'desc' ? <IconArrowDown size={11} aria-hidden /> : null}
                          </button>
                        ) : (
                          <span title={c.title} className={c.hideHeader === true ? 'cs-ui-sr' : undefined}>{c.header}</span>
                        )}
                        {i === shown.length - 1 ? menu : null}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
          </>
        )}
        <tbody>
          {props.loading === true && modelRows.length === 0
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={`sk-${i}`} className="cs-ui-dt-row cs-ui-dt-skeleton" aria-hidden="true" data-skeleton-row>
                  {useCard ? (
                    <td className="cs-ui-dt-card"><Skeleton width="70%" /></td>
                  ) : (
                    shown.map((c, n) => (
                      <td key={c.id} data-col={c.id} className={cx(c.numeric === true && 'is-num')}>
                        <Skeleton width={`${[72, 56, 40, 64, 48][(i + n) % 5]}%`} />
                      </td>
                    ))
                  )}
                </tr>
              ))
            : null}
          {modelRows.length === 0 && props.loading !== true ? (
            <tr className="cs-ui-dt-empty">
              <td colSpan={Math.max(1, colCount)}>{props.empty ?? 'Nothing here yet.'}</td>
            </tr>
          ) : null}
          {padTop > 0 ? (
            <tr aria-hidden="true" style={{ height: padTop }}>
              <td colSpan={colCount} />
            </tr>
          ) : null}
          {items.map((item) => {
            const row = modelRows[item.index];
            if (row === undefined) return null;
            const original = row.original as T;
            const id = row.id;
            const selected = selectedId === id;
            return (
              <tr
                key={id}
                data-row-id={id}
                {...props.rowAttrs?.(original)}
                tabIndex={id === stopId ? 0 : -1}
                aria-selected={onSelect === undefined ? undefined : selected}
                aria-rowindex={item.index + 1}
                title={props.rowTitle?.(original)}
                style={virtual ? { height: useCard ? 92 : rowHeight } : undefined}
                className={cx('cs-ui-dt-row', selected && 'is-selected', props.rowClassName?.(original))}
                onClick={(event) => {
                  // a link or button inside the row does its own thing
                  if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label') !== null && event.target !== event.currentTarget) return;
                  setFocusId(id);
                  (onSelect ?? onActivate)?.(original);
                }}
                onDoubleClick={() => onActivate?.(original)}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setFocusId(id);
                }}
                onKeyDown={(event) => onRowKey(event, item.index, original, id)}
              >
                {useCard ? (
                  <td className="cs-ui-dt-card">{props.card === undefined ? <AutoCard row={original} columns={shown} /> : props.card(original)}</td>
                ) : (
                  shown.map((c) => (
                    <td key={c.id} data-col={c.id} className={cx(c.numeric === true && 'is-num', c.mono === true && 'is-mono')}>
                      {c.cell(original)}
                    </td>
                  ))
                )}
              </tr>
            );
          })}
          {padBottom > 0 ? (
            <tr aria-hidden="true" style={{ height: padBottom }}>
              <td colSpan={colCount} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
