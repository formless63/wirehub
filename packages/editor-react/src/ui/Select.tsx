import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { Select as RSelect } from 'radix-ui';
import type { JSX } from 'react';

import type { ControlSize } from './Button.tsx';
import { cx } from './cx.ts';
import { useFieldProps } from './Field.tsx';
import { usePortalContainer } from './portal.ts';

export interface SelectOption {
  /** non-empty (a Radix rule); model "none" as an explicit option */
  value: string;
  label: string;
  disabled?: boolean;
  /** options with the same group are listed under its heading */
  group?: string;
}

export interface SelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  size?: ControlSize;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  'aria-label'?: string;
}

/** The one dropdown: Radix Select (keyboard, type-ahead, ARIA) in WireHub's list look. Never a native `<select>`. */
export function Select({ value, onValueChange, options, placeholder = 'Select...', size = 'sm', disabled, id, name, className, ...rest }: SelectProps): JSX.Element {
  const f = useFieldProps({ id });
  const container = usePortalContainer();
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  const item = (o: SelectOption): JSX.Element => (
    <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="cs-ui-option">
      <RSelect.ItemText>{o.label}</RSelect.ItemText>
      <RSelect.ItemIndicator className="cs-ui-option-hint"><IconCheck size={14} aria-hidden /></RSelect.ItemIndicator>
    </RSelect.Item>
  );
  return (
    <RSelect.Root {...(value === undefined ? {} : { value })} onValueChange={onValueChange} disabled={disabled} {...(name === undefined ? {} : { name })}>
      <RSelect.Trigger {...f} {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })} className={cx('cs-ui-select-trigger', className)} data-size={size}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon asChild><IconChevronDown size={14} aria-hidden /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal container={container}>
        <RSelect.Content className="cs-ui-pop cs-ui-select-pop" position="popper" sideOffset={4}>
          <RSelect.Viewport>
            {groups.map((g) =>
              g === '' ? (
                options.filter((o) => (o.group ?? '') === '').map(item)
              ) : (
                <RSelect.Group key={g}>
                  <RSelect.Label className="cs-ui-group-label">{g}</RSelect.Label>
                  {options.filter((o) => o.group === g).map(item)}
                </RSelect.Group>
              ),
            )}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
