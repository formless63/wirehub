/**
 * One Library kind as a real table: PN · Name · the
 * kind's key columns · Used · Status · Flags — sortable headers, filter
 * chips for the facet columns, a column menu remembered per viewer, and the
 * cable list's look (30px rows, small caps header, mono PN). Below 640px each
 * row is a card: PN and name first, the rest as a facts line.
 *
 * Everything it computes is `library-table.ts`; this file only draws it.
 * `compact` (a record is open beside it) keeps PN and Name only.
 */

import { IconArrowDown, IconArrowUp, IconCheck, IconChevronDown, IconColumns3 } from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { useEffect, useMemo, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';

import { classes } from '../context.ts';
import type { LibraryKind } from '../definitions.ts';
import {
  facetOptions,
  filterRows,
  loadColumnPrefs,
  saveColumnPrefs,
  sortRows,
  toggleColumn,
  visibleColumns,
  type ColumnPrefs,
  type LibraryColumn,
  type LibraryRow,
  type LibrarySort,
} from '../library-table.ts';

export interface LibraryTableProps {
  kind: LibraryKind;
  rows: readonly LibraryRow[];
  columns: readonly LibraryColumn[];
  query: string;
  /** a record is open beside the table: PN and Name only */
  compact?: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  rowMarker?: (id: string) => ReactNode;
  /** the Compare pick-two mode: a checkbox per row */
  pick?: { ids: readonly string[]; toggle: (id: string) => void };
  /** what an empty table says */
  empty: string;
  /** rows shown / total, reported up for the count */
  onCount?: (shown: number, total: number) => void;
  /** the host's own tools at the start of the filter bar (search, New …) */
  lead?: ReactNode;
}

function FacetChip(props: { label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void }): JSX.Element {
  const active = props.selected.length > 0;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={classes('cs-lt-chip', active && 'is-active')} title={`Filter by ${props.label.toLowerCase()}`}>
          {props.label}
          {active ? <strong>{props.selected.length === 1 ? props.selected[0] : props.selected.length}</strong> : null}
          <IconChevronDown size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="cs-popover cs-lt-menu" align="start" sideOffset={4} aria-label={`${props.label} filter`}>
          {props.options.map((option) => {
            const on = props.selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={on}
                className="cs-lt-menu-row"
                onClick={() => props.onChange(on ? props.selected.filter((v) => v !== option) : [...props.selected, option])}
              >
                <span className="cs-lt-box">{on ? <IconCheck size={11} /> : null}</span>
                {option}
              </button>
            );
          })}
          {active ? (
            <button type="button" className="cs-lt-menu-row cs-lt-clear" onClick={() => props.onChange([])}>
              Clear
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ColumnMenu(props: { columns: readonly LibraryColumn[]; prefs: ColumnPrefs; onChange: (next: ColumnPrefs) => void }): JSX.Element {
  const shown = new Set(visibleColumns(props.columns, props.prefs).map((c) => c.id));
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="cs-icon-btn cs-lt-columns" aria-label="Columns" title="Show or hide columns — remembered in this browser">
          <IconColumns3 size={15} stroke={1.75} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="cs-popover cs-lt-menu" align="end" sideOffset={4} aria-label="columns">
          {props.columns
            .filter((c) => c.fixed !== true)
            .map((column) => (
              <button
                key={column.id}
                type="button"
                aria-pressed={shown.has(column.id)}
                className="cs-lt-menu-row"
                onClick={() => props.onChange(toggleColumn(props.prefs, column))}
              >
                <span className="cs-lt-box">{shown.has(column.id) ? <IconCheck size={11} /> : null}</span>
                {column.header}
              </button>
            ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Cell({ row, column, marker }: { row: LibraryRow; column: LibraryColumn; marker?: ReactNode }): JSX.Element {
  const cell = row.cells[column.id];
  if (column.id === 'flags') {
    return (
      <span className="cs-lt-flags">
        {row.flags.map((flag) => (
          <span key={flag} className={classes('cs-lt-flag', `is-${flag.toLowerCase()}`)} title={flag === 'Pack' && row.pack !== undefined ? `From pack ${row.pack.pack} ${row.pack.version} — read-only; fork to edit` : undefined}>
            {flag}
          </span>
        ))}
      </span>
    );
  }
  const value = cell?.text ?? '';
  return (
    <span className={classes('cs-lt-cell', cell?.faint === true && 'is-faint')} title={cell?.title ?? (value === '' ? undefined : value)}>
      {column.id === 'name' ? marker : null}
      <span className="cs-lt-text" data-testid={column.id === 'pn' ? 'part-number' : undefined}>
        {value === '' ? '—' : value}
      </span>
      {cell?.warning === undefined ? null : <span className="cs-lt-warn" aria-label="part number pending" title={cell.warning} />}
    </span>
  );
}

export function LibraryTable(props: LibraryTableProps): JSX.Element {
  const { kind, rows, columns, query } = props;
  const [sort, setSort] = useState<LibrarySort | undefined>(undefined);
  const [facets, setFacets] = useState<Record<string, string[]>>({});
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => loadColumnPrefs(kind));
  // a new kind: its own remembered columns, and no sort or filter carried over
  useEffect(() => {
    setPrefs(loadColumnPrefs(kind));
    setSort(undefined);
    setFacets({});
  }, [kind]);
  const changePrefs = (next: ColumnPrefs): void => {
    setPrefs(next);
    saveColumnPrefs(kind, next);
  };

  const shownColumns = useMemo(() => {
    const visible = visibleColumns(columns, prefs);
    return props.compact === true ? visible.filter((c) => c.fixed === true) : visible;
  }, [columns, prefs, props.compact]);
  const facetColumns = columns.filter((c) => c.facet === true);
  const shownRows = useMemo(() => sortRows(filterRows(rows, query, facets), sort), [rows, query, facets, sort]);
  const onCount = props.onCount;
  useEffect(() => onCount?.(shownRows.length, rows.length), [onCount, shownRows.length, rows.length]);

  const toggleSort = (column: string): void => {
    setSort((current) =>
      current?.column !== column ? { column, dir: 'asc' } : current.dir === 'asc' ? { column, dir: 'desc' } : undefined,
    );
  };
  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, id: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      props.onSelect(id);
    }
  };
  const minWidth = shownColumns.reduce((sum, c) => sum + c.width, 0) + (props.pick === undefined ? 0 : 28);
  const anyFacet = Object.values(facets).some((v) => v.length > 0);

  return (
    <div className={classes('cs-lt', props.compact === true && 'is-compact')}>
      {props.compact === true ? null : (
        <div className="cs-lt-bar" role="toolbar" aria-label="filters">
          {props.lead}
          {facetColumns.map((column) => {
            const options = facetOptions(rows, column.id);
            if (options.length < 2 && (facets[column.id] ?? []).length === 0) return null;
            return (
              <FacetChip
                key={column.id}
                label={column.header}
                options={options}
                selected={facets[column.id] ?? []}
                onChange={(next) => setFacets((current) => ({ ...current, [column.id]: next }))}
              />
            );
          })}
          {anyFacet ? (
            <button type="button" className="cs-lt-chip cs-lt-reset" onClick={() => setFacets({})}>
              Reset
            </button>
          ) : null}
          <ColumnMenu columns={columns} prefs={prefs} onChange={changePrefs} />
        </div>
      )}
      <div className="cs-lt-scroll cs-scroll">
        <table className="cs-lt-table" style={{ minWidth: props.compact === true ? undefined : `${minWidth}px` }} aria-label={`${kind} table`}>
          <colgroup>
            {props.pick === undefined ? null : <col style={{ width: '28px' }} />}
            {shownColumns.map((c) => (
              <col key={c.id} style={{ width: c.id === 'name' ? undefined : `${c.width}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {props.pick === undefined ? null : <th aria-label="pick" />}
              {shownColumns.map((column) => {
                const sorted = sort?.column === column.id ? sort.dir : undefined;
                return (
                  <th
                    key={column.id}
                    data-col={column.id}
                    className={classes(column.numeric === true && 'is-num')}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                  >
                    <button type="button" className="cs-lt-sort" title={column.title ?? `Sort by ${column.header.toLowerCase()}`} onClick={() => toggleSort(column.id)}>
                      {column.header}
                      {sorted === 'asc' ? <IconArrowUp size={11} /> : sorted === 'desc' ? <IconArrowDown size={11} /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shownRows.length === 0 ? (
              <tr className="cs-lt-empty">
                <td colSpan={shownColumns.length + (props.pick === undefined ? 0 : 1)}>{props.empty}</td>
              </tr>
            ) : null}
            {shownRows.map((row) => (
              <tr
                key={row.id}
                data-id={row.id}
                tabIndex={0}
                aria-selected={props.selectedId === row.id}
                className={classes(props.selectedId === row.id && 'is-active', row.readOnly && 'is-readonly', row.old && 'is-old')}
                onClick={() => props.onSelect(row.id)}
                onKeyDown={(event) => onKey(event, row.id)}
              >
                {props.pick === undefined ? null : (
                  <td className="cs-lt-pick" onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" aria-label={`compare ${row.label}`} checked={props.pick.ids.includes(row.id)} onChange={() => props.pick?.toggle(row.id)} />
                  </td>
                )}
                {shownColumns.map((column) => (
                  <td key={column.id} data-col={column.id} data-label={column.header} className={classes(column.mono === true && 'is-mono', column.numeric === true && 'is-num')}>
                    <Cell row={row} column={column} marker={props.rowMarker?.(row.id)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
