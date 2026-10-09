/**
 * Page anatomy (plan section 3.4): a 44 px `PageHeader` (H1, count, `(?)`, secondary actions, one
 * primary), an optional 36 px `Toolbar`, then the content, with an optional 360 px `SidePanel`
 * beside it. No paragraph under the title: anything longer lives in the `(?)` or a tooltip.
 */

import { IconX } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';

import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';

export interface PageHeaderProps {
  /** the page's one H1 */
  title: string;
  /** "6 designs": quiet, after the title */
  count?: ReactNode;
  /** the `(?)` that links to the docs for this page */
  help?: ReactNode;
  /** secondary actions, right-aligned before the primary */
  secondary?: ReactNode;
  /** the one primary action */
  primary?: ReactNode;
  className?: string;
}

export function PageHeader({ title, count, help, secondary, primary, className }: PageHeaderProps): JSX.Element {
  return (
    <header className={cx('cs-ui-pagehead', className)} data-testid="page-header">
      <h1 className="cs-ui-h1">{title}</h1>
      {count === undefined ? null : <span className="cs-ui-count" data-testid="page-count">{count}</span>}
      {help}
      <span className="cs-ui-grow" />
      {secondary}
      {primary}
    </header>
  );
}

export interface ToolbarProps {
  /** names the toolbar for assistive tech */
  label: string;
  children?: ReactNode;
  /** right-aligned: view toggles, a column menu */
  end?: ReactNode;
  className?: string;
}

export function Toolbar({ label, children, end, className }: ToolbarProps): JSX.Element {
  return (
    <div role="toolbar" aria-label={label} className={cx('cs-ui-toolbar', className)}>
      {children}
      <span className="cs-ui-grow" />
      {end}
    </div>
  );
}

/** The page frame: header and toolbar on top, content below. Fills its parent. */
export function Page({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }): JSX.Element {
  return (
    <div className={cx('cs-ui-page', className)} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * Content beside an optional `SidePanel`; the panel overlays the content below 900 px. `form` caps the content at 640 px, as Settings forms are.
 */
export function PageBody({ children, panel, className, padded = false, form = false }: { children: ReactNode; panel?: ReactNode; className?: string; padded?: boolean; form?: boolean }): JSX.Element {
  return (
    <div className={cx('cs-ui-pagebody', className)}>
      <div className={cx('cs-ui-pagecontent', padded && 'is-pad', form && 'is-form')}>{children}</div>
      {panel}
    </div>
  );
}

export interface SidePanelProps {
  title: ReactNode;
  /** the id or a one-line identity under the title, mono */
  subtitle?: ReactNode;
  /** chips under the title */
  chips?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  /** actions, pinned at the bottom */
  footer?: ReactNode;
  /** names the region; defaults to "Details" */
  label?: string;
  testId?: string;
}

/** The 360 px detail panel for the selected row. Escape closes it. */
export function SidePanel({ title, subtitle, chips, onClose, children, footer, label = 'Details', testId }: SidePanelProps): JSX.Element {
  return (
    <section
      className="cs-ui-sidepanel"
      aria-label={label}
      data-testid={testId ?? 'side-panel'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="cs-ui-sidepanel-head">
        <div className="cs-ui-sidepanel-title">
          <h2 className="cs-ui-h2">{title}</h2>
          {subtitle === undefined ? null : <span className="cs-ui-sidepanel-sub">{subtitle}</span>}
          {chips === undefined ? null : <div className="cs-ui-sidepanel-chips">{chips}</div>}
        </div>
        <IconButton label="Close details" size="xs" icon={<IconX size={14} aria-hidden />} onClick={onClose} />
      </div>
      <div className="cs-ui-sidepanel-body">{children}</div>
      {footer === undefined ? null : <div className="cs-ui-sidepanel-foot">{footer}</div>}
    </section>
  );
}

/** Key / value rows for a `SidePanel` body. */
export function KeyValues({ items }: { items: readonly (readonly [label: string, value: ReactNode])[] }): JSX.Element {
  return (
    <dl className="cs-ui-kv">
      {items.map(([label, value]) => (
        <div key={label} className="cs-ui-kv-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface EmptyStateProps {
  /** one sentence: what is missing and what it is for */
  children: ReactNode;
  /** the one thing to do next */
  action?: ReactNode;
  /** "Learn more" target */
  learnMore?: string;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ children, action, learnMore, icon, className }: EmptyStateProps): JSX.Element {
  return (
    <div data-testid="empty-state" className={cx('cs-ui-empty', className)}>
      {icon}
      <span>{children}</span>
      {action}
      {learnMore === undefined ? null : (
        <a href={learnMore} target="_blank" rel="noreferrer" className="cs-ui-empty-link">
          Learn more
        </a>
      )}
    </div>
  );
}
