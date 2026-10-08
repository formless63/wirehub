import { IconX } from '@tabler/icons-react';
import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';

import { cx } from './cx.ts';

/** status tones are for status only; `selected` is the copper one */
export type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'selected';

export interface ChipProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  tone?: Tone;
  /** identifiers are set in mono */
  mono?: boolean;
  /** shows a remove button named "Remove <text of the chip>" */
  onRemove?: () => void;
  removeLabel?: string;
  children: ReactNode;
}

/** A small label for a fact about a row: kind, state, a tag. */
export function Chip({ tone = 'neutral', mono, onRemove, removeLabel, className, children, ...rest }: ChipProps): JSX.Element {
  return (
    <span {...rest} className={cx('cs-ui-chip', className)} data-tone={tone} data-mono={mono || undefined}>
      {children}
      {onRemove === undefined ? null : (
        <button type="button" className="cs-ui-chip-x" aria-label={removeLabel ?? `Remove ${typeof children === 'string' ? children : ''}`.trim()} onClick={onRemove}>
          <IconX size={10} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** A count or a short state beside a nav item or heading. */
export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }): JSX.Element {
  return <span className={cx('cs-ui-badge', className)} data-tone={tone}>{children}</span>;
}

/** A coloured dot. Colour alone is not a signal: `label` is required and is the accessible name. */
export function StatusDot({ tone = 'neutral', label, pulse = false }: { tone?: Tone; label: string; pulse?: boolean }): JSX.Element {
  return <span className="cs-ui-dot" role="img" aria-label={label} data-tone={tone} data-pulse={pulse || undefined} />;
}
