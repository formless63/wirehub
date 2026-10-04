/**
 * The small parts every definition form is built from.
 *
 * They exist so the spec's field rules are obeyed by construction rather than
 * by remembering: **every field has a one-line explanation**, held as a
 * `title` tooltip rather than printed on the page, **units are explicit** (a
 * millimetre box says mm and takes a number, never `1.4 mm`), and a field
 * that is wrong says so under itself while you are still in it.
 *
 * Nothing here holds state. Every input is controlled by the form above it,
 * which holds the draft — one place where "what the user has typed" lives.
 */

import { IconChevronDown, IconChevronUp, IconTrash } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';

import { classes } from '../context.ts';
import { isNumberField } from '../library.ts';

export interface FieldProps {
  label: string;
  /** the field's explanation, shown as a tooltip on hover/focus — never on the page */
  say?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** shown instead of `say` when it is set — what is wrong, right now */
  problem?: string;
  autoFocus?: boolean;
  /** a `<datalist>` of suggestions; typing something else is still allowed */
  options?: readonly string[];
  wide?: boolean;
  /** tabular mono — for ids, pin/terminal numbers and measurements */
  mono?: boolean;
  /** shown, not editable */
  readOnly?: boolean;
}

let listCounter = 0;

export function Field(props: FieldProps): JSX.Element {
  const listId = props.options === undefined ? undefined : `cs-list-${(listCounter += 1)}`;
  return (
    <label
      className={classes('cs-field', props.wide === true && 'is-wide', props.problem !== undefined && 'is-bad')}
      {...(props.say === undefined ? {} : { title: props.say })}
    >
      <span>{props.label}</span>
      <input
        className={classes(props.mono === true && 'cs-mono')}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
        {...(props.autoFocus === true ? { autoFocus: true } : {})}
        {...(props.readOnly === true ? { readOnly: true } : {})}
        {...(listId === undefined ? {} : { list: listId })}
      />
      {listId === undefined ? null : (
        <datalist id={listId}>
          {(props.options ?? []).map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
      {props.problem === undefined ? null : <small className="cs-field-bad">{props.problem}</small>}
    </label>
  );
}

/**
 * A millimetre box. It takes a number and says so; a value with its unit typed
 * in is caught here rather than three screens later, because "1.4 mm" is the
 * single most natural thing to type into a box labelled "diameter".
 */
export function MmField(props: Omit<FieldProps, 'problem'> & { problem?: string }): JSX.Element {
  const typed = props.value.trim();
  const problem =
    props.problem ??
    (isNumberField(props.value)
      ? undefined
      : `"${typed}" is not a number. Write millimetres as digits — 1.4, not "1.4 mm".`);
  return (
    <Field
      {...props}
      label={`${props.label} (mm)`}
      {...(problem === undefined ? {} : { problem })}
      placeholder={props.placeholder ?? '1.4'}
      mono
    />
  );
}

export interface ChoiceProps {
  label: string;
  say?: string;
  value: string;
  onChange: (next: string) => void;
  choices: readonly { value: string; label: string }[];
}

export function Choice(props: ChoiceProps): JSX.Element {
  return (
    <label className="cs-field" {...(props.say === undefined ? {} : { title: props.say })}>
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The field that asks for provenance, in the words the spec fixes. It is its
 * own component because it appears on every form and must ask the same
 * question every time, and is required by house rule: every catalog record
 * carries a citation for where its values came from.
 */
export function SrcField(props: { value: string; onChange: (next: string) => void }): JSX.Element {
  return (
    <label
      className="cs-field is-wide"
      title="The vendor datasheet, board or measurement behind these values. Say so here when a value is inferred."
    >
      <span>Source</span>
      <textarea
        className="cs-textarea"
        rows={3}
        required
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder="datasheet · bench measurement · inferred (say so)"
      />
    </label>
  );
}

/** Up · down · remove, for one row of a builder. */
export function RowTools(props: {
  index: number;
  count: number;
  what: string;
  onMove: (by: number) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <span className="cs-row-tools">
      <button
        type="button"
        className="cs-small cs-icon-btn"
        disabled={props.index === 0}
        aria-label={`move ${props.what} up`}
        title="Move up"
        onClick={() => props.onMove(-1)}
      >
        <IconChevronUp size={14} stroke={1.75} />
      </button>
      <button
        type="button"
        className="cs-small cs-icon-btn"
        disabled={props.index === props.count - 1}
        aria-label={`move ${props.what} down`}
        title="Move down"
        onClick={() => props.onMove(1)}
      >
        <IconChevronDown size={14} stroke={1.75} />
      </button>
      <button
        type="button"
        className="cs-small cs-icon-btn cs-danger-quiet"
        aria-label={`remove ${props.what}`}
        title="Remove"
        onClick={props.onRemove}
      >
        <IconTrash size={14} stroke={1.75} />
      </button>
    </span>
  );
}

/** A titled block of a form, its explanation held as a tooltip on the heading. */
export function FormSection(props: {
  title: string;
  say?: string;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="cs-form-section">
      <h3 {...(props.say === undefined ? {} : { title: props.say })}>
        {props.title}
        {props.right === undefined ? null : <span className="cs-section-right">{props.right}</span>}
      </h3>
      {props.children}
    </section>
  );
}
