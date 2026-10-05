/**
 * The base's compare view: two records of one kind, a field diff
 * (`record-diff.ts`). It makes the Library's Compare actions do something on
 * their own; a module's compare view (`CompareViewContribution`) replaces it
 * for the kinds the module declares.
 */

import { useMemo, useState, type JSX } from 'react';
import type { Db } from '@wirehub/model';

import { diffRecords, libraryRecord, libraryRecordIds } from '../record-diff.ts';

export interface RecordRef {
  kind: string;
  id: string;
}

export function RecordCompare(props: {
  db: Db;
  a: RecordRef;
  /** absent: the view asks for the second record */
  b?: RecordRef;
  onClose: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<string | undefined>(props.b?.id);
  const [showSame, setShowSame] = useState(false);
  const others = useMemo(() => libraryRecordIds(props.db, props.a.kind).filter((r) => r.id !== props.a.id), [props.db, props.a]);
  const left = libraryRecord(props.db, props.a.kind, props.a.id);
  const right = picked === undefined ? undefined : libraryRecord(props.db, props.a.kind, picked);
  const rows = useMemo(() => (left === undefined || right === undefined ? [] : diffRecords(left, right)), [left, right]);
  const shown = showSame ? rows : rows.filter((r) => r.status !== 'same');
  const differing = rows.filter((r) => r.status !== 'same').length;

  return (
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label="Compare records">
      <div className="cs-modal-card cs-compare">
        <h2>Compare</h2>
        <div className="cs-field">
          <span>
            <code>{props.a.kind}/{props.a.id}</code> with
          </span>
          <select aria-label="Compare with" value={picked ?? ''} onChange={(e) => setPicked(e.target.value === '' ? undefined : e.target.value)}>
            <option value="">choose a record…</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} ({r.id})
              </option>
            ))}
          </select>
        </div>
        {left === undefined ? <p className="cs-modal-say">There is no {props.a.kind} record {props.a.id}.</p> : null}
        {right === undefined ? null : (
          <>
            <label className="cs-small">
              <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> show unchanged fields ({rows.length - differing})
            </label>
            {differing === 0 ? <p className="cs-modal-say" data-testid="compare-identical">The two records have the same fields.</p> : null}
            <table className="cs-compare-table" aria-label="Field differences">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>{props.a.id}</th>
                  <th>{picked}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.path} data-status={r.status}>
                    <td>
                      <code>{r.path}</code>
                    </td>
                    <td>{r.a ?? <em>—</em>}</td>
                    <td>{r.b ?? <em>—</em>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="cs-modal-actions">
          <button type="button" className="cs-quiet" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
