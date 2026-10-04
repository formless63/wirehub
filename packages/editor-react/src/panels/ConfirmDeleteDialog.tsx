/**
 * Safe part delete: deleting a part that has wires on
 * it asks first, in the app — `window.confirm` is blocked or a no-op in some
 * hosts. Confirming is one `delete-instances` dispatch, so one undo puts the
 * part and every joint it took with it back.
 */

import { terminalKey, type CableDesign } from '@wirehub/model';
import { useEffect, useRef, type JSX } from 'react';

import { keepDockedConnectors } from '../store.ts';

/** What deleting `ids` would take: the parts that actually go, and the joints on them. */
export interface DeletePlan {
  ids: string[];
  /** the instances that really go (a board's docked connector stays: `keepDockedConnectors`) */
  gone: string[];
  /** joints that land on a part that goes */
  joints: number[];
}

export function deletePlan(design: CableDesign, ids: readonly string[]): DeletePlan {
  const unique = [...new Set(ids)];
  const gone = keepDockedConnectors(design, unique);
  const set = new Set(gone);
  const joints = design.joints.flatMap((joint, index) => (set.has(joint.a.instance) || set.has(joint.b.instance) ? [index] : []));
  return { ids: unique, gone, joints };
}

function listOf(ids: readonly string[]): string {
  if (ids.length <= 1) return ids[0] ?? '';
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

/** "Delete j1 and its 12 wires?" */
export function deleteQuestion(plan: DeletePlan): string {
  const n = plan.joints.length;
  const whose = plan.gone.length === 1 ? 'its' : 'their';
  return `Delete ${listOf(plan.gone)} and ${whose} ${n} wire${n === 1 ? '' : 's'}?`;
}

export function ConfirmDeleteDialog({
  design,
  plan,
  onConfirm,
  onCancel,
}: {
  design: CableDesign;
  plan: DeletePlan;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
  }, []);
  const shown = plan.joints.slice(0, 8);
  return (
    <div
      className="cs-modal"
      role="alertdialog"
      aria-modal="true"
      aria-label="Delete part"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="cs-modal-card cs-confirm-delete">
        <h2>{deleteQuestion(plan)}</h2>
        <ul className="cs-kp-list">
          {shown.map((index) => {
            const joint = design.joints[index];
            return joint === undefined ? null : (
              <li key={index}>
                {terminalKey(joint.a)} — {terminalKey(joint.b)}
              </li>
            );
          })}
          {plan.joints.length > shown.length ? <li className="cs-cj-faint">+ {plan.joints.length - shown.length} more</li> : null}
        </ul>
        <p className="cs-cj-faint">Undo restores all of it.</p>
        <div className="cs-modal-actions">
          <button type="button" className="cs-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirm} type="button" className="cs-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
