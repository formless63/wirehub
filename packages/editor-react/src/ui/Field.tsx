import { createContext, useContext, useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react';

import { cx } from './cx.ts';
import { Tooltip } from './Tooltip.tsx';
import type { ControlSize } from './Button.tsx';

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}
const FieldContext = createContext<FieldContextValue | null>(null);

/** what a control inside a `Field` takes from it: its id (for the label), `aria-describedby`, `aria-invalid`. */
export function useFieldProps(own: { id?: string | undefined; 'aria-describedby'?: string | undefined } = {}): { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-required'?: true } {
  const f = useContext(FieldContext);
  const describedBy = [own['aria-describedby'], f?.describedBy].filter(Boolean).join(' ') || undefined;
  return {
    ...(own.id !== undefined ? { id: own.id } : f ? { id: f.id } : {}),
    ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
    ...(f?.invalid ? { 'aria-invalid': true as const } : {}),
    ...(f?.required ? { 'aria-required': true as const } : {}),
  };
}

/** The `(?)`: a labelled button whose tooltip says what a field or a section means. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <Tooltip content={children}>
      <button type="button" className="cs-ui-help" aria-label={label}>?</button>
    </Tooltip>
  );
}

export interface FieldProps {
  label: string;
  /** one short line under the control */
  hint?: ReactNode;
  /** replaces nothing: shown in red under the control, and sets `aria-invalid` on it */
  error?: ReactNode;
  /** the `(?)` tooltip: what this field means (keep titles free of explanatory paragraphs) */
  help?: ReactNode;
  required?: boolean;
  /** something to show at the right of the label row (a status chip) */
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Label, control, hint and error, wired by id. The control inside reads `useFieldProps()` (Input, Textarea, NumberInput, Select, Combobox do). */
export function Field({ label, hint, error, help, required = false, meta, className, children }: FieldProps): JSX.Element {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errId = error === undefined ? undefined : `${id}-err`;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: error !== undefined, required }}>
      <div className={cx('cs-ui-field', className)}>
        <div className="cs-ui-field-label">
          <label htmlFor={id}>
            {label}
            {required ? <span className="cs-ui-req" aria-hidden> *</span> : null}
          </label>
          {help === undefined ? null : <HelpTip label={`About ${label}`}>{help}</HelpTip>}
          {meta === undefined ? null : <span className="cs-ui-field-meta">{meta}</span>}
        </div>
        {children}
        {hint === undefined ? null : <p className="cs-ui-hint" id={hintId}>{hint}</p>}
        {error === undefined ? null : <p className="cs-ui-error" id={errId} role="alert">{error}</p>}
      </div>
    </FieldContext.Provider>
  );
}

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  size?: ControlSize;
  /** identifiers (part numbers, ids, pin numbers) are set in mono */
  mono?: boolean;
}

export function Input({ size = 'sm', mono, className, ...rest }: InputProps): JSX.Element {
  const f = useFieldProps({ id: rest.id, 'aria-describedby': rest['aria-describedby'] });
  return <input {...rest} {...f} className={cx('cs-ui-input', className)} data-size={size} data-mono={mono || undefined} />;
}

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  mono?: boolean;
}

export function Textarea({ mono, className, ...rest }: TextareaProps): JSX.Element {
  const f = useFieldProps({ id: rest.id, 'aria-describedby': rest['aria-describedby'] });
  return <textarea {...rest} {...f} className={cx('cs-ui-textarea', className)} data-mono={mono || undefined} />;
}
