/**
 * The frame every Library record's page shares: a head
 * (PN, name, status chips, actions), then — below the Views panel the
 * Library mounts — a Properties grid in the table's own column order, Where
 * used, and the Source citation (collapsed). The same for a connector, a
 * board, a shell or a wire stock, so nothing has to be looked for twice.
 */

import { useState, type JSX, type ReactNode } from 'react';

import { classes } from '../context.ts';
import type { DefinitionUsage, LibraryKind } from '../definitions.ts';
import type { LibraryCell, LibraryColumn, LibraryRow } from '../library-table.ts';
import { Section } from '../ui/Section.tsx';

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
        <h2 {...(props.id === undefined ? {} : { title: props.id })}>{props.title}</h2>
        <span className="cs-chip">{props.noun}</span>
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

/**
 * The record's facts, in the table's column order — same order on every kind.
 * The name and PN are the head's; the id is the title's tooltip. `used`
 * overrides the Used cell with the where-used count, so the page shows one
 * number. `quiet`: no warnings the viewer cannot act on (a read-only record).
 */
export function PropertiesGrid(props: { row: LibraryRow; columns: readonly LibraryColumn[]; used?: number; quiet?: boolean }): JSX.Element {
  const shown = props.columns.filter((c) => c.id !== 'name' && c.id !== 'flags' && c.id !== 'pn' && c.id !== 'id');
  return (
    <section className="cs-record-section" aria-label="properties">
      <dl className="cs-props-grid">
        {shown.map((column) => {
          const cell: LibraryCell | undefined = column.id === 'used' && props.used !== undefined ? { text: String(props.used), faint: props.used === 0 } : props.row.cells[column.id];
          const text = cell?.text ?? '';
          const warning = props.quiet === true ? undefined : cell?.warning;
          return (
            <div key={column.id} className="cs-props-item">
              <dt title={column.title}>{column.header}</dt>
              <dd className={classes(column.mono === true && 'cs-mono', (cell?.faint === true || text === '') && 'is-faint')} title={cell?.title}>
                {text === '' ? '—' : text}
                {warning === undefined ? null : <span className="cs-lt-warn" title={warning} />}
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

/** what the host knows about a design beyond its label: its PN and saved revision */
export interface DesignFacts {
  pn?: string;
  rev?: string;
}

const WHERE_USED_FIRST = 10;

/** Designs and definitions that use the record: a compact table, the first ten, then Show all. */
export function WhereUsed(props: {
  usage: DefinitionUsage | undefined;
  onOpenDesign?: (id: string) => void;
  onOpenRecord?: (kind: LibraryKind, id: string) => void;
  /** a record ref (`pcbas/x`) → its name, PN and revision */
  recordFacts?: (kind: string, id: string) => { label: string; pn?: string; rev?: string } | undefined;
  designFacts?: (id: string) => DesignFacts | undefined;
}): JSX.Element {
  const usage = props.usage;
  const [all, setAll] = useState(false);
  const rows: { key: string; name: string; pn: string; rev: string; open?: () => void; title: string }[] = [];
  for (const design of usage?.designs ?? []) {
    const facts = props.designFacts?.(design.id);
    rows.push({
      key: `d:${design.id}`,
      name: design.label,
      pn: design.pn ?? facts?.pn ?? '',
      rev: design.rev ?? facts?.rev ?? '',
      title: design.id,
      ...(props.onOpenDesign === undefined ? {} : { open: () => props.onOpenDesign!(design.id) }),
    });
  }
  for (const ref of usage?.definitions ?? []) {
    const [refKind = '', refId = ''] = ref.split('/');
    const target = KIND_OF_REF[refKind];
    const facts = props.recordFacts?.(refKind, refId);
    rows.push({
      key: `r:${ref}`,
      name: facts?.label ?? refId,
      pn: facts?.pn ?? '',
      rev: facts?.rev ?? '',
      title: ref,
      ...(target === undefined || props.onOpenRecord === undefined ? {} : { open: () => props.onOpenRecord!(target, refId) }),
    });
  }
  const shown = all ? rows : rows.slice(0, WHERE_USED_FIRST);
  // a column of nothing but dashes says nothing: drop it
  const showRev = rows.some((row) => row.rev !== '');
  const mounting =
    usage?.mounting === undefined || usage.mounting.straddle + usage.mounting.direct === 0
      ? undefined
      : [usage.mounting.straddle > 0 ? `straddle-mounted in ${usage.mounting.straddle}` : undefined, usage.mounting.direct > 0 ? `direct in ${usage.mounting.direct}` : undefined]
          .filter((part): part is string => part !== undefined)
          .join(', ');
  return (
    <Section
      id="where-used"
      title="Where used"
      summary={
        <>
          {usage === undefined ? '…' : usage.count}
          {mounting === undefined ? null : <span data-testid="mounting-summary"> · {mounting}</span>}
        </>
      }
    >
      {usage === undefined || usage.count === 0 ? null : (
        <>
        <table className="cs-used-table" data-testid="where-used">
          <thead>
            <tr>
              <th>Name</th>
              <th>PN</th>
              {showRev ? <th>Rev</th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.key}>
                <td title={row.title}>
                  {row.open === undefined ? (
                    <span>{row.name}</span>
                  ) : (
                    <button type="button" className="cs-link" onClick={row.open}>
                      {row.name}
                    </button>
                  )}
                </td>
                <td className={classes('cs-mono', row.pn === '' && 'is-faint')}>{row.pn === '' ? '—' : row.pn}</td>
                {showRev ? <td className={classes('cs-mono', row.rev === '' && 'is-faint')}>{row.rev === '' ? '—' : row.rev}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length <= WHERE_USED_FIRST ? null : (
          <button type="button" className="cs-link cs-used-more" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        </>
      )}
    </Section>
  );
}

/** Where the record's values come from — collapsed; the catalog's `src`. */
export function SourceBlock({ src }: { src: string }): JSX.Element {
  return (
    <Section id="reference" title="Reference" defaultOpen={false} className="cs-record-src" {...(src === '' ? { summary: '—' } : {})}>
      {src === '' ? null : <p>{src}</p>}
    </Section>
  );
}
