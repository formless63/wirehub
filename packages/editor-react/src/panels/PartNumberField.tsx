/**
 * The part-number box with a Suggest button beside it.
 *
 * Suggest asks the deployment's numbering scheme (`part-numbers.ts`) for a
 * number and shows it with the rule that produced it, and any existing
 * numbers that may already be this part's. Use copies one into the draft;
 * nothing is saved until the form is. Scheme mismatches show under the box as
 * warnings, never as a blocking problem.
 *
 * Without a host-provided scheme (`PartNumberContext`) this is a plain Field.
 */

import { IconBulb } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import type { PnKind } from '@wirehub/model';

import { classes } from '../context.ts';
import { usePartNumbers, type PartNumberTarget, type SuggestResult } from '../part-numbers.ts';
import { Field } from './fields.tsx';

export interface PartNumberFieldProps {
  label?: string;
  say?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  wide?: boolean;
  /** a blocking problem the form itself found (shown as the Field's own) */
  problem?: string;
  /** what the scheme numbers this as (connector, shell, pcba …) */
  kind: PnKind;
  /** the definition as the form would save it — built only when Suggest is pressed */
  target: () => PartNumberTarget;
}

export function PartNumberField(props: PartNumberFieldProps): JSX.Element {
  const scope = usePartNumbers();
  const [shown, setShown] = useState<SuggestResult | undefined>(undefined);
  const field = (
    <Field
      label={props.label ?? 'Part number'}
      {...(props.say === undefined ? {} : { say: props.say })}
      value={props.value}
      onChange={props.onChange}
      {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
      {...(props.wide === true ? { wide: true } : {})}
      {...(props.problem === undefined ? {} : { problem: props.problem })}
      mono
    />
  );
  if (scope === undefined) return field;
  const warnings = scope.check(props.value, props.kind).map((w) => w.message);
  // a number another part already carries: only a warning here, the save itself is refused
  let taken: string[] = [];
  try {
    taken = scope.taken(props.value, props.target());
  } catch {
    // a half-filled draft may not convert yet
  }
  if (taken.length > 0) warnings.push(`'${props.value.trim()}' is already on ${taken.slice(0, 3).join(', ')}${taken.length > 3 ? ` and ${taken.length - 3} more` : ''} — saving will be refused`);
  // a half-filled draft may not convert yet; a suggestion is never worth a crash
  const suggestSafely = (): SuggestResult => {
    try {
      return scope.suggest(props.target());
    } catch {
      return { items: [], candidates: [] };
    }
  };
  const use = (pn: string): void => {
    props.onChange(pn);
    setShown(undefined);
  };
  return (
    <div className={classes('cs-pn', props.wide === true && 'is-wide')}>
      <div className="cs-pn-row">
        {field}
        <button
          type="button"
          className="cs-pn-suggest"
          title="Suggest a part number from the numbering already in use — shows the rule it followed"
          onClick={() => setShown(shown === undefined ? suggestSafely() : undefined)}
        >
          <IconBulb size={14} stroke={1.75} />
          Suggest
        </button>
      </div>
      {warnings.length === 0 ? null : (
        <ul className="cs-pn-warn" role="status">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {shown === undefined ? null : (
        <div className="cs-pn-panel" role="region" aria-label="Part-number suggestion">
          {shown.items.length > 0 ? null : shown.waiting !== undefined ? (
            <p className="cs-pn-rule">{shown.waiting}</p>
          ) : (
            <p className="cs-pn-rule">No suggestion: the scheme has no class for this kind.</p>
          )}
          {shown.items.length > 0 || shown.candidates.length === 0 ? null : (
            <ul className="cs-pn-candidates">
              {shown.candidates.map((c) => (
                <li key={c.pn}>
                  <span title="An existing number that may already be this part">existing</span> <code className="cs-mono">{c.pn}</code>{' '}
                  {c.description}
                  {c.pn !== props.value ? (
                    <>
                      {' '}
                      <button type="button" className="cs-link" onClick={() => use(c.pn)}>
                        Use
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {shown.items.map((s, i) => (
            <div key={i} className="cs-pn-suggestion">
              <div className="cs-pn-head">
                <span className="cs-pn-for">{s.label}</span>
                <code className="cs-mono">{s.suggestion.pn}</code>
                {s.suggestion.fallback ? (
                  <span className="cs-chip is-warn" title="No numbering pattern applied — this is only the next free number">
                    fallback
                  </span>
                ) : null}
                {s.forField && s.suggestion.pn !== props.value ? (
                  <button type="button" className="cs-link" onClick={() => use(s.suggestion.pn)}>
                    Use
                  </button>
                ) : null}
              </div>
              <p className="cs-pn-rule">
                {s.suggestion.explanation}
              </p>
              {s.candidates.length === 0 ? null : (
                <ul className="cs-pn-candidates">
                  {s.candidates.map((c) => (
                    <li key={c.pn}>
                      <span title="An existing number that may already be this part">existing</span>{' '}
                      <code className="cs-mono">{c.pn}</code> {c.description}
                      {s.forField && c.pn !== props.value ? (
                        <>
                          {' '}
                          <button type="button" className="cs-link" onClick={() => use(c.pn)}>
                            Use
                          </button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
