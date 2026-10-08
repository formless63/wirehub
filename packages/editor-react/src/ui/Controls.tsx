import { IconCheck, IconMinus } from '@tabler/icons-react';
import { Checkbox as RCheckbox, RadioGroup as RRadioGroup, Switch as RSwitch, ToggleGroup as RToggleGroup } from 'radix-ui';
import { useId, type JSX, type ReactNode } from 'react';

import type { ControlSize } from './Button.tsx';
import { cx } from './cx.ts';

export interface CheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  /** the visible label; without one, pass `aria-label` */
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

/** Space toggles. `checked="indeterminate"` shows a dash and `aria-checked="mixed"`. */
export function Checkbox({ checked, onCheckedChange, label, disabled, id, className, ...rest }: CheckboxProps): JSX.Element {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <span className={cx('cs-ui-choice', className)} data-disabled={disabled || undefined}>
      <RCheckbox.Root id={cid} className="cs-ui-check" checked={checked} disabled={disabled} onCheckedChange={(c) => onCheckedChange(c === true)} {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}>
        <RCheckbox.Indicator>{checked === 'indeterminate' ? <IconMinus size={12} stroke={2.5} aria-hidden /> : <IconCheck size={12} stroke={2.5} aria-hidden />}</RCheckbox.Indicator>
      </RCheckbox.Root>
      {label === undefined ? null : <label htmlFor={cid}>{label}</label>}
    </span>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly RadioOption[];
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
  /** names the group (required unless the group is labelled by something else) */
  'aria-label'?: string;
  className?: string;
}

/** One tab stop; arrow keys move and select. */
export function RadioGroup({ value, onValueChange, options, orientation = 'vertical', disabled, className, ...rest }: RadioGroupProps): JSX.Element {
  const base = useId();
  return (
    <RRadioGroup.Root value={value} onValueChange={onValueChange} disabled={disabled} orientation={orientation} className={cx('cs-ui-radiogroup', className)} data-orientation={orientation} {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}>
      {options.map((o) => (
        <span key={o.value} className="cs-ui-choice" data-disabled={o.disabled || disabled || undefined}>
          <RRadioGroup.Item id={`${base}-${o.value}`} value={o.value} disabled={o.disabled} className="cs-ui-radio">
            <RRadioGroup.Indicator><span className="cs-ui-radio-dot" /></RRadioGroup.Indicator>
          </RRadioGroup.Item>
          <label htmlFor={`${base}-${o.value}`}>{o.label}</label>
        </span>
      ))}
    </RRadioGroup.Root>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

/** An immediate on/off (applies now, no Save). Role `switch`; Space toggles. */
export function Switch({ checked, onCheckedChange, label, disabled, id, className, ...rest }: SwitchProps): JSX.Element {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <span className={cx('cs-ui-choice', className)} data-disabled={disabled || undefined}>
      <RSwitch.Root id={sid} className="cs-ui-switch" checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}>
        <RSwitch.Thumb className="cs-ui-switch-thumb" />
      </RSwitch.Root>
      {label === undefined ? null : <label htmlFor={sid}>{label}</label>}
    </span>
  );
}

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  /** required when `label` is an icon only */
  'aria-label'?: string;
}

export interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SegmentedOption[];
  size?: ControlSize;
  'aria-label'?: string;
  className?: string;
}

/** 2 to 5 mutually exclusive views or modes. Always one selected; arrow keys move focus (roving tab stop). */
export function SegmentedControl({ value, onValueChange, options, size = 'sm', className, ...rest }: SegmentedControlProps): JSX.Element {
  return (
    <RToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => { if (next !== '') onValueChange(next); }}
      className={cx('cs-ui-seg', className)}
      data-size={size}
      {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}
    >
      {options.map((o) => (
        <RToggleGroup.Item key={o.value} value={o.value} className="cs-ui-seg-item" {...(o['aria-label'] === undefined ? {} : { 'aria-label': o['aria-label'] })}>
          {o.label}
        </RToggleGroup.Item>
      ))}
    </RToggleGroup.Root>
  );
}
