/**
 * The frame every Library record's page shares: a head
 * (PN, name, status chips, actions), then — below the Views panel the
 * Library mounts — a Properties grid in the table's own column order, Where
 * used, and the Source citation (collapsed). The same for a connector, a
 * board, a shell or a wire stock, so nothing has to be looked for twice.
 */

import type { JSX, ReactNode } from 'react';

import { classes } from '../context.ts';
import type { DefinitionUsage, LibraryKind } from '../definitions.ts';
import type { LibraryColumn, LibraryRow } from '../library-table.ts';

export interface RecordAction {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  primary?: boolean;
  onClick: () => void;
}

export function RecordHead(props: {
  row?: LibraryRow;
  title: string;
  noun: string;
  id?: string;
  chips?: ReactNode;
  actions: readonly RecordAction[];
  children?: ReactNode;
}): JSX.Element {
  const pn = props.row?.cells['pn'];
  return (
    <header className="cs-def-head cs-record-head">
      <div className="cs-def-head-title">
        {pn === undefined ? null : (
          <span className={classes('cs-record-pn', pn.faint === true && 'is-faint')} title={pn.title} data-testid="record-pn">
            {pn.text === '' ? '—' : pn.text}
          </span>
        )}
        <h2>{props.title}</h2>
        <span className="cs-chip">{props.noun}</span>
        {props.id === undefined ? null : <span className="cs-def-id">{props.id}</span>}
        {(props.row?.flags ?? []).map((flag) => (
          <span key={flag} className={classes('cs-lt-flag', `is-${flag.toLowerCase()}`)}>
            {flag}
          </span>
        ))}
        {props.chips}
        {props.actions.length === 0 ? null : (
          <span className="cs-record-actions">
            {props.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={classes('cs-small', action.primary === true && 'cs-primary')}
                disabled={action.disabled}
                {...(action.title === undefined ? {} : { title: action.title })}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </span>
        )}
      </div>
      {props.children}
    </header>
  );
}

/** The record's facts, in the table's column order — same order on every kind. */
export function PropertiesGrid(props: { row: LibraryRow; columns: readonly LibraryColumn[] }): JSX.Element {
  const shown = props.columns.filter((c) => c.id !== 'name' && c.id !== 'flags');
  return (
    <section className="cs-record-section" aria-label="properties">
      <dl className="cs-props-grid">
        {shown.map((column) => {
          const cell = props.row.cells[column.id];
          const text = cell?.text ?? '';
          return (
            <div key={column.id} className="cs-props-item">
              <dt title={column.title}>{column.header}</dt>
              <dd className={classes(column.mono === true && 'cs-mono', (cell?.faint === true || text === '') && 'is-faint')} title={cell?.title}>
                {text === '' ? '—' : text}
                {cell?.warning === undefined ? null : <span className="cs-lt-warn" title={cell.warning} />}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

const KIND_OF_REF: Record<string, LibraryKind | undefined> = {
  connectors: 'connectors',
  pcbas: 'pcbas',
  kits: 'kits',
  mechanicals: 'mechanicals',
  components: 'components',
  wires: 'wires',
};

/** Designs and definitions that use the record, each a link. */
export function WhereUsed(props: {
  usage: DefinitionUsage | undefined;
  onOpenDesign?: (id: string) => void;
  onOpenRecord?: (kind: LibraryKind, id: string) => void;
}): JSX.Element {
  const usage = props.usage;
  return (
    <section className="cs-record-section" aria-label="where used">
      <h3 className="cs-record-h">
        Where used <span className="cs-count">{usage === undefined ? '…' : usage.count}</span>
      </h3>
      {usage?.mounting === undefined || usage.mounting.straddle + usage.mounting.direct === 0 ? null : (
        <p className="cs-meta" data-testid="mounting-summary">
          Mounting: {[
            usage.mounting.straddle > 0 ? `straddle-mounted in ${usage.mounting.straddle}` : undefined,
            usage.mounting.direct > 0 ? `direct in ${usage.mounting.direct}` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(', ')}
        </p>
      )}
      {usage === undefined ? null : usage.count === 0 ? (
        <p className="cs-empty">Nothing uses it.</p>
      ) : (
        <ul className="cs-used-list">
          {usage.designs.map((design) => (
            <li key={`d:${design.id}`}>
              {props.onOpenDesign === undefined ? (
                <span>{design.label}</span>
              ) : (
                <button type="button" className="cs-link" onClick={() => props.onOpenDesign!(design.id)}>
                  {design.label}
                </button>
              )}
              <span className="cs-def-id">{design.id}</span>
            </li>
          ))}
          {usage.definitions.map((ref) => {
            const [refKind = '', refId = ''] = ref.split('/');
            const target = KIND_OF_REF[refKind];
            return (
              <li key={`r:${ref}`}>
                {target === undefined || props.onOpenRecord === undefined ? (
                  <span className="cs-mono">{ref}</span>
                ) : (
                  <button type="button" className="cs-link cs-mono" onClick={() => props.onOpenRecord!(target, refId)}>
                    {ref}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Where the record's values come from — collapsed; the catalog's `src`. */
export function SourceBlock({ src }: { src: string }): JSX.Element {
  return (
    <details className="cs-record-section cs-record-src">
      <summary>Reference</summary>
      <p>{src === '' ? '—' : src}</p>
    </details>
  );
}
