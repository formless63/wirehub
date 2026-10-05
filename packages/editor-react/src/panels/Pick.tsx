/**
 * `Pick` — the one combobox every controlled field uses (data model v2 §5).
 *
 * A button that shows the picked entry's label; focus it and type, or press
 * ↓ / Enter, and a filter opens under it. The filter matches labels, ids and
 * aliases (`csy` → CSync, `R` → the Video R pad), recent picks come first,
 * ↑ ↓ Home End move, Enter picks, Esc closes. When nothing matches exactly
 * and the host can add entries, the last row is "Add '…'": a one-line form
 * (label, id, source — and the kind, for a signal) that appends the entry to
 * its list and picks it. Lists are append-only; the form cannot edit or
 * remove anything.
 *
 * Options come from a vocab list (`list`, read from `VocabContext`) or are
 * handed in (`options` — the standard values of a component kind). A value
 * no option has (a record written before the list existed) still shows, as
 * itself, marked as not in the list.
 */

import type { SignalKind } from '@wirehub/model';
import { signalKinds } from '@wirehub/model';
import { IconCheck, IconChevronDown, IconPlus, IconX } from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';

import { classes } from '../context.ts';
import {
  exactOption,
  guessSignalKind,
  rankOptions,
  recentPicks,
  rememberPick,
  useVocab,
  vocabIdOf,
  vocabOptions,
  type PickOption,
} from '../vocab.ts';

export interface PickProps {
  /** the vocab list the options come from (and new entries go to) */
  list?: string;
  /** options handed in; used instead of the list's when given */
  options?: readonly PickOption[];
  value: string;
  /** `picked` is the option (or the entry just added) — its label, for a field that stores words */
  onChange: (next: string, picked?: { label: string }) => void;
  /** a field label above the control; omit inside a table row */
  label?: string;
  /** the accessible name when there is no visible label */
  ariaLabel?: string;
  /** the tooltip — never printed on the page */
  say?: string;
  placeholder?: string;
  /** offer "Add '…'" (default: whenever there is a list and the host can add) */
  allowAdd?: boolean;
  /** accept what was typed as the value itself — "Use '…'" (values, not vocab ids) */
  allowCustom?: boolean;
  /** offer a row that clears the value */
  clearable?: boolean;
  /** what the cleared value is called */
  noneLabel?: string;
  wide?: boolean;
  mono?: boolean;
  problem?: string;
  disabled?: boolean;
}

type AddDraft = { label: string; id: string; idTouched: boolean; src: string; kind: SignalKind; error?: string; busy?: boolean };

/**
 * Options with each group's members brought together, groups in the order
 * they first appear and members in their own order — so a list whose source
 * file interleaves groups shows each heading once (review fix, 2026-09-26).
 */
export function groupContiguous<T extends { group?: string | undefined }>(options: readonly T[]): T[] {
  const order: (string | undefined)[] = [];
  const byGroup = new Map<string | undefined, T[]>();
  for (const option of options) {
    const members = byGroup.get(option.group);
    if (members === undefined) {
      order.push(option.group);
      byGroup.set(option.group, [option]);
    } else members.push(option);
  }
  return order.flatMap((group) => byGroup.get(group) ?? []);
}

export function Pick(props: PickProps): JSX.Element {
  const scope = useVocab();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<AddDraft | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const options = useMemo<readonly PickOption[]>(
    () => props.options ?? (props.list === undefined ? [] : vocabOptions(scope.vocab, props.list)),
    [props.options, props.list, scope.vocab],
  );
  const canAdd = props.allowAdd ?? (props.list !== undefined && scope.add !== undefined);
  const current = options.find((option) => option.value === props.value);

  /** the rows the list shows, in order — options, then the custom/add row */
  const rows = useMemo(() => {
    let ranked: PickOption[];
    if (query.trim() === '' && props.list !== undefined) {
      const recent = recentPicks(props.list)
        .map((value) => options.find((option) => option.value === value))
        .filter((option): option is PickOption => option !== undefined)
        .map((option) => ({ ...option, group: 'Recent' }));
      const seen = new Set(recent.map((option) => option.value));
      ranked = [...recent, ...groupContiguous(options.filter((option) => !seen.has(option.value)))];
    } else if (query.trim() === '') {
      ranked = groupContiguous(options);
    } else {
      ranked = rankOptions(options, query);
    }
    const out: ({ type: 'option'; option: PickOption } | { type: 'none' } | { type: 'custom' } | { type: 'add' })[] = [];
    if (props.clearable === true && query.trim() === '') out.push({ type: 'none' });
    for (const option of ranked) out.push({ type: 'option', option });
    const typed = query.trim();
    const exact = exactOption(options, typed);
    if (typed !== '' && exact === undefined) {
      if (props.allowCustom === true) out.push({ type: 'custom' });
      if (canAdd && props.list !== undefined) out.push({ type: 'add' });
    }
    return out;
  }, [options, query, props.list, props.clearable, props.allowCustom, canAdd]);

  const close = (): void => {
    setOpen(false);
    setQuery('');
    setActive(0);
    setAdding(undefined);
  };

  const commit = (value: string, picked?: { label: string }): void => {
    if (props.list !== undefined) rememberPick(props.list, value);
    props.onChange(value, picked);
    close();
    // keep the keyboard where it was: back on the trigger, ready for Tab
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const startAdd = (): void => {
    const label = query.trim();
    setAdding({ label, id: vocabIdOf(label), idTouched: false, src: '', kind: guessSignalKind(label, scope.vocab) });
  };

  const choose = (index: number): void => {
    const row = rows[index];
    if (row === undefined) return;
    if (row.type === 'option') commit(row.option.value, row.option);
    else if (row.type === 'none') commit('');
    else if (row.type === 'custom') commit(query.trim());
    else startAdd();
  };

  const onFilterKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    const last = rows.length - 1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((at) => Math.min(last, at + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((at) => Math.max(0, at - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(last);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Tab') {
      close();
    }
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (props.disabled === true) return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      event.preventDefault();
      setQuery(event.key);
      setActive(0);
      setOpen(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && props.clearable === true) {
      event.preventDefault();
      props.onChange('');
    }
  };

  const submitAdd = async (): Promise<void> => {
    if (adding === undefined || props.list === undefined || scope.add === undefined) return;
    if (adding.label.trim() === '' || adding.src.trim() === '') {
      setAdding({ ...adding, error: adding.label.trim() === '' ? 'A label is needed.' : 'Say where it comes from.' });
      return;
    }
    const { error: _previous, ...rest } = adding;
    setAdding({ ...rest, busy: true });
    const outcome = await scope.add(props.list, {
      id: adding.id.trim() || vocabIdOf(adding.label),
      label: adding.label.trim(),
      src: adding.src.trim(),
      ...(props.list === 'signals' ? { kind: adding.kind } : {}),
    });
    if (!outcome.ok) {
      const detail = outcome.issues?.map((issue) => issue.message).join('; ');
      setAdding({ ...adding, busy: false, error: detail === undefined || detail === '' ? outcome.message : `${outcome.message} ${detail}` });
      return;
    }
    commit(outcome.value.id, outcome.value);
  };

  // "one of" (`cvbs|csync`) shows as its entries' labels; picking replaces it with one
  const parts = current === undefined && props.value.includes('|') ? props.value.split('|') : undefined;
  const partOptions = parts?.map((part) => options.find((option) => option.value === part));
  const oneOf = partOptions !== undefined && partOptions.every((option) => option !== undefined);
  const shown = current?.label ?? (oneOf ? `one of ${partOptions.map((option) => option?.label).join(' / ')}` : props.value);
  const unlisted = props.value !== '' && current === undefined && !oneOf && props.allowCustom !== true;
  const activeRow = rows[active];
  const optionId = (index: number): string => `${listId}-o${index}`;
  let lastGroup: string | undefined;

  // the trigger's own tooltip: the full value always (a narrow trigger can
  // truncate it), plus the field's own explanation when
  // it says more than the value already does
  const displayed = props.value === '' ? (props.placeholder ?? props.noneLabel ?? '—') : shown;
  const triggerTitle = unlisted
    ? `'${props.value}' is not in the list — pick an entry`
    : props.say !== undefined && props.say !== displayed
      ? `${displayed} — ${props.say}`
      : displayed;

  const control = (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={classes('cs-pick', props.mono === true && 'cs-mono', unlisted && 'is-unlisted', props.problem !== undefined && 'is-bad')}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={props.disabled}
          {...(props.ariaLabel ?? props.label) === undefined ? {} : { 'aria-label': props.ariaLabel ?? props.label }}
          title={triggerTitle}
          onKeyDown={onTriggerKey}
        >
          <span className={classes('cs-pick-value', props.value === '' && 'is-empty')}>{displayed}</span>
          <IconChevronDown size={12} stroke={1.75} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cs-popover cs-pick-popover"
          sideOffset={3}
          align="start"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {adding === undefined ? (
            <>
              <input
                className="cs-input cs-pick-filter"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-label={`filter ${props.label ?? props.ariaLabel ?? 'options'}`}
                {...(activeRow === undefined ? {} : { 'aria-activedescendant': optionId(active) })}
                placeholder="Type to filter…"
                value={query}
                autoFocus
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onFilterKey}
              />
              <ul className="cs-pick-list" role="listbox" id={listId}>
                {rows.length === 0 ? <li className="cs-empty">No match</li> : null}
                {rows.map((row, index) => {
                  const heading =
                    row.type === 'option' && row.option.group !== undefined && row.option.group !== lastGroup ? row.option.group : undefined;
                  if (row.type === 'option') lastGroup = row.option.group;
                  const selected = row.type === 'option' && row.option.value === props.value;
                  return (
                    <li key={row.type === 'option' ? `o:${row.option.group === 'Recent' ? 'r:' : ''}${row.option.value}` : row.type} role="presentation">
                      {heading === undefined ? null : <span className="cs-pick-group">{heading}</span>}
                      <div
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === active}
                        className={classes('cs-pick-option', index === active && 'is-active', row.type === 'add' && 'is-add')}
                        onMouseMove={() => setActive(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(index)}
                      >
                        {row.type === 'option' ? (
                          <>
                            <span className="cs-pick-text" title={[row.option.label, row.option.hint === row.option.label ? undefined : row.option.hint].filter((t) => t !== undefined).join(' — ')}>
                              <span className="cs-pick-label">{row.option.label}</span>
                              {row.option.hint === undefined || row.option.hint === row.option.label ? null : (
                                <span className="cs-pick-hint cs-mono">{row.option.hint}</span>
                              )}
                            </span>
                            {selected ? <IconCheck size={12} stroke={2} className="cs-pick-check" aria-hidden="true" /> : null}
                          </>
                        ) : row.type === 'none' ? (
                          <span className="cs-pick-label cs-pick-none">{props.noneLabel ?? 'none'}</span>
                        ) : row.type === 'custom' ? (
                          <span className="cs-pick-label">Use ‘{query.trim()}’</span>
                        ) : (
                          <>
                            <IconPlus size={12} stroke={2} aria-hidden="true" />
                            <span className="cs-pick-label">Add ‘{query.trim()}’…</span>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <form
              className="cs-pick-add"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAdd();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setAdding(undefined);
                }
              }}
            >
              <p className="cs-popover-label">Add to {scope.vocab?.[props.list ?? '']?.label ?? props.list}</p>
              <label title="What the picker shows">
                <span>Label</span>
                <input
                  className="cs-input"
                  value={adding.label}
                  autoFocus
                  onChange={(event) =>
                    setAdding({
                      ...adding,
                      label: event.target.value,
                      ...(adding.idTouched ? {} : { id: vocabIdOf(event.target.value) }),
                    })
                  }
                />
              </label>
              <label title="Fixed once added: files refer to the entry by it. Lowercase words joined by hyphens.">
                <span>Id</span>
                <input
                  className="cs-input cs-mono"
                  value={adding.id}
                  onChange={(event) => setAdding({ ...adding, id: event.target.value, idTouched: true })}
                />
              </label>
              {props.list === 'signals' ? (
                <label title="The family of signal — what a rule with nothing more specific treats it as">
                  <span>Kind</span>
                  <select
                    className="cs-input"
                    value={adding.kind}
                    onChange={(event) => setAdding({ ...adding, kind: event.target.value as SignalKind })}
                  >
                    {signalKinds(scope.vocab).map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label title="Where this entry comes from — the spec sheet, board silkscreen or standard. Required.">
                <span>Source</span>
                <input
                  className="cs-input"
                  value={adding.src}
                  placeholder="document § · datasheet · silkscreen"
                  onChange={(event) => setAdding({ ...adding, src: event.target.value })}
                />
              </label>
              {adding.error === undefined ? null : (
                <small className="cs-field-bad" role="alert">
                  {adding.error}
                </small>
              )}
              <div className="cs-pick-add-actions">
                <button type="button" className="cs-icon-btn" title="Back to the list (Esc)" aria-label="back" onClick={() => setAdding(undefined)}>
                  <IconX size={13} stroke={1.75} />
                </button>
                <button type="submit" className="cs-primary" disabled={adding.busy === true}>
                  {adding.busy === true ? 'Adding…' : 'Add'}
                </button>
              </div>
            </form>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );

  if (props.label === undefined) return control;
  return (
    <div
      className={classes('cs-field', props.wide === true && 'is-wide', props.problem !== undefined && 'is-bad')}
      {...(props.say === undefined ? {} : { title: props.say })}
    >
      <span>{props.label}</span>
      {control}
      {props.problem === undefined ? null : <small className="cs-field-bad">{props.problem}</small>}
    </div>
  );
}
