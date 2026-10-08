import { useEffect, useId, useState, type JSX } from 'react';

import type { ControlSize } from './Button.tsx';
import { cx } from './cx.ts';
import { useFieldProps } from './Field.tsx';

export interface NumberInputProps {
  /** null = empty */
  value: number | null;
  onChange: (value: number | null) => void;
  /** shown inside the right edge and read as part of the description (mm, AWG, V, ohm ...) */
  unit?: string;
  min?: number;
  max?: number;
  /** arrow-key step; Shift multiplies by 10 (default 1) */
  step?: number;
  /** decimals kept on commit (default: as typed) */
  precision?: number;
  size?: ControlSize;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

function clamp(n: number, min?: number, max?: number): number {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
}

/**
 * A number field. Typing is free text (so "1." and "-" are allowed mid-edit); the value commits on
 * blur or Enter, clamped to min/max. Up/Down step it (Shift x10). Never a spinner: those are
 * hostile to scrolling and to a 26 px row.
 */
export function NumberInput({ value, onChange, unit, min, max, step = 1, precision, size = 'sm', disabled, placeholder, id, className, ...rest }: NumberInputProps): JSX.Element {
  const unitId = useId();
  const f = useFieldProps({ id, 'aria-describedby': unit === undefined ? undefined : unitId });
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);

  const round = (n: number): number => (precision === undefined ? n : Number(n.toFixed(precision)));
  const commit = (raw: string): void => {
    const trimmed = raw.trim().replace(',', '.');
    if (trimmed === '') {
      onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setText(value === null ? '' : String(value));
      return;
    }
    const next = round(clamp(n, min, max));
    setText(String(next));
    onChange(next);
  };
  const nudge = (dir: 1 | -1, big: boolean): void => {
    const base = Number(text.trim().replace(',', '.'));
    const from = Number.isFinite(base) && text.trim() !== '' ? base : (value ?? 0);
    const next = round(clamp(from + dir * step * (big ? 10 : 1), min, max));
    setText(String(next));
    onChange(next);
  };
  return (
    <div className={cx('cs-ui-numwrap', className)}>
      <input
        {...f}
        {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}
        className="cs-ui-input"
        data-size={size}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(text);
          else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1, e.shiftKey); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1, e.shiftKey); }
        }}
      />
      {unit === undefined ? null : <span className="cs-ui-unit" id={unitId}>{unit}</span>}
    </div>
  );
}
