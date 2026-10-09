/**
 * One Library kind as a `DataTable`: PN · Name · the kind's key columns · Used · Status · Flags —
 * sortable headers, filter chips for the facet columns, and a column menu remembered per viewer.
 * Below 640px each row is a card: PN and name first, the rest as a facts line.
 *
 * Everything it computes is `library-table.ts`; this file only wires it to the table.
 * `compact` (a record is open beside it) keeps PN and Name only.
 */

import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';

import { classes } from '../context.ts';
import type { LibraryKind } from '../definitions.ts';
import {
  facetOptions,
  filterRows,
  sortRows,
  type LibraryColumn,
  type LibraryRow,
  type LibrarySort,
} from '../library-table.ts';
import { Button } from '../ui/Button.tsx';
import { Checkbox } from '../ui/Controls.tsx';
import { DataTable, type DataColumn, type DataSort } from '../ui/DataTable.tsx';
import { FilterChip } from '../ui/FilterChip.tsx';
import { Toolbar } from '../ui/Page.tsx';

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
  empty: ReactNode;
  /** rows shown / total, reported up for the count */
  onCount?: (shown: number, total: number) => void;
  /** the host's own tools at the start of the filter bar (search, New …) */
  lead?: ReactNode;
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
  // a new kind: no sort or filter carried over (the table below is keyed by kind, so its columns reset too)
  useEffect(() => {
    setSort(undefined);
    setFacets({});
  }, [kind]);

  const facetColumns = columns.filter((c) => c.facet === true);
  const shownRows = useMemo(() => sortRows(filterRows(rows, query, facets), sort), [rows, query, facets, sort]);
  const onCount = props.onCount;
  useEffect(() => onCount?.(shownRows.length, rows.length), [onCount, shownRows.length, rows.length]);
  const anyFacet = Object.values(facets).some((v) => v.length > 0);

  const pick = props.pick;
  const marker = props.rowMarker;
  const tableColumns = useMemo((): DataColumn<LibraryRow>[] => {
    const own: DataColumn<LibraryRow>[] = columns.map((column) => ({
      id: column.id,
      header: column.header,
      ...(column.title === undefined ? {} : { title: column.title }),
      width: column.width,
      ...(column.fixed === true ? { fixed: true } : {}),
      ...(column.hiddenByDefault === true ? { defaultHidden: true } : {}),
      ...(column.numeric === true ? { numeric: true } : {}),
      ...(column.mono === true ? { mono: true } : {}),
      cell: (row) => <Cell row={row} column={column} marker={marker?.(row.id)} />,
    }));
    if (pick === undefined) return own;
    return [
      {
        id: 'pick',
        header: 'Pick for compare',
        hideHeader: true,
        fixed: true,
        width: 28,
        cell: (row) => <Checkbox aria-label={`compare ${row.label}`} checked={pick.ids.includes(row.id)} onCheckedChange={() => pick.toggle(row.id)} />,
      },
      ...own,
    ];
  }, [columns, pick, marker]);

  const dataSort: DataSort | undefined = sort === undefined ? undefined : { id: sort.column, dir: sort.dir };
  const facetChips = facetColumns.map((column) => {
    const options = facetOptions(rows, column.id);
    if (options.length < 2 && (facets[column.id] ?? []).length === 0) return null;
    return (
      <FilterChip
        key={column.id}
        group={{ label: column.header, options, selected: facets[column.id] ?? [], onChange: (next) => setFacets((current) => ({ ...current, [column.id]: next })) }}
      />
    );
  });

  return (
    <div className={classes('cs-lt', props.compact === true && 'is-compact')}>
      {props.compact === true ? null : (
        <Toolbar label="filters">
          {props.lead}
          {facetChips}
          {anyFacet ? (
            <Button variant="ghost" size="xs" onClick={() => setFacets({})}>
              Reset
            </Button>
          ) : null}
        </Toolbar>
      )}
      <DataTable
        key={kind}
        label={`${kind} table`}
        rows={shownRows}
        columns={tableColumns}
        getRowId={(row) => row.id}
        selectedId={props.selectedId}
        onSelect={(row) => props.onSelect(row.id)}
        sort={dataSort}
        manualSort
        onSortChange={(next) => setSort(next === undefined ? undefined : { column: next.id, dir: next.dir })}
        columnsKey={`library-${kind}`}
        compact={props.compact === true}
        rowAttrs={(row) => ({ 'data-id': row.id })}
        rowClassName={(row) => classes(row.readOnly && 'is-readonly', row.old && 'is-muted')}
        empty={<div className="cs-lt-empty-note">{props.empty}</div>}
        card={(row) => (
          <div className="cs-lt-card">
            <span className="cs-lt-card-head">
              <span className="cs-lt-mono">{row.cells['pn']?.text || '—'}</span>
              <strong>{row.label}</strong>
            </span>
            <span className="cs-lt-card-facts">
              {columns
                .filter((c) => c.fixed !== true && c.id !== 'flags' && (row.cells[c.id]?.text ?? '') !== '')
                .map((c) => row.cells[c.id]?.text)
                .join(' · ')}
            </span>
          </div>
        )}
      />
    </div>
  );
}
