import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconXboxX } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';

import { cx } from './cx.ts';

export type CalloutTone = 'info' | 'ok' | 'warn' | 'err';
const ICONS = { info: IconInfoCircle, ok: IconCircleCheck, warn: IconAlertTriangle, err: IconXboxX } as const;

export interface CalloutProps {
  tone?: CalloutTone;
  /** the one line */
  children: ReactNode;
  /** extra text behind a "Details" disclosure */
  details?: ReactNode;
  /** a button or link at the right */
  action?: ReactNode;
  className?: string;
}

/** An inline message: one line, optionally a "Details" disclosure. Warnings and errors are announced (`role="alert"`); the rest are polite (`role="status"`). */
export function Callout({ tone = 'info', children, details, action, className }: CalloutProps): JSX.Element {
  const Icon = ICONS[tone];
  return (
    <div className={cx('cs-ui-callout', className)} data-tone={tone} role={tone === 'err' || tone === 'warn' ? 'alert' : 'status'}>
      <Icon className="cs-ui-callout-icon" size={16} aria-hidden />
      <div className="cs-ui-callout-main">
        <span>{children}</span>
        {details === undefined ? null : (
          <details className="cs-ui-callout-more">
            <summary>Details</summary>
            <div>{details}</div>
          </details>
        )}
      </div>
      {action}
    </div>
  );
}

/** A loading placeholder for content of known shape. Hidden from assistive tech; the region that loads should set `aria-busy`. */
export function Skeleton({ width, height, className }: { width?: number | string; height?: number | string; className?: string }): JSX.Element {
  return <span className={cx('cs-ui-skeleton', className)} aria-hidden style={{ width: width ?? '100%', ...(height === undefined ? {} : { height }) }} />;
}
