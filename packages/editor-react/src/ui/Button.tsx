import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';

import { cx } from './cx.ts';
import { Tooltip } from './Tooltip.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** heights from the control scale: xs 22, sm 26 (default), md 30 */
export type ControlSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** primary is copper: one per view, the main action */
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: ReactNode;
  /** shows a spinner, disables the button and sets `aria-busy` */
  loading?: boolean;
}

export function Button({ variant = 'secondary', size = 'sm', icon, loading = false, className, children, disabled, type = 'button', ...rest }: ButtonProps): JSX.Element {
  return (
    <button {...rest} type={type} className={cx('cs-ui-btn', className)} data-variant={variant} data-size={size} disabled={disabled === true || loading} aria-busy={loading || undefined}>
      {loading ? <span className="cs-ui-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  /** required: it is the accessible name and the tooltip */
  label: string;
  icon: ReactNode;
  size?: ControlSize;
  shortcut?: string;
  /** a toggle's state; sets `aria-pressed` */
  pressed?: boolean;
}

export function IconButton({ label, icon, size = 'sm', shortcut, pressed, className, type = 'button', ...rest }: IconButtonProps): JSX.Element {
  return (
    <Tooltip content={label} {...(shortcut === undefined ? {} : { shortcut })}>
      <button {...rest} type={type} className={cx('cs-ui-icon-btn', className)} data-size={size} aria-label={label} aria-pressed={pressed}>
        {icon}
      </button>
    </Tooltip>
  );
}
