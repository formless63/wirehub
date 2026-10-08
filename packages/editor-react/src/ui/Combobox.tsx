import { IconChevronDown } from '@tabler/icons-react';
import { Popover as RPopover } from 'radix-ui';
import { useId, useMemo, useRef, useState, type JSX } from 'react';

import type { ControlSize } from './Button.tsx';
import { cx } from './cx.ts';
import { useFieldProps } from './Field.tsx';
import { usePortalContainer } from './portal.ts';

export interface ComboboxOption {
  value: string;
  label: string;
  /** a right-aligned secondary text (a part number, a count) */
  hint?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  /** the chosen option's `value`, or null */
  value: string | null;
  onValueChange: (value: string) => void;
  /** when given, a query that matches no option offers 'Create "..."' and calls this with the text */
  onCreate?: (text: string) => void;
  placeholder?: string;
  size?: ControlSize;
  disabled?: boolean;
  id?: string;
  className?: string;
  emptyText?: string;
  'aria-label'?: string;
}

/**
 * Search-as-you-type select, optionally with create. The WAI-ARIA combobox pattern: the input keeps
 * focus; Up/Down move the active option (`aria-activedescendant`), Enter picks, Escape closes.
 */
export function Combobox({ options, value, onValueChange, onCreate, placeholder = 'Search...', size = 'sm', disabled, id, className, emptyText = 'No matches', ...rest }: ComboboxProps): JSX.Element {
  const f = useFieldProps({ id });
  const container = usePortalContainer();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q === '' ? [...options] : options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q));
    const exact = options.some((o) => o.label.toLowerCase() === q);
    return { hits, create: onCreate !== undefined && q !== '' && !exact ? query.trim() : null };
  }, [options, query, onCreate]);
  const count = rows.hits.length + (rows.create === null ? 0 : 1);
  const optionId = (i: number): string => `${listId}-${i}`;

  const close = (): void => {
    setOpen(false);
    setQuery('');
    setActive(0);
  };
  const pick = (i: number): void => {
    const hit = rows.hits[i];
    if (hit !== undefined) {
      if (hit.disabled) return;
      onValueChange(hit.value);
    } else if (rows.create !== null) onCreate?.(rows.create);
    close();
  };

  return (
    <RPopover.Root open={open && !disabled} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <RPopover.Anchor asChild>
        <div ref={anchor} style={{ position: 'relative' }} className={className}>
          <input
            {...f}
            {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}
            className={cx('cs-ui-combo-input')}
            data-size={size}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && count > 0 ? optionId(active) : undefined}
            autoComplete="off"
            disabled={disabled}
            placeholder={selected === undefined ? placeholder : undefined}
            value={open ? query : (selected?.label ?? '')}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onBlur={() => close()}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!open) setOpen(true);
                else setActive((a) => (count === 0 ? 0 : (a + 1) % count));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (count === 0 ? 0 : (a - 1 + count) % count));
              } else if (e.key === 'Home' && open) {
                e.preventDefault();
                setActive(0);
              } else if (e.key === 'End' && open) {
                e.preventDefault();
                setActive(Math.max(0, count - 1));
              } else if (e.key === 'Enter' && open && count > 0) {
                e.preventDefault();
                pick(active);
              } else if (e.key === 'Escape' && open) {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <IconChevronDown size={14} aria-hidden style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--dim)' }} />
        </div>
      </RPopover.Anchor>
      <RPopover.Portal container={container}>
        <RPopover.Content
          className="cs-ui-pop cs-ui-combo-pop"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => { if (anchor.current?.contains(e.target as Node)) e.preventDefault(); }}
        >
          <ul className="cs-ui-list" role="listbox" id={listId}>
            {rows.hits.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                className="cs-ui-option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(i)}
              >
                {o.label}
                {o.hint === undefined ? null : <span className="cs-ui-option-hint">{o.hint}</span>}
              </li>
            ))}
            {rows.create === null ? null : (
              <li id={optionId(rows.hits.length)} role="option" className="cs-ui-option" aria-selected={false} data-active={active === rows.hits.length} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(rows.hits.length)} onClick={() => pick(rows.hits.length)}>
                Create &ldquo;{rows.create}&rdquo;
              </li>
            )}
          </ul>
          {count === 0 ? <div className="cs-ui-empty">{emptyText}</div> : null}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
