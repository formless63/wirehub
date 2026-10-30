/**
 * "Jumpers and switches" on a placed board: declare each one's state (open,
 * closed, or a switch position) for this occurrence. Saved on the design
 * (`PcbaInstance.partStates`); the conductor trace re-runs from it at once.
 * Two occurrences of one board are declared independently.
 */

import { boardBuildOf, boardPartsOf, findPcba, type CableDesign, type Db, type PcbaNetPart } from '@wirehub/model';
import { useMemo, type JSX } from 'react';

import { classes, useEditorApi } from '../context.ts';

/** The jumpers and switches a board's record lists, in reference order. */
export function stateParts(db: Db, def: string): PcbaNetPart[] {
  const parts = findPcba(db, def)?.netlist?.parts ?? [];
  return parts
    .filter((p) => p.category === 'jumper' || p.category === 'switch')
    .sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }));
}

/** The states a part offers: open, closed, and a switch's declared positions. */
export function stateChoices(part: PcbaNetPart): string[] {
  const positions = [...new Set((part.passages ?? []).flatMap((p) => (p.position === undefined ? [] : [p.position])))];
  return part.category === 'switch' && positions.length > 0 ? positions : ['open', 'closed'];
}

/** Where a part's state comes from when the occurrence declares none. */
function inheritedState(db: Db, design: CableDesign, id: string, part: PcbaNetPart): string | undefined {
  const def = findPcba(db, design.instances.pcbas.find((i) => i.id === id)?.def ?? '');
  if (def === undefined) return undefined;
  const entry = boardPartsOf(db, def.partNumber, def.revision);
  const build = entry === undefined ? undefined : boardBuildOf(entry, def.id);
  if (build?.omitted.includes(part.ref) === true) return 'open (build omits it)';
  if (build?.bridged.includes(part.ref) === true) return 'closed (build bridges it)';
  return part.state === undefined ? undefined : `${part.state} (board record)`;
}

export function PartStatesSection({ design, db, id }: { design: CableDesign; db: Db; id: string }): JSX.Element | null {
  const { dispatch } = useEditorApi();
  const instance = design.instances.pcbas.find((i) => i.id === id);
  const parts = useMemo(() => (instance === undefined ? [] : stateParts(db, instance.def)), [db, instance]);
  if (instance === undefined || parts.length === 0) return null;
  const declared = instance.partStates ?? {};
  const set = (ref: string, state: string | undefined): void => {
    const next = { ...declared };
    if (state === undefined) delete next[ref];
    else next[ref] = state;
    dispatch({ type: 'update-instance', id, patch: { partStates: next } });
  };
  return (
    <section className="cs-part-states" aria-label="jumpers and switches">
      <h3>
        jumpers and switches <span className="cs-count">{parts.length}</span>
      </h3>
      <ul className="cs-list cs-part-state-list">
        {parts.map((part) => {
          const own = declared[part.ref];
          const inherited = inheritedState(db, design, id, part);
          return (
            <li key={part.ref} className="cs-part-state" data-ref={part.ref}>
              <span className="cs-mono">{part.ref}</span>
              <span className="cs-seg" role="group" aria-label={`${part.ref} state`}>
                {stateChoices(part).map((choice) => (
                  <button key={choice} type="button" className={classes(own === choice && 'is-active')} aria-pressed={own === choice} onClick={() => set(part.ref, own === choice ? undefined : choice)}>
                    {choice}
                  </button>
                ))}
              </span>
              <span className="cs-meta">{own !== undefined ? 'declared here' : (inherited ?? 'not declared')}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
