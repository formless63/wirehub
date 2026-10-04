/**
 * "Components on this board": the parts placed on a
 * PCBA, grouped by component record with a quantity per refdes group, for the
 * board's Library page and the build view.
 *
 * Self-contained: give it the db (its `boardParts` and `components`), the
 * board's part number and revision, and either the definition shown (its
 * build's population, laid over the board at load) or a live population (the
 * build editor's). The PCBA stays one line in the cable BOM — the studio buys
 * the populated board — so this list is the board's own sub-list, never BOM
 * lines.
 */

import { boardBuildOf, boardComponentRows, boardPartsOf, compressRefs, type Db } from '@wirehub/model';
import { useMemo, useState, type JSX } from 'react';

import { classes } from '../context.ts';

export interface BoardComponentsSectionProps {
  db: Pick<Db, 'boardParts' | 'components'>;
  /** the bare board's part number, `PCA-00101` */
  board: string;
  /** `Rev6` (or `6`); omitted: the board's only entry */
  revision?: string;
  /** the definition shown: its build's population sets the quantities */
  defId?: string;
  /** a live population (the build editor's) — wins over `defId` */
  population?: { build?: string; omitted?: readonly string[]; bridged?: readonly string[] };
  /** open a component's Library record */
  onOpenComponent?: (id: string) => void;
}

const OPEN_KEY = 'cs-board-components-open';

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? 'true' : 'false');
  } catch {
    // a private window: the choice is not remembered
  }
}

export function BoardComponentsSection(props: BoardComponentsSectionProps): JSX.Element | null {
  const [open, setOpen] = useState(readOpen);
  const entry = useMemo(() => boardPartsOf(props.db, props.board, props.revision), [props.db, props.board, props.revision]);
  const build = entry === undefined || props.defId === undefined ? undefined : boardBuildOf(entry, props.defId);
  const population = props.population ?? build ?? {};
  // a board has a few dozen parts at most: grouping them each render is cheap
  const rows = entry === undefined ? [] : boardComponentRows(entry, props.db.components, population);
  if (entry === undefined) return null;
  const fitted = rows.reduce((n, r) => n + r.qty, 0);
  const buildName = props.population?.build ?? build?.build;
  const flip = (): void => {
    setOpen(!open);
    writeOpen(!open);
  };

  return (
    <section className={classes('cs-rev-panel cs-bc-panel', !open && 'is-collapsed')} aria-label="Components on this board">
      <header className="cs-model-head">
        <button type="button" className="cs-model-fold" aria-expanded={open} onClick={flip}>
          {open ? '▾' : '▸'} Components on this board
        </button>
        <span
          className="cs-rev-count"
          title="Bought with the populated board: the cable BOM lists the PCBA once, never these parts. From the board's .kicad_pcb, fabrication BOM and CPLs (data/board-parts.json)."
        >
          {entry.board} {entry.revision}
          {buildName === undefined ? '' : ` · ${buildName}`} · {fitted} fitted · {rows.length} part{rows.length === 1 ? '' : 's'}
        </span>
      </header>
      {open ? (
        rows.length === 0 ? (
          <p className="cs-empty cs-bc-empty">No placed parts: every footprint is a pad or a landing.</p>
        ) : (
          <table className="cs-rev-table cs-bc-table">
            <thead>
              <tr>
                <th className="cs-bc-qty">Qty</th>
                <th>Refs</th>
                <th>Component</th>
                <th>Value</th>
                <th>Package</th>
                <th>MPN</th>
                <th>Supplier</th>
                <th>PN</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const r = row.record;
                const off = row.refs.filter((ref) => !row.fitted.includes(ref));
                const supplier = (r?.suppliers ?? []).find((s) => s.alternate !== true);
                const pn = r?.partNumber?.trim() === '' ? undefined : r?.partNumber?.trim();
                return (
                  <tr key={row.component} className={classes(row.qty === 0 && 'is-empty')}>
                    <td className="cs-bc-qty cs-mono">{row.qty}</td>
                    <td className="cs-bc-refs cs-mono" title={off.length === 0 ? undefined : `Not fitted on this build: ${off.join(', ')}`}>
                      {compressRefs(row.fitted)}
                      {off.length === 0 ? null : <span className="cs-bc-off">{row.fitted.length === 0 ? '' : ' · '}DNP {compressRefs(off)}</span>}
                      {row.bridged.length === 0 ? null : <span className="cs-bc-off"> · bridged {compressRefs(row.bridged)}</span>}
                    </td>
                    <td className="cs-bc-label">
                      {props.onOpenComponent === undefined || r === undefined ? (
                        <span title={r?.review}>{r?.label ?? row.component}</span>
                      ) : (
                        <button type="button" className="cs-link" title={r.review ?? r.label} onClick={() => props.onOpenComponent!(row.component)}>
                          {r.label}
                        </button>
                      )}
                      {r?.review === undefined ? null : (
                        <span className="cs-bc-review" title={r.review}>
                          review
                        </span>
                      )}
                    </td>
                    <td>{r?.value ?? ''}</td>
                    <td>{r?.package ?? ''}</td>
                    <td className="cs-mono">{r?.mpn ?? ''}</td>
                    <td className="cs-mono" title={(r?.suppliers ?? []).map((s) => `${s.supplier} ${s.number}${s.alternate === true ? ' (alternate)' : ''}`).join('\n') || undefined}>
                      {supplier === undefined ? '' : `${supplier.supplier} ${supplier.number}`}
                    </td>
                    <td className="cs-mono">{pn ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}
