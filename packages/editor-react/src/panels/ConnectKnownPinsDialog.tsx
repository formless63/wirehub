/**
 * "Connect known pins" — the review before anything is applied (cs-5k1.8).
 *
 * `proposeKnownJoints` (the model) reads the tags and returns the joints the
 * catalog settles, and the landings it will not guess. This lists both: each
 * proposal with its reason and a box to tick or clear, the ambiguous ones with
 * their candidates and no box. Apply adds the ticked joints as one undoable
 * edit; Cancel changes nothing.
 */

import { useMemo, useState, type JSX } from 'react';
import { jointKey, proposeKnownJoints, recipeJointProposals, type CableDesign, type Db, type Joint, type TerminalRef, endName } from '@wirehub/model';

const show = (ref: TerminalRef): string => `${ref.instance} ${ref.terminal}${ref.end === undefined ? '' : ` (${endName(ref.end)})`}`;

export function ConnectKnownPinsDialog(props: {
  design: CableDesign;
  db: Db;
  onCancel: () => void;
  /** the joints to add, and the description the one undo step carries */
  onApply: (joints: Joint[], description: string) => void;
}): JSX.Element {
  // the tags' proposals, then — for a design with a recipe — the joints the recipe derives that it lacks
  const plan = useMemo(() => {
    const known = proposeKnownJoints(props.design, props.db);
    const seen = new Set(known.proposals.map((p) => jointKey(p.joint)));
    const fromRecipe = recipeJointProposals(props.design, props.db)
      .filter((p) => !seen.has(jointKey(p.joint)))
      .map((p) => ({ kind: 'recipe' as const, joint: p.joint, why: p.why }));
    return { proposals: [...known.proposals, ...fromRecipe], ambiguous: known.ambiguous };
  }, [props.design, props.db]);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const chosen = plan.proposals.filter((_, i) => !skipped.has(i));
  const toggle = (i: number): void =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label="Connect known pins">
      <div className="cs-modal-card">
        <h2>Connect known pins</h2>
        <p className="cs-modal-say">
          Joints the catalog’s own signal tags settle: a conductor end and a pin on that end of the cable that carry the same signal, and a connector mounted on a board — and, for a cable with a recipe, the joints its recipe derives that it lacks.
          Nothing is applied until you say so, and it is one undo step.
        </p>
        {plan.proposals.length === 0 ? (
          <p className="cs-modal-say" data-testid="connect-none">
            Nothing to propose: every pin the tags settle is already wired.
          </p>
        ) : (
          <ul className="cs-connect-list" aria-label="Proposed joints">
            {plan.proposals.map((p, i) => (
              <li key={i} data-kind={p.kind}>
                <label>
                  <input type="checkbox" checked={!skipped.has(i)} onChange={() => toggle(i)} aria-label={`${show(p.joint.a)} to ${show(p.joint.b)}`} />{' '}
                  <code>{show(p.joint.a)}</code> ↔ <code>{show(p.joint.b)}</code>
                </label>
                <small> — {p.why}</small>
              </li>
            ))}
          </ul>
        )}
        {plan.ambiguous.length === 0 ? null : (
          <>
            <h3>Not proposed — the tags do not settle these</h3>
            <ul className="cs-connect-ambiguous" aria-label="Ambiguous landings">
              {plan.ambiguous.map((a, i) => (
                <li key={i}>
                  <code>{show(a.terminal)}</code>: {a.why}. Candidates: {a.candidates.map(show).join(', ')}.
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="cs-modal-actions">
          <button type="button" className="cs-quiet" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="cs-primary"
            disabled={chosen.length === 0}
            onClick={() => props.onApply(chosen.map((p) => p.joint), `connected ${chosen.length} known pin${chosen.length === 1 ? '' : 's'}`)}
          >
            {chosen.length === 0 ? 'Add joints' : `Add ${chosen.length} joint${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
