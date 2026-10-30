/**
 * A record page's section: one compact header row (chevron, title, a quiet count or summary, actions
 * on the right) over a body that collapses. The open state is remembered per section id in this
 * browser, so a long record stays the shape the person left it. `empty` sections render nothing at
 * all; the page offers them through `SectionAdds` instead.
 */

import { IconChevronRight, IconPlus } from '@tabler/icons-react';
import { useId, type JSX, type ReactNode } from 'react';

import { Button } from './Button.tsx';
import { cx } from './cx.ts';
import { usePref } from './prefs.ts';

export interface SectionProps {
  /** stable across records of a kind: `stock`, `notes`, … (the remembered open state is keyed on it) */
  id: string;
  title: string;
  /** a count or a one-line state after the title, quiet */
  summary?: ReactNode;
  /** small buttons on the right of the header; they do not toggle the section */
  actions?: ReactNode;
  /** open when the person has not chosen; default true */
  defaultOpen?: boolean;
  /** shown open regardless (an edit started from the header), without changing the remembered state */
  forceOpen?: boolean;
  children?: ReactNode;
  testId?: string;
  className?: string;
}

export function Section({ id, title, summary, actions, defaultOpen = true, forceOpen = false, children, testId, className }: SectionProps): JSX.Element {
  const [remembered, setOpen] = usePref<boolean>(`section.${id}`, defaultOpen, (v): v is boolean => typeof v === 'boolean');
  const open = remembered || forceOpen;
  const bodyId = useId();
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <section className={cx('cs-ui-section', className)} aria-label={title} data-testid={testId} data-section={id} data-open={open && hasBody ? 'true' : undefined}>
      <div className="cs-ui-section-head">
        <button type="button" className="cs-ui-section-toggle" aria-expanded={hasBody ? open : undefined} aria-controls={hasBody ? bodyId : undefined} disabled={!hasBody} onClick={() => setOpen(!open)}>
          <IconChevronRight size={12} aria-hidden className="cs-ui-section-chev" data-hidden={!hasBody || undefined} />
          <span className="cs-ui-section-title">{title}</span>
          {summary === undefined ? null : <span className="cs-ui-section-sum">{summary}</span>}
        </button>
        {actions === undefined ? null : <div className="cs-ui-section-actions">{actions}</div>}
      </div>
      {hasBody && open ? <div id={bodyId} className="cs-ui-section-body">{children}</div> : null}
    </section>
  );
}

/** "+ Add" for the sections a record does not have yet (notes, firmware, an enclosure …). */
export function SectionAdds({ items }: { items: readonly { id: string; label: string; onSelect: () => void; disabled?: boolean }[] }): JSX.Element | null {
  if (items.length === 0) return null;
  // one "+ Add <thing>" per empty section: what each adds is on the button
  return (
    <div className="cs-ui-section-adds" data-testid="section-adds">
      {items.map((item) => (
        <Button key={item.id} size="xs" variant="ghost" icon={<IconPlus size={12} aria-hidden />} disabled={item.disabled === true} onClick={item.onSelect}>
          Add {item.label.replace(/…$/, '').toLowerCase()}
        </Button>
      ))}
    </div>
  );
}
